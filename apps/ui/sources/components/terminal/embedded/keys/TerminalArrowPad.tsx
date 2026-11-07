import * as React from 'react';
import { Animated, Easing, Pressable, View, useWindowDimensions, type GestureResponderEvent } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { resolveThemeColor } from '@/theme/parseThemeColor';

import { hapticsLight } from '@/components/ui/theme/haptics';
import { shadowLevelStyle } from '@/shadowElevation';
import { Icon, ICON_SIZE, type IconName } from '@/components/ui/icons/Icon';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { t } from '@/text';
import { useTerminalArrowPadPlacement, writeTerminalArrowPadPlacement } from './terminalArrowPadState';

import {
    ARROW_PAD_METRICS as M,
    resolveArrowPadCenter,
    resolveArrowPadDirection,
    resolveArrowPadDotCenter,
    resolveArrowPadRelease,
    resolveArrowPadCursorOverlap,
    type ArrowPadArea,
    type ArrowPadPlacement,
} from './terminalArrowPadGeometry';
import type { TerminalArrowDirection } from './terminalKeyInput';
import type { EmbeddedTerminalCursorRow } from '../embeddedTerminalRendererHandle';

const KEYS: readonly Readonly<{ direction: TerminalArrowDirection; icon: IconName; left: number; top: number }>[] = [
    { direction: 'up', icon: 'caret-up', left: M.keyPx + M.keyGapPx, top: 0 },
    { direction: 'left', icon: 'caret-left', left: 0, top: M.keyPx + M.keyGapPx },
    { direction: 'right', icon: 'caret-right', left: (M.keyPx + M.keyGapPx) * 2, top: M.keyPx + M.keyGapPx },
    { direction: 'down', icon: 'caret-down', left: M.keyPx + M.keyGapPx, top: (M.keyPx + M.keyGapPx) * 2 },
];

function arrowLabel(direction: TerminalArrowDirection): string {
    switch (direction) {
        case 'up': return t('terminalWorkspace.keys.up');
        case 'down': return t('terminalWorkspace.keys.down');
        case 'left': return t('terminalWorkspace.keys.left');
        case 'right': return t('terminalWorkspace.keys.right');
    }
}

type Press = { x: number; y: number; pageX: number; pageY: number; cancelled: boolean; lifted: boolean; timer: ReturnType<typeof setTimeout> | null };

/**
 * The phone terminal's floating arrow pad (terminal lab P1, round 2b). A short press sends the arrow
 * whose diagonal wedge it landed in; press and hold, then drag anywhere on it, moves it. On release it
 * lands on the nearest side at the height it was let go, or tucks into a dot past a side edge; a tap
 * on the dot brings it back. It overlays the terminal and never changes the PTY's columns. Where it
 * rests is device-local, per orientation.
 */
