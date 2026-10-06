package dev.happier.fileactions

import android.content.Intent
import android.net.Uri
import android.webkit.MimeTypeMap
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.ConscryptMode
import org.robolectric.annotation.GraphicsMode
import org.robolectric.annotation.SQLiteMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], manifest = Config.NONE)
// Intent construction uses no graphics, database, or TLS native runtime.
@GraphicsMode(GraphicsMode.Mode.LEGACY)
@SQLiteMode(SQLiteMode.Mode.LEGACY)
@ConscryptMode(ConscryptMode.Mode.OFF)
class FileIntentTest {
  @Test
  fun authoritativeMimeSurvivesAnExtensionlessArtifactTitle() {
    val uri = Uri.parse("content://dev.happier.downloads/downloads/report")
    val intent = AndroidFileActions.fileIntent(uri, "Quarterly report", share = true, explicitMimeType = "application/pdf")
    assertEquals(Intent.ACTION_SEND, intent.action)
    assertEquals("application/pdf", intent.type)
    assertEquals(uri, intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM))
    assertEquals(uri, intent.clipData!!.getItemAt(0).uri)
    assertEquals(Intent.FLAG_GRANT_READ_URI_PERMISSION, intent.flags)
  }

  @Test
  fun ordinaryOpenAndShareStillUseTheFilenameMime() {
    // Robolectric's MIME map is empty; supply the genuine Android SDK boundary.
    shadowOf(MimeTypeMap.getSingleton()).addExtensionMimeTypeMapping("mp4", "video/mp4")
    val uri = Uri.parse("content://dev.happier.downloads/downloads/clip.mp4")
    val open = AndroidFileActions.fileIntent(uri, "clip.MP4", share = false)
    val share = AndroidFileActions.fileIntent(uri, "clip.MP4", share = true)
    assertEquals("video/mp4", open.type)
    assertEquals("video/mp4", share.type)
    assertEquals(uri, open.data)
    assertEquals(Intent.ACTION_VIEW, open.action)
    assertEquals(Intent.ACTION_SEND, share.action)
  }
}
