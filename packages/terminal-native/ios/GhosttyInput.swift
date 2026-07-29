import Foundation
import UIKit

#if HAPPIER_TERMINAL_NATIVE_HAS_GHOSTTY
import libghostty
#endif

struct GhosttyInputEvent {
  let surfaceId: String
  let data: String
}

func makeGhosttyInputEvent(surfaceId: String, data: String) -> GhosttyInputEvent? {
  guard !surfaceId.isEmpty, !data.isEmpty else { return nil }
  return GhosttyInputEvent(surfaceId: surfaceId, data: data)
}

#if HAPPIER_TERMINAL_NATIVE_HAS_GHOSTTY
func withGhosttyInputKey<Result>(
  press: UIPress,
  action: ghostty_input_action_e,
  body: (ghostty_input_key_s) -> Result
) -> Result? {
  guard let key = press.key else { return nil }
  let translated = ghosttyKey(forHIDUsage: Int(key.keyCode.rawValue))
  let mods = ghosttyInputMods(from: key.modifierFlags)
  let text = key.characters
  let unshiftedCodepoint = UInt32(key.charactersIgnoringModifiers.unicodeScalars.first?.value ?? 0)

  return text.withCString { pointer in
    let textPointer: UnsafePointer<CChar>? = text.isEmpty ? nil : pointer
    let input = ghostty_input_key_s(
      action: action,
      mods: mods,
      consumed_mods: GHOSTTY_MODS_NONE,
      keycode: UInt32(translated.rawValue),
      text: textPointer,
      unshifted_codepoint: unshiftedCodepoint,
      composing: false
    )
    return body(input)
  }
}

private func ghosttyInputMods(from flags: UIKeyModifierFlags) -> ghostty_input_mods_e {
  var rawValue = GHOSTTY_MODS_NONE.rawValue
  if flags.contains(.shift) { rawValue |= GHOSTTY_MODS_SHIFT.rawValue }
  if flags.contains(.control) { rawValue |= GHOSTTY_MODS_CTRL.rawValue }
  if flags.contains(.alternate) { rawValue |= GHOSTTY_MODS_ALT.rawValue }
  if flags.contains(.command) { rawValue |= GHOSTTY_MODS_SUPER.rawValue }
  if flags.contains(.alphaShift) { rawValue |= GHOSTTY_MODS_CAPS.rawValue }
  return ghostty_input_mods_e(rawValue: rawValue)
}

private func ghosttyKey(forHIDUsage usage: Int) -> ghostty_input_key_e {
  switch usage {
  case 0x04: return GHOSTTY_KEY_A
  case 0x05: return GHOSTTY_KEY_B
  case 0x06: return GHOSTTY_KEY_C
  case 0x07: return GHOSTTY_KEY_D
  case 0x08: return GHOSTTY_KEY_E
  case 0x09: return GHOSTTY_KEY_F
  case 0x0A: return GHOSTTY_KEY_G
  case 0x0B: return GHOSTTY_KEY_H
  case 0x0C: return GHOSTTY_KEY_I
  case 0x0D: return GHOSTTY_KEY_J
  case 0x0E: return GHOSTTY_KEY_K
  case 0x0F: return GHOSTTY_KEY_L
  case 0x10: return GHOSTTY_KEY_M
  case 0x11: return GHOSTTY_KEY_N
  case 0x12: return GHOSTTY_KEY_O
  case 0x13: return GHOSTTY_KEY_P
  case 0x14: return GHOSTTY_KEY_Q
  case 0x15: return GHOSTTY_KEY_R
  case 0x16: return GHOSTTY_KEY_S
  case 0x17: return GHOSTTY_KEY_T
  case 0x18: return GHOSTTY_KEY_U
  case 0x19: return GHOSTTY_KEY_V
  case 0x1A: return GHOSTTY_KEY_W
  case 0x1B: return GHOSTTY_KEY_X
  case 0x1C: return GHOSTTY_KEY_Y
  case 0x1D: return GHOSTTY_KEY_Z
  case 0x1E: return GHOSTTY_KEY_DIGIT_1
  case 0x1F: return GHOSTTY_KEY_DIGIT_2
  case 0x20: return GHOSTTY_KEY_DIGIT_3
  case 0x21: return GHOSTTY_KEY_DIGIT_4
  case 0x22: return GHOSTTY_KEY_DIGIT_5
  case 0x23: return GHOSTTY_KEY_DIGIT_6
  case 0x24: return GHOSTTY_KEY_DIGIT_7
  case 0x25: return GHOSTTY_KEY_DIGIT_8
  case 0x26: return GHOSTTY_KEY_DIGIT_9
  case 0x27: return GHOSTTY_KEY_DIGIT_0
  case 0x28: return GHOSTTY_KEY_ENTER
  case 0x29: return GHOSTTY_KEY_ESCAPE
  case 0x2A: return GHOSTTY_KEY_BACKSPACE
  case 0x2B: return GHOSTTY_KEY_TAB
  case 0x2C: return GHOSTTY_KEY_SPACE
  case 0x2D: return GHOSTTY_KEY_MINUS
  case 0x2E: return GHOSTTY_KEY_EQUAL
  case 0x2F: return GHOSTTY_KEY_BRACKET_LEFT
  case 0x30: return GHOSTTY_KEY_BRACKET_RIGHT
  case 0x31: return GHOSTTY_KEY_BACKSLASH
  case 0x33: return GHOSTTY_KEY_SEMICOLON
  case 0x34: return GHOSTTY_KEY_QUOTE
  case 0x35: return GHOSTTY_KEY_BACKQUOTE
  case 0x36: return GHOSTTY_KEY_COMMA
  case 0x37: return GHOSTTY_KEY_PERIOD
  case 0x38: return GHOSTTY_KEY_SLASH
  case 0x39: return GHOSTTY_KEY_CAPS_LOCK
  case 0x3A: return GHOSTTY_KEY_F1
  case 0x3B: return GHOSTTY_KEY_F2
  case 0x3C: return GHOSTTY_KEY_F3
  case 0x3D: return GHOSTTY_KEY_F4
  case 0x3E: return GHOSTTY_KEY_F5
  case 0x3F: return GHOSTTY_KEY_F6
  case 0x40: return GHOSTTY_KEY_F7
  case 0x41: return GHOSTTY_KEY_F8
  case 0x42: return GHOSTTY_KEY_F9
  case 0x43: return GHOSTTY_KEY_F10
  case 0x44: return GHOSTTY_KEY_F11
  case 0x45: return GHOSTTY_KEY_F12
  case 0x49: return GHOSTTY_KEY_INSERT
  case 0x4A: return GHOSTTY_KEY_HOME
  case 0x4B: return GHOSTTY_KEY_PAGE_UP
  case 0x4C: return GHOSTTY_KEY_DELETE
  case 0x4D: return GHOSTTY_KEY_END
  case 0x4E: return GHOSTTY_KEY_PAGE_DOWN
  case 0x4F: return GHOSTTY_KEY_ARROW_RIGHT
  case 0x50: return GHOSTTY_KEY_ARROW_LEFT
  case 0x51: return GHOSTTY_KEY_ARROW_DOWN
  case 0x52: return GHOSTTY_KEY_ARROW_UP
  default: return GHOSTTY_KEY_UNIDENTIFIED
  }
}
#endif
