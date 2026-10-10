import * as React from 'react';
import { Animated, PanResponder, View, type LayoutChangeEvent } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { motionTokens } from '@/components/ui/motion/motionTokens';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { t } from '@/text';

/**
 * Drag to dismiss for the app's bottom sheet (`BaseModal placement="bottom"` + `ModalCardFrame
 * presentation="sheet"`). The modal that can close itself provides the dismissal; the sheet frame
 * draws the grabber and follows the finger only when one is provided, so a grabber always means the
 * gesture works. Escape, the scrim and Back keep closing it as before.
 */
const SheetDismissContext = React.createContext<(() => void) | null>(null);

export function SheetDismissProvider(props: Readonly<{ onDismiss: (() => void) | null; children: React.ReactNode }>): React.ReactElement {
    return <SheetDismissContext.Provider value={props.onDismiss}>{props.children}</SheetDismissContext.Provider>;
}

export function useSheetDismiss(): (() => void) | null {
    return React.useContext(SheetDismissContext);
}

/**
 * The perception thresholds of a dragged sheet, in the platform sheet convention: past a third of
 * its own height it is meant to go; a deliberate downward flick (px/ms, as PanResponder reports it)
 * closes a shorter drag. Below both it settles back where it was.
 */
const DISMISS_FRACTION = 1 / 3;
const FLING_VELOCITY_PX_PER_MS = 0.5;

export function resolveSheetDragRelease(input: Readonly<{ translationY: number; velocityY: number; sheetHeightPx: number }>): 'dismiss' | 'settle' {
    if (input.translationY <= 0 || input.velocityY < 0) return 'settle';
    if (input.velocityY >= FLING_VELOCITY_PX_PER_MS) return 'dismiss';
    return input.translationY > input.sheetHeightPx * DISMISS_FRACTION ? 'dismiss' : 'settle';
}

/**
 * The sheet's drag: the offset that moves the frame, the grabber's handlers and its layout probe.
 * The finger moves the sheet directly; a settle springs back (a cut under reduced motion) and a
 * dismiss hands over to the modal's own exit.
 */
export function useSheetDrag(onDismiss: (() => void) | null) {
    const reducedMotion = useReducedMotionPreference();
    const offset = React.useRef(new Animated.Value(0)).current;
    const height = React.useRef(0);
    const onLayout = React.useCallback((event: LayoutChangeEvent) => { height.current = event.nativeEvent.layout.height; }, []);
    const handlers = React.useMemo(() => PanResponder.create({
        onStartShouldSetPanResponder: () => onDismiss !== null,
        onMoveShouldSetPanResponder: (_event, gesture) => onDismiss !== null && Math.abs(gesture.dy) > Math.abs(gesture.dx),
        onPanResponderMove: (_event, gesture) => { offset.setValue(Math.max(0, gesture.dy)); },
        onPanResponderRelease: (_event, gesture) => {
            const release = resolveSheetDragRelease({ translationY: gesture.dy, velocityY: gesture.vy, sheetHeightPx: height.current });
            if (release === 'dismiss' && onDismiss) {
                onDismiss();
                return;
            }
            if (reducedMotion) offset.setValue(0);
            else Animated.timing(offset, { toValue: 0, duration: motionTokens.durationMs.fast, useNativeDriver: false }).start();
        },
        onPanResponderTerminate: () => { offset.setValue(0); },
    }), [offset, onDismiss, reducedMotion]);
    return { offset, panHandlers: handlers.panHandlers, onLayout };
}

/** The grabber at the top of a dismissible sheet: where the drag starts, and its accessible close. */
export function SheetGrabber(props: Readonly<{
    onDismiss: () => void;
    panHandlers: ReturnType<typeof PanResponder.create>['panHandlers'];
    testID?: string;
}>): React.ReactElement {
    return (
        <View
            testID={props.testID}
            style={styles.zone}
            accessible
            accessibilityRole="button"
            accessibilityLabel={t('common.close')}
            accessibilityActions={[{ name: 'activate', label: t('common.close') }]}
            onAccessibilityAction={(event) => { if (event.nativeEvent.actionName === 'activate') props.onDismiss(); }}
            {...props.panHandlers}
        >
            <View style={styles.grabber} />
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    zone: { alignSelf: 'stretch', alignItems: 'center', paddingTop: 8, paddingBottom: 4 },
    grabber: { width: 36, height: 5, borderRadius: 2.5, backgroundColor: theme.colors.border.strong },
}));
