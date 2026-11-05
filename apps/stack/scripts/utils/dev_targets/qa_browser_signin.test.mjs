import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { browserStep, runQaBrowserSigninPage } from './qa_browser_signin_page.mjs';

const canonicalServerUrl = 'https://qa-home.invalid';
const aliasUrl = 'https://previous-home.invalid';

// Browser DOM/input/observers are a platform boundary; execute the real driver.
async function observe({ alias = false, migrationDeclined = false, blockingDialog, blockingAfterSubmit = false, confirmHomeAliasUrl, step = 'restore' } = {}) {
  let view = 'restore';
  let submitted = false;
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
    getAttribute: name => name === 'aria-label' ? blockingDialog?.title ?? 'Error' : null,
    textContent: blockingDialog?.text ?? (migrationDeclined ? 'Error: Home canonical URL migration was not applied' : `Reached ${canonicalServerUrl}, previously ${aliasUrl}`),
    querySelector: selector => selector === '[data-testid="web-modal-confirm"]' ? (blockingDialog?.confirm === false ? null : confirm) : null,
  };
  const document = {
    documentElement: {},
    querySelector(selector) {
      if ((migrationDeclined || (blockingDialog && (!blockingAfterSubmit || submitted))) && selector === '[role="dialog"]') return dialog;
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
        click() {
          submitted = true;
          if (!blockingAfterSubmit) { view = 'home'; location.pathname = '/'; credentialFilled = false; }
          publish();
        },
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

test('reports a declined canonical migration instead of treating its error dialog as alias consent', async () => {
  assert.deepEqual((await observe({ migrationDeclined: true })).result, { reason: 'home_migration_declined', title: 'Error' });
});

test('reports reachability blockers before and after submission without clicking or retaining input', async () => {
  for (const blockingAfterSubmit of [false, true]) {
    const observed = await observe({ blockingAfterSubmit, blockingDialog: {
      confirm: !blockingAfterSubmit, title: 'Error', text: 'Error Happier couldn’t reach a Home at that address. Check the address and that the Home is running. Cancel Retry',
    }, confirmHomeAliasUrl: aliasUrl });
    assert.deepEqual(observed.result, { reason: 'home_reachability_failed', title: 'Error' });
    assert.equal(observed.aliasConfirmed, false);
    assert.equal(observed.credentialFilled, false);
  }
});

test('leaves other blocking dialogs untouched and omits an unsafe title', async () => {
  const observed = await observe({ blockingDialog: { title: randomBytes(32).toString('base64url'), text: 'Unexpected confirmation Cancel Continue' } });
  assert.deepEqual(observed.result, { reason: 'blocking_dialog', title: null });
  assert.equal(observed.aliasConfirmed, false);
  assert.equal(observed.credentialFilled, false);
});

test('preserves the blocker reason and safe title through the CDP sign-in result', async () => {
  assert.deepEqual(await profileSignin({ restoreOutcome: { reason: 'home_reachability_failed', title: 'Error' } }), {
    ok: false, reason: 'home_reachability_failed', title: 'Error',
  });
});

test('projects both descriptor revisions without returning feature payloads or URL credentials', async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async url => ({ ok: true, json: async () => ({ homeConnectionDescriptor: {
    revision: new URL(url).origin === canonicalServerUrl ? 27 : 62,
  } }) });
  try {
    assert.deepEqual(await browserStep('home-revisions', '', {
      expectedHomeUrl: `${canonicalServerUrl}/?private=discard`, confirmHomeAliasUrl: aliasUrl,
    }), { expectedRevision: 27, actualRevision: 62 });
  } finally { globalThis.fetch = previousFetch; }
});

// CDP is an external transport. Account readiness comes from the actual page
// driver; the loaded profile is a response produced by that navigation.
async function profileSignin({ profile = { id: 'account-owner-id' }, profileOrigin = canonicalServerUrl, internalServerUrl, status = 200, failed = false, cancelledFirst = false, bodyUnavailable = false, malformed = false, accountReady = true, restoreOutcome = 'home', foreignInCurrentDocument = false } = {}) {
  const uiUrl = 'http://qa-ui.localhost:19364';
  class BrowserSocket extends EventTarget {
    navigations = 0;
    constructor() { super(); queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
    message(value) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) })); }
    send(raw) {
      const { id, method, params } = JSON.parse(raw);
      queueMicrotask(() => {
        const loaderId = `document-${this.navigations + 1}`;
        if (method === 'Network.getResponseBody' && bodyUnavailable) {
          this.message({ id, error: { code: -32000, message: 'No resource with given identifier found' } });
          return;
        }
        this.message({ id, result: method === 'Page.navigate'
          ? { frameId: 'main', loaderId }
          : method === 'Runtime.callFunctionOn'
            ? { result: { value: params.arguments[0].value === 'account' ? (accountReady ? 'account' : 'account_unavailable')
              : params.arguments[0].value === 'restore' ? restoreOutcome
                : params.arguments[0].value === 'home-revisions' ? { expectedRevision: 27, actualRevision: 62 } : 'home' } }
            : method === 'Network.getResponseBody'
              ? { body: malformed ? '{' : JSON.stringify(params.requestId === 'profile' ? profile : { id: 'wrong-account' }) } : {} });
        if (method !== 'Page.navigate') return;
        this.navigations++;
        this.message({ method: 'Runtime.executionContextCreated', params: {
          context: { id: 42, auxData: { isDefault: true, frameId: 'main' } },
        } });
        if (new URL(params.url).pathname === '/settings/account') {
          // Observed live: HTTP 200, then canceled before body completion;
          // the app issues a surviving GET in the same frame and loader.
          if (cancelledFirst) {
            this.message({ method: 'Network.requestWillBeSent', params: { requestId: 'canceled-profile', frameId: 'main', loaderId,
              request: { method: 'GET', url: `${canonicalServerUrl}/v1/account/profile` },
            } });
            this.message({ method: 'Network.responseReceived', params: { requestId: 'canceled-profile', frameId: 'main', loaderId, type: 'Fetch',
              response: { url: `${canonicalServerUrl}/v1/account/profile`, status: 200 },
            } });
            this.message({ method: 'Network.loadingFailed', params: { requestId: 'canceled-profile', canceled: true } });
          }
          for (const [requestId, url, frame, loader] of [
            ['previous', canonicalServerUrl, 'main', 'previous'],
            ['foreign', 'https://other-home.invalid', 'main', foreignInCurrentDocument ? loaderId : 'previous'],
            ['iframe', canonicalServerUrl, 'child', loaderId],
            ['profile', profileOrigin, 'main', loaderId],
          ]) {
            this.message({ method: 'Network.requestWillBeSent', params: { requestId, frameId: frame, loaderId: loader, type: 'Fetch',
              request: { method: 'GET', url: `${url}/v1/account/profile` },
            } });
            this.message({ method: 'Network.responseReceived', params: { requestId, frameId: frame, loaderId: loader, type: 'Fetch',
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
  return await runQaBrowserSigninPage({ urls: { uiUrl, canonicalServerUrl, internalServerUrl },
    cdpHttpUrl: 'http://127.0.0.1:9999', key: randomBytes(32).toString('base64url'), confirmHomeAliasUrl: aliasUrl,
  }, { WebSocketImpl: BrowserSocket,
    fetchImpl: async () => ({ ok: true, json: async () => [{ type: 'page', url: 'about:blank',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9999/devtools/page/test' }] }),
  });
}

test('reads Account identity only from this main-frame navigation, ignoring previous documents and child frames', async () => {
  assert.deepEqual(await profileSignin(), { ok: true, accountIdPrefix: 'account-', homeOrigin: canonicalServerUrl });
});

test('reports a declined migration with both safe Home origins and descriptor revisions', async () => {
  assert.deepEqual(await profileSignin({ restoreOutcome: { reason: 'home_migration_declined', title: 'Error' } }), {
    ok: false, reason: 'home_migration_declined', title: 'Error', expectedOrigin: canonicalServerUrl, actualOrigin: aliasUrl,
    expectedRevision: 27, actualRevision: 62,
  });
});

test('refuses an ambiguous current-document profile from another Home even if a canonical response follows', async () => {
  assert.deepEqual(await profileSignin({ foreignInCurrentDocument: true }), {
    ok: false, reason: 'home_origin_mismatch', expectedOrigin: canonicalServerUrl, actualOrigin: 'https://other-home.invalid',
  });
});

test('reads the surviving profile GET after an HTTP 200 request is canceled in the same document', async () => {
  assert.deepEqual(await profileSignin({ cancelledFirst: true }), { ok: true, accountIdPrefix: 'account-', homeOrigin: canonicalServerUrl });
});

for (const [name, options] of [
  ['saved alias', { profileOrigin: aliasUrl }],
  ['internal endpoint', { profileOrigin: 'http://127.0.0.1:3012', internalServerUrl: 'http://127.0.0.1:3012' }],
]) {
  test(`refuses the same Account served by the ${name} instead of the expected Home origin`, async () => {
    assert.deepEqual(await profileSignin(options), {
      ok: false, reason: 'home_origin_mismatch',
      expectedOrigin: canonicalServerUrl, actualOrigin: options.profileOrigin,
    });
  });
}

for (const [name, options, detail] of [
  ['missing Account id', { profile: {} }, 'profile_id_invalid'],
  ['unsuccessful profile response', { status: 503 }, 'profile_http_status'],
  ['failed profile load', { failed: true }, 'profile_load_failed'],
  ['unavailable response body', { bodyUnavailable: true }, 'profile_body_unavailable'],
  ['invalid response JSON', { malformed: true }, 'profile_json_invalid'],
  ['unavailable Account page', { accountReady: false }, 'account_page_unavailable'],
]) {
  test(`attributes Account identity failure from ${name}`, async () => {
    const expected = { ok: false, reason: 'account_unavailable', detail };
    if (detail === 'profile_http_status') expected.status = 503;
    assert.deepEqual(await profileSignin(options), expected);
  });
}
