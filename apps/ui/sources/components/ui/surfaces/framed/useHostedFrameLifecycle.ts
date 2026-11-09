import * as React from 'react';

export type HostedFrameFailure =
    | 'guest_error'
    | 'load_failed'
    | 'unexpected_navigation';

export type HostedFrameRetirementReason = HostedFrameFailure | 'reload' | 'replaced' | 'retired' | 'unmount';

type HostedFrameLifecycleState = Readonly<{
    lifetimeKey: string;
    attempt: number;
    loaded: boolean;
    ready: boolean;
    failure: HostedFrameFailure | null;
}>;

/** One source-neutral frame attempt lifecycle shared by installed and caller adapters. */
export function useHostedFrameLifecycle(input: Readonly<{
    lifetimeKey: string;
    onRetireAttempt?: (reason: HostedFrameRetirementReason) => void;
}>) {
    const [state, setState] = React.useState<HostedFrameLifecycleState>(() => ({
        lifetimeKey: input.lifetimeKey,
        attempt: 0,
        loaded: false,
        ready: false,
        failure: null,
    }));
    const onRetireAttemptRef = React.useRef(input.onRetireAttempt);
    onRetireAttemptRef.current = input.onRetireAttempt;
    const renderedState = state.lifetimeKey === input.lifetimeKey
        ? state
        : { lifetimeKey: input.lifetimeKey, attempt: 0, loaded: false, ready: false, failure: null };
    if (renderedState !== state) setState(renderedState);
    const attemptKey = `${renderedState.lifetimeKey}\u001f${renderedState.attempt}`;
    const activeAttemptKeyRef = React.useRef(attemptKey);
    activeAttemptKeyRef.current = attemptKey;
    const retiredAttemptKeyRef = React.useRef<string | null>(null);
    const retireAttempt = React.useCallback((key: string, reason: HostedFrameRetirementReason) => {
        if (retiredAttemptKeyRef.current === key) return false;
        retiredAttemptKeyRef.current = key;
        onRetireAttemptRef.current?.(reason);
        return true;
    }, []);
    const retireIfCurrent = React.useCallback((key: string, reason: HostedFrameRetirementReason) => (
        activeAttemptKeyRef.current === key && retireAttempt(key, reason)
    ), [retireAttempt]);
    const committedAttemptKeyRef = React.useRef(attemptKey);

    React.useLayoutEffect(() => {
        const previousAttemptKey = committedAttemptKeyRef.current;
        committedAttemptKeyRef.current = attemptKey;
        if (previousAttemptKey !== attemptKey) retireAttempt(previousAttemptKey, 'replaced');
    }, [attemptKey, retireAttempt]);

    React.useLayoutEffect(() => () => {
        const key = activeAttemptKeyRef.current;
        if (retiredAttemptKeyRef.current === key) return;
        retiredAttemptKeyRef.current = key;
        onRetireAttemptRef.current?.('unmount');
    }, []);

    const fail = React.useCallback((reason: HostedFrameFailure) => {
        if (!retireIfCurrent(attemptKey, reason)) return;
        setState((current) => current.lifetimeKey === renderedState.lifetimeKey && current.attempt === renderedState.attempt
            ? { ...current, failure: current.failure ?? reason }
            : current);
    }, [attemptKey, renderedState.attempt, renderedState.lifetimeKey, retireIfCurrent]);
    const reload = React.useCallback(() => {
        if (activeAttemptKeyRef.current !== attemptKey) return;
        retireIfCurrent(attemptKey, 'reload');
        setState((current) => current.lifetimeKey === renderedState.lifetimeKey && current.attempt === renderedState.attempt
            ? { ...current, attempt: current.attempt + 1, loaded: false, ready: false, failure: null }
            : current);
    }, [attemptKey, renderedState.attempt, renderedState.lifetimeKey, retireIfCurrent]);
    const retire = React.useCallback(() => {
        retireAttempt(attemptKey, 'retired');
    }, [attemptKey, retireAttempt]);
    const markLoaded = React.useCallback(() => {
        setState((current) => current.lifetimeKey === renderedState.lifetimeKey && current.attempt === renderedState.attempt
            && current.failure === null ? { ...current, loaded: true } : current);
    }, [renderedState.attempt, renderedState.lifetimeKey]);
    const markReady = React.useCallback(() => {
        setState((current) => current.lifetimeKey === renderedState.lifetimeKey && current.attempt === renderedState.attempt
            && current.failure === null ? { ...current, ready: true } : current);
    }, [renderedState.attempt, renderedState.lifetimeKey]);

    return Object.freeze({
        attempt: renderedState.attempt,
        loaded: renderedState.loaded,
        ready: renderedState.ready,
        failure: renderedState.failure,
        fail,
        reload,
        retire,
        markLoaded,
        markReady,
    });
}
