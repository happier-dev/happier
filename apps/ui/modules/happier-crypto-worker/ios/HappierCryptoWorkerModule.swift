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
  }
}
