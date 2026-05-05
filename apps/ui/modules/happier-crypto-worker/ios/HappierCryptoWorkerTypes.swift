import Foundation

enum HappierCryptoWorkerTypes {
  static let moduleVersion = 1
  static let platform = "ios"
  static let supportedOperations = [
    "decryptDataKeyEnvelopeV1",
    "decryptSecretboxJson",
    "decryptAesGcmJson",
    "echoBatchForDiagnostics",
  ]
}
