import * as React from 'react';
import { Animated } from 'react-native';

import { motionTokens } from '@/components/ui/motion/motionTokens';

export function usePaneAnimatedPresence(input: Readonly<{
    targetOpen: boolean;
    node: React.ReactNode | null;
    durationMs: number;
    useNativeDriver: boolean;
    /** The open motion settled: the pane is drawn where it stands (see `ModalPanePresentationInput.onOpened`). */
    onOpened?: () => void;
}>): Readonly<{
    present: boolean;
    node: React.ReactNode | null;
    progress: Animated.Value;
}> {
    const progress = React.useRef(new Animated.Value(0)).current;
    const nodeRef = React.useRef<React.ReactNode | null>(input.node);
    const [present, setPresent] = React.useState(input.targetOpen);
    const presentRef = React.useRef(present);
    presentRef.current = present;
    const timeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const animationRunIdRef = React.useRef(0);
    const onOpenedRef = React.useRef(input.onOpened);
    onOpenedRef.current = input.onOpened;

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
            setPresent(true);
            Animated.timing(progress, {
                toValue: 1,
                duration: input.durationMs,
                easing: motionTokens.easing.standard,
                useNativeDriver: input.useNativeDriver,
            }).start((result) => {
                if (result?.finished === false) return;
                settleProgress(1, () => onOpenedRef.current?.());
            });
            timeoutRef.current = setTimeout(() => {
                settleProgress(1, () => onOpenedRef.current?.());
            }, settleDurationMs);
            return;
        }

        if (!presentRef.current) return;
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
    // Only opening or closing moves the pane: new content for an open pane (every parent render
    // hands it a new element) and the presence flip itself start no animation.
    }, [input.durationMs, input.targetOpen, input.useNativeDriver, progress]);

    // The content an exit animation keeps showing is the last content the open pane had.
    React.useEffect(() => {
        if (input.targetOpen) nodeRef.current = input.node;
    }, [input.node, input.targetOpen]);

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
        // Open panes show their owner's current content immediately. The retained
        // node is only for the exit animation, when the owner has removed it.
        node: present ? (input.targetOpen ? input.node : nodeRef.current) : null,
        progress,
    };
}
