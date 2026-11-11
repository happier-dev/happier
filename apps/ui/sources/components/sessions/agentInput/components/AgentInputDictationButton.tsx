import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { ChromeGlyph } from '@/components/ui/icons/chromeGlyphInk';
import { t } from '@/text';
import { AGENT_INPUT_FIELD_ACCESSORY_EDGES_PX, AGENT_INPUT_QUIET_ICON_SIZE_PX } from './agentInputChromeStyles';
import type { VoiceDictationSnapshot } from '@/voice/dictation/VoiceDictationController';

/** The drawn circle; a finger reaches it through the button's hit area, not a larger slot. */
const DICTATION_VISUAL_SIZE = AGENT_INPUT_QUIET_ICON_SIZE_PX;

/**
 * Dictation, at the top-right corner of the text field (§2.3, VE-02).
 *
 * Dictation and conversational Voice are told apart by **placement and drawing**: this is the
 * monochrome line microphone that acts on the field — it appends editable words and never sends —
 * while Voice is the coloured dot microphone before Send that acts on the session.
 *
 * The composer owns the geometry: `AgentInput`'s `fieldAccessory` slot is the 24pt circle. The shared
 * `IconButton` draws it at that size and reaches the platform target (44pt, 48 on Android) through
 * its hit area — never web-inert `hitSlop`, because the desktop app IS the web bundle.
 */
export function AgentInputDictationButton(props: Readonly<{
    testID?: string;
    disabled?: boolean;
    status: VoiceDictationSnapshot['status'];
    onPress: () => void;
    onFocus?: () => void;
}>) {
    const listening = props.status === 'listening';
    const starting = props.status === 'starting';
    const transcribing = props.status === 'transcribing';
    const label = transcribing
        ? t('voiceAssistant.transcribing')
        : starting
            ? t('common.loading')
        : listening
            ? t('voiceAssistant.endDictation')
            : t('voiceAssistant.startDictation');

    return (
        <View style={styles.target}>
            <IconButton
                testID={props.testID ?? 'agent-input-dictation'}
                // Chrome ink at rest (owner 11-10); full ink while listening, as the selected control.
                icon={<ChromeGlyph name={listening ? 'microphone-slash' : 'microphone'} size={16} active={listening} />}
                accessibilityLabel={label}
                tooltip={props.status === 'idle' ? t('voicePresence.dictate') : label}
                tooltipPlacement="bottom"
                variant="plain"
                tone={listening ? 'primary' : 'default'}
                selected={listening}
                busy={starting}
                size={DICTATION_VISUAL_SIZE}
                interactiveTargetEdgesPx={AGENT_INPUT_FIELD_ACCESSORY_EDGES_PX}
                disabled={props.disabled === true || transcribing}
                onPress={props.onPress}
                onFocusChange={(focused) => { if (focused) props.onFocus?.(); }}
            />
        </View>
    );
}

const styles = StyleSheet.create({
    target: {
        position: 'absolute',
        top: 0,
        left: 0,
        width: DICTATION_VISUAL_SIZE,
        height: DICTATION_VISUAL_SIZE + 4,
        alignItems: 'center',
        // Keeps the 24pt circle where the slot drew it: top-aligned, 4pt below the field's edge.
        justifyContent: 'flex-start',
        paddingTop: 4,
    },
});
