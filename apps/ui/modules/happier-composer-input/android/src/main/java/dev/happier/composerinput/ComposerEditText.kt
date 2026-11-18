package dev.happier.composerinput

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.ContextWrapper
import android.app.Activity
import android.net.Uri
import android.view.DragAndDropPermissions
import android.content.res.Configuration
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Rect
import android.graphics.Typeface
import android.os.Build
import android.os.Bundle
import android.text.Editable
import android.text.InputFilter
import android.text.InputType
import android.text.Selection
import android.text.Spanned
import android.text.TextWatcher
import android.text.TextPaint
import android.text.style.ForegroundColorSpan
import android.text.style.BackgroundColorSpan
import android.text.style.TypefaceSpan
import android.text.style.MetricAffectingSpan
import android.text.style.UnderlineSpan
import android.util.TypedValue
import android.view.DragEvent
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityNodeProvider
import android.view.inputmethod.BaseInputConnection
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import android.view.inputmethod.InputConnectionWrapper
import android.view.inputmethod.InputContentInfo
import androidx.appcompat.widget.AppCompatEditText
import androidx.appcompat.widget.PopupMenu
import androidx.core.view.ViewCompat
import androidx.core.view.ContentInfoCompat
import com.facebook.react.common.assets.ReactFontManager
import java.lang.Character
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/** Sole Android editing owner: source text, spans, selection, composition and clipboard. */
internal class ComposerEditText(context: Context) : AppCompatEditText(context) {
  var acceptsAttachmentDrops = false
  var attachmentDropScope = ""
  var onComposerAttachmentDrop: ((Map<String, Any>) -> Unit)? = null
  var onComposerChange: ((String, Map<String, Int>, Int) -> Unit)? = null
  var onComposerSelection: ((Map<String, Int>) -> Unit)? = null
  var onComposerKey: ((Map<String, Any>) -> Unit)? = null
  var forwardHardwareBack = false
  var onHardwareBack: (() -> Boolean)? = null
  var onComposerSubmit: ((Map<String, Any>) -> Unit)? = null
  var onComposerReference: ((String) -> Unit)? = null
  var onComposerDecoration: ((String) -> Unit)? = null
  var referenceMenuLabels: Map<String, String> = emptyMap()
  private var lastTouchX = 0f
  private var lastTouchY = 0f
  private var longPressHandled = false
  var onComposerHeight: ((Float) -> Unit)? = null
  var onComposerScroll: ((Float) -> Unit)? = null
  var submitBehavior = "newline"
  var composerAccessibilityHint: String? = null
  var nativeEventCount = 0
    private set
  private data class DocumentUpdate(val value: String? = null, val selection: Map<String, Int>? = null,
    val references: List<Map<String, Any?>>? = null, val decorations: List<Map<String, Any?>>? = null,
    val eventCount: Int? = null)
  private var pendingDocument: DocumentUpdate? = null
  private var applyingControlled = false
  private var snappingSelection = false
  private var ready = false
  private data class BoundReference(val start: Int, val end: Int, val reference: ComposerReference)
  private data class EditFragment(val value: String, val references: List<BoundReference>)
  private data class NativeEdit(val start: Int, val before: EditFragment, var after: EditFragment,
    val selectionBefore: Map<String, Int>, var selectionAfter: Map<String, Int>)
  private val undoEdits = mutableListOf<NativeEdit>()
  private val redoEdits = mutableListOf<NativeEdit>()
  private var editing: NativeEdit? = null
  private var chipContainerWidth = 0
  private var decorationSpecs = emptyList<Map<String, Any?>>()
  private var decorationSpans = mutableListOf<Any>()
  private var theme = emptyMap<String, Any?>()
  private var typography = emptyMap<String, Any?>()
  private var dropOffset: Int? = null
  private var lastContentHeight = -1
  private var accessibilityFocus = View.NO_ID

  init {
    background = null
    gravity = android.view.Gravity.TOP or android.view.Gravity.START
    setSingleLine(false)
    inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
    setPadding(0, 0, 0, 0)
    // Only a drag may enter attachment intake. IME and clipboard rich content never enter text storage.
    ViewCompat.setOnReceiveContentListener(this, arrayOf("image/*", "application/*", "text/uri-list")) { _, payload ->
      if (payload.source == ContentInfoCompat.SOURCE_DRAG_AND_DROP) receiveAttachmentDrop(payload.clip, sourceSelection().getValue("start"))
      null
    }
    filters = arrayOf(InputFilter { _, _, _, dest, dstart, dend ->
      if (applyingControlled) null else {
        val partial = dest.getSpans(0, dest.length, ComposerChipSpan::class.java).any { span ->
          val left = dest.getSpanStart(span)
          val right = dest.getSpanEnd(span)
          (dstart > left && dstart < right) || (dend > left && dend < right)
        }
        // Known edit entry points expand first. Refuse an unknown platform edit that splits a chip.
        if (partial) dest.subSequence(dstart, dend) else null
      }
    })
    addTextChangedListener(object : TextWatcher {
      override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {
        if (!applyingControlled) editing = NativeEdit(start, fragment(start, start + count), EditFragment("", emptyList()), sourceSelection(), sourceSelection())
      }
      override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {
        if (!applyingControlled) editing?.after = fragment(start, start + count)
      }
      override fun afterTextChanged(s: Editable) {
        if (applyingControlled) return
        chips().forEach { span ->
          val start = s.getSpanStart(span)
          val end = s.getSpanEnd(span)
          if (start < 0 || end <= start || s.subSequence(start, end).toString() != span.reference.source) s.removeSpan(span)
        }
        editing?.let { edit ->
          // Store only the changed fragment and its typed bindings, never a text-derived identity.
          if (edit.before.value != edit.after.value) { undoEdits.add(edit); redoEdits.clear() }
        }
        editing = null
        nativeEventCount++
        onComposerChange?.invoke(s.toString(), sourceSelection(), nativeEventCount)
        requestLayout()
        invalidate()
      }
    })
    setOnEditorActionListener { _, actionId, event ->
      if (submitBehavior != "newline" && !isComposing() && event?.isShiftPressed != true &&
        (actionId != EditorInfo.IME_NULL || event?.keyCode == KeyEvent.KEYCODE_ENTER)) {
        if (event == null || event.action == KeyEvent.ACTION_DOWN) submit(keyPayload("Enter", event))
        true
      } else false
    }
    ready = true
  }

