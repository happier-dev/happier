import * as React from 'react';
import { Platform, Pressable } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { SafeIonicons } from '@/components/ui/icons/SafeIonicons';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { t } from '@/text';
import type { VoiceDictationSnapshot } from '@/voice/dictation/VoiceDictationController';

/**
 * Dictation, at the top-right corner of the text field (§2.3).
 *
 * Dictation and conversational Voice stop competing by **placement**, not by
 * iconography: this acts on the field — it appends words to the input and nothing
 * else — while the planet in the trailing slot acts on the session. That is why it
 * lives in the field's corner and not beside Send.
 *
 * The composer owns the geometry: `AgentInput`'s `fieldAccessory` slot is already
 * the 24pt box that takes the expand toggle's place and drops beneath it when the
 * toggle appears, so this fills the slot rather than positioning itself.
 */
export function AgentInputDictationButton(props: Readonly<{
    status: VoiceDictationSnapshot['status'];
    onPress: () => void;
}>) {
    const { theme } = useUnistyles();
    const listening = props.status !== 'idle';
    const transcribing = props.status === 'transcribing';
    const minimumTargetSize = resolveMinimumInteractiveTargetSize(Platform.OS);
    const horizontalInset = (minimumTargetSize - 24) / 2;

    return (
        <Pressable
            accessibilityLabel={
                transcribing
                    ? t('voiceAssistant.transcribing')
                    : listening
                        ? t('voiceAssistant.endDictation')
                        : t('voiceAssistant.startDictation')
            }
            accessibilityRole="button"
            accessibilityState={{ busy: transcribing }}
            disabled={transcribing}
            hitSlop={{
                top: 4,
                right: horizontalInset,
                bottom: minimumTargetSize - 28,
                left: horizontalInset,
            }}
            testID="agent-input-dictation"
            onPress={props.onPress}
            style={({ pressed }) => [
                styles.button,
                pressed ? { backgroundColor: theme.colors.surface.pressed } : null,
            ]}
        >
            <SafeIonicons
                name={listening ? 'mic-off-outline' : 'mic-outline'}
                size={16}
                color={listening ? theme.colors.text.link : theme.colors.text.secondary}
            />
        </Pressable>
    );
}

const styles = StyleSheet.create({
    button: {
        width: 24,
        height: 24,
        borderRadius: 12,
        alignItems: 'center',
        justifyContent: 'center',
    },
});
