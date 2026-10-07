import * as React from 'react';
import {
    Platform,
    Pressable,
    View,
    type GestureResponderEvent,
    type StyleProp,
    type TextStyle,
    type ViewStyle,
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
import { HappierSkeletonBlock, isHappierFocusVisible } from '@happier-dev/plugin-ui/presentation';

import { Icon } from '@/components/ui/icons/Icon';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { reanimatedMotionTokens } from '@/components/ui/motion/reanimatedMotionTokens';
import { Text } from '@/components/ui/text/Text';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { t } from '@/text';
import { isCoarsePrimaryPointerEnvironment } from '@/utils/platform/webMobileHeuristics';

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

export type AgentInputFolderChipProps = Readonly<{
    anchorRef?: React.RefObject<View | null>;
    state: AgentInputFolderChipState;
    tint: string;
    chipStyle: (pressed: boolean) => StyleProp<ViewStyle>;
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

type WebKeyEvent = Readonly<{ key: string; preventDefault?: () => void }>;
type WebPressableProps = React.ComponentProps<typeof Pressable> & Readonly<{
    onKeyDown?: (event: WebKeyEvent) => void;
    onHoverIn?: () => void;
    onHoverOut?: () => void;
}>;
const WebPressable = Pressable as unknown as React.ComponentType<WebPressableProps & React.RefAttributes<View>>;

/** × is a pointer/keyboard accelerator: touch-only surfaces use the picker's "No folder" row. */
function canOfferRemoveAccelerator(): boolean {
    return Platform.OS !== 'web' || !isCoarsePrimaryPointerEnvironment();
}

function isKeyboardFocus(event: { target?: unknown } | undefined): boolean {
    return Platform.OS !== 'web' || isHappierFocusVisible(event?.target);
}

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
    const reservesRemoveSlot = removable && canOfferRemoveAccelerator();
    const disabled = state.kind === 'machine_unavailable';
    const [chipHovered, setChipHovered] = React.useState(false);
    const [chipFocusVisible, setChipFocusVisible] = React.useState(false);
    const [removeHovered, setRemoveHovered] = React.useState(false);
    const [removeFocusVisible, setRemoveFocusVisible] = React.useState(false);
    const [pressed, setPressed] = React.useState(false);
    const openRef = React.useRef<View | null>(null);
    const focusAfterRemoveRef = React.useRef(false);
    const showRemove = reservesRemoveSlot && (chipHovered || chipFocusVisible || removeHovered || removeFocusVisible);

    const setOpenRef = React.useCallback((node: View | null) => {
        openRef.current = node;
        if (props.anchorRef) (props.anchorRef as React.MutableRefObject<View | null>).current = node;
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
        (openRef.current as unknown as { focus?: () => void } | null)?.focus?.();
    }, [state.kind]);

    const handleKeyDown = React.useCallback((event: WebKeyEvent) => {
        if (!removable || !REMOVE_KEYS.has(event.key)) return;
        event.preventDefault?.();
        remove();
    }, [remove, removable]);

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
            layout={layoutTransition}
            style={[ROW_STYLE, props.layout === 'wrap' ? WRAP_STYLE : SHRINK_STYLE]}
        >
            <WebPressable
                ref={setOpenRef}
                testID="agent-input-path-chip"
                accessibilityRole="button"
                accessibilityLabel={resolveChipAccessibilityLabel(state)}
                accessibilityHint={state.kind === 'machine_unavailable' ? state.reason : undefined}
                accessibilityState={{ disabled }}
                accessibilityActions={removable ? [{ name: 'remove', label: t('newSession.folder.removeFolder') }] : undefined}
                onAccessibilityAction={removable ? handleAccessibilityAction : undefined}
                disabled={disabled}
                onPress={props.onPress}
                onPressIn={() => setPressed(true)}
                onPressOut={() => setPressed(false)}
                onKeyDown={Platform.OS === 'web' ? handleKeyDown : undefined}
                onHoverIn={() => setChipHovered(true)}
                onHoverOut={() => setChipHovered(false)}
                onFocus={(event) => setChipFocusVisible(isKeyboardFocus(event))}
                onBlur={() => setChipFocusVisible(false)}
                hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
                style={[
                    props.chipStyle(pressed),
                    props.layout === 'wrap' ? WRAP_STYLE : SHRINK_STYLE,
                    reservesRemoveSlot ? { paddingRight: 2 } : null,
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
            </WebPressable>
            {reservesRemoveSlot ? (
                <FolderChipRemoveButton
                    visible={showRemove}
                    tint={props.tint}
                    reducedMotion={reducedMotion}
                    onPress={remove}
                    onHoverChange={setRemoveHovered}
                    onFocusVisibleChange={setRemoveFocusVisible}
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
    onHoverChange: (hovered: boolean) => void;
    onFocusVisibleChange: (visible: boolean) => void;
}>) {
    const { theme } = useUnistyles();
    const [hovered, setHovered] = React.useState(false);
    const [pressed, setPressed] = React.useState(false);
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

    const handlePress = React.useCallback((event?: GestureResponderEvent) => {
        // A press on × is never a press on the chip.
        event?.stopPropagation?.();
        props.onPress();
    }, [props.onPress]);

    return (
        <WebPressable
            testID="agent-input-path-chip-remove"
            accessibilityRole="button"
            accessibilityLabel={t('newSession.folder.removeFolder')}
            accessible={props.visible}
            accessibilityElementsHidden={!props.visible}
            importantForAccessibility={props.visible ? 'auto' : 'no-hide-descendants'}
            disabled={!props.visible}
            onPress={handlePress}
            onPressIn={() => setPressed(true)}
            onPressOut={() => setPressed(false)}
            onHoverIn={() => { setHovered(true); props.onHoverChange(true); }}
            onHoverOut={() => { setHovered(false); props.onHoverChange(false); }}
            onFocus={(event) => props.onFocusVisibleChange(isKeyboardFocus(event))}
            onBlur={() => props.onFocusVisibleChange(false)}
            style={{
                width: AGENT_INPUT_CHIP_REMOVE_TARGET_WIDTH_PX,
                alignSelf: 'stretch',
                marginRight: 4,
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: AGENT_INPUT_CHIP_REMOVE_TARGET_WIDTH_PX / 2,
                backgroundColor: hovered && props.visible ? theme.colors.surface.pressedOverlay : 'transparent',
                transform: [{ scale: pressed && !reducedMotion ? motionTokens.press.scale : 1 }],
            }}
        >
            <Animated.View style={glyphStyle}>
                <Icon name="x" size={AGENT_INPUT_CHIP_OPTION_ICON_SIZE_PX} color={hovered ? theme.colors.text.primary : props.tint} />
            </Animated.View>
        </WebPressable>
    );
});
