import * as React from 'react';
import {
    View,
    type StyleProp,
    type TextStyle,
} from 'react-native';
import Animated, {
    FadeIn,
    LinearTransition,
    ReduceMotion,
    useAnimatedStyle,
    useSharedValue,
    withTiming,
} from 'react-native-reanimated';
import { useUnistyles } from 'react-native-unistyles';
import { HappierPressable, HappierSkeletonBlock, isHappierFocusVisible, type HappierPressableProps } from '@happier-dev/plugin-ui/presentation';

import { Icon } from '@/components/ui/icons/Icon';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { reanimatedMotionTokens } from '@/components/ui/motion/reanimatedMotionTokens';
import { Text } from '@/components/ui/text/Text';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { t } from '@/text';
import { useRowActionHoverHost } from '@/components/sessions/transcript/messageActions/rowActionRevealHost';
import { isHoverCapablePrimaryPointer } from '@/utils/platform/webMobileHeuristics';

import {
    AGENT_INPUT_CHIP_ICON_SIZE_PX,
    AGENT_INPUT_CHIP_ICON_STYLE,
    AGENT_INPUT_CHIP_OPTION_ICON_SIZE_PX,
    AGENT_INPUT_CHIP_REMOVE_TARGET_WIDTH_PX,
    AGENT_INPUT_FOLDER_CHIP_RESOLVING_SIZE,
} from './agentInputChipIconMetrics';

/**
 * Where the new session lives, as the one folder chip shows it. Four states, never conflated:
 * a folder; no folder (the machine keeps a private one); the folder still resolving; and the
 * machine unavailable, which keeps showing the current value but cannot be changed.
 */
export type AgentInputFolderChipState =
    | Readonly<{ kind: 'folder'; path: string }>
    | Readonly<{ kind: 'none' }>
    | Readonly<{ kind: 'resolving'; lastKnownPath: string | null }>
    | Readonly<{
        kind: 'machine_unavailable';
        label: Readonly<{ kind: 'folder'; path: string }> | Readonly<{ kind: 'none' }>;
        /** The machine's own unavailable reason, read to assistive tech as the hint. */
        reason: string;
    }>;

/**
 * The one resolution of the chip's state from the composer's inputs: an explicit state wins;
 * otherwise `currentPath` is shorthand for a folder, and no path yet means the folder is resolving.
 */
export function resolveAgentInputFolderChipState(
    currentPath: string | null | undefined,
    explicit: AgentInputFolderChipState | undefined,
): AgentInputFolderChipState {
    if (explicit) return explicit;
    const path = typeof currentPath === 'string' ? currentPath.trim() : '';
    return path ? { kind: 'folder', path } : { kind: 'resolving', lastKnownPath: null };
}

/** A static style the shared pressable accepts (its portable style, not a style callback). */
type ChipPressableStyle = Exclude<HappierPressableProps['style'], (state: never) => unknown>;

export type AgentInputFolderChipProps = Readonly<{
    anchorRef?: React.RefObject<View | null>;
    state: AgentInputFolderChipState;
    tint: string;
    chipStyle: (pressed: boolean) => ChipPressableStyle;
    textStyle: StyleProp<TextStyle>;
    /** Opens the folder choices (popover or pushed picker). */
    onPress: () => void;
    /** Present when the folder can be removed from here; one handler for ×, Delete and the a11y action. */
    onRemove?: () => void;
    /**
     * `shrink` lets a long folder middle-ellipsize inside a single row; `wrap` keeps the chip whole
     * and lets its row wrap it (the secondary control row).
     */
    layout?: 'shrink' | 'wrap';
}>;

const SHRINK_STYLE = { flexShrink: 1, minWidth: 0 } as const;
const WRAP_STYLE = { flexShrink: 0, minWidth: 0, maxWidth: '100%' } as const;
const ROW_STYLE = { flexDirection: 'row', alignItems: 'center' } as const;
const REMOVE_KEYS = new Set(['Delete', 'Backspace']);
const CHIP_HIT_SLOP = { top: 5, bottom: 10, left: 0, right: 0 } as const;

/** The chip's pressable host, handed out by the shared pressable for focus and popover anchoring. */
type ChipControl = Parameters<NonNullable<HappierPressableProps['controlRef']>>[0];

function resolveChipAccessibilityLabel(state: AgentInputFolderChipState): string {
    switch (state.kind) {
        case 'folder':
            return t('newSession.folder.a11y.folder', { path: state.path });
        case 'none':
            return t('newSession.folder.a11y.none');
        case 'resolving':
            return t('newSession.folder.a11y.loading');
        case 'machine_unavailable':
            return state.label.kind === 'folder'
                ? t('newSession.folder.a11y.folder', { path: state.label.path })
                : t('newSession.folder.a11y.none');
    }
}

/**
 * The one folder chip of the new-session composer (both the action row and the secondary
 * path row render it). The chip opens the folder choices; × is a sibling pressable, never
 * nested, so pressing it can never open the picker. Its slot is reserved wherever × can appear,
 * so showing it never changes the chip's width.
 */
