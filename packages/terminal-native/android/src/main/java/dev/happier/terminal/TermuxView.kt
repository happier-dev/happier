package dev.happier.terminal

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.text.InputType
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.accessibility.AccessibilityEvent
import android.view.inputmethod.BaseInputConnection
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import android.view.inputmethod.InputMethodManager
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.views.ExpoView

class TermuxView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  private var surfaceId = ""
  private var fontSize = 14.0
  private var lineHeightPx = 18.0
  private var accessibilitySummary = ""
  private var accessibilityAccepted = false
  private var accessibilityRefreshPosted = false
  private val surfaceInvalidator: () -> Unit = {
    postInvalidateOnAnimation()
    if (!accessibilityRefreshPosted) {
      accessibilityRefreshPosted = true
      post {
        accessibilityRefreshPosted = false
        refreshAccessibility()
        sendAccessibilityEvent(AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED)
      }
    }
  }
  private val surfaceFocusRequester: () -> Unit = {
    requestNativeViewFocus()
  }

  init {
    setBackgroundColor(Color.BLACK)
    isFocusable = true
    isFocusableInTouchMode = true
    importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_YES
    refreshAccessibility()
  }

  fun setSurfaceId(surfaceId: String) {
    if (this.surfaceId == surfaceId) return
    if (this.surfaceId.isNotBlank()) {
      TermuxBridge.unregisterSurfaceInvalidator(this.surfaceId, surfaceInvalidator)
      TermuxBridge.unregisterSurfaceFocusRequester(this.surfaceId, surfaceFocusRequester)
    }
    this.surfaceId = surfaceId
    if (surfaceId.isNotBlank()) {
      TermuxBridge.createSurface(surfaceId)
      TermuxBridge.registerSurfaceInvalidator(surfaceId, surfaceInvalidator)
      TermuxBridge.registerSurfaceFocusRequester(surfaceId, surfaceFocusRequester)
    }
    refreshAccessibility()
  }

  fun setTerminalFontSize(fontSize: Double) {
    if (fontSize > 0) {
      this.fontSize = fontSize
    }
  }

  fun setTerminalLineHeightPx(lineHeightPx: Double) {
    if (lineHeightPx > 0) {
      this.lineHeightPx = lineHeightPx
    }
  }

  fun setAccessibilitySummary(accessibilitySummary: String) {
    this.accessibilitySummary = accessibilitySummary.trim()
    refreshAccessibility()
  }

  fun setAccessibilityAccepted(accessibilityAccepted: Boolean) {
    this.accessibilityAccepted = accessibilityAccepted
    refreshAccessibility()
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    val currentSurfaceId = surfaceId
    if (currentSurfaceId.isNotBlank()) {
      TermuxBridge.registerSurfaceInvalidator(currentSurfaceId, surfaceInvalidator)
      TermuxBridge.registerSurfaceFocusRequester(currentSurfaceId, surfaceFocusRequester)
    }
  }

  override fun onDetachedFromWindow() {
    val currentSurfaceId = surfaceId
    if (currentSurfaceId.isNotBlank()) {
      TermuxBridge.unregisterSurfaceInvalidator(currentSurfaceId, surfaceInvalidator)
      TermuxBridge.unregisterSurfaceFocusRequester(currentSurfaceId, surfaceFocusRequester)
    }
    super.onDetachedFromWindow()
  }

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    if (surfaceId.isNotBlank()) {
      TermuxBridge.drawSurface(surfaceId, canvas, width, height, fontSize.toFloat())
    }
  }

  override fun onCheckIsTextEditor(): Boolean = true

  override fun onCreateInputConnection(outAttrs: EditorInfo): InputConnection {
    outAttrs.inputType = InputType.TYPE_CLASS_TEXT or
      InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD or
      InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS or
      InputType.TYPE_TEXT_FLAG_MULTI_LINE
    outAttrs.imeOptions = EditorInfo.IME_ACTION_NONE or
      EditorInfo.IME_FLAG_NO_EXTRACT_UI or
      EditorInfo.IME_FLAG_NO_FULLSCREEN

    return object : BaseInputConnection(this, true) {
      override fun commitText(text: CharSequence?, newCursorPosition: Int): Boolean {
        if (!text.isNullOrEmpty()) {
          TermuxBridge.sendTextInput(surfaceId, text)
        }
        val committed = super.commitText(text, newCursorPosition)
        editable?.clear()
        return committed
      }

      override fun finishComposingText(): Boolean {
        val content = editable
        if (!content.isNullOrEmpty()) {
          TermuxBridge.sendTextInput(surfaceId, content)
          content.clear()
        }
        return super.finishComposingText()
      }

      override fun deleteSurroundingText(leftLength: Int, rightLength: Int): Boolean {
        val deleteInput = makeTermuxDeleteInputBytes(surfaceId, leftLength)
        if (deleteInput != null) {
          TermuxBridge.sendInputBytes(surfaceId, android.util.Base64.encodeToString(deleteInput.bytes, android.util.Base64.NO_WRAP))
        }
        return super.deleteSurroundingText(leftLength, rightLength)
      }

      override fun sendKeyEvent(event: KeyEvent): Boolean {
        if (event.action == KeyEvent.ACTION_DOWN) {
          if (TermuxBridge.sendKeyEvent(surfaceId, event.keyCode, event)) {
            return true
          }
        }
        return super.sendKeyEvent(event)
      }
    }
  }

  override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
    if (surfaceId.isBlank() || keyCode == KeyEvent.KEYCODE_BACK || event.isSystem) {
      return super.onKeyDown(keyCode, event)
    }
    return if (TermuxBridge.sendKeyEvent(surfaceId, keyCode, event)) {
      true
    } else {
      super.onKeyDown(keyCode, event)
    }
  }

  override fun onKeyUp(keyCode: Int, event: KeyEvent): Boolean {
    if (surfaceId.isNotBlank() && keyCode != KeyEvent.KEYCODE_BACK && !event.isSystem) {
      return true
    }
    return super.onKeyUp(keyCode, event)
  }

  override fun onGenericMotionEvent(event: MotionEvent): Boolean {
    if (TermuxBridge.handleMotionEvent(surfaceId, event)) {
      return true
    }
    return super.onGenericMotionEvent(event)
  }

  override fun onTouchEvent(event: MotionEvent): Boolean {
    if (event.action == MotionEvent.ACTION_DOWN) {
      requestTerminalFocus(showKeyboard = true)
    }
    val handledByTerminal = TermuxBridge.handleMotionEvent(surfaceId, event)
    if (event.action == MotionEvent.ACTION_UP) {
      performClick()
    }
    return handledByTerminal || surfaceId.isNotBlank() || super.onTouchEvent(event)
  }

  override fun performClick(): Boolean {
    requestTerminalFocus(showKeyboard = true)
    return super.performClick()
  }

  override fun onFocusChanged(gainFocus: Boolean, direction: Int, previouslyFocusedRect: android.graphics.Rect?) {
    super.onFocusChanged(gainFocus, direction, previouslyFocusedRect)
    if (gainFocus) {
      TermuxBridge.focusSurface(surfaceId)
    }
  }

  private fun refreshAccessibility() {
    val diagnostic = makeTermuxAccessibilityDiagnostic()
    contentDescription = if (accessibilitySummary.isNotBlank()) {
      accessibilitySummary
    } else if (surfaceId.isNotBlank()) {
      TermuxBridge.accessibilitySummary(surfaceId)
        ?: "Native terminal renderer unavailable. ${diagnostic.fallbackRenderer} fallback is required for accessible terminal content."
    } else {
      "Native terminal renderer unavailable. ${diagnostic.fallbackRenderer} fallback is required for accessible terminal content."
    }
  }

  private fun requestTerminalFocus(showKeyboard: Boolean) {
    if (surfaceId.isBlank()) return
    if (!hasFocus()) {
      requestFocus()
    }
    TermuxBridge.focusSurface(surfaceId)
    if (showKeyboard) {
      showSoftKeyboard()
    }
  }

  private fun requestNativeViewFocus() {
    if (!isAttachedToWindow) return
    post {
      if (!hasFocus()) {
        requestFocus()
      }
      showSoftKeyboard()
    }
  }

  private fun showSoftKeyboard() {
    val inputMethodManager = context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager
    inputMethodManager?.showSoftInput(this, InputMethodManager.SHOW_IMPLICIT)
  }
}
