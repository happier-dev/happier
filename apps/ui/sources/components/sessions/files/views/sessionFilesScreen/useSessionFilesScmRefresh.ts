import * as React from 'react';
import { useFocusEffect } from '@react-navigation/native';

import { scmStatusSync } from '@/scm/scmStatusSync';
import { useScmAdaptivePolling } from '@/scm/refresh/useScmAdaptivePolling';

export type SessionFilesScmRefreshState = Readonly<{
    isRefreshing: boolean;
    diffRefreshToken: number;
    refreshScmData: () => Promise<void>;
}>;

export function useSessionFilesScmRefreshState(input: Readonly<{
    sessionId: string;
    sessionPath: string | null;
    autoRefreshIntervalMs: number;
    loadCommitHistory: (input?: Readonly<{ reset?: boolean }>) => Promise<void>;
    getSnapshotSignature: () => string | null;
}>): SessionFilesScmRefreshState {
    const [isRefreshing, setIsRefreshing] = React.useState(true);
    const [diffRefreshToken, setDiffRefreshToken] = React.useState(0);
    const [isFocused, setIsFocused] = React.useState(false);

    const loadCommitHistoryRef = React.useRef(input.loadCommitHistory);
    React.useEffect(() => {
        loadCommitHistoryRef.current = input.loadCommitHistory;
    }, [input.loadCommitHistory]);

    const pendingRefreshAfterSessionPathHydrationRef = React.useRef(false);

    const refreshScmData = React.useCallback(async () => {
        if (!input.sessionPath) return;
        setIsRefreshing(true);
        try {
            await scmStatusSync.invalidateFromUserAndAwait(input.sessionId);
            await loadCommitHistoryRef.current({ reset: true });
        } finally {
            setDiffRefreshToken((prev) => prev + 1);
            setIsRefreshing(false);
        }
    }, [input.sessionId, input.sessionPath]);

    useFocusEffect(
        React.useCallback(() => {
            const refresh = async () => {
                await refreshScmData();
            };

            if (!input.sessionPath) {
                pendingRefreshAfterSessionPathHydrationRef.current = true;
                return;
            }

            setIsFocused(true);
            refresh();

            return () => {
                setIsFocused(false);
            };
        }, [input.autoRefreshIntervalMs, input.sessionId, input.sessionPath, refreshScmData])
    );

    const maxIntervalMs = React.useMemo(() => {
        const raw = typeof input.autoRefreshIntervalMs === 'number' && Number.isFinite(input.autoRefreshIntervalMs)
            ? input.autoRefreshIntervalMs
            : 0;
        return Math.max(0, raw);
    }, [input.autoRefreshIntervalMs]);

    const baseIntervalMs = React.useMemo(() => {
        // Start reasonably fast, then backoff to the configured max interval.
        // Base is intentionally capped so SCM surfaces feel responsive without constant polling.
        return Math.max(0, Math.min(10_000, maxIntervalMs));
    }, [maxIntervalMs]);

    useScmAdaptivePolling({
        enabled: isFocused && Boolean(input.sessionPath),
        baseIntervalMs,
        stepIntervalMs: baseIntervalMs,
        maxIntervalMs,
        activityToken: diffRefreshToken,
        getSignature: input.getSnapshotSignature,
        invalidateAndAwait: React.useCallback(async () => {
            await scmStatusSync.invalidateFromAutoRefreshAndAwait(input.sessionId);
        }, [input.sessionId]),
    });

    React.useEffect(() => {
        if (!input.sessionPath) return;
        if (!pendingRefreshAfterSessionPathHydrationRef.current) return;
        pendingRefreshAfterSessionPathHydrationRef.current = false;
        void refreshScmData();
    }, [input.sessionPath, refreshScmData]);

    return { isRefreshing, diffRefreshToken, refreshScmData };
}