  private val density get() = resources.displayMetrics.density
  private val fontScale get() = resources.configuration.fontScale
  private fun dimension(map: Map<String, Any?>, key: String, fallback: Float): Float = (map[key] as? Number)?.toFloat() ?: fallback
  private fun ink(key: String, fallback: Int = currentTextColor): Int {
    return when (val value = theme[key]) {
      is Number -> value.toInt()
      is String -> {
        if (value.trim().equals("transparent", ignoreCase = true)) return Color.TRANSPARENT
        val components = Regex("rgba?\\(([^)]+)\\)").matchEntire(value.trim())?.groupValues?.get(1)?.split(',')?.map { it.trim().toFloatOrNull() }
        if (components != null && components.size in 3..4 && components.all { it != null }) {
          val rgb = components.take(3).map { it!! }
          val alpha = components.getOrNull(3) ?: 1f
          if (rgb.all { it.isFinite() && it in 0f..255f } && alpha.isFinite() && alpha in 0f..1f)
            Color.argb((alpha * 255).roundToInt(), rgb[0].roundToInt(), rgb[1].roundToInt(), rgb[2].roundToInt()) else fallback
        } else runCatching { Color.parseColor(value) }.getOrDefault(fallback)
      }
      else -> fallback
    }
  }

  private fun chipStyle() = ComposerChipStyle(
    ink("chipForeground"), ink("chipBackground", Color.TRANSPARENT), ink("warningText", ink("warning")), ink("muted"), ink("selection", highlightColor),
    dimension(typography, "chipHeight", textSize / density) * density * fontScale,
    dimension(typography, "chipRadius", 0f) * density * fontScale,
    dimension(typography, "chipMaxLabelWidth", width.toFloat() / density) * density * fontScale,
    (typography["chipFontFamily"] as? String)?.let { ReactFontManager.getInstance().getTypeface(it, Typeface.NORMAL, context.assets) } ?: typeface,
    dimension(typography, "chipPaddingLeft", 0f) * density * fontScale,
    dimension(typography, "chipPaddingRight", 0f) * density * fontScale,
    dimension(typography, "chipGlyphSize", 0f) * density * fontScale,
    dimension(typography, "chipGap", 0f) * density * fontScale,
    ink("chipGlyphForeground", ink("chipForeground")),
    ink("chipWarningGlyphForeground", ink("warning")),
    chipContainerWidth.toFloat(),
  )

  fun setThemeTokens(value: Map<String, Any?>) {
    theme = value
    setTextColor(ink("text"))
    setHintTextColor(ink("placeholder", currentHintTextColor))
    highlightColor = ink("selection", highlightColor)
    applyDecorations()
    requestLayout()
    invalidate()
  }

  fun setTypographyTokens(value: Map<String, Any?>) {
    typography = value
    (value["fontSize"] as? Number)?.let { setTextSize(TypedValue.COMPLEX_UNIT_SP, it.toFloat()) }
    val family = value["fontFamily"] as? String
    val weight = (value["fontWeight"] as? Number)?.toInt() ?: (value["fontWeight"] as? String)?.toIntOrNull() ?: 400
    typeface = if (family != null) ReactFontManager.getInstance().getTypeface(family, Typeface.NORMAL, weight, context.assets)
      else if (Build.VERSION.SDK_INT >= 28) Typeface.create(Typeface.DEFAULT, weight, false)
      else Typeface.create(Typeface.DEFAULT, if (weight >= 600) Typeface.BOLD else Typeface.NORMAL)
    (value["lineHeight"] as? Number)?.let { setLineSpacing(max(0f, it.toFloat() * density * fontScale - paint.fontSpacing), 1f) }
    applyDecorations()
    remeasureChips()
  }

  fun setPaddingTokens(value: Map<String, Any?>) {
    setPadding((dimension(value, "left", 0f) * density).toInt(), (dimension(value, "top", 0f) * density).toInt(),
      (dimension(value, "right", 0f) * density).toInt(), (dimension(value, "bottom", 0f) * density).toInt())
  }

  fun setAutocorrect(enabled: Boolean) {
    inputType = if (enabled) inputType and InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS.inv() or InputType.TYPE_TEXT_FLAG_AUTO_CORRECT
      else inputType and InputType.TYPE_TEXT_FLAG_AUTO_CORRECT.inv() or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
  }

  fun setAutocapitalize(mode: String) {
    val caps = InputType.TYPE_TEXT_FLAG_CAP_SENTENCES or InputType.TYPE_TEXT_FLAG_CAP_WORDS or InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS
    inputType = inputType and caps.inv() or when (mode) {
      "characters" -> InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS
      "words" -> InputType.TYPE_TEXT_FLAG_CAP_WORDS
      "sentences" -> InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
      else -> 0
    }
  }

  fun setTextAndSelection(value: String, selection: Map<String, Int>, references: List<Map<String, Any?>>) =
    updateDocument(DocumentUpdate(value = value, selection = selection, references = references))

