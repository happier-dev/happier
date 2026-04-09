import * as React from 'react';
import { Animated } from 'react-native';

import { motionTokens } from '@/components/ui/motion/motionTokens';

export function usePaneAnimatedPresence(input: Readonly<{
    targetOpen: boolean;
    node: React.ReactNode | null;
    durationMs: number;
    useNativeDriver: boolean;
}>): Readonly<{
    present: boolean;
    node: React.ReactNode | null;
    progress: Animated.Value;
}> {
    const progress = React.useRef(new Animated.Value(0)).current;
    const nodeRef = React.useRef<React.ReactNode | null>(input.node);
    const [present, setPresent] = React.useState(input.targetOpen);
    const timeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

    React.useEffect(() => {
        if (timeoutRef.current) {
            clearTimeout(timeoutRef.current);
            timeoutRef.current = null;
        }

        if (input.targetOpen) {
            nodeRef.current = input.node;
            setPresent(true);
            Animated.timing(progress, {
                toValue: 1,
                duration: input.durationMs,
                easing: motionTokens.easing.standard,
                useNativeDriver: input.useNativeDriver,
            }).start();
            return;
        }

        if (!present) return;
        Animated.timing(progress, {
            toValue: 0,
            duration: input.durationMs,
            easing: motionTokens.easing.standard,
            useNativeDriver: input.useNativeDriver,
        }).start();
        timeoutRef.current = setTimeout(() => {
            timeoutRef.current = null;
            setPresent(false);
        }, input.durationMs);
    }, [input.durationMs, input.node, input.targetOpen, input.useNativeDriver, present, progress]);

    React.useEffect(() => {
        return () => {
            if (timeoutRef.current) {
                clearTimeout(timeoutRef.current);
            }
        };
    }, []);

    return {
        present,
        node: present ? nodeRef.current : null,
        progress,
    };
}
