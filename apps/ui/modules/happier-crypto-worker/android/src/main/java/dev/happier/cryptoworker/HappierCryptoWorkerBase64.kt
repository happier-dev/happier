package dev.happier.cryptoworker

import android.util.Base64

internal object HappierCryptoWorkerBase64 {
  fun decode(value: String?): ByteArray? {
    if (value == null) return null
    return try {
      Base64.decode(normalize(value), Base64.NO_WRAP)
    } catch (_: IllegalArgumentException) {
      null
    }
  }

  private fun normalize(value: String): String {
    val normalized = StringBuilder(value.length)
    for (char in value) {
      if (isBase64Char(char)) {
        normalized.append(char)
      }
    }

    if (normalized.length % 4 == 1) {
      normalized.setLength(normalized.length - 1)
    }

    val padding = normalized.length % 4
    if (padding != 0) {
      repeat(4 - padding) {
        normalized.append('=')
      }
    }

    return normalized.toString()
  }

  private fun isBase64Char(char: Char): Boolean =
    char in 'A'..'Z' ||
      char in 'a'..'z' ||
      char in '0'..'9' ||
      char == '+' ||
      char == '/'
}
