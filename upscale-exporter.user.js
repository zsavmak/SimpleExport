// ==UserScript==
// @name         Upscale.trade Portfolio Exporter
// @namespace    http://tampermonkey.net/
// @version      2.6
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
let isFetchingDetails = false;
let freshLoad = true;
let initialHistoryLoaded = false;

function log(msg) { console.log(`[Exporter] ${msg}`); }

function loadData() {
    const saved = localStorage.getItem('upscaleExporterDataV23');
    if (!saved) return;
    try {
        const parsed = JSON.parse(saved);
        tradeData.markets = new Map(parsed.markets || []);
        tradeData.assetDecimals = new Map(parsed.assetDecimals || []);
    } catch (e) {
        log('Failed loading saved data: ' + e.message);
    }
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
    const statusMsg = msg || `Captured: ${tradeData.positions.size}`;
    if (ui.statusLabel) ui.statusLabel.textContent = statusMsg;
    if (ui.exportBtn) {
        ui.exportBtn.disabled = isFetchingDetails;
        ui.exportBtn.style.opacity = isFetchingDetails ? '0.5' : '1';
        ui.exportBtn.style.cursor = isFetchingDetails ? 'not-allowed' : 'pointer';
    }
}

function formatFull(value, decimals) {
    if (value === null || typeof value === 'undefined') return "0";

    const numericValue = Number(value); // Convert BigInt or number to Number
    if (isNaN(numericValue)) return "0"; // Now isNaN check is safe

    const divisor = Math.pow(10, decimals ?? 6);
    return (numericValue / divisor).toString();
}

function robustClick(el) {
    if (!el) return;
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
}

function getPositionIdFromUrl(url) {
    const parts = url.split('/').filter(Boolean);
    const historyIdx = parts.indexOf('history');
    if (historyIdx > 0 && parts[historyIdx - 1] !== 'portfolio') {
        return parts[historyIdx - 1];
    }
    return null;
}

async function triggerAllDetails() {
    const scrollable = document.querySelector('.simplebar-content-wrapper');
    if (!scrollable) return;

    scrollable.querySelectorAll('tbody > tr[data-exporter-clicked]').forEach(row => row.removeAttribute('data-exporter-clicked'));

    let lastRowCount = 0;
    let retries = 0;
    const maxRetries = 5;

    while (retries < maxRetries) {
        const rows = Array.from(scrollable.querySelectorAll('tbody > tr:not([data-exporter-clicked])'));
        if (rows.length > 0) {
            for (const row of rows) {
                const cell = row.querySelector('td');
                if (cell) {
                    robustClick(cell);
                    await new Promise(r => setTimeout(r, 100));
                    robustClick(cell);
                    await new Promise(r => setTimeout(r, 100));
                }
                row.setAttribute('data-exporter-clicked', 'true');
            }
        }

        scrollable.scrollTo(0, scrollable.scrollHeight);
        await new Promise(r => setTimeout(r, 1200));

        const currentRowCount = scrollable.querySelectorAll('tbody > tr').length;
        if (currentRowCount > lastRowCount) {
            lastRowCount = currentRowCount;
            retries = 0;
        } else {
            retries++;
        }
    }
}

async function ensureAllDetailsFetched() {
    if (isFetchingDetails) return;
    isFetchingDetails = true;

    const totalPositions = tradeData.positions.size;
    if (!freshLoad && tradeData.events.size >= totalPositions && totalPositions > 0) {
        isFetchingDetails = false;
        return;
    }

    freshLoad = false;
    tradeData.events.clear();

    if (totalPositions === 0) {
        isFetchingDetails = false;
        updateStatus();
        return;
    }

    triggerAllDetails();

    await new Promise((resolve) => {
        const pollInterval = 500;
        const timeout = 60000;
        let elapsedTime = 0;

        const poll = setInterval(() => {
            elapsedTime += pollInterval;
            const fetchedCount = tradeData.events.size;
            updateStatus(`Сбор данных: ${fetchedCount} / ${totalPositions}`);

            if (fetchedCount >= totalPositions) {
                clearInterval(poll);
                resolve();
            } else if (elapsedTime >= timeout) {
                const allIds = new Set(tradeData.positions.keys());
                const fetchedIds = new Set(tradeData.events.keys());
                const missingIds = [...allIds].filter(id => !fetchedIds.has(id));
                alert(`Тайм-аут. Экспортируются только ${fetchedCount} из ${totalPositions} позиций.`);
                clearInterval(poll);
                resolve();
            }
        }, pollInterval);
    });

    isFetchingDetails = false;
    updateStatus();
}

