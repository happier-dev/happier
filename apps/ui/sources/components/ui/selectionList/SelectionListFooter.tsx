import * as React from 'react';
import { View, Platform } from 'react-native';
import Animated, {
    useAnimatedStyle,
    useSharedValue,
    withTiming,
} from 'react-native-reanimated';
import { StyleSheet } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';

import { KeyChip } from './accessories/KeyChip';
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
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderTopWidth: 1,
        borderTopColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
    },
    animator: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 12,
    },
    hint: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    description: {
        fontSize: Platform.select({ ios: 11, default: 10 }),
        lineHeight: Platform.select({ ios: 14, default: 12 }),
        color: theme.colors.text.secondary,
    },
}));

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
    testID?: string;
}>;

/**
 * Persistent footer container for SelectionList. Renders only keyboard hints
 * (KeyChip + description); functional actions live in `inputSuffix`, NOT here.
 *
 * Renders nothing when there are no hints OR when no hardware keyboard is
 * available. The animated cross-fade of the hint set when steps change is
 * owned by the SelectionList orchestrator (Phase 1.9), not this primitive.
 */
export function SelectionListFooter(props: SelectionListFooterProps): React.ReactElement | null {
    const styles = stylesheet;
    const reducedMotion = useReducedMotionPreference();
    const keyboardAvailable = props.hardwareKeyboardAvailable ?? true;

    // Track the currently rendered hints so we can keep painting the previous
    // set while the cross-fade animation runs. When the incoming `props.hints`
    // identity (joined ids) changes, fade out → swap children → fade in.
    const [renderedHints, setRenderedHints] = React.useState(props.hints);
    const opacity = useSharedValue(1);
    const lastHintsKeyRef = React.useRef(buildHintsKey(props.hints));

    React.useEffect(() => {
        const nextKey = buildHintsKey(props.hints);
        if (lastHintsKeyRef.current === nextKey) return;
        lastHintsKeyRef.current = nextKey;
        if (reducedMotion) {
            // Snap: no opacity dip, just swap the rendered hints.
            setRenderedHints(props.hints);
            opacity.value = 1;
            return;
        }
        opacity.value = withTiming(0, { duration: HINT_CROSSFADE_DURATION_MS }, (finished) => {
            if (!finished) return;
        });
        const fadeOutTimer = setTimeout(() => {
            setRenderedHints(props.hints);
            opacity.value = withTiming(1, { duration: HINT_CROSSFADE_DURATION_MS });
        }, HINT_CROSSFADE_DURATION_MS);
        return () => {
            clearTimeout(fadeOutTimer);
        };
    }, [props.hints, reducedMotion, opacity]);

    const animatedStyle = useAnimatedStyle(() => ({
        opacity: opacity.value,
    }));

    if (!keyboardAvailable) return null;
    if (renderedHints.length === 0 && props.hints.length === 0) return null;
    return (
        <View testID={props.testID} style={styles.container}>
            <Animated.View
                testID={selectionListTestId(props.testID, 'hints-animator')}
                style={[styles.animator, animatedStyle]}
            >
                {renderedHints.map((hint) => (
                    <View
                        key={hint.id}
                        testID={selectionListTestId(props.testID, 'hint', hint.id)}
                        style={styles.hint}
                    >
                        <KeyChip label={hint.label} />
                        {hint.description ? (
                            <Text style={styles.description}>{hint.description}</Text>
                        ) : null}
                    </View>
                ))}
            </Animated.View>
        </View>
    );
}
