package dev.happier.cryptoworker

internal object HappierCryptoWorkerTypes {
  const val moduleVersion = 1
  const val platform = "android"

  val supportedOperations = listOf(
    "decryptDataKeyEnvelopeV1",
    "decryptSecretboxJson",
    "decryptAesGcmJson",
    "echoBatchForDiagnostics"
  )
}
