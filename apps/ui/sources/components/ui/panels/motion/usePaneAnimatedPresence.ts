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
    const animationRunIdRef = React.useRef(0);

    React.useEffect(() => {
        if (timeoutRef.current) {
            clearTimeout(timeoutRef.current);
            timeoutRef.current = null;
        }

        const runId = animationRunIdRef.current + 1;
        animationRunIdRef.current = runId;
        const settleDurationMs = Math.max(0, input.durationMs);
        const settleProgress = (value: number, onSettled?: () => void) => {
            if (animationRunIdRef.current !== runId) return;
            if (timeoutRef.current) {
                clearTimeout(timeoutRef.current);
                timeoutRef.current = null;
            }
            progress.setValue(value);
            onSettled?.();
        };

        if (input.targetOpen) {
            nodeRef.current = input.node;
            setPresent(true);
            Animated.timing(progress, {
                toValue: 1,
                duration: input.durationMs,
                easing: motionTokens.easing.standard,
                useNativeDriver: input.useNativeDriver,
            }).start((result) => {
                if (result?.finished === false) return;
                settleProgress(1);
            });
            timeoutRef.current = setTimeout(() => {
                settleProgress(1);
            }, settleDurationMs);
            return;
        }

        if (!present) return;
        Animated.timing(progress, {
            toValue: 0,
            duration: input.durationMs,
            easing: motionTokens.easing.standard,
            useNativeDriver: input.useNativeDriver,
        }).start((result) => {
            if (result?.finished === false) return;
            settleProgress(0, () => {
                setPresent(false);
            });
        });
        timeoutRef.current = setTimeout(() => {
            settleProgress(0, () => {
                setPresent(false);
            });
        }, settleDurationMs);
    }, [input.durationMs, input.node, input.targetOpen, input.useNativeDriver, present, progress]);

    React.useEffect(() => {
        return () => {
            animationRunIdRef.current += 1;
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
