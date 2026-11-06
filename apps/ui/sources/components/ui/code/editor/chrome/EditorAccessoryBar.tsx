import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useHappierMaterialColorResolver } from '@happier-dev/plugin-ui/presentation';

import { useReportPageBottomBar } from '@/components/ui/layout/useFloatingChromeClearance';
import { HorizontalScrollableRow } from '@/components/ui/scroll/HorizontalScrollableRow';
import { KeyboardStickyFooter } from '@/components/ui/keyboardAvoidance/KeyboardStickyFooter';
import { Text } from '@/components/ui/text/Text';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { Typography } from '@/constants/Typography';
import { CODE_EDITOR_BASE_FONT_SIZE, CODE_EDITOR_BASE_LINE_HEIGHT } from '../codeEditorFontMetrics';

export type EditorAccessoryBarProps = Readonly<{
    children: React.ReactNode;
    variant?: 'panel' | 'inline';
    /** Panel only: keys that never scroll away, before the row (hide keyboard). */
    leading?: React.ReactNode;
    /** Panel only: the pinned end of the bar (Undo and the editor's Save stay in reach while the keys scroll). */
    trailing?: React.ReactNode;
    accessibilityLabel?: string;
    testID?: string;
}>;

/** Shared editor row chrome; native panels keep the existing keyboard-sticky owner. */
export function EditorAccessoryBar(props: EditorAccessoryBarProps) {
    const { theme } = useUnistyles();
    const paintColor = useHappierMaterialColorResolver();
    const isInline = props.variant === 'inline';
    // The panel row is in flow at the page's bottom and cannot step aside, so floating companions sit above it.
    const onSeatLayout = useReportPageBottomBar(!isInline, 0);
    const content = <HorizontalScrollableRow
        testID={props.testID ? `${props.testID}:scroll` : undefined}
        contentTestID={props.testID ? `${props.testID}:scroll-content` : undefined}
        fadeColor={isInline ? theme.colors.surface.base : theme.colors.surface.inset}
        indicatorColor={theme.colors.text.secondary}
        contentStyle={isInline ? stylesheet.scrollContentInline : stylesheet.scrollContent}
    >
        {props.children}
    </HorizontalScrollableRow>;

    if (isInline) return <View testID={props.testID} accessibilityRole="toolbar" style={stylesheet.inlineRoot}>
        {content}
    </View>;

    const backgroundColor = paintColor(theme.colors.surface.inset, 'transparent');
    const bar = <View testID={props.testID} accessibilityRole="toolbar" accessibilityLabel={props.accessibilityLabel}
        style={[stylesheet.bar, props.leading || props.trailing ? stylesheet.pinnedBar : null,
            { backgroundColor }]}>
        {props.leading ? <View style={[stylesheet.pinned, stylesheet.pinnedLeading]}>{props.leading}</View> : null}
        <View style={stylesheet.scrollSlot}>{content}</View>
        {props.trailing ? <View style={[stylesheet.pinned, stylesheet.pinnedTrailing]}>{props.trailing}</View> : null}
    </View>;
    return <KeyboardStickyFooter onLayout={onSeatLayout} style={{ backgroundColor }}>{bar}</KeyboardStickyFooter>;
}

export type EditorAccessoryChipProps = Readonly<{
    /** A glyph key; or `text` for a key that types or names itself (Tab, `(`, `{`). */
    icon?: IconName;
    text?: string;
    label: string;
    onPress: () => void;
    selected?: boolean;
    disabled?: boolean;
    badge?: string;
    testID?: string;
    /** Held, the key repeats (arrow keys, P4 §3.7); a tap still steps once. */
    repeat?: boolean;
}>;

