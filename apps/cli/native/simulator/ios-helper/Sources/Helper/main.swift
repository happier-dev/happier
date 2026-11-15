import Foundation

// happier-ios-simulator-helper entrypoint.
//
// Modes (see apps/cli/src/daemon/devices/simulator/ios/helper.ts + helperProbe.ts):
//   --health-json   emit one IosSimulatorAdapterHealthV1 JSON object, then exit 0/1
//   --daemon-json   long-running NDJSON loop: emit status/diagnostic/frame/control_ack,
//                   read control commands from stdin
//
// Both modes report unavailable while capture and input have no native producer.

let helperVersion = HelperBuildInfo.version

func emitLine(_ value: String) {
    FileHandle.standardOutput.write(Data((value + "\n").utf8))
}

// The transport scaffold has no framebuffer or HID producer. Signing and framework loading
// cannot turn it into one; both modes must describe that same unavailable implementation.
func runHealthJson() -> Int32 {
    emitLine(WireCodec.line(HelperHealth.unavailable(
        reasonCode: "ios_private_helper_unavailable",
        code: "ios_capture_producer_unimplemented"
    )) ?? "{}")
    return 1
}

func runDaemonJson() -> Int32 {
    let status = HelperStatusMessage(
        status: "unavailable",
        helperVersion: helperVersion,
        supportedCodecs: [],
        supportedInputKinds: [],
        diagnostics: [[
            "reasonCode": "ios_private_helper_unavailable",
            "code": "ios_capture_producer_unimplemented"
        ]]
    )
    emitLine(WireCodec.line(status) ?? "{}")
    return 1
}

let arguments = Array(CommandLine.arguments.dropFirst())

if arguments.contains("--health-json") {
    exit(runHealthJson())
} else if arguments.contains("--daemon-json") {
    exit(runDaemonJson())
} else {
    FileHandle.standardError.write(Data("usage: happier-ios-simulator-helper [--health-json|--daemon-json]\n".utf8))
    exit(64) // EX_USAGE
}
