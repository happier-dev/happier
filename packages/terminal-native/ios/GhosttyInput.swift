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
  composing: Bool,
  body: (ghostty_input_key_s) -> Result
) -> Result? {
  guard let key = press.key else { return nil }
  let mods = ghosttyInputMods(from: key.modifierFlags)
  let includesText = action == GHOSTTY_ACTION_PRESS || action == GHOSTTY_ACTION_REPEAT
  let text = includesText ? key.characters : ""
  let unshiftedCodepoint = includesText
    ? UInt32(key.charactersIgnoringModifiers.unicodeScalars.first?.value ?? 0)
    : 0

  return text.withCString { pointer in
    let textPointer: UnsafePointer<CChar>? = text.isEmpty ? nil : pointer
    let input = ghostty_input_key_s(
      action: action,
      mods: mods,
      consumed_mods: GHOSTTY_MODS_NONE,
      keycode: ghosttyAppKitKeyCode(forHIDUsage: Int(key.keyCode.rawValue)),
      text: textPointer,
      unshifted_codepoint: unshiftedCodepoint,
      composing: composing
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

// Ghostty's iOS native-keycode table uses macOS virtual keycodes. UIKey exposes
// USB HID usages, so translate the supported UIKit keys before crossing the C API.
private func ghosttyAppKitKeyCode(forHIDUsage usage: Int) -> UInt32 {
  switch usage {
  case 0x04: return 0x00
  case 0x05: return 0x0B
  case 0x06: return 0x08
  case 0x07: return 0x02
  case 0x08: return 0x0E
  case 0x09: return 0x03
  case 0x0A: return 0x05
  case 0x0B: return 0x04
  case 0x0C: return 0x22
  case 0x0D: return 0x26
  case 0x0E: return 0x28
  case 0x0F: return 0x25
  case 0x10: return 0x2E
  case 0x11: return 0x2D
  case 0x12: return 0x1F
  case 0x13: return 0x23
  case 0x14: return 0x0C
  case 0x15: return 0x0F
  case 0x16: return 0x01
  case 0x17: return 0x11
  case 0x18: return 0x20
  case 0x19: return 0x09
  case 0x1A: return 0x0D
  case 0x1B: return 0x07
  case 0x1C: return 0x10
  case 0x1D: return 0x06
  case 0x1E: return 0x12
  case 0x1F: return 0x13
  case 0x20: return 0x14
  case 0x21: return 0x15
  case 0x22: return 0x17
  case 0x23: return 0x16
  case 0x24: return 0x1A
  case 0x25: return 0x1C
  case 0x26: return 0x19
  case 0x27: return 0x1D
  case 0x28: return 0x24
  case 0x29: return 0x35
  case 0x2A: return 0x33
  case 0x2B: return 0x30
  case 0x2C: return 0x31
  case 0x2D: return 0x1B
  case 0x2E: return 0x18
  case 0x2F: return 0x21
  case 0x30: return 0x1E
  case 0x31: return 0x2A
  case 0x33: return 0x29
  case 0x34: return 0x27
  case 0x35: return 0x32
  case 0x36: return 0x2B
  case 0x37: return 0x2F
  case 0x38: return 0x2C
  case 0x39: return 0x39
  case 0x3A: return 0x7A
  case 0x3B: return 0x78
  case 0x3C: return 0x63
  case 0x3D: return 0x76
  case 0x3E: return 0x60
  case 0x3F: return 0x61
  case 0x40: return 0x62
  case 0x41: return 0x64
  case 0x42: return 0x65
  case 0x43: return 0x6D
  case 0x44: return 0x67
  case 0x45: return 0x6F
  case 0x4A: return 0x73
  case 0x4B: return 0x74
  case 0x4C: return 0x75
  case 0x4D: return 0x77
  case 0x4E: return 0x79
  case 0x4F: return 0x7C
  case 0x50: return 0x7B
  case 0x51: return 0x7D
  case 0x52: return 0x7E
  default: return 0x10000
  }
}
#endif
