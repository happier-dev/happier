import ExpoModulesCore

import AVFoundation
import Foundation
import UIKit

private enum AudioCaptureAecRequest {
  case off
  case preferred
  case required
}

/// Result of an `AVAudioEngineConfigurationChange` for one capture session.
private enum AudioGraphConfigurationOutcome {
  /// No engine is attached to this session, so there is no graph to judge.
  case inactive
  /// The graph is running against the same input hardware format it was built
  /// against, so the installed tap and the attached player remain valid.
  case intact
  /// The graph cannot be resumed without being rebuilt against a format this
  /// owner has not proven, so it is dead.
  case unrecoverable
}

/// The tap and converter bind the complete hardware stream description, not
/// only its rate and channel count. Reusing that graph after any format-layout
/// change is unproven and must fail closed.
private func audioFormatsMatchForGraphRestart(
  _ current: AVAudioFormat,
  _ baseline: AVAudioFormat
) -> Bool {
  guard
    let currentDescription = current.streamDescription?.pointee,
    let baselineDescription = baseline.streamDescription?.pointee
  else { return false }
  return currentDescription.mSampleRate == baselineDescription.mSampleRate
    && currentDescription.mFormatID == baselineDescription.mFormatID
    && currentDescription.mFormatFlags == baselineDescription.mFormatFlags
    && currentDescription.mBytesPerPacket == baselineDescription.mBytesPerPacket
    && currentDescription.mFramesPerPacket == baselineDescription.mFramesPerPacket
    && currentDescription.mBytesPerFrame == baselineDescription.mBytesPerFrame
    && currentDescription.mChannelsPerFrame == baselineDescription.mChannelsPerFrame
    && currentDescription.mBitsPerChannel == baselineDescription.mBitsPerChannel
}

private final class AudioStreamSession {
  private let queue: DispatchQueue
  private let emitFrame: (_ event: [String: Any]) -> Void
  private let emitCaptureTerminal: (_ event: [String: Any]) -> Void
  private let emitPlaybackEvent: (_ eventName: String, _ event: [String: Any]) -> Void

  let streamId: String
  let generation: Int
  let sampleRate: Double
  let channels: Int
  let frameBytes: Int

  private var engine: AVAudioEngine?
  private var player: AVAudioPlayerNode?
  /// The input node's hardware format at the moment the tap and the player
  /// connection were built. It is the only thing that makes a later restart of
  /// this same graph provably safe.
  private var builtInputFormat: AVAudioFormat?
  private var accumulated = Data()
  private var playbackFormat: AVAudioFormat?
  private var playbackGeneration: Int?
  private var playbackChannels = 0
  private var maxPlaybackFrames = 0
  private var queuedPlaybackFrames = 0
  private var playbackActive = false
  private var playbackEpoch = 0
  private var playbackCursorBaseMs = 0.0
  private var playbackTimelineCursorMs = 0.0
  private var captureConversionFailed = false

  init(
    queue: DispatchQueue,
    emitFrame: @escaping (_ event: [String: Any]) -> Void,
    emitCaptureTerminal: @escaping (_ event: [String: Any]) -> Void,
    emitPlaybackEvent: @escaping (_ eventName: String, _ event: [String: Any]) -> Void,
    streamId: String,
    generation: Int,
    sampleRate: Double,
    channels: Int,
    frameBytes: Int
  ) {
    self.queue = queue
    self.emitFrame = emitFrame
    self.emitCaptureTerminal = emitCaptureTerminal
    self.emitPlaybackEvent = emitPlaybackEvent
    self.streamId = streamId
    self.generation = generation
    self.sampleRate = sampleRate
    self.channels = channels
    self.frameBytes = frameBytes
  }

