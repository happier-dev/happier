package dev.happier.terminal.termux

import android.graphics.Canvas
import android.graphics.Typeface
import android.view.InputDevice
import android.view.KeyCharacterMap
import android.view.KeyEvent
import android.view.MotionEvent
import com.termux.terminal.KeyHandler
import com.termux.terminal.TerminalEmulator
import com.termux.terminal.TerminalOutput
import com.termux.terminal.TerminalSession
import com.termux.terminal.TerminalSessionClient
import com.termux.view.TerminalRenderer
import dev.happier.terminal.TermuxBridgeDiagnostic
import dev.happier.terminal.TermuxRemoteSession
import dev.happier.terminal.TermuxRemoteSessionCallbacks
import dev.happier.terminal.TermuxWriteResult
import dev.happier.terminal.makeTermuxBridgeDiagnostic
import dev.happier.terminal.makeTermuxTextInputBytes
import java.net.URI
import java.util.Locale

class TermuxBackedRemoteSession(
  private val surfaceId: String,
  private val callbacks: TermuxRemoteSessionCallbacks,
) : TermuxRemoteSession {
  override val diagnostic: TermuxBridgeDiagnostic = makeTermuxBridgeDiagnostic()
  private var disposed = false
  private var cols = 80
  private var rows = 24
  private var cellWidthPx = 10
  private var cellHeightPx = 18
  private var renderer: TerminalRenderer? = null
  private var rendererFontSize = 0
  private var combiningAccent = 0
  private var topRow = 0
  private var mouseScrollStartDownTime = 0L
  private var mouseScrollStartX = 1
  private var mouseScrollStartY = 1

  private val output: TerminalOutput = object : TerminalOutput() {
    override fun write(data: ByteArray, offset: Int, count: Int) {
      if (count <= 0) return
      callbacks.emitInputBytes(data.copyOfRange(offset, offset + count))
    }

    override fun titleChanged(oldTitle: String?, newTitle: String?) {
      if (!newTitle.isNullOrBlank()) callbacks.emitTitle(newTitle)
    }

    override fun onCopyTextToClipboard(text: String?) {
      callbacks.emitCopy(text.orEmpty())
    }

    override fun onPasteTextFromClipboard() {
      callbacks.emitSelection(null)
    }

    override fun onBell() {
      callbacks.emitBell()
    }

    override fun onColorsChanged() {
      emitSurfaceReady()
    }
  }

  private val client: TerminalSessionClient = object : TerminalSessionClient {
    override fun onTextChanged(changedSession: TerminalSession) {
      emitSurfaceReady()
    }

    override fun onTitleChanged(changedSession: TerminalSession) {
      callbacks.emitTitle(emulator.getTitle().orEmpty())
    }

    override fun onSessionFinished(finishedSession: TerminalSession) {
    }

    override fun onCopyTextToClipboard(session: TerminalSession, text: String?) {
      callbacks.emitCopy(text.orEmpty())
    }

    override fun onPasteTextFromClipboard(session: TerminalSession?) {
      callbacks.emitSelection(null)
    }

    override fun onBell(session: TerminalSession) {
      callbacks.emitBell()
    }

    override fun onColorsChanged(session: TerminalSession) {
      emitSurfaceReady()
    }

    override fun onTerminalCursorStateChange(state: Boolean) {
      emitSurfaceReady()
    }

    override fun setTerminalShellPid(session: TerminalSession, pid: Int) {
    }

    override fun getTerminalCursorStyle(): Int? {
      return null
    }

    override fun logError(tag: String?, message: String?) {
    }

    override fun logWarn(tag: String?, message: String?) {
    }

    override fun logInfo(tag: String?, message: String?) {
    }

    override fun logDebug(tag: String?, message: String?) {
    }

    override fun logVerbose(tag: String?, message: String?) {
    }

    override fun logStackTraceWithMessage(tag: String?, message: String?, e: Exception?) {
    }

    override fun logStackTrace(tag: String?, e: Exception?) {
    }
  }

  private val emulator: TerminalEmulator = TerminalEmulator(
    output,
    cols,
    rows,
    cellWidthPx,
    cellHeightPx,
    null as Int?,
    client,
  )

  init {
    emitSurfaceReady()
  }

  override fun writeBytes(bytes: ByteArray, byteOffset: Long): TermuxWriteResult {
    if (disposed) return rejected("surface-not-ready", "Android Termux surface has been disposed.")
    if (bytes.isEmpty()) return rejected("invalid-ack", "Native terminal writes must contain at least one byte.")
    if (byteOffset < 0) return rejected("invalid-ack", "byteOffset must be non-negative.")

    return try {
      emulator.append(bytes, bytes.size)
      val nextOffset = byteOffset + bytes.size
      callbacks.emitWriteAck(nextOffset)
      TermuxWriteResult(accepted = true, byteOffset = nextOffset)
    } catch (error: Throwable) {
      callbacks.emitRendererCrash(error.message ?: error.javaClass.simpleName)
      rejected("renderer-unavailable", "Android Termux failed while parsing terminal bytes.")
    }
  }

  override fun sendInputBytes(bytes: ByteArray): TermuxWriteResult {
    if (disposed) return rejected("surface-not-ready", "Android Termux surface has been disposed.")
    if (bytes.isEmpty()) return rejected("invalid-ack", "Native terminal input must contain at least one byte.")
    callbacks.emitInputBytes(bytes)
    return TermuxWriteResult(accepted = true)
  }

  override fun sendTextInput(text: CharSequence): TermuxWriteResult {
    if (disposed) return rejected("surface-not-ready", "Android Termux surface has been disposed.")
    val input = makeTermuxTextInputBytes(surfaceId, text)
      ?: return rejected("invalid-ack", "Native terminal text input must not be empty.")
    callbacks.emitInputBytes(input.bytes)
    return TermuxWriteResult(accepted = true)
  }

  override fun sendKeyEvent(keyCode: Int, event: KeyEvent): Boolean {
    if (disposed || event.action != KeyEvent.ACTION_DOWN) return false

    if (keyCode == KeyEvent.KEYCODE_LANGUAGE_SWITCH || keyCode == KeyEvent.KEYCODE_BACK) {
      return false
    }

    val metaState = event.metaState
    val controlDown = event.isCtrlPressed
    val leftAltDown = (metaState and KeyEvent.META_ALT_LEFT_ON) != 0
    val rightAltDown = (metaState and KeyEvent.META_ALT_RIGHT_ON) != 0
    val shiftDown = event.isShiftPressed

    var keyMod = 0
    if (controlDown) keyMod = keyMod or KeyHandler.KEYMOD_CTRL
    if (event.isAltPressed || leftAltDown) keyMod = keyMod or KeyHandler.KEYMOD_ALT
    if (shiftDown) keyMod = keyMod or KeyHandler.KEYMOD_SHIFT
    if (event.isNumLockOn) keyMod = keyMod or KeyHandler.KEYMOD_NUM_LOCK

    if (!event.isFunctionPressed) {
      val code = KeyHandler.getCode(
        keyCode,
        keyMod,
        emulator.isCursorKeysApplicationMode,
        emulator.isKeypadApplicationMode,
      )
      if (code != null) {
        return sendUtf8Input(code)
      }
    }

    var bitsToClear = KeyEvent.META_CTRL_MASK
    if (!rightAltDown) {
      bitsToClear = bitsToClear or KeyEvent.META_ALT_ON or KeyEvent.META_ALT_LEFT_ON
    }
    var effectiveMetaState = event.metaState and bitsToClear.inv()
    if (shiftDown) {
      effectiveMetaState = effectiveMetaState or KeyEvent.META_SHIFT_ON or KeyEvent.META_SHIFT_LEFT_ON
    }

    var result = event.getUnicodeChar(effectiveMetaState)
    if (result == 0) {
      return false
    }

    if ((result and KeyCharacterMap.COMBINING_ACCENT) != 0) {
      if (combiningAccent != 0) {
        sendCodePoint(event.deviceId, combiningAccent, controlDown, leftAltDown)
      }
      combiningAccent = result and KeyCharacterMap.COMBINING_ACCENT_MASK
      return true
    }

    if (combiningAccent != 0) {
      val combinedChar = KeyCharacterMap.getDeadChar(combiningAccent, result)
      if (combinedChar > 0) {
        result = combinedChar
      }
      combiningAccent = 0
    }

    return sendCodePoint(event.deviceId, result, controlDown, leftAltDown)
  }

  override fun handleMotionEvent(event: MotionEvent): Boolean {
    if (disposed) return false
    if (event.isFromSource(InputDevice.SOURCE_MOUSE) && event.action == MotionEvent.ACTION_SCROLL) {
      val rowsDown = if (event.getAxisValue(MotionEvent.AXIS_VSCROLL) > 0f) -3 else 3
      return scrollRows(rowsDown, event)
    }

    if (event.action == MotionEvent.ACTION_UP && !event.isFromSource(InputDevice.SOURCE_MOUSE)) {
      if (emulator.isMouseTrackingActive) {
        sendMouseEventCode(event, TerminalEmulator.MOUSE_LEFT_BUTTON, true)
        sendMouseEventCode(event, TerminalEmulator.MOUSE_LEFT_BUTTON, false)
        return true
      }
      return emitLinkAt(event)
    }

    if (!event.isFromSource(InputDevice.SOURCE_MOUSE) || !emulator.isMouseTrackingActive) {
      return event.actionMasked == MotionEvent.ACTION_UP && emitLinkAt(event)
    }

    return when (event.actionMasked) {
      MotionEvent.ACTION_DOWN -> {
        if (event.isButtonPressed(MotionEvent.BUTTON_PRIMARY)) {
          sendMouseEventCode(event, TerminalEmulator.MOUSE_LEFT_BUTTON, true)
          true
        } else {
          false
        }
      }
      MotionEvent.ACTION_MOVE -> {
        if (event.isButtonPressed(MotionEvent.BUTTON_PRIMARY)) {
          sendMouseEventCode(event, TerminalEmulator.MOUSE_LEFT_BUTTON_MOVED, true)
          true
        } else {
          false
        }
      }
      MotionEvent.ACTION_UP -> {
        sendMouseEventCode(event, TerminalEmulator.MOUSE_LEFT_BUTTON, false)
        true
      }
      else -> false
    }
  }

  override fun resize(cols: Int, rows: Int): TermuxWriteResult {
    if (disposed) return rejected("surface-not-ready", "Android Termux surface has been disposed.")
    if (cols <= 0 || rows <= 0) return rejected("surface-not-ready", "cols and rows must be positive.")

    return try {
      resizeEmulator(cols, rows, cellWidthPx, cellHeightPx)
      callbacks.emitResize(cols, rows)
      TermuxWriteResult(accepted = true)
    } catch (error: Throwable) {
      callbacks.emitRendererCrash(error.message ?: error.javaClass.simpleName)
      rejected("renderer-unavailable", "Android Termux failed to resize the remote terminal.")
    }
  }

  override fun attachEventSink(eventSink: dev.happier.terminal.TermuxEventSink) {
    callbacks.attachEventSink(eventSink)
  }

  override fun focus() {
    emulator.setCursorBlinkState(true)
    emitSurfaceReady()
  }

  override fun clear() {
    emulator.reset()
    topRow = 0
    emitSurfaceReady()
  }

  override fun copySelection() {
    callbacks.emitCopy(accessibilitySummary())
  }

  override fun accessibilitySummary(): String {
    return try {
      emulator.getScreen().getSelectedText(0, 0, emulator.mColumns, emulator.mRows).toString()
    } catch (_: Throwable) {
      "Android native terminal surface $surfaceId is active."
    }
  }

  override fun draw(canvas: Canvas, width: Int, height: Int, fontSize: Float) {
    if (disposed) return
    val activeRenderer = rendererFor(fontSize)
    val nextCols = maxOf(4, (width / activeRenderer.fontWidthCompat()).toInt())
    val nextRows = maxOf(4, height / activeRenderer.fontLineSpacingCompat())
    if (nextCols != cols || nextRows != rows) {
      resizeEmulator(nextCols, nextRows, activeRenderer.fontWidthCompat().toInt(), activeRenderer.fontLineSpacingCompat())
      callbacks.emitResize(nextCols, nextRows)
    }
    activeRenderer.render(emulator, canvas, topRow, -1, -1, -1, -1)
  }

  override fun dispose() {
    disposed = true
  }

  private fun resizeEmulator(nextCols: Int, nextRows: Int, nextCellWidthPx: Int, nextCellHeightPx: Int) {
    cols = nextCols
    rows = nextRows
    cellWidthPx = maxOf(1, nextCellWidthPx)
    cellHeightPx = maxOf(1, nextCellHeightPx)
    topRow = 0
    emulator.resize(cols, rows, cellWidthPx, cellHeightPx)
  }

  private fun sendCodePoint(
    eventSource: Int,
    inputCodePoint: Int,
    controlDown: Boolean,
    leftAltDown: Boolean,
  ): Boolean {
    var codePoint = inputCodePoint
    if (controlDown) {
      codePoint = when {
        codePoint in 'a'.code..'z'.code -> codePoint - 'a'.code + 1
        codePoint in 'A'.code..'Z'.code -> codePoint - 'A'.code + 1
        codePoint == ' '.code || codePoint == '2'.code -> 0
        codePoint == '['.code || codePoint == '3'.code -> 27
        codePoint == '\\'.code || codePoint == '4'.code -> 28
        codePoint == ']'.code || codePoint == '5'.code -> 29
        codePoint == '^'.code || codePoint == '6'.code -> 30
        codePoint == '_'.code || codePoint == '7'.code || codePoint == '/'.code -> 31
        codePoint == '8'.code -> 127
        else -> codePoint
      }
    }

    if (eventSource > KEY_EVENT_SOURCE_SOFT_KEYBOARD) {
      codePoint = when (codePoint) {
        0x02dc -> 0x007e
        0x02cb -> 0x0060
        0x02c6 -> 0x005e
        else -> codePoint
      }
    }

    val text = StringBuilder()
    if (leftAltDown) {
      text.append('\u001b')
    }
    text.appendCodePoint(codePoint)
    return sendUtf8Input(text.toString())
  }

  private fun sendUtf8Input(text: String): Boolean {
    if (text.isEmpty()) return false
    callbacks.emitInputBytes(text.toByteArray(Charsets.UTF_8))
    return true
  }

  private fun scrollRows(rowsDown: Int, event: MotionEvent): Boolean {
    if (rowsDown == 0) return false
    val up = rowsDown < 0
    val amount = kotlin.math.abs(rowsDown)
    var handled = false
    repeat(amount) {
      when {
        emulator.isMouseTrackingActive -> {
          sendMouseEventCode(
            event,
            if (up) TerminalEmulator.MOUSE_WHEELUP_BUTTON else TerminalEmulator.MOUSE_WHEELDOWN_BUTTON,
            true,
          )
          handled = true
        }
        emulator.isAlternateBufferActive -> {
          val keyCode = if (up) KeyEvent.KEYCODE_DPAD_UP else KeyEvent.KEYCODE_DPAD_DOWN
          val code = KeyHandler.getCode(
            keyCode,
            0,
            emulator.isCursorKeysApplicationMode,
            emulator.isKeypadApplicationMode,
          )
          if (code != null) {
            handled = sendUtf8Input(code) || handled
          }
        }
        else -> {
          val previousTopRow = topRow
          val activeTranscriptRows = emulator.getScreen().getActiveTranscriptRows()
          topRow = minOf(0, maxOf(-activeTranscriptRows, topRow + if (up) -1 else 1))
          handled = handled || topRow != previousTopRow
        }
      }
    }
    return handled
  }

  private fun emitLinkAt(event: MotionEvent): Boolean {
    if (emulator.isMouseTrackingActive) return false
    val rendererWidth = renderer?.fontWidthCompat() ?: cellWidthPx.toFloat()
    val rendererHeight = renderer?.fontLineSpacingCompat() ?: cellHeightPx
    val column = (event.x / rendererWidth).toInt().coerceIn(0, emulator.mColumns - 1)
    val row = (topRow + (event.y / rendererHeight).toInt())
      .coerceIn(-emulator.getScreen().getActiveTranscriptRows(), emulator.mRows - 1)
    val word = try {
      emulator.getScreen().getWordAtLocation(column, row).trim()
    } catch (_: Throwable) {
      return false
    }
    val url = extractHttpUrlCandidate(word) ?: return false
    callbacks.emitLink(url, text = word)
    return true
  }

  private fun sendMouseEventCode(event: MotionEvent, button: Int, pressed: Boolean) {
    val rendererWidth = renderer?.fontWidthCompat() ?: cellWidthPx.toFloat()
    val rendererHeight = renderer?.fontLineSpacingCompat() ?: cellHeightPx
    var column = (event.x / rendererWidth).toInt() + 1
    var row = (event.y / rendererHeight).toInt() + 1
    if (pressed && (button == TerminalEmulator.MOUSE_WHEELDOWN_BUTTON || button == TerminalEmulator.MOUSE_WHEELUP_BUTTON)) {
      if (mouseScrollStartDownTime == event.downTime) {
        column = mouseScrollStartX
        row = mouseScrollStartY
      } else {
        mouseScrollStartDownTime = event.downTime
        mouseScrollStartX = column
        mouseScrollStartY = row
      }
    }
    emulator.sendMouseEvent(button, column, row, pressed)
  }

  private fun rendererFor(fontSize: Float): TerminalRenderer {
    val requestedSize = maxOf(8, fontSize.toInt())
    val existing = renderer
    if (existing != null && rendererFontSize == requestedSize) {
      return existing
    }
    val next = TerminalRenderer(requestedSize, Typeface.MONOSPACE)
    renderer = next
    rendererFontSize = requestedSize
    return next
  }

  private fun emitSurfaceReady() {
    callbacks.emitSurfaceReady(cols, rows)
  }

  private fun rejected(reason: String, detail: String): TermuxWriteResult {
    return TermuxWriteResult(
      accepted = false,
      reason = reason,
      detail = detail,
    )
  }
}

