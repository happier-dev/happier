package dev.happier.audio

import org.junit.Assert.assertThrows
import org.junit.Assert.assertEquals
import org.junit.Test

class AudioSessionOwnershipGateTest {
  @Test
  fun captureStartBeforeCoordinatorConfigurationFailsClosed() {
    val gate = AudioSessionOwnershipGate()
    val admission = AudioCaptureStartAdmission(gate)
    var audioRecordSideEffects = 0

    assertThrows(IllegalStateException::class.java) {
      admission.run {
        audioRecordSideEffects += 1
      }
    }
    assertEquals(0, audioRecordSideEffects)
  }
}
