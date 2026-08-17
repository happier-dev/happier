package dev.happier.audio

import android.media.AudioRecord
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class AudioCaptureReadResultTest {
  @Test
  fun mapsDeadObjectAndOtherReadFailuresToBoundedTerminalReasons() {
    assertEquals("dead_object", captureTerminalReasonForReadResult(AudioRecord.ERROR_DEAD_OBJECT))
    assertEquals("read_error", captureTerminalReasonForReadResult(AudioRecord.ERROR_INVALID_OPERATION))
    assertNull(captureTerminalReasonForReadResult(0))
  }
}
