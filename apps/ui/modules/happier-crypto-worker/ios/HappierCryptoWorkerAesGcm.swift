import CryptoKit
import Foundation

enum HappierCryptoWorkerAesGcm {
  private static let versionByte: UInt8 = 0
  private static let keyBytes = 32
  private static let nonceBytes = 12
  private static let tagBytes = 16

  static func decryptAesGcmJsonBatch(_ items: [[String: String]]) -> [String?] {
    items.map { item in
      guard
        let payloadBase64 = item["encryptedPayloadBase64"],
        let keyBase64 = item["keyBase64"],
        let payload = HappierCryptoWorkerBase64.decode(payloadBase64),
        let key = HappierCryptoWorkerBase64.decode(keyBase64),
        let opened = decryptAesGcm(payload: payload, key: key)
      else {
        return nil
      }
      return String(data: opened, encoding: .utf8)
    }
  }

  private static func decryptAesGcm(payload: Data, key: Data) -> Data? {
    guard key.count == keyBytes else {
      return nil
    }
    guard payload.count >= 1 + nonceBytes + tagBytes else {
      return nil
    }
    guard payload[payload.startIndex] == versionByte else {
      return nil
    }

    do {
      let combined = payload.dropFirst()
      let sealedBox = try AES.GCM.SealedBox(combined: Data(combined))
      let symmetricKey = SymmetricKey(data: key)
      return try AES.GCM.open(sealedBox, using: symmetricKey)
    } catch {
      return nil
    }
  }
}
