package dev.happier.audio

import android.content.Context
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioFocusRequest
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.AudioAttributes
import android.media.MediaRecorder
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.NoiseSuppressor
import android.os.Build
import android.util.Base64
import java.io.ByteArrayOutputStream
import java.util.UUID
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

internal class AudioCaptureStopSignal {
  private val lock = Any()
  private var stopped = false
  private var terminalClaimed = false

  fun requestStop() {
    synchronized(lock) {
      stopped = true
    }
  }

  fun isStopRequested(): Boolean = synchronized(lock) { stopped }

  fun claimTerminal(): Boolean = synchronized(lock) {
    if (stopped || terminalClaimed) return@synchronized false
    terminalClaimed = true
    true
  }
}

internal class AudioPlaybackStopSignal {
  private val lock = Any()
  private var stopped = false

  fun requestStop() {
    synchronized(lock) {
      stopped = true
    }
  }

  fun isStopRequested(): Boolean = synchronized(lock) { stopped }
}

internal fun captureTerminalReasonForReadResult(read: Int): String? = when {
  read == AudioRecord.ERROR_DEAD_OBJECT -> "dead_object"
  read < 0 -> "read_error"
  else -> null
}

internal enum class AudioCaptureAecRequest {
  OFF,
  PREFERRED,
  REQUIRED,
}

internal data class AudioCaptureStartResult<T>(
  val capture: T,
  val aecActive: Boolean,
)

