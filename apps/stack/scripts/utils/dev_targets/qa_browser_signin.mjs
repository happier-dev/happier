import { formatDevAuthKeyBackup, normalizeDevAuthKeyInputToBytes } from '../auth/dev_key.mjs';
import { requireSessionName } from './qa_browser_retirement.mjs';

const failure = reason => Object.assign(new Error(reason), { reason });

// This code only drives the supported restore form. Authentication, Account
// mode discovery and persistence remain owned by SecretKeyLoginForm.
async function browserStep(step, key) {
  const waitFor = check => new Promise(resolve => {
    const observer = new MutationObserver(() => {
      const value = check();
      if (value) { observer.disconnect(); resolve(value); }
    });
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true });
    const value = check();
    if (value) { observer.disconnect(); resolve(value); }
  });
  const home = () => {
    if (document.querySelector('[data-testid="home-unreachable"]')) return 'home_unavailable';
    if (location.pathname === '/' && !document.querySelector('[data-testid="restore-manual-wizard"]')
      && document.querySelector('[data-testid="navigation-sidebar"]')) return 'home';
    return null;
  };
  if (step === 'home') return await waitFor(home);
  if (step === 'account') return await waitFor(() => {
    if (document.querySelector('[data-testid="home-unreachable"]')) return 'account_unavailable';
    const row = document.querySelector('[data-testid="settings-account-id"]');
    if (!row) return null;
    // AccountIdentifier renders the current auth owner's id as its second Text.
    const id = row.children[1]?.textContent?.trim();
    return id && /^[a-zA-Z0-9_-]+$/.test(id) ? id.slice(0, 8) : 'account_unavailable';
  });
  const ready = await waitFor(() => {
    if (document.querySelector('[data-testid="home-unreachable"]')) return 'home_unavailable';
    if (location.pathname !== '/restore/manual'
      || document.querySelector('[role="dialog"] [data-testid="web-modal-confirm"]')) return 'restore_entry_unavailable';
    return document.querySelector('[data-testid="restore-manual-wizard"] input');
  });
  if (typeof ready === 'string') return ready;
  // Use the native setter so React receives the same input event as typing.
  const fill = value => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(ready, value);
    ready.dispatchEvent(new Event('input', { bubbles: true }));
  };
  try {
    fill(key);
    key = '';
    // Separate the fill and click like user input, allowing React to commit.
    await new Promise(requestAnimationFrame);
    const outcome = waitFor(() => {
      if (document.querySelector('[data-testid="restore-manual-wizard"] [role="alert"]')) return 'restore_failed';
      return home();
    });
    document.querySelector('[data-testid="restore-manual-submit"]').click();
    const result = await outcome;
    if (result !== 'home') fill('');
    return result;
  } catch {
    fill('');
    return 'restore_failed';
  }
}

async function connectPage(endpoint, WebSocketImpl, onEvent) {
  const socket = new WebSocketImpl(endpoint);
  const pending = new Map();
  let nextId = 0;
  const disconnected = Promise.withResolvers();
  // The disconnect can precede the caller's race while opening the socket.
  disconnected.promise.catch(() => {});
  const fail = () => {
    const error = failure('browser_unavailable');
    for (const request of pending.values()) request.reject(error);
    pending.clear();
    disconnected.reject(error);
  };
  socket.addEventListener('close', fail);
  socket.addEventListener('error', fail);
  socket.addEventListener('message', event => {
    try {
      const message = JSON.parse(event.data);
      if (message.id) {
        const request = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) request?.reject(failure('browser_unavailable'));
        else request?.resolve(message.result);
      } else onEvent(message);
    } catch { fail(); }
  });
  try {
    await Promise.race([new Promise(resolve => socket.addEventListener('open', resolve, { once: true })), disconnected.promise]);
  } catch (error) { socket.close(); throw error; }
  return {
    disconnected: disconnected.promise,
    send(method, params = {}) {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() { socket.close(); },
  };
}

