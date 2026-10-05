package dev.happier.hardwarekeyboardshortcuts

import android.view.InputDevice
import android.view.KeyCharacterMap
import android.view.KeyEvent
import android.view.View
import java.lang.ref.WeakReference

object HappierHardwareKeyboardShortcutsBridge {
  @Volatile
  private var enabled = false

  @Volatile
  private var moduleRef: WeakReference<HappierHardwareKeyboardShortcutsModule>? = null

  fun setModule(module: HappierHardwareKeyboardShortcutsModule) {
    moduleRef = WeakReference(module)
  }

  fun setEnabled(nextEnabled: Boolean) {
    enabled = nextEnabled
  }

  fun dispatchKeyEvent(event: KeyEvent, focusedView: View?): Boolean {
    if (!enabled || event.action != KeyEvent.ACTION_DOWN) return false
    if (event.deviceId == KeyCharacterMap.VIRTUAL_KEYBOARD) return false
    if (!event.isFromSource(InputDevice.SOURCE_KEYBOARD)) return false

    val module = moduleRef?.get() ?: return false
    if (!module.canReceiveHardwareKeyEvents()) return false
    val payload = payloadFromEvent(event, focusedView, module) ?: return false
    module.emitHardwareKey(payload)
    return module.shouldConsumeHardwareKey(payload)
  }

  private fun payloadFromEvent(event: KeyEvent, focusedView: View?, module: HappierHardwareKeyboardShortcutsModule): Map<String, Any>? {
    val key = normalizedKey(event.keyCode) ?: return null
    val modifiers = mapOf(
      "shift" to event.isShiftPressed,
      "ctrl" to event.isCtrlPressed,
      "meta" to event.isMetaPressed,
      "alt" to event.isAltPressed
    )
    val payload = mapOf(
      "key" to key,
      "code" to codeName(event.keyCode),
      "characters" to charactersForKey(key),
      "modifiers" to modifiers,
      "repeat" to (event.repeatCount > 0),
      "target" to "activity",
      // Activity.currentFocus is the canonical focused native View. ReactEditText
      // reports itself as a text editor through this platform API.
      "isEditableTarget" to (focusedView?.onCheckIsTextEditor() == true)
    )
    // Focused input keys (plain Return and arrows) are admitted by the same
    // provider configuration that decides whether Android consumes them.
    if (!shouldEmit(key, modifiers) && !module.shouldConsumeHardwareKey(payload)) return null
    return payload
  }

  private fun normalizedKey(keyCode: Int): String? = when (keyCode) {
    KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER -> "Enter"
    KeyEvent.KEYCODE_ESCAPE -> "Escape"
    KeyEvent.KEYCODE_DPAD_UP -> "ArrowUp"
    KeyEvent.KEYCODE_DPAD_DOWN -> "ArrowDown"
    KeyEvent.KEYCODE_K -> "k"
    else -> normalizedPrintableKey(keyCode)
  }

  private fun codeName(keyCode: Int): String = when (keyCode) {
    KeyEvent.KEYCODE_ENTER -> "Enter"
    KeyEvent.KEYCODE_NUMPAD_ENTER -> "NumpadEnter"
    KeyEvent.KEYCODE_ESCAPE -> "Escape"
    KeyEvent.KEYCODE_DPAD_UP -> "ArrowUp"
    KeyEvent.KEYCODE_DPAD_DOWN -> "ArrowDown"
    KeyEvent.KEYCODE_K -> "KeyK"
    else -> codeNameForPrintableKey(keyCode)
  }

  private fun normalizedPrintableKey(keyCode: Int): String? = when {
    keyCode in KeyEvent.KEYCODE_A..KeyEvent.KEYCODE_Z ->
      ('a'.code + (keyCode - KeyEvent.KEYCODE_A)).toChar().toString()
    keyCode in KeyEvent.KEYCODE_0..KeyEvent.KEYCODE_9 ->
      ('0'.code + (keyCode - KeyEvent.KEYCODE_0)).toChar().toString()
    keyCode == KeyEvent.KEYCODE_PERIOD -> "."
    keyCode == KeyEvent.KEYCODE_LEFT_BRACKET -> "["
    keyCode == KeyEvent.KEYCODE_RIGHT_BRACKET -> "]"
    keyCode == KeyEvent.KEYCODE_SLASH -> "/"
    else -> null
  }

  private fun codeNameForPrintableKey(keyCode: Int): String = when {
    keyCode in KeyEvent.KEYCODE_A..KeyEvent.KEYCODE_Z ->
      "Key${('A'.code + (keyCode - KeyEvent.KEYCODE_A)).toChar()}"
    keyCode in KeyEvent.KEYCODE_0..KeyEvent.KEYCODE_9 ->
      "Digit${('0'.code + (keyCode - KeyEvent.KEYCODE_0)).toChar()}"
    keyCode == KeyEvent.KEYCODE_PERIOD -> "Period"
    keyCode == KeyEvent.KEYCODE_LEFT_BRACKET -> "BracketLeft"
    keyCode == KeyEvent.KEYCODE_RIGHT_BRACKET -> "BracketRight"
    keyCode == KeyEvent.KEYCODE_SLASH -> "Slash"
    else -> "Unidentified"
  }

  private fun charactersForKey(key: String): String = when (key) {
    "Enter" -> "\n"
    "k" -> "k"
    else -> ""
  }

  private fun shouldEmit(key: String, modifiers: Map<String, Boolean>): Boolean {
    return when {
      key == "Escape" -> true
      key == "Enter" -> isSupportedEnterModifier(modifiers)
      else -> key.length == 1
    }
  }

  private fun isSupportedEnterModifier(modifiers: Map<String, Boolean>): Boolean =
    modifiers["shift"] == true || modifiers["ctrl"] == true || modifiers["meta"] == true
}
