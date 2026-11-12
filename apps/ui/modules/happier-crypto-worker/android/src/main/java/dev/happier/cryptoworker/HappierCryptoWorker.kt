package dev.happier.cryptoworker

import android.util.Base64
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import java.io.ByteArrayOutputStream
import java.util.zip.GZIPInputStream
import java.util.zip.GZIPOutputStream
import java.nio.ByteBuffer

internal object HappierCryptoWorkerContentCodec {
  // Protocol CONTENT_VALUE_MAX_DECODED_BYTES projection; shared fixtures verify parity.
  const val maxDecodedBytes = 100 * 1024 * 1024
  fun encode(json: ByteArray): ByteArray {
    val compressed = ByteArrayOutputStream().also { output ->
      GZIPOutputStream(output).use { it.write(json) }
    }.toByteArray()
    return if (compressed.size < json.size) byteArrayOf(1) + compressed else byteArrayOf(0) + json
  }

  fun decode(frame: ByteArray): ByteArray? = try {
    when (frame.firstOrNull()?.toInt()) {
      0 -> if (frame.size - 1 <= maxDecodedBytes) frame.copyOfRange(1, frame.size) else null
      1 -> GZIPInputStream(frame.copyOfRange(1, frame.size).inputStream()).use { input ->
        val output = ByteArrayOutputStream()
        val chunk = ByteArray(32 * 1024)
        while (true) {
          val count = input.read(chunk)
          if (count == -1) break
          if (count > maxDecodedBytes - output.size()) return@use null
          output.write(chunk, 0, count)
        }
        output.toByteArray()
      }
      else -> null
    }
  } catch (_: Exception) { null }

  fun decodeLegacy(bytes: ByteArray): ByteArray? =
    if (bytes.firstOrNull() == 0.toByte() || bytes.firstOrNull() == 1.toByte()) decode(bytes) else bytes

  fun json(bytes: ByteArray): String? = try {
    Charsets.UTF_8.newDecoder().decode(ByteBuffer.wrap(bytes)).toString()
  } catch (_: Exception) { null }
}

internal object HappierCryptoWorker {
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

  fun encodeContentValueBase64(jsonBase64: String): String? =
    HappierCryptoWorkerBase64.decode(jsonBase64)?.let {
      Base64.encodeToString(HappierCryptoWorkerContentCodec.encode(it), Base64.NO_WRAP)
    }

  fun encryptAesGcmContentBatch(items: List<Map<String, String>>): List<String?> = items.map { item ->
    val json = HappierCryptoWorkerBase64.decode(item["jsonBase64"]) ?: return@map null
    val key = HappierCryptoWorkerBase64.decode(item["keyBase64"]) ?: return@map null
    val nonce = HappierCryptoWorkerBase64.decode(item["nonceBase64"]) ?: return@map null
    if (key.size != aesGcmKeyBytes || nonce.size != aesGcmNonceBytes) return@map null
    try {
      val cipher = Cipher.getInstance("AES/GCM/NoPadding")
      cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(aesGcmTagBits, nonce))
      val encrypted = cipher.doFinal(HappierCryptoWorkerContentCodec.encode(json))
      Base64.encodeToString(byteArrayOf(1) + nonce + encrypted, Base64.NO_WRAP)
    } catch (_: Exception) { null }
  }

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
      HappierCryptoWorkerContentCodec.decodeLegacy(opened)?.let { HappierCryptoWorkerContentCodec.json(it) }
    }

  fun decryptAesGcmJsonBatch(items: List<Map<String, String>>): List<String?> =
    openAesGcmContentBatch(items).map { it["serializedJson"] }

  fun openAesGcmContentBatch(items: List<Map<String, String>>): List<Map<String, String>> = items.map { item ->
    val encryptedPayload = HappierCryptoWorkerBase64.decode(item["encryptedPayloadBase64"])
    val key = HappierCryptoWorkerBase64.decode(item["keyBase64"])
    if (key == null || encryptedPayload == null || key.size != aesGcmKeyBytes ||
      encryptedPayload.size < 1 + aesGcmNonceBytes + aesGcmTagBytes ||
      (encryptedPayload[0] != 0.toByte() && encryptedPayload[0] != 1.toByte())) {
      return@map mapOf("status" to "unsupported")
    }
    val opened = try {
      val nonce = encryptedPayload.copyOfRange(1, 1 + aesGcmNonceBytes)
      val ciphertextAndTag = encryptedPayload.copyOfRange(1 + aesGcmNonceBytes, encryptedPayload.size)
      val cipher = Cipher.getInstance("AES/GCM/NoPadding")
      cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(aesGcmTagBits, nonce))
      cipher.doFinal(ciphertextAndTag)
    } catch (_: Exception) { return@map mapOf("status" to "authentication_failed") }
    val json = if (encryptedPayload[0] == 1.toByte()) HappierCryptoWorkerContentCodec.decode(opened) else opened
    val serializedJson = json?.let { HappierCryptoWorkerContentCodec.json(it) }
      ?: return@map mapOf("status" to "invalid_payload")
    mapOf("status" to "authenticated", "serializedJson" to serializedJson)
  }
}
