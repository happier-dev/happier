import ExpoModulesCore
import Foundation

public final class HappierTerminalNativeModule: Module {
  public func definition() -> ModuleDefinition {
    Name("HappierTerminalNative")

    Events("rendererCrash", "surfaceReady", "writeAck", "input", "resize", "link", "selection", "copy", "title", "bell")

    Function("getAvailability") { () -> [String: Any] in
      makeGhosttyRuntimeDiagnostic().availabilityPayload()
    }

    AsyncFunction("createSurface") { (surfaceId: String) async -> [String: Any] in
      await MainActor.run {
        let diagnostic = makeGhosttyRuntimeDiagnostic()
        guard diagnostic.isAvailable else {
          return diagnostic.availabilityPayload()
        }
        guard let view = GhosttySurfaceRegistry.shared.surface(id: surfaceId),
              view.prepareSurface() else {
          return [
            "available": false,
            "reason": "surface-not-ready",
            "detail": "Native terminal surface is not mounted or has no drawable size.",
          ]
        }
        return diagnostic.availabilityPayload()
      }
    }

    AsyncFunction("writeBytes") { (surfaceId: String, base64Bytes: String, byteOffset: Int64) async -> [String: Any] in
      await MainActor.run {
        guard let view = GhosttySurfaceRegistry.shared.surface(id: surfaceId) else {
          return [
            "accepted": false,
            "reason": "surface-not-ready",
            "detail": "Native terminal surface is not mounted.",
          ]
        }
        guard let bytes = Data(base64Encoded: base64Bytes) else {
          return [
            "accepted": false,
            "reason": "invalid-ack",
            "detail": "Native terminal write payload was not valid base64.",
          ]
        }
        return view.writeBytes(bytes, byteOffset: byteOffset)
      }
    }

    AsyncFunction("resizeSurface") { (surfaceId: String, cols: Int, rows: Int) async -> Void in
      await MainActor.run {
        GhosttySurfaceRegistry.shared.surface(id: surfaceId)?.resize(cols: cols, rows: rows)
      }
    }

    AsyncFunction("focusSurface") { (surfaceId: String) async -> Void in
      await MainActor.run {
        GhosttySurfaceRegistry.shared.surface(id: surfaceId)?.focusSurface()
      }
    }

    AsyncFunction("clearSurface") { (surfaceId: String) async -> Void in
      await MainActor.run {
        GhosttySurfaceRegistry.shared.surface(id: surfaceId)?.clearSurface()
      }
    }

    AsyncFunction("disposeSurface") { (surfaceId: String) async -> Void in
      await MainActor.run {
        GhosttySurfaceRegistry.shared.surface(id: surfaceId)?.disposeSurface()
      }
    }

    AsyncFunction("copySelection") { (surfaceId: String) async -> [String: Any] in
      await MainActor.run {
        GhosttySurfaceRegistry.shared.surface(id: surfaceId)?.copySelection() ?? [
          "copied": false,
          "reason": "surface-not-ready",
        ]
      }
    }

    View(GhosttySurfaceView.self) {
      ViewName("HappierTerminalNativeView")

      Prop("surfaceId") { [weak self] (view: GhosttySurfaceView, surfaceId: String) in
        view.setEventEmitter { [weak self] eventName, payload in
          self?.sendEvent(eventName, payload)
        }
        view.surfaceId = surfaceId
      }

      Prop("fontSize", 14.0) { (view: GhosttySurfaceView, fontSize: Double) in
        view.fontSize = fontSize
      }

      Prop("lineHeightPx", 18.0) { (view: GhosttySurfaceView, lineHeightPx: Double) in
        view.lineHeightPx = lineHeightPx
      }

      Prop("accessibilitySummary") { (view: GhosttySurfaceView, accessibilitySummary: String) in
        view.accessibilitySummary = accessibilitySummary
      }

      Prop("accessibilityAccepted", false) { (view: GhosttySurfaceView, accessibilityAccepted: Bool) in
        view.accessibilityAccepted = accessibilityAccepted
      }

      Prop("accessibilityTerminalLabel") { (view: GhosttySurfaceView, value: String) in
        view.accessibilityTerminalLabel = value
      }

      Prop("accessibilityFallbackValue") { (view: GhosttySurfaceView, value: String) in
        view.accessibilityFallbackValue = value
      }

      Prop("accessibilityFocusActionLabel") { (view: GhosttySurfaceView, value: String) in
        view.accessibilityFocusActionLabel = value
      }

      Prop("accessibilityCopySelectionActionLabel") { (view: GhosttySurfaceView, value: String) in
        view.accessibilityCopySelectionActionLabel = value
      }
    }
  }
}
