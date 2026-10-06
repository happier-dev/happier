package dev.happier.fileactions

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.webkit.MimeTypeMap
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.Implementation
import org.robolectric.annotation.Implements
import java.io.File

// AndroidX 1.17.0's SimplePathStrategy.belongsToRoot assumes Android's '/' separator.
// Robolectric uses host java.io.File paths; normalize only this Android OS boundary
// on Windows, retaining real manifest parsing, URI encoding, canonicalization and I/O.
@Implements(className = "androidx.core.content.FileProvider\$SimplePathStrategy", isInAndroidSdk = false)
class HostFileProviderPathShadow {
  @Implementation
  protected fun belongsToRoot(filePath: String, rootPath: String): Boolean {
    val androidFilePath = filePath.replace(File.separatorChar, '/').trimEnd('/')
    val androidRootPath = rootPath.replace(File.separatorChar, '/').trimEnd('/')
    return androidFilePath.startsWith("$androidRootPath/")
  }
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], shadows = [HostFileProviderPathShadow::class], instrumentedPackages = ["androidx.core.content"])
class AndroidFileActionsTest {
  @Before
  fun installAndroidMimeTypeResponse() {
    // Robolectric 4.14.1's ShadowMimeTypeMap starts empty; seed the genuine OS boundary.
    // https://github.com/robolectric/robolectric/blob/robolectric-4.14.1/shadows/framework/src/main/java/org/robolectric/shadows/ShadowMimeTypeMap.java
    shadowOf(MimeTypeMap.getSingleton()).addExtensionMimeTypeMapping("mp4", "video/mp4")
  }

  @Test
  fun opensMp4WithViewContentUriAndReadOnlyGrant() {
    val uri = Uri.parse("content://dev.happier.downloads/downloads/clip.mp4")
    val intent = AndroidFileActions.fileIntent(uri, "clip.MP4", share = false)
    assertEquals(Intent.ACTION_VIEW, intent.action)
    assertEquals("video/mp4", intent.type)
    assertEquals(uri, intent.data)
    assertEquals(uri, intent.clipData!!.getItemAt(0).uri)
    assertEquals(Intent.FLAG_GRANT_READ_URI_PERMISSION, intent.flags)
  }

  @Test
  fun sharesOnlyAsAnExplicitSendActionWithTypedContentStream() {
    val uri = Uri.parse("content://dev.happier.downloads/downloads/clip.mp4")
    val intent = AndroidFileActions.fileIntent(uri, "clip.mp4", share = true)
    assertEquals(Intent.ACTION_SEND, intent.action)
    assertEquals("video/mp4", intent.type)
    assertEquals(uri, intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM))
    assertEquals(uri, intent.clipData!!.getItemAt(0).uri)
    assertEquals(Intent.FLAG_GRANT_READ_URI_PERMISSION, intent.flags)
  }

  @Test
  fun asksUserForADurableDocumentWithOriginalNameAndTypeAndHandlesCancel() {
    val options = SaveDocumentOptions("recording.mp4", "video/mp4")
    val contract = SaveDocumentContract()
    val intent = contract.createIntent(RuntimeEnvironment.getApplication(), options)
    assertEquals(Intent.ACTION_CREATE_DOCUMENT, intent.action)
    assertTrue(intent.categories!!.contains(Intent.CATEGORY_OPENABLE))
    assertEquals("video/mp4", intent.type)
    assertEquals("recording.mp4", intent.getStringExtra(Intent.EXTRA_TITLE))
    assertNull(contract.parseResult(options, Activity.RESULT_CANCELED, null))
    val uri = "content://com.android.providers.downloads.documents/document/42"
    assertEquals(uri, contract.parseResult(options, Activity.RESULT_OK, Intent().setData(Uri.parse(uri))))
  }

  @Test
  fun allowsOnlyActualFilesInsideTheCanonicalDownloadCache() {
    val context = RuntimeEnvironment.getApplication()
    val download = File(context.cacheDir, "happier-downloads/clip.mp4")
    download.parentFile!!.mkdirs()
    download.writeBytes(byteArrayOf(1, 2, 3))
    assertEquals(download.canonicalFile, AndroidFileActions.checkedDownloadFile(context, Uri.fromFile(download).toString()))
    val contentUri = AndroidFileActions.contentUri(context, download, "clip.mp4")
    assertEquals("content", contentUri.scheme)
    assertEquals(context.packageName + ".happier-file-actions", contentUri.authority)
    context.contentResolver.openInputStream(contentUri).use { input ->
      assertArrayEquals(byteArrayOf(1, 2, 3), input!!.readBytes())
    }
    val privateFile = File(context.filesDir, "secret.txt").apply { writeText("private") }
    assertThrows(IllegalArgumentException::class.java) {
      AndroidFileActions.checkedDownloadFile(context, Uri.fromFile(privateFile).toString())
    }
    assertThrows(IllegalArgumentException::class.java) {
      AndroidFileActions.contentUri(context, privateFile, "secret.txt")
    }
    val sibling = File(context.cacheDir, "happier-downloads-other/secret.txt")
    sibling.parentFile!!.mkdirs()
    sibling.writeText("private")
    assertThrows(IllegalArgumentException::class.java) {
      AndroidFileActions.checkedDownloadFile(context, Uri.fromFile(sibling).toString())
    }
    assertThrows(IllegalArgumentException::class.java) {
      AndroidFileActions.contentUri(context, sibling, "secret.txt")
    }
    val escapedUri = contentUri.buildUpon()
      .encodedPath("/downloads/..%2Fhappier-downloads-other%2Fsecret.txt")
      .build()
    assertThrows(SecurityException::class.java) {
      context.contentResolver.openInputStream(escapedUri)
    }
    assertThrows(IllegalArgumentException::class.java) {
      AndroidFileActions.checkedDownloadFile(context, "content://other/file")
    }
  }
}