  /** Match the source value and ranges to the acknowledged native edit, as one prop batch. */
  fun setControlledDocument(value: String?, eventCount: Int, references: List<Map<String, Any?>>?, decorations: List<Map<String, Any?>>?) {
    updateDocument(DocumentUpdate(value = value, eventCount = eventCount, references = references, decorations = decorations))
  }

  private fun updateDocument(update: DocumentUpdate) {
    if (update.eventCount != null && update.eventCount < nativeEventCount) return
    if (isComposing()) {
      val command = pendingDocument?.takeIf { it.eventCount == null }
      if (command != null && update.eventCount != null) {
        // A controlled echo cannot replace an explicit command waiting for IME completion.
        pendingDocument = command.copy(decorations = update.decorations ?: command.decorations)
        return
      }
      val previous = pendingDocument?.takeIf { it.eventCount == update.eventCount }
      pendingDocument = update.copy(value = update.value ?: previous?.value,
        selection = update.selection ?: previous?.selection, references = update.references ?: previous?.references,
        decorations = update.decorations ?: pendingDocument?.decorations)
      return
    }
    val previousSelection = sourceSelection()
    var commandEdit: NativeEdit? = null
    var newEnd = 0
    applyingControlled = true
    try {
      val value = update.value
      if (value != null && text.toString() != value) {
        val before = text.toString()
        var prefix = 0
        while (prefix < min(before.length, value.length) && before[prefix] == value[prefix]) prefix++
        prefix = snap(prefix, -1)
        var suffix = 0
        while (suffix < min(before.length - prefix, value.length - prefix) && before[before.length - suffix - 1] == value[value.length - suffix - 1]) suffix++
        val oldEnd = snap(before.length - suffix, 1)
        newEnd = value.length - (before.length - oldEnd)
        if (update.eventCount == null) commandEdit = NativeEdit(prefix, fragment(prefix, oldEnd), EditFragment("", emptyList()), previousSelection, previousSelection)
        else { undoEdits.clear(); redoEdits.clear() }
        text!!.replace(prefix, oldEnd, value, prefix, newEnd)
      }
      update.references?.let(::applyReferences)
      update.decorations?.let { decorationSpecs = it; applyDecorations() }
      setSourceSelection(update.selection ?: previousSelection)
      commandEdit?.let { edit ->
        edit.after = fragment(edit.start, newEnd)
        edit.selectionAfter = sourceSelection()
        undoEdits.add(edit)
        redoEdits.clear()
      }
    } finally { applyingControlled = false }
    // A controlled edit can change the line count exactly like a typed one (`afterTextChanged`), but
    // TextView asks for no layout while its host sizes it exactly. The host relays this pass, whose
    // `onLayout` reports the new content height; without it a restored draft stayed one line tall.
    requestLayout()
  }

  private fun applyReferences(values: List<Map<String, Any?>>) {
    val editable = text ?: return
    chips().forEach(editable::removeSpan)
    var previousEnd = 0
    values.sortedBy { (it["start"] as? Number)?.toInt() ?: -1 }.forEach { value ->
      val start = (value["start"] as? Number)?.toInt() ?: return@forEach
      val end = (value["end"] as? Number)?.toInt() ?: return@forEach
      val ref = value["ref"] as? String ?: return@forEach
      val label = value["label"] as? String ?: return@forEach
      val token = value["token"] as? String ?: return@forEach
      if (start < previousEnd || start < 0 || end <= start || end > editable.length || splitsSurrogate(start) || splitsSurrogate(end)) return@forEach
      if (editable.subSequence(start, end).toString() != token) return@forEach
      val reference = ComposerReference(ref, label, value["kind"] as? String ?: "", value["state"] as? String ?: "ready",
        value["glyph"] as? String, value["accessibilityLabel"] as? String ?: label, value["marker"] as? String ?: label,
        token)
      installReference(reference, start, end)
      previousEnd = end
    }
    requestLayout()
    invalidate()
    sendAccessibilityEvent(AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED)
  }

