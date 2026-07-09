import * as React from 'react';
import { Animated } from 'react-native';

import { motionTokens } from '@/components/ui/motion/motionTokens';
import { useTranscriptRowLayoutMutation } from '@/components/sessions/transcript/measurement/TranscriptRowLayoutMutationContext';

import { useTranscriptMotion } from './TranscriptMotionContext';

export const TranscriptCollapsible = React.memo(function TranscriptCollapsible(props: {
    id: string;
    createdAt: number;
    expanded: boolean;
    children: React.ReactNode;
}) {
    const runtime = useTranscriptMotion();
    const notifyRowLayoutMutation = useTranscriptRowLayoutMutation();

    const progress = React.useRef(new Animated.Value(props.expanded ? 1 : 0)).current;
    const [shouldRenderChildren, setShouldRenderChildren] = React.useState<boolean>(props.expanded);
    const didMountRef = React.useRef(false);
    const shouldAnimateLastToggleRef = React.useRef(false);
    const latestRuntimeRef = React.useRef(runtime);
    const latestNotifyRowLayoutMutationRef = React.useRef(notifyRowLayoutMutation);
    const latestCreatedAtRef = React.useRef(props.createdAt);
    const latestIdRef = React.useRef(props.id);

    const animateEnabled =
        runtime?.config.preset !== 'off' &&
        runtime?.config.animateToolExpandCollapseEnabled === true;
    const latestAnimateEnabledRef = React.useRef(animateEnabled);

    latestRuntimeRef.current = runtime;
    latestNotifyRowLayoutMutationRef.current = notifyRowLayoutMutation;
    latestAnimateEnabledRef.current = animateEnabled;
    latestCreatedAtRef.current = props.createdAt;
    latestIdRef.current = props.id;

    React.useLayoutEffect(() => {
        if (!didMountRef.current) {
            didMountRef.current = true;
            return;
        }

        const currentRuntime = latestRuntimeRef.current;
        const currentAnimateEnabled = latestAnimateEnabledRef.current;
        const notifyCurrentRowLayoutMutation = latestNotifyRowLayoutMutationRef.current;
        const currentId = latestIdRef.current;

        if (!currentRuntime || !currentAnimateEnabled) {
            shouldAnimateLastToggleRef.current = false;
            if (props.expanded) {
                notifyCurrentRowLayoutMutation({ reason: 'expand', sourceId: currentId });
                setShouldRenderChildren(true);
                progress.setValue(1);
            } else {
                notifyCurrentRowLayoutMutation({ reason: 'collapse', sourceId: currentId });
                progress.setValue(0);
                setShouldRenderChildren(false);
            }
            return;
        }

        const duration =
            currentRuntime.config.preset === 'full'
                ? motionTokens.durationMs.base
                : motionTokens.durationMs.fast;

        if (props.expanded) {
            notifyCurrentRowLayoutMutation({ reason: 'expand', sourceId: currentId });
            setShouldRenderChildren(true);
            const shouldAnimate =
                currentRuntime.config.animateToolExpandCollapseFreshOnly === true
                    ? currentRuntime.gate.consumeFreshness({
                        id: `expandCollapse:${currentId}`,
                        createdAt: latestCreatedAtRef.current,
                    })
                    : true;
            shouldAnimateLastToggleRef.current = shouldAnimate;
            if (!shouldAnimate) {
                progress.setValue(1);
                return;
            }
            Animated.timing(progress, {
                toValue: 1,
                duration,
                easing: motionTokens.easing.standard,
                useNativeDriver: false,
            }).start();
            return;
        }

        const shouldAnimate = shouldAnimateLastToggleRef.current === true;
        shouldAnimateLastToggleRef.current = false;
        if (!shouldAnimate) {
            notifyCurrentRowLayoutMutation({ reason: 'collapse', sourceId: currentId });
            progress.setValue(0);
            setShouldRenderChildren(false);
            return;
        }

        notifyCurrentRowLayoutMutation({ reason: 'collapse', sourceId: currentId });
        Animated.timing(progress, {
            toValue: 0,
            duration,
            easing: motionTokens.easing.standard,
            useNativeDriver: false,
        }).start(({ finished }) => {
            if (finished) setShouldRenderChildren(false);
        });
    }, [progress, props.expanded]);

    const maxHeight = progress.interpolate({ inputRange: [0, 1], outputRange: [0, 10_000] });
    const opacity = progress.interpolate({ inputRange: [0, 0.3, 1], outputRange: [0, 0.6, 1] });
    const translateY = progress.interpolate({ inputRange: [0, 1], outputRange: [-2, 0] });

    return (
        <Animated.View
            style={{
                overflow: 'hidden',
                maxHeight,
                opacity,
                transform: [{ translateY }],
            }}
            pointerEvents={props.expanded ? 'auto' : 'none'}
        >
            {shouldRenderChildren ? props.children : null}
        </Animated.View>
    );
});
