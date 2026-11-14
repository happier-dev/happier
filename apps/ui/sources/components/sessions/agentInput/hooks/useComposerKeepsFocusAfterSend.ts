import { useHasHardwareKeyboard } from '@/hooks/ui/useHasHardwareKeyboard';
import { useLocalSetting } from '@/sync/domains/state/storage';

/** The Send action and its settings row share the same effective preference. */
export function useComposerKeepsFocusAfterSend(): boolean {
    const setting = useLocalSetting('composerKeepFocusAfterSend');
    const hasHardwareKeyboard = useHasHardwareKeyboard();
    return setting ?? hasHardwareKeyboard;
}
