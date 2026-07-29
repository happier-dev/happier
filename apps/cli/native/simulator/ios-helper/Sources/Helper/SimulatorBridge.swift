import Foundation

// Private CoreSimulator / SimulatorKit bridge.
//
// These frameworks are not part of the public SDK; they live inside the active Xcode developer
// directory (`xcode-select -p`) under Library/PrivateFrameworks. We resolve them at runtime via
// dlopen so the build does not hard-depend on their headers. A symbol/availability mismatch must
// surface as a typed unavailable reason (`private_framework_symbol_mismatch`) rather than a crash,
// which keeps the daemon-side capability-truth invariant honest.

/// Result of attempting to load and validate the private simulator frameworks.
enum SimulatorBridgeStatus {
    case ready(xcodeVersion: String?)
    case unavailable(reasonCode: String, code: String)
}

struct SimulatorBridge {
    /// Locate the active developer dir, then dlopen CoreSimulator + SimulatorKit and verify the
    /// minimum symbol surface the streamer/input dispatcher requires.
    static func probe() -> SimulatorBridgeStatus {
        guard let developerDir = activeDeveloperDir() else {
            return .unavailable(reasonCode: "xcode_unavailable", code: "developer_dir_unresolved")
        }

        let frameworksRoot = (developerDir as NSString)
            .appendingPathComponent("Library/PrivateFrameworks")

        for framework in HelperWire.requiredPrivateFrameworks {
            let path = (frameworksRoot as NSString)
                .appendingPathComponent("\(framework).framework/\(framework)")
            guard FileManager.default.fileExists(atPath: path) else {
                return .unavailable(
                    reasonCode: "xcode_private_frameworks_unavailable",
                    code: "missing_\(framework)"
                )
            }
            guard dlopen(path, RTLD_NOW) != nil else {
                return .unavailable(
                    reasonCode: "xcode_private_frameworks_unavailable",
                    code: "dlopen_failed_\(framework)"
                )
            }
        }

        // Verify the SimDevice / SimDeviceFramebufferService class surface the streamer needs.
        // A missing class indicates an incompatible Xcode (symbol drift) — fail closed.
        for requiredClass in ["SimDeviceSet", "SimDevice"] {
            guard NSClassFromString(requiredClass) != nil else {
                return .unavailable(
                    reasonCode: "private_framework_symbol_mismatch",
                    code: "missing_class_\(requiredClass)"
                )
            }
        }

        return .ready(xcodeVersion: xcodeVersion(developerDir: developerDir))
    }

    private static func activeDeveloperDir() -> String? {
        if let override = ProcessInfo.processInfo.environment["DEVELOPER_DIR"], !override.isEmpty {
            return override
        }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/xcode-select")
        process.arguments = ["-p"]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = Pipe()
        do {
            try process.run()
            process.waitUntilExit()
        } catch {
            return nil
        }
        guard process.terminationStatus == 0 else { return nil }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        let value = String(data: data, encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return (value?.isEmpty == false) ? value : nil
    }

    private static func xcodeVersion(developerDir: String) -> String? {
        let plistPath = (developerDir as NSString)
            .deletingLastPathComponent
            .appending("/version.plist")
        guard let data = FileManager.default.contents(atPath: plistPath),
              let plist = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any],
              let version = plist["CFBundleShortVersionString"] as? String else {
            return nil
        }
        return version
    }
}
