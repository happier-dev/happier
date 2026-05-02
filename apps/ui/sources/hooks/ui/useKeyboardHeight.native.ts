import { Platform } from 'react-native';
import { useKeyboardState } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export function useKeyboardHeight(): number {
    const safeArea = useSafeAreaInsets();
    const keyboard = useKeyboardState();

    if (!keyboard.isVisible) return 0;

    // On iOS, `react-native-keyboard-controller`'s `height` includes the bottom safe area inset.
    // On Android (edge-to-edge mode), it does not — subtracting it would under-report the height.
    const deduction = Platform.OS === 'ios' ? safeArea.bottom : 0;
    return Math.max(0, keyboard.height - deduction);
}

