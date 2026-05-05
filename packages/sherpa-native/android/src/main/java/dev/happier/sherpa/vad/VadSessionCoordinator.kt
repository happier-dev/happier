package dev.happier.sherpa.vad

/**
 * Pure coordinator for VAD sessions.
 *
 * This owns the "stop previous session on double-start" contract in a unit-testable way.
 * The actual audio capture + native detector lifetimes live in platform code.
 */
class VadSessionCoordinator {
  @Volatile private var activeSessionId: String? = null

  @Synchronized
  fun startSession(sessionId: String, stopActive: (String) -> Unit) {
    require(sessionId.isNotBlank()) { "sessionId is required" }

    val prev = activeSessionId
    if (prev != null) {
      stopActive(prev)
    }

    activeSessionId = sessionId
  }

  @Synchronized
  fun stopSession(sessionId: String, stopActive: (String) -> Unit) {
    require(sessionId.isNotBlank()) { "sessionId is required" }

    val prev = activeSessionId
    if (prev == null || prev != sessionId) return

    stopActive(prev)
    activeSessionId = null
  }

  @Synchronized
  fun stopAny(stopActive: (String) -> Unit) {
    val prev = activeSessionId ?: return
    stopActive(prev)
    activeSessionId = null
  }
}
