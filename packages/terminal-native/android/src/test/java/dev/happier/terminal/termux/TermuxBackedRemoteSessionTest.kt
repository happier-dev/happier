package dev.happier.terminal.termux

import android.graphics.Canvas
import android.graphics.Paint
import android.view.MotionEvent
import dev.happier.terminal.TermuxEventSink
import dev.happier.terminal.TermuxRemoteSessionCallbacks
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [35])
class TermuxBackedRemoteSessionTest {
  @Test
  fun blankTerminalExposesNoSyntheticAccessibilityText() {
    val session = TermuxBackedRemoteSession(
      surfaceId = "secret-surface-id",
      callbacks = TermuxRemoteSessionCallbacks("secret-surface-id", null),
    )

    assertEquals("", session.accessibilitySummary())
  }

  @Test
  fun drawFailureEmitsFatalRendererCrashInsteadOfEscapingTheNativeView() {
    val events = mutableListOf<Pair<String, Map<String, Any?>>>()
    val session = TermuxBackedRemoteSession(
      surfaceId = "surface",
      callbacks = TermuxRemoteSessionCallbacks(
        "surface",
        TermuxEventSink { eventName, payload -> events += eventName to payload },
      ),
    )

    assertTrue(session.writeBytes("terminal output".toByteArray(), 0).accepted)
    session.draw(ThrowingCanvas(), 320, 240, 14f)

    val crashes = events.filter { (eventName) -> eventName == "rendererCrash" }
    assertEquals(1, crashes.size)
    assertEquals(true, crashes.single().second["fatal"])
  }

  @Test
  fun osc52ClipboardWriteDoesNotReachJsButExplicitTouchRangeCopyDoes() {
    val events = mutableListOf<Pair<String, Map<String, Any?>>>()
    val session = TermuxBackedRemoteSession(
      surfaceId = "surface",
      callbacks = TermuxRemoteSessionCallbacks(
        "surface",
        TermuxEventSink { eventName, payload -> events += eventName to payload },
      ),
    )
    val osc52 = "\u001B]52;c;cmVtb3RlIGNsaXBib2FyZA==\u0007".toByteArray()

    assertTrue(session.writeBytes(osc52, 0).accepted)
    assertFalse(events.any { (eventName) -> eventName == "copy" })

    assertTrue(session.writeBytes("\u001b[2J\u001b[Halpha bravo".toByteArray(), osc52.size.toLong()).accepted)
    session.copySelection()
    assertFalse(events.any { (eventName) -> eventName == "copy" })

    val downTime = 1_000L
    session.handleMotionEvent(MotionEvent.obtain(downTime, downTime, MotionEvent.ACTION_DOWN, 61f, 9f, 0))
    assertTrue(
      session.handleMotionEvent(
        MotionEvent.obtain(downTime, downTime + 750L, MotionEvent.ACTION_MOVE, 109f, 9f, 0),
      ),
    )
    assertTrue(
      session.handleMotionEvent(
        MotionEvent.obtain(downTime, downTime + 800L, MotionEvent.ACTION_UP, 109f, 9f, 0),
      ),
    )
    session.copySelection()

    val copyEvents = events.filter { (eventName) -> eventName == "copy" }
    assertEquals(1, copyEvents.size)
    assertEquals("bravo", copyEvents.single().second["text"])
    assertEquals(
      listOf("started", "changed", "ended", "copied", "cleared"),
      events.filter { (eventName) -> eventName == "selection" }.map { (_, payload) -> payload["state"] },
    )
  }
}

private class ThrowingCanvas : Canvas() {
  override fun drawTextRun(
    text: CharArray,
    index: Int,
    count: Int,
    contextIndex: Int,
    contextCount: Int,
    x: Float,
    y: Float,
    isRtl: Boolean,
    paint: Paint,
  ) {
    throw IllegalStateException("expected renderer draw failure")
  }
}
