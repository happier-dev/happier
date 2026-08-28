package dev.happier.audio

import android.content.pm.ServiceInfo
import android.media.AudioManager
import android.os.Build
import org.junit.Assert.assertThrows
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AudioSessionOwnershipGateTest {
  @Test
  fun androidQConversationForegroundServiceDeclaresMicrophoneAndMediaPlaybackTypes() {
    assertEquals(
      ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE or ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK,
      foregroundServiceTypeForSdk(Build.VERSION_CODES.Q),
    )
  }

  @Test
  fun preAndroidQConversationForegroundServiceUsesTheLegacyUntypedStartPath() {
    assertEquals(null, foregroundServiceTypeForSdk(Build.VERSION_CODES.P))
  }

  @Test
  fun onlyAnInputEnabledAggregateConversationRequiresTheAndroidForegroundService() {
    assertTrue(requiresVoiceForegroundService("conversation", true))
    assertFalse(requiresVoiceForegroundService("conversation", false))
    assertFalse(requiresVoiceForegroundService("dictation", true))
    assertFalse(requiresVoiceForegroundService("playback", false))
  }

  @Test
  fun duckableFocusLossLeavesPcmRunningForTheCanonicalGainOwner() {
    val focus = AudioPlaybackFocusController()

    assertEquals(
      AudioPlaybackFocusAction.NONE,
      focus.onFocusChange(AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK),
    )
    assertFalse(focus.isOutputPaused())
  }

  @Test
  fun transientFocusLossPausesOutputAndGainRestoresIt() {
    val focus = AudioPlaybackFocusController()

    assertEquals(
      AudioPlaybackFocusAction.PAUSE,
      focus.onFocusChange(AudioManager.AUDIOFOCUS_LOSS_TRANSIENT),
    )
    assertTrue(focus.isOutputPaused())
    assertEquals(
      AudioPlaybackFocusAction.RESUME,
      focus.onFocusChange(AudioManager.AUDIOFOCUS_GAIN),
    )
    assertFalse(focus.isOutputPaused())
  }

  @Test
  fun permanentFocusLossPreventsGainFromResumingPausedOutputUntilFocusIsGrantedAgain() {
    val focus = AudioPlaybackFocusController()

    assertEquals(
      AudioPlaybackFocusAction.PAUSE,
      focus.onFocusChange(AudioManager.AUDIOFOCUS_LOSS_TRANSIENT),
    )
    assertEquals(
      AudioPlaybackFocusAction.NONE,
      focus.onFocusChange(AudioManager.AUDIOFOCUS_LOSS_TRANSIENT),
    )
    assertEquals(
      AudioPlaybackFocusAction.NONE,
      focus.onFocusChange(AudioManager.AUDIOFOCUS_LOSS),
    )
    assertEquals(
      AudioPlaybackFocusAction.NONE,
      focus.onFocusChange(AudioManager.AUDIOFOCUS_GAIN),
    )
    assertTrue(focus.isOutputPaused())
    assertEquals(AudioPlaybackFocusAction.RESUME, focus.onFocusRequestGranted())
    assertFalse(focus.isOutputPaused())
  }

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
  fun preferredAecActivationExceptionStartsCaptureWithDegradedCapabilities() {
    val gate = AudioSessionOwnershipGate()
    gate.markConfigured()
    val admission = AudioCaptureStartAdmission(gate)

    val result = admission.run(
      aec = AudioCaptureAecRequest.PREFERRED,
      startCapture = { "capture-started" },
      activateAec = { throw IllegalStateException("vendor_audio_effect_failure") }
    )

    assertEquals("capture-started", result.capture)
    assertFalse(result.aecActive)
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
  fun requiredAecActivationExceptionRemainsFailClosedWithCanonicalError() {
    val gate = AudioSessionOwnershipGate()
    gate.markConfigured()
    val admission = AudioCaptureStartAdmission(gate)

    val error = assertThrows(IllegalStateException::class.java) {
      admission.run(
        aec = AudioCaptureAecRequest.REQUIRED,
        startCapture = { "capture-started" },
        activateAec = { throw IllegalStateException("vendor_audio_effect_failure") }
      )
    }

    assertEquals("aec_unavailable", error.message)
    assertEquals("vendor_audio_effect_failure", error.cause?.message)
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
