package dev.happier.audio

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class AudioSessionPriorStateTest {
  @Test
  fun repeatedConfigurationRetainsTheOriginalModeAndRouteUntilRestorationCompletes() {
    val owner = AudioSessionPriorState()
    val original = AndroidAudioSessionState(
      mode = 3,
      speakerphoneOn = false,
      bluetoothScoOn = true,
      communicationDeviceId = 41
    )
    val reconfigured = AndroidAudioSessionState(
      mode = 0,
      speakerphoneOn = true,
      bluetoothScoOn = false,
      communicationDeviceId = 99
    )

    owner.captureIfAbsent(original)
    owner.captureIfAbsent(reconfigured)

    assertEquals(original, owner.get())
    owner.clear()
    assertNull(owner.get())
  }
}