  func start(frameMs: Int, aecRequest: AudioCaptureAecRequest) throws -> Bool {
    let engine = AVAudioEngine()
    let input = engine.inputNode
    let player = AVAudioPlayerNode()
    var aecActive = false

    switch aecRequest {
    case .off:
      break
    case .preferred:
      if #available(iOS 13.0, *) {
        do {
          try input.setVoiceProcessingEnabled(true)
          aecActive = input.isVoiceProcessingEnabled
        } catch {
          // Preferred echo cancellation remains observable as inactive, while
          // capture continues through the canonical session owner.
          aecActive = false
        }
      }
    case .required:
      if #available(iOS 13.0, *) {
        do {
          try input.setVoiceProcessingEnabled(true)
          aecActive = input.isVoiceProcessingEnabled
        } catch {
          aecActive = false
        }
        if !aecActive {
          throw NSError(
            domain: "HappierAudioStreamNative",
            code: 101,
            userInfo: [NSLocalizedDescriptionKey: "aec_unavailable"]
          )
        }
      } else {
        throw NSError(
          domain: "HappierAudioStreamNative",
          code: 101,
          userInfo: [NSLocalizedDescriptionKey: "aec_unavailable"]
        )
      }
    }

    let hardwareInputFormat = input.outputFormat(forBus: 0)
    guard hardwareInputFormat.sampleRate > 0, hardwareInputFormat.channelCount > 0 else {
      throw NSError(domain: "HappierAudioStreamNative", code: 100, userInfo: [NSLocalizedDescriptionKey: "invalid_hardware_audio_format"])
    }
    guard
      let canonicalCaptureFormat = AVAudioFormat(
        commonFormat: .pcmFormatInt16,
        sampleRate: sampleRate,
        channels: AVAudioChannelCount(channels),
        interleaved: true
      ),
      let captureConverter = AVAudioConverter(from: hardwareInputFormat, to: canonicalCaptureFormat)
    else {
      throw NSError(domain: "HappierAudioStreamNative", code: 100, userInfo: [NSLocalizedDescriptionKey: "invalid_audio_format"])
    }

    let hardwareFramesPerBuffer = max(
      256,
      Int(hardwareInputFormat.sampleRate * Double(frameMs) / 1000.0)
    )
    input.installTap(
      onBus: 0,
      bufferSize: AVAudioFrameCount(hardwareFramesPerBuffer),
      format: hardwareInputFormat
    ) { [weak self] buffer, _ in
      guard let self else { return }
      let outputCapacity = max(
        1,
        Int(ceil(Double(buffer.frameLength) * canonicalCaptureFormat.sampleRate / hardwareInputFormat.sampleRate)) + 32
      )
      guard let converted = AVAudioPCMBuffer(
        pcmFormat: canonicalCaptureFormat,
        frameCapacity: AVAudioFrameCount(outputCapacity)
      ) else { return }
      var suppliedInput = false
      var conversionError: NSError?
      let status = captureConverter.convert(to: converted, error: &conversionError) { _, inputStatus in
        if suppliedInput {
          inputStatus.pointee = .noDataNow
          return nil
        }
        suppliedInput = true
        inputStatus.pointee = .haveData
        return buffer
      }
      guard status != .error, conversionError == nil else {
        self.queue.async {
          guard !self.captureConversionFailed else { return }
          self.captureConversionFailed = true
          self.emitCaptureTerminal([
            "streamId": self.streamId,
            "generation": self.generation,
            "reason": "read_error",
          ])
        }
        return
      }
      guard let mData = converted.audioBufferList.pointee.mBuffers.mData else { return }

      let byteSize = Int(converted.audioBufferList.pointee.mBuffers.mDataByteSize)
      if byteSize <= 0 { return }

      let bytes = Data(bytes: mData, count: byteSize)
      self.queue.async {
        self.accumulated.append(bytes)

        while self.accumulated.count >= self.frameBytes {
          let chunk = self.accumulated.prefix(self.frameBytes)
          self.accumulated.removeFirst(self.frameBytes)
          self.emitFrame([
            "streamId": self.streamId,
            "pcm16leBase64": Data(chunk).base64EncodedString(),
            "sampleRate": Int(self.sampleRate),
            "channels": self.channels,
          ])
        }
      }
    }

    do {
      // PCM output is attached before the one engine starts. It therefore uses
      // the same AVAudioSession, route, and lifecycle as native capture.
      engine.attach(player)
      engine.connect(player, to: engine.mainMixerNode, format: nil)
      try engine.start()
      self.engine = engine
      self.player = player
      self.builtInputFormat = hardwareInputFormat
      self.captureConversionFailed = false
    } catch {
      input.removeTap(onBus: 0)
      player.stop()
      engine.detach(player)
      engine.stop()
      self.accumulated.removeAll(keepingCapacity: false)
      throw error
    }
    return aecActive
  }

  func stop() {
    guard let engine else { return }
    playbackEpoch += 1
    playbackActive = false
    playbackGeneration = nil
    playbackChannels = 0
    queuedPlaybackFrames = 0
    maxPlaybackFrames = 0
    playbackFormat = nil
    playbackCursorBaseMs = 0
    playbackTimelineCursorMs = 0
    player?.stop()
    if let player {
      engine.detach(player)
    }
    player = nil
    engine.inputNode.removeTap(onBus: 0)
    engine.stop()
    self.engine = nil
    self.builtInputFormat = nil
    self.captureConversionFailed = false
    self.accumulated.removeAll(keepingCapacity: false)
  }

  /// AVAudioEngine stops itself when its I/O configuration changes, and the
  /// installed tap plus the attached player node stay valid only while the
  /// input hardware format is unchanged. Restarting that same graph is the only
  /// recovery this owner performs; it never rebuilds a graph against a format
  /// it has not observed working.
  func handleConfigurationChange() -> AudioGraphConfigurationOutcome {
    guard let engine else { return .inactive }
    guard let baseline = builtInputFormat else { return .unrecoverable }
    let current = engine.inputNode.outputFormat(forBus: 0)
    guard audioFormatsMatchForGraphRestart(current, baseline) else { return .unrecoverable }
    if engine.isRunning { return .intact }
    do {
      try engine.start()
    } catch {
      return .unrecoverable
    }
    return engine.isRunning ? .intact : .unrecoverable
  }

  private func matchesPlayback(streamId: String, generation: Int) -> Bool {
    return self.streamId == streamId
      && self.generation == generation
      && playbackActive
      && playbackGeneration == generation
  }

  private func refreshPlaybackTimelineCursor() {
    guard
      let player,
      let renderTime = player.lastRenderTime,
      let playerTime = player.playerTime(forNodeTime: renderTime),
      playerTime.sampleRate > 0
    else { return }
    let milliseconds = Double(playerTime.sampleTime) * 1_000 / playerTime.sampleRate
    guard milliseconds.isFinite else { return }
    playbackTimelineCursorMs = max(playbackTimelineCursorMs, max(0, milliseconds))
  }

  private func freezePlaybackTimelineCursor() {
    refreshPlaybackTimelineCursor()
    playbackCursorBaseMs += playbackTimelineCursorMs
    playbackTimelineCursorMs = 0
  }

  func playbackCursorMs(streamId: String, generation: Int) -> Double {
    guard matchesPlayback(streamId: streamId, generation: generation) else { return 0 }
    refreshPlaybackTimelineCursor()
    return max(0, playbackCursorBaseMs + playbackTimelineCursorMs)
  }

  private func emitPlaybackDrained(generation: Int) {
    emitPlaybackEvent("playbackDrained", [
      "streamId": streamId,
      "generation": generation,
    ])
  }

  private func emitPlaybackLevel(_ level: Double, generation: Int) {
    emitPlaybackEvent("playbackLevel", [
      "streamId": streamId,
      "generation": generation,
      "level": max(0, min(1, level)),
    ])
  }

  private func terminatePlayback(reason: String, generation: Int) {
    guard matchesPlayback(streamId: streamId, generation: generation) else { return }
    freezePlaybackTimelineCursor()
    playbackEpoch += 1
    playbackActive = false
    playbackGeneration = nil
    playbackChannels = 0
    queuedPlaybackFrames = 0
    player?.stop()
    emitPlaybackEvent("playbackTerminal", [
      "streamId": streamId,
      "generation": generation,
      "reason": reason,
    ])
  }

  func startPlayback(
    streamId: String,
    generation: Int,
    sampleRate: Double,
    channels: Int,
    maxBufferedMs: Int
  ) throws {
    guard self.streamId == streamId, self.generation == generation else {
      throw NSError(domain: "HappierAudioStreamNative", code: 301, userInfo: [NSLocalizedDescriptionKey: "playback_capture_mismatch"])
    }
    guard !playbackActive else {
      throw NSError(domain: "HappierAudioStreamNative", code: 302, userInfo: [NSLocalizedDescriptionKey: "playback_already_active"])
    }
    guard sampleRate > 0, (channels == 1 || channels == 2), maxBufferedMs > 0 else {
      throw NSError(domain: "HappierAudioStreamNative", code: 303, userInfo: [NSLocalizedDescriptionKey: "invalid_playback_format"])
    }
    guard let player, engine != nil else {
      throw NSError(domain: "HappierAudioStreamNative", code: 304, userInfo: [NSLocalizedDescriptionKey: "playback_engine_unavailable"])
    }
    guard let format = AVAudioFormat(
      commonFormat: .pcmFormatInt16,
      sampleRate: sampleRate,
      channels: AVAudioChannelCount(channels),
      interleaved: true
    ) else {
      throw NSError(domain: "HappierAudioStreamNative", code: 305, userInfo: [NSLocalizedDescriptionKey: "invalid_playback_format"])
    }
    let requestedFrames = (sampleRate * Double(maxBufferedMs) / 1_000.0).rounded(.up)
    guard requestedFrames > 0, requestedFrames <= Double(Int.max) else {
      throw NSError(domain: "HappierAudioStreamNative", code: 306, userInfo: [NSLocalizedDescriptionKey: "invalid_playback_buffer"])
    }
    playbackFormat = format
    // Give the player the provider's canonical PCM format explicitly. The
    // engine's main mixer owns conversion from that format to the current
    // output route; provider PCM is never scheduled against an implicit stale
    // hardware format.
    engine?.disconnectNodeOutput(player)
    if let engine {
      engine.connect(player, to: engine.mainMixerNode, format: format)
    }
    playbackGeneration = generation
    playbackChannels = channels
    maxPlaybackFrames = Int(requestedFrames)
    queuedPlaybackFrames = 0
    playbackActive = true
    playbackEpoch += 1
    player.volume = 1
  }

  func enqueuePlayback(streamId: String, generation: Int, pcm16leBase64: String) -> [String: Any] {
    guard matchesPlayback(streamId: streamId, generation: generation), let format = playbackFormat else {
      return ["accepted": false, "level": 0]
    }
    guard let data = Data(base64Encoded: pcm16leBase64), !data.isEmpty else {
      terminatePlayback(reason: "write_error", generation: generation)
      return ["accepted": false, "level": 0]
    }
    let bytesPerFrame = playbackChannels * 2
    guard data.count % bytesPerFrame == 0 else {
      terminatePlayback(reason: "write_error", generation: generation)
      return ["accepted": false, "level": 0]
    }
    let frameCount = data.count / bytesPerFrame
    guard frameCount > 0, frameCount <= maxPlaybackFrames - queuedPlaybackFrames else {
      return ["accepted": false, "level": 0]
    }
    guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frameCount)) else {
      terminatePlayback(reason: "player_error", generation: generation)
      return ["accepted": false, "level": 0]
    }
    buffer.frameLength = AVAudioFrameCount(frameCount)
    guard let destination = buffer.audioBufferList.pointee.mBuffers.mData else {
      terminatePlayback(reason: "player_error", generation: generation)
      return ["accepted": false, "level": 0]
    }
    data.withUnsafeBytes { bytes in
      guard let source = bytes.baseAddress else { return }
      destination.copyMemory(from: source, byteCount: data.count)
    }
    var energy = 0.0
    var sampleOffset = 0
    while sampleOffset < data.count {
      let low = UInt16(data[sampleOffset])
      let high = UInt16(data[sampleOffset + 1]) << 8
      let sample = Int16(bitPattern: low | high)
      let normalized = Double(sample) / (sample < 0 ? 32_768.0 : 32_767.0)
      energy += normalized * normalized
      sampleOffset += 2
    }
    let level = min(1, sqrt(energy / Double(max(1, data.count / 2))))
    let epoch = playbackEpoch
    queuedPlaybackFrames += frameCount
    player?.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { [weak self] _ in
      guard let self else { return }
      self.queue.async {
        guard self.playbackEpoch == epoch, self.matchesPlayback(streamId: streamId, generation: generation) else { return }
        self.refreshPlaybackTimelineCursor()
        self.queuedPlaybackFrames = max(0, self.queuedPlaybackFrames - frameCount)
        if self.queuedPlaybackFrames == 0 {
          self.player?.pause()
          self.emitPlaybackLevel(0, generation: generation)
          self.emitPlaybackDrained(generation: generation)
        }
      }
    }
    if player?.isPlaying != true {
      player?.play()
    }
    return ["accepted": true, "level": level]
  }

  func clearPlayback(streamId: String, generation: Int) {
    guard matchesPlayback(streamId: streamId, generation: generation) else { return }
    freezePlaybackTimelineCursor()
    playbackEpoch += 1
    queuedPlaybackFrames = 0
    player?.stop()
    emitPlaybackLevel(0, generation: generation)
    emitPlaybackDrained(generation: generation)
  }

  func setPlaybackGain(streamId: String, generation: Int, gain: Double) {
    guard matchesPlayback(streamId: streamId, generation: generation), gain.isFinite, gain >= 0, gain <= 1 else { return }
    player?.volume = Float(gain)
  }

  func stopPlayback(streamId: String, generation: Int) {
    guard matchesPlayback(streamId: streamId, generation: generation) else { return }
    freezePlaybackTimelineCursor()
    playbackEpoch += 1
    playbackActive = false
    playbackGeneration = nil
    playbackChannels = 0
    queuedPlaybackFrames = 0
    maxPlaybackFrames = 0
    playbackFormat = nil
    player?.stop()
  }
}

