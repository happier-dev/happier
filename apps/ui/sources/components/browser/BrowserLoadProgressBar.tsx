import * as React from 'react';
import type { BrowserNavigationLoadingStateV1 } from '@happier-dev/protocol/browser/events/v1';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import Animated, {
    runOnJS,
    useAnimatedStyle,
    useSharedValue,
    withSequence,
    withTiming,
} from 'react-native-reanimated';
import { HappierProgress } from '@happier-dev/plugin-ui/presentation';

import { reanimatedMotionTokens } from '@/components/ui/motion/reanimatedMotionTokens';
import { usePluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { t } from '@/text';

const TRACK_HEIGHT = 2;

/**
 * Where an unknown-progress load drifts to while it waits. The line moves so the page never reads
 * as frozen, but it never claims to be nearly done: the last stretch belongs to the real finish.
 */
const UNKNOWN_PROGRESS_DRIFT_TARGET = 0.7;
/**
 * How long that drift takes. A presentation curve, not a limit: nothing is cancelled when it ends,
 * the line simply rests at the drift target until the page reports ready.
 */
const UNKNOWN_PROGRESS_DRIFT_MS = 6_000;
/** The first visible sliver, so a load that has just begun is already on screen. */
const INITIAL_SLIVER = 0.08;

const stylesheet = StyleSheet.create((theme) => ({
    track: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        height: TRACK_HEIGHT,
        backgroundColor: 'transparent',
        overflow: 'hidden',
        zIndex: 2,
    },
    fill: {
        height: TRACK_HEIGHT,
        width: '100%',
        backgroundColor: theme.colors.text.primary,
        opacity: 0.55,
        transformOrigin: 'left',
    },
}));

type Phase = 'hidden' | 'loading' | 'settling';

/**
 * The page's load, as one 2 px line along the top of the page (lab `browser` Q).
 *
 * It fills toward the engine's real progress (or drifts, when the engine reports none), and when the
 * page is ready it runs to the end and fades — it settles, it does not blink off. No glow, and no
 * second loading signal on top of a page that is already painting. The fill is a transform, so the
 * motion stays on the compositor. Reduced motion: the line appears at the reported width and
 * disappears on ready, with no travel. Failed or idle navigation removes the line without a finish.
 */
export function BrowserLoadProgressBar(props: Readonly<{
    progress: number | null;
    loadingState: BrowserNavigationLoadingStateV1;
    reducedMotion?: boolean;
    testID?: string;
}>): React.ReactElement | null {
    const detectedReducedMotion = useReducedMotionPreference();
    const reducedMotion = props.reducedMotion ?? detectedReducedMotion;
    const { theme } = useUnistyles();
    const presentationTheme = usePluginUiTheme(theme);
    const testID = props.testID ?? 'browser-load-progress';
    const loading = props.loadingState === 'loading';
    const ready = props.loadingState === 'ready';
    const [phase, setPhase] = React.useState<Phase>(loading ? 'loading' : 'hidden');
    const fill = useSharedValue(loading ? INITIAL_SLIVER : 0);
    const opacity = useSharedValue(1);

    const hide = React.useCallback(() => setPhase('hidden'), []);
    // Whether the line on screen belongs to the current load. A load that begins after the last one
    // finished (or while its line is still fading) starts a fresh line from the sliver; reusing the
    // finished line would show a full bar for a page that has only just started.
    const lineBelongsToLoadRef = React.useRef(loading);

    React.useEffect(() => {
        if (loading) {
            setPhase('loading');
            opacity.value = 1;
            if (!lineBelongsToLoadRef.current) {
                lineBelongsToLoadRef.current = true;
                fill.value = INITIAL_SLIVER;
            }
            const known = typeof props.progress === 'number' && Number.isFinite(props.progress);
            const target = known ? Math.max(INITIAL_SLIVER, Math.min(1, props.progress as number)) : UNKNOWN_PROGRESS_DRIFT_TARGET;
            if (reducedMotion) {
                fill.value = known ? target : INITIAL_SLIVER;
                return;
            }
            fill.value = withTiming(Math.max(fill.value, target), {
                duration: known ? reanimatedMotionTokens.durationMs.base : UNKNOWN_PROGRESS_DRIFT_MS,
                easing: reanimatedMotionTokens.easing.standard,
            });
            return;
        }
        lineBelongsToLoadRef.current = false;
        setPhase((current) => (current === 'hidden' || !ready ? 'hidden' : 'settling'));
    }, [fill, loading, opacity, props.progress, ready, reducedMotion]);

    React.useEffect(() => {
        if (phase !== 'settling') return;
        if (reducedMotion) {
            hide();
            return;
        }
        fill.value = withTiming(1, {
            duration: reanimatedMotionTokens.durationMs.fast,
            easing: reanimatedMotionTokens.easing.standard,
        });
        opacity.value = withSequence(
            withTiming(1, { duration: reanimatedMotionTokens.durationMs.fast }),
            withTiming(0, {
                duration: reanimatedMotionTokens.durationMs.base,
                easing: reanimatedMotionTokens.easing.exit,
            }, (finished) => {
                if (finished) runOnJS(hide)();
            }),
        );
    }, [fill, hide, opacity, phase, reducedMotion]);

    const fillStyle = useAnimatedStyle(() => ({
        opacity: opacity.value * 0.55,
        transform: [{ scaleX: fill.value }],
    }));

    if (phase === 'hidden' || (!loading && !ready)) {
        return null;
    }

    return (
        <HappierProgress
            testID={testID}
            label={t('common.loading')}
            value={loading ? props.progress ?? undefined : 1}
            theme={presentationTheme}
            pointerEvents="none"
            style={stylesheet.track}
            renderFill={() => (
                <Animated.View
                    testID={`${testID}-fill`}
                    style={[stylesheet.fill, fillStyle]}
                />
            )}
        />
    );
}