export function AgentInputFolderChip(props: AgentInputFolderChipProps): React.ReactElement {
    const { theme } = useUnistyles();
    const reducedMotion = useReducedMotionPreference();
    const { state, onRemove } = props;
    const removable = state.kind === 'folder' && typeof onRemove === 'function';
    // × is a hover/keyboard accelerator (plan 03 §4.1): only a hover-capable primary pointer gets it
    // and its reserved slot. Touch-only devices remove through the picker's "No folder" row and the
    // screen-reader action, so the chip keeps its natural width there.
    const reservesRemoveSlot = removable && isHoverCapablePrimaryPointer();
    const disabled = state.kind === 'machine_unavailable';
    // One hover region spans the chip and ×, so moving onto × never hides it.
    const hoverRegion = useRowActionHoverHost();
    const [chipFocusVisible, setChipFocusVisible] = React.useState(false);
    const [removeFocusVisible, setRemoveFocusVisible] = React.useState(false);
    const openRef = React.useRef<ChipControl>(null);
    const focusAfterRemoveRef = React.useRef(false);
    const showRemove = reservesRemoveSlot && (hoverRegion.isHovered || chipFocusVisible || removeFocusVisible);

    const setOpenRef = React.useCallback((node: ChipControl) => {
        openRef.current = node;
        if (props.anchorRef) (props.anchorRef as React.MutableRefObject<View | null>).current = node as unknown as View | null;
    }, [props.anchorRef]);

    const remove = React.useCallback(() => {
        if (!removable) return;
        // × disappears with the folder; keep focus on the same chip, now "Add folder".
        focusAfterRemoveRef.current = true;
        onRemove?.();
    }, [onRemove, removable]);

    React.useEffect(() => {
        if (!focusAfterRemoveRef.current || state.kind !== 'none') return;
        focusAfterRemoveRef.current = false;
        openRef.current?.focus?.();
    }, [state.kind]);

    // The shared pressable consumes a handled key (preventDefault) when this returns true.
    const handleKeyDown = React.useCallback((key: string) => {
        if (!removable || !REMOVE_KEYS.has(key)) return false;
        remove();
        return true;
    }, [remove, removable]);
    const handleChipFocusChange = React.useCallback((focused: boolean) => {
        setChipFocusVisible(focused && isHappierFocusVisible());
    }, []);
    const handleRemoveFocusChange = React.useCallback((focused: boolean) => {
        setRemoveFocusVisible(focused && isHappierFocusVisible());
    }, []);

    const handleAccessibilityAction = React.useCallback((event: { nativeEvent: { actionName: string } }) => {
        if (event.nativeEvent.actionName === 'remove') remove();
    }, [remove]);

    const layoutTransition = React.useMemo(() => (
        reducedMotion
            ? undefined
            : LinearTransition
                .duration(reanimatedMotionTokens.durationMs.base)
                .easing(reanimatedMotionTokens.layoutEasing.standard)
                .reduceMotion(ReduceMotion.Never)
    ), [reducedMotion]);
    const labelEntering = React.useMemo(() => (
        FadeIn.duration(reducedMotion ? reanimatedMotionTokens.durationMs.fast : reanimatedMotionTokens.durationMs.base)
            .reduceMotion(ReduceMotion.Never)
    ), [reducedMotion]);

    const labelState = state.kind === 'machine_unavailable' ? state.label : state;
    const foreground = disabled ? theme.colors.text.tertiary : props.tint;
    const glyph = labelState.kind === 'none' ? 'folder-plus' : 'folder';
    const labelText = labelState.kind === 'folder'
        ? labelState.path
        : labelState.kind === 'none'
            ? t('newSession.folder.addFolder')
            : labelState.lastKnownPath;

    return (
        <Animated.View
            testID="agent-input-path-chip-region"
            layout={layoutTransition}
            style={[ROW_STYLE, props.layout === 'wrap' ? WRAP_STYLE : SHRINK_STYLE]}
            {...(reservesRemoveSlot ? hoverRegion.hoverProps : {})}
        >
            <HappierPressable
                controlRef={setOpenRef}
                testID="agent-input-path-chip"
                accessibilityLabel={resolveChipAccessibilityLabel(state)}
                accessibilityHint={state.kind === 'machine_unavailable' ? state.reason : undefined}
                accessibilityActions={removable ? [{ name: 'remove', label: t('newSession.folder.removeFolder') }] : undefined}
                onAccessibilityAction={removable ? handleAccessibilityAction : undefined}
                disabled={disabled}
                onPress={props.onPress}
                onKeyDown={handleKeyDown}
                onFocusChange={handleChipFocusChange}
                hitSlop={CHIP_HIT_SLOP}
                style={({ pressed, focused }) => [
                    props.chipStyle(pressed),
                    props.layout === 'wrap' ? WRAP_STYLE : SHRINK_STYLE,
                    reservesRemoveSlot ? { paddingRight: 2 } : null,
                    focusRingStyle({ focused, color: theme.colors.border.focus }),
                ]}
            >
                <Animated.View key={labelState.kind} entering={labelEntering} style={[ROW_STYLE, SHRINK_STYLE, { gap: 6 }]}>
                    <Icon name={glyph} size={AGENT_INPUT_CHIP_ICON_SIZE_PX} color={foreground} style={AGENT_INPUT_CHIP_ICON_STYLE} />
                    {/* The folder stays label-visible even in icon-only chip density. */}
                    {labelText !== null ? (
                        <Text
                            numberOfLines={1}
                            ellipsizeMode="middle"
                            style={[props.textStyle, SHRINK_STYLE, disabled ? { color: foreground } : null]}
                        >
                            {labelText}
                        </Text>
                    ) : (
                        <View aria-hidden={true} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
                            <HappierSkeletonBlock
                                color={theme.colors.surface.pressedOverlay}
                                width={AGENT_INPUT_FOLDER_CHIP_RESOLVING_SIZE.width}
                                height={AGENT_INPUT_FOLDER_CHIP_RESOLVING_SIZE.height}
                                radius={AGENT_INPUT_FOLDER_CHIP_RESOLVING_SIZE.height / 2}
                                reducedMotion={reducedMotion}
                            />
                        </View>
                    )}
                </Animated.View>
            </HappierPressable>
            {reservesRemoveSlot ? (
                <FolderChipRemoveButton
                    visible={showRemove}
                    tint={props.tint}
                    reducedMotion={reducedMotion}
                    onPress={remove}
                    onFocusChange={handleRemoveFocusChange}
                />
            ) : null}
        </Animated.View>
    );
}

