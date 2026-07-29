import XCTest
@testable import happier_ios_simulator_helper

// Native-side wire contract tests. These guard that the helper's JSON output stays byte-compatible
// with the daemon-side TypeScript parser (helperProtocol.ts) and Zod schema (iosV1.ts). The live
// private-framebuffer capture path is verified by the build smoke run + argent QA, not here.
final class WireProtocolTests: XCTestCase {
    func testAvailableHealthSerializesToSchemaShape() throws {
        let health = HelperHealth.available(helperVersion: "1.0.0", xcodeVersion: "16.0")
        let line = try XCTUnwrap(WireCodec.line(health))
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any]
        )
        XCTAssertEqual(object["v"] as? Int, 1)
        XCTAssertEqual(object["platform"] as? String, "ios")
        XCTAssertEqual(object["status"] as? String, "available")
        XCTAssertEqual(object["helperDistribution"] as? String, "prebuilt-signed")
        XCTAssertEqual(object["supportedCodecs"] as? [String], ["image.mjpeg"])
        XCTAssertEqual(
            object["requiredPrivateFrameworks"] as? [String],
            ["CoreSimulator", "SimulatorKit"]
        )
        XCTAssertEqual(object["helperVersion"] as? String, "1.0.0")
        XCTAssertFalse(line.contains("\n"))
    }

    func testUnavailableHealthCarriesReasonCode() throws {
        let health = HelperHealth.unavailable(
            reasonCode: "private_framework_symbol_mismatch",
            code: "missing_class_SimDevice"
        )
        let line = try XCTUnwrap(WireCodec.line(health))
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any]
        )
        XCTAssertEqual(object["status"] as? String, "unavailable")
        XCTAssertEqual(object["reasonCode"] as? String, "private_framework_symbol_mismatch")
    }

    func testFrameMessageMatchesWireContract() throws {
        let frame = HelperFrameMessage(
            streamId: "stream_ios",
            sourceId: "ios-simulator:A1B2-C3D4:screen",
            sequence: 1,
            timestampMs: 1_234,
            codecId: "image.mjpeg",
            payloadKind: "image_keyframe",
            payloadBase64: "AQID",
            payloadSizeBytes: 3
        )
        let line = try XCTUnwrap(WireCodec.line(frame))
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any]
        )
        XCTAssertEqual(object["kind"] as? String, "frame")
        XCTAssertEqual(object["payloadEncoding"] as? String, "binary_base64")
        XCTAssertEqual(object["codecId"] as? String, "image.mjpeg")
        XCTAssertEqual(object["payloadBase64"] as? String, "AQID")
    }

    func testControlAckMatchesWireContract() throws {
        let ack = HelperControlAck(
            commandId: "cmd_1",
            status: "accepted",
            reasonCode: nil,
            diagnostics: []
        )
        let line = try XCTUnwrap(WireCodec.line(ack))
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any]
        )
        XCTAssertEqual(object["kind"] as? String, "control_ack")
        XCTAssertEqual(object["status"] as? String, "accepted")
        XCTAssertEqual(object["commandId"] as? String, "cmd_1")
    }

    func testInputDispatcherAcceptsSupportedKinds() {
        XCTAssertTrue(InputDispatcher.dispatch(command: ["control": ["kind": "tap"]]))
        XCTAssertFalse(InputDispatcher.dispatch(command: ["control": ["kind": "unknown"]]))
        XCTAssertFalse(InputDispatcher.dispatch(command: [:]))
    }
}
