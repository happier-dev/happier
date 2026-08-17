package dev.happier.hostedwebframe

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Color
import android.net.Uri
import android.os.Looper
import android.util.Log
import android.view.ViewGroup
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.ProfileStore
import androidx.webkit.ScriptHandler
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import java.io.ByteArrayInputStream
import java.util.Locale
import java.util.UUID
import org.json.JSONObject

private const val HOSTED_WEB_DOMAIN = "plugins.happier.dev"
private const val BRIDGE_INTERFACE_NAME = "HappierHostedWebFrameBridge"
private const val HOSTED_WEB_PROFILE_PREFIX = "happier_hosted_v1_"
private const val MAX_ORPHANED_HOSTED_WEB_PROFILES_PER_START = 32
private const val MAX_PENDING_HOSTED_WEB_PROFILE_CLEANUPS = 32
private const val HOSTED_WEB_LOG_TAG = "HappierHostedWebFrame"

/**
 * Protocol serializes ordinary HTTP Content-Type values, while Android's
 * WebResourceResponse accepts the media type and charset as separate facts.
 */
internal data class WebResourceResponseContentType(
  val mimeType: String,
  val charset: String?
)

internal fun parseWebResourceResponseContentType(contentType: String): WebResourceResponseContentType? {
  val components = contentType.split(';')
  val mimeType = components.first().trim()
  if (mimeType.isEmpty()) return null
  val charset = components.asSequence()
    .drop(1)
    .mapNotNull { parameter ->
      val separator = parameter.indexOf('=')
      if (
        separator <= 0 ||
        !parameter.substring(0, separator).trim().equals("charset", ignoreCase = true)
      ) {
        null
      } else {
        parameter.substring(separator + 1).trim()
          .removeSurrounding("\"")
          .takeIf { it.isNotEmpty() }
      }
    }
    .firstOrNull()
  return WebResourceResponseContentType(mimeType, charset)
}

/**
 * A dedicated native frame for one already-registered opaque Artifact token.
 * It never accepts byte paths, cache paths, a generic endpoint, or a URL from
 * JavaScript. The origin is derived from the token registry's opaque partition.
 */
