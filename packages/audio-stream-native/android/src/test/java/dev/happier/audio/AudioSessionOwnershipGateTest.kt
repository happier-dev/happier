package dev.happier.audio

import org.junit.Assert.assertThrows
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
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

  @Test
  fun preferredAecActivationFailureStartsCaptureWithDegradedCapabilities() {
    val gate = AudioSessionOwnershipGate()
    gate.markConfigured()
    val admission = AudioCaptureStartAdmission(gate)
    var activationAttempts = 0

    val result = admission.run(
      aec = AudioCaptureAecRequest.PREFERRED,
      startCapture = { "capture-started" },
      activateAec = {
        activationAttempts += 1
        false
      }
    )

    assertEquals("capture-started", result.capture)
    assertFalse(result.aecActive)
    assertEquals(1, activationAttempts)
  }

  @Test
  fun offDoesNotAttemptAecActivation() {
    val gate = AudioSessionOwnershipGate()
    gate.markConfigured()
    val admission = AudioCaptureStartAdmission(gate)
    var activationAttempts = 0

    val result = admission.run(
      aec = AudioCaptureAecRequest.OFF,
      startCapture = { "capture-started" },
      activateAec = {
        activationAttempts += 1
        true
      }
    )

    assertEquals("capture-started", result.capture)
    assertFalse(result.aecActive)
    assertEquals(0, activationAttempts)
  }

  @Test
  fun requiredAecActivationFailureRemainsFailClosed() {
    val gate = AudioSessionOwnershipGate()
    gate.markConfigured()
    val admission = AudioCaptureStartAdmission(gate)

    val error = assertThrows(IllegalStateException::class.java) {
      admission.run(
        aec = AudioCaptureAecRequest.REQUIRED,
        startCapture = { "capture-started" },
        activateAec = { false }
      )
    }

    assertEquals("aec_unavailable", error.message)
  }

  @Test
  fun captureStartFailurePropagatesWithoutBeingTreatedAsAecDegradation() {
    val gate = AudioSessionOwnershipGate()
    gate.markConfigured()
    val admission = AudioCaptureStartAdmission(gate)
    var activationAttempts = 0

    val error = assertThrows(IllegalStateException::class.java) {
      admission.run(
        aec = AudioCaptureAecRequest.PREFERRED,
        startCapture = { throw IllegalStateException("audio_record_start_failed") },
        activateAec = {
          activationAttempts += 1
          true
        }
      )
    }

    assertEquals("audio_record_start_failed", error.message)
    assertTrue(activationAttempts == 0)
  }
}
