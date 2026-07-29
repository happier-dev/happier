import Foundation

// happier-ios-simulator-helper entrypoint.
//
// Modes (see apps/cli/src/daemon/devices/simulator/ios/helper.ts + helperProbe.ts):
//   --health-json   emit one IosSimulatorAdapterHealthV1 JSON object, then exit 0/1
//   --daemon-json   long-running NDJSON loop: emit status/diagnostic/frame/control_ack,
//                   read control commands from stdin
//
// Fail-closed: if the private simulator frameworks are unavailable / incompatible, --health-json
// emits status:"unavailable" with a typed reasonCode and exits non-zero, which the daemon resolver
// surfaces as ios_private_helper_unavailable / private_framework_symbol_mismatch.

let helperVersion = HelperBuildInfo.version

func emitLine(_ value: String) {
    FileHandle.standardOutput.write(Data((value + "\n").utf8))
}

func runHealthJson() -> Int32 {
    switch SimulatorBridge.probe() {
    case let .ready(xcodeVersion):
        let health = HelperHealth.available(helperVersion: helperVersion, xcodeVersion: xcodeVersion)
        if let line = WireCodec.line(health) {
            emitLine(line)
            return 0
        }
        emitLine(WireCodec.line(HelperHealth.unavailable(
            reasonCode: "ios_private_helper_unavailable",
            code: "health_serialization_failed"
        )) ?? "{}")
        return 1
    case let .unavailable(reasonCode, code):
        emitLine(WireCodec.line(HelperHealth.unavailable(reasonCode: reasonCode, code: code)) ?? "{}")
        return 1
    }
}

func runDaemonJson() -> Int32 {
    let probe = SimulatorBridge.probe()
    guard case .ready = probe else {
        let reasonCode: String
        if case let .unavailable(rc, _) = probe { reasonCode = rc } else { reasonCode = "ios_private_helper_unavailable" }
        let status = HelperStatusMessage(
            status: "unavailable",
            helperVersion: helperVersion,
            supportedCodecs: HelperWire.supportedCodecs,
            supportedInputKinds: [],
            diagnostics: [["reasonCode": reasonCode]]
        )
        emitLine(WireCodec.line(status) ?? "{}")
        return 1
    }

    // Ready: announce status, then run the capture/control loop. The streaming/input dispatch
    // implementation links CoreSimulator/SimulatorKit and is exercised by the native test target
    // + the live argent QA gate; the daemon-side TS contract is driven by helperProtocol.test.ts.
    let status = HelperStatusMessage(
        status: "ready",
        helperVersion: helperVersion,
        supportedCodecs: HelperWire.supportedCodecs,
        supportedInputKinds: HelperWire.supportedInputKinds,
        diagnostics: []
    )
    emitLine(WireCodec.line(status) ?? "{}")

    let session = SimulatorCaptureSession()
    return session.run()
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