private struct PreviousAudioSessionState {
  let category: AVAudioSession.Category
  let mode: AVAudioSession.Mode
  let options: AVAudioSession.CategoryOptions
  let preferredSampleRate: Double
}

private final class EncodedAudioPlaybackSession: NSObject, AVAudioPlayerDelegate {
  let playbackId: String
  private let player: AVAudioPlayer
  private let emit: (_ status: String, _ reason: String?) -> Void
  private var pausedByInterruption = false

  init(
    playbackId: String,
    url: URL,
    emit: @escaping (_ status: String, _ reason: String?) -> Void
  ) throws {
    self.playbackId = playbackId
    self.player = try AVAudioPlayer(contentsOf: url)
    self.emit = emit
    super.init()
    self.player.delegate = self
    guard self.player.prepareToPlay() else {
      throw NSError(
        domain: "HappierAudioStreamNative",
        code: 401,
        userInfo: [NSLocalizedDescriptionKey: "encoded_audio_prepare_failed"]
      )
    }
  }

  func start() throws {
    guard player.play() else {
      throw NSError(
        domain: "HappierAudioStreamNative",
        code: 402,
        userInfo: [NSLocalizedDescriptionKey: "encoded_audio_start_failed"]
      )
    }
    emit("started", nil)
  }

  func setPaused(_ paused: Bool) throws {
    pausedByInterruption = false
    if paused {
      player.pause()
    } else if !player.isPlaying {
      guard player.play() else {
        throw NSError(
          domain: "HappierAudioStreamNative",
          code: 402,
          userInfo: [NSLocalizedDescriptionKey: "encoded_audio_resume_failed"]
        )
      }
    }
  }

