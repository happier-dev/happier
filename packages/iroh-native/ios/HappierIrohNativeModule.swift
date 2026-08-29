import ExpoModulesCore
import Foundation

/// Lifecycle/status only; tunnel bytes never cross this boundary.
public final class HappierIrohNativeModule: Module {
  public func definition() -> ModuleDefinition {
    Name("HappierIrohNative")
    Function("getAvailability") { () -> [String: Any] in
      ["available": false, "platform": "ios", "engine": "iroh", "supportsHomeTunnel": false]
    }
    AsyncFunction("startHomeTunnel") { (_ request: [String: Any]) async throws -> [String: Any] in
      throw NSError(domain: "HappierIrohNative", code: 1, userInfo: [NSLocalizedDescriptionKey: "Iroh native engine is not linked in this build."])
    }
    AsyncFunction("stopHomeTunnel") { (_ leaseId: String) async throws -> Void in }
    AsyncFunction("getHomeTunnelStatus") { (_ homeServerIdentityId: String) async -> [String: Any]? in nil }
  }
}
