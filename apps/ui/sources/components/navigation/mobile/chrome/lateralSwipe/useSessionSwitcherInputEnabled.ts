import * as React from 'react';
import { Keyboard, Platform } from 'react-native';

import { useOptionalModal } from '@/modal';
import { useDeviceType } from '@/utils/platform/responsive';

/** Both bar presenters yield Session gestures while text or a modal owns the phone. */
export function useSessionSwitcherInputEnabled(): boolean {
    const deviceType = useDeviceType();
    const modalOwnsInput = useOptionalModal()?.isKeyboardLiftSuppressedByModal === true;
    const [keyboardVisible, setKeyboardVisible] = React.useState(false);
    React.useEffect(() => {
        const shown = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow', () => setKeyboardVisible(true));
        const hidden = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide', () => setKeyboardVisible(false));
        return () => { shown.remove(); hidden.remove(); };
    }, []);
    return Platform.OS !== 'web' && deviceType === 'phone' && !keyboardVisible && !modalOwnsInput;
}
