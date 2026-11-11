import { useHardwareKeyboard } from '@/components/ui/selectionList/useHardwareKeyboard';
import { useLocalSetting } from '@/sync/store/hooks';

/**
 * Whether a composer keeps its focus, and the soft keyboard, after Send: the person's device-local pin, or, while
 * they have not chosen, the device itself (keep it with a hardware keyboard, close the soft one). The one reading
 * for the composer's own Send, a new session's next draft and the setting row.
 */
export function useComposerKeepsFocusAfterSend(): boolean {
    const setting = useLocalSetting('composerKeepFocusAfterSend');
    const hardwareKeyboard = useHardwareKeyboard();
    return setting ?? hardwareKeyboard;
}