  private fun installReference(reference: ComposerReference, start: Int, end: Int) {
    val editable = text ?: return
    lateinit var span: ComposerChipSpan
    span = ComposerChipSpan(reference, ::chipStyle) { selectionStart == editable.getSpanStart(span) && selectionEnd == editable.getSpanEnd(span) }
    editable.setSpan(span, start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
  }

  private fun fragment(start: Int, end: Int): EditFragment {
    val editable = text ?: return EditFragment("", emptyList())
    val references = chips().mapNotNull { span ->
      val left = editable.getSpanStart(span)
      val right = editable.getSpanEnd(span)
      if (left >= start && right <= end && right > left && editable.subSequence(left, right).toString() == span.reference.source)
        BoundReference(left - start, right - start, span.reference) else null
    }
    return EditFragment(editable.subSequence(start, end).toString(), references)
  }

  private fun restoreEdit(undo: Boolean): Boolean {
    if (!isEnabled || !isFocusable || isComposing()) return false
    val from = if (undo) undoEdits else redoEdits
    val edit = from.lastOrNull() ?: return false
    val replaced = if (undo) edit.after else edit.before
    val restored = if (undo) edit.before else edit.after
    if (undo) edit.selectionAfter = sourceSelection()
    applyingControlled = true
    try {
      val editable = text ?: return false
      editable.replace(edit.start, edit.start + replaced.value.length, restored.value)
      restored.references.forEach { installReference(it.reference, edit.start + it.start, edit.start + it.end) }
      setSourceSelection(if (undo) edit.selectionBefore else edit.selectionAfter)
    } finally { applyingControlled = false }
    from.removeAt(from.lastIndex)
    (if (undo) redoEdits else undoEdits).add(edit)
    nativeEventCount++
    onComposerChange?.invoke(text.toString(), sourceSelection(), nativeEventCount)
    requestLayout()
    invalidate()
    return true
  }

  private fun applyDecorations() {
    val editable = text ?: return
    decorationSpans.forEach(editable::removeSpan)
    decorationSpans.clear()
    decorationSpecs.forEach { value ->
      val start = (value["start"] as? Number)?.toInt() ?: return@forEach
      val end = (value["end"] as? Number)?.toInt() ?: return@forEach
      if (start < 0 || end <= start || end > length()) return@forEach
      fun add(span: Any) { editable.setSpan(span, start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE); decorationSpans.add(span) }
      when (val treatment = value["treatment"]) {
        "muted" -> add(ForegroundColorSpan(ink("muted")))
        "warning" -> add(ForegroundColorSpan(ink("warningText", ink("warning"))))
        "success" -> add(ForegroundColorSpan(ink("successText", ink("success"))))
        "highlight" -> add(BackgroundColorSpan(ink("selection", highlightColor)))
        "code", "monospace" -> {
          val family = typography["monoFontFamily"] as? String
          if (family == null) add(TypefaceSpan("monospace")) else {
            val face = ReactFontManager.getInstance().getTypeface(family, Typeface.NORMAL, context.assets)
            add(object : MetricAffectingSpan() {
              override fun updateDrawState(paint: TextPaint) { paint.typeface = face }
              override fun updateMeasureState(paint: TextPaint) { paint.typeface = face }
            })
          }
        }
        "underline" -> add(UnderlineSpan())
        is Map<*, *> -> if (treatment["kind"] == "link") { add(ForegroundColorSpan(ink("link"))); add(UnderlineSpan()) }
      }
    }
    invalidate()
  }

  private fun chips(): Array<ComposerChipSpan> = text?.getSpans(0, length(), ComposerChipSpan::class.java) ?: emptyArray()
  private fun splitsSurrogate(offset: Int): Boolean = offset > 0 && offset < length() && Character.isHighSurrogate(text!![offset - 1]) && Character.isLowSurrogate(text!![offset])

  private fun snap(offset: Int, direction: Int = 0): Int {
    val editable = text ?: return 0
    var position = offset.coerceIn(0, editable.length)
    chips().firstOrNull { position > editable.getSpanStart(it) && position < editable.getSpanEnd(it) }?.let {
      val start = editable.getSpanStart(it)
      val end = editable.getSpanEnd(it)
      position = if (direction < 0 || (direction == 0 && position - start <= end - position)) start else end
    }
    if (splitsSurrogate(position)) position += if (direction < 0) -1 else 1
    return position
  }

  fun sourceSelection(): Map<String, Int> {
    val start = max(0, selectionStart)
    val end = max(0, selectionEnd)
    return if (start == end) mapOf("start" to snap(start), "end" to snap(end))
      else mapOf("start" to snap(min(start, end), -1), "end" to snap(max(start, end), 1))
  }

  fun referenceSnapshots(): List<Map<String, Any>> = chips().sortedBy { text!!.getSpanStart(it) }.map { span ->
    mapOf("ref" to span.reference.ref, "token" to span.reference.source,
      "start" to text!!.getSpanStart(span), "end" to text!!.getSpanEnd(span))
  }

  fun setSourceSelection(value: Map<String, Int>) {
    val editable = text ?: return
    val start = value["start"] ?: 0
    val end = value["end"] ?: start
    val collapsed = start == end
    Selection.setSelection(editable, snap(min(start, end), if (collapsed) 0 else -1), snap(max(start, end), if (collapsed) 0 else 1))
  }

  override fun onSelectionChanged(selStart: Int, selEnd: Int) {
    super.onSelectionChanged(selStart, selEnd)
    if (!ready || applyingControlled || snappingSelection || selStart < 0 || selEnd < 0) return
    val selection = sourceSelection()
    if (selStart != selection["start"] || selEnd != selection["end"]) {
      snappingSelection = true
      try { text?.let { Selection.setSelection(it, selection.getValue("start"), selection.getValue("end")) } } finally { snappingSelection = false }
    }
    if (!applyingControlled) onComposerSelection?.invoke(selection)
    invalidate()
  }

  fun isComposing(): Boolean = text?.let { BaseInputConnection.getComposingSpanStart(it) >= 0 } ?: false

  private fun flushControlledUpdates() {
    if (isComposing()) return
    val document = pendingDocument
    pendingDocument = null
    if (document != null) updateDocument(document)
  }

  private fun expandedRange(start: Int, end: Int): Pair<Int, Int> = snap(start, -1) to snap(end, 1)

  private fun normalizeReplacement() {
    val editable = text ?: return
    val composingStart = BaseInputConnection.getComposingSpanStart(editable)
    val composingEnd = BaseInputConnection.getComposingSpanEnd(editable)
    val start = if (composingStart >= 0) composingStart else max(0, min(selectionStart, selectionEnd))
    val end = if (composingEnd >= 0) composingEnd else max(0, max(selectionStart, selectionEnd))
    val range = if (start == end) snap(start) to snap(end) else expandedRange(start, end)
    if (range.first != start || range.second != end) {
      BaseInputConnection.removeComposingSpans(editable)
      Selection.setSelection(editable, range.first, range.second)
    }
  }

  private fun deleteSurrounding(before: Int, after: Int, codePoints: Boolean): Boolean {
    if (!isEnabled || !isFocusable) return false
    val editable = text ?: return false
    val selection = sourceSelection()
    val start = selection.getValue("start")
    val end = selection.getValue("end")
    if (before < 0 || after < 0) return false
    if (before == 0 && after == 0) return true
    if (start == end && before == 1 && after == 0) {
      chips().firstOrNull { editable.getSpanEnd(it) == start }?.let {
        setSourceSelection(mapOf("start" to editable.getSpanStart(it), "end" to start))
        return true
      }
    }
    fun shift(offset: Int, amount: Int): Int = if (codePoints) {
      val available = Character.codePointCount(editable, if (amount < 0) 0 else offset, if (amount < 0) offset else editable.length)
      Character.offsetByCodePoints(editable, offset, if (amount < 0) -min(-amount, available) else min(amount, available))
    } else (offset + amount).coerceIn(0, editable.length)
    val range = if (start != end) expandedRange(start, end) else expandedRange(shift(start, -before), shift(end, after))
    if (range.first == range.second) return false
    editable.delete(range.first, range.second)
    setSelection(range.first)
    return true
  }

  override fun onCreateInputConnection(outAttrs: EditorInfo): InputConnection? {
    val connection = super.onCreateInputConnection(outAttrs) ?: return null
    outAttrs.contentMimeTypes = emptyArray()
    return object : InputConnectionWrapper(connection, false) {
      override fun deleteSurroundingText(beforeLength: Int, afterLength: Int): Boolean {
        if (!isComposing() && (beforeLength > 0 || afterLength > 0)) emitPlainKey(if (beforeLength > 0) "Backspace" else "Delete")
        return deleteSurrounding(beforeLength, afterLength, false)
      }
      override fun deleteSurroundingTextInCodePoints(beforeLength: Int, afterLength: Int): Boolean {
        if (!isComposing() && (beforeLength > 0 || afterLength > 0)) emitPlainKey(if (beforeLength > 0) "Backspace" else "Delete")
        return deleteSurrounding(beforeLength, afterLength, true)
      }
      override fun commitText(value: CharSequence?, newCursorPosition: Int): Boolean {
        if (!isComposing() && value?.toString() == "\n" && submitBehavior != "newline") {
          emitPlainKey("Enter", submitting = true)
          submit()
          return true
        }
        if (!isComposing() && value != null && Character.codePointCount(value, 0, value.length) == 1) emitPlainKey(value.toString())
        normalizeReplacement()
        val result = super.commitText(value?.toString() ?: "", newCursorPosition)
        flushControlledUpdates()
        return result
      }
      override fun setComposingText(value: CharSequence?, newCursorPosition: Int): Boolean {
        normalizeReplacement()
        return super.setComposingText(value?.toString() ?: "", newCursorPosition)
      }
      override fun setComposingRegion(start: Int, end: Int): Boolean {
        val left = min(start, end).coerceIn(0, length())
        val right = max(start, end).coerceIn(0, length())
        if (chips().any { text!!.getSpanStart(it) < right && text!!.getSpanEnd(it) > left }) return false
        return super.setComposingRegion(left, right)
      }
      override fun finishComposingText(): Boolean {
        val result = super.finishComposingText()
        flushControlledUpdates()
        return result
      }
      override fun setSelection(start: Int, end: Int): Boolean {
        setSourceSelection(mapOf("start" to start, "end" to end))
        return true
      }
      override fun commitContent(inputContentInfo: InputContentInfo, flags: Int, opts: Bundle?): Boolean = false
      override fun performPrivateCommand(action: String?, data: Bundle?): Boolean {
        if (action?.contains("COMMIT_CONTENT") == true) return false
        return super.performPrivateCommand(action, data)
      }
      override fun performEditorAction(editorAction: Int): Boolean {
        if (submitBehavior != "newline" && !isComposing()) { submit(); return true }
        return super.performEditorAction(editorAction)
      }
    }
  }

  private fun submit(event: Map<String, Any> = keyPayload("Enter")) {
    onComposerSubmit?.invoke(event)
    if (submitBehavior == "blurAndSubmit") clearFocus()
  }

  private fun keyPayload(key: String, event: KeyEvent? = null): Map<String, Any> = mapOf("key" to key,
    "shiftKey" to (event?.isShiftPressed ?: false), "ctrlKey" to (event?.isCtrlPressed ?: false),
    "altKey" to (event?.isAltPressed ?: false), "metaKey" to (event?.isMetaPressed ?: false))

  private fun emitPlainKey(key: String, submitting: Boolean = false) {
    onComposerKey?.invoke(keyPayload(key) + if (submitting) mapOf("submitting" to true) else emptyMap())
  }

  override fun onKeyPreIme(keyCode: Int, event: KeyEvent): Boolean {
    if (keyCode == KeyEvent.KEYCODE_BACK && forwardHardwareBack && hasFocus()) {
      val dispatcher = keyDispatcherState
      if (dispatcher != null) {
        if (event.action == KeyEvent.ACTION_DOWN) {
          if (event.repeatCount == 0) dispatcher.startTracking(event, this)
          return true
        }
        if (event.action == KeyEvent.ACTION_UP) {
          dispatcher.handleUpEvent(event)
          if (event.isTracking && !event.isCanceled && onHardwareBack?.invoke() == true) return true
        }
      }
    }
    return super.onKeyPreIme(keyCode, event)
  }

  override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
    val key = when (keyCode) {
      KeyEvent.KEYCODE_DEL -> "Backspace"
      KeyEvent.KEYCODE_FORWARD_DEL -> "Delete"
      KeyEvent.KEYCODE_ENTER -> "Enter"
      KeyEvent.KEYCODE_DPAD_LEFT -> "ArrowLeft"
      KeyEvent.KEYCODE_DPAD_RIGHT -> "ArrowRight"
      KeyEvent.KEYCODE_DPAD_UP -> "ArrowUp"
      KeyEvent.KEYCODE_DPAD_DOWN -> "ArrowDown"
      KeyEvent.KEYCODE_ESCAPE -> "Escape"
      KeyEvent.KEYCODE_TAB -> "Tab"
      else -> if (event.unicodeChar != 0) String(Character.toChars(event.unicodeChar)) else KeyEvent.keyCodeToString(keyCode)
    }
    val submitting = !isComposing() && keyCode == KeyEvent.KEYCODE_ENTER && submitBehavior != "newline" && !event.isShiftPressed
    if (!isComposing()) onComposerKey?.invoke(keyPayload(key, event) + if (submitting) mapOf("submitting" to true) else emptyMap())
    if (!isComposing()) {
      if (keyCode == KeyEvent.KEYCODE_DEL && !event.isCtrlPressed && !event.isAltPressed) return deleteSurrounding(1, 0, false)
      if (keyCode == KeyEvent.KEYCODE_FORWARD_DEL && !event.isCtrlPressed && !event.isAltPressed) return deleteSurrounding(0, 1, false)
      if (submitting) { submit(keyPayload(key, event)); return true }
      if (!event.isShiftPressed && !event.isCtrlPressed && !event.isAltPressed && selectionStart == selectionEnd && keyCode in listOf(KeyEvent.KEYCODE_DPAD_LEFT, KeyEvent.KEYCODE_DPAD_RIGHT)) {
        val span = chips().firstOrNull { if (keyCode == KeyEvent.KEYCODE_DPAD_LEFT) text!!.getSpanEnd(it) == selectionStart else text!!.getSpanStart(it) == selectionStart }
        if (span != null) { setSelection(if (keyCode == KeyEvent.KEYCODE_DPAD_LEFT) text!!.getSpanStart(span) else text!!.getSpanEnd(span)); return true }
      }
    }
    return super.onKeyDown(keyCode, event)
  }

