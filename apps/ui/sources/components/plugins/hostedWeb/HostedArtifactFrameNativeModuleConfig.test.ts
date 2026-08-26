import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const moduleRoot = join(process.cwd(), 'modules/happier-hosted-web-frame');

function readJson(path: string): unknown {
    return JSON.parse(readFileSync(path, 'utf8'));
}

describe('hosted Artifact native-frame Expo module config', () => {
    it('autolinks one token-scoped frame module on Android and iOS', () => {
        expect(readJson(join(moduleRoot, 'package.json'))).toEqual(expect.objectContaining({
            name: 'happier-hosted-web-frame',
            private: true,
            files: expect.arrayContaining(['android', 'ios', 'expo-module.config.json', 'package.json']),
        }));
        expect(readJson(join(moduleRoot, 'expo-module.config.json'))).toEqual({
            name: 'HappierHostedWebFrame',
            platforms: ['android', 'ios'],
            android: {
                modules: ['dev.happier.hostedwebframe.HappierHostedWebFrameModule'],
            },
            ios: {
                modules: ['HappierHostedWebFrameModule'],
            },
        });
    });

    it('ships a local-only iOS token registry and nonpersistent frame view', () => {
        const registry = join(moduleRoot, 'ios/HostedWebArtifactRegistry.swift');
        const view = join(moduleRoot, 'ios/HostedWebArtifactView.swift');
        const module = join(moduleRoot, 'ios/HappierHostedWebFrameModule.swift');
        const podspec = join(moduleRoot, 'ios/HappierHostedWebFrame.podspec');

        for (const file of [registry, view, module, podspec]) {
            expect(existsSync(file)).toBe(true);
        }

        const registrySource = readFileSync(registry, 'utf8');
        const viewSource = readFileSync(view, 'utf8');
        const moduleSource = readFileSync(module, 'utf8');

        expect(registrySource).toContain('storageLocator');
        expect(registrySource).toContain('policyTable');
        expect(registrySource).toContain('static let localScheme = "happier-hosted-artifact"');
        expect(registrySource).not.toContain('URLSession');
        expect(viewSource).toContain('WKURLSchemeHandler');
        expect(viewSource).toContain('WKWebsiteDataStore.nonPersistent()');
        expect(viewSource).toContain('onExternalNavigation');
        expect(viewSource).toContain('func goBack() -> Bool');
        expect(viewSource).toContain('onHistoryStateChange');
        expect(viewSource).toContain('nextWebView.observe(\\.canGoBack');
        expect(viewSource).toContain('historyObservation?.invalidate()');
        expect(viewSource).not.toContain('allowedNavigationOrigins.contains(where: { $0.matches(url) }) {\n      decisionHandler(.allow)');
        expect(viewSource).not.toContain('loadHTMLString');
        expect(moduleSource).toContain('Function("unregisterArtifact")');
        // One strict registration result on every platform: no Bool ABI.
        expect(moduleSource).toContain('AsyncFunction("registerArtifact") { (input: [String: Any]) -> [String: Any] in');
        expect(moduleSource).toContain('return ["kind": "registered"]');
        expect(moduleSource).not.toContain('AsyncFunction("registerArtifact") { (input: [String: Any]) -> Bool in');
        expect(moduleSource).toContain('View(HostedWebArtifactView.self)');
        expect(moduleSource).toContain('AsyncFunction("goBack")');
        expect(moduleSource).toContain('"onHistoryStateChange"');
    });

    it('projects the resolved host title onto each child WebView without making its frame wrapper accessible', () => {
        const iosViewSource = readFileSync(join(moduleRoot, 'ios/HostedWebArtifactView.swift'), 'utf8');
        const iosModuleSource = readFileSync(join(moduleRoot, 'ios/HappierHostedWebFrameModule.swift'), 'utf8');
        const androidViewSource = readFileSync(join(
            moduleRoot,
            'android/src/main/java/dev/happier/hostedwebframe/HostedWebArtifactView.kt',
        ), 'utf8');
        const androidModuleSource = readFileSync(join(
            moduleRoot,
            'android/src/main/java/dev/happier/hostedwebframe/HappierHostedWebFrameModule.kt',
        ), 'utf8');

        expect(iosModuleSource).toContain('Prop("title") { (view: HostedWebArtifactView, title: String?) in');
        expect(iosModuleSource).toContain('view.setTitle(title)');
        expect(iosViewSource).toContain('private var title: String?');
        expect(iosViewSource).toContain('func setTitle(_ title: String?)');
        expect(iosViewSource).toContain('nextWebView.accessibilityLabel = title');
        expect(iosViewSource).not.toContain('isAccessibilityElement = true');

        expect(androidModuleSource).toContain('Prop<String?>("title") { view, title ->');
        expect(androidModuleSource).toContain('view.setTitle(title)');
        expect(androidViewSource).toContain('private var title: String? = null');
        expect(androidViewSource).toContain('fun setTitle(title: String?)');
        expect(androidViewSource).toContain('nextWebView.contentDescription = title');
    });

    it('uses a fresh AndroidX profile so remounting one partition cannot recover cookies', () => {
        const viewSource = readFileSync(join(
            moduleRoot,
            'android/src/main/java/dev/happier/hostedwebframe/HostedWebArtifactView.kt',
        ), 'utf8');
        const moduleSource = readFileSync(join(
            moduleRoot,
            'android/src/main/java/dev/happier/hostedwebframe/HappierHostedWebFrameModule.kt',
        ), 'utf8');

        // A token's HTTPS origin is intentionally stable across remounts. Its
        // WebView profile must not be: a new UUID-owned profile keeps both
        // host-only and parent-domain cookies out of the replacement frame,
        // even while AndroidX completes deletion of the retired profile.
        expect(viewSource).toContain('private var webView: WebView? = null');
        expect(viewSource).toContain('private var activeProfileName: String? = null');
        expect(viewSource).toContain('private fun newProfileName(): String');
        expect(viewSource).toContain('UUID.randomUUID()');
        expect(viewSource).toContain('WebViewCompat.setProfile(nextWebView, profileName)');
        expect(viewSource.indexOf('WebViewCompat.setProfile(nextWebView, profileName)')).toBeLessThan(
            viewSource.indexOf('configureWebView(nextWebView, origin)'),
        );
        expect(viewSource).toContain('currentWebView.destroy()');
        expect(viewSource).toContain('ProfileStore.getInstance().deleteProfile(profileName)');
        expect(viewSource.indexOf('currentWebView.destroy()')).toBeLessThan(
            viewSource.indexOf('ProfileStore.getInstance().deleteProfile(profileName)'),
        );
        expect(viewSource).toContain('override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean');
        expect(viewSource).toContain('clearCurrentFrameState(skipNavigation = true)');
        expect(viewSource).toContain('profileStore.getAllProfileNames()');
        expect(viewSource).toContain('.take(MAX_ORPHANED_HOSTED_WEB_PROFILES_PER_START)');
        expect(viewSource).toContain('it.startsWith(HOSTED_WEB_PROFILE_PREFIX)');
        expect(moduleSource).toContain('OnCreate {');
        expect(moduleSource).toContain('HostedWebArtifactView.cleanupOrphanedProfiles()');
        expect(moduleSource).toContain('Handler(Looper.getMainLooper()).post(cleanup)');
        expect(viewSource).not.toContain('WebStorage.getInstance().deleteOrigin');
        expect(moduleSource).not.toContain('WebStorage.getInstance().deleteOrigin');
        expect(viewSource).toContain('fun goBack(): Boolean');
        expect(viewSource).toContain('onHistoryStateChange');
        expect(viewSource).toContain('override fun doUpdateVisitedHistory(view: WebView, url: String, isReload: Boolean)');
        expect(moduleSource).toContain('AsyncFunction("goBack")');
        expect(moduleSource).toContain('"onHistoryStateChange"');
    });

    it('keeps a busy retired AndroidX profile pending and retries it on the next frame lifecycle', () => {
        const viewSource = readFileSync(join(
            moduleRoot,
            'android/src/main/java/dev/happier/hostedwebframe/HostedWebArtifactView.kt',
        ), 'utf8');
        const loadIfReady = viewSource.slice(
            viewSource.indexOf('private fun loadIfReady()'),
            viewSource.indexOf('private fun clearCurrentFrameState(skipNavigation: Boolean = false)'),
        );
        const clearCurrentFrameState = viewSource.slice(
            viewSource.indexOf('private fun clearCurrentFrameState(skipNavigation: Boolean = false)'),
            viewSource.indexOf('private fun destroyUnloadedWebView('),
        );
        const retryPendingCleanup = viewSource.slice(
            viewSource.indexOf('private fun retryPendingProfileCleanup()'),
            viewSource.indexOf('private fun deleteProfile('),
        );

        // AndroidX can reject deletion once after the owning WebView has been
        // destroyed. The name must remain owner-local and retried once by the
        // next natural frame lifecycle; `deleteProfile(false)` is already
        // absent, so it must clear pending state rather than become a retry.
        expect(viewSource).toContain('private val pendingProfileNames = LinkedHashSet<String>()');
        expect(viewSource).toContain('catch (error: IllegalStateException)');
        expect(viewSource).toContain('pendingProfileNames.add(profileName)');
        expect(viewSource).toContain('pendingProfileNames.remove(profileName)');
        expect(viewSource).toContain('onLoadError(mapOf("code" to "hosted_web_profile_cleanup_pending"))');
        expect(viewSource).toContain('Log.w(HOSTED_WEB_LOG_TAG');
        expect(clearCurrentFrameState.indexOf('currentWebView.destroy()')).toBeLessThan(
            clearCurrentFrameState.indexOf('deleteRetiredProfile(profileName)'),
        );
        expect(loadIfReady).toContain('retryPendingProfileCleanup()');
        expect(loadIfReady.indexOf('retryPendingProfileCleanup()')).toBeLessThan(
            loadIfReady.indexOf('val token = artifactHandleToken'),
        );
        expect(retryPendingCleanup).toContain('pendingProfileNames.toList()');
        expect(retryPendingCleanup).toContain('.forEach(::deleteProfile)');
        expect(viewSource).toContain('.filter { it.startsWith(HOSTED_WEB_PROFILE_PREFIX) && !activeProfileNames.contains(it) }');
    });

    it('keeps the active origin local while denying the reserved apex and every sibling hosted origin', () => {
        const viewSource = readFileSync(join(
            moduleRoot,
            'android/src/main/java/dev/happier/hostedwebframe/HostedWebArtifactView.kt',
        ), 'utf8');
        const requestHandler = viewSource.slice(
            viewSource.indexOf('override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest)'),
            viewSource.indexOf('@Deprecated("Deprecated in Java")', viewSource.indexOf('override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest)')),
        );
        const deprecatedRequestHandler = viewSource.slice(
            viewSource.indexOf('override fun shouldInterceptRequest(view: WebView, url: String)'),
            viewSource.indexOf('override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest)'),
        );

        // A cookie scoped as `Domain=plugins.happier.dev` must remain inside
        // the concrete profile that received it. The reserved apex and every
        // non-active hosted subdomain must be rejected locally rather than
        // falling through to the external network. Exact origin matching—not
        // merely matching the active hostname—keeps a wrong scheme/port from
        // becoming an escape hatch.
        expect(viewSource).toContain('internal fun isReservedHostedWebDomain(host: String?, isActiveOrigin: Boolean): Boolean');
        expect(viewSource).toContain('.removeSuffix(".")');
        expect(viewSource).toContain('host == HOSTED_WEB_DOMAIN || host.endsWith(".$HOSTED_WEB_DOMAIN")');
        expect(viewSource).toContain('return !isActiveOrigin && reservedHost');
        expect(requestHandler).toContain('val isActiveOrigin = origin.matches(request.url)');
        expect(requestHandler).toContain('if (isReservedHostedWebDomain(request.url.host, isActiveOrigin)) return rejectionResponse(404)');
        expect(deprecatedRequestHandler).toContain('val isActiveOrigin = origin.matches(uri)');
        expect(deprecatedRequestHandler).toContain('if (isReservedHostedWebDomain(uri.host, isActiveOrigin)) return rejectionResponse(404)');
    });

    it('retires and reports only a current Android main-document load failure', () => {
        const viewSource = readFileSync(join(
            moduleRoot,
            'android/src/main/java/dev/happier/hostedwebframe/HostedWebArtifactView.kt',
        ), 'utf8');
        const failureLifecycle = viewSource.slice(
            viewSource.indexOf('private fun retireCurrentMainFrameAfterLoadFailure('),
            viewSource.indexOf('private fun unloadUnexpectedNavigation('),
        );

        // Android reports resource callbacks for iframes and subresources too.
        // Only a still-current top-level Artifact document may move the React
        // pane from loading to its canonical recoverable-error state; retire
        // that exact surface first so a late finish cannot re-expose it.
        expect(viewSource).toContain(
            'override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError)',
        );
        expect(viewSource).toContain(
            'override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, errorResponse: WebResourceResponse)',
        );
        expect(failureLifecycle).toContain('if (!request.isForMainFrame || view !== webView) return');
        expect(failureLifecycle).toContain('if (!origin.matches(request.url)) return');
        expect(failureLifecycle).toContain('clearCurrentFrameState(skipNavigation = true)');
        expect(failureLifecycle).toContain('onLoadError(mapOf("code" to "hosted_web_artifact_load_failed"))');
        expect(failureLifecycle.indexOf('clearCurrentFrameState(skipNavigation = true)')).toBeLessThan(
            failureLifecycle.indexOf('onLoadError(mapOf("code" to "hosted_web_artifact_load_failed"))'),
        );
    });

    it('splits the Protocol HTTP Content-Type fact before constructing an Android WebResourceResponse', () => {
        const viewSource = readFileSync(join(
            moduleRoot,
            'android/src/main/java/dev/happier/hostedwebframe/HostedWebArtifactView.kt',
        ), 'utf8');
        const pathHandler = viewSource.slice(
            viewSource.indexOf('private class TokenPathHandler('),
            viewSource.indexOf('private class ArtifactBridge('),
        );

        // Protocol owns the media type and emits normal HTTP content-type
        // syntax. Android owns only splitting that one fact into the separate
        // WebResourceResponse MIME/charset arguments; it must never invent a
        // second local MIME table or assign a text charset to binary bytes.
        expect(viewSource).toContain('internal fun parseWebResourceResponseContentType(contentType: String): WebResourceResponseContentType?');
        expect(pathHandler).toContain('val parsedContentType = parseWebResourceResponseContentType(response.contentType)');
        expect(pathHandler).toContain('parsedContentType.mimeType');
        expect(pathHandler).toContain('parsedContentType.charset');
        expect(pathHandler).not.toContain('response.contentType,\n            "utf-8"');
    });

    it('fails registration and loading closed when AndroidX profile isolation is unavailable', () => {
        const viewSource = readFileSync(join(
            moduleRoot,
            'android/src/main/java/dev/happier/hostedwebframe/HostedWebArtifactView.kt',
        ), 'utf8');
        const moduleSource = readFileSync(join(
            moduleRoot,
            'android/src/main/java/dev/happier/hostedwebframe/HappierHostedWebFrameModule.kt',
        ), 'utf8');

        expect(viewSource).toContain('WebViewFeature.MULTI_PROFILE');
        expect(viewSource).toContain('WebViewFeature.DOCUMENT_START_SCRIPT');
        expect(viewSource).toContain('"hosted_web_profile_isolation_unavailable"');
        expect(viewSource.indexOf('if (!isProfileIsolationSupported())')).toBeLessThan(
            viewSource.indexOf('WebView(context)'),
        );
        expect(moduleSource).toContain('"hosted_web_profile_isolation_unavailable"');
        expect(moduleSource).toContain('HostedWebArtifactView.profileIsolationUnavailableCapability()');
        expect(moduleSource).toContain('"capability" to profileIsolationCapability');
        expect(moduleSource).not.toContain('if (!HostedWebArtifactView.isProfileIsolationSupported()) return@AsyncFunction false');
    });

    it('binds the Android bridge to the exact active top-level origin instead of exposing a global JS interface', () => {
        const viewSource = readFileSync(join(
            moduleRoot,
            'android/src/main/java/dev/happier/hostedwebframe/HostedWebArtifactView.kt',
        ), 'utf8');
        const configureWebView = viewSource.slice(
            viewSource.indexOf('private fun configureWebView(nextWebView: WebView, origin: HostedWebOrigin)'),
            viewSource.indexOf('private fun loadIfReady()'),
        );
        const clearCurrentFrameState = viewSource.slice(
            viewSource.indexOf('private fun clearCurrentFrameState(skipNavigation: Boolean = false)'),
            viewSource.indexOf('private fun destroyUnloadedWebView('),
        );

        // A top-level page can contain cross-origin frames. The bridge must be
        // injected only into the exact Artifact origin and independently reject
        // non-main-frame messages; checking the WebView's current URL after a
        // globally exposed JavascriptInterface would still let an iframe speak.
        expect(viewSource).toContain('WebViewFeature.WEB_MESSAGE_LISTENER');
        expect(viewSource).not.toContain('nextWebView.addJavascriptInterface(');
        expect(configureWebView).toContain('WebViewCompat.addWebMessageListener(');
        expect(configureWebView).toContain('setOf(origin.asString())');
        expect(configureWebView).toContain('!isMainFrame');
        expect(configureWebView).toContain('origin.matches(sourceOrigin)');
        expect(clearCurrentFrameState).toContain(
            'WebViewCompat.removeWebMessageListener(currentWebView, BRIDGE_INTERFACE_NAME)',
        );
    });

    it('retires an iOS hosted frame synchronously on UIKit detachment and can reload after a reattach', () => {
        const viewSource = readFileSync(join(moduleRoot, 'ios/HostedWebArtifactView.swift'), 'utf8');
        const detachmentLifecycle = viewSource.slice(
            viewSource.indexOf('override func willMove(toSuperview newSuperview: UIView?)'),
            viewSource.indexOf('func setArtifactHandleToken(_ token: String?)'),
        );

        // Expo's iOS view definition has no destruction callback. Waiting for
        // ARC/deinit leaves an active scheme handler, message handler, and
        // nonpersistent WebView alive past React detachment. UIKit's real
        // detach callback must clear it immediately, while reattachment must
        // remain able to reload the still-current token rather than creating a
        // permanently disposed view reuse path.
        expect(viewSource).toContain('override func willMove(toSuperview newSuperview: UIView?)');
        expect(detachmentLifecycle).toContain('newSuperview == nil');
        expect(detachmentLifecycle).toContain('clearCurrentFrameState()');
        expect(detachmentLifecycle).toContain('override func didMoveToSuperview()');
        expect(detachmentLifecycle).toContain('loadIfReady()');
    });

    it('retires an iOS WebKit renderer after process termination before publishing the canonical recoverable error', () => {
        const viewSource = readFileSync(join(moduleRoot, 'ios/HostedWebArtifactView.swift'), 'utf8');
        const terminationLifecycle = viewSource.slice(
            viewSource.indexOf('func webViewWebContentProcessDidTerminate(_ webView: WKWebView)'),
            viewSource.indexOf('private static func documentStartBridge'),
        );

        // A terminated WKWebView must not retain its scheme/message handlers
        // or keep a stale host bridge live. The pane already owns the visible
        // error/reopen flow, so the native adapter reports the shared renderer
        // crash code after retiring its exact view instead of adding a local
        // retry/currentness owner.
        expect(viewSource).toContain('func webViewWebContentProcessDidTerminate(_ webView: WKWebView)');
        expect(terminationLifecycle).toContain('guard webView === self.webView else');
        expect(terminationLifecycle).toContain('clearCurrentFrameState()');
        expect(terminationLifecycle).toContain('onLoadError(["code": "hosted_web_renderer_crashed"])');
        expect(terminationLifecycle.indexOf('clearCurrentFrameState()')).toBeLessThan(
            terminationLifecycle.indexOf('onLoadError(["code": "hosted_web_renderer_crashed"])'),
        );
        expect(terminationLifecycle).not.toContain('loadIfReady()');
    });

    it('retires both current iOS main-document failure phases without consulting WebKit’s nullable or previous URL', () => {
        const viewSource = readFileSync(join(moduleRoot, 'ios/HostedWebArtifactView.swift'), 'utf8');
        const provisionalFailure = viewSource.slice(
            viewSource.indexOf('func webView(\n    _ webView: WKWebView,\n    didFailProvisionalNavigation'),
            viewSource.indexOf('func webView(\n    _ webView: WKWebView,\n    didFail navigation:'),
        );
        const committedFailure = viewSource.slice(
            viewSource.indexOf('func webView(\n    _ webView: WKWebView,\n    didFail navigation:'),
            viewSource.indexOf('func webViewWebContentProcessDidTerminate(_ webView: WKWebView)'),
        );
        const failureLifecycle = viewSource.slice(
            viewSource.indexOf('private func retireCurrentMainFrameAfterLoadFailure('),
            viewSource.indexOf('func webViewWebContentProcessDidTerminate(_ webView: WKWebView)'),
        );
        const clearedFrame = viewSource.slice(
            viewSource.indexOf('private func clearCurrentFrameState()'),
            viewSource.indexOf('private func isActiveArtifactPage()'),
        );

        // WKNavigationDelegate reports main-frame navigation progress, but a
        // provisional failure can arrive before `webView.url` is set and a
        // committed failure can still expose the previous URL. The native
        // owner must use its current frame binding, retire it first, and have
        // one shared error publication path so either failure phase cannot
        // leave the scheme handler/bridge/view reachable or double-report.
        expect(provisionalFailure).toContain('retireCurrentMainFrameAfterLoadFailure(webView, error: error)');
        expect(committedFailure).toContain('retireCurrentMainFrameAfterLoadFailure(webView, error: error)');
        expect(provisionalFailure).not.toContain('isActiveArtifactPage()');
        expect(provisionalFailure).not.toContain('webView.url');
        expect(committedFailure).not.toContain('isActiveArtifactPage()');
        expect(committedFailure).not.toContain('webView.url');
        expect(failureLifecycle).toContain('webView === self.webView,');
        expect(failureLifecycle).toContain('let token = artifactHandleToken');
        expect(failureLifecycle).toContain('let activeOrigin');
        expect(failureLifecycle).toContain('HostedWebArtifactRegistryOwner.shared.origin(for: token) == activeOrigin');
        expect(failureLifecycle).toContain('activeSchemeHandler != nil');
        expect(failureLifecycle).toContain('loadedKey != nil');
        expect(failureLifecycle).not.toContain('webView.url');
        expect(failureLifecycle).not.toContain('isActiveArtifactPage()');
        expect(failureLifecycle).toContain('clearCurrentFrameState()');
        expect(failureLifecycle).toContain('onLoadError(["code": "hosted_web_artifact_load_failed"])');
        expect(failureLifecycle.indexOf('clearCurrentFrameState()')).toBeLessThan(
            failureLifecycle.indexOf('onLoadError(["code": "hosted_web_artifact_load_failed"])'),
        );
        expect(failureLifecycle.match(/onLoadError\(\["code": "hosted_web_artifact_load_failed"\]\)/g)).toHaveLength(1);
        expect(failureLifecycle).not.toContain('loadIfReady()');
        expect(clearedFrame).toContain('activeOrigin = nil');
        expect(clearedFrame).toContain('activeSchemeHandler = nil');
        expect(clearedFrame).toContain('loadedKey = nil');
        expect(clearedFrame).toContain('webView.navigationDelegate = nil');
        expect(clearedFrame).toContain('webView.uiDelegate = nil');
        expect(clearedFrame).toContain('removeScriptMessageHandler(forName: hostedWebBridgeName)');
        expect(clearedFrame).toContain('removeAllUserScripts()');
        expect(clearedFrame).toContain('webView.removeFromSuperview()');
        expect(clearedFrame).toContain('self.webView = nil');
    });

    it('keeps intentional iOS navigation cancellations inert without masking either genuine failure phase', () => {
        const viewSource = readFileSync(join(moduleRoot, 'ios/HostedWebArtifactView.swift'), 'utf8');
        const provisionalFailure = viewSource.slice(
            viewSource.indexOf('func webView(\n    _ webView: WKWebView,\n    didFailProvisionalNavigation'),
            viewSource.indexOf('func webView(\n    _ webView: WKWebView,\n    didFail navigation:'),
        );
        const committedFailure = viewSource.slice(
            viewSource.indexOf('func webView(\n    _ webView: WKWebView,\n    didFail navigation:'),
            viewSource.indexOf('private func retireCurrentMainFrameAfterLoadFailure('),
        );
        const failureLifecycle = viewSource.slice(
            viewSource.indexOf('private func retireCurrentMainFrameAfterLoadFailure('),
            viewSource.indexOf('func webViewWebContentProcessDidTerminate(_ webView: WKWebView)'),
        );
        const navigationPolicy = viewSource.slice(
            viewSource.indexOf('func webView(\n    _ webView: WKWebView,\n    decidePolicyFor navigationAction:'),
            viewSource.indexOf('func webView(_ webView: WKWebView, didStartProvisionalNavigation'),
        );

        // The host intentionally cancels a permitted external main-frame
        // navigation after handing it off. WebKit reports that policy decision
        // as its legacy FrameLoadInterruptedByPolicyChange identity, while a
        // superseded navigation reports NSURLErrorCancelled. Neither is an
        // Artifact document failure; every other current provisional or
        // committed error still reaches the common retiring path.
        expect(navigationPolicy).toContain('onExternalNavigation(["url": url.absoluteString])');
        expect(navigationPolicy).toContain('decisionHandler(.cancel)');
        expect(provisionalFailure).toContain('retireCurrentMainFrameAfterLoadFailure(webView, error: error)');
        expect(committedFailure).toContain('retireCurrentMainFrameAfterLoadFailure(webView, error: error)');
        expect(failureLifecycle).toContain('guard !Self.isExpectedNavigationCancellation(error),');
        expect(failureLifecycle.indexOf('guard !Self.isExpectedNavigationCancellation(error),')).toBeLessThan(
            failureLifecycle.indexOf('clearCurrentFrameState()'),
        );
        expect(provisionalFailure).not.toContain('clearCurrentFrameState()');
        expect(committedFailure).not.toContain('clearCurrentFrameState()');
        expect(failureLifecycle).toContain('let nsError = error as NSError');
        expect(failureLifecycle).toContain('nsError.domain == NSURLErrorDomain');
        expect(failureLifecycle).toContain('nsError.code == NSURLErrorCancelled');
        expect(viewSource).toContain('private static let webKitLegacyErrorDomain = "WebKitErrorDomain"');
        expect(viewSource).toContain('private static let webKitFrameLoadInterruptedByPolicyChange = 102');
        expect(failureLifecycle).toContain('nsError.domain == Self.webKitLegacyErrorDomain');
        expect(failureLifecycle).toContain('nsError.code == Self.webKitFrameLoadInterruptedByPolicyChange');
    });

    it('keeps noncurrent iOS views and permitted subordinate-frame navigations inert to the failure presentation path', () => {
        const viewSource = readFileSync(join(moduleRoot, 'ios/HostedWebArtifactView.swift'), 'utf8');
        const failureLifecycle = viewSource.slice(
            viewSource.indexOf('private func retireCurrentMainFrameAfterLoadFailure('),
            viewSource.indexOf('func webViewWebContentProcessDidTerminate(_ webView: WKWebView)'),
        );
        const navigationPolicy = viewSource.slice(
            viewSource.indexOf('func webView(\n    _ webView: WKWebView,\n    decidePolicyFor navigationAction:'),
            viewSource.indexOf('func webView(_ webView: WKWebView, didStartProvisionalNavigation'),
        );

        // A callback from a retired/replaced WebView must fail the exact-view
        // guard. Subordinate frame navigation is separately permitted through
        // the existing policy branch and must not manufacture a top-level
        // load-error path for an Artifact subresource.
        expect(failureLifecycle).toContain('webView === self.webView,');
        expect(failureLifecycle).toContain('HostedWebArtifactRegistryOwner.shared.origin(for: token) == activeOrigin');
        expect(navigationPolicy).toContain('if let targetFrame = navigationAction.targetFrame, !targetFrame.isMainFrame {');
        expect(navigationPolicy).toContain('decisionHandler(.allow)');
        expect(navigationPolicy).not.toContain('onLoadError');
    });

    it('keeps an iOS cancellation tombstone only until its scheme task returns', () => {
        const viewSource = readFileSync(join(moduleRoot, 'ios/HostedWebArtifactView.swift'), 'utf8');
        const handlerSource = viewSource.slice(
            viewSource.indexOf('private final class HostedWebArtifactSchemeHandler'),
            viewSource.indexOf('/**\n Native frame for one already-registered Artifact token.'),
        );

        // `stop` may arrive while any of the synchronous response callbacks is
        // pending. The tombstone must therefore survive every callback but be
        // cleared through one top-level terminal path rather than accumulating
        // or poisoning a subsequently reused ObjectIdentifier.
        expect(handlerSource).toContain('defer { clearStoppedTask(identifier) }');
        expect(handlerSource).toContain('private func clearStoppedTask(_ identifier: ObjectIdentifier)');
        expect(handlerSource).toContain('stoppedTasks.remove(identifier)');
        expect(handlerSource.indexOf('defer { clearStoppedTask(identifier) }')).toBeLessThan(
            handlerSource.indexOf('guard !isStopped(identifier)'),
        );
    });
});
