package dev.happier.cryptoworker

import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class HappierCryptoWorkerModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("HappierCryptoWorker")

    AsyncFunction("getCapabilities") {
      return@AsyncFunction HappierCryptoWorker.capabilities()
    }.runOnQueue(Queues.DEFAULT)

    AsyncFunction("echoBatchForDiagnostics") { values: List<String> ->
      return@AsyncFunction HappierCryptoWorker.echoBatchForDiagnostics(values)
    }.runOnQueue(Queues.DEFAULT)

    AsyncFunction("decryptDataKeyEnvelopeV1Batch") { items: List<Map<String, String>> ->
      return@AsyncFunction HappierCryptoWorker.decryptDataKeyEnvelopeV1Batch(items)
    }.runOnQueue(Queues.DEFAULT)

    AsyncFunction("decryptSecretboxJsonBatch") { items: List<Map<String, String>> ->
      return@AsyncFunction HappierCryptoWorker.decryptSecretboxJsonBatch(items)
    }.runOnQueue(Queues.DEFAULT)

    AsyncFunction("decryptAesGcmJsonBatch") { items: List<Map<String, String>> ->
      return@AsyncFunction HappierCryptoWorker.decryptAesGcmJsonBatch(items)
    }.runOnQueue(Queues.DEFAULT)
  }
}
