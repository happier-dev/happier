import ExpoModulesCore

import Foundation

public class HappierSherpaNativeModule: Module {
  // Expo dispatches every `AsyncFunction` on one shared *serial* queue
  // (`expo.modules.AsyncFunctionQueue`), so any function that blocks it blocks
  // every other function of every module -- including its own cancellation.
  // Sherpa's synthesis and decode calls are synchronous and multi-second, so
  // they are declared with `.runOnQueue` onto the workers below. Initialization
  // first admits its immutable cache request on Expo's serial control queue,
  // then yields its load to the TTS worker; control functions (`cancel`,
  // `cancelInitialization`, `releaseAssetsDir`,
  // `cancelVadDetector`) stay reachable while native work is in flight.
  //
  // TTS and ASR get one worker each because they run concurrently during a
  // conversation: the assistant is speaking while the microphone stays open for
  // barge-in. Sharing a worker would stall live capture frames behind a
  // multi-second synthesis and trip the capture queue's backpressure guard.
  private let ttsQueue = DispatchQueue(label: "dev.happier.sherpa.tts", qos: .userInitiated)
  private let asrQueue = DispatchQueue(label: "dev.happier.sherpa.asr", qos: .userInitiated)
  // Serializes the VAD detector registry, which is not thread-safe. VAD frames
  // are short, so this stays on the default queue rather than taking a worker.
  private let queue = DispatchQueue(label: "dev.happier.sherpa", qos: .userInitiated)
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
    // Streaming recognizers and offline TTS engines are owned by the process-wide
    // native caches, so they are released here rather than dying with this module.
    HappierSherpaOnlineAsrEngine.releaseAll()
    HappierSherpaOfflineTtsEngine.releaseAll()
    vadDetectors.cancelAll()
  }

  public func definition() -> ModuleDefinition {
    Name("HappierSherpaNative")
    OnDestroy {
      self.handleModuleDestroy()
    }

    AsyncFunction("initialize") { (params: [String: Any], promise: Promise) in
      let assetsDir = (params["assetsDir"] as? String) ?? ""
      if assetsDir.isEmpty {
        throw NSError(domain: "HappierSherpaNative", code: 101, userInfo: [NSLocalizedDescriptionKey: "assetsDir is required"])
      }
      let initializationId = params["initializationId"] as? String
      if let initializationId {
        if initializationId.isEmpty {
          throw NSError(domain: "HappierSherpaNative", code: 108, userInfo: [NSLocalizedDescriptionKey: "initializationId is required"])
        }
        // This non-concurrent AsyncFunction and `cancelInitialization` run on
        // Expo's same serial control queue. Admit before yielding to the TTS
        // worker, so an abort cannot reach the cache before this request exists
        // and can refuse only this queued request without retiring an active
        // same-pack engine.
        guard HappierSherpaOfflineTtsEngine.admitInitialization(assetsDir: assetsDir, admissionId: initializationId) else {
          throw NSError(domain: "HappierSherpaNative", code: 109, userInfo: [NSLocalizedDescriptionKey: "Failed to admit TTS initialization"])
        }
        self.ttsQueue.async {
          do {
            try HappierSherpaOfflineTtsEngine.prepare(assetsDir: assetsDir, admissionId: initializationId)
            promise.resolve()
          } catch {
            promise.reject(error)
          }
        }
      } else {
        // The shipped predecessor sends only `{ assetsDir }`. Keep that ordinary
        // warm-up on the same cache owner; it has no request id to cancel.
        self.ttsQueue.async {
          do {
            try HappierSherpaOfflineTtsEngine.prepare(assetsDir: assetsDir)
            promise.resolve()
          } catch {
            promise.reject(error)
          }
        }
      }
    }

    AsyncFunction("listVoices") { (params: [String: Any]) -> [[String: Any]] in
      let assetsDir = (params["assetsDir"] as? String) ?? ""
      if assetsDir.isEmpty {
        throw NSError(domain: "HappierSherpaNative", code: 102, userInfo: [NSLocalizedDescriptionKey: "assetsDir is required"])
      }

      // `prepare` reports a pack that cannot be loaded; the speaker count itself
      // only distinguishes a loaded engine's 0 speakers from its N.
      try HappierSherpaOfflineTtsEngine.prepare(assetsDir: assetsDir)
      let n = Int(HappierSherpaOfflineTtsEngine.numSpeakers(assetsDir: assetsDir))
      if n <= 0 { return [] }
      return (0..<n).map { i in
        [
          "id": "sid:\(i)",
          "title": "Speaker \(i)",
          "sid": i,
        ]
      }
    }.runOnQueue(ttsQueue)

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

      var sampleRate: Int32 = 0
      try HappierSherpaOfflineTtsEngine.synthesizeToWavFile(
        atPath: outWavPath,
        assetsDir: assetsDir,
        text: text,
        sid: Int32(sid),
        speed: Float(speed),
        jobId: jobId,
        sampleRate: &sampleRate
      )
      return [
        "wavPath": outWavPath,
        "sampleRate": Int(sampleRate),
      ]
    }.runOnQueue(ttsQueue)

    // Left on the default queue on purpose: both registries own their locking, so
    // the mark lands while the workers are still inside a synthesis or a decode.
    AsyncFunction("cancel") { (params: [String: Any]) in
      let jobId = (params["jobId"] as? String) ?? ""
      if jobId.isEmpty { return }
      HappierSherpaOnlineAsrEngine.cancelJob(jobId)
      HappierSherpaOfflineTtsEngine.cancelJob(jobId)
    }

    // This stays on Expo's serial control queue with initialize's admission, so
    // a JS cancellation that follows initialize cannot reach the cache before
    // that request exists. It still runs independently of the TTS worker and
    // only cancels one immutable admission; `releaseAssetsDir` remains pack
    // mutation and teardown.
    AsyncFunction("cancelInitialization") { (params: [String: Any]) in
      let assetsDir = (params["assetsDir"] as? String) ?? ""
      let initializationId = (params["initializationId"] as? String) ?? ""
      if assetsDir.isEmpty { throw NSError(domain: "HappierSherpaNative", code: 109, userInfo: [NSLocalizedDescriptionKey: "assetsDir is required"]) }
      if initializationId.isEmpty { throw NSError(domain: "HappierSherpaNative", code: 110, userInfo: [NSLocalizedDescriptionKey: "initializationId is required"]) }
      HappierSherpaOfflineTtsEngine.cancelInitialization(assetsDir: assetsDir, admissionId: initializationId)
    }

    AsyncFunction("createStreamingRecognizer") { (params: [String: Any]) in
      let jobId = (params["jobId"] as? String) ?? ""
      let assetsDir = (params["assetsDir"] as? String) ?? ""

      if jobId.isEmpty { throw NSError(domain: "HappierSherpaNative", code: 301, userInfo: [NSLocalizedDescriptionKey: "jobId is required"]) }
      if assetsDir.isEmpty { throw NSError(domain: "HappierSherpaNative", code: 302, userInfo: [NSLocalizedDescriptionKey: "assetsDir is required"]) }

      try HappierSherpaOnlineAsrEngine.createStream(forJob: jobId, assetsDir: assetsDir)
    }.runOnQueue(asrQueue)

    AsyncFunction("pushAudioFrame") { (params: [String: Any]) -> [String: Any] in
      let jobId = (params["jobId"] as? String) ?? ""
      let pcm16leBase64 = (params["pcm16leBase64"] as? String) ?? ""
      let sampleRate = (params["sampleRate"] as? Int) ?? 16000
      let channels = (params["channels"] as? Int) ?? 1

      if jobId.isEmpty { throw NSError(domain: "HappierSherpaNative", code: 304, userInfo: [NSLocalizedDescriptionKey: "jobId is required"]) }

      guard let data = Data(base64Encoded: pcm16leBase64) else {
        return ["text": "", "isEndpoint": false]
      }
      var err: NSError?
      let result = HappierSherpaOnlineAsrEngine.pushPcm16Data(data, forJob: jobId, sampleRate: Int32(sampleRate), channels: Int32(channels), error: &err)
      if let err { throw err }
      return result as? [String: Any] ?? ["text": "", "isEndpoint": false]
    }.runOnQueue(asrQueue)

    AsyncFunction("finishStreaming") { (params: [String: Any]) -> [String: Any] in
      let jobId = (params["jobId"] as? String) ?? ""
      if jobId.isEmpty { throw NSError(domain: "HappierSherpaNative", code: 306, userInfo: [NSLocalizedDescriptionKey: "jobId is required"]) }

      return HappierSherpaOnlineAsrEngine.finishJob(jobId) as? [String: Any] ?? ["status": "missing"]
    }.runOnQueue(asrQueue)

    // Left on the default queue on purpose: pack invalidation must preempt the
    // work it is retiring, not queue behind it.
    AsyncFunction("releaseAssetsDir") { (params: [String: Any]) -> [String: Any] in
      let assetsDir = (params["assetsDir"] as? String) ?? ""
      if assetsDir.isEmpty { throw NSError(domain: "HappierSherpaNative", code: 307, userInfo: [NSLocalizedDescriptionKey: "assetsDir is required"]) }

      let cancelledJobs = HappierSherpaOnlineAsrEngine.releaseAssetsDir(assetsDir)
      let releasedEngines = HappierSherpaOfflineTtsEngine.releaseAssetsDir(assetsDir)
      return ["cancelledJobs": Int(cancelledJobs), "releasedEngines": Int(releasedEngines)]
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
