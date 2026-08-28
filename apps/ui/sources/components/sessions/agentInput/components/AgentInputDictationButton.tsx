import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
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
 * the platform target box (44pt, 48 on Android) that takes the expand toggle's
 * place and drops beneath it when the toggle appears.
 *
 * The pressable *is* that box, and the 24pt circle is drawn inside it. The
 * pointer target used to be the 24pt circle with the rest carried by `hitSlop`,
 * and react-native-web 0.21 implements `hitSlop` only in its legacy `Touchable`
 * export — the desktop app IS the web bundle, so the real clickable region was
 * 24×24 (measured live at that size). A press box cannot be an arithmetic
 * promise; it has to be a frame.
 */
export function AgentInputDictationButton(props: Readonly<{
    disabled?: boolean;
    status: VoiceDictationSnapshot['status'];
    onPress: () => void;
}>) {
    const { theme } = useUnistyles();
    const listening = props.status !== 'idle';
    const transcribing = props.status === 'transcribing';
    const minimumTargetSize = resolveMinimumInteractiveTargetSize(Platform.OS);

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
            accessibilityState={{ busy: transcribing, disabled: props.disabled === true }}
            disabled={props.disabled === true || transcribing}
            testID="agent-input-dictation"
            onPress={props.onPress}
            // Fills the slot regardless of the padding the slot uses to place the
            // visual, so the target is the whole platform box on every platform.
            style={[styles.target, { width: minimumTargetSize, height: minimumTargetSize }]}
        >
            {({ pressed }) => (
                <View
                    style={[
                        styles.visual,
                        pressed ? { backgroundColor: theme.colors.surface.pressed } : null,
                    ]}
                >
                    <SafeIonicons
                        name={listening ? 'mic-off-outline' : 'mic-outline'}
                        size={16}
                        color={listening ? theme.colors.text.link : theme.colors.text.secondary}
                    />
                </View>
            )}
        </Pressable>
    );
}

const styles = StyleSheet.create({
    target: {
        position: 'absolute',
        top: 0,
        left: 0,
        alignItems: 'center',
        // Keeps the 24pt circle where the slot drew it before the target grew
        // around it: top-aligned, 4pt below the field's edge.
        justifyContent: 'flex-start',
        paddingTop: 4,
    },
    visual: {
        width: 24,
        height: 24,
        borderRadius: 12,
        alignItems: 'center',
        justifyContent: 'center',
    },
});
