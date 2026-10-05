import * as React from 'react';
import type { ScmDiffSummaryOutputKind } from '@happier-dev/protocol';

import type { SessionScmReviewComparison } from '@/components/sessions/panes/details/sessionDetailsTabBuilders';
import { useSessionScmWalkthrough } from '@/components/sessions/files/walkthrough/useSessionScmWalkthrough';
import { useSessionExternalSessionRuntime } from '@/components/sessions/model/useSessionExternalSessionRuntime';
import { useSessionMachineReachability } from '@/components/sessions/model/useSessionMachineReachability';
import { useSessionMachineTarget } from '@/components/sessions/model/useSessionMachineTarget';
import { useSessionExecutionRunLaunchability } from '@/hooks/session/useSessionExecutionRunLaunchability';
import { resolveScmDiffSummaryModelSelection, SCM_DIFF_SUMMARY_SETTING_KEYS } from '@/settings/scmDiffSummary/settings';
import { scmComparisonSourceOf, scmReviewComparisonMatchesSource } from '@/sync/domains/scm/diffSummary/selection';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { useSession, useSettings } from '@/sync/domains/state/storage';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import {
    applySavedScmDiffSummaryResult,
    generateScmDiffSummaryFromUserAction,
    loadSavedScmDiffSummaryResult,
    refreshScmDiffSummaryRun,
} from '@/sync/ops/scmDiffSummary/generate';
import { createScmDiffSummaryResultOperations } from '@/sync/ops/scmDiffSummary/results';
import { createScmDiffSummarySavedResultOperations } from '@/sync/ops/scmDiffSummary/savedResultOperations';
import { subscribeExecutionRunActivity } from '@/sync/runtime/executionRuns/executionRunActivityBus';
import { deriveTranscriptInteractionFromSession } from '@/utils/sessions/deriveTranscriptInteraction';
import { t } from '@/text';

/**
 * A comparison view's binding to its Session's saved diff-summary result: the one store's projection for the
 * requested output, the owning machine's result operations, restoring a saved result after reopening (machine
 * persistence, never the request cache), rereading it on run activity, and starting a generation through the
 * shared START owner with the person's chosen structured-output model. Walkthrough and Commits both bind here.
 */
