package dev.happier.cryptoworker

internal class HappierCryptoWorkerNative private constructor() {
  companion object {
    init {
      System.loadLibrary("happiercryptoworker")
    }

    @JvmStatic
    external fun openDataKeyEnvelopeV1(envelope: ByteArray, recipientSecretKeyOrSeed: ByteArray): ByteArray?

    @JvmStatic
    external fun openSecretboxJson(ciphertext: ByteArray, key: ByteArray): ByteArray?
  }
}