private fun extractHttpUrlCandidate(rawWord: String): String? {
  var candidate = rawWord.trim()
  while (candidate.isNotEmpty() && candidate.first() in LEADING_LINK_PUNCTUATION) {
    candidate = candidate.drop(1)
  }
  while (candidate.isNotEmpty() && candidate.last() in TRAILING_LINK_PUNCTUATION) {
    candidate = candidate.dropLast(1)
  }
  if (candidate.isEmpty() || candidate.length > MAX_LINK_CANDIDATE_LENGTH || candidate.any { it.isISOControl() }) {
    return null
  }
  val uri = try {
    URI(candidate)
  } catch (_: Throwable) {
    return null
  }
  val scheme = uri.scheme?.lowercase(Locale.ROOT) ?: return null
  if (scheme != "http" && scheme != "https") return null
  if (uri.host.isNullOrBlank()) return null
  return candidate
}

private fun TerminalRenderer.fontWidthCompat(): Float = getFontWidth().coerceAtLeast(1f)

private fun TerminalRenderer.fontLineSpacingCompat(): Int = getFontLineSpacing().coerceAtLeast(1)

private const val KEY_EVENT_SOURCE_SOFT_KEYBOARD = 0
private const val MAX_LINK_CANDIDATE_LENGTH = 2048
private val LEADING_LINK_PUNCTUATION = setOf('<', '(', '[', '{', '"', '\'')
private val TRAILING_LINK_PUNCTUATION = setOf('.', ',', ';', ':', '!', '?', ')', ']', '}', '>', '"', '\'')
