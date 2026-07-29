import XCTest
@testable import HappierSherpaNative

final class FrameFedVadDetectorRegistryTests: XCTestCase {
  func test_pushEmitsStartEdgeAndEndThenAllowsNextStart() throws {
    let detector = FakeFrameFedVadDetector([
      .init(speechDetected: true, speechEnded: false),
      .init(speechDetected: true, speechEnded: false),
      .init(speechDetected: false, speechEnded: true),
      .init(speechDetected: true, speechEnded: false),
    ])
    let registry = FrameFedVadDetectorRegistry { _, _, _ in detector }
    try registry.create(detectorId: "vad", sampleRate: 16_000, minSpeechMs: 100, redemptionMs: 300)

    XCTAssertEqual(try registry.push(detectorId: "vad", data: Data([0, 0]), sampleRate: 16_000, channels: 1).speechStarted, true)
    XCTAssertEqual(try registry.push(detectorId: "vad", data: Data([0, 0]), sampleRate: 16_000, channels: 1).speechStarted, false)
    XCTAssertEqual(try registry.push(detectorId: "vad", data: Data([0, 0]), sampleRate: 16_000, channels: 1).speechEnded, true)
    XCTAssertEqual(try registry.push(detectorId: "vad", data: Data([0, 0]), sampleRate: 16_000, channels: 1).speechStarted, true)
  }

  func test_replacementAndCancelCloseExactlyTheirOwnDetector() throws {
    let first = FakeFrameFedVadDetector([])
    let second = FakeFrameFedVadDetector([])
    var detectors = [first, second]
    let registry = FrameFedVadDetectorRegistry { _, _, _ in detectors.removeFirst() }

    try registry.create(detectorId: "vad", sampleRate: 16_000, minSpeechMs: 0, redemptionMs: 0)
    try registry.create(detectorId: "vad", sampleRate: 16_000, minSpeechMs: 0, redemptionMs: 0)
    XCTAssertEqual(first.closeCount, 1)
    XCTAssertEqual(second.closeCount, 0)

    registry.cancel(detectorId: "vad")
    registry.cancel(detectorId: "vad")
    XCTAssertEqual(second.closeCount, 1)
  }
}

private final class FakeFrameFedVadDetector: FrameFedVadDetector {
  private var results: [FrameFedVadDetection]
  private(set) var closeCount = 0

  init(_ results: [FrameFedVadDetection]) {
    self.results = results
  }

  func acceptPcm16(data: Data, sampleRate: Int32, channels: Int32) throws -> FrameFedVadDetection {
    results.isEmpty ? .init(speechDetected: false, speechEnded: false) : results.removeFirst()
  }

  func close() {
    closeCount += 1
  }
}
