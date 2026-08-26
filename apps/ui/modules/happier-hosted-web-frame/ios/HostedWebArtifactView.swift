import ExpoModulesCore
import UIKit
import WebKit

private let hostedWebBridgeName = "HappierHostedWebFrameBridge"

/**
 A `WKURLSchemeHandler` for one registered opaque token. It serves only bytes
 copied by the native registry from the app-private Artifact cache; it never
 turns a JS-provided address into a network request or filesystem lookup.
 */
private final class HostedWebArtifactSchemeHandler: NSObject, WKURLSchemeHandler {
  private let token: String
  private let origin: HostedWebArtifactOrigin
  private let lock = NSLock()
  private var stoppedTasks = Set<ObjectIdentifier>()

  init(token: String, origin: HostedWebArtifactOrigin) {
    self.token = token
    self.origin = origin
  }

  func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
    let identifier = ObjectIdentifier(urlSchemeTask as AnyObject)
    // Keep a stop tombstone through every synchronous response callback, then
    // discard it on every terminal path so a later WebKit task cannot inherit
    // a recycled object identity.
    defer { clearStoppedTask(identifier) }
    guard !isStopped(identifier), let url = urlSchemeTask.request.url, origin.matches(url) else {
      sendRejected(status: 404, to: urlSchemeTask, identifier: identifier)
      return
    }
    guard (urlSchemeTask.request.httpMethod ?? "GET").uppercased() == "GET" else {
      sendRejected(status: 405, to: urlSchemeTask, identifier: identifier)
      return
    }

    let encodedPath = URLComponents(url: url, resolvingAgainstBaseURL: false)?.percentEncodedPath
    let requestPath = encodedPath?.isEmpty == false ? encodedPath! : "/"
    let response = HostedWebArtifactRegistryOwner.shared.readResponse(
      token: token,
      requestPath: requestPath,
    )
    guard response.status == 200,
          let contentType = response.contentType,
          let bytes = response.bytes else {
      sendRejected(status: response.status, to: urlSchemeTask, identifier: identifier)
      return
    }
    guard !isStopped(identifier), let httpResponse = HTTPURLResponse(
      url: url,
      statusCode: 200,
      httpVersion: "HTTP/1.1",
      headerFields: response.headers.merging(["Content-Type": contentType]) { current, _ in current },
    ) else {
      return
    }
    urlSchemeTask.didReceive(httpResponse)
    guard !isStopped(identifier) else {
      return
    }
    urlSchemeTask.didReceive(bytes)
    guard !isStopped(identifier) else {
      return
    }
    urlSchemeTask.didFinish()
  }

  func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {
    lock.lock()
    stoppedTasks.insert(ObjectIdentifier(urlSchemeTask as AnyObject))
    lock.unlock()
  }

  private func isStopped(_ identifier: ObjectIdentifier) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    return stoppedTasks.contains(identifier)
  }

  private func clearStoppedTask(_ identifier: ObjectIdentifier) {
    lock.lock()
    stoppedTasks.remove(identifier)
    lock.unlock()
  }

  private func sendRejected(status: Int, to task: WKURLSchemeTask, identifier: ObjectIdentifier) {
    guard !isStopped(identifier), let url = task.request.url else {
      return
    }
    let reason: String
    switch status {
    case 400:
      reason = "Bad Request"
    case 404:
      reason = "Not Found"
    case 405:
      reason = "Method Not Allowed"
    case 415:
      reason = "Unsupported Media Type"
    default:
      reason = "Unavailable"
    }
    guard let response = HTTPURLResponse(
      url: url,
      statusCode: status,
      httpVersion: "HTTP/1.1",
      headerFields: [
        "Cache-Control": "no-store",
        "Content-Type": "text/plain; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
      ],
    ) else {
      return
    }
    task.didReceive(response)
    guard !isStopped(identifier) else {
      return
    }
    task.didFinish()
  }
}

/**
 Native frame for one already-registered Artifact token. Its public props are
 intentionally unable to accept a remote URL, raw bytes, cache path, Account,
 launch identity, or session identity. The host owns the bridge envelope and
 currentness; this view only provides the verified local surface primitive.
 */
