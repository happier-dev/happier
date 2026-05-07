import Clibsodium
import Foundation

enum HappierCryptoWorkerDataKeyEnvelope {
  private static let envelopeVersion: UInt8 = 0
  private static let envelopeVersionBytes = 1
  private static let publicKeyBytes = 32
  private static let secretKeyBytes = 32
  private static let nonceBytes = 24
  private static let macBytes = 16
  private static let sha512Bytes = 64

  static func decryptDataKeyEnvelopeV1Batch(_ items: [[String: String]]) -> [String?] {
    items.map { item in
      guard
        let envelopeBase64 = item["envelopeBase64"],
        let secretBase64 = item["recipientSecretKeyOrSeedBase64"],
        let envelope = HappierCryptoWorkerBase64.decode(envelopeBase64),
        let secret = HappierCryptoWorkerBase64.decode(secretBase64),
        let opened = openDataKeyEnvelopeV1(envelope: envelope, recipientSecretKeyOrSeed: secret)
      else {
        return nil
      }
      return opened.base64EncodedString()
    }
  }

  private static func openDataKeyEnvelopeV1(envelope: Data, recipientSecretKeyOrSeed: Data) -> Data? {
    guard sodium_init() >= 0 else {
      return nil
    }
    guard recipientSecretKeyOrSeed.count == secretKeyBytes else {
      return nil
    }
    guard envelope.count >= envelopeVersionBytes + publicKeyBytes + nonceBytes + macBytes else {
      return nil
    }

    let envelopeBytes = [UInt8](envelope)
    guard envelopeBytes[0] == envelopeVersion else {
      return nil
    }

    let bundleOffset = envelopeVersionBytes
    let ephemeralPublicKey = Array(envelopeBytes[bundleOffset..<bundleOffset + publicKeyBytes])
    let nonceOffset = bundleOffset + publicKeyBytes
    let nonce = Array(envelopeBytes[nonceOffset..<nonceOffset + nonceBytes])
    let boxedOffset = nonceOffset + nonceBytes
    let boxed = Array(envelopeBytes[boxedOffset..<envelopeBytes.count])
    let secret = [UInt8](recipientSecretKeyOrSeed)

    if let opened = openBoxBundle(ephemeralPublicKey: ephemeralPublicKey, nonce: nonce, boxed: boxed, secretKey: secret) {
      return Data(opened)
    }

    var hash = [UInt8](repeating: 0, count: sha512Bytes)
    let hashCount = hash.count
    let hashStatus = secret.withUnsafeBufferPointer { secretBuffer in
      hash.withUnsafeMutableBufferPointer { hashBuffer in
        guard
          let hashPointer = hashBuffer.baseAddress,
          let secretPointer = secretBuffer.baseAddress
        else {
          return Int32(-1)
        }
        return crypto_hash_sha512(hashPointer, secretPointer, UInt64(secret.count))
      }
    }
    guard hashStatus == 0 else {
      return nil
    }
    defer {
      hash.withUnsafeMutableBufferPointer { hashBuffer in
        if let hashPointer = hashBuffer.baseAddress {
          sodium_memzero(hashPointer, hashCount)
        }
      }
    }
    guard let openedFromSeed = openBoxBundle(
      ephemeralPublicKey: ephemeralPublicKey,
      nonce: nonce,
      boxed: boxed,
      secretKey: Array(hash.prefix(secretKeyBytes))
    ) else {
      return nil
    }
    return Data(openedFromSeed)
  }

  private static func openBoxBundle(
    ephemeralPublicKey: [UInt8],
    nonce: [UInt8],
    boxed: [UInt8],
    secretKey: [UInt8]
  ) -> [UInt8]? {
    guard boxed.count >= macBytes else {
      return nil
    }
    var opened = [UInt8](repeating: 0, count: boxed.count - macBytes)
    let status = opened.withUnsafeMutableBufferPointer { openedBuffer in
      boxed.withUnsafeBufferPointer { boxedBuffer in
        nonce.withUnsafeBufferPointer { nonceBuffer in
          ephemeralPublicKey.withUnsafeBufferPointer { publicKeyBuffer in
            secretKey.withUnsafeBufferPointer { secretKeyBuffer in
              guard
                let openedPointer = openedBuffer.baseAddress,
                let boxedPointer = boxedBuffer.baseAddress,
                let noncePointer = nonceBuffer.baseAddress,
                let publicKeyPointer = publicKeyBuffer.baseAddress,
                let secretKeyPointer = secretKeyBuffer.baseAddress
              else {
                return Int32(-1)
              }
              return crypto_box_open_easy(
                openedPointer,
                boxedPointer,
                UInt64(boxed.count),
                noncePointer,
                publicKeyPointer,
                secretKeyPointer
              )
            }
          }
        }
      }
    }
    return status == 0 ? opened : nil
  }
}