export const TerminalArrowPad = React.memo(function TerminalArrowPad(props: Readonly<{
    area: ArrowPadArea;
    onArrow: (direction: TerminalArrowDirection) => void;
    cursorRow?: EmbeddedTerminalCursorRow | null;
    testIdPrefix?: string | null;
}>) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const reducedMotion = useReducedMotionPreference();
    const window = useWindowDimensions();
    const orientation = window.width > window.height ? 'landscape' : 'portrait';
    const placement = useTerminalArrowPadPlacement(orientation);
    const savePlacement = React.useCallback((next: ArrowPadPlacement) => {
        writeTerminalArrowPadPlacement(orientation, next);
    }, [orientation]);

    const translateX = React.useRef(new Animated.Value(0)).current;
    const translateY = React.useRef(new Animated.Value(0)).current;
    const setTranslate = React.useCallback((x: number, y: number) => {
        translateX.setValue(x);
        translateY.setValue(y);
    }, [translateX, translateY]);
    const appear = React.useRef(new Animated.Value(1)).current;
    const dimmedAppear = React.useMemo(() => Animated.multiply(appear, 0.3), [appear]);
    const [lifted, setLifted] = React.useState(false);
    const press = React.useRef<Press | null>(null);
    const latest = React.useRef({ props, placement, savePlacement, reducedMotion });
    latest.current = { props, placement, savePlacement, reducedMotion };
    React.useEffect(() => () => { if (press.current?.timer) clearTimeout(press.current.timer); }, []);

    const fadeIn = React.useCallback(() => {
        if (latest.current.reducedMotion) { appear.setValue(1); return; }
        appear.setValue(0);
        Animated.timing(appear, { toValue: 1, duration: 180, easing: Easing.out(Easing.cubic), useNativeDriver: false }).start();
    }, [appear]);

    const onGrant = React.useCallback((event: GestureResponderEvent) => {
        const { locationX, locationY, pageX, pageY } = event.nativeEvent;
        const current: Press = { x: locationX, y: locationY, pageX, pageY, cancelled: false, lifted: false, timer: null };
        current.timer = setTimeout(() => {
            current.timer = null;
            if (current.cancelled) return;
            current.lifted = true;
            setLifted(true);
            void hapticsLight();
        }, M.holdToMoveMs);
        press.current = current;
    }, []);

    const onMove = React.useCallback((event: GestureResponderEvent) => {
        const current = press.current;
        if (!current) return;
        const dx = event.nativeEvent.pageX - current.pageX;
        const dy = event.nativeEvent.pageY - current.pageY;
        if (current.lifted) {
            setTranslate(dx, dy);
        } else if (!current.cancelled && Math.hypot(dx, dy) > M.pressSlopPx) {
            current.cancelled = true;
            if (current.timer) clearTimeout(current.timer);
        }
    }, [setTranslate]);

    const onRelease = React.useCallback((event: GestureResponderEvent) => {
        const current = press.current;
        press.current = null;
        if (!current) return;
        if (current.timer) clearTimeout(current.timer);
        const { props: latestProps, placement: latestPlacement } = latest.current;
        if (current.lifted) {
            const start = resolveArrowPadCenter(latestPlacement, latestProps.area);
            const dropped = { x: start.x + event.nativeEvent.pageX - current.pageX, y: start.y + event.nativeEvent.pageY - current.pageY };
            const next = resolveArrowPadRelease(dropped, latestProps.area);
            latest.current.savePlacement(next);
            setLifted(false);
            if (next.tucked) {
                setTranslate(0, 0);
                fadeIn();
                return;
            }
            // Settle from where it was let go onto its new resting place.
            const landed = resolveArrowPadCenter(next, latestProps.area);
            setTranslate(dropped.x - landed.x, dropped.y - landed.y);
            if (latest.current.reducedMotion) setTranslate(0, 0);
            else {
                const settle = { toValue: 0, duration: 180, easing: Easing.out(Easing.cubic), useNativeDriver: false };
                Animated.parallel([Animated.timing(translateX, settle), Animated.timing(translateY, settle)]).start();
            }
            return;
        }
        if (!current.cancelled) latestProps.onArrow(resolveArrowPadDirection(current.x, current.y));
    }, [fadeIn, setTranslate, translateX, translateY]);

    const onTerminate = React.useCallback(() => {
        const current = press.current;
        press.current = null;
        if (current?.timer) clearTimeout(current.timer);
        if (current?.lifted) {
            setLifted(false);
            setTranslate(0, 0);
        }
    }, [setTranslate]);

    const restore = React.useCallback(() => {
        if (!placement) return;
        savePlacement({ ...placement, tucked: false });
        fadeIn();
    }, [fadeIn, placement, savePlacement]);

    if (props.area.width <= 0 || props.area.height <= 0) return null;
    const keyFill = resolveThemeColor(theme.dark ? theme.colors.surface.elevated : theme.colors.surface.base).alpha(theme.dark ? 0.6 : 0.56).rgb().string();
    const testId = (suffix: string) => (props.testIdPrefix ? `${props.testIdPrefix}-${suffix}` : undefined);

    if (placement?.tucked) {
        const dot = resolveArrowPadDotCenter(placement, props.area);
        return (
            <Animated.View pointerEvents="box-none" style={[styles.dotHost, { left: dot.x - M.dotHitPx / 2, top: dot.y - M.dotHitPx / 2, opacity: appear }]}>
                <Pressable
                    testID={testId('arrow-pad-dot')}
                    accessibilityRole="button"
                    accessibilityLabel={t('terminalWorkspace.keys.dpadTuckedA11y')}
                    onPress={restore}
                    style={styles.dotHit}
                >
                    <View style={[styles.dot, { backgroundColor: keyFill }]}>
                        <Icon name="arrows-out-cardinal" size={ICON_SIZE.xs} color={theme.colors.text.secondary} />
                    </View>
                </Pressable>
            </Animated.View>
        );
    }

    const center = resolveArrowPadCenter(placement, props.area);
    return (
        <Animated.View
            testID={testId('arrow-pad')}
            accessibilityRole="none"
            accessibilityLabel={t('terminalWorkspace.keys.dpadA11y')}
            onStartShouldSetResponderCapture={() => true}
            onMoveShouldSetResponderCapture={() => press.current !== null}
            onResponderGrant={onGrant}
            onResponderMove={onMove}
            onResponderRelease={onRelease}
            onResponderTerminate={onTerminate}
            onResponderTerminationRequest={() => !press.current?.lifted}
            style={[
                styles.touch,
                {
                    left: center.x - M.touchPx / 2,
                    top: center.y - M.touchPx / 2,
                    opacity: lifted || !resolveArrowPadCursorOverlap(center, props.cursorRow ?? null) ? appear : dimmedAppear,
                    transform: [{ translateX }, { translateY }, { scale: lifted ? 1.08 : 1 }],
                },
            ]}
        >
            <View style={styles.cross} pointerEvents="box-none">
                {KEYS.map((key) => (
                    <Pressable
                        key={key.direction}
                        testID={testId(`arrow-pad-${key.direction}`)}
                        accessibilityRole="button"
                        accessibilityLabel={arrowLabel(key.direction)}
                        onPress={() => props.onArrow(key.direction)}
                        style={[styles.key, lifted ? styles.keyLifted : null, { left: key.left, top: key.top, backgroundColor: keyFill }]}
                    >
                        <Icon name={key.icon} size={ICON_SIZE.xs} color={theme.colors.text.primary} weight="bold" />
                    </Pressable>
                ))}
            </View>
        </Animated.View>
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    touch: {
        position: 'absolute',
        width: M.touchPx,
        height: M.touchPx,
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 3,
    },
    cross: {
        width: M.crossPx,
        height: M.crossPx,
    },
    key: {
        position: 'absolute',
        width: M.keyPx,
        height: M.keyPx,
        borderRadius: 8,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.strong,
        ...shadowLevelStyle(theme.colors.shadowLevels[1]),
    },
    keyLifted: {
        ...shadowLevelStyle(theme.colors.shadowLevels[2]),
    },
    dotHost: {
        position: 'absolute',
        width: M.dotHitPx,
        height: M.dotHitPx,
        zIndex: 3,
    },
    dotHit: {
        width: M.dotHitPx,
        height: M.dotHitPx,
        alignItems: 'center',
        justifyContent: 'center',
    },
    dot: {
        width: M.dotPx,
        height: M.dotPx,
        borderRadius: M.dotPx / 2,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.strong,
        ...shadowLevelStyle(theme.colors.shadowLevels[1]),
    },
}));
