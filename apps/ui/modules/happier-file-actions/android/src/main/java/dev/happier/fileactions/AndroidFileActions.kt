package dev.happier.fileactions

import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract
import android.webkit.MimeTypeMap
import androidx.core.content.FileProvider
import java.io.File
import java.io.IOException
import java.util.Locale
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext

class HappierDownloadFileProvider : FileProvider()

internal object AndroidFileActions {
  fun mimeType(name: String): String = MimeTypeMap.getSingleton()
    .getMimeTypeFromExtension(name.substringAfterLast('.', "").lowercase(Locale.ROOT))
    ?: "application/octet-stream"

  fun checkedDownloadFile(context: Context, fileUri: String): File {
    val uri = Uri.parse(fileUri)
    require(uri.scheme == "file") { "Only a downloaded local file can be opened or saved" }
    val file = File(requireNotNull(uri.path)).canonicalFile
    val root = File(context.cacheDir, "happier-downloads").canonicalFile
    require(file.path.startsWith(root.path + File.separator) && file.isFile) {
      "File is outside the download cache or no longer available"
    }
    return file
  }

  fun contentUri(context: Context, file: File, name: String): Uri = FileProvider.getUriForFile(
    context, context.packageName + ".happier-file-actions", file, name
  )

  fun documentIntent(name: String, mimeType: String): Intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
    addCategory(Intent.CATEGORY_OPENABLE)
    type = mimeType
    putExtra(Intent.EXTRA_TITLE, name)
  }

  suspend fun copyToDocument(context: Context, file: File, selectedUri: String) {
    val uri = Uri.parse(selectedUri)
    require(uri.scheme == "content") { "Save destination must be a document" }
    try {
      withContext(Dispatchers.IO) {
        context.contentResolver.openOutputStream(uri, "wt").use { output ->
          requireNotNull(output) { "Unable to write the selected destination" }
          file.inputStream().use { input ->
            val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
            while (true) {
              currentCoroutineContext().ensureActive()
              val length = input.read(buffer)
              if (length < 0) break
              output.write(buffer, 0, length)
            }
          }
        }
      }
    } catch (failure: Throwable) {
      // ACTION_CREATE_DOCUMENT returned a new document, so removing a failed
      // save cannot discard an existing user's file. Cancellation must not
      // interrupt cleanup after ownership of that document has been acquired.
      withContext(NonCancellable + Dispatchers.IO) {
        try {
          check(DocumentsContract.deleteDocument(context.contentResolver, uri)) {
            "The provider did not remove the document"
          }
        } catch (cleanupFailure: Throwable) {
          throw IOException(
            "Save failed: ${failure.message}. Incomplete document could not be removed: $selectedUri",
            failure,
          ).apply { addSuppressed(cleanupFailure) }
        }
      }
      throw failure
    }
  }

  fun chooserIntent(intent: Intent, dialogTitle: String? = null): Intent = Intent.createChooser(intent, dialogTitle).apply {
    clipData = intent.clipData
    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
  }

  fun fileIntent(uri: Uri, name: String, share: Boolean, explicitMimeType: String? = null): Intent = Intent(
    if (share) Intent.ACTION_SEND else Intent.ACTION_VIEW
  ).apply {
    val mimeType = explicitMimeType ?: mimeType(name)
    if (share) {
      type = mimeType
      putExtra(Intent.EXTRA_STREAM, uri)
    } else {
      setDataAndType(uri, mimeType)
    }
    clipData = ClipData.newRawUri(name, uri)
    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
  }
}
