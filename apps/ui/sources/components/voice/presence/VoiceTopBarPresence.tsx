import * as React from 'react';
import { View } from 'react-native';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';
import { StyleSheet } from 'react-native-unistyles';

import { IconButton } from '@/components/ui/buttons/IconButton';
import {
    useVoiceAttemptControl,
    VOICE_ATTEMPT_IDLE_TARGET_DEFAULT,
    type VoiceAttemptControlProjection,
} from '@/components/voice/attempt/useVoiceAttemptControl';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useKeyboardShortcutLabel } from '@/keyboard/shortcutLabels';
import { t } from '@/text';
import { createFrontDoorUiActionExecutor } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { VoiceGlancePopover } from './VoiceGlancePopover';
import { VoiceMark, VoiceMarkArt } from './VoiceMark';
import { VoiceStatusLine } from './VoiceStatusLine';
import { VoiceTransport } from './VoiceTransport';
import { VoiceTargetIdentity } from './VoiceTargetIdentity';
import { useVoiceReadAloud, VoiceReadAloudGlyph, VoiceReadAloudStatus, VoiceReadAloudStop, type VoiceReadAloud } from './VoiceReadAloud';
import { resolveVoicePresenceReadAloud } from './resolveVoicePresenceReadAloud';
import { registerVoiceGlancePresentation, revealVoiceCompanionSection } from './voiceCompanionSectionReveal';
import { useVoicePresenceContainer } from './useVoicePresenceContainer';

import { VoiceTopBarAnatomy, VOICE_TOP_BAR_PILL_HEIGHT as PILL_HEIGHT } from './voicePresenceAnatomy';
const MARK_SIZE = 20;
const executePresentationAction = createFrontDoorUiActionExecutor();

/**
 * The resting mic's hit area inside the 40 px title strip: sideways it keeps the strip's own reach, 6 px
 * above it stops at the window edge, and 4 of the 6 px under it are its own — the right rail's first
 * action below takes the other 2 (half of its 4 px action gap).
 */
const REST_TARGET_EDGES_PX = { leading: 8, trailing: 8, top: 6, bottom: 4 } as const;

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
    /** Read-aloud outside a conversation grows the rest mic into its own pill: what Voice is doing, and Stop. */
    readAloud?: VoiceReadAloud;
    testID?: string;
}>): React.ReactElement | null {
    const { voice, readAloud } = props;
    const testID = props.testID ?? 'voice-top-bar';
    const shortcutLabel = useKeyboardShortcutLabel('voice.toggle');
    if (voice.availability === 'unavailable') return null;
    const reading = resolveVoicePresenceReadAloud(voice, readAloud);
    if (reading) {
        return (
            <VoiceTopBarAnatomy testID={`${testID}-read-aloud`}
                mark={<View style={stylesheet.readAloudMark}><VoiceReadAloudGlyph size="pill" /></View>}
                label={<VoiceReadAloudStatus phase={reading.phase} size="pill" />}
                showDivider
                transport={<VoiceReadAloudStop readAloud={reading} size="pill" testID={`${testID}-read-aloud-stop`} />}
            />
        );
    }
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
                interactiveTargetEdgesPx={REST_TARGET_EDGES_PX}
                onPress={voice.onPrimaryAction}
                icon={<VoiceMarkArt pose="mic" size={MARK_SIZE} />}
            />
        );
    }
    return <VoiceTopBarPill voice={voice} readAloud={readAloud} testID={testID} />;
});

const VoiceTopBarPill = React.memo(function VoiceTopBarPill(props: Readonly<{
    voice: VoiceAttemptControlProjection;
    readAloud?: VoiceReadAloud;
    testID: string;
}>) {
    const styles = stylesheet;
    const { voice } = props;
    const anchorRef = React.useRef<View | null>(null);
    const [open, setOpen] = React.useState(false);
    React.useLayoutEffect(() => registerVoiceGlancePresentation((expanded) => {
        if (!expanded || !revealVoiceCompanionSection()) setOpen(expanded);
    }), []);
    const close = React.useCallback(() => {
        fireAndForget(executePresentationAction('ui.voice_global.glance.close', {}), { tag: 'VoiceTopBar.glance.close' });
    }, []);
    // The label shows the Voice section: in the Companion when it is beside the work, otherwise
    // anchored under the pill. The mark never does this — it is always start/end.
    const toggleOpen = React.useCallback(() => {
        fireAndForget(executePresentationAction(open ? 'ui.voice_global.glance.close' : 'ui.voice_global.glance.open', {}),
            { tag: 'VoiceTopBar.glance' });
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
                // The label sits flush beside the mark, so the mark's hit area reaches only above and below it.
                interactiveTargetGapPx={0}
                icon={<VoiceMark voice={voice} size={MARK_SIZE} />}
            />}
            label={<HappierPressable
                testID={`${props.testID}-label`}
                accessibilityRole="button"
                accessibilityLabel={t('voicePresence.containerA11y', { status: voice.statusLabel })}
                accessibilityHint={t('voicePresence.showConversation')}
                expanded={open}
                onPress={toggleOpen}
                style={({ pressed }) => [styles.label, pressed ? styles.labelPressed : null]}
            >
                <View style={styles.labelRow}>
                    <VoiceStatusLine voice={voice} size="pill" />
                    {/* The admitted target stays named through its clean ended moment; global has none. */}
                    {voice.targetSessionAddress ? (
                        <VoiceTargetIdentity address={voice.targetSessionAddress} size="pill" testID={`${props.testID}-target`} />
                    ) : null}
                </View>
            </HappierPressable>}
            showDivider={(voice.canStop && !voice.recoveryAvailable) || (!voice.live && Boolean(voice.ended))}
            transport={<VoiceTransport voice={voice} readAloud={props.readAloud} size="pill" testID={`${props.testID}-transport`} />}
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
    // The glyph stands in the mark's square, so the word starts where the live pill's label does.
    readAloudMark: { width: PILL_HEIGHT, height: PILL_HEIGHT, alignItems: 'center', justifyContent: 'center' },
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
    const readAloud = useVoiceReadAloud();
    return <VoiceTopBarPresence voice={voice} readAloud={readAloud} />;
}
