package dev.happier.composerinput

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.ContentProvider
import android.content.ContentValues
import android.database.MatrixCursor
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import android.graphics.Color
import android.view.ContextThemeWrapper
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import com.swmansion.enriched.markdown.spans.ReferenceChipSpan
import org.json.JSONObject
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.BaseInputConnection
import androidx.core.view.ContentInfoCompat
import androidx.core.view.ViewCompat
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Robolectric
import android.app.Activity
import android.content.pm.ProviderInfo
import org.robolectric.shadows.ShadowContentResolver
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import android.os.Looper
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.ConscryptMode
import org.robolectric.annotation.GraphicsMode
import org.robolectric.annotation.SQLiteMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], manifest = Config.NONE)
@GraphicsMode(GraphicsMode.Mode.LEGACY)
@SQLiteMode(SQLiteMode.Mode.LEGACY)
@ConscryptMode(ConscryptMode.Mode.OFF)
class ComposerEditTextTest {
  private val token = "[Auth](happier-ref:session:auth)"
  private val prefix = "😀 a "

  @Test fun preImeBackForwardsOnceOnlyForAnOptedInFocusedEditor() {
    val editor = editor()
    val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
    activity.setContentView(editor)
    editor.requestFocus()
    val text = editor.text.toString()
    val selection = editor.selectionStart
    var forwarded = 0
    editor.onHardwareBack = { forwarded += 1; true }
    fun back(action: Int, repeat: Int = 0, flags: Int = 0) = editor.dispatchKeyEventPreIme(
      KeyEvent(0, 0, action, KeyEvent.KEYCODE_BACK, repeat, 0, 0, 0, flags),
    )

    back(KeyEvent.ACTION_DOWN)
    back(KeyEvent.ACTION_UP)
    assertEquals(0, forwarded)
    editor.forwardHardwareBack = true
    assertTrue(back(KeyEvent.ACTION_DOWN))
    back(KeyEvent.ACTION_DOWN, repeat = 1)
    assertEquals(0, forwarded)
    assertTrue(back(KeyEvent.ACTION_UP))
    assertEquals(1, forwarded)
    assertEquals(text, editor.text.toString())
    assertEquals(selection, editor.selectionStart)

    back(KeyEvent.ACTION_DOWN)
    back(KeyEvent.ACTION_UP, flags = KeyEvent.FLAG_CANCELED)
    assertEquals(1, forwarded)
    editor.isFocusable = false
    editor.clearFocus()
    assertFalse(editor.hasFocus())
    back(KeyEvent.ACTION_DOWN)
    back(KeyEvent.ACTION_UP)
    assertEquals(1, forwarded)
    activity.finish()
  }

