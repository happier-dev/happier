import * as React from 'react';
import { View } from 'react-native';
import { cancelAnimation, Easing, useSharedValue, withTiming, type SharedValue } from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { interpolatePlanetMarkGeometry, type PlanetDotPose, type PlanetMarkGeometry } from '@happier-dev/brand/planet';

import { Icon } from '@/components/ui/icons/Icon';
import { shadowLevelStyle } from '@/shadowElevation';
import type { VoiceAttemptControlProjection } from '@/components/voice/attempt/useVoiceAttemptControl';
import { useVoiceEnergyIfMounted, useVoiceEnergyPresenceIfMounted } from '@/components/voice/light/useVoiceEnergy';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { useHostActivelyViewed } from '@/utils/runtime/useHostActivelyViewed';

import { VoiceMarkCanvas } from './VoiceMarkCanvas';
import { resolveVoiceMarkGeometry } from './voiceMarkGeometry';
import { resolveVoiceMarkPose, type VoiceMarkPose } from './resolveVoiceMarkPose';

export type { VoiceMarkPose } from './resolveVoiceMarkPose';

/** The mic ↔ planet morph (VE-02): one shot, about 0.55 s, reversible from wherever it is. */
const VOICE_MARK_MORPH_MS = 550;
/** A pose change that is a real event (connected, back after reconnecting): Daybreak's dawn. */
const VOICE_MARK_POSE_MS = 900;

const MORPH_TIMING = { duration: VOICE_MARK_MORPH_MS, easing: Easing.linear } as const;
const POSE_TIMING = { duration: VOICE_MARK_POSE_MS, easing: Easing.out(Easing.cubic) } as const;

/**
 * The Voice mark, wired to the attempt projection (§4.1): `<VoiceMark voice={voice} size={24} />`.
 *
 * Purely visual — it owns no press. Every container wraps it in its own control whose press is the
 * projection's start/end, so "the mark ends the call" is the container's contract, not the art's.
 */
export const VoiceMark = React.memo(function VoiceMark(props: Readonly<{
    voice: VoiceAttemptControlProjection;
    size: number;
    testID?: string;
}>): React.ReactElement {
    return (
        <VoiceMarkArt
            pose={resolveVoiceMarkPose(props.voice)}
            muted={props.voice.live && props.voice.muted}
            size={props.size}
            testID={props.testID}
        />
    );
});

/**
 * The mark at an explicit pose: the rest microphone, or the Daybreak dot planet at a pose.
 *
 * - **Morph.** Entering or leaving `mic` moves every microphone dot to its planet slot in one
 *   ~0.55 s shot; a reversal starts from the visible progress, never from either end.
 * - **Pose.** A change between planet poses (shadow → light when the call connects) is one event
 *   transform, then still.
 * - **Atmosphere.** Follows the energy owner's real level; silence draws no atmosphere and asks for
 *   no frames. Reduced motion holds the semantic pose with no morph and no atmosphere.
 * - Muted adds the slashed-mic pip, so mute is never carried by colour alone.
 */
