import * as React from 'react';
import { View, type LayoutChangeEvent, type StyleProp, type TextStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierPressable, HAPPIER_PRESS_FEEDBACK_V1 } from '@happier-dev/plugin-ui/presentation';

import { MULTI_TEXT_INPUT_BASE_LINE_HEIGHT } from '@/components/ui/forms/multiTextInputTypography';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

/** A reading card shows about three lines of its prompt before "More" (DESIGN-4 M4, lab `editor-E1`). */
const READING_CLAMP_LINES = 3;

/** One line of the prompt's own type, measured to size the clamp in whole lines. */
const LINE_PROBE_GLYPH = 'M';

const styles = StyleSheet.create((theme) => ({
    /** The composer's own line height, so a clamp is whole lines of the text people write in. */
    lineMetrics: {
        lineHeight: MULTI_TEXT_INPUT_BASE_LINE_HEIGHT,
    },
    /** The clamped text and its toggle share the last line: "… More" reads inline (DESIGN-5 N13). */
    row: {
        flexDirection: 'row',
        alignItems: 'flex-end',
        gap: theme.margins.sm,
    },
    frame: {
        flex: 1,
        minWidth: 0,
        overflow: 'hidden',
    },
    /** Full text and one line, laid out at the same width to learn whether the clamp hides anything. */
    measure: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        opacity: 0,
    },
    toggle: {
        borderRadius: theme.borderRadius.sm,
        borderWidth: 1,
        borderColor: 'transparent',
    },
    toggleLabel: {
        ...Typography.default('semiBold'),
        color: theme.colors.text.secondary,
    },
}));

/**
 * A read-only composer's text. In a reading document (`clamp`) a long prompt is calm: three whole lines
 * at the composer's line height, clipped (never an ellipsis after a sentence's period), with an inline
 * "More" / "Less" at the end of the last line. The prompt itself is never shortened — only its
 * presentation. The toggle shows only when the clamp actually hides text: the full layout is compared
 * with three measured lines at the same width and user font scale. Session composers and every
 * editable composer render the text whole, as before.
 */
export function AgentInputReadOnlyText(props: Readonly<{
    value: string;
    style: StyleProp<TextStyle>;
    accessibilityLabel?: string;
    clamp: boolean;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const [expanded, setExpanded] = React.useState(false);
    const [lineHeight, setLineHeight] = React.useState<number | null>(null);
    const [fullHeight, setFullHeight] = React.useState<number | null>(null);
    if (!props.clamp) {
        return <Text selectable accessibilityLabel={props.accessibilityLabel} style={props.style}>{props.value}</Text>;
    }
    // Never commit a zero (or unmeasured) clamp: a text that cannot be measured is shown whole (DESIGN-6 N13).
    const clampHeight = lineHeight === null || !(lineHeight > 0) ? null : lineHeight * READING_CLAMP_LINES;
    // Whole pixels: sub-pixel layout rounding is not hidden text.
    const overflows = clampHeight !== null && fullHeight !== null && Math.ceil(fullHeight) > Math.ceil(clampHeight);
    const style = [props.style, styles.lineMetrics];
    return (
        <View>
            <View style={styles.row}>
                <View testID="agent-input-read-only-frame"
                    style={[styles.frame, !expanded && overflows && clampHeight !== null ? { maxHeight: clampHeight } : null]}>
                    <Text testID="agent-input-read-only-text" selectable accessibilityLabel={props.accessibilityLabel} style={style}>
                        {props.value}
                    </Text>
                </View>
                {overflows ? (
                    <HappierPressable
                        testID="agent-input-read-only-toggle"
                        accessibilityRole="button"
                        expanded={expanded}
                        accessibilityLabel={expanded ? t('common.less') : t('common.more')}
                        onPress={() => setExpanded((value) => !value)}
                        style={(state) => [styles.toggle,
                            state.pressed ? { opacity: HAPPIER_PRESS_FEEDBACK_V1.opacitySubtle } : null,
                            focusRingStyle({ focused: state.focused, color: theme.colors.border.focus })]}
                    >
                        <Text style={[styles.toggleLabel, styles.lineMetrics]}>{expanded ? t('common.less') : t('common.more')}</Text>
                    </HappierPressable>
                ) : null}
            </View>
            <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={styles.measure}>
                <Text testID="agent-input-read-only-measure" style={style}
                    onLayout={(event: LayoutChangeEvent) => setFullHeight(event.nativeEvent.layout.height)}>
                    {props.value}
                </Text>
                {/* A visible glyph, never whitespace: react-native-web collapses a whitespace-only
                    single line to 0 px, which once clamped every reading card to nothing. */}
                <Text testID="agent-input-read-only-line" numberOfLines={1} style={style}
                    onLayout={(event: LayoutChangeEvent) => setLineHeight(event.nativeEvent.layout.height)}>
                    {LINE_PROBE_GLYPH}
                </Text>
            </View>
        </View>
    );
}
