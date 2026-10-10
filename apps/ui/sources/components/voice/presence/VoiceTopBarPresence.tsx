import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { resolveTouchTargetFloorPx } from '@/components/ui/interactiveTargetSize';
import {
    useVoiceAttemptControl,
    VOICE_ATTEMPT_IDLE_TARGET_DEFAULT,
    type VoiceAttemptControlProjection,
} from '@/components/voice/attempt/useVoiceAttemptControl';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useKeyboardShortcutLabel } from '@/keyboard/shortcutLabels';
import { t } from '@/text';

import { VoiceGlancePopover } from './VoiceGlancePopover';
import { VoiceMark, VoiceMarkArt } from './VoiceMark';
import { VoiceStatusLine } from './VoiceStatusLine';
import { VoiceTransport } from './VoiceTransport';
import { VoiceTargetIdentity } from './VoiceTargetIdentity';
import { registerVoiceGlancePresentation, revealVoiceCompanionSection } from './voiceCompanionSectionReveal';
import { useVoicePresenceContainer } from './useVoicePresenceContainer';

import { VoiceTopBarAnatomy, VOICE_TOP_BAR_PILL_HEIGHT as PILL_HEIGHT } from './voicePresenceAnatomy';
const MARK_SIZE = 20;

/**
 * Voice in the desktop top bar (§4.3, lab R/A/C).
 *
 * At rest it is a quiet dot microphone at the trailing end of the title strip: one tap (or the
 * Voice shortcut) starts the preferred idle scope there. Starting grows the same anchor into the live pill —
 * mark · status · cell · time · Mute · End. The pill's **mark** is always start/end, never a
 * popover trigger; its **label** opens the Voice section anchored under it.
 *
 * The node is reserved by the title strip's trailing slot, and every control in it is outside the
 * window drag region.
 */
export const VoiceTopBarPresence = React.memo(function VoiceTopBarPresence(props: Readonly<{
    voice: VoiceAttemptControlProjection;
    testID?: string;
}>): React.ReactElement | null {
    const { voice } = props;
    const testID = props.testID ?? 'voice-top-bar';
    const shortcutLabel = useKeyboardShortcutLabel('voice.toggle');
    if (voice.availability === 'unavailable') return null;
    if (!voice.live && !voice.ended) {
        return (
            <IconButton
                testID={`${testID}-rest`}
                accessibilityLabel={voice.primaryActionLabel ?? t('voicePresence.talkWithVoice')}
                accessibilityHint={voice.primaryActionHint ?? undefined}
                // Starts Voice, or — before Voice is set up — opens its setup; the tooltip says which.
                tooltip={voice.primaryAction === 'start'
                    ? [t('voicePresence.talkWithVoice'), shortcutLabel].filter(Boolean).join(' ')
                    : voice.primaryActionLabel ?? t('voicePresence.talkWithVoice')}
                tooltipPlacement="bottom"
                variant="plain"
                size={PILL_HEIGHT}
                minimumInteractiveTargetSize={resolveTouchTargetFloorPx() ?? undefined}
                onPress={voice.onPrimaryAction}
                icon={<VoiceMarkArt pose="mic" size={MARK_SIZE} />}
            />
        );
    }
    return <VoiceTopBarPill voice={voice} testID={testID} />;
});

const VoiceTopBarPill = React.memo(function VoiceTopBarPill(props: Readonly<{
    voice: VoiceAttemptControlProjection;
    testID: string;
}>) {
    const styles = stylesheet;
    const { voice } = props;
    const anchorRef = React.useRef<View | null>(null);
    const [open, setOpen] = React.useState(false);
    React.useLayoutEffect(() => registerVoiceGlancePresentation(setOpen), []);
    const close = React.useCallback(() => setOpen(false), []);
    // The label shows the Voice section: in the Companion when it is beside the work, otherwise
    // anchored under the pill. The mark never does this — it is always start/end.
    const toggleOpen = React.useCallback(() => {
        if (open) {
            setOpen(false);
            return;
        }
        if (!revealVoiceCompanionSection()) setOpen(true);
    }, [open]);
    return (
        <VoiceTopBarAnatomy anchorRef={anchorRef} testID={props.testID}
            mark={<IconButton
                testID={`${props.testID}-mark`}
                accessibilityLabel={voice.primaryActionLabel ?? t('voiceAssistant.endVoice')}
                accessibilityHint={voice.primaryActionHint ?? undefined}
                onPress={voice.onPrimaryAction}
                variant="plain"
                size={PILL_HEIGHT}
                minimumInteractiveTargetSize={resolveTouchTargetFloorPx() ?? undefined}
                icon={<VoiceMark voice={voice} size={MARK_SIZE} />}
            />}
            label={<Pressable
                testID={`${props.testID}-label`}
                accessibilityRole="button"
                accessibilityLabel={t('voicePresence.containerA11y', { status: voice.statusLabel })}
                accessibilityHint={t('voicePresence.showConversation')}
                aria-expanded={open}
                onPress={toggleOpen}
                style={({ pressed }) => [styles.label, { minHeight: resolveTouchTargetFloorPx() ?? PILL_HEIGHT }, pressed ? styles.labelPressed : null]}
            >
                <View style={styles.labelRow}>
                    <VoiceStatusLine voice={voice} size="pill" />
                    {/* Talking to a Session: its avatar and name ride the status line (lab `b-voice A`); global has none. */}
                    {voice.live && voice.targetSessionAddress ? (
                        <VoiceTargetIdentity address={voice.targetSessionAddress} size="pill" testID={`${props.testID}-target`} />
                    ) : null}
                </View>
            </Pressable>}
            showDivider={(voice.canStop && !voice.recoveryAvailable) || (!voice.live && Boolean(voice.ended))}
            transport={<VoiceTransport voice={voice} size="pill" testID={`${props.testID}-transport`} />}
            overlay={<VoiceGlancePopover open={open} anchorRef={anchorRef} placement="bottom" onRequestClose={close} />}
        />
    );
});

const stylesheet = StyleSheet.create({
    label: {
        height: PILL_HEIGHT,
        borderRadius: PILL_HEIGHT / 2,
        justifyContent: 'center',
        minWidth: 0,
        flexShrink: 1,
    },
    labelPressed: { opacity: 0.7 },
    labelRow: { flexDirection: 'row', alignItems: 'center', gap: 8, minWidth: 0 },
});

/**
 * The title strip's trailing Voice node in Top bar mode: the preferred scope when idle, the running
 * attempt mirrored otherwise. Renders nothing when this device chose the Island or the Orb, or when
 * Voice is off.
 */
export function VoiceTopBarPresenceMount(): React.ReactElement | null {
    const voiceEnabled = useFeatureEnabled('voice');
    const container = useVoicePresenceContainer();
    if (voiceEnabled !== true || container !== 'top_bar') return null;
    return <VoiceTopBarPresenceRuntime />;
}

function VoiceTopBarPresenceRuntime(): React.ReactElement | null {
    const voice = useVoiceAttemptControl(VOICE_ATTEMPT_IDLE_TARGET_DEFAULT);
    return <VoiceTopBarPresence voice={voice} />;
}