private class ActivePlayback(
  val streamId: String,
  val generation: Int,
  val track: AudioTrack,
  val sampleRate: Int,
  val bytesPerFrame: Int,
  val maxQueuedFrames: Long,
  val stopSignal: AudioPlaybackStopSignal,
) {
  var queuedFrames: Long = 0
  var playedFrames: Long = 0
  var lastPlaybackHeadPosition: Long = 0
  var monitorThread: Thread? = null
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

  fun <T> run(
    aec: AudioCaptureAecRequest,
    startCapture: () -> T,
    activateAec: () -> Boolean,
  ): AudioCaptureStartResult<T> {
    audioSessionOwnership.requireCaptureConfigured()
    val capture = startCapture()
    val aecActive = if (aec == AudioCaptureAecRequest.OFF) false else activateAec()
    if (aec == AudioCaptureAecRequest.REQUIRED && !aecActive) {
      throw IllegalStateException("aec_unavailable")
    }
    return AudioCaptureStartResult(capture, aecActive)
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
  private var activeCaptureGeneration: Int = 0
  private var record: AudioRecord? = null
  private var thread: Thread? = null
  private var stopSignal: AudioCaptureStopSignal? = null
  private var audioManager: AudioManager? = null
  private var audioSessionGeneration: Int = 0
  private val audioSessionOwnership = AudioSessionOwnershipGate()
  private val captureStartAdmission = AudioCaptureStartAdmission(audioSessionOwnership)
  private val priorAudioSessionState = AudioSessionPriorState()
  private var captureAecRequest = AudioCaptureAecRequest.OFF
  private var activeAec: AcousticEchoCanceler? = null
  private var activeNoiseSuppressor: NoiseSuppressor? = null
  private var focusRequest: AudioFocusRequest? = null
  private var focusListener: AudioManager.OnAudioFocusChangeListener? = null
  private var deviceCallback: AudioDeviceCallback? = null
  private var communicationDeviceChangedListener: AudioManager.OnCommunicationDeviceChangedListener? = null
  private val playbackLock = Any()
  private var activePlayback: ActivePlayback? = null

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
    captureAecRequest = if (mode == "conversation" && aecAvailable) {
      when (aec) {
        "required" -> AudioCaptureAecRequest.REQUIRED
        "preferred" -> AudioCaptureAecRequest.PREFERRED
        else -> AudioCaptureAecRequest.OFF
      }
    } else {
      AudioCaptureAecRequest.OFF
    }
    return mapOf(
      "generation" to generation,
      "aecAvailable" to aecAvailable,
      "aecActive" to false,
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
    captureAecRequest = AudioCaptureAecRequest.OFF
    if (wasConfigured) emitAudioSessionEvent("restoration_completed")
  }

  private fun playbackIdentityMatches(
    playback: ActivePlayback,
    streamId: String,
    generation: Int,
  ): Boolean {
    return activeStreamId == streamId
      && activeCaptureGeneration == generation
      && playback.streamId == streamId
      && playback.generation == generation
  }

  private fun emitPlaybackEvent(name: String, playback: ActivePlayback, values: Map<String, Any> = emptyMap()) {
    try {
      sendEvent(
        name,
        values + mapOf(
          "streamId" to playback.streamId,
          "generation" to playback.generation,
        )
      )
    } catch (_: Throwable) {
      // A bridge teardown has no remaining output observer.
    }
  }

  private fun updatePlaybackProgressLocked(playback: ActivePlayback): Boolean {
    val head = playback.track.playbackHeadPosition.toLong() and 0xffffffffL
    val delta = if (head >= playback.lastPlaybackHeadPosition) {
      head - playback.lastPlaybackHeadPosition
    } else {
      (1L shl 32) - playback.lastPlaybackHeadPosition + head
    }
    playback.lastPlaybackHeadPosition = head
    if (delta <= 0) return false
    val wasQueued = playback.queuedFrames > 0
    val renderedFrames = minOf(playback.queuedFrames, delta)
    playback.queuedFrames = maxOf(0, playback.queuedFrames - renderedFrames)
    playback.playedFrames += renderedFrames
    return wasQueued && playback.queuedFrames == 0L
  }

  private fun playbackCursorMs(streamId: String, generation: Int): Double {
    var drainedPlayback: ActivePlayback? = null
    val cursorMs = synchronized(playbackLock) {
      val playback = activePlayback?.takeIf { playbackIdentityMatches(it, streamId, generation) }
        ?: return@synchronized 0.0
      if (updatePlaybackProgressLocked(playback)) drainedPlayback = playback
      playback.playedFrames.toDouble() * 1_000.0 / playback.sampleRate.toDouble()
    }
    drainedPlayback?.let { playback ->
      emitPlaybackEvent("playbackLevel", playback, mapOf("level" to 0.0))
      emitPlaybackEvent("playbackDrained", playback)
    }
    return cursorMs
  }

  private fun startPlaybackMonitor(playback: ActivePlayback) {
    val monitor = Thread {
      while (!playback.stopSignal.isStopRequested()) {
        val drained = synchronized(playbackLock) {
          if (activePlayback !== playback) return@Thread
          updatePlaybackProgressLocked(playback)
        }
        if (drained) {
          emitPlaybackEvent("playbackLevel", playback, mapOf("level" to 0.0))
          emitPlaybackEvent("playbackDrained", playback)
        }
        try {
          Thread.sleep(10)
        } catch (_: InterruptedException) {
          return@Thread
        }
      }
    }
    monitor.name = "HappierAudioStreamPlayback"
    monitor.isDaemon = true
    playback.monitorThread = monitor
    monitor.start()
  }

  private fun stopActivePlayback(streamId: String? = null, generation: Int? = null) {
    val playback = synchronized(playbackLock) {
      val current = activePlayback ?: return@synchronized null
      if (
        (streamId != null && current.streamId != streamId)
        || (generation != null && current.generation != generation)
      ) {
        return@synchronized null
      }
      activePlayback = null
      current.stopSignal.requestStop()
      current
    } ?: return

    try {
      playback.track.pause()
    } catch (_: Throwable) {
      // A newly-created or already-stopped track can reject pause.
    }
    try {
      playback.track.flush()
    } catch (_: Throwable) {
      // The track still must be released below.
    }
    try {
      playback.track.stop()
    } catch (_: Throwable) {
      // The track still must be released below.
    }
    try {
      playback.track.release()
    } catch (_: Throwable) {
      // Native teardown is best effort and idempotent at the bridge boundary.
    }
    try {
      if (playback.monitorThread !== Thread.currentThread()) playback.monitorThread?.join(400)
    } catch (_: Throwable) {
      // A stuck monitor has its stop signal and cannot retain the next player.
    }
  }

  private fun terminatePlayback(playback: ActivePlayback, reason: String) {
    val isCurrent = synchronized(playbackLock) { activePlayback === playback }
    if (!isCurrent) return
    stopActivePlayback(playback.streamId, playback.generation)
    emitPlaybackEvent("playbackTerminal", playback, mapOf("reason" to reason))
  }

  private fun startPlayback(params: Map<String, Any>): Map<String, Any> {
    val streamId = params["streamId"] as? String ?: ""
    val generation = (params["generation"] as? Number)?.toInt() ?: 0
    val sampleRate = (params["sampleRate"] as? Number)?.toInt() ?: 0
    val channels = (params["channels"] as? Number)?.toInt() ?: 0
    val maxBufferedMs = (params["maxBufferedMs"] as? Number)?.toInt() ?: 0
    if (streamId.isBlank() || generation <= 0 || activeStreamId != streamId || activeCaptureGeneration != generation) {
      throw IllegalStateException("playback_capture_mismatch")
    }
    if (sampleRate <= 0 || (channels != 1 && channels != 2) || maxBufferedMs <= 0) {
      throw IllegalArgumentException("invalid_playback_format")
    }
    val channelMask = if (channels == 1) AudioFormat.CHANNEL_OUT_MONO else AudioFormat.CHANNEL_OUT_STEREO
    val minBuffer = AudioTrack.getMinBufferSize(sampleRate, channelMask, AudioFormat.ENCODING_PCM_16BIT)
    if (minBuffer == AudioTrack.ERROR || minBuffer == AudioTrack.ERROR_BAD_VALUE || minBuffer <= 0) {
      throw IllegalStateException("failed_to_get_playback_buffer_size")
    }
    val bytesPerFrame = channels * 2
    val maxQueuedFrames = ((sampleRate.toLong() * maxBufferedMs.toLong()) + 999L) / 1_000L
    if (maxQueuedFrames <= 0 || maxQueuedFrames > Int.MAX_VALUE.toLong() / bytesPerFrame.toLong()) {
      throw IllegalArgumentException("invalid_playback_buffer")
    }
    val requestedBufferBytes = (maxQueuedFrames * bytesPerFrame).toInt()
    val track = AudioTrack.Builder()
      .setAudioAttributes(
        AudioAttributes.Builder()
          .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
          .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
          .build()
      )
      .setAudioFormat(
        AudioFormat.Builder()
          .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
          .setSampleRate(sampleRate)
          .setChannelMask(channelMask)
          .build()
      )
      .setBufferSizeInBytes(maxOf(minBuffer, requestedBufferBytes))
      .setTransferMode(AudioTrack.MODE_STREAM)
      .build()
    if (track.state != AudioTrack.STATE_INITIALIZED) {
      track.release()
      throw IllegalStateException("audio_track_not_initialized")
    }
    val playback = ActivePlayback(
      streamId = streamId,
      generation = generation,
      track = track,
      sampleRate = sampleRate,
      bytesPerFrame = bytesPerFrame,
      maxQueuedFrames = maxQueuedFrames,
      stopSignal = AudioPlaybackStopSignal(),
    )
    val accepted = synchronized(playbackLock) {
      if (activePlayback != null || !playbackIdentityMatches(playback, streamId, generation)) {
        false
      } else {
        activePlayback = playback
        true
      }
    }
    if (!accepted) {
      track.release()
      throw IllegalStateException("playback_already_active")
    }
    try {
      track.play()
      startPlaybackMonitor(playback)
    } catch (error: Throwable) {
      stopActivePlayback(streamId, generation)
      throw error
    }
    return mapOf("streamId" to streamId, "generation" to generation)
  }

  private fun playbackLevel(data: ByteArray): Double {
    if (data.isEmpty()) return 0.0
    var energy = 0.0
    var sampleCount = 0
    var index = 0
    while (index + 1 < data.size) {
      val low = data[index].toInt() and 0xff
      val high = data[index + 1].toInt() shl 8
      val sample = (low or high).toShort().toInt()
      val normalized = sample.toDouble() / if (sample < 0) 32768.0 else 32767.0
      energy += normalized * normalized
      sampleCount += 1
      index += 2
    }
    return minOf(1.0, kotlin.math.sqrt(energy / maxOf(1, sampleCount).toDouble()))
  }

  private fun enqueuePlayback(params: Map<String, Any>): Map<String, Any> {
    val streamId = params["streamId"] as? String ?: ""
    val generation = (params["generation"] as? Number)?.toInt() ?: 0
    val encoded = params["pcm16leBase64"] as? String ?: ""
    val data = try {
      Base64.decode(encoded, Base64.DEFAULT)
    } catch (_: IllegalArgumentException) {
      val failed = synchronized(playbackLock) {
        activePlayback?.takeIf { playbackIdentityMatches(it, streamId, generation) }
      }
      if (failed != null) terminatePlayback(failed, "write_error")
      return mapOf("accepted" to false, "level" to 0.0)
    }
    val candidate = synchronized(playbackLock) {
      activePlayback?.takeIf { playbackIdentityMatches(it, streamId, generation) }
    } ?: return mapOf("accepted" to false, "level" to 0.0)
    if (data.isEmpty() || data.size % candidate.bytesPerFrame != 0) {
      terminatePlayback(candidate, "write_error")
      return mapOf("accepted" to false, "level" to 0.0)
    }
    val frameCount = data.size / candidate.bytesPerFrame
    val playback = synchronized(playbackLock) {
      val current = activePlayback
      if (current !== candidate || !playbackIdentityMatches(current, streamId, generation)) {
        return@synchronized null
      }
      // The only drained event is emitted after the monitor observes the
      // post-write queue reach zero. Do not resolve a waiter from stale output
      // progress while this accepted chunk is still pending.
      updatePlaybackProgressLocked(current)
      if (current.queuedFrames + frameCount > current.maxQueuedFrames) {
        return@synchronized null
      }
      current.queuedFrames += frameCount.toLong()
      current
    } ?: return mapOf("accepted" to false, "level" to 0.0)
    val wrote = try {
      // Logical queue admission bounds this blocking call to a single admitted
      // chunk. A true JS result therefore means all PCM bytes were accepted.
      playback.track.write(data, 0, data.size, AudioTrack.WRITE_BLOCKING)
    } catch (_: Throwable) {
      AudioTrack.ERROR_INVALID_OPERATION
    }
    if (wrote != data.size) {
      terminatePlayback(playback, "write_error")
      return mapOf("accepted" to false, "level" to 0.0)
    }
    return mapOf("accepted" to true, "level" to playbackLevel(data))
  }

  private fun clearPlayback(streamId: String, generation: Int) {
    val playback = synchronized(playbackLock) {
      activePlayback?.takeIf { playbackIdentityMatches(it, streamId, generation) }
    } ?: return
    try {
      synchronized(playbackLock) {
        if (activePlayback === playback) updatePlaybackProgressLocked(playback)
      }
      playback.track.pause()
      playback.track.flush()
      playback.track.play()
      synchronized(playbackLock) {
        if (activePlayback !== playback) return@synchronized
        playback.queuedFrames = 0
        playback.lastPlaybackHeadPosition = playback.track.playbackHeadPosition.toLong() and 0xffffffffL
      }
      emitPlaybackEvent("playbackLevel", playback, mapOf("level" to 0.0))
      emitPlaybackEvent("playbackDrained", playback)
    } catch (_: Throwable) {
      terminatePlayback(playback, "player_error")
    }
  }

  private fun setPlaybackGain(streamId: String, generation: Int, gain: Double) {
    if (!gain.isFinite() || gain < 0 || gain > 1) return
    val playback = synchronized(playbackLock) {
      activePlayback?.takeIf { playbackIdentityMatches(it, streamId, generation) }
    } ?: return
    try {
      playback.track.setVolume(gain.toFloat())
    } catch (_: Throwable) {
      terminatePlayback(playback, "player_error")
    }
  }

  override fun definition() = ModuleDefinition {
    Name("HappierAudioStreamNative")

    Events(
      "audioFrame",
      "captureTerminal",
      "playbackDrained",
      "playbackLevel",
      "playbackTerminal",
      "voiceAudioSessionEvent",
    )

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
      val captureGeneration = (params["generation"] as? Number)?.toInt() ?: 0

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
          if (captureAecRequest != AudioCaptureAecRequest.OFF) MediaRecorder.AudioSource.VOICE_COMMUNICATION else MediaRecorder.AudioSource.VOICE_RECOGNITION,
          sampleRate,
          channelConfig,
          AudioFormat.ENCODING_PCM_16BIT,
          bufferSize
        )

        if (audioRecord.state != AudioRecord.STATE_INITIALIZED) {
          audioRecord.release()
          throw IllegalStateException("audio_record_not_initialized")
        }

        val captureAecAvailable = AcousticEchoCanceler.isAvailable()
        val captureStopSignal = AudioCaptureStopSignal()
        val captureAecActive = captureStartAdmission.run(
          aec = captureAecRequest,
          startCapture = {
            activeStreamId = streamId
            activeCaptureGeneration = captureGeneration
            record = audioRecord
            stopSignal = captureStopSignal
            audioRecord.startRecording()
          },
          activateAec = {
            activeAec = AcousticEchoCanceler.create(audioRecord.audioSessionId)?.also { it.enabled = true }
            activeNoiseSuppressor = NoiseSuppressor.create(audioRecord.audioSessionId)?.also { it.enabled = true }
            activeAec?.enabled == true
          },
        ).aecActive
        emitAudioSessionEvent(
          "capabilities_changed",
          mapOf(
            "aecAvailable" to captureAecAvailable,
            "aecActive" to captureAecActive
          )
        )
        val readBuffer = ByteArray(bufferSize)
        val accumulator = ByteArrayOutputStream()

        val t = Thread {
          fun reportTerminal(reason: String) {
            // Explicit stop claims the signal first, so a read unblocked by
            // stop/release cannot become a capture failure event.
            if (!captureStopSignal.claimTerminal()) return
            try {
              sendEvent(
                "captureTerminal",
                mapOf(
                  "streamId" to streamId,
                  "generation" to captureGeneration,
                  "reason" to reason
                )
              )
            } catch (_: Throwable) {
              // JS is unavailable; there is no remaining event consumer.
            }
          }

          try {
            while (!captureStopSignal.isStopRequested()) {
              val read = audioRecord.read(readBuffer, 0, readBuffer.size)
              val terminalReason = captureTerminalReasonForReadResult(read)
              if (terminalReason != null) {
                reportTerminal(terminalReason)
                break
              }
              if (read == 0) continue
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
            reportTerminal("read_error")
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

    AsyncFunction("startPlayback") { params: Map<String, Any> ->
      return@AsyncFunction startPlayback(params)
    }

    Function("enqueuePlayback") { params: Map<String, Any> ->
      return@Function enqueuePlayback(params)
    }

    Function("clearPlayback") { params: Map<String, Any> ->
      val streamId = params["streamId"] as? String ?: ""
      val generation = (params["generation"] as? Number)?.toInt() ?: 0
      clearPlayback(streamId, generation)
    }

    Function("setPlaybackGain") { params: Map<String, Any> ->
      val streamId = params["streamId"] as? String ?: ""
      val generation = (params["generation"] as? Number)?.toInt() ?: 0
      val gain = (params["gain"] as? Number)?.toDouble() ?: -1.0
      setPlaybackGain(streamId, generation, gain)
    }

    Function("getPlaybackCursorMs") { params: Map<String, Any> ->
      val streamId = params["streamId"] as? String ?: ""
      val generation = (params["generation"] as? Number)?.toInt() ?: 0
      playbackCursorMs(streamId, generation)
    }

    AsyncFunction("stopPlayback") { params: Map<String, Any> ->
      val streamId = params["streamId"] as? String ?: ""
      val generation = (params["generation"] as? Number)?.toInt() ?: 0
      stopActivePlayback(streamId, generation)
    }
  }

  private fun stopActive() {
    stopActivePlayback()
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
    activeCaptureGeneration = 0
  }
}
