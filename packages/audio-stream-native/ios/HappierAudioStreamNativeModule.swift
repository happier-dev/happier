import ExpoModulesCore

import AVFoundation
import Foundation

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

  func start(frameMs: Int) throws {
    let session = AVAudioSession.sharedInstance()
    try session.setCategory(.playAndRecord, mode: .measurement, options: [.allowBluetooth])
    try session.setPreferredSampleRate(sampleRate)
    try session.setActive(true, options: [])

    let engine = AVAudioEngine()
    let input = engine.inputNode

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

    try engine.start()
    self.engine = engine
  }

  func stop() {
    guard let engine else { return }
    engine.inputNode.removeTap(onBus: 0)
    engine.stop()
    self.engine = nil
    self.accumulated.removeAll(keepingCapacity: false)

    do {
      try AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
    } catch {
      // best-effort
    }
  }
}

public final class HappierAudioStreamNativeModule: Module {
  private let queue = DispatchQueue(label: "dev.happier.audioStream", qos: .userInitiated)
  private var active: AudioStreamSession? = nil

  public func definition() -> ModuleDefinition {
    Name("HappierAudioStreamNative")

    Events("audioFrame")

    AsyncFunction("start") { (params: [String: Any]) -> [String: String] in
      let sampleRate = (params["sampleRate"] as? Double) ?? 16000
      let channels = (params["channels"] as? Int) ?? 1
      let frameMs = (params["frameMs"] as? Int) ?? 50

      if sampleRate <= 0 { throw NSError(domain: "HappierAudioStreamNative", code: 1, userInfo: [NSLocalizedDescriptionKey: "sampleRate must be > 0"]) }
      if channels != 1 && channels != 2 { throw NSError(domain: "HappierAudioStreamNative", code: 2, userInfo: [NSLocalizedDescriptionKey: "channels must be 1 or 2"]) }
      if frameMs <= 0 { throw NSError(domain: "HappierAudioStreamNative", code: 3, userInfo: [NSLocalizedDescriptionKey: "frameMs must be > 0"]) }

      return try self.queue.sync {
        self.active?.stop()
        self.active = nil

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

        try session.start(frameMs: frameMs)
        self.active = session
        return ["streamId": streamId]
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
