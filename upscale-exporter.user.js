// ==UserScript==
// @name         Upscale.trade Portfolio Exporter
// @namespace    http://tampermonkey.net/
// @version      2.0
// @description  Export portfolio history with detailed events and filters
// @author       Saveli
// @match        https://app.upscale.trade/portfolio*
// @grant        none
// @run-at       document-start
// ==/UserScript==
(function() {
'use strict';
let tradeData = { positions: new Map(), markets: new Map(), events: new Map(), assetDecimals: new Map() };
const ui = { exportBtn: null, statusLabel: null, exportOptions: null, searchInput: null, startDateInput: null, endDateInput: null };
const pendingEventPromises = new Map();
let isFetchingDetails = false;
let freshLoad = true;
function log(msg) { console.log(`[Exporter] ${msg}`); }
function loadData() {
    const saved = localStorage.getItem('upscaleExporterDataV23');
    if (!saved) return;
    try {
        const parsed = JSON.parse(saved);
        tradeData.positions = new Map(parsed.positions || []);
        tradeData.markets = new Map(parsed.markets || []);
        tradeData.assetDecimals = new Map(parsed.assetDecimals || []);
        log('Loaded saved data.');
    } catch (e) { log('Failed loading saved data'); }
}
function saveData() {
    const obj = {
        positions: Array.from(tradeData.positions.entries()),
        markets: Array.from(tradeData.markets.entries()),
        events: Array.from(tradeData.events.entries()),
        assetDecimals: Array.from(tradeData.assetDecimals.entries()),
    };
    localStorage.setItem('upscaleExporterDataV23', JSON.stringify(obj));
}
function updateStatus(msg = '') {
    if (ui.statusLabel) ui.statusLabel.textContent = msg || `Captured: ${tradeData.positions.size}`;
    if (ui.exportBtn) {
        ui.exportBtn.disabled = isFetchingDetails;
        ui.exportBtn.style.opacity = isFetchingDetails ? '0.5' : '1';
        ui.exportBtn.style.cursor = isFetchingDetails ? 'not-allowed' : 'pointer';
    }
}
function formatFull(value, decimals) {
    if (value === null || typeof value === 'undefined' || isNaN(value)) return "0";
    const divisor = Math.pow(10, decimals ?? 6);
    return (Number(value) / divisor).toString();
}
function robustClick(el) {
    if (!el) return;
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
}
function getPositionIdFromUrl(url) {
    const parts = url.split('/').filter(Boolean);
    const historyIdx = parts.indexOf('history');
    if (historyIdx > 0 && parts[historyIdx - 1] !== 'portfolio') return parts[historyIdx - 1];
    return null;
}
async function triggerAllDetails() {
    const scrollable = document.querySelector('.simplebar-content-wrapper');
    if (!scrollable) return;
    let lastHeight = 0;
    let retries = 0;
    while (retries < 3) {
        scrollable.scrollTo(0, scrollable.scrollHeight);
        await new Promise(r => setTimeout(r, 300));
        if (scrollable.scrollHeight === lastHeight) retries++; else retries = 0;
        lastHeight = scrollable.scrollHeight;
    }
    const rows = Array.from(scrollable.querySelectorAll('tbody > tr'));
    for (let i = 0; i < rows.length; i++) {
        const cell = rows[i].querySelector('td');
        if (cell) {
            robustClick(cell); await new Promise(r => setTimeout(r, 60));
            robustClick(cell); await new Promise(r => setTimeout(r, 60));
        }
    }
}
async function ensureAllDetailsFetched() {
    if (isFetchingDetails) return;
    isFetchingDetails = true;
    updateStatus(`Refreshing all position details...`);
    if (!freshLoad && tradeData.events.size > 0) {
        log("Reusing cached event data.");
        isFetchingDetails = false; updateStatus();
        return;
    }
    freshLoad = false;
    tradeData.events.clear();
    pendingEventPromises.clear();
    const allIds = Array.from(tradeData.positions.keys());
    if (allIds.length === 0) {
        isFetchingDetails = false; updateStatus();
        return;
    }
    const promises = allIds.map(id => new Promise(res => pendingEventPromises.set(id, res)));
    await triggerAllDetails();
    try {
        await Promise.race([
            Promise.all(promises),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Fetch timed out after 45 seconds')), 45000))
        ]);
    } catch (e) {
        alert('Fetch timed out. Some data may be missing.');
    } finally {
        isFetchingDetails = false;
        updateStatus();
    }
}
function handleXhrData(url, text, status) {
    const positionId = getPositionIdFromUrl(url);
    if (!positionId || !url.includes('/history')) return;
    try {
        const resolvePromise = () => {
            if (pendingEventPromises.has(positionId)) {
                pendingEventPromises.get(positionId)();
                pendingEventPromises.delete(positionId);
            }
        };
        if (status === 304) {
            resolvePromise();
        } else if (status === 200 && text) {
            const eventArray = JSON.parse(text);
            tradeData.events.set(positionId, eventArray || []);
            resolvePromise();
        }
    } catch(e){
    } finally {
        saveData();
        updateStatus();
    }
}
const origOpen = XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open = function(method, url) { this._url = url; return origOpen.apply(this, arguments); };
const origSend = XMLHttpRequest.prototype.send;
XMLHttpRequest.prototype.send = function() {
    this.addEventListener('load', () => {
        if (this._url && this._url.includes('api.upscale.trade')) {
            if(this._url.includes('/portfolio/history')) {
                 try {
                     if(this.status === 200 && this.responseText) {
                        const data = JSON.parse(this.responseText);
                        data.data.forEach(p => { if (!tradeData.positions.has(p.idx)) tradeData.positions.set(p.idx, p); });
                        saveData(); updateStatus();
                     }
                 } catch(e) {}
            } else {
                handleXhrData(this._url, this.responseText, this.status);
            }
        }
    });
    return origSend.apply(this, arguments);
};
function processPositionData(pos, events, marketInfo, assetDecimals) {
    const baseDec = marketInfo ? assetDecimals.get(marketInfo.baseAsset) ?? 6 : 6;
    const quoteDec = marketInfo ? assetDecimals.get(marketInfo.quoteAsset) ?? 6 : 6;
    let totalFee = 0, totalPnl = 0, totalEntryQuote = 0, totalEntryBase = 0;
    let totalCloseQuote = 0, totalCloseBase = 0;
    let formattedEvents = [];
    if (events && events.length > 0) {
        events.forEach(e => {
            const exchangedBaseRaw = BigInt(e.exchangedBase || 0);
            const exchangedQuoteRaw = BigInt(e.exchangedQuote || 0);
            if (exchangedBaseRaw === 0n) return;
            const baseAmount = Number(exchangedBaseRaw) / (Math.pow(10, baseDec) * 1000);
            const quoteAmount = Number(exchangedQuoteRaw) / Math.pow(10, quoteDec);
            const price = Math.abs(quoteAmount / baseAmount);
            totalFee += Number(e.feeInEvent || 0);
            totalPnl += Number(e.pnlInEvent || 0);
            if (e.eventName === 'increasePosition' || e.eventName === 'openPosition') {
                totalEntryQuote += quoteAmount;
                totalEntryBase += baseAmount;
            } else if (e.eventName === 'closePosition') {
                totalCloseQuote += quoteAmount;
                totalCloseBase += baseAmount;
            }
            formattedEvents.push({
                name: e.eventName,
                size: baseAmount,
                price: price,
                fee: Number(e.feeInEvent || 0),
                pnl: Number(e.pnlInEvent || 0),
                type: e.order?.type || null
            });
        });
    }
    const entryPrice = totalEntryBase > 0 ? totalEntryQuote / totalEntryBase : 0;
    const closePrice = totalCloseBase > 0 ? totalCloseQuote / totalCloseBase : 0;
    const pnlToFormat = totalFee > 0 || totalPnl > 0 ? totalPnl : Number(pos.pnl);
    const feeToFormat = totalFee > 0 || totalPnl > 0 ? totalFee : Number(pos.fee);
    const sizeToFormat = (totalEntryBase > 0) ? (totalEntryBase * Math.pow(10, baseDec)) : BigInt(pos.size || 0);
    return { ...pos, entryPrice, closePrice, pnlToFormat, feeToFormat, sizeToFormat, marketInfo, baseDecimals: baseDec, quoteDecimals: quoteDec, formattedEvents };
}
function getFilteredData() {
    let data = Array.from(tradeData.positions.values()).map(p=>{
        const events = tradeData.events.get(p.idx)||[];
        const marketInfo = tradeData.markets.get(p.market);
        return processPositionData(p,events,marketInfo,tradeData.assetDecimals);
    });
    const search = ui.searchInput?.value?.toLowerCase();
    const start = ui.startDateInput?.value ? new Date(ui.startDateInput.value) : null;
    const end = ui.endDateInput?.value ? new Date(ui.endDateInput.value) : null;
    if(search) data=data.filter(p=>p.marketInfo?.symbol.toLowerCase().includes(search));
    if(start) data=data.filter(p=>new Date(p.closedAt)>=start);
    if(end) data=data.filter(p=>new Date(p.closedAt)<=end);
    return data;
}
async function exportCommon(exportFunction) {
    await ensureAllDetailsFetched();
    const data = getFilteredData();
    if(data.length===0) return alert('No positions to export for the selected filters.');
    exportFunction(data);
}
function exportToTXT(data){
    const lines=[`Upscale Trade History Export`,`Generated: ${new Date().toISOString()}`,`Total Positions: ${data.length}`,'====================================',''];
    data.sort((a,b)=>new Date(b.closedAt)-new Date(a.closedAt)).forEach(p=>{
        const lev = p.order?.leverage ? (Number(p.order.leverage)/1e9).toString() : (p.notional && p.margin && p.margin!=='0'? (parseFloat(p.notional)/parseFloat(p.margin)).toString():'N/A');
        lines.push(`--- Position: ${p.idx} ---`);
        lines.push(`Market: ${p.marketInfo?.symbol||'N/A'} | Direction: ${p.direction.toUpperCase()} | Leverage: ${lev}x`);
        lines.push(`Opened: ${new Date(p.openedAt).toLocaleString()} | Closed: ${new Date(p.closedAt).toLocaleString()}`);
        lines.push(`Avg Entry Price: ${p.entryPrice} | Avg Close Price: ${p.closePrice}`);
        lines.push(`PnL: ${formatFull(p.pnlToFormat,p.quoteDecimals)} | Fees: ${formatFull(p.feeToFormat,p.quoteDecimals)} | Total Size: ${formatFull(p.sizeToFormat,p.baseDecimals)}`);
        lines.push('Events:');
        if (p.formattedEvents && p.formattedEvents.length > 0) {
            p.formattedEvents.forEach(e => {
                const price = e.price;
                const size = e.size;
                const fee = formatFull(e.fee, p.quoteDecimals);
                const pnl = formatFull(e.pnl, p.quoteDecimals);
                lines.push(`  - ${e.name} | Type: ${e.type||'N/A'} | Size: ${size} | Price: ${price} | Fee: ${fee} | PnL: ${pnl}`);
            });
        } else { lines.push('  - No detailed events captured.'); }
        lines.push('-----------------------------','');
    });
    downloadFile(lines.join('\n'),'upscale_history.txt','text/plain');
}
function exportToJSON(data){
    downloadFile(JSON.stringify(data, (key, value) => typeof value === 'bigint' ? value.toString() : value, 2),'upscale_history.json','application/json');
}
function downloadFile(content,name,type){
    const blob = new Blob([content],{type});
    const a=document.createElement('a');
    a.href=URL.createObjectURL(blob);
    a.download=name;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
}
function createUI(parent,target){
    if(document.getElementById('exporter-container')) return;
    const container=document.createElement('div'); container.id='exporter-container'; Object.assign(container.style,{display:'flex',alignItems:'center',gap:'10px',padding:'5px', zIndex: '1000'});
    ui.statusLabel=document.createElement('span'); Object.assign(ui.statusLabel.style,{fontSize:'12px',color:'#A0AEC0'}); container.appendChild(ui.statusLabel);
    ui.searchInput=document.createElement('input'); ui.searchInput.placeholder='Filter Symbol'; Object.assign(ui.searchInput.style,{fontSize:'12px',padding:'3px',background:'#1A202C',color:'#E2E8F0',border:'1px solid #4A5568'}); container.appendChild(ui.searchInput);
    ui.startDateInput=document.createElement('input'); ui.startDateInput.type='date'; Object.assign(ui.startDateInput.style,{fontSize:'12px',padding:'3px',background:'#1A202C',color:'#E2E8F0',border:'1px solid #4A5568'}); container.appendChild(ui.startDateInput);
    ui.endDateInput=document.createElement('input'); ui.endDateInput.type='date'; Object.assign(ui.endDateInput.style,{fontSize:'12px',padding:'3px',background:'#1A202C',color:'#E2E8F0',border:'1px solid #4A5568'}); container.appendChild(ui.endDateInput);
    ui.exportBtn=document.createElement('button'); ui.exportBtn.textContent='Export'; Object.assign(ui.exportBtn.style,{padding:'3px 8px',fontSize:'12px',background:'#3182CE',color:'white',border:'none',borderRadius:'3px',cursor:'pointer'}); container.appendChild(ui.exportBtn);
    ui.exportOptions=document.createElement('div'); Object.assign(ui.exportOptions.style,{display:'none',position:'absolute',background:'#2D3748',border:'1px solid #4A5568',borderRadius:'4px'});
    const jsonBtn = document.createElement('button'); jsonBtn.textContent='To JSON'; jsonBtn.onclick=()=>exportCommon(exportToJSON);
    const txtBtn = document.createElement('button'); txtBtn.textContent='To TXT'; txtBtn.onclick=()=>exportCommon(exportToTXT);
    [jsonBtn, txtBtn].forEach(btn => { Object.assign(btn.style,{display:'block',width:'100%',background:'transparent',border:'none',color:'#E2E8F0',padding:'4px',textAlign:'left',cursor:'pointer'}); ui.exportOptions.appendChild(btn); });
    container.appendChild(ui.exportOptions);
    ui.exportBtn.onclick=(e)=>{ e.stopPropagation(); ui.exportOptions.style.display=(ui.exportOptions.style.display==='none')?'block':'none'; };
    document.addEventListener('click',()=>{ if(ui.exportOptions) ui.exportOptions.style.display='none'; });
    parent.insertBefore(container,target);
    updateStatus();
}
const observer = new MutationObserver((mutations, observerInstance) => {
    if (document.getElementById('exporter-container')) {
        observerInstance.disconnect(); return;
    }
    const buttons = Array.from(document.querySelectorAll('button'));
    const historyButton = buttons.find(b => b.textContent.trim() === 'История');
    if (historyButton?.parentElement?.parentElement) {
        const parent = historyButton.parentElement.parentElement.parentElement;
        const target = historyButton.parentElement.parentElement;
        createUI(parent, target);
        observerInstance.disconnect();
    }
});
loadData();
window.addEventListener('load',()=>{
    observer.observe(document.body,{childList:true,subtree:true});
});
})();
