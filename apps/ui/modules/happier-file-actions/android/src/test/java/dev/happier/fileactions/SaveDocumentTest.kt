package dev.happier.fileactions

import android.content.pm.ProviderInfo
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import android.os.CancellationSignal
import android.os.ParcelFileDescriptor
import android.provider.DocumentsContract
import android.provider.DocumentsProvider
import java.io.File
import java.io.FileOutputStream
import java.io.FilterOutputStream
import java.io.IOException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.ConscryptMode
import org.robolectric.annotation.GraphicsMode
import org.robolectric.annotation.SQLiteMode
import org.robolectric.shadows.ShadowContentResolver
import kotlin.coroutines.CoroutineContext

// The document provider and output stream are Android OS boundaries. The real
// save owner and DocumentsContract/ContentResolver path remain in use.
class SaveTestDocumentsProvider : DocumentsProvider() {
  lateinit var document: File
  var refuseDeletion = false

  override fun onCreate() = true
  override fun queryRoots(projection: Array<out String>?) = MatrixCursor(arrayOf(DocumentsContract.Root.COLUMN_ROOT_ID))
  override fun queryDocument(documentId: String, projection: Array<out String>?): Cursor =
    MatrixCursor(arrayOf(DocumentsContract.Document.COLUMN_DOCUMENT_ID)).apply { addRow(arrayOf(documentId)) }
  override fun queryChildDocuments(parentDocumentId: String, projection: Array<out String>?, sortOrder: String?) =
    MatrixCursor(arrayOf(DocumentsContract.Document.COLUMN_DOCUMENT_ID))
  override fun openDocument(documentId: String, mode: String, signal: CancellationSignal?): ParcelFileDescriptor =
    ParcelFileDescriptor.open(document, ParcelFileDescriptor.parseMode(mode))
  override fun deleteDocument(documentId: String) {
    if (refuseDeletion) throw UnsupportedOperationException("Provider refuses document deletion")
    check(document.delete()) { "Document deletion failed" }
  }
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], manifest = Config.NONE)
// Saving uses no graphics, database, or TLS; avoid unrelated native runtimes
// which Robolectric 4.14.1 does not provide for Linux ARM hosts.
@GraphicsMode(GraphicsMode.Mode.LEGACY)
@SQLiteMode(SQLiteMode.Mode.LEGACY)
@ConscryptMode(ConscryptMode.Mode.OFF)
class SaveDocumentTest {
  private val context get() = RuntimeEnvironment.getApplication()
  private lateinit var provider: SaveTestDocumentsProvider
  private lateinit var source: File
  private lateinit var uri: Uri

  @Before
  fun createSelectedDocument() {
    source = File(context.cacheDir, "source.mp4").apply { writeBytes(byteArrayOf(1, 2, 3, 4)) }
    provider = SaveTestDocumentsProvider().apply {
      document = File(this@SaveDocumentTest.context.cacheDir, "selected-document.mp4").apply { writeBytes(byteArrayOf()) }
      attachInfo(this@SaveDocumentTest.context, ProviderInfo().apply {
        authority = "dev.happier.test.documents"
        exported = true
        grantUriPermissions = true
        readPermission = "android.permission.MANAGE_DOCUMENTS"
        writePermission = "android.permission.MANAGE_DOCUMENTS"
      })
    }
    ShadowContentResolver.registerProviderInternal("dev.happier.test.documents", provider)
    uri = DocumentsContract.buildDocumentUri("dev.happier.test.documents", "selected-document")
  }

  @Test
  fun successfulSaveRetainsTheCompleteDocument() = runBlocking {
    AndroidFileActions.copyToDocument(context, source, uri.toString())
    assertArrayEquals(source.readBytes(), provider.document.readBytes())
  }

  @Test
  fun failedWriteDeletesThePartiallyWrittenDocumentAndRetainsTheCause() = runBlocking {
    val failure = IOException("Destination is full")
    shadowOf(context.contentResolver).registerOutputStream(uri, object : FilterOutputStream(FileOutputStream(provider.document)) {
      override fun write(bytes: ByteArray, offset: Int, length: Int) {
        out.write(bytes, offset, 1)
        throw failure
      }
    })
    val thrown = runCatching { AndroidFileActions.copyToDocument(context, source, uri.toString()) }.exceptionOrNull()
    assertTrue(thrown is IOException)
    assertEquals(failure.message, thrown?.message)
    assertFalse("Failed save left a partial document", provider.document.exists())
  }

  @Test
  fun failedStreamCloseDeletesTheDocument() = runBlocking {
    val failure = IOException("Destination close failed")
    shadowOf(context.contentResolver).registerOutputStream(uri, object : FilterOutputStream(FileOutputStream(provider.document)) {
      override fun close() { super.close(); throw failure }
    })
    val thrown = runCatching { AndroidFileActions.copyToDocument(context, source, uri.toString()) }.exceptionOrNull()
    assertTrue(thrown is IOException)
    assertEquals(failure.message, thrown?.message)
    assertFalse("Failed close left a document", provider.document.exists())
  }

  @Test
  fun canceledCopyDeletesTheDocument() = runBlocking {
    lateinit var saveContext: CoroutineContext
    shadowOf(context.contentResolver).registerOutputStream(uri, object : FilterOutputStream(FileOutputStream(provider.document)) {
      override fun write(bytes: ByteArray, offset: Int, length: Int) {
        out.write(bytes, offset, length)
        saveContext.cancel(CancellationException("Save canceled"))
      }
    })
    val save = async {
      saveContext = currentCoroutineContext()
      AndroidFileActions.copyToDocument(context, source, uri.toString())
    }
    val thrown = runCatching { save.await() }.exceptionOrNull()
    assertTrue(thrown is CancellationException)
    assertFalse("Canceled copy left a document", provider.document.exists())
  }

  @Test
  fun failedCleanupReportsTheRemainingDocumentAndOriginalFailure() = runBlocking {
    provider.refuseDeletion = true
    val failure = IOException("Destination is full")
    shadowOf(context.contentResolver).registerOutputStream(uri, object : FilterOutputStream(FileOutputStream(provider.document)) {
      override fun write(bytes: ByteArray, offset: Int, length: Int) { out.write(bytes, offset, 1); throw failure }
    })
    val thrown = runCatching { AndroidFileActions.copyToDocument(context, source, uri.toString()) }.exceptionOrNull()
    assertNotNull(thrown)
    assertTrue(provider.document.exists())
    assertTrue("Cleanup failure did not identify the remaining document", thrown!!.message.orEmpty().contains(uri.toString()))
    assertTrue("Original save failure was lost", generateSequence(thrown) { it.cause }.any { it.message == failure.message })
    assertTrue("Provider cleanup failure was lost", generateSequence(thrown) { it.cause }.any { it.suppressed.isNotEmpty() })
  }
}
