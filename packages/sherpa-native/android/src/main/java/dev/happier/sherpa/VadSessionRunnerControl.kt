package dev.happier.sherpa

internal interface VadSessionRunnerControl {
  fun startVadSession(sessionId: String, minSpeechMs: Long, redemptionMs: Long)

  fun stopVadSession(sessionId: String)

  fun stopAny()
}