  @Test fun treeUriDropRetainsRelativeEntriesAndEmptyDirectoriesAfterTheProviderGrantEnds() {
    val context = RuntimeEnvironment.getApplication()
    val providerFile = File.createTempFile("composer-provider", ".svg", context.cacheDir).apply { writeText("svg") }
    val provider = object : ContentProvider() {
      override fun onCreate() = true
      override fun getType(uri: Uri) = if (DocumentsContract.getDocumentId(uri) == "icon") "image/svg+xml" else DocumentsContract.Document.MIME_TYPE_DIR
      override fun query(uri: Uri, projection: Array<out String>?, selection: String?, args: Array<out String>?, sort: String?): MatrixCursor {
        val columns = projection ?: arrayOf(OpenableColumns.DISPLAY_NAME)
        val ids = if (uri.path!!.endsWith("/children")) when (DocumentsContract.getDocumentId(uri)) {
          "root" -> listOf("icons", "empty")
          "icons" -> listOf("icon")
          else -> emptyList()
        } else listOf(DocumentsContract.getDocumentId(uri))
        return MatrixCursor(columns).apply { for (id in ids) addRow(columns.map { column -> when (column) {
          DocumentsContract.Document.COLUMN_DOCUMENT_ID -> id
          OpenableColumns.DISPLAY_NAME -> when (id) { "root" -> "Design"; "icon" -> "a.svg"; else -> id }
          DocumentsContract.Document.COLUMN_MIME_TYPE -> if (id == "icon") "image/svg+xml" else DocumentsContract.Document.MIME_TYPE_DIR
          else -> null
        } }.toTypedArray()) }
      }
      override fun openFile(uri: Uri, mode: String) = ParcelFileDescriptor.open(providerFile, ParcelFileDescriptor.MODE_READ_ONLY)
      override fun insert(uri: Uri, values: ContentValues?): Uri? = null
      override fun delete(uri: Uri, selection: String?, args: Array<out String>?) = 0
      override fun update(uri: Uri, values: ContentValues?, selection: String?, args: Array<out String>?) = 0
    }
    provider.attachInfo(context, ProviderInfo().apply { authority = "composer.documents"; exported = true })
    ShadowContentResolver.registerProviderInternal("composer.documents", provider)
    val source = ComposerAttachmentDrop.read(context, Uri.parse("content://composer.documents/tree/root"))
    assertEquals("folder", source["kind"])
    assertEquals("Design", source["name"])
    assertEquals(setOf("icons", "empty"), (source["directories"] as List<*>).toSet())
    val entries = source["entries"] as List<*>
    assertEquals(1, entries.size)
    val entry = entries[0] as Map<*, *>
    assertEquals("icons/a.svg", entry["relativePath"])
    val file = entry["source"] as Map<*, *>
    val cached = File(requireNotNull(Uri.parse(file["uri"] as String).path))
    providerFile.delete()
    assertEquals("native", file["kind"])
    assertEquals("svg", cached.readText())
    cached.parentFile!!.deleteRecursively()
  }

  @Test fun receiveContentRoutesOnlyDroppedUrisToAttachmentIntakeAtTheCaret() {
    val editor = editor()
    val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
    activity.setContentView(editor)
    editor.acceptsAttachmentDrops = true
    editor.setSelection(prefix.length)
    val received = CountDownLatch(1)
    var payload: Map<String, Any>? = null
    editor.onComposerAttachmentDrop = { payload = it; received.countDown() }
    val file = File.createTempFile("composer-drop", ".txt", editor.context.cacheDir).apply { writeText("drop") }
    val clip = ClipData.newRawUri("file", Uri.fromFile(file))
    assertNull(ViewCompat.performReceiveContent(editor, ContentInfoCompat.Builder(clip, ContentInfoCompat.SOURCE_INPUT_METHOD).build()))
    assertNull(payload)
    assertNull(ViewCompat.performReceiveContent(editor, ContentInfoCompat.Builder(clip, ContentInfoCompat.SOURCE_DRAG_AND_DROP).build()))
    // The native provider read runs off the UI thread; drain only the main dispatcher while it finishes.
    val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
    while (received.count > 0 && System.nanoTime() < deadline) { shadowOf(Looper.getMainLooper()).idle(); Thread.yield() }
    assertTrue(received.await(0, TimeUnit.MILLISECONDS))
    assertEquals(prefix.length, payload!!["offset"])
    assertEquals(prefix + token + " z", editor.text.toString())
    assertNotEquals(true, payload!!["error"])
    val sources = payload!!["sources"] as List<*>
    val source = sources[0] as Map<*, *>
    assertEquals("native", source["kind"])
    file.delete()
    File(requireNotNull(Uri.parse(source["uri"] as String).path)).parentFile!!.deleteRecursively()
  }

