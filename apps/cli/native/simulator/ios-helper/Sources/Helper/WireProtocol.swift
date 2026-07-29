import Foundation

// Wire contract mirror of apps/cli/src/daemon/devices/simulator/ios/helperProtocol.ts and
// packages/protocol/src/devices/simulator/iosV1.ts. Keep these shapes byte-compatible with the
// TypeScript parser (helperProtocol.ts) and the Zod schema (IosSimulatorAdapterHealthV1Schema).

enum HelperWire {
    static let protocolVersion = 1
    static let supportedCodecs = ["image.mjpeg"]
    static let supportedInputKinds = ["tap", "swipe", "keyboard_text", "hardware_button"]
    static let requiredPrivateFrameworks = ["CoreSimulator", "SimulatorKit"]
}

/// `--health-json` payload. Discriminated by `status`; mirrors IosSimulatorAdapterHealthV1.
struct HelperHealth: Encodable {
    let v: Int
    let platform: String
    let status: String // "available" | "unavailable"

    // available-only fields
    let usesPrivateFrameworks: Bool?
    let helperDistribution: String? // "prebuilt-signed" | "development-build"
    let requiredPrivateFrameworks: [String]?
    let supportedCodecs: [String]?
    let supportedInputKinds: [String]?
    let helperVersion: String?
    let xcodeVersion: String?

    // unavailable-only fields
    let reasonCode: String?
    let diagnostics: [[String: String]]?

    static func available(helperVersion: String, xcodeVersion: String?) -> HelperHealth {
        HelperHealth(
            v: HelperWire.protocolVersion,
            platform: "ios",
            status: "available",
            usesPrivateFrameworks: true,
            helperDistribution: "prebuilt-signed",
            requiredPrivateFrameworks: HelperWire.requiredPrivateFrameworks,
            supportedCodecs: HelperWire.supportedCodecs,
            supportedInputKinds: HelperWire.supportedInputKinds,
            helperVersion: helperVersion,
            xcodeVersion: xcodeVersion,
            reasonCode: nil,
            diagnostics: nil
        )
    }

    static func unavailable(reasonCode: String, code: String) -> HelperHealth {
        HelperHealth(
            v: HelperWire.protocolVersion,
            platform: "ios",
            status: "unavailable",
            usesPrivateFrameworks: nil,
            helperDistribution: nil,
            requiredPrivateFrameworks: nil,
            supportedCodecs: nil,
            supportedInputKinds: nil,
            helperVersion: nil,
            xcodeVersion: nil,
            reasonCode: reasonCode,
            diagnostics: [["code": code]]
        )
    }
}

/// Outbound `--daemon-json` frame message; mirrors IosSimulatorHelperFrameMessage.
struct HelperFrameMessage: Encodable {
    let v = HelperWire.protocolVersion
    let kind = "frame"
    let streamId: String
    let sourceId: String
    let sequence: Int
    let timestampMs: Int
    let codecId: String
    let payloadKind: String // "image_keyframe" | "image_delta" | "metadata"
    let payloadEncoding = "binary_base64"
    let payloadBase64: String
    let payloadSizeBytes: Int
}

/// Outbound status message; mirrors IosSimulatorHelperStatusMessage.
struct HelperStatusMessage: Encodable {
    let v = HelperWire.protocolVersion
    let kind = "status"
    let status: String // "ready" | "available" | "unavailable"
    let helperVersion: String?
    let supportedCodecs: [String]
    let supportedInputKinds: [String]
    let diagnostics: [[String: String]]
}

/// Outbound control acknowledgement; mirrors IosSimulatorHelperControlAckMessage.
struct HelperControlAck: Encodable {
    let v = HelperWire.protocolVersion
    let kind = "control_ack"
    let commandId: String
    let status: String // "accepted" | "rejected" | "unavailable"
    let reasonCode: String?
    let diagnostics: [[String: String]]
}

enum WireCodec {
    /// Serialize an Encodable to a single compact JSON line (no embedded newlines).
    static func line<T: Encodable>(_ value: T) -> String? {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.withoutEscapingSlashes]
        guard let data = try? encoder.encode(value),
              let json = String(data: data, encoding: .utf8) else {
            return nil
        }
        return json
    }
}
