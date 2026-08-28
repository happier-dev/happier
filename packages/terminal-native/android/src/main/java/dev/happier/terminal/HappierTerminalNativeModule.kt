package dev.happier.terminal

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.functions.Queues

class HappierTerminalNativeModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("HappierTerminalNative")

    Events("rendererCrash", "surfaceReady", "writeAck", "input", "resize", "link", "selection", "copy", "title", "bell")

    Function("getAvailability") {
      return@Function TermuxBridge.availability()
    }

    Function("getQaCapabilities") {
      return@Function mapOf(
        "rendererCrashInjection" to BuildConfig.HAPPIER_TERMINAL_NATIVE_QA_CRASH_INJECTION,
      )
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
        "engineeringQaOverride" to diagnostic.engineeringQaOverride,
        "requiredModules" to diagnostic.requiredModules,
        "forbiddenModules" to diagnostic.forbiddenModules,
        "remoteSessionAdapterRequired" to diagnostic.remoteSessionAdapterRequired,
        "blockers" to diagnostic.blockers.map { mapOf("reason" to it.reason, "detail" to it.detail) },
      )
    }

    AsyncFunction("createSurface") { surfaceId: String ->
      return@AsyncFunction TermuxBridge.createSurface(surfaceId) { eventName, payload ->
        sendEvent(eventName, payload)
      }
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("qaInjectRendererCrash") { surfaceId: String ->
      return@AsyncFunction TermuxBridge.qaInjectRendererCrash(surfaceId)
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("writeBytes") { surfaceId: String, base64Bytes: String, byteOffset: Double ->
      return@AsyncFunction TermuxBridge.writeBytes(surfaceId, base64Bytes, byteOffset.toLong())
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("sendInputBytes") { surfaceId: String, base64Bytes: String ->
      return@AsyncFunction TermuxBridge.sendInputBytes(surfaceId, base64Bytes)
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("resizeSurface") { surfaceId: String, cols: Int, rows: Int ->
      return@AsyncFunction TermuxBridge.resizeSurface(surfaceId, cols, rows)
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("focusSurface") { surfaceId: String ->
      return@AsyncFunction TermuxBridge.focusSurface(surfaceId)
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("clearSurface") { surfaceId: String ->
      return@AsyncFunction TermuxBridge.clearSurface(surfaceId)
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("disposeSurface") { surfaceId: String ->
      return@AsyncFunction TermuxBridge.disposeSurface(surfaceId)
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("copySelection") { surfaceId: String ->
      return@AsyncFunction TermuxBridge.copySelection(surfaceId)
    }.runOnQueue(Queues.MAIN)

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

      Prop("accessibilityTerminalLabel") { view: TermuxView, label: String ->
        view.setAccessibilityTerminalLabel(label)
      }

      Prop("accessibilityFallbackValue") { view: TermuxView, value: String ->
        view.setAccessibilityFallbackValue(value)
      }

      Prop("accessibilityFocusActionLabel") { view: TermuxView, label: String ->
        view.setAccessibilityFocusActionLabel(label)
      }

      Prop("accessibilityCopySelectionActionLabel") { view: TermuxView, label: String ->
        view.setAccessibilityCopySelectionActionLabel(label)
      }

      Prop("accessibilitySelectAllActionLabel") { view: TermuxView, label: String ->
        view.setAccessibilitySelectAllActionLabel(label)
      }

      Prop("accessibilityOpenLinkActionLabel") { view: TermuxView, label: String ->
        view.setAccessibilityOpenLinkActionLabel(label)
      }
    }

    OnDestroy {
      TermuxBridge.disposeAllOnMain()
    }
  }
}
