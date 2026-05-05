import XCTest

@testable import HappierSherpaNative

final class IosVadSessionRunnerTests: XCTestCase {
  func test_startVadSession_closesDetectorAndClearsSessionWhenCaptureStartThrows() {
    let capture = FailingVadAudioCapture(error: TestError("start_failed"))
    let detector = FakeVadDetector()
    let replacementCapture = FakeVadAudioCapture()
    let replacementDetector = FakeVadDetector()

    var captures: [VadAudioCapture] = [capture, replacementCapture]
    var detectors: [FakeVadDetector] = [detector, replacementDetector]

    let runner = IosVadSessionRunner(
      makeAudioCapture: {
        guard !captures.isEmpty else { throw TestError("no_more_captures") }
        return captures.removeFirst()
      },
      makeDetector: { _, _ in
        guard !detectors.isEmpty else { throw TestError("no_more_detectors") }
        return detectors.removeFirst()
      },
      onSpeechEnd: { _ in
        XCTFail("should_not_emit_speech_end_in_this_test")
      }
    )

    XCTAssertThrowsError(try runner.startVadSession(sessionId: "s1", minSpeechMs: 0, redemptionMs: 0))
    XCTAssertEqual(capture.stopCallCount, 1)
    XCTAssertEqual(detector.closeCallCount, 1)

    XCTAssertNoThrow(try runner.startVadSession(sessionId: "s2", minSpeechMs: 0, redemptionMs: 0))
    XCTAssertFalse(replacementCapture.didStop)
  }

  func test_startVadSession_stopsPreviousSessionOnDoubleStart() throws {
    let captureA = FakeVadAudioCapture()
    let captureB = FakeVadAudioCapture()
    var captures: [FakeVadAudioCapture] = [captureA, captureB]

    let detectorA = FakeVadDetector()
    let detectorB = FakeVadDetector()
    var detectors: [FakeVadDetector] = [detectorA, detectorB]

    let runner = IosVadSessionRunner(
      makeAudioCapture: {
        guard !captures.isEmpty else { throw TestError("no_more_captures") }
        return captures.removeFirst()
      },
      makeDetector: { _, _ in
        guard !detectors.isEmpty else { throw TestError("no_more_detectors") }
        return detectors.removeFirst()
      },
      onSpeechEnd: { _ in
        XCTFail("should_not_emit_speech_end_in_this_test")
      }
    )

    try runner.startVadSession(sessionId: "s1", minSpeechMs: 0, redemptionMs: 0)
    XCTAssertFalse(captureA.didStop)

    try runner.startVadSession(sessionId: "s2", minSpeechMs: 0, redemptionMs: 0)
    XCTAssertTrue(captureA.didStop)
    XCTAssertFalse(captureB.didStop)
  }

  func test_stopVadSession_onlyStopsWhenSessionIdMatches() throws {
    let captureA = FakeVadAudioCapture()
    let runner = IosVadSessionRunner(
      makeAudioCapture: { captureA },
      makeDetector: { _, _ in FakeVadDetector() },
      onSpeechEnd: { _ in
        XCTFail("should_not_emit_speech_end_in_this_test")
      }
    )

    try runner.startVadSession(sessionId: "s1", minSpeechMs: 0, redemptionMs: 0)
    XCTAssertFalse(captureA.didStop)

    runner.stopVadSession(sessionId: "other")
    XCTAssertFalse(captureA.didStop)

    runner.stopVadSession(sessionId: "s1")
    XCTAssertTrue(captureA.didStop)
  }

  func test_speechEnd_emitsOnceAndStopsSession() throws {
    let captureA = FakeVadAudioCapture()
    let detector = FakeVadDetector()
    detector.detectSpeechEndOnAcceptIndex = 2

    var emitted: [String] = []
    let runner = IosVadSessionRunner(
      makeAudioCapture: { captureA },
      makeDetector: { _, _ in detector },
      onSpeechEnd: { sessionId in
        emitted.append(sessionId)
      }
    )

    try runner.startVadSession(sessionId: "s1", minSpeechMs: 0, redemptionMs: 0)
    captureA.emit(samples: Array(repeating: 0.0, count: 160))
    XCTAssertEqual(emitted, [])
    XCTAssertFalse(captureA.didStop)

    captureA.emit(samples: Array(repeating: 0.0, count: 160))
    XCTAssertEqual(emitted, ["s1"])
    XCTAssertTrue(captureA.didStop)

    // Further audio frames must not re-emit.
    captureA.emit(samples: Array(repeating: 0.0, count: 160))
    XCTAssertEqual(emitted, ["s1"])
  }

