import * as React from 'react';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { useHostActivelyViewed } from '@/utils/runtime/useHostActivelyViewed';

import {
    ENROLLMENT_POLL_IDLE_DELAY_MS,
    enrollmentPollingBackoffMs,
} from '@/auth/enrollment/enrollmentPollingBackoff';
import {
    isRuntimeActive,
    subscribeToRuntimeActiveChange,
} from '@/utils/runtime/isRuntimeActive';

export type AccountDirectoryActivePollingOutcome = 'completed' | 'backoff';
type PollingCallback = () =>
    | AccountDirectoryActivePollingOutcome
    | Promise<AccountDirectoryActivePollingOutcome>;

const callbacks = new Set<PollingCallback>();
let pollingTimeout: ReturnType<typeof setTimeout> | null = null;
let stopListening: (() => void) | null = null;
let pollDueAtMs = 0;
let backoffAttemptCount = 0;
let pollRunning = false;

function stopScheduler(): void {
    if (pollingTimeout) clearTimeout(pollingTimeout);
    pollingTimeout = null;
    stopListening?.();
    stopListening = null;
    pollDueAtMs = 0;
    backoffAttemptCount = 0;
}

function nextDelayMs(): number {
    return backoffAttemptCount === 0
        ? ENROLLMENT_POLL_IDLE_DELAY_MS
        : enrollmentPollingBackoffMs(backoffAttemptCount);
}

function schedulePolling(delayMs = nextDelayMs()): void {
    if (callbacks.size === 0 || pollRunning || !isRuntimeActive()) return;
    if (pollingTimeout) clearTimeout(pollingTimeout);
    const boundedDelayMs = Math.max(0, Math.trunc(delayMs));
    pollDueAtMs = Date.now() + boundedDelayMs;
    pollingTimeout = setTimeout(() => {
        pollingTimeout = null;
        if (isRuntimeActive()) void runPollingCallbacks();
    }, boundedDelayMs);
}

async function runPollingCallbacks(): Promise<void> {
    if (pollRunning || callbacks.size === 0 || !isRuntimeActive()) return;
    pollRunning = true;
    try {
        const outcomes = await Promise.all([...callbacks].map(async (callback) => {
            try {
                return await callback();
            } catch {
                return 'backoff';
            }
        }));
        backoffAttemptCount = outcomes.includes('backoff')
            ? backoffAttemptCount + 1
            : 0;
    } finally {
        pollRunning = false;
        schedulePolling();
    }
}

function onRuntimeActiveChange(): void {
    if (!isRuntimeActive()) {
        if (pollingTimeout) clearTimeout(pollingTimeout);
        pollingTimeout = null;
        return;
    }
    if (callbacks.size === 0 || pollRunning) return;
    const remainingMs = pollDueAtMs - Date.now();
    if (remainingMs <= 0) void runPollingCallbacks();
    else schedulePolling(remainingMs);
}

function reconcilePolling(): void {
    if (callbacks.size === 0) {
        stopScheduler();
    } else {
        stopListening ??= subscribeToRuntimeActiveChange(onRuntimeActiveChange);
        if (!pollingTimeout && !pollRunning) schedulePolling();
    }
}

/** One visible-demand cadence for external Directory enrollment and Home approval discovery.
 * External Directory enrollment has no event transport before Home sign-in. */
export function useAccountDirectoryActivePolling(callback: PollingCallback, enabled = true): void {
    const presented = useLayoutPresentationActive();
    const viewed = useHostActivelyViewed();
    const callbackRef = React.useRef(callback);
    callbackRef.current = callback;
    React.useEffect(() => {
        if (!enabled || !presented || !viewed) return;
        const invoke = () => callbackRef.current();
        callbacks.add(invoke);
        reconcilePolling();
        return () => {
            callbacks.delete(invoke);
            reconcilePolling();
        };
    }, [enabled, presented, viewed]);
}