@SuppressLint("SetJavaScriptEnabled")
internal class HostedWebArtifactView(
  context: Context,
  appContext: AppContext
) : ExpoView(context, appContext) {
  private var webView: WebView? = null
  private val onMessage by EventDispatcher<Map<String, Any>>()
  private val onLoadStart by EventDispatcher<Map<String, Any>>()
  private val onLoadEnd by EventDispatcher<Map<String, Any>>()
  private val onLoadError by EventDispatcher<Map<String, Any>>()
  private val onExternalNavigation by EventDispatcher<Map<String, Any>>()
  private val onBlockedNavigation by EventDispatcher<Map<String, Any>>()
  private val onHistoryStateChange by EventDispatcher<Map<String, Any>>()

  private var artifactHandleToken: String? = null
  private var initialPathAndQuery: String? = null
  private var activeOrigin: HostedWebOrigin? = null
  private var activeLoader: WebViewAssetLoader? = null
  private var activePathHandler: TokenPathHandler? = null
  private var documentStartScript: ScriptHandler? = null
  private var activeProfileName: String? = null
  private var loadedKey: String? = null
  private var disposed = false
  private var allowedNavigationOrigins = emptySet<HostedWebOrigin>()

  init {
    orientation = VERTICAL
    setBackgroundColor(Color.TRANSPARENT)
  }

  override val shouldUseAndroidLayout: Boolean = true

  fun setArtifactHandleToken(token: String?) {
    if (artifactHandleToken == token) return
    clearCurrentFrameState()
    artifactHandleToken = token?.takeIf { it.isNotBlank() }
    loadedKey = null
    loadIfReady()
  }

  fun setInitialPathAndQuery(pathAndQuery: String?) {
    if (initialPathAndQuery == pathAndQuery) return
    clearCurrentFrameState()
    initialPathAndQuery = pathAndQuery?.takeIf(::isSafePathAndQuery)
    loadedKey = null
    loadIfReady()
  }

  fun setAllowedNavigationOrigins(origins: List<String>) {
    allowedNavigationOrigins = origins.mapNotNull(::parseOrigin).toSet()
  }

  fun postHostMessage(serializedMessage: String): Boolean {
    val currentWebView = webView ?: return false
    if (!isActiveArtifactPage(currentWebView)) return false
    // The bridge receives the same `MessageEvent.data` string as the existing
    // native WebView engine: host envelope JSON, encoded once as JavaScript.
    val script = """
      (function () {
        window.dispatchEvent(new MessageEvent('message', {
          data: ${JSONObject.quote(serializedMessage)}
        }));
      })();
    """.trimIndent()
    currentWebView.evaluateJavascript(script, null)
    return true
  }

  fun goBack(): Boolean {
    val currentWebView = webView ?: return false
    if (!isActiveArtifactPage(currentWebView) || !currentWebView.canGoBack()) return false
    currentWebView.goBack()
    return true
  }

  fun dispose() {
    if (disposed) return
    disposed = true
    clearCurrentFrameState()
  }

  private fun configureWebView(nextWebView: WebView, origin: HostedWebOrigin) {
    val settings = nextWebView.settings
    settings.javaScriptEnabled = true
    settings.javaScriptCanOpenWindowsAutomatically = false
    settings.setSupportMultipleWindows(false)
    settings.allowFileAccess = false
    settings.allowContentAccess = false
    @Suppress("DEPRECATION")
    run {
      settings.allowFileAccessFromFileURLs = false
      settings.allowUniversalAccessFromFileURLs = false
    }
    settings.mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW
    // No persistent DOM or WebView cache is needed for token-served resources.
    settings.domStorageEnabled = false
    settings.databaseEnabled = false
    settings.cacheMode = android.webkit.WebSettings.LOAD_NO_CACHE
    settings.setGeolocationEnabled(false)
    settings.mediaPlaybackRequiresUserGesture = true
    nextWebView.setBackgroundColor(Color.TRANSPARENT)
    android.webkit.CookieManager.getInstance().setAcceptThirdPartyCookies(nextWebView, false)
    // Unlike addJavascriptInterface, AndroidX binds this object to the exact
    // Artifact origin and gives the host the actual sender origin/frame. The
    // native bridge is a top-level page capability, never an iframe capability.
    WebViewCompat.addWebMessageListener(
      nextWebView,
      BRIDGE_INTERFACE_NAME,
      setOf(origin.asString()),
      object : WebViewCompat.WebMessageListener {
        override fun onPostMessage(
          view: WebView,
          message: WebMessageCompat,
          sourceOrigin: Uri,
          isMainFrame: Boolean,
          replyProxy: JavaScriptReplyProxy
        ) {
          if (
            view !== nextWebView ||
            !isMainFrame ||
            !origin.matches(sourceOrigin) ||
            message.type != WebMessageCompat.TYPE_STRING ||
            !isActiveArtifactPage(nextWebView)
          ) {
            return
          }
          val data = message.data ?: return
          post {
            if (isActiveArtifactPage(nextWebView) && origin.matches(sourceOrigin)) {
              onMessage(mapOf("data" to data, "url" to sourceOrigin.toString()))
            }
          }
        }
      }
    )
    nextWebView.webViewClient = ArtifactWebViewClient()
  }

  private fun loadIfReady() {
    if (disposed) return
    retryPendingProfileCleanup()
    val token = artifactHandleToken ?: return
    val pathAndQuery = initialPathAndQuery ?: return
    if (!isProfileIsolationSupported()) {
      onLoadError(profileIsolationUnavailableEvent())
      return
    }
    val origin = HostedWebArtifactRegistryOwner.originFor(context, token)
      ?.let(::parseOrigin)
      ?: run {
        onLoadError(mapOf("code" to "hosted_web_artifact_handle_unavailable"))
        return
      }
    val key = "$token\u001F$pathAndQuery"
    if (loadedKey == key) return

    val pathHandler = TokenPathHandler(context, token)
    val loader = WebViewAssetLoader.Builder()
      .setDomain(origin.host)
      .addPathHandler("/", pathHandler)
      .build()
    val profileName = newProfileName()
    val nextWebView = WebView(context)
    val installedDocumentStartScript = runCatching {
      // AndroidX requires the profile assignment before any settings, bridge,
      // client, or navigation operation on this WebView.
      WebViewCompat.setProfile(nextWebView, profileName)
      markProfileActive(profileName)
      configureWebView(nextWebView, origin)
      WebViewCompat.addDocumentStartJavaScript(
        nextWebView,
        DOCUMENT_START_BRIDGE,
        setOf(origin.asString())
      )
    }.getOrNull()
    if (installedDocumentStartScript == null) {
      destroyUnloadedWebView(nextWebView, profileName)
      onLoadError(profileIsolationUnavailableEvent())
      return
    }

    webView = nextWebView
    activeProfileName = profileName
    activeOrigin = origin
    activePathHandler = pathHandler
    activeLoader = loader
    documentStartScript = installedDocumentStartScript
    loadedKey = key
    addView(nextWebView, ViewGroup.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT,
      ViewGroup.LayoutParams.MATCH_PARENT
    ))
    onHistoryStateChange(mapOf("canGoBack" to false))
    onLoadStart(mapOf("url" to "${origin.asString()}$pathAndQuery"))
    nextWebView.loadUrl("${origin.asString()}$pathAndQuery")
  }

  private fun clearCurrentFrameState(skipNavigation: Boolean = false) {
    val currentWebView = webView
    val profileName = activeProfileName
    webView = null
    activeProfileName = null
    activeOrigin = null
    activePathHandler = null
    activeLoader = null
    runCatching { documentStartScript?.remove() }
    documentStartScript = null
    loadedKey = null
    if (currentWebView != null) {
      if (!skipNavigation && !disposed) {
        runCatching {
          currentWebView.stopLoading()
          currentWebView.loadUrl("about:blank")
          currentWebView.clearHistory()
          currentWebView.clearFormData()
        }
      }
      runCatching {
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
          WebViewCompat.removeWebMessageListener(currentWebView, BRIDGE_INTERFACE_NAME)
        }
      }
      runCatching { removeView(currentWebView) }
      runCatching { currentWebView.destroy() }
    }
    if (profileName != null) deleteRetiredProfile(profileName)
  }

  private fun destroyUnloadedWebView(currentWebView: WebView, profileName: String) {
    runCatching {
      if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
        WebViewCompat.removeWebMessageListener(currentWebView, BRIDGE_INTERFACE_NAME)
      }
    }
    runCatching { currentWebView.destroy() }
    deleteRetiredProfile(profileName)
  }

  private fun deleteRetiredProfile(profileName: String) {
    markProfileRetired(profileName)
    if (!deleteProfile(profileName)) {
      onLoadError(mapOf("code" to "hosted_web_profile_cleanup_pending"))
    }
  }

  private fun isActiveArtifactPage(candidate: WebView? = webView): Boolean {
    val currentWebView = candidate ?: return false
    if (currentWebView !== webView) return false
    val token = artifactHandleToken ?: return false
    val origin = activeOrigin ?: return false
    if (HostedWebArtifactRegistryOwner.originFor(context, token) != origin.asString()) return false
    val url = currentWebView.url ?: return false
    return parseOrigin(url) == origin
  }

  private fun profileIsolationUnavailableEvent(): Map<String, Any> {
    val event = mutableMapOf<String, Any>("code" to "hosted_web_profile_isolation_unavailable")
    profileIsolationUnavailableCapability()?.let { event["capability"] = it }
    val webViewPackage = runCatching {
      WebViewCompat.getCurrentWebViewPackage(context)
    }.getOrNull()
    if (webViewPackage != null) {
      event["webViewPackage"] = webViewPackage.packageName
      webViewPackage.versionName?.let { event["webViewVersion"] = it }
    }
    return event
  }

  private inner class ArtifactWebViewClient : WebViewClient() {
    override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
      if (view !== webView) return rejectionResponse(404)
      if (request.method != "GET") return rejectionResponse(405)
      val origin = activeOrigin ?: return rejectionResponse(404)
      val isActiveOrigin = origin.matches(request.url)
      if (isReservedHostedWebDomain(request.url.host, isActiveOrigin)) return rejectionResponse(404)
      if (!isActiveOrigin) return null
      val handler = activePathHandler ?: return rejectionResponse(404)
      // WebViewAssetLoader's PathHandler receives a decoded path on some
      // WebView releases. Preserve encoded traversal/separator evidence here
      // so the Protocol policy's fail-closed request grammar remains exact.
      val encodedPath = request.url.encodedPath ?: "/"
      if (encodedPath.contains('%') || encodedPath.contains('\\')) {
        return handler.handle(encodedPath)
      }
      return activeLoader?.shouldInterceptRequest(request.url)
        ?: handler.handle(encodedPath)
    }

    @Deprecated("Deprecated in Java")
    override fun shouldInterceptRequest(view: WebView, url: String): WebResourceResponse? {
      if (view !== webView) return rejectionResponse(404)
      val uri = Uri.parse(url)
      val origin = activeOrigin ?: return rejectionResponse(404)
      val isActiveOrigin = origin.matches(uri)
      if (isReservedHostedWebDomain(uri.host, isActiveOrigin)) return rejectionResponse(404)
      if (!isActiveOrigin) return null
      val handler = activePathHandler ?: return rejectionResponse(404)
      val encodedPath = uri.encodedPath ?: "/"
      if (encodedPath.contains('%') || encodedPath.contains('\\')) {
        return handler.handle(encodedPath)
      }
      return activeLoader?.shouldInterceptRequest(uri) ?: handler.handle(encodedPath)
    }

    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
      if (view !== webView) return true
      if (!request.isForMainFrame) return false
      val uri = request.url
      val active = activeOrigin
      if (active != null && active.matches(uri)) return false
      if (allowedNavigationOrigins.any { it.matches(uri) }) {
        // Never let guest JavaScript navigate this WebView externally. The
        // React host receives this event and decides whether to open the
        // policy-approved destination through the platform handoff.
        onExternalNavigation(mapOf("url" to uri.toString()))
        return true
      }
      unloadUnexpectedNavigation(uri.toString())
      return true
    }

    @Deprecated("Deprecated in Java")
    override fun shouldOverrideUrlLoading(view: WebView, url: String): Boolean {
      if (view !== webView) return true
      val uri = Uri.parse(url)
      val active = activeOrigin
      if (active != null && active.matches(uri)) return false
      if (allowedNavigationOrigins.any { it.matches(uri) }) {
        onExternalNavigation(mapOf("url" to url))
        return true
      }
      unloadUnexpectedNavigation(url)
      return true
    }

    override fun onPageStarted(view: WebView, url: String, favicon: android.graphics.Bitmap?) {
      if (view !== webView) return
      val active = activeOrigin ?: return
      if (!active.matches(Uri.parse(url))) {
        // A renderer navigation that bypasses `shouldOverrideUrlLoading` must
        // still lose the frame before it can become a second live origin.
        unloadUnexpectedNavigation(url)
      }
    }

    override fun onPageFinished(view: WebView, url: String) {
      if (isActiveArtifactPage(view)) {
        onHistoryStateChange(mapOf("canGoBack" to view.canGoBack()))
        onLoadEnd(mapOf("url" to url))
      }
    }

    override fun doUpdateVisitedHistory(view: WebView, url: String, isReload: Boolean) {
      if (isActiveArtifactPage(view)) {
        onHistoryStateChange(mapOf("canGoBack" to view.canGoBack()))
      }
    }

    override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
      retireCurrentMainFrameAfterLoadFailure(view, request)
    }

    override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, errorResponse: WebResourceResponse) {
      retireCurrentMainFrameAfterLoadFailure(view, request)
    }

    override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
      if (view !== webView) return true
      clearCurrentFrameState(skipNavigation = true)
      onLoadError(mapOf("code" to "hosted_web_renderer_crashed"))
      return true
    }
  }

  private fun retireCurrentMainFrameAfterLoadFailure(view: WebView, request: WebResourceRequest) {
    if (!request.isForMainFrame || view !== webView) return
    val token = artifactHandleToken ?: return
    val origin = activeOrigin ?: return
    if (!origin.matches(request.url)) return
    if (HostedWebArtifactRegistryOwner.originFor(context, token) != origin.asString()) return
    // Android can publish a late page-finished callback after a main-document
    // failure. Retire the exact bound surface before the shared error event so
    // that callback cannot restore the pane to ready or leave its bridge live.
    clearCurrentFrameState(skipNavigation = true)
    onLoadError(mapOf("code" to "hosted_web_artifact_load_failed"))
  }

  private fun unloadUnexpectedNavigation(url: String) {
    clearCurrentFrameState()
    onBlockedNavigation(mapOf("url" to url))
  }

  private class TokenPathHandler(
    private val context: Context,
    private val token: String
  ) : WebViewAssetLoader.PathHandler {
    override fun handle(path: String): WebResourceResponse {
      return HostedWebArtifactRegistryOwner.withResolved(context, token, path) { response ->
        if (response.status != 200 || response.bytes == null || response.contentType == null) {
          rejectionResponse(response.status)
        } else {
          val parsedContentType = parseWebResourceResponseContentType(response.contentType)
          if (parsedContentType == null) {
            rejectionResponse(415)
          } else {
            WebResourceResponse(
              parsedContentType.mimeType,
              parsedContentType.charset,
              200,
              "OK",
              response.headers,
              ByteArrayInputStream(response.bytes)
            )
          }
        }
      }
    }
  }

  private data class HostedWebOrigin(
    val scheme: String,
    val host: String,
    val port: Int
  ) {
    fun asString(): String = when {
      scheme == "https" && port == 443 -> "https://$host"
      scheme == "http" && port == 80 -> "http://$host"
      else -> "$scheme://$host:$port"
    }

    fun matches(uri: Uri): Boolean {
      return uri.scheme?.lowercase(Locale.ROOT) == scheme
        && uri.host?.lowercase(Locale.ROOT) == host
        && effectivePort(uri.scheme, uri.port) == port
    }
  }

  companion object {
    private val activeProfileNames = mutableSetOf<String>()
    private val pendingProfileNames = LinkedHashSet<String>()

    private val DOCUMENT_START_BRIDGE = """
      (function () {
        var bridge = window.$BRIDGE_INTERFACE_NAME;
        if (!bridge || typeof bridge.postMessage !== 'function') return;
        var nativeBridge = Object.freeze({
          postMessage: function (data) {
            bridge.postMessage(String(data));
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
    """.trimIndent()

    /**
     * AndroidX profiles are the storage owner for each concrete WebView. A
     * profile is never looked up through ProfileStore because doing so pins it
     * in memory and prevents deletion after the frame retires.
     */
    internal fun isProfileIsolationSupported(): Boolean = profileIsolationUnavailableCapability() == null

    internal fun cleanupOrphanedProfiles() {
      assertProfileStoreThread()
      val pendingBeforeSweep = pendingProfileNames.toSet()
      retryPendingProfileCleanup()
      if (!WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) return
      val profileStore = runCatching { ProfileStore.getInstance() }.getOrNull() ?: return
      val names = runCatching { profileStore.getAllProfileNames() }.getOrDefault(emptyList())
      names.asSequence()
        .filter { it.startsWith(HOSTED_WEB_PROFILE_PREFIX) && !activeProfileNames.contains(it) }
        // A pending name was retried above. Do not retry it again in the same
        // lifecycle event; the next frame creation or module start owns that.
        .filter { it !in pendingBeforeSweep }
        // Bound startup work; subsequent module starts continue draining only
        // our opaque prefix and never touch another WebView consumer's profile.
        .take(MAX_ORPHANED_HOSTED_WEB_PROFILES_PER_START)
        .forEach(::deleteProfile)
    }

    internal fun profileIsolationUnavailableCapability(): String? = when {
      !WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE) -> "MULTI_PROFILE"
      !WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT) -> "DOCUMENT_START_SCRIPT"
      !WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER) -> "WEB_MESSAGE_LISTENER"
      else -> null
    }

    private fun newProfileName(): String = "$HOSTED_WEB_PROFILE_PREFIX${UUID.randomUUID()}"

    private fun markProfileActive(profileName: String) {
      assertProfileStoreThread()
      activeProfileNames.add(profileName)
    }

    private fun markProfileRetired(profileName: String) {
      assertProfileStoreThread()
      activeProfileNames.remove(profileName)
    }

    private fun retryPendingProfileCleanup() {
      assertProfileStoreThread()
      pendingProfileNames.toList()
        .take(MAX_PENDING_HOSTED_WEB_PROFILE_CLEANUPS)
        .forEach(::deleteProfile)
    }

    private fun deleteProfile(profileName: String): Boolean {
      assertProfileStoreThread()
      if (!WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) return false
      return try {
        // AndroidX returning `false` means the profile was already absent;
        // either result settles owner-local pending cleanup successfully.
        ProfileStore.getInstance().deleteProfile(profileName)
        pendingProfileNames.remove(profileName)
        true
      } catch (error: IllegalStateException) {
        rememberPendingProfileCleanup(profileName, error)
        false
      }
    }

    private fun rememberPendingProfileCleanup(profileName: String, error: IllegalStateException) {
      if (!pendingProfileNames.contains(profileName) && pendingProfileNames.size < MAX_PENDING_HOSTED_WEB_PROFILE_CLEANUPS) {
        pendingProfileNames.add(profileName)
      }
      Log.w(HOSTED_WEB_LOG_TAG, "Hosted Web profile cleanup is pending.", error)
    }

    private fun assertProfileStoreThread() {
      check(Looper.myLooper() == Looper.getMainLooper()) {
        "Hosted Web profile lifecycle must run on the UI thread."
      }
    }

    private fun parseOrigin(value: String): HostedWebOrigin? {
      val uri = Uri.parse(value)
      val scheme = uri.scheme?.lowercase(Locale.ROOT) ?: return null
      val host = uri.host?.lowercase(Locale.ROOT) ?: return null
      if (scheme != "https" && scheme != "http") return null
      if (uri.userInfo != null || (uri.path != null && uri.path !in setOf("", "/")) || uri.query != null || uri.fragment != null) {
        return null
      }
      val port = effectivePort(scheme, uri.port)
      return if (port in 1..65535) HostedWebOrigin(scheme, host, port) else null
    }

    internal fun isReservedHostedWebDomain(host: String?, isActiveOrigin: Boolean): Boolean {
      val reservedHost = host?.lowercase(Locale.ROOT)?.removeSuffix(".")?.let { host ->
        host == HOSTED_WEB_DOMAIN || host.endsWith(".$HOSTED_WEB_DOMAIN")
      } ?: false
      return !isActiveOrigin && reservedHost
    }

    private fun effectivePort(scheme: String?, port: Int): Int = when {
      port >= 0 -> port
      scheme.equals("https", ignoreCase = true) -> 443
      scheme.equals("http", ignoreCase = true) -> 80
      else -> -1
    }

    private fun isSafePathAndQuery(value: String): Boolean {
      if (!value.startsWith('/') || value.startsWith("//") || value.contains('\\') || value.contains('\u0000')) {
        return false
      }
      val uri = Uri.parse(value)
      return uri.scheme == null && uri.authority == null && uri.fragment == null && uri.path?.startsWith('/') == true
    }

    private fun rejectionResponse(status: Int): WebResourceResponse {
      val reason = when (status) {
        400 -> "Bad Request"
        404 -> "Not Found"
        405 -> "Method Not Allowed"
        415 -> "Unsupported Media Type"
        else -> "Unavailable"
      }
      return WebResourceResponse(
        "text/plain",
        "utf-8",
        status,
        reason,
        mapOf(
          "Cache-Control" to "no-store",
          "X-Content-Type-Options" to "nosniff"
        ),
        ByteArrayInputStream(ByteArray(0))
      )
    }
  }
}
