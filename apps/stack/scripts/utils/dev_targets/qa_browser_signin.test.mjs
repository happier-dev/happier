import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { browserStep, runQaBrowserSigninPage } from './qa_browser_signin_page.mjs';

const canonicalServerUrl = 'https://qa-home.invalid';
const aliasUrl = 'https://previous-home.invalid';

// Browser DOM/input/observers are a platform boundary; execute the real driver.
async function observe({ alias = false, confirmHomeAliasUrl, step = 'restore' } = {}) {
  let view = 'restore';
  let aliasConfirmed = false;
  let credentialFilled = false;
  const observers = new Set();
  const publish = () => { for (const observer of [...observers]) observer(); };
  class Input {
    set value(value) { credentialFilled = value.length > 0; }
    dispatchEvent() {}
  }
  const input = new Input();
  const confirm = { click() { aliasConfirmed = true; publish(); } };
  const dialog = {
    textContent: `Reached ${canonicalServerUrl}, previously ${aliasUrl}`,
    querySelector: () => confirm,
  };
  const document = {
    documentElement: {},
    querySelector(selector) {
      if (alias && !aliasConfirmed && view === 'restore') {
        if (selector === '[role="dialog"]') return dialog;
        if (selector.includes('web-modal-confirm')) return confirm;
        return null;
      }
      if (view === 'account' && selector === '[data-testid="settings-account-identity"]') return {};
      if (view === 'home' && selector === '[data-testid="navigation-sidebar"]') return {};
      if (view !== 'restore') return null;
      if (selector === '[data-testid="restore-manual-wizard"] input') return input;
      if (selector === '[data-testid="restore-manual-submit"]') return {
        click() { view = 'home'; location.pathname = '/'; credentialFilled = false; publish(); },
      };
      return null;
    },
  };
  const location = { pathname: '/restore/manual' };
  const context = {
    document, location, HTMLInputElement: Input, Event,
    requestAnimationFrame: callback => queueMicrotask(callback),
    MutationObserver: class {
      constructor(callback) { this.callback = callback; }
      observe() { observers.add(this.callback); }
      disconnect() { observers.delete(this.callback); }
    },
  };

  if (step === 'account') { view = 'account'; location.pathname = '/settings/account'; }
  const previous = new Map(Object.keys(context).map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  Object.assign(globalThis, context);
  try {
    const pending = browserStep(step, randomBytes(32).toString('base64url'), {
      expectedHomeUrl: canonicalServerUrl, confirmHomeAliasUrl,
    });
    // No producer remains after this fixture's DOM settles. A stale selector
    // cannot satisfy the observable contract and must fail this assertion.
    const result = await Promise.race([pending, new Promise(resolve => setImmediate(() => resolve('no_dom_progress')))]);
    return { result, aliasConfirmed, credentialFilled };
  } finally {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
}

test('observes the mounted Account identity without an account-id row', async () => {
  assert.equal((await observe({ step: 'account' })).result, 'account');
});

test('confirms the explicitly named Home alias before entering a credential', async () => {
  const observed = await observe({ alias: true, confirmHomeAliasUrl: aliasUrl });
  assert.equal(observed.result, 'home');
  assert.equal(observed.aliasConfirmed, true);
  assert.equal(observed.credentialFilled, false);
});

test('leaves an unapproved Home alias unconfirmed and the credential field empty', async () => {
  const observed = await observe({ alias: true });
  assert.equal(observed.result, 'home_alias_confirmation_required');
  assert.equal(observed.aliasConfirmed, false);
  assert.equal(observed.credentialFilled, false);
});

test('refuses an alias different from the explicitly confirmed address', async () => {
  const observed = await observe({ alias: true, confirmHomeAliasUrl: 'https://different-home.invalid' });
  assert.equal(observed.result, 'home_alias_confirmation_required');
  assert.equal(observed.aliasConfirmed, false);
  assert.equal(observed.credentialFilled, false);
});

test('the current Home address does not authorize a different saved alias', async () => {
  const observed = await observe({ alias: true, confirmHomeAliasUrl: canonicalServerUrl });
  assert.equal(observed.result, 'home_alias_confirmation_required');
  assert.equal(observed.aliasConfirmed, false);
  assert.equal(observed.credentialFilled, false);
});

test('restores normally when there is no Home alias warning', async () => {
  assert.equal((await observe()).result, 'home');
});

// CDP is an external transport. Account readiness comes from the actual page
// driver; the loaded profile is a response produced by that navigation.
async function profileSignin({ profile = { id: 'account-owner-id' }, status = 200, failed = false } = {}) {
  const uiUrl = 'http://qa-ui.localhost:19364';
  class BrowserSocket extends EventTarget {
    navigations = 0;
    constructor() { super(); queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
    message(value) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) })); }
    send(raw) {
      const { id, method, params } = JSON.parse(raw);
      queueMicrotask(() => {
        const loaderId = `document-${this.navigations + 1}`;
        this.message({ id, result: method === 'Page.navigate'
          ? { frameId: 'main', loaderId }
          : method === 'Runtime.callFunctionOn'
            ? { result: { value: params.arguments[0].value === 'account' ? 'account' : 'home' } }
            : method === 'Network.getResponseBody'
              ? { body: JSON.stringify(params.requestId === 'profile' ? profile : { id: 'wrong-account' }) } : {} });
        if (method !== 'Page.navigate') return;
        this.navigations++;
        this.message({ method: 'Runtime.executionContextCreated', params: {
          context: { id: 42, auxData: { isDefault: true, frameId: 'main' } },
        } });
        if (new URL(params.url).pathname === '/settings/account') {
          for (const [requestId, url, frame, loader] of [
            ['previous', canonicalServerUrl, 'main', 'previous'],
            ['foreign', 'https://other-home.invalid', 'main', loaderId],
            ['iframe', canonicalServerUrl, 'child', loaderId],
            ['profile', canonicalServerUrl, 'main', loaderId],
          ]) {
            this.message({ method: 'Network.responseReceived', params: { requestId, frameId: frame, loaderId: loader,
              response: { url: `${url}/v1/account/profile`, status: requestId === 'profile' ? status : 200 },
            } });
            this.message({ method: failed && requestId === 'profile' ? 'Network.loadingFailed' : 'Network.loadingFinished',
              params: { requestId } });
          }
          // Missing completion must not leave this finite transport fixture hung.
          setImmediate(() => this.dispatchEvent(new Event('close')));
        }
        this.message({ method: 'Page.lifecycleEvent', params: { name: 'load', frameId: 'main', loaderId } });
      });
    }
    close() {}
  }
  return await runQaBrowserSigninPage({ urls: { uiUrl, canonicalServerUrl },
    cdpHttpUrl: 'http://127.0.0.1:9999', key: randomBytes(32).toString('base64url'),
  }, { WebSocketImpl: BrowserSocket,
    fetchImpl: async () => ({ ok: true, json: async () => [{ type: 'page', url: 'about:blank',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9999/devtools/page/test' }] }),
  });
}

test('reads Account identity only from this main-frame navigation and Home profile', async () => {
  assert.deepEqual(await profileSignin(), { ok: true, accountIdPrefix: 'account-' });
});

for (const [name, options] of [
  ['missing Account id', { profile: {} }],
  ['unsuccessful profile response', { status: 503 }],
  ['failed profile load', { failed: true }],
]) {
  test(`refuses Account identity from ${name}`, async () => {
    assert.deepEqual(await profileSignin(options), { ok: false, reason: 'account_unavailable' });
  });
}
