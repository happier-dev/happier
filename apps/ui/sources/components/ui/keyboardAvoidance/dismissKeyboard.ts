import { Keyboard, Platform } from 'react-native';
import { KeyboardController } from 'react-native-keyboard-controller';

/**
 * Closes the on-screen keyboard, whichever field holds it.
 *
 * React Native's `Keyboard.dismiss()` only blurs a field registered as a React Native `TextInput`. The composer's
 * native editor (`HappierComposerInput`, behind `MultiTextInput`) is not one, so that call left its keyboard up
 * (PHONE-POPOVERS-1109). On a device the keyboard controller resigns the platform's focused input instead (the
 * first responder on iOS, the focused `EditText` on Android), which covers the composer and every `TextInput`.
 */
export function dismissKeyboard(): void {
  if (Platform.OS === 'web') {
    Keyboard.dismiss();
    return;
  }
  void KeyboardController.dismiss();
}
