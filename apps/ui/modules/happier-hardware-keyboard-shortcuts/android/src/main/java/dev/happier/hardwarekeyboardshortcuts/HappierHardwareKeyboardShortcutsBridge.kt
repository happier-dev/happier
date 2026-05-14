package dev.happier.hardwarekeyboardshortcuts

import android.view.InputDevice
import android.view.KeyCharacterMap
import android.view.KeyEvent
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

  fun dispatchKeyEvent(event: KeyEvent): Boolean {
    if (!enabled || event.action != KeyEvent.ACTION_DOWN) return false
    if (event.deviceId == KeyCharacterMap.VIRTUAL_KEYBOARD) return false
    if (!event.isFromSource(InputDevice.SOURCE_KEYBOARD)) return false

    val module = moduleRef?.get() ?: return false
    if (!module.canReceiveHardwareKeyEvents()) return false
    val payload = payloadFromEvent(event) ?: return false
    module.emitHardwareKey(payload)
    return module.shouldConsumeHardwareKey(payload)
  }

  private fun payloadFromEvent(event: KeyEvent): Map<String, Any>? {
    val key = normalizedKey(event.keyCode) ?: return null
    val modifiers = mapOf(
      "shift" to event.isShiftPressed,
      "ctrl" to event.isCtrlPressed,
      "meta" to event.isMetaPressed,
      "alt" to event.isAltPressed
    )
    if (!shouldEmit(key, modifiers)) return null

    return mapOf(
      "key" to key,
      "code" to codeName(event.keyCode),
      "characters" to charactersForKey(key),
      "modifiers" to modifiers,
      "repeat" to (event.repeatCount > 0),
      "target" to "activity"
    )
  }

  private fun normalizedKey(keyCode: Int): String? = when (keyCode) {
    KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER -> "Enter"
    KeyEvent.KEYCODE_ESCAPE -> "Escape"
    else -> null
  }

  private fun codeName(keyCode: Int): String = when (keyCode) {
    KeyEvent.KEYCODE_ENTER -> "Enter"
    KeyEvent.KEYCODE_NUMPAD_ENTER -> "NumpadEnter"
    KeyEvent.KEYCODE_ESCAPE -> "Escape"
    else -> "Unidentified"
  }

  private fun charactersForKey(key: String): String = when (key) {
    "Enter" -> "\n"
    else -> ""
  }

  private fun shouldEmit(key: String, modifiers: Map<String, Boolean>): Boolean {
    return when {
      key == "Escape" -> true
      key == "Enter" -> isSupportedEnterModifier(modifiers)
      else -> false
    }
  }

  private fun isSupportedEnterModifier(modifiers: Map<String, Boolean>): Boolean =
    modifiers["shift"] == true || modifiers["ctrl"] == true || modifiers["meta"] == true
}