function handleXhr(xhr) {
    if (!xhr._url || !xhr._url.includes('api.upscale.trade') || xhr.status !== 200 || !xhr.responseText) return;

    try {
        const url = xhr._url;
        const data = JSON.parse(xhr.responseText);

        if (url.includes('/portfolio/history')) {
            if (url.includes('offset=0') && !initialHistoryLoaded) {
                initialHistoryLoaded = true;
                tradeData.positions.clear();
            }

            const initialCount = tradeData.positions.size;
            (data.data || []).forEach(p => tradeData.positions.set(p.idx, p));

            if (tradeData.positions.size > initialCount) {
                 saveData();
                 updateStatus();
            }
        } else if (url.includes('/markets') && !url.includes('/history')) {
             (data || []).forEach(m => tradeData.markets.set(m.id, m));
             saveData();
        } else if (url.includes('/config') && data.assetDecimals) {
             tradeData.assetDecimals = new Map(Object.entries(data.assetDecimals));
             saveData();
        } else {
            const positionId = getPositionIdFromUrl(url);
            if (positionId) {
                tradeData.events.set(positionId, data || []);
                log(`[${tradeData.events.size}/${tradeData.positions.size}] Received event data for position ${positionId}.`);
                saveData();
            }
        }
    } catch (e) {
        log(`Error processing response from ${xhr._url}: ${e.message}`);
    }
}

const origOpen = XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open = function(method, url) { this._url = url; return origOpen.apply(this, arguments); };
const origSend = XMLHttpRequest.prototype.send;
XMLHttpRequest.prototype.send = function() {
    this.addEventListener('load', () => handleXhr(this));
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
            const price = baseAmount !== 0 ? Math.abs(quoteAmount / baseAmount) : 0;
            totalFee += Number(e.feeInEvent || 0);
            totalPnl += Number(e.pnlInEvent || 0);
            if (e.eventName === 'increasePosition' || e.eventName === 'openPosition') {
                totalEntryQuote += quoteAmount;
                totalEntryBase += baseAmount;
            } else if (e.eventName === 'closePosition' || e.eventName === 'decreasePosition') {
                totalCloseQuote += quoteAmount;
                totalCloseBase += baseAmount;
            }
            formattedEvents.push({ name: e.eventName, size: baseAmount, price: price, fee: Number(e.feeInEvent || 0), pnl: Number(e.pnlInEvent || 0), type: e.order?.type || null });
        });
    }
    const entryPrice = totalEntryBase > 0 ? totalEntryQuote / totalEntryBase : 0;
    const closePrice = totalCloseBase !== 0 ? totalCloseQuote / Math.abs(totalCloseBase) : 0;
    const pnlToFormat = totalPnl !== 0 ? totalPnl : Number(pos.pnl);
    const feeToFormat = totalFee !== 0 ? totalFee : Number(pos.fee);
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
    if(search) {
        data=data.filter(p=>p.marketInfo?.symbol.toLowerCase().includes(search));
    }
    if(start) {
        data=data.filter(p=>new Date(p.closedAt)>=start);
    }
    if(end) {
        const endDate = new Date(end);
        endDate.setHours(23, 59, 59, 999);
        data=data.filter(p=>new Date(p.closedAt)<=endDate);
    }
    return data;
}

async function exportCommon(exportFunction) {
    await ensureAllDetailsFetched();
    const data = getFilteredData();
    if(data.length===0) {
        return alert('Нет позиций для экспорта по выбранным фильтрам.');
    }
    exportFunction(data);
}

function exportToTXT(data){
    const lines=[`Upscale Trade History Export`,`Generated: ${new Date().toISOString()}`,`Total Positions: ${data.length}`,'====================================',''];
    data.sort((a,b)=>new Date(b.closedAt)-new Date(a.closedAt)).forEach(p=>{
        const lev = p.order?.leverage ? (Number(p.order.leverage)/1e9).toString() : (p.notional && p.margin && p.margin!=='0'? (parseFloat(p.notional)/parseFloat(p.margin)).toString():'N/A');
        lines.push(`--- Position: ${p.idx} ---`);
        lines.push(`Market: ${p.marketInfo?.symbol||p.market||'N/A'} | Direction: ${p.direction.toUpperCase()} | Leverage: ${lev}x`);
        lines.push(`Opened: ${new Date(p.openedAt).toLocaleString()} | Closed: ${new Date(p.closedAt).toLocaleString()}`);
        lines.push(`Avg Entry Price: ${p.entryPrice.toFixed(p.quoteDecimals)} | Avg Close Price: ${p.closePrice.toFixed(p.quoteDecimals)}`);
        lines.push(`PnL: ${formatFull(p.pnlToFormat,p.quoteDecimals)} | Fees: ${formatFull(p.feeToFormat,p.quoteDecimals)} | Total Size: ${formatFull(p.sizeToFormat,p.baseDecimals)}`);
        lines.push('Events:');
        if (p.formattedEvents && p.formattedEvents.length > 0) {
            p.formattedEvents.forEach(e => {
                const price = e.price.toFixed(p.quoteDecimals);
                const size = e.size.toFixed(p.baseDecimals);
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
    ui.exportOptions=document.createElement('div'); Object.assign(ui.exportOptions.style,{display:'none',position:'absolute',background:'#2D3748',border:'1px solid #4A5568',borderRadius:'4px', zIndex: '1001'});
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
    const historyButton = Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === 'История');
    if (historyButton?.parentElement?.parentElement) {
        const parent = historyButton.parentElement.parentElement.parentElement;
        const target = historyButton.parentElement.parentElement;
        createUI(parent, target);
        historyButton.addEventListener('click', () => {
            initialHistoryLoaded = false;
        });
        observerInstance.disconnect();
    }
});
loadData();
window.addEventListener('load',()=>{
    observer.observe(document.body,{childList:true,subtree:true});
});
})();