  func suspendForInterruption() {
    guard player.isPlaying else { return }
    player.pause()
    pausedByInterruption = true
  }

  func resumeAfterInterruption() -> Bool {
    guard pausedByInterruption else { return true }
    pausedByInterruption = false
    return player.play()
  }

  func stop() {
    pausedByInterruption = false
    player.stop()
    player.delegate = nil
  }

  func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
    emit(flag ? "finished" : "failed", flag ? nil : "encoded_audio_decode_failed")
  }

  func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
    emit("failed", error?.localizedDescription ?? "encoded_audio_decode_failed")
  }
}

public final class HappierAudioStreamNativeModule: Module {
  private let queue = DispatchQueue(label: "dev.happier.audioStream", qos: .userInitiated)
  private var active: AudioStreamSession? = nil
  private var fileRecorder: AVAudioRecorder? = nil
  private var fileRecordingId: String? = nil
  private var fileRecordingMuted = false
  private var fileRecordingPausedByInterruption = false
  private var encodedPlayback: EncodedAudioPlaybackSession? = nil
  private var audioSessionGeneration: Int = 0
  private var audioSessionConfigured = false
  private var captureAecRequest: AudioCaptureAecRequest = .off
  private var previousAudioSessionState: PreviousAudioSessionState? = nil
  private var notificationObservers: [NSObjectProtocol] = []
  /// One terminal report per audio-session generation. A dead graph produces a
  /// burst of notifications, and repeating the terminal event would race the
  /// lifecycle owner already tearing the session down.
  private var audioGraphTerminalReported = false

  private func retireEncodedPlayback(status: String? = nil, reason: String? = nil) {
    guard let playback = encodedPlayback else { return }
    encodedPlayback = nil
    playback.stop()
    guard let status else { return }
    var event: [String: Any] = ["playbackId": playback.playbackId, "status": status]
    if let reason { event["reason"] = reason }
    sendEvent("encodedAudioPlayback", event)
  }

  private func emitAudioSessionEvent(_ event: [String: Any], generation: Int? = nil) {
    var payload = event
    payload["generation"] = generation ?? self.audioSessionGeneration
    self.sendEvent("voiceAudioSessionEvent", payload)
  }

  private func currentRouteName() -> String? {
    AVAudioSession.sharedInstance().currentRoute.outputs.first?.portType.rawValue
  }

