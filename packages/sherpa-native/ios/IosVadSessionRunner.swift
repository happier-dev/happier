import Foundation

protocol VadAudioCapture {
  func start(onSamples: @escaping (_ samples: UnsafePointer<Float>, _ count: Int32) -> Void) throws
  func stop()
}

protocol VadDetector {
  /// Returns true when a speech segment is available (i.e. "speech ended").
  func acceptWaveform(samples: UnsafePointer<Float>, count: Int32) -> Bool
  func close()
}

/// Owns mic capture + native sherpa-onnx VAD lifecycle for a single active session.
///
/// Contract:
/// - startVadSession always stops any currently-active session (even if same id).
/// - emits onSpeechEnd once and then stops/cleans up.
final class IosVadSessionRunner {
  private let lock = NSLock()
  private var active: ActiveVadSession?

  private let coordinator: VadSessionCoordinator
  private let makeAudioCapture: () throws -> VadAudioCapture
  private let makeDetector: (_ minSpeechSec: Float, _ minSilenceSec: Float) throws -> VadDetector
  private let onSpeechEnd: (_ sessionId: String) -> Void

  init(
    makeAudioCapture: @escaping () throws -> VadAudioCapture,
    makeDetector: @escaping (_ minSpeechSec: Float, _ minSilenceSec: Float) throws -> VadDetector,
    onSpeechEnd: @escaping (_ sessionId: String) -> Void,
    coordinator: VadSessionCoordinator = VadSessionCoordinator()
  ) {
    self.makeAudioCapture = makeAudioCapture
    self.makeDetector = makeDetector
    self.onSpeechEnd = onSpeechEnd
    self.coordinator = coordinator
  }

  func startVadSession(sessionId: String, minSpeechMs: Int64, redemptionMs: Int64) throws {
    coordinator.startSession(sessionId: sessionId) { prev in
      self.stopVadSessionInternal(sessionId: prev)
    }
    try startVadSessionInternal(sessionId: sessionId, minSpeechMs: minSpeechMs, redemptionMs: redemptionMs)
  }

  func stopVadSession(sessionId: String) {
    coordinator.stopSession(sessionId: sessionId) { id in
      self.stopVadSessionInternal(sessionId: id)
    }
  }

  func stopAny() {
    coordinator.stopAny { id in
      self.stopVadSessionInternal(sessionId: id)
    }
  }

  private func startVadSessionInternal(sessionId: String, minSpeechMs: Int64, redemptionMs: Int64) throws {
    let id = sessionId.trimmingCharacters(in: .whitespacesAndNewlines)
    if id.isEmpty {
      throw NSError(domain: "HappierSherpaNative", code: 401, userInfo: [NSLocalizedDescriptionKey: "sessionId is required"])
    }

    let minSpeechSec = Float(max(0, minSpeechMs)) / 1000.0
    let minSilenceSec = Float(max(0, redemptionMs)) / 1000.0

    let capture = try makeAudioCapture()
    let detector = try makeDetector(minSpeechSec, minSilenceSec)

    let session = ActiveVadSession(sessionId: id, capture: capture, detector: detector)

    lock.lock()
    active = session
    lock.unlock()

    do {
      try capture.start { [weak self] samples, count in
        guard let self else { return }

        guard let current = self.beginAccept(sessionId: id, session: session) else {
          return
        }
        let speechEnded = current.acceptWaveform(samples: samples, count: count)
        current.endAccept()
        if !speechEnded { return }

        self.lock.lock()
        guard let cur = self.active, cur === current, !cur.stopRequested, !cur.didEmitSpeechEnd else {
          self.lock.unlock()
          return
        }
        cur.didEmitSpeechEnd = true
        cur.stopRequested = true
        self.lock.unlock()

        self.onSpeechEnd(id)
        self.stopVadSessionInternal(sessionId: id)
      }
    } catch {
      cleanupFailedStart(session: session)
      throw error
    }
  }

  private func stopVadSessionInternal(sessionId: String) {
    let id = sessionId.trimmingCharacters(in: .whitespacesAndNewlines)
    if id.isEmpty { return }

    lock.lock()
    let session = active
    if session?.sessionId == id {
      active = nil
    }
    lock.unlock()

    guard let session, session.sessionId == id else { return }

    session.stopRequested = true
    session.capture.stop()
    session.closeDetector()
  }

  private func beginAccept(sessionId: String, session: ActiveVadSession) -> ActiveVadSession? {
    lock.lock()
    guard let current = active, current === session, current.sessionId == sessionId, !current.stopRequested else {
      lock.unlock()
      return nil
    }
    current.beginAccept()
    lock.unlock()
    return current
  }

  private func cleanupFailedStart(session: ActiveVadSession) {
    lock.lock()
    if active === session {
      active = nil
    }
    lock.unlock()

    session.stopRequested = true
    session.capture.stop()
    session.closeDetector()
  }
}

private final class ActiveVadSession {
  let sessionId: String
  let capture: VadAudioCapture
  let detector: VadDetector
  private let detectorLock = NSLock()

  // Guarded by the runner's lock.
  var didEmitSpeechEnd: Bool = false
  var stopRequested: Bool = false

  init(sessionId: String, capture: VadAudioCapture, detector: VadDetector) {
    self.sessionId = sessionId
    self.capture = capture
    self.detector = detector
  }

  func beginAccept() {
    detectorLock.lock()
  }

  func acceptWaveform(samples: UnsafePointer<Float>, count: Int32) -> Bool {
    detector.acceptWaveform(samples: samples, count: count)
  }

  func endAccept() {
    detectorLock.unlock()
  }

  func closeDetector() {
    detectorLock.lock()
    detector.close()
    detectorLock.unlock()
  }
}
