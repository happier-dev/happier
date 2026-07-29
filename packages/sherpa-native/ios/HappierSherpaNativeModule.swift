import ExpoModulesCore

import Foundation

public class HappierSherpaNativeModule: Module {
  private let queue = DispatchQueue(label: "dev.happier.sherpa", qos: .userInitiated)
  // Offline TTS synthesis runs on its own serial queue so that a `cancel`
  // dispatched on `queue` can flip the engine's atomic cancel flag mid-synthesis.
  // If synthesis ran on `queue`, the serial queue could not service the async
  // cancel until synthesis finished, making cancellation a no-op.
  private let synthQueue = DispatchQueue(label: "dev.happier.sherpa.synthesis", qos: .userInitiated)
  private var engines: [String: HappierSherpaOfflineTtsEngine] = [:]
  private var asrEngines: [String: HappierSherpaOnlineAsrEngine] = [:]
  private var asrStreams: [String: HappierSherpaOnlineAsrStream] = [:]
  private lazy var vadDetectors = FrameFedVadDetectorRegistry { sampleRate, minSpeechSec, minSilenceSec in
    let modelPath = try VadModelResolver.resolveSileroVadModelPath()
    return try SileroVadDetector(
      modelPath: modelPath,
      sampleRate: sampleRate,
      minSpeechSec: minSpeechSec,
      minSilenceSec: minSilenceSec
    )
  }

  private func handleModuleDestroy() {
    vadDetectors.cancelAll()
  }

  private func getEngine(assetsDir: String) throws -> HappierSherpaOfflineTtsEngine {
    if let cached = engines[assetsDir] {
      return cached
    }

    let engine = try HappierSherpaOfflineTtsEngine(assetsDir: assetsDir)
    engines[assetsDir] = engine
    return engine
  }

