package dev.happier.cryptoworker

import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.typedarray.TypedArray

class HappierCryptoWorkerModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("HappierCryptoWorker")

    // Synchronous so the installer core can hash each bounded chunk in place; a 1 MB update is
    // milliseconds natively and far slower in Hermes, which has no JIT.
    Class("Sha256", HappierCryptoWorkerSha256::class) {
      Constructor { -> HappierCryptoWorkerSha256() }
      Function("update") { hasher: HappierCryptoWorkerSha256, chunk: TypedArray -> hasher.update(chunk) }
      Function("digestHex") { hasher: HappierCryptoWorkerSha256 -> hasher.digestHex() }
    }

    AsyncFunction("derivePasswordEnvelopeKey") { request: PasswordEnvelopeKeyRequest ->
      return@AsyncFunction HappierCryptoWorkerPassword.derivePasswordEnvelopeKey(request)
    }.runOnQueue(Queues.DEFAULT)

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

    AsyncFunction("encodeContentValueBase64") { jsonBase64: String ->
      return@AsyncFunction HappierCryptoWorker.encodeContentValueBase64(jsonBase64)
    }.runOnQueue(Queues.DEFAULT)

    AsyncFunction("decodeContentValueBase64") { frameBase64: String ->
      return@AsyncFunction HappierCryptoWorkerBase64.decode(frameBase64)?.let {
        HappierCryptoWorkerContentCodec.decodeLegacy(it)?.let { bytes -> HappierCryptoWorkerContentCodec.json(bytes) }
      }
    }.runOnQueue(Queues.DEFAULT)

    AsyncFunction("openAesGcmContentBatch") { items: List<Map<String, String>> ->
      return@AsyncFunction HappierCryptoWorker.openAesGcmContentBatch(items)
    }.runOnQueue(Queues.DEFAULT)

    AsyncFunction("encryptAesGcmContentBatch") { items: List<Map<String, String>> ->
      return@AsyncFunction HappierCryptoWorker.encryptAesGcmContentBatch(items)
    }.runOnQueue(Queues.DEFAULT)
  }
}