  /// Ends the native graph and tells the canonical lifecycle owner once. Every
  /// caller runs on `queue`, so this serializes against start/stop/playback.
  private func reportAudioGraphTerminal(reason: String, generation: Int) {
    guard
      audioSessionConfigured,
      generation == audioSessionGeneration,
      !audioGraphTerminalReported
    else { return }
    audioGraphTerminalReported = true
    active?.stop()
    active = nil
    fileRecorder?.stop()
    fileRecorder = nil
    fileRecordingId = nil
    fileRecordingMuted = false
    fileRecordingPausedByInterruption = false
    retireEncodedPlayback(status: "failed", reason: reason)
    emitAudioSessionEvent(["kind": "audio_graph_terminal", "reason": reason], generation: generation)
  }

  private func handleEngineConfigurationChange(generation: Int) {
    queue.async { [weak self] in
      guard let self, generation == self.audioSessionGeneration else { return }
      // Ordinary route changes reach here too. Only a graph this owner cannot
      // resume is fatal; a resumed one keeps the session running untouched.
      switch self.active?.handleConfigurationChange() ?? .inactive {
      case .inactive, .intact:
        return
      case .unrecoverable:
        self.reportAudioGraphTerminal(reason: "configuration_unrecoverable", generation: generation)
      }
    }
  }

  private func handleMediaServicesReset(generation: Int) {
    queue.async { [weak self] in
      guard let self, generation == self.audioSessionGeneration else { return }
      // A media-server reset invalidates every AVAudioSession and engine object,
      // including the pre-session state captured to restore later. Restoring a
      // category onto a session the system already reset is not a restoration.
      self.previousAudioSessionState = nil
      self.fileRecorder?.stop()
      self.fileRecorder = nil
      self.fileRecordingId = nil
      self.fileRecordingMuted = false
      self.fileRecordingPausedByInterruption = false
      self.retireEncodedPlayback(status: "failed", reason: "media_services_reset")
      self.reportAudioGraphTerminal(reason: "media_services_reset", generation: generation)
    }
  }

  private func handleInterruptionBegan(generation: Int) {
    queue.async { [weak self] in
      guard let self, generation == self.audioSessionGeneration else { return }
      if let recorder = self.fileRecorder, recorder.isRecording, !self.fileRecordingMuted {
        recorder.pause()
        self.fileRecordingPausedByInterruption = true
      }
      self.encodedPlayback?.suspendForInterruption()
      self.emitAudioSessionEvent(["kind": "interruption_began"], generation: generation)
    }
  }

  private func handleInterruptionEnded(generation: Int, shouldResume: Bool) {
    queue.async { [weak self] in
      guard let self, generation == self.audioSessionGeneration else { return }
      var resumed = shouldResume
      if shouldResume {
        do {
          try AVAudioSession.sharedInstance().setActive(true, options: [])
        } catch {
          resumed = false
        }
        if resumed, self.fileRecordingPausedByInterruption, !self.fileRecordingMuted,
           let recorder = self.fileRecorder {
          guard recorder.record() else {
            self.fileRecordingPausedByInterruption = false
            self.reportAudioGraphTerminal(reason: "recording_resume_failed", generation: generation)
            self.emitAudioSessionEvent(["kind": "interruption_ended", "shouldResume": false], generation: generation)
            return
          }
          self.fileRecordingPausedByInterruption = false
        }
        if resumed, let encodedPlayback = self.encodedPlayback {
          if !encodedPlayback.resumeAfterInterruption() {
            self.retireEncodedPlayback(status: "failed", reason: "encoded_audio_resume_failed")
            resumed = false
          }
        }
        if resumed {
          switch self.active?.handleConfigurationChange() ?? .inactive {
          case .inactive, .intact:
            break
          case .unrecoverable:
            resumed = false
            self.reportAudioGraphTerminal(reason: "interruption_resume_failed", generation: generation)
          }
        }
      }
      self.emitAudioSessionEvent([
        "kind": "interruption_ended",
        "shouldResume": resumed,
      ], generation: generation)
    }
  }

  private func installNotificationObservers(generation: Int) {
    removeNotificationObservers()
    let center = NotificationCenter.default
    notificationObservers.append(center.addObserver(
      forName: AVAudioSession.interruptionNotification,
      object: nil,
      queue: nil
    ) { [weak self] notification in
      guard let self else { return }
      let rawType = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
      let type = rawType.flatMap(AVAudioSession.InterruptionType.init(rawValue:))
      if type == .began {
        self.handleInterruptionBegan(generation: generation)
      } else if type == .ended {
        let rawOptions = notification.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0
        let shouldResume = AVAudioSession.InterruptionOptions(rawValue: rawOptions).contains(.shouldResume)
        self.handleInterruptionEnded(generation: generation, shouldResume: shouldResume)
      }
    })
    notificationObservers.append(center.addObserver(
      forName: AVAudioSession.routeChangeNotification,
      object: nil,
      queue: nil
    ) { [weak self] _ in
      guard let self else { return }
      self.emitAudioSessionEvent(["kind": "route_changed", "route": self.currentRouteName() ?? "unknown"], generation: generation)
    })
    notificationObservers.append(center.addObserver(
      forName: UIApplication.didEnterBackgroundNotification,
      object: nil,
      queue: nil
    ) { [weak self] _ in
      self?.emitAudioSessionEvent(["kind": "lifecycle_changed", "state": "background"], generation: generation)
    })
    notificationObservers.append(center.addObserver(
      forName: UIApplication.willEnterForegroundNotification,
      object: nil,
      queue: nil
    ) { [weak self] _ in
      self?.emitAudioSessionEvent(["kind": "lifecycle_changed", "state": "foreground"], generation: generation)
    })
    // AVAudioEngine stops itself on an I/O configuration change. Without this
    // the module keeps reporting an active stream while no audio flows.
    notificationObservers.append(center.addObserver(
      forName: .AVAudioEngineConfigurationChange,
      object: nil,
      queue: nil
    ) { [weak self] _ in
      self?.handleEngineConfigurationChange(generation: generation)
    })
    notificationObservers.append(center.addObserver(
      forName: AVAudioSession.mediaServicesWereLostNotification,
      object: nil,
      queue: nil
    ) { [weak self] _ in
      self?.handleMediaServicesReset(generation: generation)
    })
    notificationObservers.append(center.addObserver(
      forName: AVAudioSession.mediaServicesWereResetNotification,
      object: nil,
      queue: nil
    ) { [weak self] _ in
      self?.handleMediaServicesReset(generation: generation)
    })
  }

