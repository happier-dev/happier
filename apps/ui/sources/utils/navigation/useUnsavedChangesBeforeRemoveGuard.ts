import { usePreventRemove } from '@react-navigation/native';
import * as React from 'react';
import { useDestinationFocus, useDestinationInstanceKey } from '@/components/appShell/workspace/DestinationInstanceHost';
import { useActiveUnsavedChangesGuard } from './useActiveUnsavedChangesGuard';

import {
    type ActiveUnsavedChangesGuard,
    runUnsavedChangesGuard,
} from '@/utils/navigation/runGuardedNavigation';
import { fireAndForget } from '@/utils/system/fireAndForget';
import type { UnsavedChangesDecision } from '@/utils/ui/promptUnsavedChangesAlert';

export type { UnsavedChangesDecision };

export function useUnsavedChangesBeforeRemoveGuard(params: Readonly<{
    enabled?: boolean;
    ignoreRef?: React.MutableRefObject<boolean>;
    isDirty: boolean;
    isDirtyRef: React.MutableRefObject<boolean>;
    requestDecision: () => Promise<UnsavedChangesDecision>;
    onDiscard?: () => void | Promise<void>;
    onSave?: () => boolean | Promise<boolean>;
    continueOnSave?: boolean;
    onHistoryLeave?: () => void | Promise<void>;
    /** Flush an editor-owned pending value before the dirty decision is read. */
    prepareGuard?: () => void | Promise<void>;
    /** Install the remove interceptor even before React draft state is dirty. */
    interceptWhenClean?: boolean;
    onContinue: (action: unknown) => void;
    tag: string;
}>) {
    const {
        enabled: enabledParam,
        ignoreRef,
        isDirty,
        isDirtyRef,
        requestDecision,
        onDiscard,
        onSave,
        continueOnSave,
        onHistoryLeave,
        prepareGuard,
        interceptWhenClean,
        onContinue,
        tag,
    } = params;
    const enabled = enabledParam ?? true;
    const hosted = useDestinationInstanceKey() !== null;
    const destinationFocused = useDestinationFocus();
    const [pendingContinuation, setPendingContinuation] = React.useState<Readonly<{
        action: unknown;
        resolve: () => void;
        reject: (error: unknown) => void;
    }> | null>(null);
    const guard = React.useMemo<ActiveUnsavedChangesGuard>(() => ({
        isDirtyRef,
        ignoreRef,
        requestDecision,
        prepareGuard,
        onDiscard,
        onSave,
        continueOnSave,
        onHistoryLeave,
        tag,
    }), [
        continueOnSave,
        onHistoryLeave,
        ignoreRef,
        isDirtyRef,
        onDiscard,
        onSave,
        prepareGuard,
        requestDecision,
        tag,
    ]);

    const handlePreventedRemove = React.useCallback((event: Readonly<{
        data: Readonly<{ action: unknown }>;
    }>) => {
        const action = event.data.action;
        fireAndForget(Promise.resolve(runUnsavedChangesGuard(
            guard,
            () => new Promise<void>((resolve, reject) => {
                setPendingContinuation({ action, resolve, reject });
            }),
        )), { tag });
    }, [
        guard,
        tag,
    ]);

    useActiveUnsavedChangesGuard({
        navigation: null,
        guard,
        enabled: destinationFocused && enabled,
    });

    // Ownership is fixed for a mounted body; hosted views are outside the native Stack.
    // eslint-disable-next-line react-hooks/rules-of-hooks
    if (!hosted) usePreventRemove(
        enabled
            && pendingContinuation === null
            && !ignoreRef?.current
            && (isDirty || interceptWhenClean === true),
        handlePreventedRemove,
    );

    React.useEffect(() => {
        if (!pendingContinuation) return;

        // This effect must stay after usePreventRemove so React Navigation commits
        // its disabled removal guard before the action it blocked is redispatched.
        setPendingContinuation(null);
        try {
            onContinue(pendingContinuation.action);
            pendingContinuation.resolve();
        } catch (error) {
            pendingContinuation.reject(error);
        }
    }, [onContinue, pendingContinuation]);

    React.useEffect(() => {
        if (!enabled || ignoreRef?.current || !isDirty) return;
        if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;

        const handleBeforeUnload = (event: BeforeUnloadEvent) => {
            if (ignoreRef?.current || !isDirtyRef.current) return;
            event.preventDefault();
            event.returnValue = '';
        };
        window.addEventListener('beforeunload', handleBeforeUnload);
        return () => window.removeEventListener('beforeunload', handleBeforeUnload);
    }, [enabled, ignoreRef, isDirty, isDirtyRef]);
}