const FolderChipRemoveButton = React.memo(function FolderChipRemoveButton(props: Readonly<{
    visible: boolean;
    tint: string;
    reducedMotion: boolean;
    onPress: () => void;
    onFocusChange: (focused: boolean) => void;
}>) {
    const { theme } = useUnistyles();
    const shown = useSharedValue(props.visible ? 1 : 0);
    React.useEffect(() => {
        // Enter at the fast step, exit quicker: attention is moving on.
        shown.value = withTiming(props.visible ? 1 : 0, {
            duration: props.visible ? reanimatedMotionTokens.durationMs.fast : reanimatedMotionTokens.durationMs.press,
            easing: reanimatedMotionTokens.easing.standard,
        });
    }, [props.visible, shown]);
    const reducedMotion = props.reducedMotion;
    const glyphStyle = useAnimatedStyle(() => ({
        opacity: shown.value,
        transform: [{ scale: reducedMotion ? 1 : 0.7 + 0.3 * shown.value }],
    }), [reducedMotion]);

    const { onPress } = props;
    const handlePress = React.useCallback((event?: { stopPropagation?: () => void }) => {
        // A press on × is never a press on the chip.
        event?.stopPropagation?.();
        onPress();
    }, [onPress]);

    return (
        // Hidden × leaves the accessibility tree; the chip's "Remove folder" action stays the AT path.
        <View
            style={REMOVE_SLOT_STYLE}
            accessibilityElementsHidden={!props.visible}
            importantForAccessibility={props.visible ? 'auto' : 'no-hide-descendants'}
            aria-hidden={props.visible ? undefined : true}
        >
            <HappierPressable
                testID="agent-input-path-chip-remove"
                accessibilityLabel={t('newSession.folder.removeFolder')}
                disabled={!props.visible}
                onPress={handlePress}
                onFocusChange={props.onFocusChange}
                style={({ focused }) => [REMOVE_TARGET_STYLE, focusRingStyle({ focused, color: theme.colors.border.focus })]}
            >
                {({ pressed, hovered }) => (
                    // Hover fill and the canonical press scale (down on press, back on release).
                    <View
                        style={[REMOVE_FILL_STYLE, {
                            backgroundColor: hovered && props.visible ? theme.colors.surface.pressedOverlay : 'transparent',
                            transform: [{ scale: pressed && !reducedMotion ? motionTokens.press.scale : 1 }],
                        }]}
                    >
                        <Animated.View style={glyphStyle}>
                            <Icon name="x" size={AGENT_INPUT_CHIP_OPTION_ICON_SIZE_PX} color={hovered ? theme.colors.text.primary : props.tint} />
                        </Animated.View>
                    </View>
                )}
            </HappierPressable>
        </View>
    );
});

const REMOVE_SLOT_STYLE = { alignSelf: 'stretch', marginRight: 4 } as const;
const REMOVE_TARGET_STYLE = {
    width: AGENT_INPUT_CHIP_REMOVE_TARGET_WIDTH_PX,
    flex: 1,
    borderRadius: AGENT_INPUT_CHIP_REMOVE_TARGET_WIDTH_PX / 2,
} as const;
const REMOVE_FILL_STYLE = {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: AGENT_INPUT_CHIP_REMOVE_TARGET_WIDTH_PX / 2,
} as const;
