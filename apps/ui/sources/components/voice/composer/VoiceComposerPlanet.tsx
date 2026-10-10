import * as React from 'react';
import { Platform, View } from 'react-native';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { VoiceMarkArt, type VoiceMarkEvent, type VoiceMarkPose } from '@/components/voice/presence/VoiceMark';
import type { VoiceHeldInput } from '@/voice/runtime/controller/VoiceConversationController';
import { fireAndForget } from '@/utils/system/fireAndForget';

/**
 * The composer's Voice control is drawn at 32pt, the submit button's peer (§2.3); its press frame
 * is the platform's 44/48pt target. The mark inside is the 26pt tier, which keeps the microphone
 * legible beside Send while the planet's atmosphere has room to breathe inside the slot.
 */
export const VOICE_COMPOSER_PLANET_SLOT = 32;
const VOICE_COMPOSER_MARK_SIZE = 26;
const VOICE_COMPOSER_PLANET_TARGET = resolveMinimumInteractiveTargetSize(Platform.OS);
/** The trailing row's gap to Send; the press frame grows into half of it on each side. */
const VOICE_COMPOSER_ROW_GAP = 8;

/**
 * Voice, in the composer's trailing action slot — immediately before Send (VE-02).
 *
 * At rest it is the line waveform glyph in the composer's icon tint; tapping starts Voice and it
 * flows into the live dot planet; tapping again ends it and the dots regather into the glyph. Dictation is a different control (the monochrome line
 * mic inside the field), so the two never share a glyph.
 *
 * **A pure leaf.** Every fact it draws arrives as a primitive prop and every press leaves through
 * `onPress`, so it can live inside a composer that re-renders on each keystroke at no cost:
 * `React.memo` over primitives plus one caller-stable handler (§16.2). Callers must pass a **stable**
 * `onPress`.
 */
export const VoiceComposerPlanet = React.memo(function VoiceComposerPlanet(props: Readonly<{
    /** The attempt's mark pose: the microphone at rest, a planet pose while live. */
    pose: VoiceMarkPose;
    /** The microphone is muted for the running conversation. */
    muted: boolean;
    /** The attempt's one-shot mark event (a stable reference from the projection). */
    markEvent?: VoiceMarkEvent | null;
    /** Localized by the caller: the composer leaf owns no copy. */
    accessibilityLabel: string;
    accessibilityHint: string;
    /** Hover/focus help on pointer platforms, e.g. "Talk with Voice ⌥⌘V". */
    tooltip?: string;
    tooltipContent?: React.ReactNode;
    disabled?: boolean;
    isActivelyFocused?: boolean;
    onPress: () => void;
    /** Omitted until the device preference opts in; the owner may decline admission. */
    beginHoldToTalk?: () => VoiceHeldInput | null;
    onHoldUnavailable?: () => void;
}>) {
    const heldInput = React.useRef<VoiceHeldInput | null>(null);
    const secondaryGesture = React.useRef(false);
    const moved = React.useRef(false);
    const cancel = React.useCallback(() => {
        moved.current = true;
        const held = heldInput.current;
        heldInput.current = null;
        if (held) fireAndForget(held.cancel(), { tag: 'VoiceComposerPlanet.cancelHold' });
    }, []);
    const release = React.useCallback(() => {
        const held = heldInput.current;
        heldInput.current = null;
        if (held) fireAndForget(held.release(), { tag: 'VoiceComposerPlanet.releaseHold' });
    }, []);
    React.useEffect(() => cancel, [cancel, props.beginHoldToTalk]);
    React.useEffect(() => { if (props.isActivelyFocused === false) cancel(); }, [cancel, props.isActivelyFocused]);
    const button = (
        <IconButton
            testID="session-composer-voice"
            accessibilityLabel={props.accessibilityLabel}
            accessibilityHint={props.accessibilityHint}
            tooltip={props.tooltip}
            tooltipContent={props.tooltipContent}
            tooltipPlacement="top"
            variant="plain"
            size={VOICE_COMPOSER_PLANET_SLOT}
            minimumInteractiveTargetSize={VOICE_COMPOSER_PLANET_TARGET}
            interactiveTargetGapPx={VOICE_COMPOSER_ROW_GAP}
            disabled={props.disabled}
            onPress={() => { if (!secondaryGesture.current) props.onPress(); }}
            onPressIn={() => { secondaryGesture.current = false; moved.current = false; }}
            onPressOut={(event) => {
                const native = event?.nativeEvent;
                const type = event && 'type' in event && typeof event.type === 'string' ? event.type
                    : native && typeof native === 'object' && 'type' in native && typeof native.type === 'string' ? native.type : null;
                // Native Pressability owns the press rectangle. Its move/cancel
                // deactivation cancels; ordinary release is handled below.
                if (type && ['touchmove', 'mousemove', 'pointermove', 'touchcancel', 'pointercancel', 'responderterminate'].includes(type.toLowerCase())) cancel();
            }}
            onFocusChange={(focused) => { if (!focused) cancel(); }}
            onLongPress={props.beginHoldToTalk ? () => {
                secondaryGesture.current = true;
                if (moved.current || heldInput.current || props.isActivelyFocused === false) return;
                const held = props.beginHoldToTalk?.() ?? null;
                heldInput.current = held;
                if (!held) props.onHoldUnavailable?.();
            } : undefined}
            icon={<VoiceMarkArt pose={props.pose} event={props.markEvent} muted={props.muted} size={VOICE_COMPOSER_MARK_SIZE} />}
        />
    );
    // Successful release is distinct from press-out (which also fires for cancellation).
    // The host handle, not this gesture adapter, owns currentness and exactly one commit.
    return props.beginHoldToTalk ? (
        <View testID="session-composer-voice-gesture" onTouchEnd={release} onTouchCancel={cancel}
            onPointerUp={release} onPointerCancel={cancel} onPointerLeave={cancel}>
            {button}
        </View>
    ) : button;
});
