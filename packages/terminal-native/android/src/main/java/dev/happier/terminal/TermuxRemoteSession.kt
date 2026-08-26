package dev.happier.terminal

import android.graphics.Canvas
import android.graphics.Color
import android.view.KeyEvent
import android.view.MotionEvent
import java.lang.reflect.Constructor
import java.util.concurrent.CancellationException

fun interface TermuxEventSink {
  fun send(eventName: String, payload: Map<String, Any?>)
}

interface TermuxRemoteSession {
  val diagnostic: TermuxBridgeDiagnostic

  fun writeBytes(bytes: ByteArray, byteOffset: Long): TermuxWriteResult
  fun sendInputBytes(bytes: ByteArray): TermuxWriteResult
  fun sendTextInput(text: CharSequence): TermuxWriteResult
  fun sendKeyEvent(keyCode: Int, event: KeyEvent): Boolean
  fun handleMotionEvent(event: MotionEvent): Boolean
  fun resize(cols: Int, rows: Int): TermuxWriteResult
  fun attachEventSink(eventSink: TermuxEventSink)
  fun focus()
  fun clear()
  fun copySelection()
  fun accessibilitySummary(): String?
  fun draw(canvas: Canvas, width: Int, height: Int, fontSize: Float)
  fun dispose()
}

class TermuxRemoteSessionCallbacks(
  private val surfaceId: String,
  private var eventSink: TermuxEventSink?,
) {
  fun attachEventSink(eventSink: TermuxEventSink) {
    this.eventSink = eventSink
  }

  fun emitWriteAck(byteOffset: Long) {
    emit("writeAck", mapOf("surfaceId" to surfaceId, "byteOffset" to byteOffset))
  }

  fun emitInputBytes(bytes: ByteArray) {
    if (bytes.isEmpty()) return
    emit(
      "input",
      mapOf(
        "surfaceId" to surfaceId,
        "data" to bytes.toString(Charsets.UTF_8),
      ),
    )
  }

  fun emitResize(cols: Int, rows: Int) {
    emit("resize", mapOf("surfaceId" to surfaceId, "cols" to cols, "rows" to rows))
  }

  fun emitCopy(text: String) {
    emit("copy", mapOf("surfaceId" to surfaceId, "text" to text))
  }

  fun emitSelection(text: String?) {
    if (text.isNullOrEmpty()) {
      emit("selection", mapOf("surfaceId" to surfaceId, "state" to "cleared"))
    } else {
      emit("selection", mapOf("surfaceId" to surfaceId, "state" to "changed", "text" to text))
    }
  }

  fun emitSelectionState(state: String, text: String? = null) {
    val payload = mutableMapOf<String, Any?>("surfaceId" to surfaceId, "state" to state)
    if (!text.isNullOrEmpty()) payload["text"] = text
    emit("selection", payload)
  }

  fun emitTitle(title: String) {
    emit("title", mapOf("surfaceId" to surfaceId, "title" to title))
  }

  fun emitBell() {
    emit("bell", mapOf("surfaceId" to surfaceId))
  }

  fun emitLink(url: String, text: String? = null) {
    if (url.isBlank()) return
    val payload = mutableMapOf<String, Any?>("surfaceId" to surfaceId, "url" to url)
    if (!text.isNullOrBlank()) {
      payload["text"] = text
    }
    emit("link", payload)
  }

  fun emitRendererCrash(message: String) {
    emit("rendererCrash", mapOf("surfaceId" to surfaceId, "reason" to message, "fatal" to true))
  }

  fun emitSurfaceReady(cols: Int, rows: Int) {
    emit("surfaceReady", mapOf("surfaceId" to surfaceId, "cols" to cols, "rows" to rows))
  }

  private fun emit(eventName: String, payload: Map<String, Any?>) {
    eventSink?.send(eventName, payload)
  }
}

object TermuxRemoteSessionFactory {
  fun create(surfaceId: String, eventSink: TermuxEventSink?): TermuxRemoteSession {
    val diagnostic = makeTermuxBridgeDiagnostic()
    if (!diagnostic.available) {
      return UnavailableTermuxRemoteSession(
        surfaceId,
        eventSink,
        "${diagnostic.reason}: ${diagnostic.detail}",
      )
    }

    if (!BuildConfig.HAPPIER_TERMINAL_NATIVE_HAS_TERMUX_SOURCE) {
      return UnavailableTermuxRemoteSession(surfaceId, eventSink)
    }

    return try {
      val callbacks = TermuxRemoteSessionCallbacks(surfaceId, eventSink)
      val constructor = termuxBackedConstructor()
      constructor.newInstance(surfaceId, callbacks)
    } catch (error: Throwable) {
      if (error is CancellationException || error is VirtualMachineError || error is ThreadDeath) throw error
      UnavailableTermuxRemoteSession(
        surfaceId,
        eventSink,
        "Termux-backed remote session failed to load: ${error.message ?: error.javaClass.simpleName}.",
      )
    }
  }

