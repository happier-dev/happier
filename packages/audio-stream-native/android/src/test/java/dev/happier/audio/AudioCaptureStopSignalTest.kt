package dev.happier.audio

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AudioCaptureStopSignalTest {
  @Test
  fun stoppingOneCaptureCannotCancelOrRestartAnotherGeneration() {
    val first = AudioCaptureStopSignal()
    val second = AudioCaptureStopSignal()

    first.requestStop()

    assertTrue(first.isStopRequested())
    assertFalse(second.isStopRequested())
  }

  @Test
  fun expectedStopCannotPublishATerminalFailure() {
    val signal = AudioCaptureStopSignal()

    signal.requestStop()

    assertFalse(signal.claimTerminal())
  }

  @Test
  fun terminalFailureCanBeClaimedOnlyOnce() {
    val signal = AudioCaptureStopSignal()

    assertTrue(signal.claimTerminal())
    assertFalse(signal.claimTerminal())
  }
}