/** A press callback, not an editor command owner: hosts bind their existing handle or Save action. */
export function EditorAccessoryChip(props: EditorAccessoryChipProps) {
    const { theme } = useUnistyles();
    const paintColor = useHappierMaterialColorResolver();
    const selected = props.selected === true;
    const foreground = selected ? theme.colors.state.active.foreground : theme.colors.text.secondary;
    const repeatHandlers = useHeldKeyRepeat(props.repeat === true && !props.disabled, props.onPress);
    return <Pressable
        testID={props.testID}
        accessibilityRole="button"
        accessibilityLabel={props.label}
        accessibilityState={props.selected === undefined && props.disabled === undefined ? undefined : {
            ...(props.selected === undefined ? {} : { selected }),
            ...(props.disabled === undefined ? {} : { disabled: props.disabled }),
        }}
        aria-pressed={props.selected}
        disabled={props.disabled}
        hitSlop={6}
        onPress={repeatHandlers?.onPress ?? props.onPress}
        onPressIn={repeatHandlers?.onPressIn}
        onPressOut={repeatHandlers?.onPressOut}
        style={({ pressed }) => [stylesheet.chip, props.text !== undefined ? stylesheet.textChip : null, props.disabled ? stylesheet.disabledChip : null, {
            backgroundColor: paintColor(selected ? theme.colors.state.active.background : theme.colors.surface.base),
            borderColor: selected ? theme.colors.state.active.border : theme.colors.border.default,
            opacity: pressed ? motionTokens.press.opacity : 1,
        }]}
    >
        {props.text !== undefined
            ? <Text style={[props.text.length <= 2 ? stylesheet.symbolKeyText : stylesheet.keyText, { color: foreground }]} allowFontScaling={false}>{props.text}</Text>
            : props.icon ? <Icon name={props.icon} size={16} color={foreground} /> : null}
        {props.badge ? <Text style={[stylesheet.badge, { color: foreground }]} allowFontScaling={false}>
            {props.badge}
        </Text> : null}
    </Pressable>;
}

/**
 * Press-in steps at once and starts the repeat; release stops it and swallows the release's own press.
 * A press with no press-in (keyboard, assistive activation) steps once.
 */
function useHeldKeyRepeat(enabled: boolean, onStep: () => void) {
    const stepRef = React.useRef(onStep);
    stepRef.current = onStep;
    const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const heldRef = React.useRef(false);
    const stop = React.useCallback(() => {
        if (timerRef.current !== null) { clearTimeout(timerRef.current); timerRef.current = null; }
    }, []);
    React.useEffect(() => stop, [stop]);
    return React.useMemo(() => enabled ? {
        onPressIn: () => {
            heldRef.current = true;
            stepRef.current();
            const tick = () => { stepRef.current(); timerRef.current = setTimeout(tick, motionTokens.gesture.keyRepeatIntervalMs); };
            stop();
            timerRef.current = setTimeout(tick, motionTokens.gesture.keyRepeatDelayMs);
        },
        onPressOut: stop,
        onPress: () => {
            if (heldRef.current) { heldRef.current = false; return; }
            stepRef.current();
        },
    } : null, [enabled, stop]);
}

// Mechanical extraction of the Markdown toolbar's existing geometry and paint.
// The phone-specific code-key inventory and composition are supplied by its host.
const stylesheet = StyleSheet.create((theme) => ({
    bar: {
        backgroundColor: theme.colors.surface.inset,
        borderTopWidth: Platform.select({ ios: 0.33, default: 1 }),
        borderTopColor: theme.colors.border.default,
    },
    scrollContent: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingHorizontal: 12,
        paddingVertical: 8,
    },
    pinnedBar: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    scrollSlot: {
        flex: 1,
        minWidth: 0,
    },
    pinned: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingVertical: 8,
    },
    pinnedLeading: {
        paddingLeft: 12,
        paddingRight: 6,
        borderRightWidth: StyleSheet.hairlineWidth,
        borderRightColor: theme.colors.border.default,
    },
    pinnedTrailing: {
        paddingLeft: 6,
        paddingRight: 12,
    },
    textChip: {
        width: undefined,
        minWidth: 34,
        paddingHorizontal: 10,
    },
    disabledChip: {
        opacity: 0.45,
    },
    // Word keys (Tab, Changes) read as labels; symbol keys use the editor's own code face and size.
    keyText: {
        ...Typography.variant('label'),
    },
    symbolKeyText: {
        ...Typography.mono(),
        fontSize: CODE_EDITOR_BASE_FONT_SIZE + 2,
        lineHeight: CODE_EDITOR_BASE_LINE_HEIGHT,
    },
    scrollContentInline: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingHorizontal: 0,
        paddingVertical: 0,
    },
    inlineRoot: {
        flex: 1,
        minWidth: 0,
        flexDirection: 'row',
        alignItems: 'center',
    },
    chip: {
        width: 34,
        height: 34,
        borderRadius: 9,
        borderWidth: 1,
        alignItems: 'center',
        justifyContent: 'center',
        position: 'relative',
    },
    badge: {
        position: 'absolute',
        right: 4,
        bottom: 3,
        fontSize: 9,
        fontWeight: '700',
        lineHeight: 10,
    },
}));
