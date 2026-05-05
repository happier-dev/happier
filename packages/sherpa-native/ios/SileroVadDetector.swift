import Foundation

final class SileroVadDetector: VadDetector {
  private let lock = NSLock()
  private var inner: HappierSherpaSileroVadDetector?

  init(modelPath: String, sampleRate: Int32, minSpeechSec: Float, minSilenceSec: Float) throws {
    var err: NSError?
    guard let d = HappierSherpaSileroVadDetector(
      modelPath: modelPath,
      sampleRate: sampleRate,
      minSpeechSec: minSpeechSec,
      minSilenceSec: minSilenceSec,
      error: &err
    ) else {
      throw err ?? NSError(domain: "HappierSherpaNative", code: 412, userInfo: [NSLocalizedDescriptionKey: "Failed to create SileroVadDetector"])
    }
    inner = d
  }

  func acceptWaveform(samples: UnsafePointer<Float>, count: Int32) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    guard let inner else { return false }
    return inner.acceptWaveform(samples, count: count)
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