  private fun readableSelection(start: Int, end: Int): String {
    val editable = text ?: return ""
    val result = StringBuilder()
    var offset = start
    chips().sortedBy { editable.getSpanStart(it) }.forEach { span ->
      val left = editable.getSpanStart(span)
      val right = editable.getSpanEnd(span)
      if (left >= start && right <= end) {
        result.append(editable.subSequence(offset, left)).append(span.reference.marker)
        offset = right
      }
    }
    return result.append(editable.subSequence(offset, end)).toString()
  }

  override fun onTextContextMenuItem(id: Int): Boolean {
    if (id == android.R.id.undo || id == android.R.id.redo) return restoreEdit(id == android.R.id.undo)
    val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    val selection = sourceSelection()
    val start = selection.getValue("start")
    val end = selection.getValue("end")
    if (id == android.R.id.copy || id == android.R.id.cut) {
      if (start == end) return false
      clipboard.setPrimaryClip(ClipData.newPlainText("", readableSelection(start, end)))
      if (id == android.R.id.cut && isEnabled && isFocusable) { text!!.delete(start, end); setSelection(start) }
      return true
    }
    if (id == android.R.id.paste || id == android.R.id.pasteAsPlainText) {
      if (!isEnabled || !isFocusable) return false
      val clip = clipboard.primaryClip ?: return false
      // URI/image clipboard entries are refused; never coerce them into textual URI payloads.
      val plain = (0 until clip.itemCount).mapNotNull { clip.getItemAt(it).text?.toString() }.joinToString("\n")
      if (plain.isEmpty()) return false
      text!!.replace(start, end, plain)
      setSelection(start + plain.length)
      return true
    }
    return super.onTextContextMenuItem(id)
  }

