import Foundation

enum HappierCryptoWorker {
  static func capabilities() -> [String: Any] {
    [
      "moduleVersion": HappierCryptoWorkerTypes.moduleVersion,
      "platform": HappierCryptoWorkerTypes.platform,
      "supportedOperations": HappierCryptoWorkerTypes.supportedOperations,
    ]
  }

  static func echoBatchForDiagnostics(_ values: [String]) -> [String] {
    values
  }

  static func decryptDataKeyEnvelopeV1Batch(_ items: [[String: String]]) -> [String?] {
    HappierCryptoWorkerDataKeyEnvelope.decryptDataKeyEnvelopeV1Batch(items)
  }

  static func decryptSecretboxJsonBatch(_ items: [[String: String]]) -> [String?] {
    HappierCryptoWorkerSecretbox.decryptSecretboxJsonBatch(items)
  }

  static func decryptAesGcmJsonBatch(_ items: [[String: String]]) -> [String?] {
    HappierCryptoWorkerAesGcm.decryptAesGcmJsonBatch(items)
  }
}
