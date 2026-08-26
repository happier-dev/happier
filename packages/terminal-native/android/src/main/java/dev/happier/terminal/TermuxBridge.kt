package dev.happier.terminal

import android.graphics.Canvas
import android.util.Base64
import android.view.KeyEvent
import android.view.MotionEvent
import java.util.concurrent.ConcurrentHashMap

data class TermuxBridgeBlocker(
  val reason: String,
  val detail: String,
)

data class TermuxBridgeDiagnostic(
  val available: Boolean,
  val renderer: String,
  val reason: String,
  val detail: String,
  val fallbackRenderer: String,
  val fallbackRequired: Boolean,
  val requiredModules: List<Map<String, String>>,
  val forbiddenModules: List<Map<String, String>>,
  val remoteSessionAdapterRequired: Boolean,
  val blockers: List<TermuxBridgeBlocker>,
)

data class TermuxWriteResult(
  val accepted: Boolean,
  val byteOffset: Long? = null,
  val reason: String? = null,
  val detail: String? = null,
) {
  fun toMap(): Map<String, Any?> {
    return if (accepted) {
      mapOf("accepted" to true, "byteOffset" to byteOffset)
    } else {
      mapOf("accepted" to false, "reason" to reason, "detail" to detail)
    }
  }
}

object TermuxBridge {
  private const val MODULE_VERSION = "0.0.0"
  private val surfaces = ConcurrentHashMap<String, TermuxRemoteSession>()
  private val invalidators = ConcurrentHashMap<String, () -> Unit>()
  private val focusRequesters = ConcurrentHashMap<String, () -> Unit>()

  private val requiredModules = listOf(
    mapOf("name" to "terminal-view", "path" to "terminal-view", "license" to "Apache-2.0"),
    mapOf("name" to "terminal-emulator", "path" to "terminal-emulator", "license" to "Apache-2.0"),
  )

  private val forbiddenModules = listOf(
    mapOf(
      "name" to "app",
      "reason" to "The full Termux app is GPL-3.0-only and is out of scope for the native renderer package.",
    ),
    mapOf(
      "name" to "termux-shared",
      "reason" to "TERM-6 only approves terminal-view and terminal-emulator until dependency closure review says otherwise.",
    ),
  )

  fun diagnostic(): TermuxBridgeDiagnostic {
    val blockers = collectBlockers()
    val firstBlocker = blockers.firstOrNull()
    return TermuxBridgeDiagnostic(
      available = blockers.isEmpty(),
      renderer = "android-termux",
      reason = firstBlocker?.reason ?: "available",
      detail = firstBlocker?.detail ?: "Android Termux native renderer gates passed.",
      fallbackRenderer = "xterm-webview",
      fallbackRequired = blockers.isNotEmpty() || !BuildConfig.HAPPIER_TERMINAL_NATIVE_ANDROID_ACCESSIBILITY_NATIVE,
      requiredModules = requiredModules,
      forbiddenModules = forbiddenModules,
      remoteSessionAdapterRequired = true,
      blockers = blockers,
    )
  }

  fun availability(): Map<String, Any> {
    val diagnostic = diagnostic()
    if (diagnostic.available) {
      val accessibility = if (BuildConfig.HAPPIER_TERMINAL_NATIVE_ANDROID_ACCESSIBILITY_NATIVE) {
        "native"
      } else {
        "fallback-required"
      }
      return mapOf(
        "available" to true,
        "platform" to "android",
        "renderer" to diagnostic.renderer,
        "moduleVersion" to moduleVersion(),
        "accessibility" to accessibility,
      )
    }
    return mapOf(
      "available" to false,
      "reason" to diagnostic.reason,
      "detail" to diagnostic.detail,
    )
  }

  fun createSurface(surfaceId: String, eventSink: TermuxEventSink? = null): TermuxBridgeDiagnostic {
    unavailableDiagnostic()?.let { return it }
    if (surfaceId.isNotBlank()) {
      val existing = surfaces[surfaceId]
      if (existing != null) {
        if (eventSink != null) {
          existing.attachEventSink(eventSink)
        }
      } else {
        val created = TermuxRemoteSessionFactory.create(surfaceId, eventSink)
        val raced = surfaces.putIfAbsent(surfaceId, created)
        if (raced != null) {
          created.dispose()
          if (eventSink != null) {
            raced.attachEventSink(eventSink)
          }
        }
      }
    }
    return diagnostic()
  }