  override fun onKeyShortcut(keyCode: Int, event: KeyEvent): Boolean {
    if (event.isCtrlPressed && !event.isAltPressed) {
      if (keyCode == KeyEvent.KEYCODE_Z) return onTextContextMenuItem(if (event.isShiftPressed) android.R.id.redo else android.R.id.undo)
      if (keyCode == KeyEvent.KEYCODE_Y && !event.isShiftPressed) return onTextContextMenuItem(android.R.id.redo)
    }
    return super.onKeyShortcut(keyCode, event)
  }

  private fun dropActivity(): Activity? {
    var current = context
    while (current is ContextWrapper) {
      if (current is Activity) return current
      current = current.baseContext
    }
    return current as? Activity
  }

  fun receiveAttachmentDrop(clip: ClipData, offset: Int, permission: DragAndDropPermissions? = null) {
    if (!acceptsAttachmentDrops || !isEnabled || onComposerAttachmentDrop == null) { permission?.release(); return }
    val uris = (0 until clip.itemCount).mapNotNull { clip.getItemAt(it).uri }.filter { it.scheme == "content" || it.scheme == "file" }
    if (uris.isEmpty()) { permission?.release(); return }
    val scope = attachmentDropScope
    Thread({
      val result = runCatching { uris.map { ComposerAttachmentDrop.read(context, it) } }
      permission?.release()
      post {
        if (acceptsAttachmentDrops && isEnabled && attachmentDropScope == scope) {
          val payload = mutableMapOf<String, Any>("scope" to scope, "offset" to offset, "sources" to result.getOrDefault(emptyList()))
          if (result.isFailure) payload["error"] = true
          onComposerAttachmentDrop?.invoke(payload)
        }
      }
    }, "composer-attachment-drop").start()
  }

