import ExpoModulesCore
import Foundation

public final class HappierCryptoWorkerModule: Module {
  private static let workerQueue = DispatchQueue(
    label: "dev.happier.crypto-worker",
    qos: .userInitiated,
    attributes: .concurrent
  )

  public func definition() -> ModuleDefinition {
    Name("HappierCryptoWorker")

    // Synchronous so the installer core can hash each bounded chunk in place; a 1 MB update is
    // milliseconds natively and far slower in Hermes, which has no JIT.
    Class("Sha256", HappierCryptoWorkerSha256.self) {
      Constructor {
        HappierCryptoWorkerSha256()
      }
      Function("update") { (hasher: HappierCryptoWorkerSha256, chunk: TypedArray) in
        try hasher.update(chunk)
      }
      Function("digestHex") { (hasher: HappierCryptoWorkerSha256) in
        try hasher.digestHex()
      }
    }

    AsyncFunction("derivePasswordEnvelopeKey") { (request: PasswordEnvelopeKeyRequest) in
      try HappierCryptoWorkerPassword.derivePasswordEnvelopeKey(request)
    }.runOnQueue(Self.workerQueue)

    AsyncFunction("getCapabilities") {
      HappierCryptoWorker.capabilities()
    }.runOnQueue(Self.workerQueue)

    AsyncFunction("echoBatchForDiagnostics") { (values: [String]) in
      HappierCryptoWorker.echoBatchForDiagnostics(values)
    }.runOnQueue(Self.workerQueue)

    AsyncFunction("decryptDataKeyEnvelopeV1Batch") { (items: [[String: String]]) in
      HappierCryptoWorker.decryptDataKeyEnvelopeV1Batch(items)
    }.runOnQueue(Self.workerQueue)

    AsyncFunction("decryptSecretboxJsonBatch") { (items: [[String: String]]) in
      HappierCryptoWorker.decryptSecretboxJsonBatch(items)
    }.runOnQueue(Self.workerQueue)

    AsyncFunction("decryptAesGcmJsonBatch") { (items: [[String: String]]) in
      HappierCryptoWorker.decryptAesGcmJsonBatch(items)
    }.runOnQueue(Self.workerQueue)

    AsyncFunction("encodeContentValueBase64") { (jsonBase64: String) in
      HappierCryptoWorkerAesGcm.encodeContentValueBase64(jsonBase64)
    }.runOnQueue(Self.workerQueue)

    AsyncFunction("decodeContentValueBase64") { (frameBase64: String) -> String? in
      guard let frame = HappierCryptoWorkerBase64.decode(frameBase64),
            let json = HappierCryptoWorkerContentCodec.decodeLegacy(frame) else { return nil }
      return String(data: json, encoding: .utf8)
    }.runOnQueue(Self.workerQueue)

    AsyncFunction("openAesGcmContentBatch") { (items: [[String: String]]) in
      HappierCryptoWorkerAesGcm.openAesGcmContentBatch(items)
    }.runOnQueue(Self.workerQueue)

    AsyncFunction("encryptAesGcmContentBatch") { (items: [[String: String]]) in
      HappierCryptoWorkerAesGcm.encryptAesGcmContentBatch(items)
    }.runOnQueue(Self.workerQueue)
  }
}
