import CryptoKit
import Foundation

@main struct ContentCodecTests {
  static func main() throws {
    let fixture = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))) as! [String: Any]
    let key = fixture["keyBase64"] as! String
    for vector in fixture["vectors"] as! [[String: Any]] {
      let ciphertext = vector["ciphertextBase64"] as! String
      let opened = vector["variant"] as! String == "dataKey"
        ? HappierCryptoWorkerAesGcm.decryptAesGcmJsonBatch([["encryptedPayloadBase64": ciphertext, "keyBase64": key]])[0]
        : HappierCryptoWorkerSecretbox.decryptSecretboxJsonBatch([["ciphertextBase64": ciphertext, "keyBase64": key]])[0]
      precondition(opened == vector["serializedJson"] as? String, "native fixture failed: \(vector["name"]!)")
      if vector["variant"] as! String == "dataKey" {
        let notification = HappierCryptoWorkerSessionCrypto.decryptSessionPayload(ciphertextBase64: ciphertext, sessionDataKeyBase64: key)
        let value = notification.flatMap { $0.data(using: .utf8) }.flatMap { try? JSONSerialization.jsonObject(with: $0) }
        precondition((value as? NSDictionary) == (vector["value"] as? NSDictionary), "notification facade failed: \(vector["name"]!)")
      }
      let json = (vector["serializedJson"] as! String).data(using: .utf8)!
      let encoded = HappierCryptoWorkerAesGcm.encryptAesGcmContentBatch([[
        "jsonBase64": json.base64EncodedString(), "keyBase64": key,
        "nonceBase64": Data(repeating: 9, count: 12).base64EncodedString(),
      ]])[0]!
      precondition(HappierCryptoWorkerAesGcm.decryptAesGcmJsonBatch([[
        "encryptedPayloadBase64": encoded, "keyBase64": key,
      ]])[0] == opened, "native byte AES round trip failed")
      var tampered = Data(base64Encoded: encoded)!
      tampered[tampered.count - 1] ^= 1
      precondition(HappierCryptoWorkerAesGcm.decryptAesGcmJsonBatch([[
        "encryptedPayloadBase64": tampered.base64EncodedString(), "keyBase64": key,
      ]])[0] == nil, "modified ciphertext opened")
      precondition(HappierCryptoWorkerAesGcm.openAesGcmContentBatch([["encryptedPayloadBase64": tampered.base64EncodedString(), "keyBase64": key]])[0]["status"] == "authentication_failed", "tampered ciphertext classification failed")
    }
    let keyBytes = Data(base64Encoded: key)!
    let nonceBytes = Data(repeating: 7, count: 12)
    for invalidFrame in [Data([2]), Data([1, 1, 2, 3]), Data([0, 0xff])] {
      let sealed = try AES.GCM.seal(invalidFrame, using: SymmetricKey(data: keyBytes), nonce: AES.GCM.Nonce(data: nonceBytes))
      let bundle = Data([1]) + nonceBytes + sealed.ciphertext + sealed.tag
      let result = HappierCryptoWorkerAesGcm.openAesGcmContentBatch([["encryptedPayloadBase64": bundle.base64EncodedString(), "keyBase64": key]])[0]
      precondition(result["status"] == "invalid_payload", "authenticated malformed frame reported as wrong key")
    }
    let small = Data("1".utf8)
    precondition(HappierCryptoWorkerContentCodec.encode(small)?.first == 0, "small content grew through gzip")
    let large = Data(String(repeating: "repeated content ", count: 200).utf8)
    precondition(HappierCryptoWorkerContentCodec.encode(large)?.first == 1, "compressible content stayed raw")
    precondition(HappierCryptoWorkerContentCodec.decode(Data([2])) == nil, "unknown codec admitted")
    precondition(HappierCryptoWorkerContentCodec.decode(Data([1, 1, 2, 3])) == nil, "malformed gzip admitted")
    let bounds = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[2]))) as! [String: Any]
    precondition(bounds["maxDecodedBytes"] as? Int == HappierCryptoWorkerContentCodec.maxDecodedBytes, "native ceiling diverged from Protocol")
    for vector in bounds["vectors"] as! [[String: Any]] {
      let frame = Data(base64Encoded: vector["frameBase64"] as! String)!
      let decoded = HappierCryptoWorkerContentCodec.decode(frame)
      if vector["expectedStatus"] as! String == "authenticated" {
        precondition(decoded?.count == vector["decodedBytes"] as? Int, "valid near-bound content rejected")
      } else {
        precondition(decoded == nil, "gzip expanded beyond Protocol ingress ceiling")
      }
    }
    print("native content fixtures and byte AES round trips passed")
  }
}
