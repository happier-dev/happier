import * as React from 'react';
import type { ScmDiffSummaryOutputKind } from '@happier-dev/protocol/scm';

import type { SessionScmReviewComparison } from '@/components/sessions/panes/details/sessionDetailsTabBuilders';
import type { ScmDiffSummaryEntry, ScmDiffSummaryViewModel, ScmDiffSummaryRestoreState } from '@/sync/domains/scm/diffSummary/state';
import { selectScmWalkthroughKey, scmReviewComparisonMatchesSource, scmDiffSummaryOutputNeedsPublishedFallback } from '@/sync/domains/scm/diffSummary/selection';
import { serverAccountScopeKeySuffix, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { retryServerCredentialAccountScope } from '@/sync/domains/scope/serverCredentialAccountScope';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { usePreferredServerIdForSession } from '@/sync/runtime/orchestration/serverScopedRpc/usePreferredServerIdForSession';
import {
    getScmDiffSummaryOperationState,
    getScmDiffSummaryState,
    subscribeScmDiffSummaryState,
    retireScmDiffSummaryScope,
    loadSavedScmDiffSummaryResult,
} from '@/sync/ops/scmDiffSummary/generate';
import { createScmDiffSummaryResultOperations } from '@/sync/ops/scmDiffSummary/results';
import { createScmDiffSummarySavedResultOperations } from '@/sync/ops/scmDiffSummary/savedResultOperations';
import { useSessionMachineControlTargetState, useSessionMachineDisplayIdentity } from '@/components/sessions/model/useSessionMachineTarget';
import { useMachinePresenceSummary } from '@/components/sessions/model/useMachinePresenceSummary';
import { subscribeExecutionRunActivity } from '@/sync/runtime/executionRuns/executionRunActivityBus';
import { scmComparisonKey } from '@/components/sessions/files/comparison/filesComparison';

/**
 * The walkthrough analysis behind a comparison view: the existing diff-summary request state (its
 * captured comparison, per-output progress, analysis coverage and result identity), read through the
 * one store, including saved results published before this view opened. Null when no matching
 * walkthrough is available for the admitted host and comparison.
 */
export function useSessionScmWalkthrough(sessionId: string, comparison: SessionScmReviewComparison | null, output: ScmDiffSummaryOutputKind = 'walkthrough', serverId?: string | null): ScmDiffSummaryViewModel | null {
    return useScmWalkthrough({ sessionId }, comparison, output, serverId);
}

type ScmWalkthroughHost = Readonly<{ sessionId: string }> | Readonly<{ machineId: string; cwd: string }>;
export type ScmWalkthroughSelection = Readonly<{ comparison: SessionScmReviewComparison | null; output: ScmDiffSummaryOutputKind }>;
export type ScmWalkthroughRestoration = Readonly<{
    restoreState: ScmDiffSummaryRestoreState;
    retryRestore: () => void;
    machineReachability: ReturnType<typeof useMachinePresenceSummary>['reachability'];
}>;
/** Primitive props keep the memoized view adapters stable when the parent renders unrelated changes. */
export type ScmWalkthroughRestorationProps = ScmWalkthroughRestoration | Readonly<{
    restoreState?: never;
    retryRestore?: never;
    machineReachability?: never;
}>;

export function useScmWalkthroughState(host: Readonly<{ sessionId: string }> | Readonly<{ machineId: string; cwd: string }>,
    comparison: SessionScmReviewComparison | null, output: ScmDiffSummaryOutputKind = 'walkthrough', serverId?: string | null,
    restoration?: ScmWalkthroughRestoration) {
    const { viewModels, restoration: restored } = useScmWalkthroughStates(host, [{ comparison, output }], serverId, restoration);
    const viewModel = viewModels[0] ?? null;
    return { viewModel, ...restored, restoreState: !comparison ? 'idle' as const : viewModel ? 'ready' as const : restored.restoreState };
}

/** One acquisition admits complete saved records; each output keeps its own comparison and fallback selection. */
export function useScmWalkthroughStates(host: ScmWalkthroughHost, selections: readonly ScmWalkthroughSelection[],
    serverId?: string | null, restoration?: ScmWalkthroughRestoration) {
    const sessionId = 'sessionId' in host ? host.sessionId : null;
    const sessionServerId = usePreferredServerIdForSession({ sessionId: sessionId ?? '', serverId }, Boolean(sessionId));
    const hostServerId = sessionId ? sessionServerId : serverId;
    const admittedScope = React.useRef<ServerAccountScope | null>(null);
    const projectionLifecycle = React.useMemo(() => ({
        beforeBinding: (binding: Readonly<{ scope: ServerAccountScope }>) => { admittedScope.current = binding.scope; },
        onCredentialMutation: (changedServerId: string) => {
            if (admittedScope.current?.serverId === changedServerId) retireScmDiffSummaryScope(admittedScope.current);
        },
    }), []);
    const { binding, resolution } = useServerCredentialAccountScopeBinding(hostServerId, projectionLifecycle);
    // Profile/reconnect revalidation retires request authority, not hydrated Account data.
    // The scope owner retains this identity until it confirms a different Account or sign-out.
    const scopeKey = resolution.kind === 'bound' ? serverAccountScopeKeySuffix(resolution.scope) : null;
    const selectionKey = JSON.stringify(selections.map(({ comparison, output }) => [comparison ? scmComparisonKey(comparison) : null, output]));
    const getSnapshot = React.useMemo(() => {
        let previousEntries: (ScmDiffSummaryEntry | undefined)[] = [];
        let projection: readonly (ScmDiffSummaryViewModel | null)[] = selections.map(() => null);
        return () => {
            const state = getScmDiffSummaryState();
            const keys = selections.map(({ comparison, output }) => scopeKey
                ? selectScmWalkthroughKey(state, host, comparison, output, scopeKey) : null);
            const entries = keys.map(key => key ? state.entriesByKey[key] : undefined);
            if (entries.length === previousEntries.length && entries.every((entry, index) => entry === previousEntries[index])) return projection;
            previousEntries = entries;
            projection = keys.map((key, index) => key ? getScmDiffSummaryOperationState(state, key, selections[index]!.output) : null);
            return projection;
        };
    }, ['sessionId' in host ? host.sessionId : null, 'machineId' in host ? host.machineId : null,
        'cwd' in host ? host.cwd : null, selectionKey, scopeKey]);
    const viewModels = React.useSyncExternalStore(subscribeScmDiffSummaryState, getSnapshot, getSnapshot);
    // The control-target owner admits an exact metadata target before presence hydrates; transport still
    // verifies the captured Session/Account. Display identity is used only to explain known offline state.
    const sessionTarget = useSessionMachineControlTargetState(sessionId ?? '', hostServerId);
    const sessionMachine = sessionTarget.status === 'ready' ? sessionTarget : null;
    const displayMachine = useSessionMachineDisplayIdentity(sessionId ?? '', hostServerId);
    const machineId = 'machineId' in host ? host.machineId : sessionMachine?.machineId;
    const cwd = 'cwd' in host ? host.cwd : sessionMachine?.basePath;
    const presence = useMachinePresenceSummary(binding?.scope.serverId, machineId ?? (sessionId ? displayMachine.machineId : null));
    const machineOffline = presence.reachability === 'unreachable';
    const restoreKey = JSON.stringify([scopeKey, sessionId, machineId, cwd, selectionKey]);
    const [restored, setRestored] = React.useState<Readonly<{ key: string; state: 'ready' | 'unavailable' }> | null>(null);
    const [retry, setRetry] = React.useState(0);
    const retryRestore = React.useCallback(() => {
        retryServerCredentialAccountScope(resolveServerProfileScopeIdForIdentifier(hostServerId));
        setRestored(null);
        setRetry(value => value + 1);
    }, [hostServerId]);
    const needsRestore = selections.some(({ comparison, output }, index) => comparison && (!viewModels[index]
        || (viewModels[index]?.savedResult && scmDiffSummaryOutputNeedsPublishedFallback(viewModels[index]?.outputs?.[output]))));
    // Files, Walkthrough and Commits read the same saved-result owner. A
    // published reading must not depend on visiting its generation controls.
    React.useEffect(() => {
        if (restoration || !binding?.isCurrent() || !machineId || !cwd || machineOffline || !needsRestore) return;
        const scope = binding.scope;
        const abort = new AbortController();
        const current = () => binding.isCurrent() && !abort.signal.aborted;
        const operations = createScmDiffSummaryResultOperations({ ...host, serverId: scope.serverId,
            accountId: scope.accountId, signal: abort.signal, shouldContinue: current });
        const inventory = createScmDiffSummarySavedResultOperations({ machineId, serverId: scope.serverId,
            ...(sessionId ? { sessionId } : {}), accountId: scope.accountId,
            signal: abort.signal, shouldContinue: current });
        let pending = false;
        let invalidated = false;
        const restore = async () => {
            if (!current()) return;
            if (pending) { invalidated = true; return; }
            pending = true;
            try {
                const listed = await inventory.list();
                if (!current()) return;
                if (!listed.success) { setRestored({ key: restoreKey, state: 'unavailable' }); return; }
                const remaining = new Set(selections.flatMap(({ comparison }, index) => comparison ? [index] : []));
                const failedAttempts = new Set<number>();
                let unreadable = false;
                for (const candidate of listed.results) {
                    if (candidate.cwd !== cwd || (sessionId ? candidate.sessionId !== sessionId : Boolean(candidate.sessionId))) continue;
                    const matches = [...remaining].filter(index => {
                        const comparison = selections[index]!.comparison!;
                        return (!comparison.comparisonId || candidate.comparisonId === comparison.comparisonId)
                            && scmReviewComparisonMatchesSource(comparison, candidate.source);
                    });
                    if (matches.length === 0) continue;
                    const response = await operations.read({ cwd: candidate.cwd, resultId: candidate.resultId });
                    if (!current()) return;
                    const captured = response.success ? response.result.output.comparison : null;
                    if (!response.success || captured?.repository.rootPath !== cwd || captured.id !== candidate.comparisonId) { unreadable = true; continue; }
                    const capturedMatches = matches.filter(index => scmReviewComparisonMatchesSource(selections[index]!.comparison!, captured.source, captured));
                    if (capturedMatches.length === 0) { unreadable = true; continue; }
                    // Admit the complete record even when an output is absent. Later publications enter the
                    // same store, and the selectors retain independent newest/proven-value fallback rules.
                    loadSavedScmDiffSummaryResult({ ...host, scope, result: response.result, savedAtMs: candidate.updatedAtMs });
                    for (const index of capturedMatches) {
                        const requestedOutput = response.result.output.success ? response.result.output.outputs?.[selections[index]!.output] : undefined;
                        if (!requestedOutput) continue;
                        if (scmDiffSummaryOutputNeedsPublishedFallback(requestedOutput)) failedAttempts.add(index);
                        if (requestedOutput.value !== undefined || !failedAttempts.has(index)) remaining.delete(index);
                    }
                    if (remaining.size === 0) break;
                }
                if (current()) setRestored({ key: restoreKey, state: unreadable ? 'unavailable' : 'ready' });
            } catch {
                if (current()) setRestored({ key: restoreKey, state: 'unavailable' });
            } finally {
                pending = false;
                if (invalidated && current()) { invalidated = false; void restore(); }
            }
        };
        void restore();
        const unsubscribe = sessionId ? subscribeExecutionRunActivity({ sessionId, serverId: scope.serverId }, () => { if (current()) void restore(); }) : () => {};
        return () => { abort.abort(); unsubscribe(); };
    }, [binding, machineId, cwd, machineOffline, sessionId, selectionKey, needsRestore, restoreKey, retry, Boolean(restoration)]);
    // A preloaded comparison is revalidated once on mount/reconnect, at the same owner as cold
    // restoration. Newly admitted output does not trigger this effect or another full-result read.
    React.useEffect(() => {
        if (restoration || !binding?.isCurrent() || !machineId || !cwd || machineOffline || !selections.some(selection => selection.comparison)) return;
        const admitted = getSnapshot();
        if (selections.some(({ comparison, output }, index) => comparison && (!admitted[index]
            || (admitted[index]?.savedResult && scmDiffSummaryOutputNeedsPublishedFallback(admitted[index]?.outputs?.[output]))))) return;
        const scope = binding.scope;
        const abort = new AbortController();
        const current = () => binding.isCurrent() && !abort.signal.aborted;
        const operations = createScmDiffSummaryResultOperations({ ...host, serverId: scope.serverId,
            accountId: scope.accountId, signal: abort.signal, shouldContinue: current });
        void (async () => {
            const read = new Set<string>();
            for (const value of admitted) {
                if (!current()) return;
                if (!value?.resultId || read.has(value.resultId)) continue;
                read.add(value.resultId);
                try {
                    const response = await operations.read({ cwd: value.comparison?.repository.rootPath ?? cwd, resultId: value.resultId });
                    if (response.success && current()) loadSavedScmDiffSummaryResult({ ...host, scope, result: response.result });
                } catch { /* Keep the admitted last-known record on a failed revalidation. */ }
            }
        })();
        return () => abort.abort();
    }, [binding, machineId, cwd, machineOffline, sessionId, selectionKey, getSnapshot, retry, Boolean(restoration)]);
    // A missing projection is unknown until its saved read settles. Presence and target hydration can take
    // longer than the read itself; neither is proof that this comparison has no saved output.
    const restoreState: ScmDiffSummaryRestoreState = !selections.some(selection => selection.comparison) ? 'idle' : !needsRestore ? 'ready'
        : restored?.key === restoreKey ? restored.state
        : (resolution.kind !== 'bound' && resolution.kind !== 'resolving')
            || machineOffline || (sessionId && sessionTarget.status === 'unavailable') ? 'unavailable' : 'restoring';
    return { viewModels, restoration: restoration ?? { restoreState, retryRestore, machineReachability: presence.reachability } } as const;
}

/** Projection-only consumers share the same restoration lifecycle as the foreground binding. */
export function useScmWalkthrough(host: Readonly<{ sessionId: string }> | Readonly<{ machineId: string; cwd: string }>,
    comparison: SessionScmReviewComparison | null, output: ScmDiffSummaryOutputKind = 'walkthrough', serverId?: string | null,
    restoration?: ScmWalkthroughRestoration): ScmDiffSummaryViewModel | null {
    return useScmWalkthroughState(host, comparison, output, serverId, restoration).viewModel;
}