  func test_stopVadSession_waitsForInFlightAcceptBeforeClosingDetector() throws {
    let capture = FakeVadAudioCapture()
    let detector = BlockingVadDetector()
    let stopReturned = DispatchSemaphore(value: 0)

    let runner = IosVadSessionRunner(
      makeAudioCapture: { capture },
      makeDetector: { _, _ in detector },
      onSpeechEnd: { _ in
        XCTFail("should_not_emit_speech_end_in_this_test")
      }
    )
    let runnerHandle = UncheckedRunnerHandle(runner)

    try runner.startVadSession(sessionId: "s1", minSpeechMs: 0, redemptionMs: 0)

    DispatchQueue.global().async {
      capture.emit(samples: Array(repeating: 0.0, count: 160))
    }

    detector.waitUntilAcceptStarts()

    DispatchQueue.global().async {
      runnerHandle.runner.stopVadSession(sessionId: "s1")
      stopReturned.signal()
    }

    XCTAssertEqual(stopReturned.wait(timeout: .now() + 0.1), .timedOut)
    XCTAssertEqual(detector.closeCallCount, 0)

    detector.allowAcceptToFinish()

    XCTAssertEqual(stopReturned.wait(timeout: .now() + 1.0), .success)
    XCTAssertEqual(detector.closeCallCount, 1)
    XCTAssertFalse(detector.closeObservedAcceptInFlight)
  }
}

private final class FakeVadAudioCapture: VadAudioCapture, @unchecked Sendable {
  private var onSamples: ((UnsafePointer<Float>, Int32) -> Void)?
  private(set) var didStop: Bool = false
  private(set) var stopCallCount: Int = 0

  func start(onSamples: @escaping (UnsafePointer<Float>, Int32) -> Void) throws {
    self.onSamples = onSamples
  }

  func stop() {
    stopCallCount += 1
    didStop = true
  }

  func emit(samples: [Float]) {
    guard !didStop else { return }
    samples.withUnsafeBufferPointer { buf in
      guard let base = buf.baseAddress else { return }
      onSamples?(base, Int32(buf.count))
    }
  }
}

private final class FakeVadDetector: VadDetector, @unchecked Sendable {
  var detectSpeechEndOnAcceptIndex: Int = 1
  private(set) var closeCallCount: Int = 0
  private var acceptIndex: Int = 0

  func acceptWaveform(samples: UnsafePointer<Float>, count: Int32) -> Bool {
    acceptIndex += 1
    return acceptIndex >= detectSpeechEndOnAcceptIndex
  }

  func close() {
    closeCallCount += 1
  }
}

private final class FailingVadAudioCapture: VadAudioCapture, @unchecked Sendable {
  private let error: Error
  private(set) var stopCallCount: Int = 0

  init(error: Error) {
    self.error = error
  }

  func start(onSamples: @escaping (UnsafePointer<Float>, Int32) -> Void) throws {
    throw error
  }

  func stop() {
    stopCallCount += 1
  }
}

private final class BlockingVadDetector: VadDetector, @unchecked Sendable {
  private let acceptStarted = DispatchSemaphore(value: 0)
  private let acceptMayFinish = DispatchSemaphore(value: 0)
  private let stateLock = NSLock()

  private(set) var closeCallCount: Int = 0
  private(set) var closeObservedAcceptInFlight: Bool = false
  private var acceptInFlight: Bool = false

  func acceptWaveform(samples: UnsafePointer<Float>, count: Int32) -> Bool {
    stateLock.lock()
    acceptInFlight = true
    stateLock.unlock()

    acceptStarted.signal()
    _ = acceptMayFinish.wait(timeout: .now() + 1.0)

    stateLock.lock()
    acceptInFlight = false
    stateLock.unlock()
    return false
  }

  func close() {
    stateLock.lock()
    closeCallCount += 1
    if acceptInFlight {
      closeObservedAcceptInFlight = true
    }
    stateLock.unlock()
  }

  func waitUntilAcceptStarts() {
    _ = acceptStarted.wait(timeout: .now() + 1.0)
  }

  func allowAcceptToFinish() {
    acceptMayFinish.signal()
  }
}

private final class UncheckedRunnerHandle: @unchecked Sendable {
  let runner: IosVadSessionRunner

  init(_ runner: IosVadSessionRunner) {
    self.runner = runner
  }
}

private struct TestError: Error {
  let message: String
  init(_ message: String) { self.message = message }
}