  private func removeNotificationObservers() {
    let center = NotificationCenter.default
    notificationObservers.forEach { center.removeObserver($0) }
    notificationObservers.removeAll()
  }

  private func configureAudioSession(_ params: [String: Any]) throws -> [String: Any] {
    let generation = (params["generation"] as? Int) ?? 0
    guard let configuration = params["configuration"] as? [String: Any] else {
      throw NSError(domain: "HappierAudioStreamNative", code: 201, userInfo: [NSLocalizedDescriptionKey: "configuration_required"])
    }
    let mode = (configuration["mode"] as? String) ?? "dictation"
    let input = (configuration["input"] as? Bool) ?? true
    let output = (configuration["output"] as? Bool) ?? false
    let aec = (configuration["aec"] as? String) ?? "off"
    let session = AVAudioSession.sharedInstance()
    if previousAudioSessionState == nil {
      previousAudioSessionState = PreviousAudioSessionState(
        category: session.category,
        mode: session.mode,
        options: session.categoryOptions,
        preferredSampleRate: session.preferredSampleRate
      )
    }

    let category: AVAudioSession.Category
    let sessionMode: AVAudioSession.Mode
    let options: AVAudioSession.CategoryOptions
    switch mode {
    case "conversation":
      category = .playAndRecord
      sessionMode = .voiceChat
      options = [.allowBluetooth, .defaultToSpeaker]
    case "playback" where !input:
      category = .playback
      sessionMode = .default
      options = []
    default:
      category = output ? .playAndRecord : .record
      sessionMode = .measurement
      options = output ? [.allowBluetooth] : []
    }

    try session.setCategory(category, mode: sessionMode, options: options)
    try session.setActive(true, options: [])
    audioSessionGeneration = generation
    audioSessionConfigured = true
    audioGraphTerminalReported = false
    let aecAvailable: Bool
    if #available(iOS 13.0, *) { aecAvailable = true } else { aecAvailable = false }
    if mode == "conversation" {
      switch aec {
      case "required": captureAecRequest = .required
      case "preferred": captureAecRequest = .preferred
      default: captureAecRequest = .off
      }
    } else {
      captureAecRequest = .off
    }
    installNotificationObservers(generation: generation)
    return [
      "generation": generation,
      "aecAvailable": aecAvailable,
      "aecActive": false,
      "route": currentRouteName() ?? "unknown",
    ]
  }

  private func restoreAudioSession(_ generation: Int) throws {
    guard generation >= audioSessionGeneration else { return }
    let wasConfigured = audioSessionConfigured
    active?.stop()
    active = nil
    fileRecorder?.stop()
    fileRecorder = nil
    fileRecordingId = nil
    fileRecordingMuted = false
    fileRecordingPausedByInterruption = false
    retireEncodedPlayback()
    let session = AVAudioSession.sharedInstance()
    if let previous = previousAudioSessionState {
      try session.setCategory(previous.category, mode: previous.mode, options: previous.options)
      try session.setPreferredSampleRate(previous.preferredSampleRate)
    }
    try session.setActive(false, options: [.notifyOthersOnDeactivation])
    previousAudioSessionState = nil
    audioSessionGeneration = generation
    audioSessionConfigured = false
    audioGraphTerminalReported = false
    captureAecRequest = .off
    removeNotificationObservers()
    if wasConfigured {
      emitAudioSessionEvent(["kind": "restoration_completed"])
    }
  }

