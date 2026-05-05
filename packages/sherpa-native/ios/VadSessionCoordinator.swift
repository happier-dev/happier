import Foundation

/// Pure coordinator for VAD sessions.
///
/// This owns the "stop previous session on double-start" contract in a unit-testable way.
/// The actual audio capture + native detector lifetimes live in platform code.
final class VadSessionCoordinator {
  private let lock = NSLock()
  private var activeSessionId: String?

  func startSession(sessionId: String, stopActive: (_ sessionId: String) -> Void) {
    let id = sessionId.trimmingCharacters(in: .whitespacesAndNewlines)
    if id.isEmpty { return }

    lock.lock()
    let prev = activeSessionId
    activeSessionId = id
    lock.unlock()

    if let prev {
      stopActive(prev)
    }
  }

  func stopSession(sessionId: String, stopActive: (_ sessionId: String) -> Void) {
    let id = sessionId.trimmingCharacters(in: .whitespacesAndNewlines)
    if id.isEmpty { return }

    lock.lock()
    let prev = activeSessionId
    if prev == nil || prev != id {
      lock.unlock()
      return
    }
    activeSessionId = nil
    lock.unlock()

    stopActive(id)
  }

  func stopAny(stopActive: (_ sessionId: String) -> Void) {
    lock.lock()
    let prev = activeSessionId
    activeSessionId = nil
    lock.unlock()

    if let prev {
      stopActive(prev)
    }
  }
}
