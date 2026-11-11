import * as React from 'react';
import { Pressable } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { AGENT_INPUT_QUIET_ICON_SIZE_PX } from '@/components/sessions/agentInput/components/agentInputChromeStyles';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { Icon } from '@/components/ui/icons/Icon';
import { dismissKeyboard } from '@/components/ui/keyboardAvoidance/dismissKeyboard';
import { hapticsLight } from '@/components/ui/theme/haptics';
import { useStatusRowIconHitEdges } from '@/components/sessions/agentInput/instrumentStrip/useStatusRowIconHitEdges';
import { useKeyboardHeight } from '@/hooks/ui/useKeyboardHeight';
import { useLocalSettingMutable } from '@/sync/store/hooks';
import { t } from '@/text';

/**
 * The soft keyboard's two controls in the row above every composer (0.2's accessory, owner 2026-11-11): lower the
 * keyboard without leaving the field, and pin it open across sends for writing several messages, or several new
 * sessions, in a row. They show only while the keyboard is open, the one time they can matter (owner R9).
 */
export const AgentInputKeyboardAccessory = React.memo(function AgentInputKeyboardAccessory() {
    const keyboardOpen = useKeyboardHeight() > 0;
    const edges = useStatusRowIconHitEdges();
    if (!keyboardOpen) return null;
    // Unwrapped, so each icon takes the status row's one gap.
    return (
        <>
            <IconButton testID="agent-input-dismiss-keyboard" variant="plain" iconName="caret-down" tooltipPlacement="top"
                size={AGENT_INPUT_QUIET_ICON_SIZE_PX} interactiveTargetEdgesPx={edges} accessibilityLabel={t('common.dismissKeyboard')}
                tooltip={t('common.dismissKeyboard')} onPress={dismissKeyboard} />
            <KeepKeyboardPin edges={edges} />
        </>
    );
});

/** The pin governs the Send's own blur and nothing else, so tapping the transcript still closes the keyboard. */
function KeepKeyboardPin(props: Readonly<{ edges: ReturnType<typeof useStatusRowIconHitEdges> }>) {
    const { theme } = useUnistyles();
    const [setting, setSetting] = useLocalSettingMutable('composerKeepFocusAfterSend');
    const pinned = setting === true;
    return (
        <Pressable
            testID="agent-input-keep-keyboard"
            accessibilityRole="switch"
            accessibilityState={{ checked: pinned }}
            accessibilityLabel={t('agentInput.keepKeyboard.label')}
            hitSlop={{ left: props.edges.leading, right: props.edges.trailing, top: 8, bottom: props.edges.bottom }}
            onPress={() => {
                hapticsLight();
                setSetting(!pinned);
            }}
            style={{ alignItems: 'center', height: AGENT_INPUT_QUIET_ICON_SIZE_PX, justifyContent: 'center', width: AGENT_INPUT_QUIET_ICON_SIZE_PX }}
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
