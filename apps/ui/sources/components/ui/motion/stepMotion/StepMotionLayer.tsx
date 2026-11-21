import * as React from 'react';
import { Animated, Easing, Platform, View, type GestureResponderEvent, type LayoutChangeEvent, type StyleProp, type ViewStyle } from 'react-native';

import { restoreFocusToBestTarget, type FocusReturnTarget } from '@/keyboard/focusReturn';

import { motionTokens } from '../motionTokens';
import { findNativeStepAnchor } from './capturePressedElement.native';
import { findWebStepAnchor } from './capturePressedElement.web';
import { StepEntranceBodyContext } from './StepEntranceBody';
import { runStepMove, useStepMotionStage } from './StepMotionStage';
import { stepEntranceFrames } from './stepMotionChoreography';
import type { StepMotionLayerHandle } from './stepMotionTypes';
import { StepFocalContext } from './useStepFocal';

export type StepMotionLayerProps = React.PropsWithChildren<Readonly<{
    layerKey: string;
    stepKey?: string | number;
    active?: boolean;
    compact?: boolean;
    testID?: string;
    backTestID?: string;
    webChrome?: StepMotionLayerHandle['webChrome'];
    retainContent?: boolean;
    warmOnMount?: boolean;
    shareFocalWithParent?: boolean;
    style?: StyleProp<ViewStyle>;
    onLayout?: (event: LayoutChangeEvent) => void;
}>>;

export const FIRST_RUN_WORKFLOW_LAYER = 'workflow';
const MotionLayerContext = React.createContext<Readonly<{ active: boolean; firstRun: boolean }> | null>(null);

export function useFirstRunWorkflowMotion() {
    return React.useContext(MotionLayerContext)?.firstRun === true;
}

export function useFirstRunRouteMove() {
    const firstRun = useFirstRunWorkflowMotion();
    return React.useCallback(<T,>(commit: () => T): T => firstRun
        ? runStepMove({ layer: FIRST_RUN_WORKFLOW_LAYER, kind: 'step', commit })
        : commit(), [firstRun]);
}

function focusStepTarget(target: FocusReturnTarget, fallback?: FocusReturnTarget) {
    if (Platform.OS === 'web' && typeof HTMLElement !== 'undefined' && target instanceof HTMLElement && !target.hasAttribute('tabindex')) {
        target.tabIndex = -1;
    }
    restoreFocusToBestTarget({ current: target }, { current: fallback });
}

export function StepMotionLayer(props: StepMotionLayerProps) {
    const stage = useStepMotionStage();
    const parent = React.useContext(MotionLayerContext);
    const active = parent?.active !== false && props.active !== false;
    const firstRun = parent?.firstRun === true || props.layerKey === FIRST_RUN_WORKFLOW_LAYER;
    const scope = React.useMemo(() => ({ active, firstRun }), [active, firstRun]);
    const wasActive = React.useRef(active);
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
    const parentEntranceBody = React.useContext(StepEntranceBodyContext);
    const [fadeOpacity] = React.useState(() => new Animated.Value(1));
    const [surfaceOpacity, setSurfaceOpacity] = React.useState<Animated.Value | Animated.AnimatedInterpolation<number>>(fadeOpacity);
    const entrance = React.useMemo(() => {
        const clock = new Animated.Value(1);
        const interpolate = (outputRange: number[]) => clock.interpolate({ inputRange: stepEntranceFrames.map(frame => frame.progress), outputRange });
        return {
            clock,
            opacity: interpolate(stepEntranceFrames.map(frame => frame.opacity)),
            translateY: interpolate(stepEntranceFrames.map(frame => frame.translateY)),
            body: { targets: new Set<HTMLElement>(), opacity: interpolate(stepEntranceFrames.map(frame => frame.bodyOpacity)) },
        };
    }, []);
    const entranceBody = React.useMemo(() => props.shareFocalWithParent && parentEntranceBody ? {
        targets: [entrance.body.targets, ...parentEntranceBody.targets],
        opacity: Animated.multiply(entrance.body.opacity, parentEntranceBody.opacity),
    } : { targets: [entrance.body.targets], opacity: entrance.body.opacity }, [entrance.body, parentEntranceBody, props.shareFocalWithParent]);
    const webElement = React.useCallback(() => {
        if (Platform.OS === 'web' && typeof HTMLElement !== 'undefined' && root.current instanceof HTMLElement) return root.current;
        return null;
    }, []);
    const { layerKey, backTestID, compact = false, warmOnMount = true, webChrome } = props;
    const layer = React.useMemo<StepMotionLayerHandle>(() => ({
        key: layerKey,
        backTestID,
        compact,
        warmOnMount,
        webElement,
        webChrome,
        nativeElement: () => root.current,
        focal(returnTo) {
            const web = webElement();
            const preferred = returnTo ? web
                ? findWebStepAnchor(web, returnTo) ?? webChrome?.().map(region => findWebStepAnchor(region, returnTo)).find(Boolean)
                : findNativeStepAnchor(root.current, returnTo) : null;
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
        fadeIn(onSettled, rise, duration = motionTokens.stepMotion.noticeCrossFadeMs) {
            const web = webElement();
            if (web?.animate) {
                const frames = rise
                    ? stepEntranceFrames.map(({ opacity, translateY }) => ({ opacity, transform: `translateY(${translateY}px)` }))
                    : [{ opacity: 0 }, { opacity: 1 }];
                const animation = web.animate(frames, { duration });
                const bodyAnimations = rise ? [...entrance.body.targets].map(body =>
                    body.animate(stepEntranceFrames.map(({ bodyOpacity }) => ({ opacity: bodyOpacity })), { duration })) : [];
                animation.onfinish = onSettled;
                return () => {
                    animation.onfinish = null;
                    animation.cancel();
                    for (const body of bodyAnimations) body.cancel();
                };
            }
            const clock = rise ? entrance.clock : fadeOpacity;
            clock.setValue(0);
            const animation = Animated.timing(clock, { toValue: 1, duration, easing: rise ? Easing.linear : undefined, useNativeDriver: Platform.OS !== 'web' });
            animation.start(({ finished }) => { if (finished) onSettled(); });
            return () => {
                animation.stop();
                clock.setValue(1);
            };
        },
    }), [layerKey, backTestID, compact, entrance, fadeOpacity, focals, warmOnMount, webChrome, webElement]);
    React.useLayoutEffect(() => active ? stage?.attach(layer) : undefined, [active, stage, layer]);
    React.useLayoutEffect(() => {
        if (active) stage?.commit(layer, !wasActive.current);
        wasActive.current = active;
    }, [active, stage, layer, props.stepKey]);
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
            onLayout={props.onLayout}
            onTouchStart={Platform.OS !== 'web' ? onTouchStart : undefined}
        >
            <MotionLayerContext.Provider value={scope}>
                <StepFocalContext.Provider value={focals}>
                    <StepEntranceBodyContext.Provider value={entranceBody}>
                        {Platform.OS === 'web'
                            ? <React.Fragment key={contentKey}>{props.children}</React.Fragment>
                            : <Animated.View key={contentKey} style={{ flexGrow: 1, opacity: entrance.opacity, transform: [{ translateY: entrance.translateY }] }}
                                onLayout={() => stage?.laidOut?.(layer)}>{props.children}</Animated.View>}
                    </StepEntranceBodyContext.Provider>
                </StepFocalContext.Provider>
            </MotionLayerContext.Provider>
        </Animated.View>
    );
}
