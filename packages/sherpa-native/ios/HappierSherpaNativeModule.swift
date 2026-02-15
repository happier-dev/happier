import ExpoModulesCore

import Foundation

public class HappierSherpaNativeModule: Module {
  private let queue = DispatchQueue(label: "dev.happier.sherpa", qos: .userInitiated)
  private var engines: [String: HappierSherpaOfflineTtsEngine] = [:]
  private var asrEngines: [String: HappierSherpaOnlineAsrEngine] = [:]
  private var asrStreams: [String: HappierSherpaOnlineAsrStream] = [:]

  private func getEngine(assetsDir: String) throws -> HappierSherpaOfflineTtsEngine {
    if let cached = engines[assetsDir] {
      return cached
    }

    var err: NSError?
    if let engine = HappierSherpaOfflineTtsEngine(assetsDir: assetsDir, error: &err) {
      engines[assetsDir] = engine
      return engine
    }

    throw err ?? NSError(domain: "HappierSherpaNative", code: 100, userInfo: [NSLocalizedDescriptionKey: "Failed to initialize engine"])
  }

  private func getAsrEngine(assetsDir: String, language: String?) throws -> HappierSherpaOnlineAsrEngine {
    let langKey = (language ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    let key = "\(assetsDir)|\(langKey)"
    if let cached = asrEngines[key] { return cached }

    var err: NSError?
    if let engine = HappierSherpaOnlineAsrEngine(assetsDir: assetsDir, sampleRate: 16000, language: langKey.isEmpty ? nil : langKey, error: &err) {
      asrEngines[key] = engine
      return engine
    }

    throw err ?? NSError(domain: "HappierSherpaNative", code: 300, userInfo: [NSLocalizedDescriptionKey: "Failed to initialize ASR engine"])
  }

  public func definition() -> ModuleDefinition {
    Name("HappierSherpaNative")

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

      return try self.queue.sync {
        let engine = try self.getEngine(assetsDir: assetsDir)
        var err: NSError?
        let ok = engine.synthesizeToWavFile(atPath: outWavPath, text: text, sid: Int32(sid), speed: Float(speed), jobId: jobId, error: &err)
        if !ok {
          throw err ?? NSError(domain: "HappierSherpaNative", code: 107, userInfo: [NSLocalizedDescriptionKey: "Synthesis failed"])
        }
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
        var err: NSError?
        guard let stream = engine.createStreamWithError(&err) else {
          throw err ?? NSError(domain: "HappierSherpaNative", code: 303, userInfo: [NSLocalizedDescriptionKey: "Failed to create ASR stream"])
        }
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
  }
}
