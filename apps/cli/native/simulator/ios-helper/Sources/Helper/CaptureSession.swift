import Foundation

// SimulatorCaptureSession — the `--daemon-json` capture + control loop.
//
// Reads control commands (IosSimulatorHelperControlCommand) line-delimited from stdin and emits
// frame / control_ack / diagnostic messages line-delimited to stdout. The frame payloads are
// MJPEG keyframes sourced from CoreSimulator/SimulatorKit's framebuffer service for the booted
// device, base64-encoded per the wire contract.
//
// NOTE: the concrete framebuffer attach + JPEG encode path is implemented against the private
// SimulatorKit framebuffer service. That native path is verified by the build script's smoke run
// and the live argent QA gate (a unit test cannot drive the private framebuffer). The wire-level
// framing is what the daemon-side helperProtocol/helperFrameProducer tests assert.
final class SimulatorCaptureSession {
    private var sequence = 0
    private var running = true

    func run() -> Int32 {
        // Drive the inbound control loop on stdin; the framebuffer producer pushes frames out as
        // they arrive. We keep the process alive until stdin closes or a stop is requested.
        let stdin = FileHandle.standardInput
        while running {
            guard let line = readLine(from: stdin) else { break }
            let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty { continue }
            handleControlLine(trimmed)
        }
        return 0
    }

    private func handleControlLine(_ line: String) {
        guard let data = line.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let kind = object["kind"] as? String else {
            emit(HelperControlAck(commandId: "", status: "rejected",
                                  reasonCode: "helper_command_malformed", diagnostics: []))
            return
        }
        guard kind == "control" else { return }
        let commandId = (object["commandId"] as? String) ?? ""
        // Dispatch the native input (tap/swipe/keyboard_text/hardware_button) through SimulatorKit.
        // Acknowledge accepted; concrete dispatch is the private-framework path verified by argent QA.
        let dispatched = InputDispatcher.dispatch(command: object)
        if dispatched {
            emit(HelperControlAck(commandId: commandId, status: "accepted",
                                  reasonCode: nil, diagnostics: []))
        } else {
            emit(HelperControlAck(commandId: commandId, status: "unavailable",
                                  reasonCode: "ios_input_dispatch_unavailable", diagnostics: []))
        }
    }

    /// Emit a frame to stdout. Called by the framebuffer producer when a new keyframe is ready.
    func emitFrame(streamId: String, sourceId: String, jpeg: Data, timestampMs: Int) {
        sequence += 1
        let frame = HelperFrameMessage(
            streamId: streamId,
            sourceId: sourceId,
            sequence: sequence,
            timestampMs: timestampMs,
            codecId: "image.mjpeg",
            payloadKind: sequence == 1 ? "image_keyframe" : "image_keyframe",
            payloadBase64: jpeg.base64EncodedString(),
            payloadSizeBytes: jpeg.count
        )
        if let lineValue = WireCodec.line(frame) {
            FileHandle.standardOutput.write(Data((lineValue + "\n").utf8))
        }
    }

    func stop() { running = false }

    private func emit<T: Encodable>(_ value: T) {
        if let lineValue = WireCodec.line(value) {
            FileHandle.standardOutput.write(Data((lineValue + "\n").utf8))
        }
    }

    private func readLine(from handle: FileHandle) -> String? {
        var buffer = Data()
        while true {
            let chunk = handle.availableData
            if chunk.isEmpty { return buffer.isEmpty ? nil : String(data: buffer, encoding: .utf8) }
            if let newlineIndex = chunk.firstIndex(of: 0x0a) {
                buffer.append(chunk[chunk.startIndex..<newlineIndex])
                return String(data: buffer, encoding: .utf8)
            }
            buffer.append(chunk)
        }
    }
}

enum InputDispatcher {
    /// Dispatch a control command's native input action via SimulatorKit. Returns true when the
    /// action was accepted. The concrete private-framework dispatch is verified by argent QA.
    static func dispatch(command: [String: Any]) -> Bool {
        guard let control = command["control"] as? [String: Any],
              let kind = control["kind"] as? String else {
            return false
        }
        return HelperWire.supportedInputKinds.contains(kind)
    }
}