  fun writeBytes(surfaceId: String, base64Bytes: String, byteOffset: Long): Map<String, Any?> {
    unavailableDiagnostic()?.let { return rejectUnavailable(it).toMap() }
    if (surfaceId.isBlank()) {
      return TermuxWriteResult(
        accepted = false,
        reason = "surface-not-ready",
        detail = "surfaceId is required.",
      ).toMap()
    }
    if (byteOffset < 0) {
      return TermuxWriteResult(
        accepted = false,
        reason = "invalid-ack",
        detail = "byteOffset must be non-negative.",
      ).toMap()
    }
    val bytes = try {
      Base64.decode(base64Bytes, Base64.NO_WRAP)
    } catch (_: Throwable) {
      return TermuxWriteResult(
        accepted = false,
        reason = "invalid-ack",
        detail = "base64Bytes must be valid base64.",
      ).toMap()
    }
    val surface = surfaces.getOrPut(surfaceId) { TermuxRemoteSessionFactory.create(surfaceId, null) }
    val result = surface.writeBytes(bytes, byteOffset)
    if (result.accepted) invalidators[surfaceId]?.invoke()
    return result.toMap()
  }

  fun sendInputBytes(surfaceId: String, base64Bytes: String): Map<String, Any?> {
    unavailableDiagnostic()?.let { return rejectUnavailable(it).toMap() }
    if (surfaceId.isBlank()) {
      return TermuxWriteResult(
        accepted = false,
        reason = "surface-not-ready",
        detail = "surfaceId is required.",
      ).toMap()
    }
    val bytes = try {
      Base64.decode(base64Bytes, Base64.NO_WRAP)
    } catch (_: Throwable) {
      return TermuxWriteResult(
        accepted = false,
        reason = "invalid-ack",
        detail = "base64Bytes must be valid base64.",
      ).toMap()
    }
    val surface = surfaces.getOrPut(surfaceId) { TermuxRemoteSessionFactory.create(surfaceId, null) }
    return surface.sendInputBytes(bytes).toMap()
  }

  fun sendTextInput(surfaceId: String, text: CharSequence): Map<String, Any?> {
    unavailableDiagnostic()?.let { return rejectUnavailable(it).toMap() }
    if (surfaceId.isBlank()) {
      return TermuxWriteResult(
        accepted = false,
        reason = "surface-not-ready",
        detail = "surfaceId is required.",
      ).toMap()
    }
    val surface = surfaces.getOrPut(surfaceId) { TermuxRemoteSessionFactory.create(surfaceId, null) }
    return surface.sendTextInput(text).toMap()
  }

  fun sendKeyEvent(surfaceId: String, keyCode: Int, event: KeyEvent): Boolean {
    unavailableDiagnostic()?.let { return false }
    if (surfaceId.isBlank()) return false
    val surface = surfaces.getOrPut(surfaceId) { TermuxRemoteSessionFactory.create(surfaceId, null) }
    return surface.sendKeyEvent(keyCode, event)
  }

  fun handleMotionEvent(surfaceId: String, event: MotionEvent): Boolean {
    unavailableDiagnostic()?.let { return false }
    if (surfaceId.isBlank()) return false
    val surface = surfaces.getOrPut(surfaceId) { TermuxRemoteSessionFactory.create(surfaceId, null) }
    val handled = surface.handleMotionEvent(event)
    if (handled) invalidators[surfaceId]?.invoke()
    return handled
  }

  fun resizeSurface(surfaceId: String, cols: Int, rows: Int): Map<String, Any?> {
    unavailableDiagnostic()?.let { return rejectUnavailable(it).toMap() }
    if (surfaceId.isBlank() || cols <= 0 || rows <= 0) {
      return mapOf("accepted" to false, "reason" to "surface-not-ready")
    }
    val surface = surfaces.getOrPut(surfaceId) { TermuxRemoteSessionFactory.create(surfaceId, null) }
    val result = surface.resize(cols, rows)
    if (result.accepted) invalidators[surfaceId]?.invoke()
    return result.toMap()
  }

  fun focusSurface(surfaceId: String) {
    unavailableDiagnostic()?.let { return }
    if (surfaceId.isNotBlank()) {
      surfaces.getOrPut(surfaceId) { TermuxRemoteSessionFactory.create(surfaceId, null) }.focus()
      focusRequesters[surfaceId]?.invoke()
    }
  }