  private func getAsrEngine(assetsDir: String, language: String?) throws -> HappierSherpaOnlineAsrEngine {
    let langKey = (language ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    let key = "\(assetsDir)|\(langKey)"
    if let cached = asrEngines[key] { return cached }

    let engine = try HappierSherpaOnlineAsrEngine(assetsDir: assetsDir, sampleRate: 16000, language: langKey.isEmpty ? nil : langKey)
    asrEngines[key] = engine
    return engine
  }

  public func definition() -> ModuleDefinition {
    Name("HappierSherpaNative")
    OnDestroy {
      self.handleModuleDestroy()
    }

    AsyncFunction("initialize") { (params: [String: Any]) in
      let assetsDir = (params["assetsDir"] as? String) ?? ""
      if assetsDir.isEmpty {
        throw NSError(domain: "HappierSherpaNative", code: 101, userInfo: [NSLocalizedDescriptionKey: "assetsDir is required"])
      }
      try self.queue.sync {
        _ = try self.getEngine(assetsDir: assetsDir)
      }
    }

    AsyncFunction("listVoices") { (params: [String: Any]) -> [[String: Any]] in
      let assetsDir = (params["assetsDir"] as? String) ?? ""
      if assetsDir.isEmpty {
        throw NSError(domain: "HappierSherpaNative", code: 102, userInfo: [NSLocalizedDescriptionKey: "assetsDir is required"])
      }

      return try self.queue.sync {
        let engine = try self.getEngine(assetsDir: assetsDir)
        let n = Int(engine.numSpeakers())
        if n <= 0 { return [] }
        return (0..<n).map { i in
          [
            "id": "sid:\(i)",
            "title": "Speaker \(i)",
            "sid": i,
          ]
        }
      }
    }

    AsyncFunction("synthesizeToWavFile") { (params: [String: Any]) -> [String: Any] in
      let jobId = (params["jobId"] as? String) ?? ""
      let assetsDir = (params["assetsDir"] as? String) ?? ""
      let text = (params["text"] as? String) ?? ""
      let sid = (params["sid"] as? Int) ?? 0
      let speed = (params["speed"] as? Double) ?? 1.0
      let outWavPath = (params["outWavPath"] as? String) ?? ""

      if jobId.isEmpty { throw NSError(domain: "HappierSherpaNative", code: 103, userInfo: [NSLocalizedDescriptionKey: "jobId is required"]) }
      if assetsDir.isEmpty { throw NSError(domain: "HappierSherpaNative", code: 104, userInfo: [NSLocalizedDescriptionKey: "assetsDir is required"]) }
      if text.isEmpty { throw NSError(domain: "HappierSherpaNative", code: 105, userInfo: [NSLocalizedDescriptionKey: "text is required"]) }
      if outWavPath.isEmpty { throw NSError(domain: "HappierSherpaNative", code: 106, userInfo: [NSLocalizedDescriptionKey: "outWavPath is required"]) }

      // Resolve/create the engine under the shared-state queue, but run the
      // (potentially multi-second) synthesis on the dedicated synth queue so a
      // concurrent `cancel` dispatched on `queue` can flip the atomic cancel flag.
      let engine = try self.queue.sync {
        try self.getEngine(assetsDir: assetsDir)
      }
      return try self.synthQueue.sync {
        try engine.synthesizeToWavFile(atPath: outWavPath, text: text, sid: Int32(sid), speed: Float(speed), jobId: jobId)
        return [
          "wavPath": outWavPath,
          "sampleRate": Int(engine.sampleRate()),
        ]
      }
    }

    AsyncFunction("cancel") { (params: [String: Any]) in
      let jobId = (params["jobId"] as? String) ?? ""
      if jobId.isEmpty { return }
      self.queue.async {
        for (_, engine) in self.engines {
          engine.cancelJob(jobId)
        }
        if let stream = self.asrStreams[jobId] {
          stream.cancel()
          self.asrStreams.removeValue(forKey: jobId)
        }
      }
    }

    AsyncFunction("createStreamingRecognizer") { (params: [String: Any]) in
      let jobId = (params["jobId"] as? String) ?? ""
      let assetsDir = (params["assetsDir"] as? String) ?? ""
      let language = (params["language"] as? String)

      if jobId.isEmpty { throw NSError(domain: "HappierSherpaNative", code: 301, userInfo: [NSLocalizedDescriptionKey: "jobId is required"]) }
      if assetsDir.isEmpty { throw NSError(domain: "HappierSherpaNative", code: 302, userInfo: [NSLocalizedDescriptionKey: "assetsDir is required"]) }

      try self.queue.sync {
        let engine = try self.getAsrEngine(assetsDir: assetsDir, language: language)
        let stream = try engine.createStream()
        self.asrStreams[jobId] = stream
      }
    }

    AsyncFunction("pushAudioFrame") { (params: [String: Any]) -> [String: Any] in
      let jobId = (params["jobId"] as? String) ?? ""
      let pcm16leBase64 = (params["pcm16leBase64"] as? String) ?? ""
      let sampleRate = (params["sampleRate"] as? Int) ?? 16000
      let channels = (params["channels"] as? Int) ?? 1

      if jobId.isEmpty { throw NSError(domain: "HappierSherpaNative", code: 304, userInfo: [NSLocalizedDescriptionKey: "jobId is required"]) }

      return try self.queue.sync {
        guard let stream = self.asrStreams[jobId] else {
          throw NSError(domain: "HappierSherpaNative", code: 305, userInfo: [NSLocalizedDescriptionKey: "ASR stream not found"])
        }
        guard let data = Data(base64Encoded: pcm16leBase64) else {
          return ["text": "", "isEndpoint": false]
        }
        var err: NSError?
        let result = stream.pushPcm16Data(data, sampleRate: Int32(sampleRate), channels: Int32(channels), error: &err)
        if let err { throw err }
        return result as? [String: Any] ?? ["text": "", "isEndpoint": false]
      }
    }

    AsyncFunction("finishStreaming") { (params: [String: Any]) -> [String: Any] in
      let jobId = (params["jobId"] as? String) ?? ""
      if jobId.isEmpty { throw NSError(domain: "HappierSherpaNative", code: 306, userInfo: [NSLocalizedDescriptionKey: "jobId is required"]) }

      return try self.queue.sync {
        guard let stream = self.asrStreams.removeValue(forKey: jobId) else {
          return ["text": ""]
        }
        var err: NSError?
        let text = stream.finishWithError(&err)
        if let err { throw err }
        return ["text": text]
      }
    }

    AsyncFunction("createVadDetector") { (params: [String: Any]) in
      let detectorId = (params["detectorId"] as? String) ?? ""
      let minSpeechMs = (params["minSpeechMs"] as? Int64) ?? Int64((params["minSpeechMs"] as? Int) ?? 0)
      let redemptionMs = (params["redemptionMs"] as? Int64) ?? Int64((params["redemptionMs"] as? Int) ?? 0)
      let sampleRate = Int32((params["sampleRate"] as? Int) ?? 16_000)

      try self.queue.sync {
        try self.vadDetectors.create(
          detectorId: detectorId,
          sampleRate: sampleRate,
          minSpeechMs: minSpeechMs,
          redemptionMs: redemptionMs
        )
      }
    }

    AsyncFunction("pushVadAudioFrame") { (params: [String: Any]) -> [String: Any] in
      let detectorId = (params["detectorId"] as? String) ?? ""
      let pcm16leBase64 = (params["pcm16leBase64"] as? String) ?? ""
      let sampleRate = Int32((params["sampleRate"] as? Int) ?? 16_000)
      let channels = Int32((params["channels"] as? Int) ?? 1)
      guard let data = Data(base64Encoded: pcm16leBase64) else {
        throw NSError(domain: "HappierSherpaNative", code: 404, userInfo: [NSLocalizedDescriptionKey: "pcm16leBase64 is invalid"])
      }

      return try self.queue.sync {
        let result = try self.vadDetectors.push(
          detectorId: detectorId,
          data: data,
          sampleRate: sampleRate,
          channels: channels
        )
        return [
          "speechStarted": result.speechStarted,
          "speechEnded": result.speechEnded,
        ]
      }
    }

    AsyncFunction("cancelVadDetector") { (params: [String: Any]) in
      let detectorId = (params["detectorId"] as? String) ?? ""
      if detectorId.isEmpty { return }

      self.queue.sync {
        self.vadDetectors.cancel(detectorId: detectorId)
      }
    }
  }
}