/** Restore only in an existing browser, retaining no credentials or browser state. */
export async function runQaBrowserSignin({ sessionName, stackName, rootDir, cdpHttpUrl, input = process.stdin }, {
  fetchImpl = fetch, WebSocketImpl = WebSocket,
  readStackInfo = async options => (await import('../../stack/stack_info_snapshot.mjs')).readStackInfoSnapshot(options),
} = {}) {
  let client;
  let key = '';
  try {
    requireSessionName(sessionName);
    if (input.isTTY) return { ok: false, reason: 'stdin_required' };
    for await (const chunk of input) key += chunk;
    const bytes = normalizeDevAuthKeyInputToBytes(key);
    key = '';
    if (!bytes) return { ok: false, reason: 'invalid_key' };
    key = formatDevAuthKeyBackup(Buffer.from(bytes).toString('base64url'));
    if (!cdpHttpUrl) return { ok: false, reason: 'cdp_required' };
    const cdp = new URL(cdpHttpUrl);
    if (!['http:', 'https:'].includes(cdp.protocol)) throw failure('browser_unavailable');
    const info = await readStackInfo({ rootDir, stackName });
    if (!info.urls?.uiUrl || !info.urls?.canonicalServerUrl) throw failure('restore_entry_unavailable');
    const restoreUrl = new URL(info.urls.uiUrl);
    restoreUrl.pathname = '/restore/manual';
    restoreUrl.hash = '';
    restoreUrl.searchParams.set('returnTo', '/');
    restoreUrl.searchParams.set('server', info.urls.canonicalServerUrl);
    const response = await fetchImpl(new URL('/json/list', cdp));
    if (!response.ok) throw failure('browser_unavailable');
    const pages = await response.json();
    const page = pages.find(page => page.type === 'page' && page.url !== 'about:blank'
      && new URL(page.url).origin === restoreUrl.origin)
      ?? pages.find(page => page.type === 'page' && page.url === 'about:blank');
    if (!page?.webSocketDebuggerUrl) throw failure('session_unavailable');
    const endpoint = new URL(page.webSocketDebuggerUrl);
    endpoint.host = cdp.host; // The pool's controller forward owns this address.
    endpoint.protocol = cdp.protocol === 'https:' ? 'wss:' : 'ws:';
    let loaded;
    let navigation;
    const loadedFrames = new Map();
    const contexts = new Map();
    const resolveLoaded = () => {
      if (navigation && loadedFrames.get(navigation.loaderId) === navigation.frameId) loaded?.resolve();
    };
    client = await connectPage(endpoint.href, WebSocketImpl, message => {
      if (message.method === 'Page.lifecycleEvent' && message.params.name === 'load') {
        loadedFrames.set(message.params.loaderId, message.params.frameId);
        resolveLoaded();
      }
      if (message.method === 'Runtime.executionContextCreated') {
        const context = message.params.context;
        if (context.auxData?.isDefault) contexts.set(context.auxData.frameId, context.id);
      }
      if (message.method === 'Runtime.executionContextsCleared') contexts.clear();
      if (message.method === 'Runtime.executionContextDestroyed') {
        for (const [frameId, id] of contexts) if (id === message.params.executionContextId) contexts.delete(frameId);
      }
    });
    const restored = (async () => {
      await client.send('Page.enable');
      await client.send('Page.setLifecycleEventsEnabled', { enabled: true });
      await client.send('Runtime.enable');
      const navigate = async pathname => {
        const url = new URL(restoreUrl);
        url.pathname = pathname;
        if (pathname !== '/restore/manual') url.searchParams.delete('server');
        loaded = Promise.withResolvers();
        loadedFrames.clear();
        navigation = null;
        navigation = await client.send('Page.navigate', { url: url.href });
        if (navigation.errorText) throw failure('restore_entry_unavailable');
        if (!navigation.frameId || !navigation.loaderId) throw failure('browser_unavailable');
        resolveLoaded();
        await loaded.promise;
      };
      const step = async (name, value = '') => {
        const executionContextId = contexts.get(navigation.frameId);
        if (!executionContextId) throw failure('browser_unavailable');
        const pending = client.send('Runtime.callFunctionOn', {
          executionContextId, functionDeclaration: browserStep.toString(),
          arguments: [{ value: name }, { value }], awaitPromise: true, returnByValue: true,
        });
        value = '';
        const result = await pending;
        if (result.exceptionDetails) throw failure('restore_failed');
        return result.result?.value;
      };
      await navigate('/restore/manual');
      const submitted = step('restore', key);
      key = '';
      const outcome = await submitted;
      if (outcome !== 'home') throw failure(['home_unavailable', 'restore_entry_unavailable'].includes(outcome) ? outcome : 'restore_failed');
      await navigate('/settings/account');
      const accountIdPrefix = await step('account');
      if (typeof accountIdPrefix !== 'string' || !/^[a-zA-Z0-9_-]{1,8}$/.test(accountIdPrefix)) throw failure('account_unavailable');
      await navigate('/');
      if (await step('home') !== 'home') throw failure('home_unavailable');
      return { ok: true, accountIdPrefix };
    })();
    return await Promise.race([restored, client.disconnected]);
  } catch (error) {
    // Browser/Playwright/CDP errors may contain the filled value. Only our closed
    // reason vocabulary can cross this boundary; never return exception text.
    const reasons = ['invalid_key', 'stdin_required', 'cdp_required', 'session_unavailable', 'browser_unavailable',
      'restore_entry_unavailable', 'restore_failed', 'home_unavailable', 'account_unavailable'];
    return { ok: false, reason: reasons.includes(error?.reason) ? error.reason : 'browser_unavailable' };
  } finally { key = ''; client?.close(); }
}
