import ExpoModulesCore
import Foundation

public final class HappierSshNativeModule: Module {
  public func definition() -> ModuleDefinition {
    Name("HappierSshNative")

    Events("hostKeyPrompt", "authPrompt", "progress")

    Function("getAvailability") { () -> [String: Any] in
      HappierSshNativeBridge.availability()
    }

    AsyncFunction("exec") { (_ request: [String: Any]) async throws -> [String: Any] in
      try await HappierSshNativeBridge.execAsync(module: self, request: request)
    }

    AsyncFunction("respondToHostKeyPrompt") { (_ promptId: String, _ response: [String: Any]) -> Void in
      HappierSshNativeBridge.respondToHostKeyPrompt(promptId: promptId, response: response)
    }

    AsyncFunction("respondToAuthPrompt") { (_ promptId: String, _ response: [String: Any]) -> Void in
      HappierSshNativeBridge.respondToAuthPrompt(promptId: promptId, response: response)
    }

    AsyncFunction("cancelRequest") { (_ requestId: String) -> Void in
      HappierSshNativeBridge.cancelRequest(requestId: requestId)
    }

    AsyncFunction("startLoopbackTunnel") { (_ request: [String: Any]) async throws -> [String: Any] in
      try await HappierSshNativeBridge.startLoopbackTunnelAsync(module: self, request: request)
    }

    AsyncFunction("stopLoopbackTunnel") { (_ nativeTunnelId: String) -> Void in
      HappierSshNativeBridge.stopLoopbackTunnel(nativeTunnelId: nativeTunnelId)
    }
  }
}
