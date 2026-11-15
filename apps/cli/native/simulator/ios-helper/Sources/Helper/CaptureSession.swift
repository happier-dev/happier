import Foundation

// NDJSON transport scaffold only. There is no framebuffer or HID producer; the entrypoint
// reports unavailable until those native effects are implemented and verified.
final class SimulatorCaptureSession {
    private var sequence = 0
    private var running = true

    func run() -> Int32 {
        // Transport loop retained for the eventual native producer.
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
        emit(HelperControlAck(commandId: commandId, status: "unavailable",
                              reasonCode: "ios_private_helper_unavailable",
                              diagnostics: [["code": "ios_capture_producer_unimplemented"]]))
    }

    /// Wire encoder scaffold; no framebuffer producer currently calls this method.
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