export function useSessionScmDiffSummaryBinding(params: Readonly<{
    sessionId: string;
    serverId?: string | null;
    /** Null while the view is not mounted in front; nothing is read or restored then. */
    comparison: SessionScmReviewComparison | null;
    output: ScmDiffSummaryOutputKind;
}>) {
    const { sessionId, serverId, comparison, output } = params;
    const binding = useServerCredentialAccountScopeBinding(serverId).binding;
    const scope = binding?.isCurrent() ? binding.scope : null;
    const session = useSession(sessionId, serverId);
    const machine = useSessionMachineTarget(sessionId, serverId);
    const { machineReachable } = useSessionMachineReachability(sessionId, serverId);
    const launch = useSessionExecutionRunLaunchability(sessionId, session, serverId);
    const external = useSessionExternalSessionRuntime({ sessionId, metadata: session ? readSessionOwnerMetadataView(session) : null, serverId });
    const canControl = Boolean(scope && machineReachable && (external.externalSessionLink === null || external.status?.runnerActive === true));
    const canSend = canControl && Boolean(session && deriveTranscriptInteractionFromSession(session).canSendMessages);
    const settings = useSettings();
    const storedModel = settings[SCM_DIFF_SUMMARY_SETTING_KEYS.modelProfileOverride];
    const [model, setModel] = React.useState(typeof storedModel === 'string' ? storedModel : '');
    const [modelAvailability, setModelAvailability] = React.useState({ value: '', available: false });
    const onModelAvailability = React.useCallback((available: boolean) => setModelAvailability({ value: model, available }), [model]);
    const modelAvailable = modelAvailability.value === model && modelAvailability.available;
    React.useEffect(() => { setModel(typeof storedModel === 'string' ? storedModel : ''); }, [binding, storedModel]);
    const selected = React.useMemo(() => resolveScmDiffSummaryModelSelection({ storedValue: model }), [model]);
    const [starting, setStarting] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    const viewModel = useSessionScmWalkthrough(sessionId, comparison, output, serverId);
    const capturedComparison = viewModel?.comparison ?? null;
    const cwd = capturedComparison?.repository.rootPath ?? machine?.basePath ?? null;
    const operations = React.useMemo(() => scope ? createScmDiffSummaryResultOperations({ sessionId,
        serverId: scope.serverId, accountId: scope.accountId, shouldContinue: () => binding?.isCurrent() === true }) : null,
        [binding, sessionId, scope?.serverId, scope?.accountId]);

    // Machine persistence, not the request cache, restores an edited result after reopening.
    React.useEffect(() => {
        if (!binding || !scope || !machine || !operations || !comparison || viewModel) return;
        const abort = new AbortController();
        const current = () => binding.isCurrent() && !abort.signal.aborted;
        const inventory = createScmDiffSummarySavedResultOperations({ machineId: machine.machineId, serverId: scope.serverId,
            accountId: scope.accountId, signal: abort.signal, shouldContinue: current });
        const restore = async () => {
            const listed = await inventory.list();
            if (!listed.success || !current()) return;
            const candidate = listed.results.find((item) => item.cwd === machine.basePath && item.sessionId === sessionId
                && (!comparison.comparisonId || item.comparisonId === comparison.comparisonId)
                && scmReviewComparisonMatchesSource(comparison, item.source));
            if (!candidate) return;
            const response = await operations.read({ cwd: candidate.cwd, resultId: candidate.resultId });
            if (response.success && current()) loadSavedScmDiffSummaryResult({ sessionId, scope, result: response.result });
        };
        void restore();
        // A result another producer saves later (a review's narration) arrives with that Session's Run
        // activity, the existing invalidation owner; once a result is bound this listener retires.
        const unsubscribe = subscribeExecutionRunActivity({ sessionId, serverId: scope.serverId }, () => { if (current()) void restore(); });
        return () => { abort.abort(); unsubscribe(); };
    }, [binding, scope?.serverId, scope?.accountId, machine?.machineId, machine?.basePath, operations, sessionId, comparison, Boolean(viewModel)]);

    const onStart = React.useCallback(async (outputs: readonly ScmDiffSummaryOutputKind[] = [output]) => {
        if (!binding?.isCurrent() || !scope || !cwd || !comparison || !selected.success || !modelAvailable || !canSend || !launch.canLaunchExecutionRuns || starting) return;
        setStarting(true); setError(null);
        try {
            const source = scmComparisonSourceOf(comparison, sessionId);
            const result = await generateScmDiffSummaryFromUserAction({ sessionId, serverId: scope.serverId, scope,
                shouldContinue: () => binding.isCurrent(), backendTarget: selected.backendTarget,
                input: { cwd, source, ...(comparison.comparisonId ? { comparisonId: comparison.comparisonId } : {}),
                    outputs: [...outputs], modelSelector: selected.modelSelector },
                settings: { ...settings, [SCM_DIFF_SUMMARY_SETTING_KEYS.modelProfileOverride]: model },
                intent: viewModel ? 'regenerate' : 'generate' });
            if (binding.isCurrent() && !result.ok) setError(result.error);
        } catch (failure) {
            if (binding.isCurrent()) setError(failure instanceof Error ? failure.message : t('walkthroughStart.unavailable'));
        } finally { if (binding.isCurrent()) setStarting(false); }
    }, [binding, scope?.serverId, scope?.accountId, cwd, comparison, sessionId, output, selected, modelAvailable, canSend, launch.canLaunchExecutionRuns, starting, settings, model, Boolean(viewModel)]);

    const key = viewModel?.requestKey;
    const resultId = viewModel?.resultId;
    const runId = viewModel?.executionRunId ?? null;
    // Run activity/reconnect is the existing invalidation owner. No polling timer or generated text authority.
    React.useEffect(() => {
        if (!scope || !binding || !key || !operations || !cwd) return;
        const abort = new AbortController();
        const current = () => binding.isCurrent() && !abort.signal.aborted;
        let pending = false;
        let invalidated = false;
        const refresh = async () => {
            if (!current()) return;
            if (pending) { invalidated = true; return; }
            pending = true;
            try {
                let currentRunId = runId;
                if (resultId && current()) {
                    const saved = await operations.read({ cwd, resultId });
                    if (saved.success && current()) {
                        applySavedScmDiffSummaryResult(key, saved.result);
                        currentRunId = saved.result.output.runId ?? runId;
                    }
                }
                if (currentRunId === runId && runId && current()) await refreshScmDiffSummaryRun({ key, sessionId, serverId: scope.serverId, scope,
                    runId, signal: abort.signal, shouldContinue: current });
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
        const unsubscribe = subscribeExecutionRunActivity({ sessionId, serverId: scope.serverId }, () => { void refresh(); });
        return () => { abort.abort(); unsubscribe(); };
    }, [binding, scope?.serverId, scope?.accountId, key, resultId, runId, operations, cwd, sessionId]);

    return {
        binding, scope, machine, canControl, canSend, launch, viewModel, capturedComparison, cwd, operations,
        error, setError,
        model, setModel, onModelAvailability, modelAvailable, selected, starting, onStart,
    } as const;
}
