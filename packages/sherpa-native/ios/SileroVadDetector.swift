import Foundation

final class SileroVadDetector: FrameFedVadDetector {
  private let lock = NSLock()
  private var inner: HappierSherpaSileroVadDetector?

  init(modelPath: String, sampleRate: Int32, minSpeechSec: Float, minSilenceSec: Float) throws {
    let d = try HappierSherpaSileroVadDetector(
      modelPath: modelPath,
      sampleRate: sampleRate,
      minSpeechSec: minSpeechSec,
      minSilenceSec: minSilenceSec
    )
    inner = d
  }

  func acceptPcm16(data: Data, sampleRate: Int32, channels: Int32) throws -> FrameFedVadDetection {
    guard sampleRate == 16_000 else {
      throw NSError(domain: "HappierSherpaNative", code: 414, userInfo: [NSLocalizedDescriptionKey: "VAD expects 16000 Hz PCM"])
    }
    guard channels > 0, data.count.isMultiple(of: 2) else {
      throw NSError(domain: "HappierSherpaNative", code: 415, userInfo: [NSLocalizedDescriptionKey: "VAD expects complete PCM16 samples"])
    }

    let channelCount = Int(channels)
    let rawSampleCount = data.count / 2
    guard rawSampleCount >= channelCount else {
      return FrameFedVadDetection(speechDetected: false, speechEnded: false)
    }

    var samples = [Float]()
    samples.reserveCapacity(rawSampleCount / channelCount)
    data.withUnsafeBytes { bytes in
      let raw = bytes.bindMemory(to: UInt8.self)
      var frameIndex = 0
      while frameIndex + channelCount <= rawSampleCount {
        var sum: Float = 0
        for channel in 0..<channelCount {
          let sampleIndex = frameIndex + channel
          let byteIndex = sampleIndex * 2
          let bits = UInt16(raw[byteIndex]) | (UInt16(raw[byteIndex + 1]) << 8)
          sum += Float(Int16(bitPattern: bits)) / 32768.0
        }
        samples.append(sum / Float(channelCount))
        frameIndex += channelCount
      }
    }

    lock.lock()
    defer { lock.unlock() }
    guard let inner else {
      throw NSError(domain: "HappierSherpaNative", code: 416, userInfo: [NSLocalizedDescriptionKey: "VAD detector is closed"])
    }
    var speechDetected = ObjCBool(false)
    let speechEnded = samples.withUnsafeBufferPointer { buffer -> Bool in
      guard let baseAddress = buffer.baseAddress else { return false }
      return inner.acceptWaveform(baseAddress, count: Int32(buffer.count), speechDetected: &speechDetected)
    }
    return FrameFedVadDetection(speechDetected: speechDetected.boolValue, speechEnded: speechEnded)
  }

  func close() {
    lock.lock()
    defer { lock.unlock() }
    inner?.close()
    inner = nil
  }
}

private final class HappierSherpaNativeBundleLocator: NSObject {}

enum VadModelResolver {
  static func resolveSileroVadModelPath() throws -> String {
    // Model is shipped via a CocoaPods resource bundle.
    let owning = Bundle(for: HappierSherpaNativeBundleLocator.self)
    if let url = owning.url(forResource: "silero_vad_v5", withExtension: "onnx") {
      return url.path
    }

    if let bundleURL = owning.url(forResource: "HappierSherpaNativeResources", withExtension: "bundle"),
       let bundle = Bundle(url: bundleURL),
       let url = bundle.url(forResource: "silero_vad_v5", withExtension: "onnx") {
      return url.path
    }

    throw NSError(domain: "HappierSherpaNative", code: 413, userInfo: [NSLocalizedDescriptionKey: "silero_vad_v5.onnx resource not found"])
  }
}
