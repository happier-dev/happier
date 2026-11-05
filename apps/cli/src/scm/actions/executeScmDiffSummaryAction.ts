import { EXECUTION_RUN_KIND_BY_INTENT } from '@happier-dev/protocol/execution/runs/startRequest';
import { ExecutionRunStartResponseSchema, ExecutionRunStartFailureDetailsV1Schema, readExecutionRunStartRunCreation, withExecutionRunStartFailureDetails } from '@happier-dev/protocol/execution/runs/responseSchemas';
import { randomUUID } from 'node:crypto';
import { ScmDiffSummaryGenerateOutputSchema, ScmDiffSummaryFailureReasonCodeSchema, buildScmDiffSummaryCacheKey, SCM_DIFF_SUMMARY_CACHE_SCHEMA_VERSION } from '@happier-dev/protocol/scm/diffSummary';
import { ActionApprovalRequestCreatedResultSchema, readUnexpectedActionErrorDiagnosticV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import type { ActionExecuteResult, BackendTargetRefV2, ScmDiffSummaryGenerateInput, ScmDiffSummaryGenerateOutput, ScmDiffSummaryOutputKind, ScmDiffSummaryOutputs } from '@happier-dev/protocol';

import { captureScmComparison, readCapturedScmComparison } from '@/scm/comparisons/captureScmComparison';
import type { ReadRepositoryCheckpointTranscriptPage } from '@/scm/checkpoints/readRepositoryCheckpointTranscriptPage';
import type { ReadPullRequestComparisonPage } from '@/scm/comparisons/readPullRequestComparisonPage';
import { scmDiffSummaryResultStore } from '@/agent/executionRuns/tasks/scmDiffSummary/results/resultStore';
import { createCliSettingsCatalogServices } from '@/session/actions/settingsCatalogServices';
import { getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { resolveScmDiffSummaryModelSelection, resolveScmDiffSummarySettings, SCM_DIFF_SUMMARY_SETTING_KEYS } from '@happier-dev/protocol/actions/settings/scmDiffSummarySettings';
import { ProviderDefaultModelSelectionsByAgentTargetKeyV1StoredSchema } from '@happier-dev/protocol/providers/selection/v1';
import type { StoredCredentials } from '@/persistence';
import { loadScmPullRequestDraftEvidence } from '@/agent/runtime/bridges/executionRun/kinds/scmDiffSummary/loadScmDiffSummaryContext';
import { logger } from '@/ui/logger';

type ExecuteCanonicalAction = (
    actionId: 'execution.run.start' | 'scm.pullRequest.openCompose',
    input: unknown,
) => Promise<ActionExecuteResult>;

/** Capture once at the host, then admit the canonical retained analysis run. */
export async function executeScmDiffSummaryAction(params: Readonly<{
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
    let backendTarget = params.backendTarget;
    if (!selector?.modelId && !selector?.profileId) {
        const storedValue = selector?.backendTargetKey ? '' : settings[SCM_DIFF_SUMMARY_SETTING_KEYS.modelProfileOverride];
        const catalog = await createCliSettingsCatalogServices({ signal: params.signal, credentials: params.credentials }).readScmDiffSummaryCatalog?.(settings, storedValue);
        const profiles = selector?.backendTargetKey
            ? catalog?.profiles.filter(profile => profile.modelSelector?.backendTargetKey === selector?.backendTargetKey)
            : catalog?.profiles;
        const selection = resolveScmDiffSummaryModelSelection({ storedValue, defaultBackendTarget: backendTarget,
            catalogProfiles: profiles ?? [] });
        const defaultAvailable = selection.success && catalog?.isCurrent(getActiveAccountSettingsSnapshot()?.settings ?? settings);
        if (!defaultAvailable && (!sessionId || !backendTarget)) {
            return failure('Diff-summary model is unavailable', 'MODEL_UNAVAILABLE');
        }
        if (defaultAvailable && selection.success) {
            backendTarget = selection.backendTarget;
            selector = selection.modelSelector;
        }
    }
    const key = buildScmDiffSummaryCacheKey({ source: { kind: 'comparison', comparisonId: captured.comparison.id },
        summarySchemaVersion: SCM_DIFF_SUMMARY_CACHE_SCHEMA_VERSION, outputs: requestedOutputs, scopeKey: sessionId,
        investigateSurroundingFiles,
        ...(outputLanguage ? { outputLanguage } : {}),
        resolvedSelector: { catalogId: JSON.stringify({ backendTargetKey: backendTarget ? buildBackendTargetKeyV2(backendTarget) : null,
            modelId: selector?.modelId ?? 'default', ...(selector?.profileId ? { profileId: selector.profileId } : {}) }) },
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
        const startInput = {
            sessionId: sessionId ?? null,
            ...(!sessionId ? { machineId: params.machineId, cwd: params.request.cwd } : {}),
            kind: EXECUTION_RUN_KIND_BY_INTENT.scm_diff_summary,
            intent: 'scm_diff_summary',
            localInputId: inputId,
            backendTarget: sessionId && !params.request.modelSelector?.modelId && !params.request.modelSelector?.profileId
                ? params.backendTarget ?? backendTarget : backendTarget,
            permissionMode: 'read_only',
            retentionPolicy: 'resumable',
            runClass: 'long_lived',
            ioMode: 'streaming',
            ...(selector?.profileId ? { profileId: selector.profileId } : {}),
            // Automatic summary defaults are fallback input. A known attached
            // parent supplies its applied model at the runner admission owner.
            ...(selector?.modelId && (!sessionId || params.request.modelSelector?.modelId) ? { modelId: selector.modelId } : {}),
            // Only a host-owned saved evidence id crosses admission, never client diff bytes.
            intentInput: { ...params.request, outputs: requestedOutputs, investigateSurroundingFiles,
                ...(params.request.pullRequestDraft ? { cachePolicy: { mode: 'bypass' } } : {}),
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
        let startResult = await start(startInput);
        // Losing Start's observation does not revoke its saved revision: that
        // same request may still be preparing or publishing on the receiver.
        if (!startResult.ok && startResult.errorCode === 'execution_run_parent_selection_unavailable'
            && readExecutionRunStartRunCreation(startResult.details) === 'noRunCreated'
            && !params.request.modelSelector?.modelId && !params.request.modelSelector?.profileId && selector?.modelId) {
            // A different default Agent must pass the canonical Action gate itself.
            // Only a proven empty admission permits this fallback; an unknown
            // outcome must never create another Run for the captured comparison.
            const defaults = ProviderDefaultModelSelectionsByAgentTargetKeyV1StoredSchema.safeParse(
                settings.providerDefaultModelSelectionsByAgentTargetKeyV1 ?? {},
            );
            if (!defaults.success) return failed('Diff-summary model is unavailable');
            const agentTargetKey = buildBackendTargetKeyV2(backendTarget);
            startResult = await start({
                ...startInput,
                backendTarget,
                modelId: selector.modelId,
                modelSelection: {
                    ...(defaults.data[agentTargetKey]?.ref ?? { agentTargetKey, providerConnectionId: null }),
                    modelId: selector.modelId,
                },
            });
        }
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
