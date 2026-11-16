import * as React from 'react';
import type { SessionExecutionRunLaunchUnavailableReason } from '@/hooks/session/useSessionExecutionRunLaunchability';
import type { ScmDiffSummaryOutputKind } from '@happier-dev/protocol/scm/diffSummary';
import { buildBackendTargetKeyV2, parseBackendTargetKeyV2, readBackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { isLlmTaskRunnerAutoV1, LlmTaskRunnerChoiceV1Schema, type LlmTaskRunnerChoiceV1 } from '@happier-dev/protocol/llm/tasks/llmTaskRunnerConfigV1';
import { ProviderBoundModelRefSchema } from '@happier-dev/protocol/providers/model-selection';

import type { SessionScmReviewComparison } from '@/components/sessions/panes/details/sessionDetailsTabBuilders';
import { getStorage, useSetting } from '@/sync/domains/state/storage';
import { useScmWalkthroughStates, type ScmWalkthroughRestoration, type ScmWalkthroughSelection } from '@/components/sessions/files/walkthrough/useSessionScmWalkthrough';
import { projectScmDiffSummaryModelSelector, SCM_DIFF_SUMMARY_SETTING_KEYS } from '@/settings/scmDiffSummary/settings';
import { scmComparisonSourceOf } from '@/sync/domains/scm/diffSummary/selection';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import {
    applySavedScmDiffSummaryResult,
    generateScmDiffSummaryFromUserAction,
    refreshScmDiffSummaryRun,
    type ScmDiffSummaryOperationResult,
} from '@/sync/ops/scmDiffSummary/generate';
import { createScmDiffSummaryResultOperations, type ScmDiffSummaryHost } from '@/sync/ops/scmDiffSummary/results';
import { subscribeExecutionRunActivity } from '@/sync/runtime/executionRuns/executionRunActivityBus';
import { t } from '@/text';
import { SCM_DIFF_SUMMARY_DISABLED_FAILURE, selectScmDiffSummaryProducerModel } from '@/sync/domains/scm/diffSummary/state';
import { scmComparisonKey } from './filesComparison';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { useScmReviewModelChoice } from './useSessionScmReviewTabState';
import { useSessionSelector } from '@/sync/store/hooks';
import { resolveSessionActionDefaultBackend } from '@/sync/domains/session/resolveSessionActionDefaultBackend';
import type { Session } from '@/sync/domains/state/storageTypes';

const AUTO_CHOICE: LlmTaskRunnerChoiceV1 = Object.freeze({ v: 1, mode: 'auto' });

function readSessionAgentTargetKey(session: Session | null): string | null {
    const resolved = session ? resolveSessionActionDefaultBackend({ session }) : null;
    const target = resolved?.agentTarget ?? resolved?.backendTarget;
    try { return target ? buildBackendTargetKeyV2(target) : null; } catch { return null; }
}

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
    /** Why runs cannot launch from this host, when its launch owner says (a Session's launchability). */
    launch: Readonly<{ canLaunchExecutionRuns: boolean; launchUnavailableReason?: SessionExecutionRunLaunchUnavailableReason | null }>;
    serverId?: string | null;
    paneScopeId?: string;
    /** Null while the view is not mounted in front; nothing is read or restored then. */
    comparison: SessionScmReviewComparison | null;
    output: ScmDiffSummaryOutputKind;
    restoration?: ScmWalkthroughRestoration;
    restoreSelections?: readonly ScmWalkthroughSelection[];
}>) {
    const { host, serverId, comparison, output, machine, machineReachable, launch } = params;
    const sessionId = 'sessionId' in host ? host.sessionId : null;
    // The hosting Session's own Agent: Auto stays on it, and the picker's "currently" reads the same input.
    const sessionAgentTargetKey = useSessionSelector(sessionId ?? '', serverId, readSessionAgentTargetKey);
    const binding = useServerCredentialAccountScopeBinding(serverId).binding;
    const scope = binding?.isCurrent() ? binding.scope : null;
    const canControl = Boolean(scope) && params.canControl;
    const canSend = canControl && params.canSend;
    const comparisonKey = comparison ? scmComparisonKey(comparison) : null;
    const hostKey = JSON.stringify([scope?.serverId, scope?.accountId, sessionId, host.machineId, machine?.basePath,
        comparisonKey, output]);
    const currentHostKey = React.useRef<string | null>(hostKey);
    currentHostKey.current = hostKey;
    const isCurrent = React.useCallback(() => binding?.isCurrent() === true && currentHostKey.current === hostKey, [binding, hostKey]);
    React.useEffect(() => {
        currentHostKey.current = hostKey;
        return () => { if (currentHostKey.current === hostKey) currentHostKey.current = null; };
    }, [hostKey]);
    const explainEnabled = useSetting(SCM_DIFF_SUMMARY_SETTING_KEYS.enabled) !== false;
    const storedSetting = useSetting(SCM_DIFF_SUMMARY_SETTING_KEYS.runner);
    const storedChoice = React.useMemo(() => {
        const parsed = LlmTaskRunnerChoiceV1Schema.safeParse(storedSetting ?? null);
        return parsed.success ? parsed.data : null;
    }, [storedSetting]);
    const { chosenModel, setModel } = useScmReviewModelChoice(hostKey, JSON.stringify(storedChoice), params.paneScopeId);
    const [starting, setStarting] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    const [inputObservation, setInputObservation] = React.useState<Readonly<{ hostKey: string; runId: string; inputId: string; resultId: string }> | null>(null);
    const onRunAdmitted = React.useCallback((observation: Readonly<{ runId: string; inputId: string; resultId: string }>) => {
        if (!sessionId && isCurrent()) setInputObservation({ hostKey, ...observation });
    }, [sessionId, isCurrent, hostKey]);
    React.useEffect(() => { setStarting(false); setError(null); }, [hostKey]);
    const { viewModels, restoration } = useScmWalkthroughStates(sessionId ? { sessionId } : { machineId: host.machineId!, cwd: machine?.basePath ?? '' }, [
        { comparison, output },
        // Proposing can extend a saved reading even when it has no commitPlan yet.
        { comparison: output === 'commitPlan' ? comparison : null, output: 'walkthrough' },
        ...(params.restoreSelections ?? []),
    ], serverId, params.restoration);
    const viewModel = viewModels[0] ?? null;
    const { retryRestore, machineReachability } = restoration;
    const restoreState = !comparison ? 'idle' : viewModel ? 'ready' : restoration.restoreState;
    const producer = selectScmDiffSummaryProducerModel(viewModel);
    const observedSelection = ProviderBoundModelRefSchema.safeParse(producer.backendTarget && producer.modelId
        && !producer.selection?.modelSelection?.providerConnectionId && !viewModel?.latestRun?.resolvedSelection?.teamCredentialModel
        ? { agentTargetKey: buildBackendTargetKeyV2(readBackendTargetRefV2(producer.backendTarget)), providerConnectionId: null, modelId: producer.modelId } : null);
    // An explicit per-run choice (including Auto) wins. Otherwise keep the Account preference, or reuse the
    // displayed producer with its recorded authentication rather than turning a saved retry into fresh Auto.
    // A model-only observation may label the reading, but cannot reconstruct its authentication.
    const recordedChoice = React.useMemo<LlmTaskRunnerChoiceV1 | null>(() => observedSelection.success && producer.selection?.connectedServices !== undefined
        ? { v: 1, modelSelection: observedSelection.data, connectedServices: producer.selection.connectedServices } : null,
    [observedSelection.success ? JSON.stringify(observedSelection.data) : null, JSON.stringify(producer.selection?.connectedServices)]);
    const model: LlmTaskRunnerChoiceV1 = chosenModel ?? (storedChoice && !isLlmTaskRunnerAutoV1(storedChoice) ? storedChoice : recordedChoice ?? storedChoice ?? AUTO_CHOICE);
    const generationFailure = viewModel?.error && !(viewModel.error.reason === 'disabled' && explainEnabled) ? viewModel.error : null;
    const capturedComparison = viewModel?.comparison ?? null;
    const cwd = capturedComparison?.repository.rootPath ?? machine?.basePath ?? null;
    const operations = React.useMemo(() => scope ? createScmDiffSummaryResultOperations({ ...host,
        serverId: scope.serverId, accountId: scope.accountId, shouldContinue: isCurrent, onRunAdmitted }) : null,
        [isCurrent, onRunAdmitted, sessionId, host.machineId, scope?.serverId, scope?.accountId]);

    /** `pullRequestDraft` asks the host to write the summary's pull request description from the repository template and recorded Session outcomes. */
    const onStart = React.useCallback(async (outputs: readonly ScmDiffSummaryOutputKind[] = [output], options: Readonly<{ pullRequestDraft?: Readonly<{ providerId?: string }> }> = {}): Promise<ScmDiffSummaryOperationResult | null> => {
        if (!isCurrent() || !scope || !cwd || !comparison || (!viewModel && restoreState !== 'ready') || !canSend || !launch.canLaunchExecutionRuns || starting) return null;
        setStarting(true); setError(null);
        let draftAccount: Awaited<ReturnType<typeof captureLazyActionAccountContext>> | null = null;
        try {
            if (!sessionId && (comparison.kind === 'session' || comparison.kind === 'turnCheckpoint')) return null;
            if (options.pullRequestDraft) {
                // A form can move while its request is pending. Publication belongs to its captured Account, not that placement.
                draftAccount = await captureLazyActionAccountContext(scope.serverId);
                if (!areServerAccountScopesEqual(draftAccount.accountOnlyLifetime.scope, scope)) throw new Error(t('walkthroughStart.unavailable'));
            }
            const source = scmComparisonSourceOf(comparison, sessionId ?? '');
            // Auto sends no model: the executing machine's task-runner owner picks on the Session's own Agent.
            const explicit = isLlmTaskRunnerAutoV1(model) ? null : model;
            return await generateScmDiffSummaryFromUserAction({ ...host, serverId: scope.serverId, scope,
                shouldContinue: draftAccount?.accountOnlyLifetime.isCurrent ?? isCurrent,
                ...(explicit ? { backendTarget: readBackendTargetRefV2(parseBackendTargetKeyV2(explicit.modelSelection.agentTargetKey)) } : {}),
                input: { cwd, source, ...(comparison.comparisonId ? { comparisonId: comparison.comparisonId } : {}),
                    outputs: [...outputs], ...(options.pullRequestDraft ? { pullRequestDraft: options.pullRequestDraft } : {}),
                    ...(explicit ? { modelSelector: projectScmDiffSummaryModelSelector(explicit) } : {}) },
                settings: { ...getStorage().getState().settings, [SCM_DIFF_SUMMARY_SETTING_KEYS.runner]: explicit ?? model },
                intent: viewModel ? 'regenerate' : 'generate' });
        } catch (failure) {
            if (isCurrent()) setError(failure instanceof Error ? failure.message : t('walkthroughStart.unavailable'));
            return null;
        } finally { draftAccount?.dispose(); if (isCurrent()) setStarting(false); }
    }, [binding, isCurrent, scope?.serverId, scope?.accountId, cwd, comparison, sessionId, host.machineId, output, canSend, launch.canLaunchExecutionRuns, starting, model, Boolean(viewModel), restoreState]);

    const key = viewModel?.requestKey;
    const resultId = viewModel?.resultId;
    const runId = viewModel?.executionRunId ?? null;
    const linkedRunId = runId && (!viewModel?.savedResult || viewModel.savedResult.output.runId === runId) ? runId : null;
    const initialInputId = viewModel?.inputId ?? null;
    const cancelGeneration = React.useCallback(async () => {
        if (!sessionId || !scope || !runId || !isCurrent()) return false;
        try {
            const actions: typeof import('@/sync/ops/actions/frontDoorRuntimeActionExecutor') = await import('@/sync/ops/actions/frontDoorRuntimeActionExecutor');
            if (!isCurrent()) return false;
            const response = await actions.createFrontDoorActionExecute()('execution.run.stop', { sessionId, runId }, {
                surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
                serverId: scope.serverId, expectedAccountId: scope.accountId, defaultSessionId: sessionId,
                externalActionTarget: { kind: 'session', sessionId },
            });
            if (!isCurrent()) return false;
            actions.requireActionSuccess(response);
            setError(null);
            return true;
        } catch (failure) {
            if (isCurrent()) setError(failure instanceof Error ? failure.message : t('walkthroughStart.unavailable'));
            return false;
        }
    }, [sessionId, scope, runId, isCurrent]);
    // Recheck the same saved receipt. A missing acknowledgement never authorizes another Start.
    const checkAdmission = React.useCallback(async (admittedResultId = resultId) => {
        if (!operations || !cwd || !key || !admittedResultId || !isCurrent()) return;
        try {
            const response = await operations.read({ cwd, resultId: admittedResultId });
            if (!isCurrent()) return;
            if (response.success) { applySavedScmDiffSummaryResult(key, response.result); setError(null); }
            else setError(response.error);
        } catch (failure) {
            if (isCurrent()) setError(failure instanceof Error ? failure.message : t('walkthroughStart.unavailable'));
        }
    }, [operations, cwd, key, resultId, isCurrent]);
    // Run activity refreshes Run state; the exact result-revision push owns saved content.
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
                if (runId && current()) {
                    const input = inputObservation?.hostKey === hostKey && inputObservation.resultId === resultId && inputObservation.runId === runId
                        ? inputObservation : null;
                    const state = viewModel.outputs?.walkthrough?.state;
                    const waitForOutput = !sessionId && viewModel.comparison && (state === 'pending' || state === 'writing')
                        ? { kind: 'review_walkthrough' as const, comparisonId: viewModel.comparison.id,
                            ...(resultId ? { resultId } : {}), ...(viewModel.revision !== null ? { afterRevision: viewModel.revision } : {}) } : undefined;
                    const waitForInputId = input?.inputId ?? (!sessionId ? initialInputId : null);
                    await refreshScmDiffSummaryRun({ key, ...host, serverId: scope.serverId, scope,
                        runId, signal: abort.signal, shouldContinue: current,
                        ...(waitForInputId ? { waitForInputId } : {}), ...(waitForOutput ? { waitForOutput } : {}) });
                    if (input && current()) setInputObservation(previous => previous === input ? null : previous);
                }
            } catch (failure) {
                if (current()) setError(failure instanceof Error ? failure.message : t('walkthroughStart.unavailable'));
            } finally {
                pending = false;
                if (invalidated && current()) { invalidated = false; void refresh(); }
            }
        };
        // Restoration owns the initial full-result read, including revalidation on remount/reconnect.
        // Run observation consumes the admitted record and keeps Stop/Retry state current.
        void refresh();
        const unsubscribe = sessionId ? subscribeExecutionRunActivity({ sessionId, serverId: scope.serverId }, notification => {
            if (notification.runId && linkedRunId && notification.runId !== linkedRunId) return;
            void refresh();
        }) : () => {};
        return () => { abort.abort(); unsubscribe(); };
    }, [binding, isCurrent, hostKey, inputObservation, initialInputId, scope?.serverId, scope?.accountId, machineReachable, key, resultId, runId, linkedRunId, operations, cwd, sessionId, host.machineId]);

    return {
        host, serverId, comparison, paneScopeId: params.paneScopeId,
        binding, isCurrent, scope, machine, machineReachable, canControl, canSend, launch, viewModel, capturedComparison, cwd, operations,
        restoreState, restoreFailure: restoration.restoreFailure ?? null, retryRestore, machineReachability, restoration,
        admission: viewModel?.admission ?? null, checkAdmission, cancelGeneration,
        error, setError,
        /** The typed refusal or failure of the comparison's generation; never its diagnostic code or message. */
        generationFailure,
        /**
         * Why Start cannot run at all: Explain changes is off. Start stays unavailable and says how to turn it on;
         * an action that still reaches the generation owner (Refresh, Try again) is refused there with the same
         * typed failure, which `generationFailure` then carries.
         */
        startBlocker: explainEnabled ? null : SCM_DIFF_SUMMARY_DISABLED_FAILURE,
        /** The per-run runner choice (Auto unless chosen); the executing machine resolves Auto. */
        model, setModel, sessionAgentTargetKey, starting, onStart,
    } as const;
}
