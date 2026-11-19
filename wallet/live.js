/* 코인가스비미터 — 「비수탁 지갑 이체 가스비」 페이지의 지금 값 계산기.
 *
 * 하는 일
 *  - 공개 이더리움 노드에서 지금 가스 가격(eth_gasPrice)과 최신 블록 번호를 읽습니다.
 *  - 국내 거래소 공개 시세에서 ETH 원화 가격을 읽습니다.
 *  - ETH 전송(21,000 gas)과 USDT·USDC 전송(65,000 gas)에 드는 ETH·원화를 표에 채웁니다.
 *
 * 지키는 것
 *  - 값을 읽지 못하면 0원으로 채우지 않고 "—"와 안내 문구를 남깁니다(거짓 숫자 방지).
 *  - 쿠키·저장소·분석 스크립트를 쓰지 않고, 아무것도 저장하지 않습니다(Zero-PII).
 *  - 앱과 같은 공개 노드·같은 공개 시세만 씁니다. 지갑 연결·서명·전송은 하지 않습니다.
 */
(function () {
  'use strict';

  var RPC_ENDPOINTS = [
    'https://ethereum-rpc.publicnode.com',
    'https://eth.drpc.org',
    'https://1rpc.io/eth',
  ];
  var MARKET_URL = 'https://api.upbit.com/v1/ticker?markets=KRW-ETH';

  /** 표준 가스 사용량 — 앱(src/engine/gas.ts)과 같은 값입니다. */
  var GAS = { eth: 21000, token: 65000 };

  var REFRESH_MS = 60000;
  var TIMEOUT_MS = 8000;

  var table = document.getElementById('fee-table');
  var statusEl = document.getElementById('live-status');
  var button = document.getElementById('refresh-btn');
  var cells = {
    ethNative: document.querySelector('[data-cell="eth-native"]'),
    ethKrw: document.querySelector('[data-cell="eth-krw"]'),
    tokenNative: document.querySelector('[data-cell="token-native"]'),
    tokenKrw: document.querySelector('[data-cell="token-krw"]'),
  };

  var busy = false;

  function fetchJson(url, options) {
    return new Promise(function (resolve, reject) {
      var controller = typeof AbortController === 'function' ? new AbortController() : null;
      var timer = setTimeout(function () {
        if (controller) controller.abort();
        reject(new Error('timeout'));
      }, TIMEOUT_MS);

      fetch(url, options)
        .then(function (res) {
          if (!res.ok) throw new Error('http ' + res.status);
          return res.json();
        })
        .then(function (data) {
          clearTimeout(timer);
          resolve(data);
        })
        .catch(function (err) {
          clearTimeout(timer);
          reject(err);
        });
    });
  }

  function rpcCall(url, method) {
    return fetchJson(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: method, params: [] }),
    }).then(function (json) {
      if (!json || typeof json.result === 'undefined' || json.result === null) throw new Error('empty');
      return json.result;
    });
  }

  /** 앞 노드가 막히면 다음 노드로 넘어갑니다. */
  function readGasWei() {
    var index = 0;
    function attempt() {
      if (index >= RPC_ENDPOINTS.length) return Promise.reject(new Error('all rpc failed'));
      var url = RPC_ENDPOINTS[index++];
      return rpcCall(url, 'eth_gasPrice').then(function (hex) {
        var wei = parseInt(hex, 16);
        if (!isFinite(wei) || wei <= 0) throw new Error('bad gas price');
        return { wei: wei, endpoint: url };
      }).catch(attempt);
    }
    return attempt();
  }

  function readBlockNumber() {
    var index = 0;
    function attempt() {
      if (index >= RPC_ENDPOINTS.length) return Promise.resolve(null);
      var url = RPC_ENDPOINTS[index++];
      return rpcCall(url, 'eth_blockNumber').then(function (hex) {
        var n = parseInt(hex, 16);
        return isFinite(n) && n > 0 ? n : null;
      }).catch(attempt);
    }
    return attempt();
  }

  function readEthKrw() {
    return fetchJson(MARKET_URL).then(function (rows) {
      var row = Array.isArray(rows) ? rows[0] : null;
      var price = row && typeof row.trade_price === 'number' ? row.trade_price : null;
      if (!price || price <= 0) throw new Error('no price');
      return price;
    });
  }

  /** 0.00004561 처럼 아주 작은 값도 읽히도록 소수 8자리까지, 뒤쪽 0은 정리합니다. */
  function formatEth(value) {
    if (!isFinite(value) || value <= 0) return '—';
    var text = value.toFixed(8).replace(/0+$/, '');
    if (text.charAt(text.length - 1) === '.') text += '0';
    return text + ' ETH';
  }

  function formatKrw(value) {
    if (!isFinite(value) || value <= 0) return '—';
    var rounded = value >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
    var parts = String(rounded).split('.');
    var head = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return '약 ' + head + (parts[1] ? '.' + parts[1] : '') + '원';
  }

  function formatKstTime(date) {
    try {
      return new Intl.DateTimeFormat('ko-KR', {
        timeZone: 'Asia/Seoul',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(date);
    } catch (err) {
      var h = date.getHours();
      var m = date.getMinutes();
      return (h < 10 ? '0' + h : h) + ':' + (m < 10 ? '0' + m : m);
    }
  }

  function setStatus(text) {
    if (statusEl) statusEl.textContent = text;
  }

  function setState(state) {
    if (table) table.setAttribute('data-state', state);
  }

  function paintEmpty() {
    Object.keys(cells).forEach(function (key) {
      if (cells[key]) cells[key].textContent = '—';
    });
  }

  function paint(gasWei, ethKrw, blockNumber) {
    // wei → gwei → 전송 1회 ETH
    var gasPriceWei = gasWei;
    var ethCost = (gasPriceWei * GAS.eth) / 1e18;
    var tokenCost = (gasPriceWei * GAS.token) / 1e18;
    var ethKrwCost = ethKrw ? ethCost * ethKrw : null;
    var tokenKrwCost = ethKrw ? tokenCost * ethKrw : null;

    if (cells.ethNative) cells.ethNative.textContent = formatEth(ethCost);
    if (cells.ethKrw) cells.ethKrw.textContent = ethKrwCost === null ? '—' : formatKrw(ethKrwCost);
    if (cells.tokenNative) cells.tokenNative.textContent = formatEth(tokenCost);
    if (cells.tokenKrw) cells.tokenKrw.textContent = tokenKrwCost === null ? '—' : formatKrw(tokenKrwCost);

    setState('ready');

    var gwei = gasPriceWei / 1e9;
    var parts = [];
    parts.push('기준 ' + formatKstTime(new Date()) + ' (한국 시간)');
    parts.push(gwei.toFixed(gwei < 1 ? 3 : 2) + ' gwei');
    if (blockNumber) parts.push('블록 ' + blockNumber.toLocaleString('ko-KR'));
    if (!ethKrw) parts.push('원화 시세를 읽지 못해 원화 칸은 비워 두었습니다');
    setStatus(parts.join(' · '));
  }

  function refresh() {
    if (busy) return;
    busy = true;
    if (button) {
      button.disabled = true;
      button.textContent = '읽는 중…';
    }
    setStatus('지금 값을 읽는 중…');

    Promise.all([readGasWei(), readEthKrw().catch(function () { return null; }), readBlockNumber()])
      .then(function (values) {
        paint(values[0].wei, values[1], values[2]);
      })
      .catch(function () {
        paintEmpty();
        setState('error');
        setStatus('지금은 네트워크 값을 읽지 못했어요. 잠시 뒤 「다시 읽기」를 눌러 주세요.');
      })
      .then(function () {
        busy = false;
        if (button) {
          button.disabled = false;
          button.textContent = '다시 읽기';
        }
      });
  }

  if (!table || !cells.ethNative) return;

  paintEmpty();
  refresh();

  if (button) button.addEventListener('click', refresh);

  // 화면이 다시 보일 때만 새로 읽습니다(숨은 탭에서 요청을 반복하지 않도록).
  var timer = setInterval(function () {
    if (document.visibilityState === 'visible') refresh();
  }, REFRESH_MS);

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') refresh();
  });

  window.addEventListener('pagehide', function () {
    clearInterval(timer);
  });
})();
