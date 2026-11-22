import * as React from 'react';
import { Platform, Pressable } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { ICON_SIZE, Icon } from '@/components/ui/icons/Icon';
import { Modal } from '@/modal';
import { storage } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { toggleReadAloud } from '@/voice/local/readAloud';
import { useIsReadingAloud } from '@/voice/local/readAloudState';
import { useReadAloudAvailable } from '@/voice/local/useReadAloudAvailable';
import { primeWebAudioPlayback } from '@/voice/output/webAudioContext';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { RowActionDeferredIcon } from './RowActionRevealSlot';

/**
 * Reads one message aloud with the TTS provider chosen in voice settings. It only appears when a
 * local voice provider is selected and its TTS is filled in; a live voice session is not required.
 */
export function MessageSpeakButton(props: Readonly<{
    messageKey: string;
    text: string;
    testID?: string;
    invertedActionsLayout?: boolean;
    onHoverIn?: () => void;
    onHoverOut?: () => void;
}>): React.ReactElement | null {
    const { theme } = useUnistyles();
    const { messageKey, text } = props;
    const playing = useIsReadingAloud(messageKey);
    const available = useReadAloudAvailable();

    const handlePress = React.useCallback(() => {
        // Browsers only allow audio that is unlocked from the press itself, before any async work.
        primeWebAudioPlayback();
        fireAndForget((async () => {
            // Read the current speech settings at press time rather than subscribing to them.
            const ok = await toggleReadAloud({ key: messageKey, text, settings: storage.getState().settings });
            if (!ok) Modal.alert(t('common.error'), t('message.readAloudFailed'));
        })(), { tag: 'MessageSpeakButton.toggleReadAloud' });
    }, [messageKey, text]);

    if (text.trim().length === 0 || !available) return null;

    return (
        <Pressable
            testID={props.testID}
            onPress={handlePress}
            onHoverIn={props.onHoverIn}
            onHoverOut={props.onHoverOut}
            hitSlop={Platform.OS === 'web' ? undefined : 15}
            accessibilityRole="button"
            accessibilityLabel={playing ? t('message.stopReadAloudA11y') : t('message.readAloudA11y')}
            style={({ pressed }) => [
                styles.button,
                Platform.OS === 'web' ? styles.webActionButton : null,
                props.invertedActionsLayout ? styles.webActionButtonInverted : null,
                props.invertedActionsLayout ? styles.invertedSpacing : null,
                playing || pressed ? styles.buttonActive : null,
            ]}
        >
            <RowActionDeferredIcon size={ICON_SIZE.xs}>
                <Icon
                    name={playing ? 'stop' : 'speaker-high'}
                    size={ICON_SIZE.xs}
                    color={playing ? theme.colors.state.active.foreground : theme.colors.text.secondary}
                />
            </RowActionDeferredIcon>
        </Pressable>
    );
}

const styles = StyleSheet.create(() => ({
    button: {
        padding: 2,
        borderRadius: 6,
        opacity: 0.6,
        cursor: 'pointer',
        marginRight: 6,
    },
    webActionButton: {
        padding: 6,
    },
    webActionButtonInverted: {
        paddingHorizontal: 4,
    },
    invertedSpacing: {
        marginRight: 2,
    },
    buttonActive: {
        opacity: 1,
    },
}));
