package dev.happier.fileactions

import android.app.Activity
import android.content.Context
import android.content.Intent
import expo.modules.kotlin.activityresult.AppContextActivityResultContract
import expo.modules.kotlin.activityresult.AppContextActivityResultLauncher
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.sync.Mutex
import java.io.Serializable

internal data class SaveDocumentOptions(val name: String, val mimeType: String) : Serializable

internal class SaveDocumentContract : AppContextActivityResultContract<SaveDocumentOptions, String?> {
  override fun createIntent(context: Context, input: SaveDocumentOptions): Intent =
    AndroidFileActions.documentIntent(input.name, input.mimeType)

  override fun parseResult(input: SaveDocumentOptions, resultCode: Int, intent: Intent?): String? {
    if (resultCode != Activity.RESULT_OK) return null
    return requireNotNull(intent?.data) { "Save destination is unavailable" }.toString()
  }
}

class HappierFileActionsModule : Module() {
  private lateinit var saveLauncher: AppContextActivityResultLauncher<SaveDocumentOptions, String?>
  private val saveMutex = Mutex()

  override fun definition() = ModuleDefinition {
    Name("HappierFileActions")

    RegisterActivityContracts {
      saveLauncher = registerForActivityResult(SaveDocumentContract()) { _, _ -> }
    }

    AsyncFunction("saveFile") Coroutine { fileUri: String, name: String ->
      check(saveMutex.tryLock()) { "Another save is already in progress" }
      try {
        val context = requireNotNull(appContext.reactContext) { "App context is unavailable" }
        val file = AndroidFileActions.checkedDownloadFile(context, fileUri)
        val selectedUri = saveLauncher.launch(SaveDocumentOptions(name, AndroidFileActions.mimeType(name)))
        if (selectedUri == null) {
          mapOf("canceled" to true)
        } else {
          AndroidFileActions.copyToDocument(context, file, selectedUri)
          mapOf("canceled" to false, "uri" to selectedUri)
        }
      } finally {
        saveMutex.unlock()
      }
    }

    AsyncFunction("openFile") { fileUri: String, name: String ->
      launchFileIntent(fileUri, name, share = false)
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("shareFile") { fileUri: String, name: String, mimeType: String? ->
      launchFileIntent(fileUri, name, share = true, explicitMimeType = mimeType)
    }.runOnQueue(Queues.MAIN)
  }

  private fun launchFileIntent(fileUri: String, name: String, share: Boolean, explicitMimeType: String? = null) {
    val context = requireNotNull(appContext.reactContext) { "App context is unavailable" }
    val file = AndroidFileActions.checkedDownloadFile(context, fileUri)
    val uri = AndroidFileActions.contentUri(context, file, name)
    val intent = AndroidFileActions.fileIntent(uri, name, share, explicitMimeType)
    val chooser = Intent.createChooser(intent, null).apply {
      clipData = intent.clipData
      addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }
    appContext.throwingActivity.startActivity(chooser)
  }
}
