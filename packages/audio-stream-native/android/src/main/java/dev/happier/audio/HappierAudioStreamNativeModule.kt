package dev.happier.audio

import android.content.Context
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioFocusRequest
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.AudioAttributes
import android.media.MediaRecorder
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.NoiseSuppressor
import android.os.Build
import android.util.Base64
import java.io.ByteArrayOutputStream
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

internal class AudioCaptureStopSignal {
  private val stopped = AtomicBoolean(false)

  fun requestStop() {
    stopped.set(true)
  }

  fun isStopRequested(): Boolean = stopped.get()
}

internal class AudioSessionOwnershipGate {
  var isConfigured: Boolean = false
    private set

  fun markConfigured() {
    isConfigured = true
  }

  fun clear() {
    isConfigured = false
  }

  fun requireCaptureConfigured() {
    if (!isConfigured) throw IllegalStateException("audio_session_not_configured")
  }
}

internal class AudioCaptureStartAdmission(
  private val audioSessionOwnership: AudioSessionOwnershipGate
) {
  fun <T> run(startAudioRecordSideEffects: () -> T): T {
    audioSessionOwnership.requireCaptureConfigured()
    return startAudioRecordSideEffects()
  }
}

internal fun routeNameForDeviceType(type: Int): String = when (type) {
  AudioDeviceInfo.TYPE_BLUETOOTH_A2DP, AudioDeviceInfo.TYPE_BLUETOOTH_SCO -> "bluetooth"
  AudioDeviceInfo.TYPE_WIRED_HEADPHONES, AudioDeviceInfo.TYPE_WIRED_HEADSET, AudioDeviceInfo.TYPE_USB_HEADSET -> "wired"
  AudioDeviceInfo.TYPE_BUILTIN_EARPIECE -> "earpiece"
  AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> "speaker"
  else -> "unknown"
}

class HappierAudioStreamNativeModule : Module() {
  private var activeStreamId: String? = null
  private var record: AudioRecord? = null
  private var thread: Thread? = null
  private var stopSignal: AudioCaptureStopSignal? = null
  private var audioManager: AudioManager? = null
  private var audioSessionGeneration: Int = 0
  private val audioSessionOwnership = AudioSessionOwnershipGate()
  private val captureStartAdmission = AudioCaptureStartAdmission(audioSessionOwnership)
  private val priorAudioSessionState = AudioSessionPriorState()
  private var voiceProcessingRequested = false
  private var activeAec: AcousticEchoCanceler? = null
  private var activeNoiseSuppressor: NoiseSuppressor? = null
  private var focusRequest: AudioFocusRequest? = null
  private var focusListener: AudioManager.OnAudioFocusChangeListener? = null
  private var deviceCallback: AudioDeviceCallback? = null
  private var communicationDeviceChangedListener: AudioManager.OnCommunicationDeviceChangedListener? = null

  private fun emitAudioSessionEvent(kind: String, values: Map<String, Any> = emptyMap(), generation: Int = audioSessionGeneration) {
    sendEvent("voiceAudioSessionEvent", values + mapOf("generation" to generation, "kind" to kind))
  }

