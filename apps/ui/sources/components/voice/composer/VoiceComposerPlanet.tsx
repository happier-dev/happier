import * as React from 'react';
import { Platform, View } from 'react-native';

import { TactilePressable } from '@/components/voice/controls/VoiceControls';
import { PlanetOrb, VoiceWaveform } from '@/components/voice/light/VoiceLight';
import { useVoiceEnergyPresence } from '@/components/voice/light/useVoiceEnergy';
import { light, onPlanetInk, useVoiceLightTokens, type VoiceLightStop } from '@/components/voice/light/voiceLightTokens';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';

/**
 * The composer's planet visual is 32pt, and it is the submit's **peer**, not a
 * trailing afterthought. Its outer Pressable still owns the platform's 44/48pt
 * target; shrinking the visual itself would make it read as a weaker sibling
 * (§2.3).
 */
export const VOICE_COMPOSER_PLANET_SLOT = 32;
const VOICE_COMPOSER_PLANET_TARGET = resolveMinimumInteractiveTargetSize(Platform.OS);

/** Geometry of the meter laid over the body, in fractions of the slot. */
const METER_INSET = 0.24;
const METER_TOP = 0.38;
const METER_HEIGHT = 0.24;
const METER_SLOTS = 5;
const METER_BAR_WIDTH = 1.5;

/**
 * Voice, in the composer's trailing action slot — immediately before Send.
 *
 * **A pure leaf.** It reads the energy context and nothing else: no view model,
 * no store subscription, no lifecycle. Every fact it draws arrives as a
 * primitive prop, decided by whichever surface owns the attempt, and every press
 * leaves through `onPress`. That is what lets it live inside a 3k-line composer
 * that re-renders on each keystroke without costing anything — `React.memo` over
 * primitives plus one caller-stable handler (§16.2).
 *
 * Callers must pass a **stable** `onPress` (`useEventCallback`/`useCallback`);
 * an inline arrow defeats the memo and re-renders the planet per keystroke.
 *
 * Two geometry rules, both of which were shipped wrong once and corrected:
 *
 *  - **Its visual fills the 32pt slot.** Its outer target remains 44/48pt.
 *  - **Nothing here clips.** A 12% inhale overshoots ~2pt per edge, which the
 *    row's 8pt gap absorbs. Clipping is what made the planet look static — so
 *    neither the tap target nor the body wrapper sets `overflow: 'hidden'`, and
 *    the muted mark deliberately hangs 1pt outside the disc.
 *
 * **Motion is not decided here.** Per §2.4a the planet breathes only while the
 * microphone is genuinely capturing, and that gate lives in the energy clock —
 * an idle planet is drawn exactly the same way and simply does not move.
 * Registering presence is how this surface tells the clock it is on screen; the
 * clock still refuses to run without a live attempt, and the breath still
 * refuses to start without an open microphone.
 */
export const VoiceComposerPlanet = React.memo(function VoiceComposerPlanet(props: Readonly<{
    /** A Voice conversation is running — the meter has something to show. */
    live: boolean;
    /** The microphone is muted for the running conversation. */
    muted: boolean;
    /** The light this state is drawn in. */
    stop: VoiceLightStop;
    /** Localized by the caller: the composer leaf owns no copy. */
    accessibilityLabel: string;
    accessibilityHint: string;
    disabled?: boolean;
    onPress: () => void;
}>) {
    const tokens = useVoiceLightTokens();
    const presence = useVoiceEnergyPresence();

    React.useEffect(() => {
        presence.acquire();
        return () => presence.release();
    }, [presence]);

    const slot = VOICE_COMPOSER_PLANET_SLOT;

    return (
        <TactilePressable
            testID="session-composer-voice"
            accessibilityLabel={props.accessibilityLabel}
            accessibilityHint={props.accessibilityHint}
            disabled={props.disabled}
            onPress={props.onPress}
            // Layout on `style` never reaches the Pressable (§3.2), so the real
            // target belongs on this outer frame. The visual stays 32pt, while
            // the trailing cluster reserves the required 44/48pt hit area rather
            // than relying on web-inert hitSlop or overlapping Send.
            containerStyle={{
                width: VOICE_COMPOSER_PLANET_TARGET,
                height: VOICE_COMPOSER_PLANET_TARGET,
                alignItems: 'center',
                justifyContent: 'center',
            }}
            style={{
                width: slot,
                height: slot,
                alignItems: 'center',
                justifyContent: 'center',
            }}
        >
            <PlanetOrb size={slot} tint={props.stop} tintAmount={0.07} atmosphere={false} />
            {props.live ? (
                <View
                    testID="voice-composer-planet-meter"
                    pointerEvents="none"
                    style={{
                        position: 'absolute',
                        left: slot * METER_INSET,
                        right: slot * METER_INSET,
                        top: slot * METER_TOP,
                        height: slot * METER_HEIGHT,
                    }}
                >
                    <VoiceWaveform
                        stop={props.stop}
                        slots={METER_SLOTS}
                        height={slot * METER_HEIGHT}
                        barWidth={METER_BAR_WIDTH}
                        color={onPlanetInk(tokens)}
                    />
                </View>
            ) : null}
            {props.live && props.muted ? (
                <View
                    testID="voice-composer-planet-muted"
                    pointerEvents="none"
                    style={{
                        position: 'absolute',
                        right: -1,
                        bottom: -1,
                        width: 9,
                        height: 9,
                        borderRadius: 9,
                        backgroundColor: light('warm', 1, tokens),
                    }}
                />
            ) : null}
        </TactilePressable>
    );
});
