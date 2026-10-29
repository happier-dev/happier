import * as React from 'react';
import { View, Platform } from 'react-native';
import Animated, {
    useAnimatedStyle,
    useSharedValue,
    withTiming,
} from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { isHappierPageRowNarrow, useHappierMaterialColorResolver } from '@happier-dev/plugin-ui/presentation';

import { Text } from '@/components/ui/text/Text';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { KeyHint } from '@/components/ui/keyboard/KeyHint';

import type { SelectionListKeyboardHint } from './_types';
import { selectionListTestId } from './_shared';

/**
 * R6 — Premium UI design polish (Fix 4): hint set cross-fade duration when the
 * visible step swaps in a different `hints` array. Snapping with React's
 * mount/unmount default reads as a flicker; the animator dips opacity to 0
 * over this duration, then swaps the children, then fades back to 1.
 */
const HINT_CROSSFADE_DURATION_MS = 120;

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        paddingHorizontal: theme.space.s12,
        paddingVertical: theme.space.s8,
        borderTopWidth: 1,
        borderTopColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
    },
    animator: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: theme.space.s12,
    },
    withAction: {
        flexDirection: 'row',
        alignItems: 'center',
        // The list's one action sits at the trailing edge, also when a narrow footer drops the hints.
        justifyContent: 'flex-end',
        gap: theme.space.s12,
    },
    animatorBesideAction: { flex: 1, minWidth: 0 },
    hint: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s6,
    },
    description: {
        fontSize: Platform.select({ ios: 11, default: 10 }),
        lineHeight: Platform.select({ ios: 14, default: 12 }),
        color: theme.colors.text.secondary,
    },
}));

/**
 * On a phone-width footer the Escape hint is left out: the hints would not fit one line, and the surface
 * already carries a visible way out (its Cancel or back control) that a keyboard hint only repeats.
 */
function isEscapeHint(hint: SelectionListKeyboardHint): boolean {
    return hint.label.trim().toLowerCase() === 'esc';
}

function buildHintsKey(hints: ReadonlyArray<SelectionListKeyboardHint>): string {
    if (hints.length === 0) return '';
    const parts: string[] = [];
    for (const hint of hints) parts.push(hint.id);
    return parts.join('|');
}

export type SelectionListFooterProps = Readonly<{
    hints: ReadonlyArray<SelectionListKeyboardHint>;
    /** When false, the entire footer renders nothing (touch device). Defaults to true. */
    hardwareKeyboardAvailable?: boolean;
    /** The list's one whole-list action, at the trailing edge; shown with or without a keyboard. */
    action?: React.ReactNode;
    testID?: string;
}>;

/**
 * Persistent footer container for SelectionList. Renders only keyboard hints
 * (KeyHint + description); functional actions live in `inputSuffix`, NOT here.
 *
 * Renders nothing when there are no hints OR when no hardware keyboard is
 * available. The animated cross-fade of the hint set when steps change is
 * owned by the SelectionList orchestrator (Phase 1.9), not this primitive.
 */
export function SelectionListFooter(props: SelectionListFooterProps): React.ReactElement | null {
    const { theme } = useUnistyles();
    const paintColor = useHappierMaterialColorResolver();
    const styles = stylesheet;
    const reducedMotion = useReducedMotionPreference();
    const keyboardAvailable = props.hardwareKeyboardAvailable ?? true;
    const [narrow, setNarrow] = React.useState(false);

    // Track the currently rendered hints so we can keep painting the previous
    // set while the cross-fade animation runs. When the incoming `props.hints`
    // identity (joined ids) changes, fade out → swap children → fade in.
    const [renderedHints, setRenderedHints] = React.useState(props.hints);
    const opacity = useSharedValue(1);
    // The fade follows the hint SET (ids), not the array identity: a parent that rebuilds the same hints
    // mid-fade must not cancel the swap and leave the footer faded out on the old set.
    const hintsKey = buildHintsKey(props.hints);
    const latestHintsRef = React.useRef(props.hints);
    latestHintsRef.current = props.hints;
    const lastHintsKeyRef = React.useRef(hintsKey);

    React.useEffect(() => {
        if (lastHintsKeyRef.current === hintsKey) return;
        lastHintsKeyRef.current = hintsKey;
        if (reducedMotion) {
            // Snap: no opacity dip, just swap the rendered hints.
            setRenderedHints(latestHintsRef.current);
            opacity.value = 1;
            return;
        }
        opacity.value = withTiming(0, { duration: HINT_CROSSFADE_DURATION_MS });
        const fadeOutTimer = setTimeout(() => {
            setRenderedHints(latestHintsRef.current);
            opacity.value = withTiming(1, { duration: HINT_CROSSFADE_DURATION_MS });
        }, HINT_CROSSFADE_DURATION_MS);
        return () => {
            clearTimeout(fadeOutTimer);
        };
    }, [hintsKey, reducedMotion, opacity]);
    // Same set, new text (a relabelled hint): show it without a fade.
    React.useEffect(() => {
        if (lastHintsKeyRef.current === buildHintsKey(renderedHints) && renderedHints !== props.hints) setRenderedHints(props.hints);
    }, [props.hints, renderedHints]);

    const animatedStyle = useAnimatedStyle(() => ({
        opacity: opacity.value,
    }));

    const action = props.action ?? null;
    if (!keyboardAvailable && action === null) return null;
    if (renderedHints.length === 0 && props.hints.length === 0 && action === null) return null;
    return (
        <View
            testID={props.testID}
            onLayout={(event) => setNarrow(isHappierPageRowNarrow(event.nativeEvent.layout.width))}
            style={[styles.container, action !== null ? styles.withAction : null, { backgroundColor: paintColor(theme.colors.surface.base, 'transparent') }]}
        >
            {/* A narrow footer with the list's one action gives the whole row to that action. */}
            {narrow && action !== null ? null : <Animated.View
                testID={selectionListTestId(props.testID, 'hints-animator')}
                style={[styles.animator, action !== null ? styles.animatorBesideAction : null, animatedStyle]}
            >
                {(keyboardAvailable ? renderedHints : []).filter((hint) => !(narrow && isEscapeHint(hint))).map((hint) => (
                    <View
                        key={hint.id}
                        testID={selectionListTestId(props.testID, 'hint', hint.id)}
                        style={styles.hint}
                    >
                        <KeyHint label={hint.label} />
                        {hint.description ? (
                            <Text style={styles.description}>{hint.description}</Text>
                        ) : null}
                    </View>
                ))}
            </Animated.View>}
            {action}
        </View>
    );
}