export const VoiceMarkArt = React.memo(function VoiceMarkArt(props: Readonly<{
    pose: VoiceMarkPose;
    size: number;
    muted?: boolean;
    /**
     * Frozen values for a static specimen (design boards, settings tiles). Preview only: a live
     * container never passes it, and its absence never falls back to synthetic motion.
     */
    preview?: Readonly<{ morph?: number; energy?: number; flow?: number }>;
    /**
     * A static light vector from the Brand model (`planetLightForProgress`): Light = readiness on
     * setup art. Only facts the caller observed move it; it never animates by itself.
     */
    light?: readonly [number, number, number];
    /**
     * The planet stands without atmosphere and asks the energy owner for nothing (setup art before
     * anything is heard). Unlike `preview`, pose and light changes still move as one event.
     */
    still?: boolean;
    /** Presentational specimens may choose a Brand theme without changing host appearance. */
    theme?: 'light' | 'dark';
    /** Explicit author art has no live energy source, even when pose changes animate. */
    presentationOnly?: boolean;
    testID?: string;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const reduced = useReducedMotionPreference() || props.preview !== undefined
        || (props.presentationOnly === true && props.still !== false);
    const presented = useLayoutPresentationActive();
    const viewed = useHostActivelyViewed();
    const animationActive = presented && viewed;
    const live = props.pose !== 'mic';
    const planetTheme = props.theme ?? (theme.dark ? 'dark' : 'light');

    // The planet the mark gathers into (its pose and any readiness light), kept across a return to the
    // microphone so the regather starts from the planet that was actually on screen. A change of
    // either is one event transform (the terminator moving once when a setup step finishes), then still.
    const [poses, setPoses] = React.useState<Readonly<{
        from: PlanetLook;
        to: PlanetLook;
        displayed?: Readonly<{ geometry: PlanetMarkGeometry; key: string }>;
    }>>(() => {
        const initial = { pose: props.pose === 'mic' ? 'ready' : props.pose, light: props.light };
        return { from: initial, to: initial };
    });
    const nextLook: PlanetLook = props.pose === 'mic'
        ? poses.to
        : { pose: props.pose, light: props.light };
    const nextKey = planetLookKey(nextLook);
    const nextLookRef = React.useRef(nextLook);
    nextLookRef.current = nextLook;

    const previewMorph = props.preview?.morph;
    const morph = useSharedValue(previewMorph ?? (live ? 1 : 0));
    const poseProgress = useSharedValue(1);
    const geometryKey = `${props.size}:${planetTheme}`;
    const to = resolveVoiceMarkGeometry({ size: props.size, theme: planetTheme, ...poses.to });
    const from = poses.displayed?.key === geometryKey
        ? poses.displayed.geometry
        : resolveVoiceMarkGeometry({ size: props.size, theme: planetTheme, ...poses.from });
    React.useEffect(() => {
        const target = previewMorph ?? (live ? 1 : 0);
        if (reduced || !animationActive) {
            cancelAnimation(morph);
            morph.value = target;
        } else if (morph.value !== target) {
            morph.value = withTiming(target, MORPH_TIMING);
        }
    }, [animationActive, live, morph, previewMorph, reduced]);
    React.useLayoutEffect(() => {
        if (nextKey === planetLookKey(poses.to)) return;
        cancelAnimation(poseProgress);
        setPoses({
            from: poses.to,
            to: nextLookRef.current,
            displayed: { geometry: interpolatePlanetMarkGeometry(to, from, poseProgress.value), key: geometryKey },
        });
    }, [from, geometryKey, nextKey, poseProgress, poses.to, to]);

    // Restart only after React commits the captured geometry to both painters. Resetting in the
    // admission effect would briefly repaint the previous geometry at progress zero.
    const committedStart = React.useRef(poses.displayed);
    React.useLayoutEffect(() => {
        if (!poses.displayed) return;
        if (reduced || !animationActive) {
            committedStart.current = poses.displayed;
            cancelAnimation(poseProgress);
            poseProgress.value = 1;
            return;
        }
        if (committedStart.current === poses.displayed) return;
        committedStart.current = poses.displayed;
        poseProgress.value = 0;
        poseProgress.value = withTiming(1, POSE_TIMING);
    }, [animationActive, poseProgress, poses.displayed, reduced]);

    return (
        <View
            testID={props.testID}
            pointerEvents="none"
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={{ width: props.size, height: props.size }}
        >
            <VoiceMarkEnergy live={live && !reduced && !props.still && !props.presentationOnly} preview={props.preview}>
                {(energy, flow) => (
                    <VoiceMarkCanvas to={to} from={from} morph={morph} pose={poseProgress} energy={energy} flow={flow} />
                )}
            </VoiceMarkEnergy>
            {props.muted ? <VoiceMarkMutePip size={props.size} /> : null}
        </View>
    );
});

type PlanetLook = Readonly<{ pose: PlanetDotPose; light?: readonly [number, number, number] }>;

function planetLookKey(look: PlanetLook): string {
    return `${look.pose}:${look.light?.join(',') ?? ''}`;
}

/**
 * Hands the renderer the energy owner's real level — only while the planet is live. At rest, in a
 * frozen preview, hidden presentation or under reduced motion it hands a still zero, and does not register as a
 * consumer, so nothing asks the shared clock to run.
 */
function VoiceMarkEnergy(props: Readonly<{
    live: boolean;
    preview?: Readonly<{ energy?: number; flow?: number }>;
    children: (energy: SharedValue<number>, flow: SharedValue<number>) => React.ReactNode;
}>): React.ReactNode {
    const energy = useVoiceEnergyIfMounted();
    const presence = useVoiceEnergyPresenceIfMounted();
    const presented = useLayoutPresentationActive();
    const still = useSharedValue(0);
    const previewEnergy = useSharedValue(props.preview?.energy ?? 0);
    const previewFlow = useSharedValue(props.preview?.flow ?? 0);
    const active = presented && props.live && props.preview === undefined && energy !== null;
    React.useEffect(() => {
        if (!active || !presence) return;
        presence.acquire();
        return () => presence.release();
    }, [active, presence]);
    if (props.preview) return props.children(previewEnergy, previewFlow);
    return props.children(active && energy ? energy.level : still, active && energy ? energy.flow : still);
}

/** The slashed microphone pip: mute is a shape, never only a colour. */
const VoiceMarkMutePip = React.memo(function VoiceMarkMutePip(props: Readonly<{ size: number }>) {
    const { theme } = useUnistyles();
    const pip = Math.max(11, Math.round(props.size * 0.55));
    return (
        <View
            style={[
                styles.pip,
                {
                    width: pip,
                    height: pip,
                    borderRadius: pip / 2,
                    right: -3,
                    bottom: -3,
                    // A lifted disc (lab `.vp .mx`): it must stand off whatever surface the mark sits on —
                    // page or card, light or dark — so it carries a hairline edge as well as its shadow.
                    backgroundColor: theme.colors.surface.elevated,
                    borderColor: theme.colors.border.strong,
                    ...shadowLevelStyle(theme.colors.shadowLevels[2]),
                },
            ]}
        >
            <Icon name="microphone-slash" size={Math.round(pip * 0.78)} color={theme.colors.text.primary} />
        </View>
    );
});

const styles = StyleSheet.create({
    pip: {
        position: 'absolute',
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1,
    },
});
