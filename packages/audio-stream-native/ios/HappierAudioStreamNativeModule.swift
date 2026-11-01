import ExpoModulesCore

import AVFoundation
import Foundation

private final class AudioStreamSession {
  private let queue: DispatchQueue
  private let emitFrame: (_ event: [String: Any]) -> Void
  private let emitError: (_ event: [String: Any]) -> Void

  let streamId: String
  let sampleRate: Double
  let channels: Int
  let frameBytes: Int

  private var engine: AVAudioEngine?
  private var accumulated = Data()
  private var reportedError = false

  init(
    queue: DispatchQueue,
    emitFrame: @escaping (_ event: [String: Any]) -> Void,
    emitError: @escaping (_ event: [String: Any]) -> Void,
    streamId: String,
    sampleRate: Double,
    channels: Int,
    frameBytes: Int
  ) {
    self.queue = queue
    self.emitFrame = emitFrame
    self.emitError = emitError
    self.streamId = streamId
    self.sampleRate = sampleRate
    self.channels = channels
    self.frameBytes = frameBytes
  }

  func start(frameMs: Int) throws {
    do {
      try startEngine(frameMs: frameMs)
    } catch {
      // Leave no active session behind a failed start: it would keep other apps' audio interrupted.
      try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
      throw error
    }
  }

  // AVAudioConverter can emit a few frames more than the exact rate ratio while its resampler drains.
  private static let convertedFrameSlack: AVAudioFrameCount = 32

  private func startEngine(frameMs: Int) throws {
    let session = AVAudioSession.sharedInstance()
    // Voice turns alternate listening with spoken replies played by other players while this category is
    // still set, so output must default to the speaker rather than the receiver (earpiece).
    // `.default` mode: `.measurement` lowers loudspeaker output, and `.voiceChat` only adds echo cancellation
    // for audio rendered through this engine's voice-processing unit, which spoken replies are not.
    try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetooth, .allowBluetoothA2DP])
    try session.setPreferredSampleRate(sampleRate)
    try session.setActive(true, options: [])

    let engine = AVAudioEngine()
    let input = engine.inputNode

    // An input-node tap must use the hardware format (AVAudioEngine raises an exception otherwise), so
    // capture in that format and convert to the requested PCM16 rate and channel count.
    let hardwareFormat = input.outputFormat(forBus: 0)
    guard hardwareFormat.sampleRate > 0, hardwareFormat.channelCount > 0 else {
      throw NSError(domain: "HappierAudioStreamNative", code: 101, userInfo: [NSLocalizedDescriptionKey: "no_audio_input"])
    }
    guard
      let format = AVAudioFormat(
        commonFormat: .pcmFormatInt16,
        sampleRate: sampleRate,
        channels: AVAudioChannelCount(channels),
        interleaved: true
      ),
      let converter = AVAudioConverter(from: hardwareFormat, to: format)
    else {
      throw NSError(domain: "HappierAudioStreamNative", code: 100, userInfo: [NSLocalizedDescriptionKey: "invalid_audio_format"])
    }

    let framesPerBuffer = max(256, Int(hardwareFormat.sampleRate * Double(frameMs) / 1000.0))
    let rateRatio = sampleRate / hardwareFormat.sampleRate
    input.installTap(onBus: 0, bufferSize: AVAudioFrameCount(framesPerBuffer), format: hardwareFormat) { [weak self] buffer, _ in
      guard let self else { return }
      let capacity = AVAudioFrameCount((Double(buffer.frameLength) * rateRatio).rounded(.up)) + Self.convertedFrameSlack
      guard let converted = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { return }

      // Taps arrive serially, so one converter keeps its resampler state across buffers.
      var supplied = false
      var conversionError: NSError?
      let status = converter.convert(to: converted, error: &conversionError) { _, inputStatus in
        if supplied {
          inputStatus.pointee = .noDataNow
          return nil
        }
        supplied = true
        inputStatus.pointee = .haveData
        return buffer
      }
      if status == .error {
        self.emitErrorOnce(code: "conversion_failed", message: conversionError?.localizedDescription ?? "audio conversion failed")
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
      try engine.start()
    } catch {
      input.removeTap(onBus: 0)
      throw error
    }
    self.engine = engine
  }

  private func emitErrorOnce(code: String, message: String) {
    queue.async {
      if self.reportedError { return }
      self.reportedError = true
      self.emitError([
        "streamId": self.streamId,
        "code": code,
        "message": message,
      ])
    }
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

    Events("audioFrame", "audioError")

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
          emitError: { event in
            self.sendEvent("audioError", event)
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
