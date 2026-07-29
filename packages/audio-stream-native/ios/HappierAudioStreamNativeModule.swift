import ExpoModulesCore

import AVFoundation
import Foundation
import UIKit

private final class AudioStreamSession {
  private let queue: DispatchQueue
  private let emitFrame: (_ event: [String: Any]) -> Void

  let streamId: String
  let sampleRate: Double
  let channels: Int
  let frameBytes: Int

  private var engine: AVAudioEngine?
  private var accumulated = Data()

  init(
    queue: DispatchQueue,
    emitFrame: @escaping (_ event: [String: Any]) -> Void,
    streamId: String,
    sampleRate: Double,
    channels: Int,
    frameBytes: Int
  ) {
    self.queue = queue
    self.emitFrame = emitFrame
    self.streamId = streamId
    self.sampleRate = sampleRate
    self.channels = channels
    self.frameBytes = frameBytes
  }

  func start(frameMs: Int, voiceProcessingEnabled: Bool) throws {
    let engine = AVAudioEngine()
    let input = engine.inputNode

    if voiceProcessingEnabled {
      if #available(iOS 13.0, *) {
        try input.setVoiceProcessingEnabled(true)
      } else {
        throw NSError(
          domain: "HappierAudioStreamNative",
          code: 101,
          userInfo: [NSLocalizedDescriptionKey: "aec_unavailable"]
        )
      }
    }

    guard
      let format = AVAudioFormat(
        commonFormat: .pcmFormatInt16,
        sampleRate: sampleRate,
        channels: AVAudioChannelCount(channels),
        interleaved: true
      )
    else {
      throw NSError(domain: "HappierAudioStreamNative", code: 100, userInfo: [NSLocalizedDescriptionKey: "invalid_audio_format"])
    }

    let framesPerBuffer = max(256, Int(sampleRate * Double(frameMs) / 1000.0))
    input.installTap(onBus: 0, bufferSize: AVAudioFrameCount(framesPerBuffer), format: format) { [weak self] buffer, _ in
      guard let self else { return }
      guard let mData = buffer.audioBufferList.pointee.mBuffers.mData else { return }

      let byteSize = Int(buffer.audioBufferList.pointee.mBuffers.mDataByteSize)
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
      try engine.start()
      self.engine = engine
    } catch {
      input.removeTap(onBus: 0)
      engine.stop()
      self.accumulated.removeAll(keepingCapacity: false)
      throw error
    }
  }

  func stop() {
    guard let engine else { return }
    engine.inputNode.removeTap(onBus: 0)
    engine.stop()
    self.engine = nil
    self.accumulated.removeAll(keepingCapacity: false)

  }
}

private struct PreviousAudioSessionState {
  let category: AVAudioSession.Category
  let mode: AVAudioSession.Mode
  let options: AVAudioSession.CategoryOptions
  let preferredSampleRate: Double
}

public final class HappierAudioStreamNativeModule: Module {
  private let queue = DispatchQueue(label: "dev.happier.audioStream", qos: .userInitiated)
  private var active: AudioStreamSession? = nil
  private var audioSessionGeneration: Int = 0
  private var audioSessionConfigured = false
  private var voiceProcessingEnabled = false
  private var previousAudioSessionState: PreviousAudioSessionState? = nil
  private var notificationObservers: [NSObjectProtocol] = []

  private func emitAudioSessionEvent(_ event: [String: Any], generation: Int? = nil) {
    var payload = event
    payload["generation"] = generation ?? self.audioSessionGeneration
    self.sendEvent("voiceAudioSessionEvent", payload)
  }

  private func currentRouteName() -> String? {
    AVAudioSession.sharedInstance().currentRoute.outputs.first?.portType.rawValue
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
        self.emitAudioSessionEvent(["kind": "interruption_began"], generation: generation)
      } else if type == .ended {
        let rawOptions = notification.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0
        let shouldResume = AVAudioSession.InterruptionOptions(rawValue: rawOptions).contains(.shouldResume)
        self.emitAudioSessionEvent(["kind": "interruption_ended", "shouldResume": shouldResume], generation: generation)
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
    let aecAvailable: Bool
    if #available(iOS 13.0, *) { aecAvailable = true } else { aecAvailable = false }
    voiceProcessingEnabled = mode == "conversation" && aec != "off" && aecAvailable
    installNotificationObservers(generation: generation)
    return [
      "generation": generation,
      "aecAvailable": aecAvailable,
      "aecActive": voiceProcessingEnabled,
      "route": currentRouteName() ?? "unknown",
    ]
  }

  private func restoreAudioSession(_ generation: Int) throws {
    guard generation >= audioSessionGeneration else { return }
    let wasConfigured = audioSessionConfigured
    active?.stop()
    active = nil
    let session = AVAudioSession.sharedInstance()
    if let previous = previousAudioSessionState {
      try session.setCategory(previous.category, mode: previous.mode, options: previous.options)
      try session.setPreferredSampleRate(previous.preferredSampleRate)
    }
    try session.setActive(false, options: [.notifyOthersOnDeactivation])
    previousAudioSessionState = nil
    audioSessionGeneration = generation
    audioSessionConfigured = false
    voiceProcessingEnabled = false
    removeNotificationObservers()
    if wasConfigured {
      emitAudioSessionEvent(["kind": "restoration_completed"])
    }
  }

  public func definition() -> ModuleDefinition {
    Name("HappierAudioStreamNative")

    Events("audioFrame", "voiceAudioSessionEvent")

    OnDestroy {
      self.queue.sync {
        self.active?.stop()
        self.active = nil
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

    AsyncFunction("start") { (params: [String: Any]) -> [String: String] in
      let sampleRate = (params["sampleRate"] as? Double) ?? 16000
      let channels = (params["channels"] as? Int) ?? 1
      let frameMs = (params["frameMs"] as? Int) ?? 50

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
            streamId: streamId,
            sampleRate: sampleRate,
            channels: channels,
            frameBytes: max(1, frameBytes)
          )

          try session.start(frameMs: frameMs, voiceProcessingEnabled: self.voiceProcessingEnabled)
          self.active = session
          return ["streamId": streamId]
        } catch {
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
  }
}
