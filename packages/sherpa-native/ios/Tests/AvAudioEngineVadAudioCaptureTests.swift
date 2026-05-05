import AVFoundation
import XCTest

@testable import HappierSherpaNative

final class AvAudioEngineVadAudioCaptureTests: XCTestCase {
  func test_start_configuresAndActivatesAudioSessionBeforeStartingEngine() throws {
    let tracker = CallOrderTracker()
    let audioSession = FakeVadAudioSessionController(callOrder: tracker)
    let inputNode = FakeVadAudioInputNode(callOrder: tracker)
    let engine = FakeVadAudioEngine(inputNode: inputNode, callOrder: tracker)
    let capture = AvAudioEngineVadAudioCapture(
      audioSession: audioSession,
      makeAudioEngine: { engine }
    )

    try capture.start { _, _ in
      XCTFail("audio tap should not emit in this test")
    }

    XCTAssertEqual(
      tracker.events,
      [
        "session.setCategory",
        "session.setPreferredSampleRate",
        "session.setActive(true)",
        "engine.start",
      ]
    )
    XCTAssertEqual(audioSession.categoryCalls.count, 1)
    XCTAssertEqual(audioSession.preferredSampleRates, [16_000])
    XCTAssertEqual(audioSession.activeCalls.map(\.active), [true])
  }

  func test_stop_deactivatesAudioSessionAfterStoppingEngine() throws {
    let tracker = CallOrderTracker()
    let audioSession = FakeVadAudioSessionController(callOrder: tracker)
    let inputNode = FakeVadAudioInputNode(callOrder: tracker)
    let engine = FakeVadAudioEngine(inputNode: inputNode, callOrder: tracker)
    let capture = AvAudioEngineVadAudioCapture(
      audioSession: audioSession,
      makeAudioEngine: { engine }
    )

    try capture.start { _, _ in
      XCTFail("audio tap should not emit in this test")
    }

    tracker.events.removeAll()
    capture.stop()

    XCTAssertEqual(
      tracker.events,
      [
        "input.removeTap",
        "engine.stop",
        "session.setActive(false)",
      ]
    )
    XCTAssertEqual(audioSession.activeCalls.map(\.active), [true, false])
    XCTAssertEqual(
      audioSession.activeCalls.last?.options,
      [.notifyOthersOnDeactivation]
    )
  }

  func test_start_deactivatesAudioSessionWhenEngineStartFails() {
    let tracker = CallOrderTracker()
    let audioSession = FakeVadAudioSessionController(callOrder: tracker)
    let inputNode = FakeVadAudioInputNode(callOrder: tracker)
    let engine = FakeVadAudioEngine(
      inputNode: inputNode,
      callOrder: tracker,
      startError: TestError("engine_start_failed")
    )
    let capture = AvAudioEngineVadAudioCapture(
      audioSession: audioSession,
      makeAudioEngine: { engine }
    )

    XCTAssertThrowsError(
      try capture.start { _, _ in
        XCTFail("audio tap should not emit in this test")
      }
    )

    XCTAssertEqual(
      tracker.events,
      [
        "session.setCategory",
        "session.setPreferredSampleRate",
        "session.setActive(true)",
        "engine.start",
        "input.removeTap",
        "session.setActive(false)",
      ]
    )
    XCTAssertEqual(audioSession.activeCalls.map(\.active), [true, false])
  }
}

private final class CallOrderTracker {
  var events: [String] = []
}

private final class FakeVadAudioSessionController: VadAudioSessionControlling {
  struct CategoryCall {
    let category: AVAudioSession.Category
    let mode: AVAudioSession.Mode
    let options: AVAudioSession.CategoryOptions
  }

  struct ActiveCall {
    let active: Bool
    let options: AVAudioSession.SetActiveOptions
  }

  let callOrder: CallOrderTracker
  private(set) var categoryCalls: [CategoryCall] = []
  private(set) var preferredSampleRates: [Double] = []
  private(set) var activeCalls: [ActiveCall] = []

  init(callOrder: CallOrderTracker) {
    self.callOrder = callOrder
  }

  func setCategory(
    _ category: AVAudioSession.Category,
    mode: AVAudioSession.Mode,
    options: AVAudioSession.CategoryOptions
  ) throws {
    callOrder.events.append("session.setCategory")
    categoryCalls.append(CategoryCall(category: category, mode: mode, options: options))
  }

  func setPreferredSampleRate(_ sampleRate: Double) throws {
    callOrder.events.append("session.setPreferredSampleRate")
    preferredSampleRates.append(sampleRate)
  }

  func setActive(_ active: Bool, options: AVAudioSession.SetActiveOptions) throws {
    callOrder.events.append("session.setActive(\(active))")
    activeCalls.append(ActiveCall(active: active, options: options))
  }
}

private final class FakeVadAudioEngine: VadAudioEngineControlling {
  let inputNode: VadAudioInputNodeControlling

  private let callOrder: CallOrderTracker
  private let startError: Error?

  init(
    inputNode: VadAudioInputNodeControlling,
    callOrder: CallOrderTracker,
    startError: Error? = nil
  ) {
    self.inputNode = inputNode
    self.callOrder = callOrder
    self.startError = startError
  }

  func start() throws {
    callOrder.events.append("engine.start")
    if let startError {
      throw startError
    }
  }

  func stop() {
    callOrder.events.append("engine.stop")
  }
}

private final class FakeVadAudioInputNode: VadAudioInputNodeControlling {
  private let callOrder: CallOrderTracker

  init(callOrder: CallOrderTracker) {
    self.callOrder = callOrder
  }

  func outputFormat(forBus bus: AVAudioNodeBus) -> AVAudioFormat {
    AVAudioFormat(
      commonFormat: .pcmFormatFloat32,
      sampleRate: 48_000,
      channels: 1,
      interleaved: false
    )!
  }

  func installTap(
    onBus bus: AVAudioNodeBus,
    bufferSize: AVAudioFrameCount,
    format: AVAudioFormat?,
    block: @escaping AVAudioNodeTapBlock
  ) {
    // no-op
  }

  func removeTap(onBus bus: AVAudioNodeBus) {
    callOrder.events.append("input.removeTap")
  }
}

private struct TestError: Error {
  let message: String

  init(_ message: String) {
    self.message = message
  }
}
