package dev.happier.cryptoworker

import android.net.Uri
import java.io.File
import java.io.FileInputStream
import java.security.MessageDigest

internal object HappierCryptoWorkerFileHash {
  private const val readBufferBytes = 1024 * 1024

  /** Streams a local file through SHA-256 off the JS thread; returns lowercase hex. */
  fun sha256File(fileUri: String): String {
    val uri = Uri.parse(fileUri)
    require(uri.scheme == null || uri.scheme == "file") { "Unsupported scheme for '$fileUri'" }
    val path = requireNotNull(uri.path) { "Missing file path in '$fileUri'" }
    val digest = MessageDigest.getInstance("SHA-256")
    val buffer = ByteArray(readBufferBytes)
    FileInputStream(File(path)).use { input ->
      while (true) {
        val count = input.read(buffer)
        if (count < 0) break
        digest.update(buffer, 0, count)
      }
    }
    return digest.digest().joinToString("") { "%02x".format(it) }
  }
}
