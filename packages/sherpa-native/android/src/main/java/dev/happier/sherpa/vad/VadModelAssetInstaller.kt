package dev.happier.sherpa.vad

import android.content.Context
import java.io.File
import java.io.FileOutputStream

object VadModelAssetInstaller {
  private const val kAssetName = "silero_vad_v5.onnx"
  private const val kOutFileName = "happier_silero_vad_v5.onnx"

  fun ensureInstalled(context: Context): String {
    val outDir = context.noBackupFilesDir ?: context.filesDir
    val outFile = File(outDir, kOutFileName)
    if (outFile.exists() && outFile.length() > 0) {
      return outFile.absolutePath
    }

    context.assets.open(kAssetName).use { input ->
      outFile.parentFile?.mkdirs()
      FileOutputStream(outFile).use { output ->
        input.copyTo(output)
      }
    }

    return outFile.absolutePath
  }
}
