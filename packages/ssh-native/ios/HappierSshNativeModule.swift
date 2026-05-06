import ExpoModulesCore
import Foundation

public final class HappierSshNativeModule: Module {
  public func definition() -> ModuleDefinition {
    Name("HappierSshNative")

    Events("hostKeyPrompt", "progress")

    Function("getAvailability") { () -> [String: Any] in
      HappierSshNativeBridge.availability()
    }

    AsyncFunction("exec") { (_ request: [String: Any]) -> [String: Any] in
      throw NSError(
        domain: "HappierSshNative",
        code: 1,
        userInfo: [NSLocalizedDescriptionKey: HappierSshNativeBridge.unavailableDetail]
      )
    }
  }
}