final class HostedWebArtifactView: UIView, WKNavigationDelegate, WKScriptMessageHandler, WKUIDelegate {
  let onMessage = EventDispatcher()
  let onLoadStart = EventDispatcher()
  let onLoadEnd = EventDispatcher()
  let onLoadError = EventDispatcher()
  let onExternalNavigation = EventDispatcher()
  let onBlockedNavigation = EventDispatcher()
  let onHistoryStateChange = EventDispatcher()

  // The iOS SDK does not expose a Swift constant for WebKit's legacy policy
  // interruption error, but this exact NSError identity is emitted when a
  // navigation delegate cancels a frame load.
  private static let webKitLegacyErrorDomain = "WebKitErrorDomain"
  private static let webKitFrameLoadInterruptedByPolicyChange = 102

  private var artifactHandleToken: String?
  private var initialPathAndQuery: String?
  private var title: String?
  private var allowedNavigationOrigins = Set<HostedWebArtifactOrigin>()
  private var activeOrigin: HostedWebArtifactOrigin?
  private var activeSchemeHandler: HostedWebArtifactSchemeHandler?
  private var webView: WKWebView?
  private var historyObservation: NSKeyValueObservation?
  private var loadedKey: String?
  private var disposed = false

  override init(frame: CGRect) {
    super.init(frame: frame)
    backgroundColor = .clear
    clipsToBounds = true
  }

  required init?(coder: NSCoder) {
    super.init(coder: coder)
    backgroundColor = .clear
    clipsToBounds = true
  }

  deinit {
    dispose()
  }

  /// React Native may detach an Expo view before ARC releases it. Clear the
  /// borrowed WebKit primitive at that UIKit boundary, then allow a later
  /// legitimate reattachment to reload the still-current opaque token.
  override func willMove(toSuperview newSuperview: UIView?) {
    super.willMove(toSuperview: newSuperview)
    if newSuperview == nil {
      clearCurrentFrameState()
    }
  }

  override func didMoveToSuperview() {
    super.didMoveToSuperview()
    if superview != nil {
      loadIfReady()
    }
  }

  func dispose() {
    guard !disposed else {
      return
    }
    disposed = true
    clearCurrentFrameState()
  }

  func setArtifactHandleToken(_ token: String?) {
    let normalized = token?.isEmpty == false ? token : nil
    guard artifactHandleToken != normalized else {
      return
    }
    clearCurrentFrameState()
    artifactHandleToken = normalized
    loadIfReady()
  }

  func setTitle(_ title: String?) {
    guard self.title != title else {
      return
    }
    self.title = title
    webView?.accessibilityLabel = title
  }

  func setInitialPathAndQuery(_ pathAndQuery: String?) {
    guard initialPathAndQuery != pathAndQuery else {
      return
    }
    clearCurrentFrameState()
    initialPathAndQuery = pathAndQuery.flatMap { Self.isSafePathAndQuery($0) ? $0 : nil }
    loadIfReady()
  }

  func setAllowedNavigationOrigins(_ origins: [String]) {
    allowedNavigationOrigins = Set(origins.compactMap(HostedWebArtifactOrigin.navigationOrigin))
  }

  func postHostMessage(_ serializedMessage: String) -> Bool {
    guard isActiveArtifactPage(), let webView else {
      return false
    }
    guard let quotedMessage = Self.jsonStringLiteral(serializedMessage) else {
      return false
    }
    let script = """
      (function () {
        window.dispatchEvent(new MessageEvent('message', { data: \(quotedMessage) }));
      })();
      """
    webView.evaluateJavaScript(script)
    return true
  }

  func goBack() -> Bool {
    guard isActiveArtifactPage(), let webView, webView.canGoBack else {
      return false
    }
    webView.goBack()
    return true
  }

