import * as React from 'react';

import type { AgentId } from '@/agents/catalog/catalog';
import {
    buildScmStatusSummaryFromSnapshot,
    type ScmStatusSummary,
} from '@/components/sessions/sourceControl/status/statusSummary';
import type { Metadata } from '@/sync/domains/state/storageTypes';
import type { CurrentSessionRunnerProcessIdentity } from '@/sync/domains/models/resolveSessionModelSelectionDisposition';
import { useSessionProjectScmSnapshot, useSessionUsage } from '@/sync/domains/state/storage';
import { sync } from '@/sync/sync';
import { nowServerMs } from '@/sync/runtime/time';
import {
    computeContextPercentUsed,
    type SessionContextUsageSnapshotV1,
} from '@happier-dev/protocol';

import { resolveContextWindowTokens } from '../resolveContextWarningWindowTokens';

/**
 * Config-option id the Claude runtime listens for to run an on-demand
 * `getContextUsage()` refresh (L2 T3.3). Toggling it from the UI publishes a
 * session metadata override that the plugin picks up between turns.
 */
const CONTEXT_USAGE_REFRESH_CONFIG_OPTION_ID = 'context_usage_refresh';

export type InstrumentStripContextModel = Readonly<{
    /** Baseline-adjusted used percentage, 0..100 (true window, not the 0.95 warning window). */
    usedPct: number;
    usedTokens: number;
    windowTokens: number | null;
    baselineTokens: number | null;
    totalProcessedTokens: number | null;
    isAutoCompactEnabled: boolean | null;
    categories: ReadonlyArray<{ key: string; label: string | null; tokens: number }> | null;
    source: SessionContextUsageSnapshotV1['source'];
    stale: boolean;
}>;

export type InstrumentStripModel = Readonly<{
    context: InstrumentStripContextModel | null;
    git: ScmStatusSummary | null;
    /** Triggers a between-turn provider context refresh (Claude); no-op otherwise. */
    refreshContextUsage: () => void;
}>;

type SessionUsageLike = Readonly<{
    contextSize?: number;
    contextWindowTokens?: number;
    contextSnapshot?: SessionContextUsageSnapshotV1;
    contextSnapshotStale?: boolean;
}> | null;

/**
 * Store-subscribed model for the session instrument strip. Subscribing HERE
 * (not via a prop from `SessionView`) is the F-UI-11 perf fix: usage ticks
 * re-render only the strip, never the memoized 3k-line composer.
 */
export function useInstrumentStripModel(params: Readonly<{
    sessionId: string | null | undefined;
    agentId: AgentId | null | undefined;
    agentTargetKey?: string | null;
    metadata: Metadata | null | undefined;
    sessionActive?: boolean;
    currentRunnerProcessIdentity?: CurrentSessionRunnerProcessIdentity | null;
}>): InstrumentStripModel {
    const {
        sessionId,
        agentId,
        agentTargetKey,
        metadata,
        sessionActive,
        currentRunnerProcessIdentity,
    } = params;
    const usage = useSessionUsage(sessionId ?? '') as SessionUsageLike;
    const scmSnapshot = useSessionProjectScmSnapshot(sessionId ?? null);

    const snapshot = usage?.contextSnapshot ?? null;
    const contextSnapshotStale = usage?.contextSnapshotStale === true;
    const usageContextSize = typeof usage?.contextSize === 'number' ? usage.contextSize : 0;
    const usageContextWindowTokens = typeof usage?.contextWindowTokens === 'number'
        ? usage.contextWindowTokens
        : undefined;

    // Resolve the TRUE window (registry / metadata / catalog fallbacks) so the
    // gauge % denominator matches the provider's own `/status`, not the 0.95
    // warning-adjusted window.
    const resolvedWindowTokens = React.useMemo(() => {
        if (!agentId) return null;
        return resolveContextWindowTokens({
            agentId,
            agentTargetKey,
            metadata: metadata ?? null,
            sessionActive,
            currentRunnerProcessIdentity,
            usageData: {
                contextSnapshot: snapshot ?? undefined,
                contextSize: usageContextSize,
                ...(typeof usageContextWindowTokens === 'number'
                    ? { contextWindowTokens: usageContextWindowTokens }
                    : {}),
            },
        });
    }, [
        agentId,
        agentTargetKey,
        metadata,
        currentRunnerProcessIdentity,
        sessionActive,
        snapshot,
        usageContextSize,
        usageContextWindowTokens,
    ]);

    const context = React.useMemo<InstrumentStripContextModel | null>(() => {
        // Nothing to show when neither a snapshot nor a resolvable window exists
        // (unknown provider pre-L2 — keep today's "gauge hidden" behavior).
        if (resolvedWindowTokens === null && !snapshot) return null;

        const effectiveSnapshot: SessionContextUsageSnapshotV1 = snapshot
            ? { ...snapshot, windowTokens: resolvedWindowTokens ?? snapshot.windowTokens }
            : {
                v: 1,
                modelId: null,
                usedTokens: usageContextSize,
                windowTokens: resolvedWindowTokens,
                totalProcessedTokens: null,
                baselineTokens: null,
                isAutoCompactEnabled: null,
                categories: null,
                observedAtMs: 0,
                source: 'derived_estimate',
            };

        const pct = contextSnapshotStale ? null : computeContextPercentUsed(effectiveSnapshot);
        if (pct === null && !contextSnapshotStale && effectiveSnapshot.windowTokens === null) {
            // No window at all → cannot render a meaningful gauge.
            return null;
        }

        return {
            usedPct: pct ?? 0,
            usedTokens: effectiveSnapshot.usedTokens,
            windowTokens: effectiveSnapshot.windowTokens,
            baselineTokens: effectiveSnapshot.baselineTokens,
            totalProcessedTokens: effectiveSnapshot.totalProcessedTokens,
            isAutoCompactEnabled: effectiveSnapshot.isAutoCompactEnabled,
            categories: effectiveSnapshot.categories,
            source: effectiveSnapshot.source,
            stale: contextSnapshotStale,
        };
    }, [resolvedWindowTokens, snapshot, usageContextSize, contextSnapshotStale]);

    const git = React.useMemo(
        () => buildScmStatusSummaryFromSnapshot(scmSnapshot),
        [scmSnapshot],
    );

    const refreshContextUsage = React.useCallback(() => {
        if (!sessionId) return;
        // Toggle a monotonically-changing value so a repeated open re-triggers.
        void sync.publishSessionAcpConfigOptionOverrideToMetadata({
            sessionId,
            configId: CONTEXT_USAGE_REFRESH_CONFIG_OPTION_ID,
            value: String(nowServerMs()),
            updatedAt: nowServerMs(),
        });
    }, [sessionId]);

    return React.useMemo(
        () => ({ context, git, refreshContextUsage }),
        [context, git, refreshContextUsage],
    );
}
