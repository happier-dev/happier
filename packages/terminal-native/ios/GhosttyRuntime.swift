import Foundation

enum GhosttyRuntimeState: String {
  case unavailable
  case available
}

struct GhosttyRuntimeDiagnostic {
  let state: GhosttyRuntimeState
  let reason: String
  let detail: String

  var isAvailable: Bool {
    state == .available
  }

  func availabilityPayload() -> [String: Any] {
    if isAvailable {
      return [
        "available": true,
        "platform": "ios",
        "renderer": "ios-ghosttykit",
        "moduleVersion": GhosttyRuntime.moduleVersion,
        "accessibility": GhosttyRuntime.accessibility,
      ]
    }

    return [
      "available": false,
      "reason": reason,
      "detail": detail,
    ]
  }
}

enum GhosttyRuntime {
  static let moduleVersion = "0.0.0"
  static var accessibility: String {
#if HAPPIER_TERMINAL_NATIVE_IOS_ACCESSIBILITY_NATIVE
    return "native"
#else
    return "fallback-required"
#endif
  }
  static let unavailableWriteResult: [String: Any] = [
    "accepted": false,
    "reason": "renderer-unavailable",
    "detail": "iOS Ghostty renderer is unavailable; xterm WebView fallback must remain selected.",
  ]
}

func makeGhosttyRuntimeDiagnostic() -> GhosttyRuntimeDiagnostic {
#if !HAPPIER_TERMINAL_NATIVE_IOS_PACKAGE_PROOF_ACCEPTED
  return GhosttyRuntimeDiagnostic(
    state: .unavailable,
    reason: "package-proof-unaccepted",
    detail: "iOS Ghostty package proof has not been accepted."
  )
#elseif !HAPPIER_TERMINAL_NATIVE_IOS_CRASH_FALLBACK_PROVEN
  return GhosttyRuntimeDiagnostic(
    state: .unavailable,
    reason: "renderer-unavailable",
    detail: "iOS Ghostty crash-to-WebView fallback proof has not passed."
  )
#elseif HAPPIER_TERMINAL_NATIVE_HAS_GHOSTTY
  return GhosttyRuntimeDiagnostic(
    state: .available,
    reason: "available",
    detail: "GhosttyKit is linked and hard native renderer gates passed."
  )
#else
  return GhosttyRuntimeDiagnostic(
    state: .unavailable,
    reason: "artifact-missing",
    detail: "iOS Ghostty renderer artifacts are not linked even though package and crash fallback proof gates passed."
  )
#endif
}
