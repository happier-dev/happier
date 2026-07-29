package dev.happier.audio

internal data class AndroidAudioSessionState(
  val mode: Int,
  val speakerphoneOn: Boolean,
  val bluetoothScoOn: Boolean,
  val communicationDeviceId: Int?
)

/** Retains the state that predated the first coordinator-owned configuration. */
internal class AudioSessionPriorState {
  private var state: AndroidAudioSessionState? = null

  fun captureIfAbsent(next: AndroidAudioSessionState) {
    if (state == null) state = next
  }

  fun get(): AndroidAudioSessionState? = state

  fun clear() {
    state = null
  }
}
