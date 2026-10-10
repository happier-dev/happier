import * as React from 'react';
import type { ScmDiffSummaryOutputKind } from '@happier-dev/protocol';

import type { SessionScmReviewComparison } from '@/components/sessions/panes/details/sessionDetailsTabBuilders';
import { getStorage, useSetting } from '@/sync/domains/state/storage';
import { useScmWalkthrough } from '@/components/sessions/files/walkthrough/useSessionScmWalkthrough';
import { resolveScmDiffSummaryModelSelection, SCM_DIFF_SUMMARY_SETTING_KEYS } from '@/settings/scmDiffSummary/settings';
import { scmComparisonSourceOf, scmReviewComparisonMatchesSource } from '@/sync/domains/scm/diffSummary/selection';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import {
    applySavedScmDiffSummaryResult,
    generateScmDiffSummaryFromUserAction,
    loadSavedScmDiffSummaryResult,
    refreshScmDiffSummaryRun,
} from '@/sync/ops/scmDiffSummary/generate';
import { createScmDiffSummaryResultOperations, type ScmDiffSummaryHost } from '@/sync/ops/scmDiffSummary/results';
import { createScmDiffSummarySavedResultOperations } from '@/sync/ops/scmDiffSummary/savedResultOperations';
import { subscribeExecutionRunActivity } from '@/sync/runtime/executionRuns/executionRunActivityBus';
import { t } from '@/text';
import { scmComparisonKey } from './filesComparison';

/**
 * A comparison view's binding to its admitted host's saved diff-summary result: the one store's projection for the
 * requested output, the owning machine's result operations, restoring a saved result after reopening (machine
 * persistence, never the request cache), rereading it on run activity, and starting a generation through the
 * shared START owner with the person's chosen structured-output model. Walkthrough and Commits both bind here.
 */
