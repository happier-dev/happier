import * as React from 'react';
import { Platform, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { t } from '@/text';
import type { VoiceDictationSnapshot } from '@/voice/dictation/VoiceDictationController';

/** The drawn circle; the press frame around it is the slot's platform target. */
const DICTATION_VISUAL_SIZE = 24;

/**
 * Dictation, at the top-right corner of the text field (§2.3, VE-02).
 *
 * Dictation and conversational Voice are told apart by **placement and drawing**: this is the
 * monochrome line microphone that acts on the field — it appends editable words and never sends —
 * while Voice is the coloured dot microphone before Send that acts on the session.
 *
 * The composer owns the geometry: `AgentInput`'s `fieldAccessory` slot is the platform target box
 * (44pt, 48 on Android). The shared `IconButton` draws the 24pt circle at the top of that box and
 * grows a real press frame to the platform target around it — never web-inert `hitSlop`, because
 * the desktop app IS the web bundle.
 */
export function AgentInputDictationButton(props: Readonly<{
    testID?: string;
    disabled?: boolean;
    status: VoiceDictationSnapshot['status'];
    onPress: () => void;
}>) {
    const listening = props.status !== 'idle';
    const transcribing = props.status === 'transcribing';
    const minimumTargetSize = resolveMinimumInteractiveTargetSize(Platform.OS);
    const label = transcribing
        ? t('voiceAssistant.transcribing')
        : listening
            ? t('voiceAssistant.endDictation')
            : t('voiceAssistant.startDictation');

    return (
        <View style={[styles.target, { width: minimumTargetSize, height: minimumTargetSize }]}>
            <IconButton
                testID={props.testID ?? 'agent-input-dictation'}
                iconName={listening ? 'microphone-slash' : 'microphone'}
                accessibilityLabel={label}
                tooltip={listening ? label : t('voicePresence.dictate')}
                tooltipPlacement="bottom"
                variant="plain"
                tone={listening ? 'primary' : 'default'}
                selected={listening}
                size={DICTATION_VISUAL_SIZE}
                iconSize={16}
                minimumInteractiveTargetSize={minimumTargetSize}
                interactiveTargetGapPx={minimumTargetSize}
                disabled={props.disabled === true || transcribing}
                onPress={props.onPress}
            />
        </View>
    );
}

const styles = StyleSheet.create({
    target: {
        position: 'absolute',
        top: 0,
        left: 0,
        alignItems: 'center',
        // Keeps the 24pt circle where the slot drew it: top-aligned, 4pt below the field's edge.
        justifyContent: 'flex-start',
        paddingTop: 4,
    },
});
