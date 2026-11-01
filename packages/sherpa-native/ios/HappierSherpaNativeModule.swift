import ExpoModulesCore

import Foundation

public class HappierSherpaNativeModule: Module {
  // Expo's default AsyncFunction queue is one serial queue shared by every module. Synthesis takes seconds, so
  // TTS and ASR each run on their own queue: cancel, mic frames and other modules never wait behind synthesis.
  private let ttsQueue = DispatchQueue(label: "dev.happier.sherpa.tts", qos: .userInitiated)
  private let asrQueue = DispatchQueue(label: "dev.happier.sherpa.asr", qos: .userInitiated)

  // Touched only on ttsQueue.
  private var engines: [String: HappierSherpaOfflineTtsEngine] = [:]
  // Touched only on asrQueue. A stream retains its engine, so dropping an engine never frees a live recognizer.
  private var asrEngines: [String: HappierSherpaOnlineAsrEngine] = [:]
  private var asrStreams: [String: HappierSherpaOnlineAsrStream] = [:]

  // Callers derive assetsDir from directory URIs that may carry a trailing slash; one dir is one engine.
  private static func normalizeAssetsDir(_ raw: String) -> String {
    var dir = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    while dir.hasSuffix("/") { dir.removeLast() }
    return dir
  }

  // Runs only on ttsQueue, so creation is serialized.
  private func getEngine(assetsDir rawAssetsDir: String) throws -> HappierSherpaOfflineTtsEngine {
    let assetsDir = HappierSherpaNativeModule.normalizeAssetsDir(rawAssetsDir)
    if let cached = engines[assetsDir] {
      return cached
    }

    let engine = try HappierSherpaOfflineTtsEngine(assetsDir: assetsDir)
    engines[assetsDir] = engine
    return engine
  }

  private func asrEngineKey(assetsDir: String, language: String) -> String {
    return "\(assetsDir)|\(language)"
  }

