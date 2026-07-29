import Foundation

// Build-stamped helper version. buildIosSimulatorHelper.mjs rewrites HELPER_VERSION at build time
// (or passes -DHELPER_VERSION) so the emitted health.helperVersion matches the pinned manifest
// version. The default placeholder keeps an unbuilt source tree honestly "unavailable".
enum HelperBuildInfo {
    static let version: String = {
        if let injected = ProcessInfo.processInfo.environment["HAPPIER_IOS_HELPER_VERSION"],
           !injected.isEmpty {
            return injected
        }
        return "0.0.0-unavailable"
    }()
}