  private fun routeName(manager: AudioManager): String {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return "unknown"
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      manager.communicationDevice?.let { return routeNameForDeviceType(it.type) }
    }
    @Suppress("DEPRECATION")
    if (manager.isBluetoothScoOn) return "bluetooth"
    @Suppress("DEPRECATION")
    if (manager.isSpeakerphoneOn) return "speaker"
    val outputs = manager.getDevices(AudioManager.GET_DEVICES_OUTPUTS)
    outputs.firstOrNull { routeNameForDeviceType(it.type) == "wired" }
      ?.let { return "wired" }
    outputs.firstOrNull { it.type == AudioDeviceInfo.TYPE_BUILTIN_EARPIECE }
      ?.let { return "earpiece" }
    return outputs.firstOrNull()?.let { routeNameForDeviceType(it.type) } ?: "unknown"
  }

  private fun removeRouteCallbacks(manager: AudioManager) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
      deviceCallback?.let { manager.unregisterAudioDeviceCallback(it) }
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      communicationDeviceChangedListener?.let { manager.removeOnCommunicationDeviceChangedListener(it) }
    }
    deviceCallback = null
    communicationDeviceChangedListener = null
  }

  private fun ensureRouteCallbacks(context: Context, manager: AudioManager, generation: Int) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return
    removeRouteCallbacks(manager)
    val callback = object : AudioDeviceCallback() {
      override fun onAudioDevicesAdded(addedDevices: Array<out AudioDeviceInfo>) {
        emitAudioSessionEvent("route_changed", mapOf("route" to routeName(manager)), generation)
      }

      override fun onAudioDevicesRemoved(removedDevices: Array<out AudioDeviceInfo>) {
        emitAudioSessionEvent("route_changed", mapOf("route" to routeName(manager)), generation)
      }
    }
    manager.registerAudioDeviceCallback(callback, null)
    deviceCallback = callback
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      val communicationListener = AudioManager.OnCommunicationDeviceChangedListener {
        emitAudioSessionEvent("route_changed", mapOf("route" to routeName(manager)), generation)
      }
      manager.addOnCommunicationDeviceChangedListener(context.mainExecutor, communicationListener)
      communicationDeviceChangedListener = communicationListener
    }
  }

  @Suppress("DEPRECATION")
  private fun capturePriorAudioSessionState(manager: AudioManager) {
    priorAudioSessionState.captureIfAbsent(AndroidAudioSessionState(
      mode = manager.mode,
      speakerphoneOn = manager.isSpeakerphoneOn,
      bluetoothScoOn = manager.isBluetoothScoOn,
      communicationDeviceId = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        manager.communicationDevice?.id
      } else {
        null
      }
    ))
  }

  @Suppress("DEPRECATION")
  private fun restorePriorAudioSessionState(manager: AudioManager, previous: AndroidAudioSessionState) {
    manager.mode = previous.mode
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      val previousDevice = previous.communicationDeviceId?.let { deviceId ->
        manager.availableCommunicationDevices.firstOrNull { it.id == deviceId }
      }
      if (previousDevice != null) {
        if (!manager.setCommunicationDevice(previousDevice)) {
          throw IllegalStateException("audio_route_restore_failed")
        }
      } else {
        manager.clearCommunicationDevice()
      }
      return
    }

    manager.isSpeakerphoneOn = previous.speakerphoneOn
    if (previous.bluetoothScoOn) {
      manager.startBluetoothSco()
      manager.isBluetoothScoOn = true
    } else {
      manager.isBluetoothScoOn = false
      manager.stopBluetoothSco()
    }
  }

  private fun requestAudioFocus(manager: AudioManager, output: Boolean, generation: Int) {
    if (!output) return
    val listener = AudioManager.OnAudioFocusChangeListener { change ->
      when (change) {
        AudioManager.AUDIOFOCUS_GAIN -> emitAudioSessionEvent("focus_changed", mapOf("state" to "gained"), generation)
        AudioManager.AUDIOFOCUS_LOSS_TRANSIENT,
        AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> emitAudioSessionEvent("focus_changed", mapOf("state" to "lost_transient"), generation)
        AudioManager.AUDIOFOCUS_LOSS -> emitAudioSessionEvent("focus_changed", mapOf("state" to "lost_permanent"), generation)
      }
    }
    focusListener = listener
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE)
        .setAudioAttributes(
          AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
            .build()
        )
        .setOnAudioFocusChangeListener(listener)
        .build()
      val result = manager.requestAudioFocus(request)
      if (result != AudioManager.AUDIOFOCUS_REQUEST_GRANTED) throw IllegalStateException("audio_focus_denied")
      focusRequest = request
    } else {
      @Suppress("DEPRECATION")
      val result = manager.requestAudioFocus(listener, AudioManager.STREAM_VOICE_CALL, AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE)
      if (result != AudioManager.AUDIOFOCUS_REQUEST_GRANTED) throw IllegalStateException("audio_focus_denied")
    }
  }

  private fun abandonAudioFocus(manager: AudioManager) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      focusRequest?.let { manager.abandonAudioFocusRequest(it) }
    } else {
      @Suppress("DEPRECATION")
      focusListener?.let { manager.abandonAudioFocus(it) }
    }
    focusRequest = null
    focusListener = null
  }

  private fun configureAudioSession(params: Map<String, Any>): Map<String, Any> {
    val generation = (params["generation"] as? Number)?.toInt() ?: 0
    @Suppress("UNCHECKED_CAST")
    val configuration = params["configuration"] as? Map<String, Any>
      ?: throw IllegalArgumentException("configuration_required")
    val mode = configuration["mode"] as? String ?: "dictation"
    val output = configuration["output"] as? Boolean ?: false
    val aec = configuration["aec"] as? String ?: "off"
    val context = appContext.reactContext?.applicationContext
      ?: throw IllegalStateException("react_context_unavailable")
    val manager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    capturePriorAudioSessionState(manager)
    if (audioSessionOwnership.isConfigured) abandonAudioFocus(manager)
    // Record ownership before operations that may throw so the coordinator's
    // rollback restore can unwind a partially-applied mode/focus change.
    audioManager = manager
    audioSessionGeneration = generation
    audioSessionOwnership.markConfigured()
    manager.mode = if (mode == "conversation") AudioManager.MODE_IN_COMMUNICATION else AudioManager.MODE_NORMAL
    requestAudioFocus(manager, output, generation)
    ensureRouteCallbacks(context, manager, generation)
    val aecAvailable = AcousticEchoCanceler.isAvailable()
    voiceProcessingRequested = mode == "conversation" && aec != "off" && aecAvailable
    return mapOf(
      "generation" to generation,
      "aecAvailable" to aecAvailable,
      "aecActive" to voiceProcessingRequested,
      "route" to routeName(manager)
    )
  }

  private fun restoreAudioSession(generation: Int) {
    if (generation < audioSessionGeneration) return
    val wasConfigured = audioSessionOwnership.isConfigured
    stopActive()
    val manager = audioManager
    if (manager != null) {
      abandonAudioFocus(manager)
      removeRouteCallbacks(manager)
      priorAudioSessionState.get()?.let { restorePriorAudioSessionState(manager, it) }
    }
    priorAudioSessionState.clear()
    audioManager = null
    audioSessionGeneration = generation
    audioSessionOwnership.clear()
    voiceProcessingRequested = false
    if (wasConfigured) emitAudioSessionEvent("restoration_completed")
  }

  override fun definition() = ModuleDefinition {
    Name("HappierAudioStreamNative")

    Events("audioFrame", "voiceAudioSessionEvent")

    OnDestroy {
      restoreAudioSession(audioSessionGeneration + 1)
    }

    OnActivityEntersForeground {
      if (audioSessionOwnership.isConfigured) emitAudioSessionEvent("lifecycle_changed", mapOf("state" to "foreground"))
    }

    OnActivityEntersBackground {
      if (audioSessionOwnership.isConfigured) emitAudioSessionEvent("lifecycle_changed", mapOf("state" to "background"))
    }

    AsyncFunction("configureAudioSession") { params: Map<String, Any> ->
      return@AsyncFunction configureAudioSession(params)
    }

    AsyncFunction("restoreAudioSession") { params: Map<String, Any> ->
      val generation = (params["generation"] as? Number)?.toInt() ?: 0
      restoreAudioSession(generation)
    }

    AsyncFunction("start") { params: Map<String, Any> ->
      val sampleRate = (params["sampleRate"] as? Number)?.toInt() ?: 16000
      val channels = (params["channels"] as? Number)?.toInt() ?: 1
      val frameMs = (params["frameMs"] as? Number)?.toInt() ?: 50

      if (sampleRate <= 0) throw IllegalArgumentException("sampleRate must be > 0")
      if (channels != 1 && channels != 2) throw IllegalArgumentException("channels must be 1 or 2")
      if (frameMs <= 0) throw IllegalArgumentException("frameMs must be > 0")

      return@AsyncFunction captureStartAdmission.run {
        stopActive()
        try {
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
          if (voiceProcessingRequested) MediaRecorder.AudioSource.VOICE_COMMUNICATION else MediaRecorder.AudioSource.VOICE_RECOGNITION,
          sampleRate,
          channelConfig,
          AudioFormat.ENCODING_PCM_16BIT,
          bufferSize
        )

        if (audioRecord.state != AudioRecord.STATE_INITIALIZED) {
          audioRecord.release()
          throw IllegalStateException("audio_record_not_initialized")
        }

        val captureStopSignal = AudioCaptureStopSignal()
        activeStreamId = streamId
        record = audioRecord
        stopSignal = captureStopSignal
        audioRecord.startRecording()

        if (voiceProcessingRequested) {
          activeAec = AcousticEchoCanceler.create(audioRecord.audioSessionId)?.also { it.enabled = true }
          activeNoiseSuppressor = NoiseSuppressor.create(audioRecord.audioSessionId)?.also { it.enabled = true }
          if (activeAec?.enabled != true) throw IllegalStateException("aec_unavailable")
        }

        val readBuffer = ByteArray(bufferSize)
        val accumulator = ByteArrayOutputStream()

        val t = Thread {
          try {
            while (!captureStopSignal.isStopRequested()) {
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
            // Teardown stops/releases AudioRecord to unblock a pending read.
          }
        }
        t.name = "HappierAudioStreamNative"
        t.isDaemon = true
        thread = t
        t.start()

          mapOf("streamId" to streamId)
        } catch (error: Throwable) {
          stopActive()
          throw error
        }
      }
    }

    AsyncFunction("stop") { params: Map<String, Any> ->
      val streamId = params["streamId"] as? String
      if (streamId == null || streamId.isBlank()) return@AsyncFunction
      if (activeStreamId != streamId) return@AsyncFunction
      stopActive()
    }
  }

  private fun stopActive() {
    stopSignal?.requestStop()
    stopSignal = null

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

    try {
      thread?.join(400)
    } catch (_: Throwable) {
      // ignore
    }
    thread = null

    activeAec?.release()
    activeNoiseSuppressor?.release()
    activeAec = null
    activeNoiseSuppressor = null

    activeStreamId = null
  }
}
