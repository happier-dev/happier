import AVFoundation
import Foundation

protocol VadAudioSessionControlling {
  func setCategory(
    _ category: AVAudioSession.Category,
    mode: AVAudioSession.Mode,
    options: AVAudioSession.CategoryOptions
  ) throws

  func setPreferredSampleRate(_ sampleRate: Double) throws

  func setActive(_ active: Bool, options: AVAudioSession.SetActiveOptions) throws
}

protocol VadAudioInputNodeControlling {
  func outputFormat(forBus bus: AVAudioNodeBus) -> AVAudioFormat

  func installTap(
    onBus bus: AVAudioNodeBus,
    bufferSize: AVAudioFrameCount,
    format: AVAudioFormat?,
    block: @escaping AVAudioNodeTapBlock
  )

  func removeTap(onBus bus: AVAudioNodeBus)
}

protocol VadAudioEngineControlling {
  var inputNode: VadAudioInputNodeControlling { get }

  func start() throws

  func stop()
}

final class AvAudioEngineVadAudioCapture: VadAudioCapture {
  private let targetSampleRate: Double
  private let targetChannels: AVAudioChannelCount
  private let audioSession: VadAudioSessionControlling
  private let makeAudioEngine: () -> VadAudioEngineControlling

  private let lock = NSLock()
  private var engine: VadAudioEngineControlling?
  private var inputFormat: AVAudioFormat?
  private var outputFormat: AVAudioFormat?
  private var converter: AVAudioConverter?
  private var isStopped: Bool = false

  init(
    targetSampleRate: Double = 16_000,
    targetChannels: AVAudioChannelCount = 1,
    audioSession: VadAudioSessionControlling = SharedAvAudioSessionController(),
    makeAudioEngine: @escaping () -> VadAudioEngineControlling = { AvAudioEngineController() }
  ) {
    self.targetSampleRate = targetSampleRate
    self.targetChannels = targetChannels
    self.audioSession = audioSession
    self.makeAudioEngine = makeAudioEngine
  }

  func start(onSamples: @escaping (UnsafePointer<Float>, Int32) -> Void) throws {
    lock.lock()
    if engine != nil {
      lock.unlock()
      return
    }
    isStopped = false
    lock.unlock()

    try audioSession.setCategory(.playAndRecord, mode: .measurement, options: [.allowBluetooth])
    try audioSession.setPreferredSampleRate(targetSampleRate)
    try audioSession.setActive(true, options: [])
    do {
      let audioEngine = makeAudioEngine()
      let inputNode = audioEngine.inputNode
      let inFormat = inputNode.outputFormat(forBus: 0)

      guard let outFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: targetSampleRate, channels: targetChannels, interleaved: false) else {
        throw NSError(domain: "HappierSherpaNative", code: 402, userInfo: [NSLocalizedDescriptionKey: "Failed to create VAD output audio format"])
      }

      guard let converter = AVAudioConverter(from: inFormat, to: outFormat) else {
        throw NSError(domain: "HappierSherpaNative", code: 403, userInfo: [NSLocalizedDescriptionKey: "Failed to create VAD audio converter"])
      }

      lock.lock()
      self.engine = audioEngine
      self.inputFormat = inFormat
      self.outputFormat = outFormat
      self.converter = converter
      lock.unlock()

      inputNode.installTap(onBus: 0, bufferSize: 2048, format: inFormat) { [weak self] buffer, _ in
        guard let self else { return }
        self.lock.lock()
        let stopped = self.isStopped
        let converter = self.converter
        let outFormat = self.outputFormat
        self.lock.unlock()
        if stopped { return }
        guard let converter, let outFormat else { return }

        // Convert to 16kHz mono float32 for sherpa VAD.
        let ratio = outFormat.sampleRate / buffer.format.sampleRate
        let outFrames = max(1, Int(ceil(Double(buffer.frameLength) * ratio)))
        guard let outBuffer = AVAudioPCMBuffer(pcmFormat: outFormat, frameCapacity: AVAudioFrameCount(outFrames)) else { return }

        var error: NSError?
        var didProvideInput = false
        converter.convert(to: outBuffer, error: &error) { _, outStatus in
          if didProvideInput {
            outStatus.pointee = .noDataNow
            return nil
          }
          didProvideInput = true
          outStatus.pointee = .haveData
          return buffer
        }
        if error != nil { return }

        guard let channelData = outBuffer.floatChannelData else { return }
        let samples = channelData[0]
        let count = Int32(outBuffer.frameLength)
        if count <= 0 { return }

        onSamples(samples, count)
      }

      try audioEngine.start()
    } catch {
      lock.lock()
      let engine = self.engine
      self.engine = nil
      self.converter = nil
      self.inputFormat = nil
      self.outputFormat = nil
      isStopped = true
      lock.unlock()
      engine?.inputNode.removeTap(onBus: 0)
      deactivateAudioSession()
      throw error
    }
  }

  func stop() {
    lock.lock()
    isStopped = true
    let engine = self.engine
    self.engine = nil
    self.converter = nil
    self.inputFormat = nil
    self.outputFormat = nil
    lock.unlock()

    guard let engine else { return }
    engine.inputNode.removeTap(onBus: 0)
    engine.stop()
    deactivateAudioSession()
  }

  private func deactivateAudioSession() {
    do {
      try audioSession.setActive(false, options: [.notifyOthersOnDeactivation])
    } catch {
      // best-effort
    }
  }
}

private final class SharedAvAudioSessionController: VadAudioSessionControlling {
  private let audioSession = AVAudioSession.sharedInstance()

  func setCategory(
    _ category: AVAudioSession.Category,
    mode: AVAudioSession.Mode,
    options: AVAudioSession.CategoryOptions
  ) throws {
    try audioSession.setCategory(category, mode: mode, options: options)
  }

  func setPreferredSampleRate(_ sampleRate: Double) throws {
    try audioSession.setPreferredSampleRate(sampleRate)
  }

  func setActive(_ active: Bool, options: AVAudioSession.SetActiveOptions) throws {
    try audioSession.setActive(active, options: options)
  }
}

private final class AvAudioEngineController: VadAudioEngineControlling {
  private let audioEngine = AVAudioEngine()
  lazy var inputNode: VadAudioInputNodeControlling = AvAudioInputNodeController(inputNode: audioEngine.inputNode)

  func start() throws {
    try audioEngine.start()
  }

  func stop() {
    audioEngine.stop()
  }
}

private final class AvAudioInputNodeController: VadAudioInputNodeControlling {
  private let inputNode: AVAudioInputNode

  init(inputNode: AVAudioInputNode) {
    self.inputNode = inputNode
  }

  func outputFormat(forBus bus: AVAudioNodeBus) -> AVAudioFormat {
    inputNode.outputFormat(forBus: bus)
  }

  func installTap(
    onBus bus: AVAudioNodeBus,
    bufferSize: AVAudioFrameCount,
    format: AVAudioFormat?,
    block: @escaping AVAudioNodeTapBlock
  ) {
    inputNode.installTap(onBus: bus, bufferSize: bufferSize, format: format, block: block)
  }

  func removeTap(onBus bus: AVAudioNodeBus) {
    inputNode.removeTap(onBus: bus)
  }
}
