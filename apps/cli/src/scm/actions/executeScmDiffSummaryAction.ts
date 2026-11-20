import { EXECUTION_RUN_KIND_BY_INTENT } from '@happier-dev/protocol/execution/runs/startRequest';
import { ExecutionRunStartResponseSchema, ExecutionRunStartFailureDetailsV1Schema, readExecutionRunStartRunCreation, withExecutionRunStartFailureDetails } from '@happier-dev/protocol/execution/runs/responseSchemas';
import { randomUUID } from 'node:crypto';
import { ScmDiffSummaryGenerateOutputSchema, ScmDiffSummaryFailureReasonCodeSchema, buildScmDiffSummaryCacheKey, SCM_DIFF_SUMMARY_CACHE_SCHEMA_VERSION } from '@happier-dev/protocol/scm/diffSummary';
import { ActionApprovalRequestCreatedResultSchema, readUnexpectedActionErrorDiagnosticV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { BackendTargetRefV2Schema, buildBackendTargetKeyV2, parseBackendTargetKeyV2, readBackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import type { ActionExecuteResult, BackendTargetRefV2, ScmDiffSummaryGenerateInput, ScmDiffSummaryGenerateOutput, ScmDiffSummaryOutputKind, ScmDiffSummaryOutputs } from '@happier-dev/protocol';

import { captureScmComparison, readCapturedScmComparison } from '@/scm/comparisons/captureScmComparison';
import type { ReadRepositoryCheckpointTranscriptPage } from '@/scm/checkpoints/readRepositoryCheckpointTranscriptPage';
import type { ReadPullRequestComparisonPage } from '@/scm/comparisons/readPullRequestComparisonPage';
import { scmDiffSummaryResultStore } from '@/agent/executionRuns/tasks/scmDiffSummary/results/resultStore';
import { createCliSettingsCatalogServices } from '@/session/actions/settingsCatalogServices';
import { getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { projectLlmTaskRunnerCandidatesFromCatalog, readScmDiffSummaryRunnerCatalogId, readScmDiffSummaryRunnerChoice, resolveScmDiffSummaryModelSelection, resolveScmDiffSummarySettings, SCM_DIFF_SUMMARY_SETTING_KEYS } from '@happier-dev/protocol/actions/settings/scmDiffSummarySettings';
import { LlmTaskRunnerChoiceV1Schema } from '@happier-dev/protocol/llm/tasks/llmTaskRunnerConfigV1';
import { readLlmTaskPermissionModeV1, resolveLlmTaskRunnerV1 } from '@happier-dev/protocol/llm/tasks/llmTaskRunnerSelection';
import type { StoredCredentials } from '@/persistence';
import { loadScmPullRequestDraftEvidence } from '@/agent/runtime/bridges/executionRun/kinds/scmDiffSummary/loadScmDiffSummaryContext';
import { logger } from '@/ui/logger';
import type { ActionExecutorContext } from '@happier-dev/protocol';
import { readActionPrincipalAccountId } from '@/session/actions/actionPrincipalAccount';
import { readScmAccountScope, runWithScmAccountScope } from '@/scm/accountScope';
import { projectSessionModelRefToExecutionModelSelection } from '@happier-dev/protocol/providers/selection/v2';
import { readAgentCatalogSnapshot } from '@/agent/catalog/snapshot';
import { indexAgentRoutingIdsByContributionIdentity, readAgentRoutingIdForContributionIdentity } from '@/plugins/projection/registry/agentRoutingIdentity';

type ExecuteCanonicalAction = (
    actionId: 'execution.run.start' | 'scm.pullRequest.openCompose',
    input: unknown,
) => Promise<ActionExecuteResult>;

/** Capture once at the host, then admit the canonical retained analysis run. */
export async function executeScmDiffSummaryAction(params: Readonly<{
    actionContext?: ActionExecutorContext;
    request: ScmDiffSummaryGenerateInput;
    sessionId?: string;
    machineId?: string;
    readTranscriptPage?: ReadRepositoryCheckpointTranscriptPage;
    readPullRequestComparisonPage?: ReadPullRequestComparisonPage;
    backendTarget: BackendTargetRefV2 | null;
    executeCanonicalAction: ExecuteCanonicalAction;
    actionRequestId?: string;
    signal?: AbortSignal;
    credentials?: StoredCredentials;
}>): Promise<ScmDiffSummaryGenerateOutput> {
    const accountId = readActionPrincipalAccountId(params.actionContext) ?? readScmAccountScope();
    if (!accountId) return { success: false, errorCode: 'DIFF_UNAVAILABLE', error: 'SCM requester Account is unavailable' };
    return runWithScmAccountScope(accountId, () => executeScmDiffSummaryActionInAccountScope(params),
        params.actionContext?.externalActionExecutionAuthorization);
}

async function executeScmDiffSummaryActionInAccountScope(
    params: Parameters<typeof executeScmDiffSummaryAction>[0],
): Promise<ScmDiffSummaryGenerateOutput> {
    const settings = getActiveAccountSettingsSnapshot()?.settings ?? accountSettingsParse({});
    const resolvedSettings = resolveScmDiffSummarySettings({ storedSettings: settings, catalogProfiles: [] });
    if (!resolvedSettings.enabled) {
        return ScmDiffSummaryGenerateOutputSchema.parse({ success: false, errorCode: 'SCM_DIFF_SUMMARY_DISABLED',
            error: 'SCM diff summary generation is disabled' });
    }
    const sessionId = params.sessionId ?? params.request.sessionId;
    const captured = params.request.comparisonId ? await readCapturedScmComparison({
        cwd: params.request.cwd, comparisonId: params.request.comparisonId, source: params.request.source,
        ...(sessionId ? { sessionId } : {}),
        turnId: params.request.turnId, checkpointReceiptId: params.request.checkpointReceiptId,
        turnEvidenceMode: params.request.turnEvidenceMode,
    }) : await captureScmComparison({
        signal: params.signal,
        ...params.request,
        ...(sessionId ? { sessionId } : {}),
        ...(params.readTranscriptPage ? { readTranscriptPage: params.readTranscriptPage } : {}),
        ...(params.readPullRequestComparisonPage ? { readPullRequestComparisonPage: params.readPullRequestComparisonPage } : {}),
    });
    const requestedOutputs: readonly ScmDiffSummaryOutputKind[] = params.request.pullRequestDraft ? ['summary'] : params.request.outputs ?? ['summary'];
    const envelope = (state: 'pending' | 'failed', reason?: string,
        reasonCode?: NonNullable<ScmDiffSummaryOutputs['summary']>['reasonCode']): ScmDiffSummaryGenerateOutput => {
        const outputs: ScmDiffSummaryOutputs = {};
        for (const kind of requestedOutputs) outputs[kind] = { state, ...(reason ? { reason } : {}), ...(reasonCode ? { reasonCode } : {}) };
        return ScmDiffSummaryGenerateOutputSchema.parse({ success: true, sourceKey: captured.metadata.sourceKey,
            metadata: captured.metadata, comparison: captured.comparison, requestedOutputs, outputs,
            analysis: { suppliedChangeRefs: [], analysedChangeRefs: [], remainingChangeRefs:
                captured.comparison.inventory.files.flatMap(file => file.occurrences.map(occurrence => occurrence.id)) },
            ...(captured.metadata.checkpointReceiptId ? { checkpointReceiptId: captured.metadata.checkpointReceiptId } : {}),
        });
    };
    const failure = (reason: string, errorCode: 'DIFF_UNAVAILABLE' | 'MODEL_UNAVAILABLE' | 'SUMMARY_FAILED' = 'SUMMARY_FAILED',
        reasonCode: NonNullable<ScmDiffSummaryOutputs['summary']>['reasonCode'] = errorCode): ScmDiffSummaryGenerateOutput =>
        ScmDiffSummaryGenerateOutputSchema.parse({ ...envelope('failed', reason, reasonCode), success: false, errorCode,
            error: reason, ...(errorCode === 'MODEL_UNAVAILABLE' ? { nextAction: 'chooseModel' } : {}) });
    const outputLanguage = params.request.outputLanguage ?? resolvedSettings.outputLanguage;
    const investigateSurroundingFiles = params.request.investigateSurroundingFiles ?? resolvedSettings.investigateSurroundingFiles;
    let selector = params.request.modelSelector;
    if (selector?.modelSelection) selector = { ...selector,
        backendTargetKey: selector.modelSelection.agentTargetKey, modelId: selector.modelSelection.modelId };
    let backendTarget = params.backendTarget;
    if (selector?.backendTargetKey && (selector.modelId || selector.profileId)) {
        try {
            const target = parseBackendTargetKeyV2(selector.backendTargetKey);
            if (target.kind === 'backend' || target.definitionId) {
                backendTarget = readBackendTargetRefV2(target);
            } else {
                const agentId = readAgentRoutingIdForContributionIdentity(
                    indexAgentRoutingIdsByContributionIdentity([...readAgentCatalogSnapshot().agentDefinitionsById.values()]), target.identity);
                // Protocol can resolve bundled identities without a host; installed Agents require its active catalog.
                backendTarget = agentId
                    ? BackendTargetRefV2Schema.parse({ kind: 'backend', backendId: agentId, sourceKind: 'built_in' })
                    : readBackendTargetRefV2(target);
            }
        }
        catch { return failure('Diff-summary model target is unavailable', 'MODEL_UNAVAILABLE'); }
    }
    // No per-run model: the stored runner, or Auto through the task-runner owner. Auto stays on the
    // cheapest ready model; the Session's own Agent wins a tie; nothing ready is a typed failure.
    let ownerResolved = false;
    if (!selector?.modelId && !selector?.profileId) {
        const stored = selector?.backendTargetKey ? null : readScmDiffSummaryRunnerChoice(settings);
        const catalog = await createCliSettingsCatalogServices({ signal: params.signal, credentials: params.credentials })
            .readScmDiffSummaryCatalog?.(settings, readScmDiffSummaryRunnerCatalogId(stored));
        const current = () => catalog?.isCurrent(getActiveAccountSettingsSnapshot()?.settings ?? settings) === true;
        if (stored) {
            const selection = resolveScmDiffSummaryModelSelection({ runner: stored, catalogProfiles: catalog?.profiles ?? [] });
            if (!selection.success || !current()) return failure('Diff-summary model is unavailable', 'MODEL_UNAVAILABLE');
            backendTarget = selection.backendTarget;
            selector = selection.modelSelector;
        } else {
            // A per-run Agent without a model is the person's Agent: Auto picks only its models.
            // Otherwise only a hosting Session names an Agent, for the tie-break.
            const chosenAgent = selector?.backendTargetKey ?? null;
            const machine = projectLlmTaskRunnerCandidatesFromCatalog({ profiles: catalog?.profiles ?? [], unavailableTargets: catalog?.unavailableTargets });
            const storedChoice = LlmTaskRunnerChoiceV1Schema.safeParse(settings[SCM_DIFF_SUMMARY_SETTING_KEYS.runner] ?? null);
            const resolved = resolveLlmTaskRunnerV1({ task: 'scm_diff_summary',
                choice: !chosenAgent && storedChoice.success ? storedChoice.data : null,
                unavailableAgents: machine.unavailableAgents,
                candidates: chosenAgent ? machine.candidates.filter(candidate => candidate.modelSelection.agentTargetKey === chosenAgent) : machine.candidates,
                sessionAgentTargetKey: chosenAgent ?? (sessionId && backendTarget ? buildBackendTargetKeyV2(backendTarget) : null) });
            if (!resolved.ok || resolved.source !== 'auto' || !current()) {
                return failure('No ready model for the diff summary on this machine', 'MODEL_UNAVAILABLE', 'LLM_TASK_RUNNER_UNAVAILABLE');
            }
            const selection = resolveScmDiffSummaryModelSelection({ runner: resolved.runner, catalogProfiles: catalog?.profiles ?? [] });
            if (!selection.success) return failure('No ready model for the diff summary on this machine', 'MODEL_UNAVAILABLE', 'LLM_TASK_RUNNER_UNAVAILABLE');
            backendTarget = selection.backendTarget;
            selector = selection.modelSelector;
        }
        ownerResolved = true;
    }
    const key = buildScmDiffSummaryCacheKey({ source: { kind: 'comparison', comparisonId: captured.comparison.id },
        summarySchemaVersion: SCM_DIFF_SUMMARY_CACHE_SCHEMA_VERSION, outputs: requestedOutputs, scopeKey: sessionId,
        investigateSurroundingFiles,
        ...(outputLanguage ? { outputLanguage } : {}),
        resolvedSelector: { catalogId: JSON.stringify({ ...selector,
            backendTargetKey: backendTarget ? buildBackendTargetKeyV2(backendTarget) : null, modelId: selector?.modelId ?? 'default' }) },
    });
    return scmDiffSummaryResultStore.admitGeneration({ cwd: params.request.cwd, ...(sessionId ? { sessionId } : {}), key, outputs: requestedOutputs,
        bypass: Boolean(params.request.pullRequestDraft) || params.request.cachePolicy?.mode === 'bypass', ...(params.signal ? { signal: params.signal } : {}) }, async () => {
        let pullRequestDraftEvidence: string | undefined;
        if (params.request.pullRequestDraft) {
            try {
                pullRequestDraftEvidence = await loadScmPullRequestDraftEvidence({ cwd: params.request.cwd,
                    comparison: captured.comparison, sessionId, providerId: params.request.pullRequestDraft.providerId,
                    readTranscriptPage: params.readTranscriptPage, signal: params.signal,
                    executeCanonicalAction: params.executeCanonicalAction });
            } catch (error) {
                params.signal?.throwIfAborted();
                return failure(error instanceof Error ? error.message : 'Pull request draft evidence is unavailable', 'DIFF_UNAVAILABLE');
            }
        }
        const saved = await scmDiffSummaryResultStore.create({ cwd: params.request.cwd,
            ...(sessionId ? { sessionId } : {}), output: envelope('pending'),
            ...(pullRequestDraftEvidence !== undefined ? { pullRequestDraftEvidence } : {}),
            ...(backendTarget ? { generator: { backendTarget,
                ...(investigateSurroundingFiles ? { investigateSurroundingFiles: true } : {}),
                ...(selector?.profileId ? { profileId: selector.profileId } : {}),
                ...(selector?.modelSelection ? { modelSelection: selector.modelSelection } : {}),
                ...(selector?.connectedServices !== undefined ? { connectedServices: selector.connectedServices } : {}),
                ...(selector?.sessionConfigOptionOverrides !== undefined ? { sessionConfigOptionOverrides: selector.sessionConfigOptionOverrides } : {}),
                ...(selector?.modelId ? { modelId: selector.modelId } : {}) } } : {}),
        });
        const scope = { cwd: params.request.cwd, resultId: saved.resultId, ...(sessionId ? { sessionId } : {}) };
        const latestOutput = async (runId?: string, inputId?: string, admission?: 'outcomeUnknown'): Promise<ScmDiffSummaryGenerateOutput> => {
            const latest = await scmDiffSummaryResultStore.read(scope);
            const output = latest.success ? latest.result.output : saved.output;
            return ScmDiffSummaryGenerateOutputSchema.parse({ ...output, ...(runId ? { runId } : {}),
                ...(!runId && !output.runId && admission ? { admission } : {}),
                ...(output.success && inputId ? { inputId } : {}) });
        };
        const failed = async (reason: string, errorCode?: 'DIFF_UNAVAILABLE' | 'MODEL_UNAVAILABLE',
            reasonCode?: NonNullable<ScmDiffSummaryOutputs['summary']>['reasonCode']): Promise<ScmDiffSummaryGenerateOutput> => {
            // A concurrent manual edit or started/terminal publication owns the newer revision.
            const output = failure(reason, errorCode, reasonCode);
            await scmDiffSummaryResultStore.publishProgress({ ...scope, expectedRevision: saved.revision, output });
            return latestOutput();
        };
        if (!backendTarget) return failed('Diff-summary model target is unavailable', 'MODEL_UNAVAILABLE');
        if (!sessionId && !params.machineId) return failed('Diff-summary generation requires an admitted execution target');
        const inputId = randomUUID();
        // The owner's pick is as binding as a person's: it names the Agent and model this run uses.
        const explicitModelChoice = ownerResolved || Boolean(params.request.modelSelector?.modelId || params.request.modelSelector?.profileId || selector?.modelSelection);
        const { cachePolicy: _cachePolicy, ...intentInput } = params.request;
        const startInput = {
            sessionId: sessionId ?? null,
            ...(!sessionId ? { machineId: params.machineId, cwd: params.request.cwd } : {}),
            kind: EXECUTION_RUN_KIND_BY_INTENT.scm_diff_summary,
            intent: 'scm_diff_summary',
            localInputId: inputId,
            backendTarget: sessionId && !explicitModelChoice
                ? params.backendTarget ?? backendTarget : backendTarget,
            permissionMode: readLlmTaskPermissionModeV1('scm_diff_summary'),
            retentionPolicy: 'resumable',
            runClass: 'long_lived',
            ioMode: 'streaming',
            ...(selector?.profileId ? { profileId: selector.profileId } : {}),
            ...(selector?.modelSelection ? projectSessionModelRefToExecutionModelSelection(selector.modelSelection) : {}),
            ...(selector?.connectedServices !== undefined ? { connectedServices: selector.connectedServices } : {}),
            ...(selector?.sessionConfigOptionOverrides ? { sessionConfigOptionOverrides: selector.sessionConfigOptionOverrides } : {}),
            // A known attached parent supplies its applied model at the runner
            // admission owner; an unusable parent requires an explicit choice.
            ...(selector?.modelId && (!sessionId || explicitModelChoice) ? { modelId: selector.modelId } : {}),
            // Only a host-owned saved evidence id crosses admission, never client diff bytes.
            intentInput: { ...intentInput, outputs: requestedOutputs, investigateSurroundingFiles,
                ...(outputLanguage ? { outputLanguage } : {}), ...(selector ? { modelSelector: selector } : {}), ...(sessionId ? { sessionId } : {}), comparisonId: captured.comparison.id,
                resultId: saved.resultId, expectedRevision: saved.revision },
            waitForCompletion: false,
        };
        const start = async (input: unknown): Promise<ActionExecuteResult> => {
            let result: ActionExecuteResult;
            let outcomeClass: 'started' | 'deferredApproval' | 'refused' | 'threw' | 'malformed';
            let errorClass: string | null = null;
            try {
                result = await params.executeCanonicalAction('execution.run.start', input);
                const approval = result.ok ? ActionApprovalRequestCreatedResultSchema.safeParse(result.result) : null;
                if (approval?.success) {
                    outcomeClass = 'deferredApproval';
                    result = { ok: false, errorCode: 'approval_required', error: 'Execution Run Start requires approval',
                        details: withExecutionRunStartFailureDetails(undefined, 'noRunCreated') };
                } else {
                    outcomeClass = !result.ok ? 'refused'
                        : ExecutionRunStartResponseSchema.safeParse(result.result).success ? 'started' : 'malformed';
                }
            } catch (error) {
                outcomeClass = 'threw';
                errorClass = readUnexpectedActionErrorDiagnosticV1(error).errorClass;
                const details = error && typeof error === 'object' && 'details' in error ? error.details : undefined;
                const code = ScmDiffSummaryFailureReasonCodeSchema.safeParse(
                    error && typeof error === 'object' && 'code' in error ? error.code : undefined);
                result = { ok: false, errorCode: code.success ? code.data : 'action_failed', error: 'Execution Run Start failed',
                    details: withExecutionRunStartFailureDetails(details, readExecutionRunStartRunCreation(details)) };
            }
            if (!result.ok && errorClass === null) {
                const details = ExecutionRunStartFailureDetailsV1Schema.safeParse(result.details);
                errorClass = details.success ? details.data.executionRunStart.errorClass ?? null : null;
            }
            const code = !result.ok ? ScmDiffSummaryFailureReasonCodeSchema.safeParse(result.errorCode) : null;
            logger.infoFile('[scm.diffSummary] nested Start', { resultId: saved.resultId,
                outerRequestId: params.actionRequestId ?? null, actionEntered: true, outcomeClass,
                errorCode: code?.success ? code.data : null, errorClass,
                runCreation: outcomeClass === 'started' ? 'runCreated'
                    : result.ok ? 'outcomeUnknown' : readExecutionRunStartRunCreation(result.details) });
            return result;
        };
        const startResult = await start(startInput);
        // Losing Start's observation does not revoke its saved revision: that
        // same request may still be preparing or publishing on the receiver.
        if (!startResult.ok) {
            const noRunCreated = readExecutionRunStartRunCreation(startResult.details) === 'noRunCreated';
            if (!noRunCreated) return latestOutput(undefined, undefined, 'outcomeUnknown');
            if (noRunCreated && startResult.errorCode === 'execution_run_parent_selection_unavailable'
                && !params.request.modelSelector?.modelId && !params.request.modelSelector?.profileId) {
                return failed('Diff-summary model is unavailable', 'MODEL_UNAVAILABLE');
            }
            // The typed refusal and its reason travel together; the code alone is not a reason.
            const refusal = startResult.error.includes(startResult.errorCode) ? startResult.error
                : `${startResult.errorCode}: ${startResult.error}`;
            const reasonCode = ScmDiffSummaryFailureReasonCodeSchema.safeParse(startResult.errorCode);
            return failed(refusal, startResult.errorCode === 'DIFF_UNAVAILABLE' ? 'DIFF_UNAVAILABLE' : undefined,
                reasonCode.success ? reasonCode.data : 'SUMMARY_FAILED');
        }
        const started = ExecutionRunStartResponseSchema.safeParse(startResult.result);
        return started.success
            ? latestOutput(started.data.runId, inputId)
            : latestOutput(undefined, undefined, 'outcomeUnknown');
    });
}
