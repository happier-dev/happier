export const QA_BROWSER_CUSTODY_LOST = 'qa-browser-custody-lost';
export const QA_BROWSER_CDP_UNAVAILABLE = 'qa-browser-cdp-unavailable';

// CDP discovery belongs below the complete endpoint returned by its owner.
export async function readQaBrowserCdpTargets(endpoint, { fetchImpl = fetch, signal } = {}) {
  const base = new URL(endpoint);
  base.pathname = `${base.pathname.replace(/\/+$/, '')}/`;
  const response = await fetchImpl(new URL('json/list', base), { signal });
  if (!response.ok) {
    const result = await response.json().catch(() => null);
    const code = result?.reason === QA_BROWSER_CUSTODY_LOST
      ? QA_BROWSER_CUSTODY_LOST : QA_BROWSER_CDP_UNAVAILABLE;
    throw Object.assign(new Error(`[dev-targets] CDP discovery HTTP ${response.status}`),
      { code, status: response.status });
  }
  return (await response.json()).map(target => {
    if (!target.webSocketDebuggerUrl) return target;
    const address = new URL(target.webSocketDebuggerUrl, base);
    address.host = base.host;
    address.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
    return { ...target, webSocketDebuggerUrl: address.href };
  });
}
