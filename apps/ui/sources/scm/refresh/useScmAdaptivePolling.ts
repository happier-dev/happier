import * as React from 'react';
import { AppState, Platform } from 'react-native';

export type ScmAdaptivePollingInput = Readonly<{
    enabled: boolean;
    baseIntervalMs: number;
    stepIntervalMs: number;
    maxIntervalMs: number;
    activityToken?: number | string | null;
    getSignature: () => string | null;
    invalidateAndAwait: () => Promise<void>;
}>;

export function useScmAdaptivePolling(input: ScmAdaptivePollingInput) {
    const enabled = input.enabled === true;

    const baseIntervalMs = React.useMemo(() => {
        const raw = Number.isFinite(input.baseIntervalMs) ? input.baseIntervalMs : 0;
        return Math.max(0, raw);
    }, [input.baseIntervalMs]);

    const stepIntervalMs = React.useMemo(() => {
        const raw = Number.isFinite(input.stepIntervalMs) ? input.stepIntervalMs : 0;
        return Math.max(0, raw);
    }, [input.stepIntervalMs]);

    const maxIntervalMs = React.useMemo(() => {
        const raw = Number.isFinite(input.maxIntervalMs) ? input.maxIntervalMs : 0;
        return Math.max(0, raw);
    }, [input.maxIntervalMs]);

    const invalidateAndAwaitRef = React.useRef(input.invalidateAndAwait);
    React.useEffect(() => {
        invalidateAndAwaitRef.current = input.invalidateAndAwait;
    }, [input.invalidateAndAwait]);

    const getSignatureRef = React.useRef(input.getSignature);
    React.useEffect(() => {
        getSignatureRef.current = input.getSignature;
    }, [input.getSignature]);

    const [isActive, setIsActive] = React.useState(true);
    React.useEffect(() => {
        const sub = AppState.addEventListener('change', (state) => {
            setIsActive(state === 'active');
        });
        return () => {
            sub?.remove?.();
        };
    }, []);

    React.useEffect(() => {
        if (Platform.OS !== 'web') return;
        if (typeof document === 'undefined') return;

        const update = () => {
            setIsActive(document.visibilityState !== 'hidden');
        };
        update();
        document.addEventListener('visibilitychange', update);
        return () => {
            document.removeEventListener('visibilitychange', update);
        };
    }, []);

    const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const cancelledRef = React.useRef(false);
    const intervalMsRef = React.useRef<number>(baseIntervalMs);
    const lastSignatureRef = React.useRef<string | null>(null);
    const lastActivityTokenRef = React.useRef<unknown>(input.activityToken);

    React.useEffect(() => {
        intervalMsRef.current = baseIntervalMs;
    }, [baseIntervalMs]);

    React.useEffect(() => {
        lastActivityTokenRef.current = input.activityToken;
    }, [input.activityToken]);

    React.useEffect(() => {
        if (timerRef.current) {
            clearTimeout(timerRef.current);
            timerRef.current = null;
        }
        cancelledRef.current = false;
        // Treat a non-positive base interval as "disabled" to avoid accidental tight loops
        // (e.g. callers passing 0 to mean "no auto-refresh").
        if (!enabled || !isActive || baseIntervalMs <= 0) return;

        const runOnce = async () => {
            if (cancelledRef.current) return;
            const previousSignature = lastSignatureRef.current;
            const previousActivityToken = lastActivityTokenRef.current;

            try {
                await invalidateAndAwaitRef.current();
            } catch {
                // Best-effort: transient SCM errors should not permanently stop polling.
            }

            if (cancelledRef.current) return;
            const nextSignature = getSignatureRef.current();
            const signatureChanged = Boolean(nextSignature && nextSignature !== previousSignature);

            const activityToken = input.activityToken;
            const activityChanged = activityToken !== previousActivityToken;
            lastActivityTokenRef.current = activityToken;
            if (signatureChanged) {
                lastSignatureRef.current = nextSignature;
            } else if (previousSignature === null && typeof nextSignature === 'string') {
                // first observed signature
                lastSignatureRef.current = nextSignature;
            }

            if (activityChanged || signatureChanged) {
                intervalMsRef.current = baseIntervalMs;
            } else {
                const next = intervalMsRef.current + stepIntervalMs;
                intervalMsRef.current = maxIntervalMs > 0 ? Math.min(maxIntervalMs, next) : next;
            }

            const delayMs = Math.max(0, intervalMsRef.current);
            timerRef.current = setTimeout(() => {
                void runOnce();
            }, delayMs);
        };

        void runOnce();
        return () => {
            cancelledRef.current = true;
            if (timerRef.current) {
                clearTimeout(timerRef.current);
                timerRef.current = null;
            }
        };
    }, [baseIntervalMs, enabled, input.activityToken, isActive, maxIntervalMs, stepIntervalMs]);
}