  private fun editor(): ComposerEditText {
    val context = ContextThemeWrapper(RuntimeEnvironment.getApplication(), androidx.appcompat.R.style.Theme_AppCompat)
    return ComposerEditText(context).apply {
      layoutParams = ViewGroup.LayoutParams(600, ViewGroup.LayoutParams.WRAP_CONTENT)
      setTypographyTokens(mapOf("fontSize" to 14, "lineHeight" to 22, "chipHeight" to 20, "chipRadius" to 6, "chipMaxLabelWidth" to 190))
      setControlledDocument(prefix + token + " z", 0, listOf(mapOf("start" to prefix.length, "end" to prefix.length + token.length,
        "token" to token, "ref" to "session:auth", "label" to "Auth", "kind" to "session", "state" to "ready",
        "marker" to "@Session \"Auth\"", "accessibilityLabel" to "Session, Auth")), emptyList())
      measure(View.MeasureSpec.makeMeasureSpec(600, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(400, View.MeasureSpec.AT_MOST))
      layout(0, 0, 600, measuredHeight)
    }
  }

  @Test @GraphicsMode(GraphicsMode.Mode.NATIVE)
  fun controlledTextThatAddsLinesReportsItsNewContentHeight() {
    val context = ContextThemeWrapper(RuntimeEnvironment.getApplication(), androidx.appcompat.R.style.Theme_AppCompat)
    val editor = ComposerEditText(context).apply {
      layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
      setTypographyTokens(mapOf("fontSize" to 14, "lineHeight" to 22))
    }
    val heights = mutableListOf<Float>()
    editor.onComposerHeight = { heights.add(it) }
    // The React Native host sizes the editor exactly and relays a layout the editor requests
    // (ExpoView.shouldUseAndroidLayout); it never re-measures on its own.
    val hostHeight = 60
    fun hostPass() {
      editor.measure(View.MeasureSpec.makeMeasureSpec(600, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(hostHeight, View.MeasureSpec.EXACTLY))
      editor.layout(0, 0, 600, hostHeight)
    }
    editor.setControlledDocument("One line", 0, null, null)
    hostPass()
    val oneLine = heights.last()
    // A draft restored after mount arrives as a controlled value, not as typing.
    editor.setControlledDocument("Reply exactly DOCK NATIVE QA OK. ".repeat(8), 0, null, null)
    if (editor.isLayoutRequested) hostPass()
    assertTrue("reported ${heights.last()} after one line at $oneLine", heights.last() > oneLine * 2)
  }

  @Test fun hardwareBackspaceSelectsThenDeletesOneWholeChip() {
    val editor = editor()
    editor.setSelection(prefix.length + token.length)
    editor.onKeyDown(KeyEvent.KEYCODE_DEL, KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_DEL))
    assertEquals(prefix.length, editor.selectionStart)
    assertEquals(prefix.length + token.length, editor.selectionEnd)
    assertEquals(prefix + token + " z", editor.text.toString())
    editor.onKeyDown(KeyEvent.KEYCODE_DEL, KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_DEL))
    assertEquals(prefix + " z", editor.text.toString())
    assertTrue(editor.referenceSnapshots().isEmpty())
  }

