import { QA_BROWSER_CUSTODY_LOST, QA_BROWSER_CDP_UNAVAILABLE, readQaBrowserCdpTargets } from './qa_browser_cdp.mjs';

// This code only drives the supported restore form. Authentication, Account
// mode discovery and persistence remain owned by SecretKeyLoginForm.
export async function browserStep(step, key, { expectedHomeUrl, confirmHomeAliasUrl } = {}) {
  if (step === 'home-revisions') {
    // Failure diagnostics only: public descriptor facts, never auth storage or
    // response payloads. These observations do not override revision admission.
    const revision = async value => {
      if (!value) return null;
      try {
        const response = await fetch(new URL('/v1/features', new URL(value).origin));
        if (!response.ok) return null;
        const observedRevision = (await response.json()).homeConnectionDescriptor?.revision;
        return Number.isSafeInteger(observedRevision) && observedRevision > 0 ? observedRevision : null;
      } catch { return null; }
    };
    const [expectedRevision, actualRevision] = await Promise.all([
      revision(expectedHomeUrl), revision(confirmHomeAliasUrl),
    ]);
    return { expectedRevision, actualRevision };
  }
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
      && (document.querySelector('[data-testid="navigation-sidebar"]')
        || document.querySelector('[data-testid="main-app-tabbar"]'))) return 'home';
    return null;
  };
  let confirmedDialog;
  let skippedShowcase;
  const blockingDialog = () => {
    const dialog = document.querySelector('[role="dialog"]');
    if (!dialog || dialog === confirmedDialog) return null;
    if (dialog === skippedShowcase) return false;
    const skipShowcase = dialog.querySelector('[data-testid="onboarding-showcase-story-skip"]');
    if (skipShowcase) {
      skippedShowcase = dialog;
      skipShowcase.click();
      // Let the existing DOM observer see the dialog leave before reporting readiness.
      return false;
    }
    // Only public, fixed modal labels may leave the credential page. Other
    // titles and the message can contain input or credentials and stay here.
    const label = dialog.getAttribute('aria-label');
    const title = ['Error', 'Warning', 'Confirmation'].includes(label) ? label : null;
    if (step !== 'restore') return { reason: 'blocking_dialog', title };
    if (dialog.textContent.includes('Home canonical URL migration was not applied')) {
      return { reason: 'home_migration_declined', title };
    }
    const confirm = dialog.querySelector('[data-testid="web-modal-confirm"]');
    // Consent names both addresses. Never accept an arbitrary confirmation or
    // infer trust from a Home's public identity claim.
    const comparable = value => {
      try { return new URL(value).href.replace(/\/$/, ''); } catch { return null; }
    };
    const addresses = (dialog.textContent.match(/https?:\/\/[^\s<>"\u201c\u201d\u2018\u2019]+/g) ?? [])
      .map(value => comparable(value.replace(/[.,;!?)]*$/, '')));
    const expected = comparable(expectedHomeUrl);
    const alias = comparable(confirmHomeAliasUrl);
    if (!confirm || !expected || addresses.length !== 2 || !addresses.includes(expected)) {
      return {
        reason: /Happier couldn[’']t reach a Home at that address/.test(dialog.textContent)
          ? 'home_reachability_failed' : 'blocking_dialog',
        title,
      };
    }
    if (!alias || expected === alias || !addresses.includes(alias)) {
      return 'home_alias_confirmation_required';
    }
    confirmedDialog = dialog;
    confirm.click();
    return null;
  };
  const waitForUnblocked = check => waitFor(() => blockingDialog() ?? check());
  if (step === 'home') return await waitForUnblocked(home);
  if (step === 'account') return await waitForUnblocked(() => {
    const homeState = home();
    if (homeState === 'home_unavailable') return 'account_unavailable';
    return homeState ?? (document.querySelector('[data-testid="settings-account-identity"]') ? 'account' : null);
  });
  const ready = await waitFor(() => {
    if (document.querySelector('[data-testid="home-unreachable"]')) return 'home_unavailable';
    const warning = blockingDialog();
    if (warning !== null) return warning;
    if (home() === 'home') return 'home';
    if (location.pathname !== '/restore/manual') return 'restore_entry_unavailable';
    return document.querySelector('[data-testid="restore-manual-wizard"] input');
  });
  if (typeof ready === 'string' || ready?.reason) return ready;
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
    const outcome = waitForUnblocked(() => {
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


const failure = (reason, detail) => Object.assign(new Error(reason), { reason, detail });

async function connectPage(endpoint, WebSocketImpl, onEvent, signal) {
  const socket = new WebSocketImpl(endpoint);
  const pending = new Map();
  let nextId = 0;
  const disconnected = Promise.withResolvers();
  // The disconnect can precede the caller's race while opening the socket.
  disconnected.promise.catch(() => {});
  const fail = (reason = 'browser_unavailable') => {
    const error = failure(reason);
    for (const request of pending.values()) request.reject(error);
    pending.clear();
    disconnected.reject(error);
  };
  const unavailable = () => fail();
  const cancel = () => { fail('cancelled'); socket.close(); };
  socket.addEventListener('close', unavailable);
  socket.addEventListener('error', unavailable);
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
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
  } catch (error) { signal?.removeEventListener('abort', cancel); socket.close(); throw error; }
  return {
    disconnected: disconnected.promise,
    refuse: fail,
    send(method, params = {}) {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() { signal?.removeEventListener('abort', cancel); socket.close(); },
  };
}


/** Drive an existing browser from the Stack owner's resolved endpoint snapshot. */
export async function runQaBrowserSigninPage({ urls, cdpHttpUrl, key, confirmHomeAliasUrl, signal }, {
  fetchImpl = fetch, WebSocketImpl = WebSocket,
} = {}) {
  let client;
  try {
    if (signal?.aborted) throw failure('cancelled');
    if (!cdpHttpUrl) return { ok: false, reason: 'cdp_required' };
    const cdp = new URL(cdpHttpUrl);
    if (!['http:', 'https:'].includes(cdp.protocol)) throw failure('browser_unavailable');
    if (!urls?.uiUrl || !urls?.canonicalServerUrl) throw failure('restore_entry_unavailable');
    const restoreUrl = new URL(urls.uiUrl);
    restoreUrl.pathname = '/restore/manual';
    restoreUrl.hash = '';
    restoreUrl.searchParams.set('returnTo', '/');
    restoreUrl.searchParams.set('server', urls.canonicalServerUrl);
    const pages = await readQaBrowserCdpTargets(cdp, { fetchImpl, signal });
    const page = pages.find(page => page.type === 'page' && page.url !== 'about:blank'
      && new URL(page.url).origin === restoreUrl.origin)
      ?? pages.find(page => page.type === 'page' && page.url === 'about:blank');
    if (!page?.webSocketDebuggerUrl) throw failure('session_unavailable');
    const endpoint = new URL(page.webSocketDebuggerUrl);
    let loaded;
    let navigation;
    const loadedFrames = new Map();
    const navigatedFrames = new Map();
    const contexts = new Map();
    let observingAccount = false;
    let profileLoaded;
    const profileRequests = new Map();
    // The key form's error copy is cleared with the key, so the Home's answer to
    // the key sign-in requests is the observable cause. Only path, status and
    // failure are recorded; never request or response content.
    let signinRequests = null;
    const expectedOrigin = new URL(urls.canonicalServerUrl).origin;
    const isHomeSigninRequest = value => {
      try {
        const url = new URL(value);
        return url.origin === expectedOrigin
          && ['/v1/auth/challenge', '/v1/auth', '/v1/account/encryption'].includes(url.pathname);
      } catch { return false; }
    };
    const isHomeProfile = value => {
      try {
        const url = new URL(value);
        return url.pathname === '/v1/account/profile';
      } catch { return false; }
    };
    const resolveProfile = () => {
      if (!observingAccount || !navigation) return;
      for (const [requestId, request] of profileRequests) {
        if (request.frameId === navigation.frameId && request.loaderId === navigation.loaderId
          && (request.finished || request.failed)) profileLoaded.resolve({ requestId, ...request });
      }
    };
    const resolveLoaded = () => {
      if (!navigation) return;
      const observedLoader = navigatedFrames.get(navigation.frameId);
      if (observedLoader && observedLoader !== navigation.loaderId) {
        const error = failure('restore_entry_unavailable');
        loaded?.reject(error);
        client.refuse('restore_entry_unavailable');
      } else if (loadedFrames.get(navigation.loaderId) === navigation.frameId) loaded?.resolve();
    };
    client = await connectPage(endpoint.href, WebSocketImpl, message => {
      if (message.method === 'Page.frameNavigated') {
        const { id, loaderId } = message.params.frame;
        navigatedFrames.set(id, loaderId);
        resolveLoaded();
      }
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
      if (signinRequests) {
        const params = message.params;
        if (message.method === 'Network.requestWillBeSent' && isHomeSigninRequest(params.request.url)) signinRequests.set(params.requestId, {});
        const request = signinRequests.get(params?.requestId);
        if (request && message.method === 'Network.responseReceived') request.status = params.response.status;
        if (request && message.method === 'Network.loadingFailed' && params.canceled !== true) request.failed = true;
      }
      if (observingAccount) {
        const params = message.params;
        if (message.method === 'Network.requestWillBeSent' && isHomeProfile(params.request.url)) {
          profileRequests.set(params.requestId, { frameId: params.frameId, loaderId: params.loaderId,
            origin: new URL(params.request.url).origin });
        }
        if (message.method === 'Network.responseReceived' && isHomeProfile(params.response.url)) {
          profileRequests.set(params.requestId, { frameId: params.frameId, loaderId: params.loaderId,
            origin: new URL(params.response.url).origin, status: params.response.status });
        }
        const request = profileRequests.get(params?.requestId);
        if (request && message.method === 'Network.loadingFinished') { request.finished = true; resolveProfile(); }
        if (request && message.method === 'Network.loadingFailed') {
          // An aborted startup fetch is not the profile the Account page loaded.
          // Keep observing the app's surviving request, without issuing our own.
          if (params.canceled === true) profileRequests.delete(params.requestId);
          else { request.failed = true; resolveProfile(); }
        }
      }
    }, signal);
    const restored = (async () => {
      await client.send('Page.enable');
      await client.send('Page.setLifecycleEventsEnabled', { enabled: true });
      await client.send('Runtime.enable');
      await client.send('Network.enable');
      const navigate = async pathname => {
        const url = new URL(restoreUrl);
        url.pathname = pathname;
        // Each full document load needs the explicit Home entry again.
        // Keep the browser's saved default unchanged while verifying this stack.
        loaded = Promise.withResolvers();
        loadedFrames.clear();
        navigatedFrames.clear();
        navigation = null;
        navigation = await client.send('Page.navigate', { url: url.href });
        if (navigation.errorText) throw failure('restore_entry_unavailable');
        if (!navigation.frameId || !navigation.loaderId) throw failure('browser_unavailable');
        resolveLoaded();
        resolveProfile();
        await loaded.promise;
      };
      const step = async (name, value = '') => {
        const executionContextId = contexts.get(navigation.frameId);
        if (!executionContextId) throw failure('browser_unavailable');
        const pending = client.send('Runtime.callFunctionOn', {
          executionContextId, functionDeclaration: browserStep.toString(),
          arguments: [{ value: name }, { value }, { value: { expectedHomeUrl: urls.canonicalServerUrl, confirmHomeAliasUrl } }],
          awaitPromise: true, returnByValue: true,
        });
        value = '';
        const result = await pending;
        if (result.exceptionDetails) throw failure('restore_failed');
        const outcome = result.result?.value;
        if (outcome?.reason === 'home_reachability_failed' || outcome?.reason === 'blocking_dialog') {
          throw Object.assign(failure(outcome.reason), { title: outcome.title });
        }
        return outcome;
      };
      signinRequests = new Map();
      await navigate('/restore/manual');
      const submitted = step('restore', key);
      key = '';
      const outcome = await submitted;
      const signinFailure = [...signinRequests.values()].find(request => request.failed
        || (Number.isInteger(request.status) && (request.status < 200 || request.status >= 300)));
      signinRequests = null;
      if (outcome?.reason === 'home_migration_declined') {
        const revisions = await step('home-revisions');
        throw Object.assign(failure(outcome.reason), revisions, { title: outcome.title, expectedOrigin,
          actualOrigin: confirmHomeAliasUrl ? new URL(confirmHomeAliasUrl).origin : null });
      }
      if (outcome !== 'home' && ['home_unavailable', 'restore_entry_unavailable', 'home_alias_confirmation_required'].includes(outcome)) throw failure(outcome);
      if (outcome !== 'home') {
        if (signinFailure?.failed) throw failure('restore_failed', 'home_request_failed');
        if (signinFailure) throw Object.assign(failure('restore_failed', 'home_http_status'), { status: signinFailure.status });
        throw failure('restore_failed');
      }
      observingAccount = true;
      profileLoaded = Promise.withResolvers();
      await navigate('/settings/account');
      // The current UI mounts its identity header without an Account-id row.
      // Observe the profile this main-frame navigation loaded; do not inspect
      // credential storage or infer identity from an editable display name.
      // Settle profile failures before waiting for DOM they may never render.
      const profileRequest = await profileLoaded.promise;
      if (profileRequest.origin !== expectedOrigin) {
        throw Object.assign(failure('home_origin_mismatch'), { expectedOrigin, actualOrigin: profileRequest.origin });
      }
      if (profileRequest.failed) throw failure('account_unavailable', 'profile_load_failed');
      if (profileRequest.status !== 200) throw Object.assign(failure('account_unavailable', 'profile_http_status'), { status: profileRequest.status });
      let response;
      try {
        response = await client.send('Network.getResponseBody', { requestId: profileRequest.requestId });
      } catch { throw failure('account_unavailable', 'profile_body_unavailable'); }
      let profile;
      try {
        const body = response.base64Encoded ? Buffer.from(response.body, 'base64').toString('utf8') : response.body;
        profile = JSON.parse(body);
      } catch { throw failure('account_unavailable', 'profile_json_invalid'); }
      if (typeof profile?.id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(profile.id)) throw failure('account_unavailable', 'profile_id_invalid');
      // Account settings can return to Home during startup without mounting its identity header.
      const accountView = await step('account');
      if (accountView !== 'account' && accountView !== 'home') throw failure('account_unavailable', 'account_page_unavailable');
      const accountIdPrefix = profile.id.slice(0, 8);
      observingAccount = false;
      if (accountView === 'account') {
        await navigate('/');
        if (await step('home') !== 'home') throw failure('home_unavailable');
      }
      return { ok: true, accountIdPrefix, homeOrigin: profileRequest.origin };
    })();
    return await Promise.race([restored, client.disconnected]);
  } catch (error) {
    // Browser/Playwright/CDP errors may contain the filled value. Only our closed
    // reason vocabulary can cross this boundary; never return exception text.
    const reasons = [QA_BROWSER_CUSTODY_LOST, QA_BROWSER_CDP_UNAVAILABLE, 'cancelled', 'invalid_key', 'stdin_required', 'cdp_required', 'session_unavailable', 'browser_unavailable',
      'restore_entry_unavailable', 'restore_failed', 'home_unavailable', 'account_unavailable', 'home_alias_confirmation_required', 'home_origin_mismatch', 'home_migration_declined', 'home_reachability_failed', 'blocking_dialog'];
    const reason = signal?.aborted ? 'cancelled' : error?.code ?? error?.reason;
    const result = { ok: false, reason: reasons.includes(reason) ? reason : 'browser_unavailable' };
    if (result.reason === 'home_reachability_failed' || result.reason === 'blocking_dialog' || result.reason === 'home_migration_declined') result.title = error.title;
    if (result.reason === 'home_origin_mismatch' || result.reason === 'home_migration_declined') {
      result.expectedOrigin = error.expectedOrigin;
      result.actualOrigin = error.actualOrigin;
    }
    if (result.reason === 'home_migration_declined') {
      result.expectedRevision = error.expectedRevision;
      result.actualRevision = error.actualRevision;
    }
    const details = ['account_page_unavailable', 'profile_load_failed', 'profile_http_status',
      'profile_body_unavailable', 'profile_json_invalid', 'profile_id_invalid'];
    if (result.reason === 'account_unavailable' && details.includes(error.detail)) {
      result.detail = error.detail;
      if (error.detail === 'profile_http_status' && Number.isInteger(error.status)) result.status = error.status;
    }
    if (result.reason === 'restore_failed' && ['home_http_status', 'home_request_failed'].includes(error.detail)) {
      result.detail = error.detail;
      if (error.detail === 'home_http_status' && Number.isInteger(error.status)) result.status = error.status;
    }
    return result;
  } finally { key = ''; client?.close(); }
}
