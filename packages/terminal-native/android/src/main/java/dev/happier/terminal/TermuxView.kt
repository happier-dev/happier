package dev.happier.terminal

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.text.InputType
import android.os.Bundle
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
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
  private var accessibilityTerminalLabel = ""
  private var accessibilityFallbackValue = ""
  private var accessibilityFocusActionLabel = ""
  private var accessibilityCopySelectionActionLabel = ""
  private var accessibilitySelectAllActionLabel = ""
  private var accessibilityOpenLinkActionLabel = ""
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

  fun setAccessibilityTerminalLabel(label: String) {
    accessibilityTerminalLabel = label.trim()
    refreshAccessibility()
  }

  fun setAccessibilityFallbackValue(value: String) {
    accessibilityFallbackValue = value.trim()
    refreshAccessibility()
  }

  fun setAccessibilityFocusActionLabel(label: String) {
    accessibilityFocusActionLabel = label.trim()
    notifyAccessibilityActionsChanged()
  }

  fun setAccessibilityCopySelectionActionLabel(label: String) {
    accessibilityCopySelectionActionLabel = label.trim()
    notifyAccessibilityActionsChanged()
  }

  fun setAccessibilitySelectAllActionLabel(label: String) {
    accessibilitySelectAllActionLabel = label.trim()
    notifyAccessibilityActionsChanged()
  }

  fun setAccessibilityOpenLinkActionLabel(label: String) {
    accessibilityOpenLinkActionLabel = label.trim()
    notifyAccessibilityActionsChanged()
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

  override fun onInitializeAccessibilityNodeInfo(info: AccessibilityNodeInfo) {
    super.onInitializeAccessibilityNodeInfo(info)
    if (!accessibilityAccepted || surfaceId.isBlank()) return
    if (accessibilityFocusActionLabel.isNotBlank()) {
      info.addAction(AccessibilityNodeInfo.AccessibilityAction(ACTION_FOCUS_TERMINAL, accessibilityFocusActionLabel))
    }
    if (accessibilityCopySelectionActionLabel.isNotBlank()) {
      info.addAction(AccessibilityNodeInfo.AccessibilityAction(ACTION_COPY_SELECTION, accessibilityCopySelectionActionLabel))
    }
    if (accessibilitySelectAllActionLabel.isNotBlank()) {
      info.addAction(AccessibilityNodeInfo.AccessibilityAction(ACTION_SELECT_ALL, accessibilitySelectAllActionLabel))
    }
    if (accessibilityOpenLinkActionLabel.isNotBlank()) {
      info.addAction(AccessibilityNodeInfo.AccessibilityAction(ACTION_OPEN_LINK, accessibilityOpenLinkActionLabel))
    }
  }

  override fun performAccessibilityAction(action: Int, arguments: Bundle?): Boolean {
    if (!accessibilityAccepted || surfaceId.isBlank()) {
      return super.performAccessibilityAction(action, arguments)
    }
    if (action == ACTION_FOCUS_TERMINAL) {
      requestTerminalFocus(showKeyboard = true)
      return true
    }
    if (action == ACTION_COPY_SELECTION) {
      TermuxBridge.copySelection(surfaceId)
      return true
    }
    if (action == ACTION_SELECT_ALL) {
      return TermuxBridge.selectAll(surfaceId)
    }
    if (action == ACTION_OPEN_LINK) {
      return TermuxBridge.openAccessibleLink(surfaceId)
    }
    return super.performAccessibilityAction(action, arguments)
  }

  override fun onFocusChanged(gainFocus: Boolean, direction: Int, previouslyFocusedRect: android.graphics.Rect?) {
    super.onFocusChanged(gainFocus, direction, previouslyFocusedRect)
    if (gainFocus) {
      TermuxBridge.focusSurface(surfaceId)
    }
  }

  private fun refreshAccessibility() {
    if (!accessibilityAccepted) {
      importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
      contentDescription = null
      notifyAccessibilityActionsChanged()
      return
    }
    importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_YES
    val value = if (accessibilitySummary.isNotBlank()) {
      accessibilitySummary
    } else if (surfaceId.isNotBlank()) {
      TermuxBridge.accessibilitySummary(surfaceId)
        ?.takeUnless { it.isNullOrBlank() }
        ?: accessibilityFallbackValue
    } else {
      accessibilityFallbackValue
    }
    contentDescription = listOf(accessibilityTerminalLabel, value)
      .filter { it.isNotBlank() }
      .joinToString(". ")
  }

  private fun notifyAccessibilityActionsChanged() {
    if (isAttachedToWindow) {
      sendAccessibilityEvent(AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED)
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

  private companion object {
    const val ACTION_FOCUS_TERMINAL = 0x01020001
    const val ACTION_COPY_SELECTION = 0x01020002
    const val ACTION_SELECT_ALL = 0x01020003
    const val ACTION_OPEN_LINK = 0x01020004
  }
}
