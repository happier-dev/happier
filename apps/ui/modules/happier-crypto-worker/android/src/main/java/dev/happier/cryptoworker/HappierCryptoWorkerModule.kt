package dev.happier.cryptoworker

import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

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

    // Hashing a model file takes far longer than a crypto batch; keep it off the single thread that
    // serves every module's DEFAULT-queue async functions, and let several files hash in parallel.
    AsyncFunction("sha256File") Coroutine { fileUri: String ->
      withContext(Dispatchers.IO) { HappierCryptoWorkerFileHash.sha256File(fileUri) }
    }

    AsyncFunction("decryptAesGcmJsonBatch") { items: List<Map<String, String>> ->
      return@AsyncFunction HappierCryptoWorker.decryptAesGcmJsonBatch(items)
    }.runOnQueue(Queues.DEFAULT)
  }
}