  private func loadIfReady() {
    guard !disposed,
          let token = artifactHandleToken,
          let pathAndQuery = initialPathAndQuery,
          let origin = HostedWebArtifactRegistryOwner.shared.origin(for: token) else {
      if !disposed, artifactHandleToken != nil, initialPathAndQuery != nil {
        onLoadError(["code": "hosted_web_artifact_handle_unavailable"])
      }
      return
    }
    let key = "\(token)\u{001F}\(pathAndQuery)"
    guard loadedKey != key, let url = URL(string: origin.serialized + pathAndQuery) else {
      return
    }

    clearCurrentFrameState()
    let schemeHandler = HostedWebArtifactSchemeHandler(token: token, origin: origin)
    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = WKWebsiteDataStore.nonPersistent()
    configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
    configuration.defaultWebpagePreferences.allowsContentJavaScript = true
    configuration.setURLSchemeHandler(schemeHandler, forURLScheme: HostedWebArtifactOrigin.localScheme)
    configuration.userContentController.add(self, name: hostedWebBridgeName)
    configuration.userContentController.addUserScript(Self.documentStartBridge(origin: origin))

    let nextWebView = WKWebView(frame: .zero, configuration: configuration)
    nextWebView.accessibilityLabel = title
    nextWebView.translatesAutoresizingMaskIntoConstraints = false
    nextWebView.navigationDelegate = self
    nextWebView.uiDelegate = self
    nextWebView.allowsBackForwardNavigationGestures = false
    nextWebView.isOpaque = false
    nextWebView.backgroundColor = .clear
    nextWebView.scrollView.backgroundColor = .clear
    addSubview(nextWebView)
    NSLayoutConstraint.activate([
      nextWebView.leadingAnchor.constraint(equalTo: leadingAnchor),
      nextWebView.trailingAnchor.constraint(equalTo: trailingAnchor),
      nextWebView.topAnchor.constraint(equalTo: topAnchor),
      nextWebView.bottomAnchor.constraint(equalTo: bottomAnchor),
    ])

    activeOrigin = origin
    activeSchemeHandler = schemeHandler
    webView = nextWebView
    historyObservation = nextWebView.observe(\.canGoBack, options: [.new]) { [weak self] observedWebView, _ in
      guard let self,
            observedWebView === self.webView,
            self.isActiveArtifactPage() else {
        return
      }
      self.onHistoryStateChange(["canGoBack": observedWebView.canGoBack])
    }
    loadedKey = key
    onHistoryStateChange(["canGoBack": false])
    onLoadStart(["url": url.absoluteString])
    nextWebView.load(URLRequest(url: url))
  }

  private func clearCurrentFrameState() {
    historyObservation?.invalidate()
    historyObservation = nil
    activeOrigin = nil
    activeSchemeHandler = nil
    loadedKey = nil
    guard let webView else {
      return
    }
    webView.stopLoading()
    webView.navigationDelegate = nil
    webView.uiDelegate = nil
    webView.configuration.userContentController.removeScriptMessageHandler(forName: hostedWebBridgeName)
    webView.configuration.userContentController.removeAllUserScripts()
    webView.removeFromSuperview()
    self.webView = nil
  }

  private func isActiveArtifactPage() -> Bool {
    guard let token = artifactHandleToken,
          let activeOrigin,
          HostedWebArtifactRegistryOwner.shared.origin(for: token) == activeOrigin,
          let url = webView?.url else {
      return false
    }
    return activeOrigin.matches(url)
  }