export function useScmDiffSummaryBinding(params: Readonly<{
    host: ScmDiffSummaryHost;
    machine: Readonly<{ machineId: string; basePath: string }> | null;
    machineReachable: boolean;
    canControl: boolean;
    canSend: boolean;
    launch: Readonly<{ canLaunchExecutionRuns: boolean }>;
    serverId?: string | null;
    /** Null while the view is not mounted in front; nothing is read or restored then. */
    comparison: SessionScmReviewComparison | null;
    output: ScmDiffSummaryOutputKind;
}>) {
    const { host, serverId, comparison, output, machine, machineReachable, launch } = params;
    const sessionId = 'sessionId' in host ? host.sessionId : null;
    const binding = useServerCredentialAccountScopeBinding(serverId).binding;
    const scope = binding?.isCurrent() ? binding.scope : null;
    const canControl = Boolean(scope) && params.canControl;
    const canSend = canControl && params.canSend;
    const hostKey = JSON.stringify([scope?.serverId, scope?.accountId, sessionId, host.machineId, machine?.basePath,
        comparison ? scmComparisonKey(comparison) : null, output]);
    const currentHostKey = React.useRef<string | null>(hostKey);
    currentHostKey.current = hostKey;
    const isCurrent = React.useCallback(() => binding?.isCurrent() === true && currentHostKey.current === hostKey, [binding, hostKey]);
    React.useEffect(() => {
        currentHostKey.current = hostKey;
        return () => { if (currentHostKey.current === hostKey) currentHostKey.current = null; };
    }, [hostKey]);
    const storedModel = useSetting(SCM_DIFF_SUMMARY_SETTING_KEYS.modelProfileOverride);
    const [model, setModel] = React.useState(typeof storedModel === 'string' ? storedModel : '');
    const [modelAvailability, setModelAvailability] = React.useState({ value: '', available: false });
    const onModelAvailability = React.useCallback((available: boolean) => setModelAvailability({ value: model, available }), [model]);
    const modelAvailable = modelAvailability.value === model && modelAvailability.available;
    React.useEffect(() => { setModel(typeof storedModel === 'string' ? storedModel : ''); }, [binding, storedModel]);
    const selected = React.useMemo(() => resolveScmDiffSummaryModelSelection({ storedValue: model }), [model]);
    const [starting, setStarting] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    const [inputObservation, setInputObservation] = React.useState<Readonly<{ hostKey: string; runId: string; inputId: string; resultId: string }> | null>(null);
    const onRunAdmitted = React.useCallback((observation: Readonly<{ runId: string; inputId: string; resultId: string }>) => {
        if (!sessionId && isCurrent()) setInputObservation({ hostKey, ...observation });
    }, [sessionId, isCurrent, hostKey]);
    React.useEffect(() => { setStarting(false); setError(null); }, [hostKey]);
    const viewModel = useScmWalkthrough(sessionId ? { sessionId } : { machineId: host.machineId!, cwd: machine?.basePath ?? '' }, comparison, output, serverId);
    const capturedComparison = viewModel?.comparison ?? null;
    const cwd = capturedComparison?.repository.rootPath ?? machine?.basePath ?? null;
    const operations = React.useMemo(() => scope ? createScmDiffSummaryResultOperations({ ...host,
        serverId: scope.serverId, accountId: scope.accountId, shouldContinue: isCurrent, onRunAdmitted }) : null,
        [isCurrent, onRunAdmitted, sessionId, host.machineId, scope?.serverId, scope?.accountId]);

    // Machine persistence, not the request cache, restores an edited result after reopening.
    React.useEffect(() => {
        if (!binding || !scope || !machine || !machineReachable || !operations || !comparison || viewModel) return;
        const abort = new AbortController();
        const current = () => isCurrent() && !abort.signal.aborted;
        const inventory = createScmDiffSummarySavedResultOperations({ machineId: machine.machineId, serverId: scope.serverId,
            ...(sessionId ? { sessionId } : {}),
            accountId: scope.accountId, signal: abort.signal, shouldContinue: current });
        let pending = false;
        let invalidated = false;
        const restore = async () => {
            if (!current()) return;
            if (pending) { invalidated = true; return; }
            pending = true;
            try {
                const listed = await inventory.list();
                if (!listed.success || !current()) return;
                const candidate = listed.results.find((item) => item.cwd === machine.basePath && (sessionId ? item.sessionId === sessionId : !item.sessionId)
                    && (!comparison.comparisonId || item.comparisonId === comparison.comparisonId)
                    && scmReviewComparisonMatchesSource(comparison, item.source));
                if (!candidate) return;
                const response = await operations.read({ cwd: candidate.cwd, resultId: candidate.resultId });
                const captured = response.success ? response.result.output.comparison : null;
                if (response.success && current() && captured?.repository.rootPath === machine.basePath
                    && captured.id === candidate.comparisonId
                    && scmReviewComparisonMatchesSource(comparison, captured.source, captured)) {
                    loadSavedScmDiffSummaryResult({ ...host, scope, result: response.result });
                }
            } finally {
                pending = false;
                if (invalidated && current()) { invalidated = false; void restore(); }
            }
        };
        void restore();
        // A result another producer saves later (a review's narration) arrives with that Session's Run
        // activity, the existing invalidation owner; once a result is bound this listener retires.
        const unsubscribe = sessionId ? subscribeExecutionRunActivity({ sessionId, serverId: scope.serverId }, () => { if (current()) void restore(); }) : () => {};
        return () => { abort.abort(); unsubscribe(); };
    }, [binding, isCurrent, scope?.serverId, scope?.accountId, machine?.machineId, machine?.basePath, machineReachable, operations, sessionId, host.machineId, comparison, Boolean(viewModel)]);

    const onStart = React.useCallback(async (outputs: readonly ScmDiffSummaryOutputKind[] = [output]) => {
        if (!isCurrent() || !scope || !cwd || !comparison || !selected.success || !modelAvailable || !canSend || !launch.canLaunchExecutionRuns || starting) return;
        setStarting(true); setError(null);
        try {
            if (!sessionId && (comparison.kind === 'session' || comparison.kind === 'turnCheckpoint')) return;
            const source = scmComparisonSourceOf(comparison, sessionId ?? '');
            const result = await generateScmDiffSummaryFromUserAction({ ...host, serverId: scope.serverId, scope,
                shouldContinue: isCurrent, backendTarget: selected.backendTarget,
                input: { cwd, source, ...(comparison.comparisonId ? { comparisonId: comparison.comparisonId } : {}),
                    outputs: [...outputs], modelSelector: selected.modelSelector },
                settings: { ...getStorage().getState().settings, [SCM_DIFF_SUMMARY_SETTING_KEYS.modelProfileOverride]: model },
                intent: viewModel ? 'regenerate' : 'generate' });
            if (isCurrent() && !result.ok) setError(result.error);
        } catch (failure) {
            if (isCurrent()) setError(failure instanceof Error ? failure.message : t('walkthroughStart.unavailable'));
        } finally { if (isCurrent()) setStarting(false); }
    }, [binding, isCurrent, scope?.serverId, scope?.accountId, cwd, comparison, sessionId, host.machineId, output, selected, modelAvailable, canSend, launch.canLaunchExecutionRuns, starting, model, Boolean(viewModel)]);

    const key = viewModel?.requestKey;
    const resultId = viewModel?.resultId;
    const runId = viewModel?.executionRunId ?? null;
    const initialInputId = viewModel?.inputId ?? null;
    // Run activity/reconnect is the existing invalidation owner. No polling timer or generated text authority.
    React.useEffect(() => {
        if (!scope || !binding || !machineReachable || !key || !viewModel || !operations || !cwd) return;
        const abort = new AbortController();
        const current = () => isCurrent() && !abort.signal.aborted;
        let pending = false;
        let invalidated = false;
        const refresh = async () => {
            if (!current()) return;
            if (pending) { invalidated = true; return; }
            pending = true;
            try {
                let currentRunId = runId;
                let observation = viewModel;
                if (resultId && current()) {
                    const saved = await operations.read({ cwd, resultId });
                    if (saved.success && current()) {
                        applySavedScmDiffSummaryResult(key, saved.result);
                        currentRunId = saved.result.output.runId ?? runId;
                        observation = { ...viewModel, revision: saved.result.revision, comparison: saved.result.output.comparison ?? null,
                            outputs: saved.result.output.outputs ?? null };
                    }
                }
                if (currentRunId === runId && runId && current()) {
                    const input = inputObservation?.hostKey === hostKey && inputObservation.resultId === resultId && inputObservation.runId === runId
                        ? inputObservation : null;
                    const state = observation?.outputs?.walkthrough?.state;
                    const waitForOutput = !sessionId && observation?.comparison && (state === 'pending' || state === 'writing')
                        ? { kind: 'review_walkthrough' as const, comparisonId: observation.comparison.id,
                            ...(resultId ? { resultId } : {}), ...(observation.revision !== null ? { afterRevision: observation.revision } : {}) } : undefined;
                    const waitForInputId = input?.inputId ?? (!sessionId ? initialInputId : null);
                    await refreshScmDiffSummaryRun({ key, ...host, serverId: scope.serverId, scope,
                        runId, signal: abort.signal, shouldContinue: current,
                        ...(waitForInputId ? { waitForInputId } : {}), ...(waitForOutput ? { waitForOutput } : {}) });
                    if (!sessionId && resultId && current()) {
                        const settled = await operations.read({ cwd, resultId });
                        if (settled.success && current()) applySavedScmDiffSummaryResult(key, settled.result);
                    }
                    if (input && current()) setInputObservation(previous => previous === input ? null : previous);
                }
            } catch (failure) {
                if (current()) setError(failure instanceof Error ? failure.message : t('walkthroughStart.unavailable'));
            } finally {
                pending = false;
                if (invalidated && current()) { invalidated = false; void refresh(); }
            }
        };
        void refresh();
        // A newly seeded discussion can bind its Run after admission; reread the canonical
        // saved linkage on Session activity too, rather than filtering out that new Run.
        const unsubscribe = sessionId ? subscribeExecutionRunActivity({ sessionId, serverId: scope.serverId }, () => { void refresh(); }) : () => {};
        return () => { abort.abort(); unsubscribe(); };
    }, [binding, isCurrent, hostKey, inputObservation, initialInputId, scope?.serverId, scope?.accountId, machineReachable, key, resultId, runId, operations, cwd, sessionId, host.machineId]);

    return {
        host, serverId, comparison,
        binding, isCurrent, scope, machine, machineReachable, canControl, canSend, launch, viewModel, capturedComparison, cwd, operations,
        error, setError,
        model, setModel, onModelAvailability, modelAvailable, selected, starting, onStart,
    } as const;
}
