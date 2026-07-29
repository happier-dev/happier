// swift-tools-version:5.9
import PackageDescription

// happier-ios-simulator-helper
//
// First-party iOS Simulator capture/control helper for the Happier daemon device-preview tier.
// It links Apple's private CoreSimulator/SimulatorKit frameworks to attach to a booted simulator,
// stream its screen as MJPEG frames, and dispatch native input (tap/swipe/keyboard/hardware button).
//
// The binary speaks the wire contract defined in TypeScript under
// apps/cli/src/daemon/devices/simulator/ios/helperProtocol.ts:
//   --health-json   prints a single IosSimulatorAdapterHealthV1 JSON object and exits
//   --daemon-json   newline-delimited JSON: status/diagnostic/frame/control_ack out, control in
//
// Trust model: this is a TRUSTED first-party diagnostics/control channel — the iOS analog of the
// pinned Android scrcpy server. It is launched only through the daemon's forbidden-runtime-guarded
// starter and is only ever resolved after a Developer ID signature + notarization + digest verify.
let package = Package(
    name: "happier-ios-simulator-helper",
    platforms: [
        .macOS(.v13),
    ],
    targets: [
        .executableTarget(
            name: "happier-ios-simulator-helper",
            path: "Sources/Helper",
            // CoreSimulator / SimulatorKit are private frameworks resolved from the active
            // Xcode developer dir at runtime via dlopen; we do not weak-link them at build
            // time so the build does not depend on their presence on the build host. The
            // build script (buildIosSimulatorHelper.mjs) provides the framework search path.
            linkerSettings: [
                .unsafeFlags([
                    "-Xlinker", "-rpath",
                    "-Xlinker", "@executable_path/../Frameworks",
                ])
            ]
        ),
        .testTarget(
            name: "HelperTests",
            dependencies: ["happier-ios-simulator-helper"],
            path: "Tests/HelperTests"
        ),
    ]
)
