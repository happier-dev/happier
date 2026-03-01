import * as React from 'react';
import { Animated } from 'react-native';

import { motionTokens } from '@/components/ui/motion/motionTokens';

import { useTranscriptMotion } from './TranscriptMotionContext';

export const TranscriptCollapsible = React.memo(function TranscriptCollapsible(props: {
    id: string;
    createdAt: number;
    expanded: boolean;
    children: React.ReactNode;
}) {
    const runtime = useTranscriptMotion();

    const progress = React.useRef(new Animated.Value(props.expanded ? 1 : 0)).current;
    const [shouldRenderChildren, setShouldRenderChildren] = React.useState<boolean>(props.expanded);
    const didMountRef = React.useRef(false);
    const shouldAnimateLastToggleRef = React.useRef(false);

    const animateEnabled =
        runtime?.config.preset !== 'off' &&
        runtime?.config.animateToolExpandCollapseEnabled === true;

    React.useEffect(() => {
        if (!didMountRef.current) {
            didMountRef.current = true;
            return;
        }

        if (!runtime || !animateEnabled) {
            shouldAnimateLastToggleRef.current = false;
            if (props.expanded) {
                setShouldRenderChildren(true);
                progress.setValue(1);
            } else {
                progress.setValue(0);
                setShouldRenderChildren(false);
            }
            return;
        }

        const duration =
            runtime.config.preset === 'full'
                ? motionTokens.durationMs.base
                : motionTokens.durationMs.fast;

        if (props.expanded) {
            setShouldRenderChildren(true);
            const shouldAnimate =
                runtime.config.animateToolExpandCollapseFreshOnly === true
                    ? runtime.gate.consumeFreshness({ id: `expandCollapse:${props.id}`, createdAt: props.createdAt })
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
            progress.setValue(0);
            setShouldRenderChildren(false);
            return;
        }

        Animated.timing(progress, {
            toValue: 0,
            duration,
            easing: motionTokens.easing.standard,
            useNativeDriver: false,
        }).start(({ finished }) => {
            if (finished) setShouldRenderChildren(false);
        });
    }, [animateEnabled, progress, props.createdAt, props.expanded, props.id, runtime]);

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