  // Runs only on asrQueue.
  private func getAsrEngine(assetsDir rawAssetsDir: String, language: String?) throws -> HappierSherpaOnlineAsrEngine {
    let assetsDir = HappierSherpaNativeModule.normalizeAssetsDir(rawAssetsDir)
    let langKey = (language ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    let key = asrEngineKey(assetsDir: assetsDir, language: langKey)
    if let cached = asrEngines[key] { return cached }

    let engine = try HappierSherpaOnlineAsrEngine(assetsDir: assetsDir, sampleRate: 16000, language: langKey.isEmpty ? nil : langKey)
    asrEngines[key] = engine
    return engine
  }

  public func definition() -> ModuleDefinition {
    Name("HappierSherpaNative")

    AsyncFunction("initialize") { (params: [String: Any]) in
      let assetsDir = (params["assetsDir"] as? String) ?? ""
      if assetsDir.isEmpty {
        throw NSError(domain: "HappierSherpaNative", code: 101, userInfo: [NSLocalizedDescriptionKey: "assetsDir is required"])
      }
      _ = try self.getEngine(assetsDir: assetsDir)
    }.runOnQueue(self.ttsQueue)

    AsyncFunction("listVoices") { (params: [String: Any]) -> [[String: Any]] in
      let assetsDir = (params["assetsDir"] as? String) ?? ""
      if assetsDir.isEmpty {
        throw NSError(domain: "HappierSherpaNative", code: 102, userInfo: [NSLocalizedDescriptionKey: "assetsDir is required"])
      }

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
    }.runOnQueue(self.ttsQueue)

    AsyncFunction("synthesizeToWavFile") { (params: [String: Any], promise: Promise) in
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

      // Registered here, on Expo's serial function queue, so a later `cancel` call always finds the job even
      // while it waits behind another synthesis on ttsQueue.
      HappierSherpaOfflineTtsEngine.acceptJob(jobId)
      self.ttsQueue.async {
        defer { HappierSherpaOfflineTtsEngine.forgetJob(jobId) }
        do {
          let engine = try self.getEngine(assetsDir: assetsDir)
          try engine.synthesizeToWavFile(atPath: outWavPath, text: text, sid: Int32(sid), speed: Float(speed), jobId: jobId)
          promise.resolve([
            "wavPath": outWavPath,
            "sampleRate": Int(engine.sampleRate()),
          ])
        } catch {
          promise.reject(error)
        }
      }
    }

    AsyncFunction("cancel") { (params: [String: Any]) in
      let jobId = (params["jobId"] as? String) ?? ""
      if jobId.isEmpty { return }
      // TTS: flags an accepted job, queued or running, without waiting behind the synthesis it stops; unknown
      // ids are ignored. Synthesis polls the flag.
      HappierSherpaOfflineTtsEngine.cancelJob(jobId)
      // ASR: cancels the streaming job with this id, if any.
      self.asrQueue.async {
        if let stream = self.asrStreams.removeValue(forKey: jobId) {
          stream.cancel()
        }
      }
    }

    AsyncFunction("release") { (params: [String: Any]) in
      let assetsDir = HappierSherpaNativeModule.normalizeAssetsDir((params["assetsDir"] as? String) ?? "")
      if assetsDir.isEmpty { return }
      // Runs on ttsQueue, so it waits for a synthesis already using the engine.
      self.engines.removeValue(forKey: assetsDir)
      self.asrQueue.sync {
        let prefix = self.asrEngineKey(assetsDir: assetsDir, language: "")
        for key in self.asrEngines.keys where key.hasPrefix(prefix) {
          self.asrEngines.removeValue(forKey: key)
        }
      }
    }.runOnQueue(self.ttsQueue)

    // Model packs live under Documents, which iOS backs up to iCloud by default; they are re-downloadable.
    AsyncFunction("excludeFromBackup") { (params: [String: Any]) in
      let path = (params["path"] as? String) ?? ""
      if path.isEmpty {
        throw NSError(domain: "HappierSherpaNative", code: 107, userInfo: [NSLocalizedDescriptionKey: "path is required"])
      }
      var url = URL(fileURLWithPath: path, isDirectory: true)
      var values = URLResourceValues()
      values.isExcludedFromBackup = true
      try url.setResourceValues(values)
    }

    AsyncFunction("createStreamingRecognizer") { (params: [String: Any]) in
      let jobId = (params["jobId"] as? String) ?? ""
      let assetsDir = (params["assetsDir"] as? String) ?? ""
      let language = (params["language"] as? String)

      if jobId.isEmpty { throw NSError(domain: "HappierSherpaNative", code: 301, userInfo: [NSLocalizedDescriptionKey: "jobId is required"]) }
      if assetsDir.isEmpty { throw NSError(domain: "HappierSherpaNative", code: 302, userInfo: [NSLocalizedDescriptionKey: "assetsDir is required"]) }

      let engine = try self.getAsrEngine(assetsDir: assetsDir, language: language)
      let stream = try engine.createStream()
      self.asrStreams[jobId] = stream
    }.runOnQueue(self.asrQueue)

    AsyncFunction("pushAudioFrame") { (params: [String: Any]) -> [String: Any] in
      let jobId = (params["jobId"] as? String) ?? ""
      let pcm16leBase64 = (params["pcm16leBase64"] as? String) ?? ""
      let sampleRate = (params["sampleRate"] as? Int) ?? 16000
      let channels = (params["channels"] as? Int) ?? 1

      if jobId.isEmpty { throw NSError(domain: "HappierSherpaNative", code: 304, userInfo: [NSLocalizedDescriptionKey: "jobId is required"]) }

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
    }.runOnQueue(self.asrQueue)

    AsyncFunction("finishStreaming") { (params: [String: Any]) -> [String: Any] in
      let jobId = (params["jobId"] as? String) ?? ""
      if jobId.isEmpty { throw NSError(domain: "HappierSherpaNative", code: 306, userInfo: [NSLocalizedDescriptionKey: "jobId is required"]) }

      guard let stream = self.asrStreams.removeValue(forKey: jobId) else {
        return ["text": ""]
      }
      var err: NSError?
      let text = stream.finishWithError(&err)
      if let err { throw err }
      return ["text": text]
    }.runOnQueue(self.asrQueue)
  }
}
