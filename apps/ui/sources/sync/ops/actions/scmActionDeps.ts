import { getActionSpec, requiresExplicitScmMachineTarget, isScmDiffSummaryRunAction } from '@happier-dev/protocol/actions/actionSpecs';
import { ScmDiffSummaryResultClearInputSchema, ScmDiffSummaryResultResponseSchema } from '@happier-dev/protocol/scm/diffSummaryResult';
import { executeScmDiffSummaryClear } from '@happier-dev/protocol/scm';
import { ScmComparisonCaptureOutputSchema, ScmReviewedMarkInputSchema, ScmReviewedUnmarkInputSchema, buildScmReviewedMarksKey, createScmReviewedMarksRecordPort, buildScmComparisonSourceKey, buildScmReviewScopeId, buildReviewUnits, ScmStatusSnapshotResponseSchema, ScmDiffFileResponseSchema, type ScmReviewedMarksSource } from '@happier-dev/protocol/scm';
import type { ActionExecutorContext, ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import type { ScmComparison, ScmReviewedUnmarkInput } from '@happier-dev/protocol/scm';
import { RPC_METHODS, resolveSocketRpcSessionAuthorization } from '@happier-dev/protocol/rpc';
import { runMachineScmRpcWithFallback } from '@/sync/ops/scm/machineScm';
import { resolveSessionScmRequestTarget, runSessionScmRpc } from '@/sync/ops/sessionScm';
import type { LazyActionAccountContext } from './actionAccountContext';
import { createAccountKvJsonTransport } from '@/sync/ops/account/accountKvJsonTransport';
import { scmReviewComparisonMatchesSource } from '@/sync/domains/scm/diffSummary/selection';
import { throwIfAborted } from '@/utils/runtime/abortSignals';
import { createUiAccountAction } from './accountActionDeps';

/** Admission and schemas belong to Actions; repository policy belongs to SCM. */
export function createUiScmAction(
    account?: LazyActionAccountContext,
    options?: Readonly<{ onDispatched?: () => void }>,
): NonNullable<ActionExecutorDeps['scmActionExecute']> {
    const requesterAction = account ? createUiAccountAction({ account }) : null;
    const writeReviewedMarks = async (evidence: ScmComparison | ScmReviewedMarksSource,
        selection: ScmReviewedUnmarkInput, reviewed: boolean, context: ActionExecutorContext) => {
        if (!account) return { success: false as const, errorCode: 'reviewed_marks_unavailable', error: 'Captured Account credentials are required for personal reviewed marks.' };
        try {
            const { encryption } = await account.resolveAccountEncryption();
            account.assertCurrent();
            const shouldContinue = () => { try { account.assertCurrent(); throwIfAborted(context.signal); return true; } catch { return false; } };
            const scope = 'id' in evidence ? { repositoryRootPath: evidence.repository.rootPath, source: evidence.source } : evidence;
            const transport = createAccountKvJsonTransport({ key: buildScmReviewedMarksKey(buildScmReviewScopeId(scope)), credentials: account.credentials,
                request: account.request, encryption, shouldContinue });
            const port = createScmReviewedMarksRecordPort('id' in evidence ? { comparison: evidence, transport } : { source: evidence, transport });
            const result = await ('reset' in selection ? port.clear() : 'changeKeys' in selection ? port.setReviewedKeys(selection.changeKeys, reviewed)
                : port.setReviewed(selection.changeRefs, reviewed));
            account.assertResultCurrent('write');
            return result;
        } catch (error) {
            return { success: false as const, errorCode: error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
                ? error.code : 'reviewed_marks_unavailable', error: error instanceof Error ? error.message : 'Reviewed marks are unavailable' };
        }
    };
    return async ({ actionId, input, context }) => {
        throwIfAborted(context.signal);
        account?.assertCurrent();
        const method = getActionSpec(actionId).bindings?.rpcMethod;
        if (!method) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };

        // The canonical Action owner has already parsed this family's request schema.
        const request = input as Readonly<{ cwd?: string; backendPreference?: unknown; destinationParentPath?: string }>;
        const serverId = account?.serverId ?? context.serverId;
        const accountId = account?.accountId ?? context.runtimeAccountId;
        const target = context.externalActionTarget;
        if (actionId === 'scm.diffSummary.reviewed.mark' || actionId === 'scm.diffSummary.reviewed.unmark') {
            if (!account) return { success: false, errorCode: 'reviewed_marks_unavailable', error: 'Captured Account credentials are required for personal reviewed marks.' };
            const selection = (actionId === 'scm.diffSummary.reviewed.mark' ? ScmReviewedMarkInputSchema : ScmReviewedUnmarkInputSchema).parse(input);
            const sessionId = target?.kind === 'session' ? target.sessionId : target?.kind === 'machine' ? undefined : context.defaultSessionId;
            if (!sessionId && target?.kind !== 'machine') return { ok: false, errorCode: 'session_not_selected', error: 'session_not_selected' };
            if ('v' in selection && sessionId && selection.sessionId && selection.sessionId !== sessionId) {
                return { success: false, errorCode: 'reviewed_marks_unavailable', error: 'The captured comparison does not belong to the selected Session.' };
            }
            const read = <T extends Readonly<{ cwd: string }>>(readMethod: string, payload: T) => target?.kind === 'machine'
                ? runMachineScmRpcWithFallback(target.machineId, readMethod, payload, { serverId, accountId, signal: context.signal })
                : runSessionScmRpc(sessionId!, readMethod, { ...payload, cwd: undefined }, serverId, context.signal, accountId);
            const evidence = await (async () => {
                if ('v' in selection && !selection.comparisonId) {
                    if (selection.source.kind !== 'workingTree') return null;
                    const response = ScmStatusSnapshotResponseSchema.safeParse(await read(RPC_METHODS.SCM_STATUS_SNAPSHOT, { cwd: selection.cwd }));
                    account.assertCurrent();
                    if (!response.success || !response.data.success || !response.data.snapshot) return null;
                    const snapshot = response.data.snapshot;
                    const repositoryRootPath = snapshot.repo.rootPath;
                    if (repositoryRootPath === null || repositoryRootPath !== selection.cwd) return null;
                    if ('reset' in selection) return { repositoryRootPath, source: selection.source, changeKeys: [] } satisfies ScmReviewedMarksSource;
                    const groups = await Promise.all(snapshot.entries.map(async entry => (await Promise.all(snapshot.capabilities.supportedDiffAreas.map(async area => {
                        const diff = ScmDiffFileResponseSchema.safeParse(await read(RPC_METHODS.SCM_DIFF_FILE, { cwd: selection.cwd, path: entry.path, area }));
                        account.assertCurrent();
                        if (!diff.success || !diff.data.success) throw new Error('Live change evidence is unavailable.');
                        const layer = area === 'both' ? 'combined' : area === 'included' ? 'staged' : entry.kind === 'untracked' ? 'untracked' : 'unstaged';
                        return buildReviewUnits(entry.path, layer, diff.data.diff ?? '').map(unit => unit.key);
                    }))).flat()));
                    return { repositoryRootPath, source: selection.source, changeKeys: groups.flat() } satisfies ScmReviewedMarksSource;
                }
                if ('v' in selection && selection.comparisonId) {
                    const captured = ScmComparisonCaptureOutputSchema.safeParse(await read(RPC_METHODS.SCM_DIFF_SUMMARY_CAPTURE, {
                        cwd: selection.cwd, comparisonId: selection.comparisonId, source: selection.source,
                        ...(sessionId ?? selection.sessionId ? { sessionId: sessionId ?? selection.sessionId } : {}),
                    }));
                    account.assertCurrent();
                    if (!captured.success || !captured.data.success || captured.data.comparison.id !== selection.comparisonId
                        || captured.data.comparison.repository.rootPath !== selection.cwd) return null;
                    const evidence = captured.data;
                    const retainedSelectors = { cwd: selection.cwd,
                        sessionId: evidence.comparison.source.kind === 'turnCheckpoint' ? evidence.comparison.source.sessionId : undefined,
                        turnId: evidence.metadata.turnId,
                        checkpointReceiptId: evidence.metadata.checkpointReceiptId, turnEvidenceMode: evidence.metadata.turnEvidenceMode };
                    const sourceMatches = selection.source.kind === 'turnCheckpoint'
                        ? buildScmComparisonSourceKey({ ...retainedSelectors, source: selection.source })
                            === buildScmComparisonSourceKey({ ...retainedSelectors, source: evidence.comparison.source })
                        : scmReviewComparisonMatchesSource(selection.source, evidence.comparison.source, evidence.comparison);
                    if (!sourceMatches) return null;
                    return captured.data.comparison;
                }
                if (!('resultId' in selection)) return null;
                const saved = ScmDiffSummaryResultResponseSchema.safeParse(await read(RPC_METHODS.SCM_DIFF_SUMMARY_RESULT_READ,
                    { cwd: selection.cwd, resultId: selection.resultId }));
                account.assertCurrent();
                return saved.success && saved.data.success && saved.data.result.resultId === selection.resultId
                    && saved.data.result.output.comparison?.repository.rootPath === selection.cwd ? saved.data.result.output.comparison : null;
            })();
            if (!evidence) return { success: false, errorCode: 'reviewed_marks_unavailable', error: 'The selected change evidence is unavailable for this caller.' };
            return writeReviewedMarks(evidence, selection, actionId === 'scm.diffSummary.reviewed.mark', context);
        }
        const machineInventory = requiresExplicitScmMachineTarget(actionId);
        if (machineInventory && target?.kind !== 'machine') return { ok: false, errorCode: 'machine_not_selected', error: 'machine_not_selected' };
        if (isScmDiffSummaryRunAction(actionId)) {
            if (!requesterAction) return { ok: false, errorCode: 'admission_unavailable', error: 'admission_unavailable' };
            let requesterContext = context;
            let requesterInput = input;
            if (target?.kind === 'machine') {
                if (!target.machineId.trim() || !request.cwd?.trim()) return { ok: false, errorCode: 'invalid_input', error: 'invalid_input' };
            } else {
                const sessionId = target?.kind === 'session' ? target.sessionId : context.defaultSessionId;
                if (!sessionId) return { ok: false, errorCode: 'session_not_selected', error: 'session_not_selected' };
                const resolved = resolveSessionScmRequestTarget(sessionId, method, { ...request, cwd: undefined }, serverId, accountId);
                if (!resolved.ok) return { ok: false, errorCode: resolved.failure.errorCode, error: resolved.failure.error };
                requesterContext = { ...context, defaultSessionId: sessionId, externalActionTarget: {
                    kind: 'machine', machineId: resolved.machineId, project: { machineId: resolved.machineId, directory: resolved.cwd },
                } };
                requesterInput = { ...request, cwd: resolved.cwd,
                    ...(actionId === 'scm.diffSummary.generate' || actionId === 'scm.diffSummary.draftPullRequest' ? { sessionId } : {}) };
            }
            options?.onDispatched?.();
            return await requesterAction({ actionId, input: requesterInput, context: requesterContext });
        }
        if (target?.kind === 'machine') {
            const cwd = actionId === 'scm.repository.clone' ? request.destinationParentPath : request.cwd;
            if (!target.machineId.trim() || (!machineInventory && !cwd?.trim())) return { ok: false, errorCode: 'invalid_input', error: 'invalid_input' };
            if (actionId === 'scm.diffSummary.result.clear') {
                return executeScmDiffSummaryClear({ input: ScmDiffSummaryResultClearInputSchema.parse(input),
                    assertCurrent: () => { throwIfAborted(context.signal); account?.assertCurrent(); },
                    list: () => runMachineScmRpcWithFallback(target.machineId, RPC_METHODS.SCM_DIFF_SUMMARY_RESULT_LIST,
                        {}, { serverId, accountId, signal: context.signal }),
                    read: item => runMachineScmRpcWithFallback(target.machineId, RPC_METHODS.SCM_DIFF_SUMMARY_RESULT_READ,
                        { cwd: item.cwd, resultId: item.resultId }, { serverId, accountId, signal: context.signal }),
                    delete: item => {
                        options?.onDispatched?.();
                        return runMachineScmRpcWithFallback(target.machineId, RPC_METHODS.SCM_DIFF_SUMMARY_RESULT_DELETE,
                            { cwd: item.cwd, resultId: item.resultId, expectedRevision: item.expectedRevision }, { serverId, accountId, signal: context.signal });
                    },
                    clearReviewedMarks: (comparison, reset) => writeReviewedMarks(comparison, reset, false, context),
                });
            }
            options?.onDispatched?.();
            const result = await runMachineScmRpcWithFallback(target.machineId, method, request, {
                serverId, accountId, signal: context.signal,
                ...(context.defaultSessionId && resolveSocketRpcSessionAuthorization(method)?.optionalSessionScope
                    ? { authorization: { kind: 'session.write', sessionId: context.defaultSessionId } } : {}),
            });
            account?.assertResultCurrent(getActionSpec(actionId).sideEffectClass);
            return result;
        }
        const sessionId = target?.kind === 'session' ? target.sessionId : context.defaultSessionId;
        if (!sessionId) return { ok: false, errorCode: 'session_not_selected', error: 'session_not_selected' };
        // Like the CLI Action adapter, Session Actions cannot substitute another
        // repository. The general SCM facade still owns caller-relative paths.
        const sessionRequest = actionId === 'scm.repository.clone' ? request : { ...request, cwd: undefined };
        options?.onDispatched?.();
        const result = await runSessionScmRpc(sessionId, method, sessionRequest, serverId, context.signal, accountId,
            actionId === 'scm.pullRequest.prepareWorktree' ? (resolved) => ({ ...resolved, sourcePath: resolved.cwd }) : undefined);
        account?.assertResultCurrent(getActionSpec(actionId).sideEffectClass);
        return result;
    };
}