  @Test fun undoAfterControlledEmptyReferenceEchoRestoresTypedSpanAndRedoRemovesIt() {
    val editor = editor()
    editor.setSelection(prefix.length + token.length)
    repeat(2) { editor.onKeyDown(KeyEvent.KEYCODE_DEL, KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_DEL)) }
    editor.setControlledDocument(editor.text.toString(), editor.nativeEventCount, emptyList(), emptyList())
    assertTrue(editor.onKeyShortcut(KeyEvent.KEYCODE_Z,
      KeyEvent(0, 0, KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_Z, 0, KeyEvent.META_CTRL_ON)))
    assertEquals(prefix + token + " z", editor.text.toString())
    val span = editor.text!!.getSpans(0, editor.length(), ComposerChipSpan::class.java).single()
    assertEquals("session:auth", span.reference.ref)
    assertEquals(listOf(mapOf("ref" to "session:auth", "token" to token, "start" to prefix.length,
      "end" to prefix.length + token.length)), editor.referenceSnapshots())
    editor.setSelection(prefix.length, prefix.length + token.length)
    editor.onTextContextMenuItem(android.R.id.copy)
    val clipboard = editor.context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    assertEquals("@Session \"Auth\"", clipboard.primaryClip!!.getItemAt(0).text.toString())
    assertTrue(editor.onKeyShortcut(KeyEvent.KEYCODE_Y,
      KeyEvent(0, 0, KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_Y, 0, KeyEvent.META_CTRL_ON)))
    assertEquals(prefix + " z", editor.text.toString())
    assertTrue(editor.referenceSnapshots().isEmpty())
    assertTrue(editor.onTextContextMenuItem(android.R.id.undo))
    editor.setSelection(prefix.length + token.length)
    editor.onCreateInputConnection(EditorInfo())!!.commitText("!", 1)
    assertEquals(prefix + token + "! z", editor.text.toString())
    assertEquals("session:auth", editor.referenceSnapshots().single()["ref"])
    assertFalse(editor.onTextContextMenuItem(android.R.id.redo))
  }

  @Test @GraphicsMode(GraphicsMode.Mode.NATIVE)
  fun largeChipFitsMeasuredContentWidthAndRemeasuresAfterResize() {
    val editor = editor()
    editor.setTypographyTokens(mapOf("fontSize" to 28, "chipHeight" to 40, "chipRadius" to 12,
      "chipMaxLabelWidth" to 380, "chipPaddingLeft" to 8, "chipPaddingRight" to 12,
      "chipGlyphSize" to 28, "chipGap" to 8))
    editor.setControlledDocument(null, editor.nativeEventCount, listOf(mapOf("start" to prefix.length, "end" to prefix.length + token.length,
      "token" to token, "ref" to "session:auth", "label" to "A very long reference title with enough words to fill a large chip",
      "accessibilityLabel" to "Full Session reference title")), null)
    editor.setPadding(16, 0, 24, 0)
    fun chipWidth(width: Int): Int {
      editor.measure(View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(500, View.MeasureSpec.AT_MOST))
      editor.layout(0, 0, width, editor.measuredHeight)
      val span = editor.text!!.getSpans(0, editor.length(), ComposerChipSpan::class.java).single()
      assertEquals("Full Session reference title", span.contentDescription)
      return span.getSize(editor.paint, editor.text!!, prefix.length, prefix.length + token.length, null)
    }
    val narrow = chipWidth(240)
    assertTrue("chip width $narrow exceeds content width", narrow <= 200)
    val wide = chipWidth(500)
    assertTrue(wide > narrow)
    assertTrue(wide <= 460)
    assertEquals(narrow, chipWidth(240))
  }

  @Test @GraphicsMode(GraphicsMode.Mode.NATIVE)
  fun transcriptChipFitsRegisteredTextViewWidthAtLargeFontAndAfterResize() {
    val host = TextView(RuntimeEnvironment.getApplication()).apply {
      setPadding(8, 0, 8, 0)
      textSize = 32f
    }
    val anatomy = JSONObject().put("baseFontSize", 14).put("height", 20).put("radius", 6)
      .put("maxLabelWidth", 240).put("paddingLeft", 4).put("paddingRight", 6)
      .put("glyphSize", 14).put("gap", 4).put("thumbnailRadius", 2)
    val span = ReferenceChipSpan(host.context,
      JSONObject().put("label", "A long Session reference title that needs to fit a phone"),
      JSONObject().put("fontSize", 14).put("anatomy", anatomy))
    span.registerTextView(host)
    host.layout(0, 0, 180, 100)
    val narrow = span.getSize(host.paint, "label", 0, 5, null)
    assertTrue("transcript chip width $narrow exceeds 164", narrow <= 164)
    host.layout(0, 0, 300, 100)
    val wide = span.getSize(host.paint, "label", 0, 5, null)
    assertTrue(wide > narrow)
    assertTrue(wide <= 284)
  }

  @Test fun softwareKeyboardDeleteAndCodePointDeleteRespectTheSameTwoPressContract() {
    for (codePoints in listOf(false, true)) {
      val editor = editor()
      editor.setSelection(prefix.length + token.length)
      val connection = editor.onCreateInputConnection(EditorInfo())!!
      if (codePoints) connection.deleteSurroundingTextInCodePoints(1, 0) else connection.deleteSurroundingText(1, 0)
      assertEquals(token, editor.text!!.subSequence(editor.selectionStart, editor.selectionEnd).toString())
      if (codePoints) connection.deleteSurroundingTextInCodePoints(1, 0) else connection.deleteSurroundingText(1, 0)
      assertEquals(prefix + " z", editor.text.toString())
    }
  }

  @Test fun forwardDeleteAndCommitOverASelectedChipAreAtomic() {
    val forward = editor()
    forward.setSelection(prefix.length)
    forward.onKeyDown(KeyEvent.KEYCODE_FORWARD_DEL, KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_FORWARD_DEL))
    assertEquals(prefix + " z", forward.text.toString())
    val replacement = editor()
    replacement.setSelection(prefix.length + 2, prefix.length + token.length - 2)
    replacement.onCreateInputConnection(EditorInfo())!!.commitText("替", 1)
    assertEquals(prefix + "替 z", replacement.text.toString())
  }

  @Test fun selectionAndArrowsUseUtf16SourceEdgesIncludingEmoji() {
    val editor = editor()
    editor.setSelection(prefix.length + 2)
    assertEquals(prefix.length, editor.selectionStart)
    editor.onKeyDown(KeyEvent.KEYCODE_DPAD_RIGHT, KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_DPAD_RIGHT))
    assertEquals(prefix.length + token.length, editor.selectionStart)
    editor.onKeyDown(KeyEvent.KEYCODE_DPAD_LEFT, KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_DPAD_LEFT))
    assertEquals(prefix.length, editor.selectionStart)
  }

  @Test fun compositionDoesNotSplitChipsAndDefersControlledChangesUntilFinish() {
    val editor = editor()
    val connection = editor.onCreateInputConnection(EditorInfo())!!
    connection.setComposingRegion(prefix.length + 1, prefix.length + token.length - 1)
    assertEquals(-1, BaseInputConnection.getComposingSpanStart(editor.text!!))
    editor.setSelection(editor.length())
    connection.setComposingText("に", 1)
    val composing = editor.text.toString()
    editor.setTextAndSelection("controlled", mapOf("start" to 10, "end" to 10), emptyList())
    assertEquals(composing, editor.text.toString())
    connection.finishComposingText()
    assertEquals("controlled", editor.text.toString())
  }

  @Test fun textSelectionAndRebasedReferencesApplyAsOneCommandAfterComposition() {
    for (composing in listOf(false, true)) {
      val editor = editor()
      editor.setSelection(editor.length())
      val connection = editor.onCreateInputConnection(EditorInfo())!!
      if (composing) connection.setComposingText("に", 1)
      val echoed = editor.text.toString()
      val count = editor.nativeEventCount
      val value = "Hi " + prefix + token + " z"
      val start = 3 + prefix.length
      val selection = mapOf("start" to 3, "end" to 3)
      editor.setTextAndSelection(value, selection, listOf(mapOf("start" to start, "end" to start + token.length,
        "token" to token, "ref" to "session:auth", "label" to "Auth", "marker" to "@Session \"Auth\"")))
      if (composing) {
        assertEquals(echoed, editor.text.toString())
        editor.setControlledDocument(echoed, count, emptyList(), emptyList())
        connection.finishComposingText()
      }
      assertEquals(value, editor.text.toString())
      assertEquals(selection, editor.sourceSelection())
      assertEquals(start, editor.referenceSnapshots().single()["start"])
      editor.setControlledDocument(value, editor.nativeEventCount, listOf(mapOf("start" to start,
        "end" to start + token.length, "token" to token, "ref" to "session:auth", "label" to "Auth")), emptyList())
      assertEquals(selection, editor.sourceSelection())
    }
  }

  @Test fun controlledBindingWithAnObsoleteTokenDoesNotCreateAChip() {
    val editor = editor()
    editor.setControlledDocument(editor.text.toString(), editor.nativeEventCount,
      listOf(mapOf("start" to prefix.length, "end" to prefix.length + token.length,
        "token" to "obsolete token", "ref" to "session:auth", "label" to "Auth")), emptyList())
    assertTrue(editor.referenceSnapshots().isEmpty())
    assertTrue(editor.text!!.getSpans(0, editor.length(), ComposerChipSpan::class.java).isEmpty())
  }

  @Test fun pointMappingUsesWindowCoordinatesAndNeverReturnsChipInterior() {
    val editor = editor()
    val layout = requireNotNull(editor.layout)
    val start = prefix.length
    val end = start + token.length
    val location = IntArray(2)
    editor.getLocationInWindow(location)
    val left = layout.getPrimaryHorizontal(start)
    val right = layout.getPrimaryHorizontal(end)
    val y = location[1] + editor.totalPaddingTop + layout.getLineBaseline(0) - editor.scrollY
    val x = location[0] + editor.totalPaddingLeft + (left + right) / 2 - editor.scrollX
    val density = editor.resources.displayMetrics.density
    assertTrue(editor.offsetAtWindowPoint(x / density, y.toFloat() / density) in listOf(start, end))
    assertNull(editor.offsetAtWindowPoint(-100f, -100f))
  }

  @Test fun clipboardProjectsMarkersAndPastesOnlyPlainText() {
    val editor = editor()
    editor.setSelection(prefix.length, prefix.length + token.length)
    assertTrue(editor.onTextContextMenuItem(android.R.id.copy))
    val clipboard = editor.context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    assertEquals("@Session \"Auth\"", clipboard.primaryClip!!.getItemAt(0).text.toString())
    clipboard.setPrimaryClip(ClipData.newHtmlText("text", "literal $token", "<b>literal</b>"))
    editor.onTextContextMenuItem(android.R.id.paste)
    assertEquals(prefix + "literal $token z", editor.text.toString())
    assertEquals(0, editor.text!!.getSpans(0, editor.length(), ComposerChipSpan::class.java).size)
  }

  @Test fun themeColorsAcceptTheActualRgbaInkTokens() {
    val editor = editor()
    editor.setThemeTokens(mapOf("text" to "rgba(30, 40, 50, 0.5)", "placeholder" to "transparent"))
    assertEquals(Color.argb(128, 30, 40, 50), editor.currentTextColor)
    assertEquals(Color.TRANSPARENT, editor.currentHintTextColor)
  }

  @Test fun receiveContentRefusalDoesNotFallThroughToTextInsertion() {
    val editor = editor()
    val before = editor.text.toString()
    val payload = ContentInfoCompat.Builder(
      ClipData.newPlainText("foreign", "foreign rich-content fallback"), ContentInfoCompat.SOURCE_DRAG_AND_DROP,
    ).build()
    assertNull(ViewCompat.performReceiveContent(editor, payload))
    assertEquals(before, editor.text.toString())
  }

  @Test fun controlledAppendKeepsAnUnchangedChipAndPlainTypingDoesNotCreateOne() {
    val editor = editor()
    editor.setControlledDocument(editor.text.toString() + "!", editor.nativeEventCount, null, null)
    assertEquals(1, editor.text!!.getSpans(0, editor.length(), ComposerChipSpan::class.java).size)
    editor.setSelection(editor.length())
    editor.onCreateInputConnection(EditorInfo())!!.commitText(" $token", 1)
    assertEquals(1, editor.text!!.getSpans(0, editor.length(), ComposerChipSpan::class.java).size)
  }

  @Test fun accessibilityExposesOneLabeledActivatableNodePerChip() {
    val editor = editor()
    var activated: String? = null
    editor.onComposerReference = { activated = it }
    val provider = editor.accessibilityNodeProvider!!
    val node = provider.createAccessibilityNodeInfo(0)!!
    assertEquals("Session, Auth", node.contentDescription)
    assertTrue(provider.performAction(0, android.view.accessibility.AccessibilityNodeInfo.ACTION_CLICK, null))
    assertEquals("session:auth", activated)
  }

  @Test fun enterToSendLeavesShiftEnterAndComposingEnterAsInput() {
    val editor = editor()
    editor.submitBehavior = "submit"
    var submissions = 0
    editor.onComposerSubmit = { submissions++ }
    editor.setSelection(editor.length())
    editor.onKeyDown(KeyEvent.KEYCODE_ENTER, KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_ENTER))
    assertEquals(1, submissions)
    val shift = KeyEvent(0, 0, KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_ENTER, 0, KeyEvent.META_SHIFT_ON)
    editor.onKeyDown(KeyEvent.KEYCODE_ENTER, shift)
    assertEquals(1, submissions)
    editor.onCreateInputConnection(EditorInfo())!!.setComposingText("に", 1)
    editor.onKeyDown(KeyEvent.KEYCODE_ENTER, KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_ENTER))
    assertEquals(1, submissions)
  }

  @Test fun softwareKeyboardReportsKeysAndNewlineUsesNativeSubmitBehavior() {
    val editor = editor()
    val keys = mutableListOf<String>()
    editor.onComposerKey = { keys.add(it.getValue("key") as String) }
    editor.submitBehavior = "submit"
    var submissions = 0
    editor.onComposerSubmit = { submissions++ }
    editor.setSelection(editor.length())
    val connection = editor.onCreateInputConnection(EditorInfo())!!
    connection.commitText("a", 1)
    assertEquals("a", keys.last())
    connection.deleteSurroundingText(1, 0)
    assertEquals("Backspace", keys.last())
    val before = editor.text.toString()
    connection.commitText("\n", 1)
    assertEquals(1, submissions)
    assertEquals(before, editor.text.toString())
  }

  @Test fun submitProducingEnterReportsOneIntentWithItsModifiers() {
    val editor = editor()
    editor.submitBehavior = "submit"
    val keys = mutableListOf<Map<String, Any>>()
    val submits = mutableListOf<Map<String, Any>>()
    editor.onComposerKey = { keys.add(it) }
    editor.onComposerSubmit = { submits.add(it) }
    val event = KeyEvent(0, 0, KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_ENTER, 0, KeyEvent.META_CTRL_ON)
    assertTrue(editor.dispatchKeyEvent(event))
    editor.dispatchKeyEvent(KeyEvent.changeAction(event, KeyEvent.ACTION_UP))
    assertEquals(1, keys.size)
    assertEquals(true, keys.single()["submitting"])
    assertEquals(1, submits.size)
    assertEquals(true, submits.single()["ctrlKey"])
    keys.clear(); submits.clear()
    editor.setSelection(editor.length())
    editor.onCreateInputConnection(EditorInfo())!!.commitText("\n", 1)
    assertEquals(1, keys.size)
    assertEquals(true, keys.single()["submitting"])
    assertEquals(1, submits.size)
    assertEquals(false, submits.single()["ctrlKey"])
    keys.clear(); submits.clear()
    editor.onCreateInputConnection(EditorInfo())!!.performEditorAction(EditorInfo.IME_ACTION_SEND)
    assertEquals(1, submits.size)
    assertEquals("Enter", submits.single()["key"])
    assertTrue(keys.isEmpty())
  }

  @Test fun staleControlledEchoCannotReplaceACommittedComposition() {
    val editor = editor()
    editor.setSelection(editor.length())
    val connection = editor.onCreateInputConnection(EditorInfo())!!
    connection.setComposingText("に", 1)
    val intermediate = editor.text.toString()
    val intermediateCount = editor.nativeEventCount
    editor.setControlledDocument(intermediate, intermediateCount, emptyList(), emptyList())
    connection.commitText("日本", 1)
    val committed = editor.text.toString()
    assertTrue(committed.endsWith("日本"))
    assertTrue(editor.nativeEventCount > intermediateCount)
    editor.setControlledDocument(intermediate, intermediateCount, emptyList(), emptyList())
    assertEquals(committed, editor.text.toString())
    editor.setControlledDocument("accepted", editor.nativeEventCount, emptyList(), emptyList())
    assertEquals("accepted", editor.text.toString())
  }
}
