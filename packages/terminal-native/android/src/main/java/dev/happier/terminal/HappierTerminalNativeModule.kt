package dev.happier.terminal

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class HappierTerminalNativeModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("HappierTerminalNative")

    Events("rendererCrash", "surfaceReady", "writeAck", "input", "resize", "link", "selection", "copy", "title", "bell")

    Function("getAvailability") {
      return@Function TermuxBridge.availability()
    }

    Function("getAndroidTermuxDiagnostics") {
      val diagnostic = TermuxBridge.diagnostic()
      return@Function mapOf(
        "available" to diagnostic.available,
        "renderer" to diagnostic.renderer,
        "reason" to diagnostic.reason,
        "detail" to diagnostic.detail,
        "fallbackRenderer" to diagnostic.fallbackRenderer,
        "fallbackRequired" to diagnostic.fallbackRequired,
        "requiredModules" to diagnostic.requiredModules,
        "forbiddenModules" to diagnostic.forbiddenModules,
        "remoteSessionAdapterRequired" to diagnostic.remoteSessionAdapterRequired,
        "blockers" to diagnostic.blockers.map { mapOf("reason" to it.reason, "detail" to it.detail) },
      )
    }

    AsyncFunction("createSurface") { surfaceId: String ->
      val diagnostic = TermuxBridge.createSurface(surfaceId) { eventName, payload ->
        sendEvent(eventName, payload)
      }
      return@AsyncFunction mapOf(
        "available" to diagnostic.available,
        "reason" to diagnostic.reason,
        "detail" to diagnostic.detail,
      )
    }

    AsyncFunction("writeBytes") { surfaceId: String, base64Bytes: String, byteOffset: Double ->
      return@AsyncFunction TermuxBridge.writeBytes(surfaceId, base64Bytes, byteOffset.toLong())
    }

    AsyncFunction("sendInputBytes") { surfaceId: String, base64Bytes: String ->
      return@AsyncFunction TermuxBridge.sendInputBytes(surfaceId, base64Bytes)
    }

    AsyncFunction("resizeSurface") { surfaceId: String, cols: Int, rows: Int ->
      return@AsyncFunction TermuxBridge.resizeSurface(surfaceId, cols, rows)
    }

    AsyncFunction("focusSurface") { surfaceId: String ->
      return@AsyncFunction TermuxBridge.focusSurface(surfaceId)
    }

    AsyncFunction("clearSurface") { surfaceId: String ->
      return@AsyncFunction TermuxBridge.clearSurface(surfaceId)
    }

    AsyncFunction("disposeSurface") { surfaceId: String ->
      return@AsyncFunction TermuxBridge.disposeSurface(surfaceId)
    }

    AsyncFunction("copySelection") { surfaceId: String ->
      return@AsyncFunction TermuxBridge.copySelection(surfaceId)
    }

    View(TermuxView::class) {
      Name("HappierTerminalNativeView")

      Prop("surfaceId") { view: TermuxView, surfaceId: String ->
        view.setSurfaceId(surfaceId)
      }

      Prop("fontSize") { view: TermuxView, fontSize: Double ->
        view.setTerminalFontSize(fontSize)
      }

      Prop("lineHeightPx") { view: TermuxView, lineHeightPx: Double ->
        view.setTerminalLineHeightPx(lineHeightPx)
      }

      Prop("accessibilitySummary") { view: TermuxView, accessibilitySummary: String ->
        view.setAccessibilitySummary(accessibilitySummary)
      }

      Prop("accessibilityAccepted") { view: TermuxView, accessibilityAccepted: Boolean ->
        view.setAccessibilityAccepted(accessibilityAccepted)
      }
    }

    OnDestroy {
      TermuxBridge.disposeAll()
    }
  }
}