  public func definition() -> ModuleDefinition {
    Name("HappierAudioStreamNative")

    Events(
      "audioFrame",
      "captureTerminal",
      "playbackDrained",
      "playbackLevel",
      "playbackTerminal",
      "encodedAudioPlayback",
      "voiceAudioSessionEvent"
    )

    OnDestroy {
      self.queue.sync {
        self.active?.stop()
        self.active = nil
        self.fileRecorder?.stop()
        self.fileRecorder = nil
        self.fileRecordingId = nil
        self.fileRecordingMuted = false
        self.fileRecordingPausedByInterruption = false
        self.retireEncodedPlayback()
        try? self.restoreAudioSession(self.audioSessionGeneration + 1)
      }
    }

    AsyncFunction("configureAudioSession") { (params: [String: Any]) -> [String: Any] in
      return try self.queue.sync { try self.configureAudioSession(params) }
    }

    AsyncFunction("restoreAudioSession") { (params: [String: Any]) -> Void in
      let generation = (params["generation"] as? Int) ?? 0
      try self.queue.sync { try self.restoreAudioSession(generation) }
    }

    AsyncFunction("startFileRecording") { (params: [String: Any]) -> [String: String] in
      return try self.queue.sync {
        guard self.audioSessionConfigured else {
          throw NSError(domain: "HappierAudioStreamNative", code: 403, userInfo: [NSLocalizedDescriptionKey: "audio_session_not_configured"])
        }
        guard self.fileRecorder == nil else {
          throw NSError(domain: "HappierAudioStreamNative", code: 404, userInfo: [NSLocalizedDescriptionKey: "file_recording_already_active"])
        }
        guard (params["format"] as? String) == "m4a" else {
          throw NSError(domain: "HappierAudioStreamNative", code: 405, userInfo: [NSLocalizedDescriptionKey: "unsupported_recording_format"])
        }
        let recordingId = UUID().uuidString
        let url = FileManager.default.temporaryDirectory
          .appendingPathComponent("happier-voice-\(recordingId)")
          .appendingPathExtension("m4a")
        let recorder = try AVAudioRecorder(url: url, settings: [
          AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
          AVSampleRateKey: 44_100,
          AVNumberOfChannelsKey: 2,
          AVEncoderBitRateKey: 128_000,
          AVEncoderAudioQualityKey: AVAudioQuality.high.rawValue,
        ])
        guard recorder.prepareToRecord(), recorder.record() else {
          throw NSError(domain: "HappierAudioStreamNative", code: 406, userInfo: [NSLocalizedDescriptionKey: "file_recording_start_failed"])
        }
        self.fileRecorder = recorder
        self.fileRecordingId = recordingId
        self.fileRecordingMuted = false
        self.fileRecordingPausedByInterruption = false
        return ["recordingId": recordingId]
      }
    }

    AsyncFunction("setFileRecordingMuted") { (params: [String: Any]) -> Void in
      let recordingId = (params["recordingId"] as? String) ?? ""
      let muted = (params["muted"] as? Bool) ?? false
      try self.queue.sync {
        guard recordingId == self.fileRecordingId, let recorder = self.fileRecorder else { return }
        if muted {
          recorder.pause()
          self.fileRecordingMuted = true
          self.fileRecordingPausedByInterruption = false
        } else {
          guard recorder.record() else {
            throw NSError(domain: "HappierAudioStreamNative", code: 406, userInfo: [NSLocalizedDescriptionKey: "file_recording_resume_failed"])
          }
          self.fileRecordingMuted = false
          self.fileRecordingPausedByInterruption = false
        }
      }
    }

    AsyncFunction("stopFileRecording") { (params: [String: Any]) -> [String: String] in
      let recordingId = (params["recordingId"] as? String) ?? ""
      return try self.queue.sync {
        guard recordingId == self.fileRecordingId, let recorder = self.fileRecorder else {
          throw NSError(domain: "HappierAudioStreamNative", code: 407, userInfo: [NSLocalizedDescriptionKey: "file_recording_not_active"])
        }
        self.fileRecorder = nil
        self.fileRecordingId = nil
        self.fileRecordingMuted = false
        self.fileRecordingPausedByInterruption = false
        recorder.stop()
        return ["uri": recorder.url.absoluteString]
      }
    }

    AsyncFunction("startEncodedAudioPlayback") { (params: [String: Any]) -> Void in
      let playbackId = (params["playbackId"] as? String) ?? ""
      let uri = (params["uri"] as? String) ?? ""
      try self.queue.sync {
        guard self.audioSessionConfigured else {
          throw NSError(domain: "HappierAudioStreamNative", code: 408, userInfo: [NSLocalizedDescriptionKey: "audio_session_not_configured"])
        }
        guard !playbackId.isEmpty, let url = URL(string: uri), url.isFileURL else {
          throw NSError(domain: "HappierAudioStreamNative", code: 409, userInfo: [NSLocalizedDescriptionKey: "invalid_encoded_audio_uri"])
        }
        self.retireEncodedPlayback(status: "replaced", reason: "encoded_audio_replaced")
        let playback = try EncodedAudioPlaybackSession(
          playbackId: playbackId,
          url: url,
          emit: { [weak self] status, reason in
            self?.queue.async { [weak self] in
              guard let self, self.encodedPlayback?.playbackId == playbackId else { return }
              var event: [String: Any] = ["playbackId": playbackId, "status": status]
              if let reason { event["reason"] = reason }
              self.sendEvent("encodedAudioPlayback", event)
              if status != "started" { self.encodedPlayback = nil }
            }
          }
        )
        self.encodedPlayback = playback
        do {
          try playback.start()
        } catch {
          playback.stop()
          self.encodedPlayback = nil
          throw error
        }
      }
    }

    AsyncFunction("setEncodedAudioPlaybackPaused") { (params: [String: Any]) -> Void in
      let playbackId = (params["playbackId"] as? String) ?? ""
      let paused = (params["paused"] as? Bool) ?? false
      try self.queue.sync {
        guard self.encodedPlayback?.playbackId == playbackId else { return }
        try self.encodedPlayback?.setPaused(paused)
      }
    }

    AsyncFunction("stopEncodedAudioPlayback") { (params: [String: Any]) -> Void in
      let playbackId = (params["playbackId"] as? String) ?? ""
      self.queue.sync {
        guard self.encodedPlayback?.playbackId == playbackId else { return }
        self.retireEncodedPlayback()
      }
    }

    AsyncFunction("start") { (params: [String: Any]) -> [String: String] in
      let sampleRate = (params["sampleRate"] as? Double) ?? 16000
      let channels = (params["channels"] as? Int) ?? 1
      let frameMs = (params["frameMs"] as? Int) ?? 50
      let captureGeneration = (params["generation"] as? Int) ?? 0

      if sampleRate <= 0 { throw NSError(domain: "HappierAudioStreamNative", code: 1, userInfo: [NSLocalizedDescriptionKey: "sampleRate must be > 0"]) }
      if channels != 1 && channels != 2 { throw NSError(domain: "HappierAudioStreamNative", code: 2, userInfo: [NSLocalizedDescriptionKey: "channels must be 1 or 2"]) }
      if frameMs <= 0 { throw NSError(domain: "HappierAudioStreamNative", code: 3, userInfo: [NSLocalizedDescriptionKey: "frameMs must be > 0"]) }

      return try self.queue.sync {
        guard self.audioSessionConfigured else {
          throw NSError(
            domain: "HappierAudioStreamNative",
            code: 202,
            userInfo: [NSLocalizedDescriptionKey: "audio_session_not_configured"]
          )
        }
        self.active?.stop()
        self.active = nil
        let aecAvailable: Bool
        if #available(iOS 13.0, *) { aecAvailable = true } else { aecAvailable = false }
        do {
          try AVAudioSession.sharedInstance().setPreferredSampleRate(sampleRate)

          let streamId = UUID().uuidString
          let bytesPerFrame = channels * 2
          let frameBytes = Int(sampleRate * Double(frameMs) / 1000.0) * bytesPerFrame

          let session = AudioStreamSession(
            queue: self.queue,
            emitFrame: { event in
              self.sendEvent("audioFrame", event)
            },
            emitCaptureTerminal: { event in
              self.sendEvent("captureTerminal", event)
            },
            emitPlaybackEvent: { eventName, event in
              self.sendEvent(eventName, event)
            },
            streamId: streamId,
            generation: captureGeneration,
            sampleRate: sampleRate,
            channels: channels,
            frameBytes: max(1, frameBytes)
          )

          let aecActive = try session.start(
            frameMs: frameMs,
            aecRequest: self.captureAecRequest
          )
          self.active = session
          self.emitAudioSessionEvent([
            "kind": "capabilities_changed",
            "aecAvailable": aecAvailable,
            "aecActive": aecActive,
          ])
          return ["streamId": streamId]
        } catch {
          self.emitAudioSessionEvent([
            "kind": "capabilities_changed",
            "aecAvailable": aecAvailable,
            "aecActive": false,
          ])
          self.active?.stop()
          self.active = nil
          throw error
        }
      }
    }

    AsyncFunction("stop") { (params: [String: Any]) -> Void in
      let streamId = (params["streamId"] as? String) ?? ""
      if streamId.isEmpty { return }

      self.queue.sync {
        guard let current = self.active, current.streamId == streamId else { return }
        current.stop()
        self.active = nil
      }
    }

    AsyncFunction("startPlayback") { (params: [String: Any]) -> [String: Any] in
      let streamId = (params["streamId"] as? String) ?? ""
      let generation = (params["generation"] as? Int) ?? 0
      let sampleRate = (params["sampleRate"] as? Double) ?? 0
      let channels = (params["channels"] as? Int) ?? 0
      let maxBufferedMs = (params["maxBufferedMs"] as? Int) ?? 0
      if streamId.isEmpty || generation <= 0 {
        throw NSError(domain: "HappierAudioStreamNative", code: 307, userInfo: [NSLocalizedDescriptionKey: "playback_capture_mismatch"])
      }
      return try self.queue.sync {
        guard let current = self.active else {
          throw NSError(domain: "HappierAudioStreamNative", code: 308, userInfo: [NSLocalizedDescriptionKey: "playback_capture_unavailable"])
        }
        try current.startPlayback(
          streamId: streamId,
          generation: generation,
          sampleRate: sampleRate,
          channels: channels,
          maxBufferedMs: maxBufferedMs
        )
        return ["streamId": streamId, "generation": generation]
      }
    }

    Function("enqueuePlayback") { (params: [String: Any]) -> [String: Any] in
      let streamId = (params["streamId"] as? String) ?? ""
      let generation = (params["generation"] as? Int) ?? 0
      let pcm16leBase64 = (params["pcm16leBase64"] as? String) ?? ""
      return self.queue.sync {
        guard let current = self.active else { return ["accepted": false, "level": 0] }
        return current.enqueuePlayback(
          streamId: streamId,
          generation: generation,
          pcm16leBase64: pcm16leBase64
        )
      }
    }

    Function("clearPlayback") { (params: [String: Any]) -> Void in
      let streamId = (params["streamId"] as? String) ?? ""
      let generation = (params["generation"] as? Int) ?? 0
      self.queue.sync {
        self.active?.clearPlayback(streamId: streamId, generation: generation)
      }
    }

    Function("setPlaybackGain") { (params: [String: Any]) -> Void in
      let streamId = (params["streamId"] as? String) ?? ""
      let generation = (params["generation"] as? Int) ?? 0
      let gain = (params["gain"] as? Double) ?? -1
      self.queue.sync {
        self.active?.setPlaybackGain(streamId: streamId, generation: generation, gain: gain)
      }
    }

    Function("getPlaybackCursorMs") { (params: [String: Any]) -> Double in
      let streamId = (params["streamId"] as? String) ?? ""
      let generation = (params["generation"] as? Int) ?? 0
      return self.queue.sync {
        self.active?.playbackCursorMs(streamId: streamId, generation: generation) ?? 0
      }
    }

    AsyncFunction("stopPlayback") { (params: [String: Any]) -> Void in
      let streamId = (params["streamId"] as? String) ?? ""
      let generation = (params["generation"] as? Int) ?? 0
      self.queue.sync {
        self.active?.stopPlayback(streamId: streamId, generation: generation)
      }
    }
  }
}
