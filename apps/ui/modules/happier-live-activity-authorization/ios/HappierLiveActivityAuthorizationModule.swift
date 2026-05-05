import ActivityKit
import ExpoModulesCore
import Foundation

public final class HappierLiveActivityAuthorizationModule: Module {
  public func definition() -> ModuleDefinition {
    Name("HappierLiveActivityAuthorization")

    AsyncFunction("getLiveActivityAuthorizationDiagnostics") { () -> [String: Bool] in
      if #available(iOS 16.2, *) {
        let authorizationInfo = ActivityAuthorizationInfo()
        return [
          "areActivitiesEnabled": authorizationInfo.areActivitiesEnabled,
          "frequentPushesEnabled": authorizationInfo.frequentPushesEnabled,
        ]
      }

      return [
        "areActivitiesEnabled": false,
        "frequentPushesEnabled": false,
      ]
    }
  }
}
