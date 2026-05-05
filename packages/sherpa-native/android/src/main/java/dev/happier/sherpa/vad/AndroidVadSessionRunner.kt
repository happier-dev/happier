package dev.happier.sherpa.vad

import android.content.Context
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import dev.happier.sherpa.HappierSherpaNativeJni
import dev.happier.sherpa.VadSessionRunnerControl
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Owns mic capture + native sherpa-onnx VAD lifecycle for a single active session.
 *
 * Contract:
 * - startVadSession always stops any currently-active session (even if same id).
 * - emits onSpeechEnd once and then stops/cleans up.
 */
class AndroidVadSessionRunner(
  private val context: Context,
  private val onSpeechEnd: (sessionId: String) -> Unit,
  private val coordinator: VadSessionCoordinator = VadSessionCoordinator()
) : VadSessionRunnerControl {
  private val lock = Any()
  private var active: ActiveVadSession? = null

  override fun startVadSession(sessionId: String, minSpeechMs: Long, redemptionMs: Long) {
    coordinator.startSession(sessionId) { stopVadSessionInternal(it) }
    startVadSessionInternal(sessionId, minSpeechMs, redemptionMs)
  }

  override fun stopVadSession(sessionId: String) {
    coordinator.stopSession(sessionId) { stopVadSessionInternal(it) }
  }

  override fun stopAny() {
    coordinator.stopAny { stopVadSessionInternal(it) }
  }

  private fun startVadSessionInternal(sessionId: String, minSpeechMs: Long, redemptionMs: Long) {
    require(sessionId.isNotBlank()) { "sessionId is required" }

    val sampleRate = 16_000
    val channels = 1
    val channelConfig = AudioFormat.CHANNEL_IN_MONO
    val minBuffer = AudioRecord.getMinBufferSize(sampleRate, channelConfig, AudioFormat.ENCODING_PCM_16BIT)
    if (minBuffer == AudioRecord.ERROR || minBuffer == AudioRecord.ERROR_BAD_VALUE) {
      throw IllegalStateException("failed_to_get_min_buffer_size")
    }

    val bufferSize = maxOf(minBuffer, sampleRate / 2)
    val audioRecord = AudioRecord(
      MediaRecorder.AudioSource.VOICE_RECOGNITION,
      sampleRate,
      channelConfig,
      AudioFormat.ENCODING_PCM_16BIT,
      bufferSize
    )
    if (audioRecord.state != AudioRecord.STATE_INITIALIZED) {
      audioRecord.release()
      throw IllegalStateException("audio_record_not_initialized")
    }

    val modelPath = VadModelAssetInstaller.ensureInstalled(context)
    val minSpeechSec = (minSpeechMs.coerceAtLeast(0) / 1000.0).toFloat()
    val minSilenceSec = (redemptionMs.coerceAtLeast(0) / 1000.0).toFloat()

    val nativeHandle = HappierSherpaNativeJni.nativeCreateVadSession(modelPath, sampleRate, minSpeechSec, minSilenceSec)
    if (nativeHandle == 0L) {
      audioRecord.release()
      throw IllegalStateException("failed_to_create_vad_session")
    }

    val stopFlag = AtomicBoolean(false)
    val readBuffer = ShortArray(bufferSize / 2)
    try {
      audioRecord.startRecording()
    } catch (error: Throwable) {
      try {
        audioRecord.release()
      } catch (_: Throwable) {}
      HappierSherpaNativeJni.nativeDestroyVadSession(nativeHandle)
      throw error
    }

    val session = ActiveVadSession(
      sessionId = sessionId,
      audioRecord = audioRecord,
      stopFlag = stopFlag
    )
    val t = Thread {
      try {
        while (!stopFlag.get()) {
          val read = audioRecord.read(readBuffer, 0, readBuffer.size)
          if (read <= 0) continue

          val speechEnded = HappierSherpaNativeJni.nativeVadAcceptPcm16(nativeHandle, readBuffer, read, channels)
          if (speechEnded) {
            onSpeechEnd(sessionId)
            break
          }
        }
      } catch (_: Throwable) {
        // best-effort; JS side falls back to heuristic endpointing if VAD fails.
      } finally {
        try {
          audioRecord.stop()
        } catch (_: Throwable) {}
        try {
          audioRecord.release()
        } catch (_: Throwable) {}
        HappierSherpaNativeJni.nativeDestroyVadSession(nativeHandle)

        synchronized(lock) {
          if (active === session) {
            active = null
          }
        }
      }
    }
    t.name = "HappierSherpaNativeVAD"
    t.isDaemon = true
    session.thread = t

    synchronized(lock) {
      active = session
    }

    try {
      t.start()
    } catch (error: Throwable) {
      synchronized(lock) {
        if (active === session) {
          active = null
        }
      }
      stopFlag.set(true)
      try {
        audioRecord.stop()
      } catch (_: Throwable) {}
      try {
        audioRecord.release()
      } catch (_: Throwable) {}
      HappierSherpaNativeJni.nativeDestroyVadSession(nativeHandle)
      throw error
    }
  }

  private fun stopVadSessionInternal(sessionId: String) {
    val toStop = synchronized(lock) {
      val cur = active
      if (cur?.sessionId != sessionId) null else cur.also { active = null }
    } ?: return

    toStop.stopFlag.set(true)
    // Unblock any in-flight AudioRecord.read() so the worker can exit promptly.
    try {
      toStop.audioRecord.stop()
    } catch (_: Throwable) {}
    try {
      toStop.audioRecord.release()
    } catch (_: Throwable) {}
    try {
      toStop.thread?.join(400)
    } catch (_: Throwable) {
      // ignore
    }

    // Thread cleanup handles releasing AudioRecord + native handle.
  }

  private data class ActiveVadSession(
    val sessionId: String,
    val audioRecord: AudioRecord,
    val stopFlag: AtomicBoolean,
    var thread: Thread? = null
  )
}