  override fun onDragEvent(event: DragEvent): Boolean {
    if (!acceptsAttachmentDrops || !isEnabled || onComposerAttachmentDrop == null) return false
    val location = IntArray(2)
    getLocationInWindow(location)
    val offset = offsetAtWindowPoint((location[0] + event.x) / density, (location[1] + event.y) / density)
    when (event.action) {
      DragEvent.ACTION_DRAG_STARTED -> return true
      DragEvent.ACTION_DRAG_LOCATION -> setDropCaret(offset)
      DragEvent.ACTION_DROP -> {
        setDropCaret(null)
        val clip = event.clipData ?: return true
        if (offset != null) receiveAttachmentDrop(clip, offset, dropActivity()?.requestDragAndDropPermissions(event))
      }
      DragEvent.ACTION_DRAG_EXITED, DragEvent.ACTION_DRAG_ENDED -> setDropCaret(null)
    }
    return true
  }

  fun offsetAtWindowPoint(x: Float, y: Float): Int? {
    if (!x.isFinite() || !y.isFinite() || width <= 0 || height <= 0) return null
    val location = IntArray(2)
    getLocationInWindow(location)
    val localX = x * density - location[0]
    val localY = y * density - location[1]
    if (localX < 0 || localY < 0 || localX > width || localY > height) return null
    val layout = layout ?: return null
    val line = layout.getLineForVertical((localY - totalPaddingTop + scrollY).toInt())
    val horizontal = localX - totalPaddingLeft + scrollX
    val offset = layout.getOffsetForHorizontal(line, horizontal)
    val span = chips().firstOrNull { chipBounds(it).contains(localX.toInt(), localY.toInt()) }
    if (span != null) {
      val start = text!!.getSpanStart(span)
      val end = text!!.getSpanEnd(span)
      val bounds = chipBounds(span)
      val rtl = layout.isRtlCharAt(start)
      val first = if (rtl) bounds.right else bounds.left
      val last = if (rtl) bounds.left else bounds.right
      return if (abs(localX - first) <= abs(localX - last)) start else end
    }
    return snap(offset)
  }

  fun setDropCaret(offset: Int?) { dropOffset = offset?.let { snap(it) }; invalidate() }

