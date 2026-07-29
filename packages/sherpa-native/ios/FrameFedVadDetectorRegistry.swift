import Foundation

struct FrameFedVadDetection {
  let speechDetected: Bool
  let speechEnded: Bool
}

protocol FrameFedVadDetector: AnyObject {
  func acceptPcm16(data: Data, sampleRate: Int32, channels: Int32) throws -> FrameFedVadDetection
  func close()
}

struct FrameFedVadFrameResult {
  let speechStarted: Bool
  let speechEnded: Bool
}

/// Owns inference-only VAD detectors. Microphone and audio-session ownership
/// deliberately remain outside this package in audio-stream-native.
final class FrameFedVadDetectorRegistry {
  typealias Factory = (_ sampleRate: Int32, _ minSpeechSec: Float, _ minSilenceSec: Float) throws -> FrameFedVadDetector

  private final class Entry {
    let detector: FrameFedVadDetector
    var speechActive = false

    init(detector: FrameFedVadDetector) {
      self.detector = detector
    }
  }

  private let lock = NSLock()
  private let makeDetector: Factory
  private var entries: [String: Entry] = [:]

  init(makeDetector: @escaping Factory) {
    self.makeDetector = makeDetector
  }

  func create(detectorId: String, sampleRate: Int32, minSpeechMs: Int64, redemptionMs: Int64) throws {
    let id = detectorId.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !id.isEmpty else {
      throw NSError(domain: "HappierSherpaNative", code: 401, userInfo: [NSLocalizedDescriptionKey: "detectorId is required"])
    }
    guard sampleRate > 0 else {
      throw NSError(domain: "HappierSherpaNative", code: 402, userInfo: [NSLocalizedDescriptionKey: "sampleRate must be positive"])
    }

    let detector = try makeDetector(
      sampleRate,
      Float(max(0, minSpeechMs)) / 1000.0,
      Float(max(0, redemptionMs)) / 1000.0
    )

    lock.lock()
    let previous = entries.updateValue(Entry(detector: detector), forKey: id)
    lock.unlock()
    previous?.detector.close()
  }

  func push(detectorId: String, data: Data, sampleRate: Int32, channels: Int32) throws -> FrameFedVadFrameResult {
    lock.lock()
    defer { lock.unlock() }

    guard let entry = entries[detectorId] else {
      throw NSError(domain: "HappierSherpaNative", code: 403, userInfo: [NSLocalizedDescriptionKey: "VAD detector not found"])
    }

    let detection = try entry.detector.acceptPcm16(data: data, sampleRate: sampleRate, channels: channels)
    let speechStarted = detection.speechDetected && !entry.speechActive
    entry.speechActive = detection.speechDetected && !detection.speechEnded
    return FrameFedVadFrameResult(speechStarted: speechStarted, speechEnded: detection.speechEnded)
  }

  func cancel(detectorId: String) {
    lock.lock()
    let entry = entries.removeValue(forKey: detectorId)
    lock.unlock()
    entry?.detector.close()
  }

  func cancelAll() {
    lock.lock()
    let active = Array(entries.values)
    entries.removeAll()
    lock.unlock()
    active.forEach { $0.detector.close() }
  }
}
