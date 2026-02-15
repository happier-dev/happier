package dev.happier.audio

import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.util.Base64
import java.io.ByteArrayOutputStream
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class HappierAudioStreamNativeModule : Module() {
  private var activeStreamId: String? = null
  private var record: AudioRecord? = null
  private var thread: Thread? = null
  private var stopFlag = AtomicBoolean(false)

  override fun definition() = ModuleDefinition {
    Name("HappierAudioStreamNative")

    Events("audioFrame")

    AsyncFunction("start") { params: Map<String, Any> ->
      val sampleRate = (params["sampleRate"] as? Number)?.toInt() ?: 16000
      val channels = (params["channels"] as? Number)?.toInt() ?: 1
      val frameMs = (params["frameMs"] as? Number)?.toInt() ?: 50

      if (sampleRate <= 0) throw IllegalArgumentException("sampleRate must be > 0")
      if (channels != 1 && channels != 2) throw IllegalArgumentException("channels must be 1 or 2")
      if (frameMs <= 0) throw IllegalArgumentException("frameMs must be > 0")

      stopActive()

      val streamId = UUID.randomUUID().toString()
      val channelConfig = if (channels == 1) AudioFormat.CHANNEL_IN_MONO else AudioFormat.CHANNEL_IN_STEREO
      val minBuffer = AudioRecord.getMinBufferSize(sampleRate, channelConfig, AudioFormat.ENCODING_PCM_16BIT)
      if (minBuffer == AudioRecord.ERROR || minBuffer == AudioRecord.ERROR_BAD_VALUE) {
        throw IllegalStateException("failed_to_get_min_buffer_size")
      }

      val bytesPerFrame = channels * 2
      val frameBytes = ((sampleRate * frameMs) / 1000) * bytesPerFrame
      val bufferSize = maxOf(minBuffer, frameBytes * 2)

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

      stopFlag.set(false)
      audioRecord.startRecording()

      val readBuffer = ByteArray(bufferSize)
      val accumulator = ByteArrayOutputStream()

      val t = Thread {
        try {
          while (!stopFlag.get()) {
            val read = audioRecord.read(readBuffer, 0, readBuffer.size)
            if (read <= 0) continue
            accumulator.write(readBuffer, 0, read)

            while (accumulator.size() >= frameBytes && frameBytes > 0) {
              val all = accumulator.toByteArray()
              val chunk = all.copyOfRange(0, frameBytes)
              val rest = if (all.size > frameBytes) all.copyOfRange(frameBytes, all.size) else ByteArray(0)
              accumulator.reset()
              if (rest.isNotEmpty()) accumulator.write(rest)

              val base64 = Base64.encodeToString(chunk, Base64.NO_WRAP)
              sendEvent(
                "audioFrame",
                mapOf(
                  "streamId" to streamId,
                  "pcm16leBase64" to base64,
                  "sampleRate" to sampleRate,
                  "channels" to channels
                )
              )
            }
          }
        } catch (_: Throwable) {
          // best-effort
        }
      }
      t.name = "HappierAudioStreamNative"
      t.isDaemon = true
      t.start()

      activeStreamId = streamId
      record = audioRecord
      thread = t

      return@AsyncFunction mapOf("streamId" to streamId)
    }

    AsyncFunction("stop") { params: Map<String, Any> ->
      val streamId = params["streamId"] as? String
      if (streamId == null || streamId.isBlank()) return@AsyncFunction
      if (activeStreamId != streamId) return@AsyncFunction
      stopActive()
    }
  }

  private fun stopActive() {
    stopFlag.set(true)
    try {
      thread?.join(400)
    } catch (_: Throwable) {
      // ignore
    }
    thread = null

    val audioRecord = record
    record = null
    if (audioRecord != null) {
      try {
        audioRecord.stop()
      } catch (_: Throwable) {
        // ignore
      }
      try {
        audioRecord.release()
      } catch (_: Throwable) {
        // ignore
      }
    }

    activeStreamId = null
  }
}
