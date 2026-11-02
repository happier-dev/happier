import { COOPERATIVE_NAVIGATION_BIND_KIND, COOPERATIVE_NAVIGATION_BIND_REQUEST_KIND } from './cooperative.js';
import { INJECTED_BROWSER_KEYBOARD_RUNTIME } from './keyboard.js';

/**
 * The cooperative preview's navigation reporter. It is the only part of the collector that every
 * in-frame document of a relay preview carries: it reports history position, loading and title to
 * the exact host that embedded it, and obeys back, forward and stop from that host only. It never
 * admits page automation or diagnostics; the full runtime still does that for the document loaded
 * with the pane's own navigation identity.
 */
export const INJECTED_COOPERATIVE_NAVIGATION_RUNTIME = `
  (function (config) {
    ${INJECTED_BROWSER_KEYBOARD_RUNTIME}
    var navigationPending = false;
    var reportedTitle = null;
    var collectorQueryNames = ['__happierCollector', '__happierCollectorState'];

    function currentUrl() {
      var url = new URL(window.location.href);
      var kept = url.search.replace(/^\\?/, '').split('&').filter(function (part) {
        return part && collectorQueryNames.indexOf(part.split('=', 1)[0]) === -1;
      }).join('&');
      return url.origin + url.pathname + (kept ? '?' + kept : '') + url.hash;
    }

    function reportNavigationState() {
      if (!config || !window.parent || typeof window.parent.postMessage !== 'function') return;
      var navigation = window.navigation;
      var title = String(document.title || '');
      try {
        window.parent.postMessage(JSON.stringify({
          v: 1, kind: 'browser.collector.navigation',
          browserSessionId: config.browserSessionId, viewId: config.viewId,
          navigationGeneration: config.navigationGeneration,
          collectorId: config.collector.collectorId, nonce: config.collector.nonce,
          loading: navigationPending || String(document.readyState) !== 'complete',
          canGoBack: Boolean(navigation && navigation.canGoBack),
          canGoForward: Boolean(navigation && navigation.canGoForward),
          url: currentUrl(),
          title: title
        }), config.webPostMessageTargetOrigin);
        reportedTitle = title;
      } catch (_error) {
        // Reporting is best-effort metadata; it must never disturb the previewed page.
      }
    }

    function handleNavigationCommand(event) {
      if (event.source !== window.parent) return;
      var message = event.data;
      if (typeof message === 'string') {
        try { message = JSON.parse(message); } catch (_error) { return; }
      }
      if (!config) {
        if (!message || message.v !== 1 || message.kind !== '${COOPERATIVE_NAVIGATION_BIND_KIND}'
            || Object.keys(message).length !== 3 || !message.config) return;
        var binding = message.config;
        if (event.origin !== binding.webPostMessageTargetOrigin || !/^https?:\\/\\//.test(event.origin)
            || typeof binding.browserSessionId !== 'string' || typeof binding.viewId !== 'string'
            || !Number.isSafeInteger(binding.navigationGeneration) || !binding.collector
            || typeof binding.collector.collectorId !== 'string' || typeof binding.collector.nonce !== 'string') return;
        // Only the real embedding window supplies identity, and only for this document's navigation reporter.
        config = binding;
        reportNavigationState();
        return;
      }
      if (event.origin !== config.webPostMessageTargetOrigin) return;
      if (message && message.v === 1 && message.kind === 'browser.collector.keyboard.configure'
          && message.browserSessionId === config.browserSessionId && message.viewId === config.viewId
          && message.navigationGeneration === config.navigationGeneration
          && message.collectorId === config.collector.collectorId && message.nonce === config.collector.nonce
          && Array.isArray(message.signatures) && message.signatures.every(function (value) { return typeof value === 'string'; })) {
        installBrowserKeyboard(message.signatures, function (keyboardEvent) {
          window.parent.postMessage(JSON.stringify({ v: 1, kind: 'browser.collector.keyboard',
            browserSessionId: config.browserSessionId, viewId: config.viewId,
            navigationGeneration: config.navigationGeneration,
            collectorId: config.collector.collectorId, nonce: config.collector.nonce, event: keyboardEvent }), config.webPostMessageTargetOrigin);
        });
        return;
      }
      if (!message || message.v !== 1 || message.kind !== 'browser.collector.navigate'
          || message.browserSessionId !== config.browserSessionId || message.viewId !== config.viewId
          || message.navigationGeneration !== config.navigationGeneration
          || message.collectorId !== config.collector.collectorId || message.nonce !== config.collector.nonce) return;
      if (message.command === 'back') window.history.back();
      else if (message.command === 'forward') window.history.forward();
      else if (message.command === 'stop') {
        navigationPending = false;
        window.stop();
        reportNavigationState();
      }
    }

    function requestBinding() {
      if (!config && window.parent && typeof window.parent.postMessage === 'function') {
        // The request carries no identity or page content. The parent verifies its own frame before replying.
        window.parent.postMessage(JSON.stringify({ v: 1, kind: '${COOPERATIVE_NAVIGATION_BIND_REQUEST_KIND}' }), '*');
      }
      reportNavigationState();
    }

    window.addEventListener('message', handleNavigationCommand);
    window.addEventListener('load', reportNavigationState);
    window.addEventListener('pageshow', requestBinding);
    // A page can rename itself after load without navigating. Keep this document's title
    // on the same identity-bound report; unrelated head changes do not publish state.
    if (document.head && typeof window.MutationObserver === 'function') {
      new window.MutationObserver(function () {
        if (String(document.title || '') !== reportedTitle) reportNavigationState();
      }).observe(document.head, { childList: true, characterData: true, subtree: true });
    }
    if (window.navigation && typeof window.navigation.addEventListener === 'function') {
      window.navigation.addEventListener('currententrychange', reportNavigationState);
      window.navigation.addEventListener('navigate', function (event) {
        if (event.destination && event.destination.sameDocument) return;
        navigationPending = true;
        reportNavigationState();
      });
      window.navigation.addEventListener('navigateerror', function () {
        navigationPending = false;
        reportNavigationState();
      });
    }
    requestBinding();
  })(config);
`;