  @Suppress("UNCHECKED_CAST")
  private fun termuxBackedConstructor(): Constructor<out TermuxRemoteSession> {
    val type = Class.forName("dev.happier.terminal.termux.TermuxBackedRemoteSession")
      .asSubclass(TermuxRemoteSession::class.java)
    return type.getConstructor(String::class.java, TermuxRemoteSessionCallbacks::class.java)
  }
}

private class UnavailableTermuxRemoteSession(
  private val surfaceId: String,
  eventSink: TermuxEventSink?,
  private val overrideDetail: String? = null,
) : TermuxRemoteSession {
  override val diagnostic: TermuxBridgeDiagnostic = makeUnavailableTermuxBridgeDiagnostic(overrideDetail)
  private val callbacks = TermuxRemoteSessionCallbacks(surfaceId, eventSink)
  private var disposed = false

  override fun writeBytes(bytes: ByteArray, byteOffset: Long): TermuxWriteResult {
    if (disposed) {
      return rejected("surface-not-ready", "Android Termux surface has been disposed.")
    }
    if (bytes.isEmpty()) {
      return rejected("invalid-ack", "Native terminal writes must contain at least one byte.")
    }
    if (byteOffset < 0) {
      return rejected("invalid-ack", "byteOffset must be non-negative.")
    }
    return rejected(
      "renderer-unavailable",
      overrideDetail ?: "Android Termux renderer source is not linked; xterm WebView must remain selected.",
    )
  }

  override fun sendInputBytes(bytes: ByteArray): TermuxWriteResult {
    if (disposed) return rejected("surface-not-ready", "Android Termux surface has been disposed.")
    if (bytes.isEmpty()) return rejected("invalid-ack", "Native terminal input must contain at least one byte.")
    return rejected(
      "renderer-unavailable",
      overrideDetail ?: "Android Termux renderer source is not linked; xterm WebView must remain selected.",
    )
  }

  override fun sendTextInput(text: CharSequence): TermuxWriteResult {
    if (disposed) return rejected("surface-not-ready", "Android Termux surface has been disposed.")
    if (text.isEmpty()) return rejected("invalid-ack", "Native terminal text input must not be empty.")
    return rejected(
      "renderer-unavailable",
      overrideDetail ?: "Android Termux renderer source is not linked; xterm WebView must remain selected.",
    )
  }

  override fun sendKeyEvent(keyCode: Int, event: KeyEvent): Boolean {
    if (disposed || event.action != KeyEvent.ACTION_DOWN) return false
    val text = when {
      keyCode == KeyEvent.KEYCODE_ENTER -> "\r"
      keyCode == KeyEvent.KEYCODE_DEL -> "\u007f"
      keyCode == KeyEvent.KEYCODE_ESCAPE -> "\u001b"
      else -> {
        val codePoint = event.getUnicodeChar(event.metaState)
        if (codePoint == 0) null else String(Character.toChars(codePoint))
      }
    } ?: return false

    return sendTextInput(text).accepted
  }

  override fun handleMotionEvent(event: MotionEvent): Boolean {
    return false
  }

  override fun resize(cols: Int, rows: Int): TermuxWriteResult {
    if (cols <= 0 || rows <= 0) return rejected("surface-not-ready", "cols and rows must be positive.")
    return rejected(
      "renderer-unavailable",
      overrideDetail ?: "Android Termux renderer is unavailable until package gates pass.",
    )
  }

  override fun attachEventSink(eventSink: TermuxEventSink) {
    callbacks.attachEventSink(eventSink)
  }

  override fun focus() {
  }

  override fun clear() {
  }

  override fun copySelection() {
  }

  override fun accessibilitySummary(): String? = null

  override fun draw(canvas: Canvas, width: Int, height: Int, fontSize: Float) {
    canvas.drawColor(Color.BLACK)
  }

  override fun dispose() {
    disposed = true
  }

  private fun rejected(reason: String, detail: String): TermuxWriteResult {
    return TermuxWriteResult(
      accepted = false,
      reason = reason,
      detail = detail,
    )
  }
}
