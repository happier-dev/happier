import Clibsodium
import Foundation

enum HappierCryptoWorkerSecretbox {
  private static let keyBytes = 32
  private static let nonceBytes = 24
  private static let macBytes = 16

  static func decryptSecretboxJsonBatch(_ items: [[String: String]]) -> [String?] {
    items.map { item in
      guard
        let ciphertextBase64 = item["ciphertextBase64"],
        let keyBase64 = item["keyBase64"],
        let ciphertext = HappierCryptoWorkerBase64.decode(ciphertextBase64),
        let key = HappierCryptoWorkerBase64.decode(keyBase64),
        let opened = openSecretbox(ciphertext: ciphertext, key: key)
      else {
        return nil
      }
      return String(data: opened, encoding: .utf8)
    }
  }

  private static func openSecretbox(ciphertext: Data, key: Data) -> Data? {
    guard sodium_init() >= 0 else {
      return nil
    }
    guard key.count == keyBytes else {
      return nil
    }
    guard ciphertext.count >= nonceBytes + macBytes else {
      return nil
    }

    let ciphertextBytes = [UInt8](ciphertext)
    let nonce = Array(ciphertextBytes[0..<nonceBytes])
    let boxed = Array(ciphertextBytes[nonceBytes..<ciphertextBytes.count])
    let keyBytes = [UInt8](key)
    var opened = [UInt8](repeating: 0, count: boxed.count - macBytes)

    let status = opened.withUnsafeMutableBufferPointer { openedBuffer in
      boxed.withUnsafeBufferPointer { boxedBuffer in
        nonce.withUnsafeBufferPointer { nonceBuffer in
          keyBytes.withUnsafeBufferPointer { keyBuffer in
            guard
              let openedPointer = openedBuffer.baseAddress,
              let boxedPointer = boxedBuffer.baseAddress,
              let noncePointer = nonceBuffer.baseAddress,
              let keyPointer = keyBuffer.baseAddress
            else {
              return Int32(-1)
            }
            return crypto_secretbox_open_easy(
              openedPointer,
              boxedPointer,
              UInt64(boxed.count),
              noncePointer,
              keyPointer
            )
          }
        }
      }
    }
    return status == 0 ? Data(opened) : nil
  }
}