  fun caretRect(): Map<String, Float>? {
    val layout = layout ?: return null
    val offset = snap(max(0, selectionEnd))
    val line = layout.getLineForOffset(offset)
    val location = IntArray(2)
    getLocationInWindow(location)
    return mapOf("x" to (location[0] + totalPaddingLeft + layout.getPrimaryHorizontal(offset) - scrollX) / density,
      "y" to (location[1] + totalPaddingTop + layout.getLineTop(line) - scrollY) / density,
      "width" to 1f, "height" to (layout.getLineBottom(line) - layout.getLineTop(line)) / density)
  }

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    val offset = dropOffset ?: return
    val layout = layout ?: return
    val line = layout.getLineForOffset(offset.coerceIn(0, length()))
    val x = layout.getPrimaryHorizontal(offset) + totalPaddingLeft - scrollX
    val paint = Paint().apply { color = ink("selection"); strokeWidth = density }
    canvas.drawLine(x, (layout.getLineTop(line) + totalPaddingTop - scrollY).toFloat(), x, (layout.getLineBottom(line) + totalPaddingTop - scrollY).toFloat(), paint)
  }

  override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
    super.onSizeChanged(w, h, oldw, oldh)
    reportContentHeight()
  }

  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    val available = (View.MeasureSpec.getSize(widthMeasureSpec) - compoundPaddingLeft - compoundPaddingRight).coerceAtLeast(0)
    if (chipContainerWidth != available) {
      chipContainerWidth = available
      remeasureChips()
    }
    super.onMeasure(widthMeasureSpec, heightMeasureSpec)
  }

  private fun remeasureChips() {
    val editable = text ?: return
    chips().forEach { editable.setSpan(it, editable.getSpanStart(it), editable.getSpanEnd(it), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE) }
    requestLayout()
    invalidate()
  }

  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    if (ready) setTypographyTokens(typography)
  }

  override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
    super.onLayout(changed, left, top, right, bottom)
    reportContentHeight()
  }

  private fun reportContentHeight() {
    val height = (layout?.height ?: 0) + compoundPaddingTop + compoundPaddingBottom
    if (height != lastContentHeight) { lastContentHeight = height; onComposerHeight?.invoke(height / density) }
  }

  override fun onScrollChanged(l: Int, t: Int, oldl: Int, oldt: Int) {
    super.onScrollChanged(l, t, oldl, oldt)
    if (ready) onComposerScroll?.invoke(t / density)
  }

  override fun onTouchEvent(event: MotionEvent): Boolean {
    if (event.action == MotionEvent.ACTION_DOWN) { lastTouchX = event.x; lastTouchY = event.y; longPressHandled = false }
    if (event.action == MotionEvent.ACTION_UP && !longPressHandled && !isComposing()) {
      val span = chipAtLocalPoint(event.x, event.y)
      if (span != null) onComposerReference?.invoke(span.reference.ref)
    }
    return super.onTouchEvent(event)
  }

  override fun performLongClick(): Boolean {
    if (isComposing()) return super.performLongClick()
    val openLabel = referenceMenuLabels["open"] ?: return super.performLongClick()
    val span = chipAtLocalPoint(lastTouchX, lastTouchY)
    val offset = getOffsetForPosition(lastTouchX, lastTouchY)
    val decoration = decorationSpecs.firstOrNull { entry ->
      val start = (entry["start"] as? Number)?.toInt() ?: return@firstOrNull false
      val end = (entry["end"] as? Number)?.toInt() ?: return@firstOrNull false
      start <= offset && offset < end && (entry["treatment"] as? Map<*, *>)?.get("kind") == "link"
    }
    val url = (decoration?.get("treatment") as? Map<*, *>)?.get("url") as? String
    if (span == null && url == null) return super.performLongClick()
    longPressHandled = true
    PopupMenu(context, this).apply {
      menu.add(openLabel).setOnMenuItemClickListener {
        if (span != null) onComposerReference?.invoke(span.reference.ref) else if (url != null) onComposerDecoration?.invoke(url)
        true
      }
      val removeLabel = referenceMenuLabels["remove"]
      if (span != null && removeLabel != null && isEnabled && isFocusable) {
        menu.add(removeLabel).setOnMenuItemClickListener {
          val editable = text
          if (editable != null) {
            val start = editable.getSpanStart(span)
            val end = editable.getSpanEnd(span)
            if (start >= 0 && end > start) { editable.delete(start, end); setSelection(start) }
          }
          true
        }
      }
      show()
    }
    return true
  }

  private fun chipBounds(span: ComposerChipSpan): Rect {
    val layout = layout ?: return Rect()
    val start = text!!.getSpanStart(span)
    val end = text!!.getSpanEnd(span)
    if (start < 0 || end < 0) return Rect()
    val line = layout.getLineForOffset(start)
    val a = layout.getPrimaryHorizontal(start)
    val spanWidth = span.getSize(paint, text!!, start, end, null)
    val b = a + if (layout.isRtlCharAt(start)) -spanWidth else spanWidth
    return Rect((min(a, b) + totalPaddingLeft - scrollX).toInt(), layout.getLineTop(line) + totalPaddingTop - scrollY,
      (max(a, b) + totalPaddingLeft - scrollX).toInt(), layout.getLineBottom(line) + totalPaddingTop - scrollY)
  }

  private fun chipAtLocalPoint(x: Float, y: Float): ComposerChipSpan? = chips().firstOrNull { chipBounds(it).contains(x.toInt(), y.toInt()) }

  private val chipAccessibility = object : AccessibilityNodeProvider() {
    override fun createAccessibilityNodeInfo(virtualViewId: Int): AccessibilityNodeInfo? {
      if (virtualViewId == View.NO_ID) return AccessibilityNodeInfo.obtain(this@ComposerEditText).also { node ->
        onInitializeAccessibilityNodeInfo(node)
        chips().indices.forEach { node.addChild(this@ComposerEditText, it) }
      }
      val span = chips().getOrNull(virtualViewId) ?: return null
      return AccessibilityNodeInfo.obtain().apply {
        setSource(this@ComposerEditText, virtualViewId)
        setParent(this@ComposerEditText)
        packageName = context.packageName
        className = "android.widget.Button"
        text = span.reference.accessibilityLabel
        contentDescription = span.reference.accessibilityLabel
        isEnabled = this@ComposerEditText.isEnabled
        isClickable = true
        isFocusable = true
        isVisibleToUser = isShown
        val bounds = chipBounds(span)
        setBoundsInParent(bounds)
        val location = IntArray(2)
        getLocationOnScreen(location)
        bounds.offset(location[0], location[1])
        setBoundsInScreen(bounds)
        isAccessibilityFocused = accessibilityFocus == virtualViewId
        addAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_CLICK)
        addAction(if (isAccessibilityFocused) AccessibilityNodeInfo.AccessibilityAction.ACTION_CLEAR_ACCESSIBILITY_FOCUS else AccessibilityNodeInfo.AccessibilityAction.ACTION_ACCESSIBILITY_FOCUS)
      }
    }

    override fun performAction(virtualViewId: Int, action: Int, arguments: Bundle?): Boolean {
      if (virtualViewId == View.NO_ID) return performAccessibilityAction(action, arguments)
      val span = chips().getOrNull(virtualViewId) ?: return false
      return when (action) {
        AccessibilityNodeInfo.ACTION_CLICK -> { onComposerReference?.invoke(span.reference.ref); true }
        AccessibilityNodeInfo.ACTION_ACCESSIBILITY_FOCUS -> { accessibilityFocus = virtualViewId; sendChipAccessibilityEvent(virtualViewId, AccessibilityEvent.TYPE_VIEW_ACCESSIBILITY_FOCUSED); true }
        AccessibilityNodeInfo.ACTION_CLEAR_ACCESSIBILITY_FOCUS -> { accessibilityFocus = View.NO_ID; sendChipAccessibilityEvent(virtualViewId, AccessibilityEvent.TYPE_VIEW_ACCESSIBILITY_FOCUS_CLEARED); true }
        else -> false
      }
    }
  }

  override fun getAccessibilityNodeProvider(): AccessibilityNodeProvider? = if (ready && chips().isNotEmpty()) chipAccessibility else super.getAccessibilityNodeProvider()

  override fun onInitializeAccessibilityNodeInfo(info: AccessibilityNodeInfo) {
    super.onInitializeAccessibilityNodeInfo(info)
    if (ready && Build.VERSION.SDK_INT >= 26) {
      val labels = listOfNotNull(composerAccessibilityHint) + decorationSpecs.mapNotNull { it["label"] as? String }
      if (labels.isNotEmpty()) info.hintText = labels.joinToString(". ")
    }
  }

  private fun sendChipAccessibilityEvent(id: Int, type: Int) {
    val event = AccessibilityEvent.obtain(type)
    event.packageName = context.packageName
    event.className = "android.widget.Button"
    event.setSource(this, id)
    chips().getOrNull(id)?.let { event.text.add(it.reference.accessibilityLabel) }
    parent?.requestSendAccessibilityEvent(this, event)
  }

  override fun dispatchHoverEvent(event: MotionEvent): Boolean {
    val span = chipAtLocalPoint(event.x, event.y)
    if (span != null && event.action in listOf(MotionEvent.ACTION_HOVER_ENTER, MotionEvent.ACTION_HOVER_MOVE)) {
      sendChipAccessibilityEvent(chips().indexOf(span), AccessibilityEvent.TYPE_VIEW_HOVER_ENTER)
      return true
    }
    return super.dispatchHoverEvent(event)
  }
}
