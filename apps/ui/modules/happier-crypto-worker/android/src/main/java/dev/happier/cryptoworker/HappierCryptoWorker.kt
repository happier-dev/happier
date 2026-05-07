package dev.happier.cryptoworker

import android.util.Base64
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

internal object HappierCryptoWorker {
  private const val aesGcmVersionByte: Byte = 0
  private const val aesGcmKeyBytes = 32
  private const val aesGcmNonceBytes = 12
  private const val aesGcmTagBits = 128
  private const val aesGcmTagBytes = 16

  fun capabilities(): Map<String, Any> = mapOf(
    "moduleVersion" to HappierCryptoWorkerTypes.moduleVersion,
    "platform" to HappierCryptoWorkerTypes.platform,
    "supportedOperations" to HappierCryptoWorkerTypes.supportedOperations
  )

  fun echoBatchForDiagnostics(values: List<String>): List<String> = values

  fun decryptDataKeyEnvelopeV1Batch(items: List<Map<String, String>>): List<String?> =
    items.map { item ->
      val envelope = HappierCryptoWorkerBase64.decode(item["envelopeBase64"]) ?: return@map null
      val secret = HappierCryptoWorkerBase64.decode(item["recipientSecretKeyOrSeedBase64"]) ?: return@map null
      val opened = HappierCryptoWorkerNative.openDataKeyEnvelopeV1(envelope, secret) ?: return@map null
      Base64.encodeToString(opened, Base64.NO_WRAP)
    }

  fun decryptSecretboxJsonBatch(items: List<Map<String, String>>): List<String?> =
    items.map { item ->
      val ciphertext = HappierCryptoWorkerBase64.decode(item["ciphertextBase64"]) ?: return@map null
      val key = HappierCryptoWorkerBase64.decode(item["keyBase64"]) ?: return@map null
      val opened = HappierCryptoWorkerNative.openSecretboxJson(ciphertext, key) ?: return@map null
      opened.toString(Charsets.UTF_8)
    }

  fun decryptAesGcmJsonBatch(items: List<Map<String, String>>): List<String?> =
    items.map { item ->
      val encryptedPayload = HappierCryptoWorkerBase64.decode(item["encryptedPayloadBase64"]) ?: return@map null
      val key = HappierCryptoWorkerBase64.decode(item["keyBase64"]) ?: return@map null
      decryptAesGcmJson(encryptedPayload, key)
    }

  private fun decryptAesGcmJson(encryptedPayload: ByteArray, key: ByteArray): String? {
    if (
      key.size != aesGcmKeyBytes ||
      encryptedPayload.size < 1 + aesGcmNonceBytes + aesGcmTagBytes ||
      encryptedPayload[0] != aesGcmVersionByte
    ) {
      return null
    }

    return try {
      val nonce = encryptedPayload.copyOfRange(1, 1 + aesGcmNonceBytes)
      val ciphertextAndTag = encryptedPayload.copyOfRange(1 + aesGcmNonceBytes, encryptedPayload.size)
      val cipher = Cipher.getInstance("AES/GCM/NoPadding")
      cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(aesGcmTagBits, nonce))
      cipher.doFinal(ciphertextAndTag).toString(Charsets.UTF_8)
    } catch (_: Exception) {
      null
    }
  }

}