  fun clearSurface(surfaceId: String) {
    surfaces[surfaceId]?.clear()
    invalidators[surfaceId]?.invoke()
  }

  fun copySelection(surfaceId: String) {
    surfaces[surfaceId]?.copySelection()
  }

  fun accessibilitySummary(surfaceId: String): String? {
    return surfaces[surfaceId]?.accessibilitySummary()
  }

  fun drawSurface(surfaceId: String, canvas: Canvas, width: Int, height: Int, fontSize: Float) {
    unavailableDiagnostic()?.let { return }
    surfaces[surfaceId]?.draw(canvas, width, height, fontSize)
  }

  fun registerSurfaceInvalidator(surfaceId: String, invalidator: () -> Unit) {
    if (surfaceId.isNotBlank()) {
      invalidators[surfaceId] = invalidator
    }
  }

  fun unregisterSurfaceInvalidator(surfaceId: String, invalidator: () -> Unit) {
    invalidators.remove(surfaceId, invalidator)
  }

  fun registerSurfaceFocusRequester(surfaceId: String, focusRequester: () -> Unit) {
    if (surfaceId.isNotBlank()) {
      focusRequesters[surfaceId] = focusRequester
    }
  }

  fun unregisterSurfaceFocusRequester(surfaceId: String, focusRequester: () -> Unit) {
    focusRequesters.remove(surfaceId, focusRequester)
  }

  fun disposeSurface(surfaceId: String) {
    surfaces.remove(surfaceId)?.dispose()
  }

  fun disposeAll() {
    surfaces.values.forEach { it.dispose() }
    surfaces.clear()
    invalidators.clear()
    focusRequesters.clear()
  }

  fun moduleVersion(): String = MODULE_VERSION

  private fun collectBlockers(): List<TermuxBridgeBlocker> {
    val blockers = mutableListOf<TermuxBridgeBlocker>()
    if (!BuildConfig.HAPPIER_TERMINAL_NATIVE_HAS_TERMUX_SOURCE) {
      addBlocker(
        blockers,
        "artifact-missing",
        "Termux terminal-view/terminal-emulator source is not present in android/termux/vendor.",
      )
    }
    if (!BuildConfig.HAPPIER_TERMINAL_NATIVE_ANDROID_DEPENDENCY_CLOSURE_APPROVED) {
      addBlocker(
        blockers,
        "dependency-closure-unapproved",
        "The selected Termux dependency closure has not been approved.",
      )
    }
    if (!BuildConfig.HAPPIER_TERMINAL_NATIVE_ANDROID_LEGAL_ACCEPTED) {
      addBlocker(
        blockers,
        "legal-not-approved",
        "Android Termux legal/product approval has not passed.",
      )
    }
    if (!BuildConfig.HAPPIER_TERMINAL_NATIVE_ANDROID_GRADLE_BUILD_PROVEN) {
      addBlocker(
        blockers,
        "renderer-unavailable",
        "Repeatable Gradle/AAR packaging proof has not passed.",
      )
    }
    if (!BuildConfig.HAPPIER_TERMINAL_NATIVE_ANDROID_ABI_SMOKE_PASSED) {
      addBlocker(
        blockers,
        "abi-unsupported",
        "Android Termux ABI smoke has not passed for the supported ABI matrix.",
      )
    }
    if (!BuildConfig.HAPPIER_TERMINAL_NATIVE_ANDROID_CRASH_FALLBACK_PROVEN) {
      addBlocker(
        blockers,
        "renderer-unavailable",
        "Native renderer crash-to-WebView fallback proof has not passed.",
      )
    }
    return blockers
  }

  private fun addBlocker(blockers: MutableList<TermuxBridgeBlocker>, reason: String, detail: String) {
    blockers.add(TermuxBridgeBlocker(reason = reason, detail = detail))
  }

  private fun unavailableDiagnostic(): TermuxBridgeDiagnostic? {
    val diagnostic = diagnostic()
    return if (diagnostic.available) null else diagnostic
  }

  private fun rejectUnavailable(diagnostic: TermuxBridgeDiagnostic): TermuxWriteResult {
    return TermuxWriteResult(
      accepted = false,
      reason = "renderer-unavailable",
      detail = "${diagnostic.reason}: ${diagnostic.detail}",
    )
  }
}

fun makeTermuxBridgeDiagnostic(): TermuxBridgeDiagnostic {
  return TermuxBridge.diagnostic()
}
