import * as React from 'react';
import { Animated, Easing, Platform, View, type GestureResponderEvent, type StyleProp, type ViewStyle } from 'react-native';

import { restoreFocusToBestTarget, type FocusReturnTarget } from '@/keyboard/focusReturn';

import { motionTokens } from '../motionTokens';
import { findNativeStepAnchor } from './capturePressedElement.native';
import { findWebStepAnchor } from './capturePressedElement.web';
import { useStepMotionStage } from './StepMotionStage';
import type { StepMotionLayerHandle } from './stepMotionTypes';
import { StepFocalContext } from './useStepFocal';

export type StepMotionLayerProps = React.PropsWithChildren<Readonly<{
    layerKey: string;
    stepKey?: string | number;
    compact?: boolean;
    testID?: string;
    backTestID?: string;
    retainContent?: boolean;
    warmOnMount?: boolean;
    shareFocalWithParent?: boolean;
    style?: StyleProp<ViewStyle>;
}>>;

function focusStepTarget(target: FocusReturnTarget, fallback?: FocusReturnTarget) {
    if (Platform.OS === 'web' && target instanceof HTMLElement && !target.hasAttribute('tabindex')) target.tabIndex = -1;
    restoreFocusToBestTarget({ current: target }, { current: fallback });
}

export function StepMotionLayer(props: StepMotionLayerProps) {
    const stage = useStepMotionStage();
    const root = React.useRef<View>(null);
    const ownHeading = React.useRef<FocusReturnTarget>(null);
    const ownFocal = React.useRef<FocusReturnTarget>(null);
    const awaitingFocalFrom = React.useRef<HTMLElement | null>(null);
    const registerFocal = React.useCallback((target: FocusReturnTarget) => {
        ownFocal.current = target;
        if (!target || !awaitingFocalFrom.current) return;
        const previous = awaitingFocalFrom.current;
        awaitingFocalFrom.current = null;
        if (previous.ownerDocument.activeElement === previous) focusStepTarget(target, previous);
    }, []);
    const ownFocals = React.useMemo(() => ({ heading: ownHeading, focal: ownFocal, awaitingFocalFrom, registerFocal }), [registerFocal]);
    const parentFocals = React.useContext(StepFocalContext);
    const focals = props.shareFocalWithParent && parentFocals ? parentFocals : ownFocals;
    const [fadeOpacity] = React.useState(() => new Animated.Value(1));
    const [surfaceOpacity, setSurfaceOpacity] = React.useState<Animated.Value | Animated.AnimatedInterpolation<number>>(fadeOpacity);
    const webElement = React.useCallback(() => {
        if (Platform.OS === 'web' && typeof HTMLElement !== 'undefined' && root.current instanceof HTMLElement) return root.current;
        return null;
    }, []);
    const { layerKey, backTestID, compact = false, warmOnMount = true } = props;
    const layer = React.useMemo<StepMotionLayerHandle>(() => ({
        key: layerKey,
        backTestID,
        compact,
        warmOnMount,
        webElement,
        nativeElement: () => root.current,
        focal(returnTo) {
            const web = webElement();
            const preferred = returnTo ? web ? findWebStepAnchor(web, returnTo) : findNativeStepAnchor(root.current, returnTo) : null;
            return preferred ?? focals.focal.current ?? focals.heading.current ?? web?.querySelector<HTMLElement>('[role="heading"], h1, h2');
        },
        focus(returnTo, allowLateFocal) {
            const web = webElement();
            const target = this.focal(returnTo);
            // A late QR can take over the heading while it still owns browser focus.
            focals.awaitingFocalFrom.current = allowLateFocal && web && !focals.focal.current && target instanceof HTMLElement
                ? target : null;
            focusStepTarget(target, this.focal());
        },
        paintOpacity(values, durationMs, delayMs) {
            const web = webElement();
            if (web?.animate) {
                const animation = web.animate(values.map(opacity => ({ opacity })), { duration: durationMs, delay: delayMs, fill: 'both' });
                return () => animation.cancel();
            }
            const progress = new Animated.Value(0);
            setSurfaceOpacity(progress.interpolate({
                inputRange: values.map((_, index) => index / (values.length - 1)),
                outputRange: [...values],
            }));
            const animation = Animated.timing(progress, { toValue: 1, duration: durationMs, delay: delayMs, easing: Easing.linear, useNativeDriver: true });
            animation.start();
            return () => {
                animation.stop();
                progress.setValue(1);
                setSurfaceOpacity(fadeOpacity);
            };
        },
        fadeIn(onSettled) {
            const duration = motionTokens.stepMotion.noticeCrossFadeMs;
            const web = webElement();
            if (web?.animate) {
                const animation = web.animate([{ opacity: 0 }, { opacity: 1 }], { duration });
                animation.onfinish = onSettled;
                return () => { animation.onfinish = null; animation.cancel(); };
            }
            fadeOpacity.setValue(0);
            const animation = Animated.timing(fadeOpacity, { toValue: 1, duration, useNativeDriver: Platform.OS !== 'web' });
            animation.start(({ finished }) => { if (finished) onSettled(); });
            return () => { animation.stop(); fadeOpacity.setValue(1); };
        },
    }), [layerKey, backTestID, compact, fadeOpacity, focals, warmOnMount, webElement]);
    React.useLayoutEffect(() => stage?.attach(layer), [stage, layer]);
    React.useLayoutEffect(() => { stage?.commit(layer); }, [stage, layer, props.stepKey]);
    const onTouchStart = React.useCallback((event: GestureResponderEvent) => {
        if (root.current) stage?.nativeTouch(event, root.current);
    }, [stage]);
    const contentKey = props.retainContent ? undefined : props.stepKey;
    return (
        <Animated.View
            ref={root}
            collapsable={false}
            style={[props.style, { opacity: surfaceOpacity }]}
            testID={props.testID}
            onTouchStart={Platform.OS !== 'web' ? onTouchStart : undefined}
        >
            <StepFocalContext.Provider value={focals}>
                {Platform.OS === 'web'
                    ? <React.Fragment key={contentKey}>{props.children}</React.Fragment>
                    : <View key={contentKey} style={{ flexGrow: 1 }} onLayout={() => stage?.laidOut?.(layer)}>{props.children}</View>}
            </StepFocalContext.Provider>
        </Animated.View>
    );
}
