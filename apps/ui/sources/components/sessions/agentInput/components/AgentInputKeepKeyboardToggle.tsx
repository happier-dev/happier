import * as React from 'react';
import { Pressable } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { Icon } from '@/components/ui/icons/Icon';
import { hapticsLight } from '@/components/ui/theme/haptics';
import { useKeyboardHeight } from '@/hooks/ui/useKeyboardHeight';
import { useLocalSettingMutable } from '@/sync/store/hooks';
import { t } from '@/text';

/**
 * Touch only: keeps the soft keyboard up across sends, for writing several messages in a row. It governs
 * the send's own blur and nothing else, so tapping the transcript still closes the keyboard. It shows only
 * while the keyboard is open, the one time it can matter (owner R9, 2026-11-09).
 */
export const AgentInputKeepKeyboardToggle = React.memo(function AgentInputKeepKeyboardToggle() {
    const keyboardOpen = useKeyboardHeight() > 0;
    return keyboardOpen ? <KeepKeyboardPin /> : null;
});

function KeepKeyboardPin() {
    const { theme } = useUnistyles();
    const [setting, setSetting] = useLocalSettingMutable('composerKeepFocusAfterSend');
    const pinned = setting === true;
    return (
        <Pressable
            testID="agent-input-keep-keyboard"
            accessibilityRole="switch"
            accessibilityState={{ checked: pinned }}
            accessibilityLabel={t('agentInput.keepKeyboard.label')}
            hitSlop={8}
            onPress={() => {
                hapticsLight();
                setSetting(!pinned);
            }}
            style={{ alignItems: 'center', height: 24, justifyContent: 'center', marginRight: 6, width: 24 }}
        >
            <Icon
                name="push-pin"
                size={15}
                weight={pinned ? 'fill' : 'regular'}
                color={pinned ? theme.colors.accent.blue : theme.colors.text.secondary}
            />
        </Pressable>
    );
}
