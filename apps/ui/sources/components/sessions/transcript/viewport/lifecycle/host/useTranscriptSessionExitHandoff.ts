import * as React from 'react';
import { AppState, Platform, type AppStateStatus } from 'react-native';

type BrowserLifecycleTarget = Readonly<{
    addEventListener?: (eventName: string, listener: () => void) => void;
    removeEventListener?: (eventName: string, listener: () => void) => void;
}>;

type BrowserLifecycleDocument = BrowserLifecycleTarget & Readonly<{
    visibilityState?: string;
}>;

export type TranscriptSessionExitHandoffDeps = Readonly<{
    commitSessionId(sessionId: string): void;
    exitCurrentSession(options?: Readonly<{ deferEmit?: boolean }>): void;
    revalidateAfterLifecycleResume?: () => void;
    sessionId: string;
}>;

function addBrowserLifecycleListener(
    target: BrowserLifecycleTarget | null,
    eventName: string,
    listener: () => void,
): () => void {
    try {
        target?.addEventListener?.(eventName, listener);
    } catch {
        return () => {};
    }
    return () => {
        try {
            target?.removeEventListener?.(eventName, listener);
        } catch {
            // A terminating page may already have detached its lifecycle target.
        }
    };
}

export function useTranscriptSessionExitHandoff(
    deps: TranscriptSessionExitHandoffDeps,
): void {
    const exitCurrentSessionRef = React.useRef(deps.exitCurrentSession);
    const revalidateAfterLifecycleResumeRef = React.useRef(deps.revalidateAfterLifecycleResume);
    const lifecycleExitedRef = React.useRef(false);
    const trueUnmountIntentRef = React.useRef(false);
    const exitForLifecycle = React.useCallback(() => {
        if (lifecycleExitedRef.current) return;
        lifecycleExitedRef.current = true;
        exitCurrentSessionRef.current({ deferEmit: false });
    }, []);
    const resumeLifecycle = React.useCallback((options?: Readonly<{ revalidateNative?: boolean }>) => {
        const didExit = lifecycleExitedRef.current;
        lifecycleExitedRef.current = false;
        if (didExit && options?.revalidateNative === true) {
            revalidateAfterLifecycleResumeRef.current?.();
        }
    }, []);

    React.useInsertionEffect(() => {
        exitCurrentSessionRef.current = deps.exitCurrentSession;
        revalidateAfterLifecycleResumeRef.current = deps.revalidateAfterLifecycleResume;
    }, [
        deps.exitCurrentSession,
        deps.revalidateAfterLifecycleResume,
    ]);

    React.useInsertionEffect(() => {
        lifecycleExitedRef.current = false;
        trueUnmountIntentRef.current = false;
        deps.commitSessionId(deps.sessionId);
        return () => {
            trueUnmountIntentRef.current = true;
        };
    }, [
        deps.commitSessionId,
        deps.sessionId,
    ]);

    React.useLayoutEffect(() => {
        const documentTarget = (
            typeof document === 'undefined'
                ? null
                : document as unknown as BrowserLifecycleDocument
        );
        const browserTarget = globalThis as unknown as BrowserLifecycleTarget;
        const onVisibilityChange = () => {
            if (documentTarget?.visibilityState === 'hidden') {
                exitForLifecycle();
                return;
            }
            if (documentTarget?.visibilityState === 'visible') {
                resumeLifecycle();
            }
        };
        const dispose = [
            addBrowserLifecycleListener(documentTarget, 'visibilitychange', onVisibilityChange),
            addBrowserLifecycleListener(browserTarget, 'pagehide', exitForLifecycle),
            addBrowserLifecycleListener(browserTarget, 'freeze', exitForLifecycle),
            addBrowserLifecycleListener(browserTarget, 'pageshow', resumeLifecycle),
            addBrowserLifecycleListener(browserTarget, 'resume', resumeLifecycle),
        ];
        return () => {
            for (const removeListener of dispose) {
                removeListener();
            }
        };
    }, [exitForLifecycle, resumeLifecycle]);

    React.useLayoutEffect(() => {
        if (Platform.OS === 'web') return;
        const onAppStateChange = (state: AppStateStatus) => {
            if (state === 'inactive' || state === 'background') {
                exitForLifecycle();
                return;
            }
            if (state === 'active') {
                resumeLifecycle({ revalidateNative: true });
            }
        };
        const subscription = AppState.addEventListener('change', onAppStateChange);
        return () => {
            subscription.remove();
        };
    }, [exitForLifecycle, resumeLifecycle]);

    React.useLayoutEffect(() => {
        return () => {
            if (!trueUnmountIntentRef.current) return;
            if (lifecycleExitedRef.current) return;
            exitCurrentSessionRef.current();
        };
    }, []);
}
