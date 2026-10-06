package dev.happier.fileactions

import android.content.Intent
import android.net.Uri
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.ConscryptMode
import org.robolectric.annotation.GraphicsMode
import org.robolectric.annotation.SQLiteMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], manifest = Config.NONE)
@GraphicsMode(GraphicsMode.Mode.LEGACY)
@SQLiteMode(SQLiteMode.Mode.LEGACY)
@ConscryptMode(ConscryptMode.Mode.OFF)
class FileChooserTest {
  @Test
  fun preservesExportTitleAndReadOnlyGrantOnChooserAndTarget() {
    val uri = Uri.parse("content://dev.happier.downloads/downloads/diagnostics.json")
    val target = AndroidFileActions.fileIntent(uri, "diagnostics.json", share = true)
    val chooser = AndroidFileActions.chooserIntent(target, "Export diagnostics")
    assertEquals(Intent.ACTION_CHOOSER, chooser.action)
    assertEquals("Export diagnostics", chooser.getCharSequenceExtra(Intent.EXTRA_TITLE))
    assertEquals(uri, chooser.clipData!!.getItemAt(0).uri)
    assertEquals(Intent.FLAG_GRANT_READ_URI_PERMISSION, chooser.flags)
    val handedOff = chooser.getParcelableExtra<Intent>(Intent.EXTRA_INTENT)!!
    assertEquals(Intent.ACTION_SEND, handedOff.action)
    assertEquals(uri, handedOff.getParcelableExtra<Uri>(Intent.EXTRA_STREAM))
    assertEquals(Intent.FLAG_GRANT_READ_URI_PERMISSION, handedOff.flags)
  }
}