  func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
    guard message.name == hostedWebBridgeName,
          message.frameInfo.isMainFrame,
          let payload = message.body as? String,
          let activeOrigin,
          let frameURL = message.frameInfo.request.url,
          activeOrigin.matches(frameURL),
          isActiveArtifactPage() else {
      return
    }
    onMessage(["data": payload, "url": frameURL.absoluteString])
  }

  func webView(
    _ webView: WKWebView,
    decidePolicyFor navigationAction: WKNavigationAction,
    decisionHandler: @escaping (WKNavigationActionPolicy) -> Void,
  ) {
    guard webView === self.webView, let url = navigationAction.request.url else {
      decisionHandler(.cancel)
      return
    }
    if let targetFrame = navigationAction.targetFrame, !targetFrame.isMainFrame {
      decisionHandler(.allow)
      return
    }
    if activeOrigin?.matches(url) == true {
      decisionHandler(.allow)
      return
    }
    if allowedNavigationOrigins.contains(where: { $0.matches(url) }) {
      // The host, never this WebView, opens a declared external destination.
      onExternalNavigation(["url": url.absoluteString])
      decisionHandler(.cancel)
      return
    }
    unloadUnexpectedNavigation(url)
    decisionHandler(.cancel)
  }

  func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
    guard webView === self.webView, let url = webView.url, let activeOrigin else {
      return
    }
    if !activeOrigin.matches(url) {
      // Defense in depth for a navigation that reached WebKit before delegate
      // policy. Remove the page before it can become an active frame.
      unloadUnexpectedNavigation(url)
    }
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    guard webView === self.webView, isActiveArtifactPage(), let url = webView.url else {
      return
    }
    onHistoryStateChange(["canGoBack": webView.canGoBack])
    onLoadEnd(["url": url.absoluteString])
  }

  func webView(
    _ webView: WKWebView,
    didFailProvisionalNavigation navigation: WKNavigation!,
    withError error: Error,
  ) {
    retireCurrentMainFrameAfterLoadFailure(webView, error: error)
  }

  func webView(
    _ webView: WKWebView,
    didFail navigation: WKNavigation!,
    withError error: Error,
  ) {
    retireCurrentMainFrameAfterLoadFailure(webView, error: error)
  }

  private func retireCurrentMainFrameAfterLoadFailure(_ webView: WKWebView, error: Error) {
    // WKNavigationDelegate reports navigation progress for the main frame, but
    // either failure phase can arrive without a usable current page URL. The
    // active local and registry bindings are sufficient to reject stale or
    // revoked views while allowing the exact current surface to retire before
    // the pane handles recovery.
    guard !Self.isExpectedNavigationCancellation(error),
          webView === self.webView,
          let token = artifactHandleToken,
          let activeOrigin,
          HostedWebArtifactRegistryOwner.shared.origin(for: token) == activeOrigin,
          activeSchemeHandler != nil,
          loadedKey != nil else {
      return
    }
    clearCurrentFrameState()
    onLoadError(["code": "hosted_web_artifact_load_failed"])
  }

  private static func isExpectedNavigationCancellation(_ error: Error) -> Bool {
    let nsError = error as NSError
    return (nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled)
      || (nsError.domain == Self.webKitLegacyErrorDomain
        && nsError.code == Self.webKitFrameLoadInterruptedByPolicyChange)
  }

  func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
    guard webView === self.webView else {
      return
    }
    clearCurrentFrameState()
    onLoadError(["code": "hosted_web_renderer_crashed"])
  }

  private static func documentStartBridge(origin: HostedWebArtifactOrigin) -> WKUserScript {
    let scheme = jsonStringLiteral(origin.scheme + ":") ?? "\"\""
    let host = jsonStringLiteral(origin.host) ?? "\"\""
    let script = """
      (function () {
        if (window.location.protocol !== \(scheme) || window.location.host !== \(host)) return;
        var handler = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.\(hostedWebBridgeName);
        if (!handler || typeof handler.postMessage !== 'function') return;
        var nativeBridge = Object.freeze({
          postMessage: function (data) {
            handler.postMessage(String(data));
          }
        });
        try {
          Object.defineProperty(window, 'ReactNativeWebView', {
            value: nativeBridge,
            configurable: false,
            enumerable: false,
            writable: false
          });
        } catch (_) {
          return;
        }
      })();
      """
    return WKUserScript(source: script, injectionTime: .atDocumentStart, forMainFrameOnly: true)
  }

  private func unloadUnexpectedNavigation(_ url: URL) {
    clearCurrentFrameState()
    onBlockedNavigation(["url": url.absoluteString])
  }

  private static func isSafePathAndQuery(_ value: String) -> Bool {
    guard value.hasPrefix("/"),
          !value.hasPrefix("//"),
          !value.contains("\\"),
          !value.contains("\0"),
          let components = URLComponents(string: value),
          components.scheme == nil,
          components.host == nil,
          components.user == nil,
          components.password == nil,
          components.fragment == nil,
          components.path.hasPrefix("/") else {
      return false
    }
    return true
  }

  private static func jsonStringLiteral(_ value: String) -> String? {
    guard let data = try? JSONSerialization.data(withJSONObject: [value]),
          let array = String(data: data, encoding: .utf8),
          array.count >= 2 else {
      return nil
    }
    return String(array.dropFirst().dropLast())
  }
}
