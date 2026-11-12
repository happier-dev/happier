import Foundation

/// Public, React-free access to the same Session cryptography used by the
/// native batch worker. Native extensions can compose these primitives without
/// copying the envelope or payload algorithms into another owner.
public enum HappierCryptoWorkerSessionCrypto {
  public static func openSessionDataKey(
    envelopeBase64: String,
    recipientSecretKeyOrSeedBase64: String
  ) -> String? {
    HappierCryptoWorkerDataKeyEnvelope.decryptDataKeyEnvelopeV1Batch([[
      "envelopeBase64": envelopeBase64,
      "recipientSecretKeyOrSeedBase64": recipientSecretKeyOrSeedBase64,
    ]]).first ?? nil
  }

  public static func decryptSessionPayload(
    ciphertextBase64: String,
    sessionDataKeyBase64: String
  ) -> String? {
    guard let serialized = HappierCryptoWorkerAesGcm.decryptAesGcmJsonBatch([[
      "encryptedPayloadBase64": ciphertextBase64,
      "keyBase64": sessionDataKeyBase64,
    ]]).first ?? nil,
      let data = serialized.data(using: .utf8),
      let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
    guard object["__happierSerializedJsonValueV1"] as? Bool == true else { return serialized }
    guard object["type"] as? String == "json", let value = object["value"] as? [String: Any],
          let json = try? JSONSerialization.data(withJSONObject: value) else { return nil }
    return String(data: json, encoding: .utf8)
  }

  public static func decryptMachinePayload(ciphertextBase64: String, machineDataKeyBase64: String) -> String? {
    decryptSessionPayload(ciphertextBase64: ciphertextBase64, sessionDataKeyBase64: machineDataKeyBase64)
  }
}
