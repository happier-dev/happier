import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { ScmDiffSummaryResultClearInputSchema, ScmDiffSummaryResultClearResponseSchema, ScmDiffSummaryResultResponseSchema, type ScmDiffSummaryResultClearResponse } from '@happier-dev/protocol/scm/diffSummaryResult';
import { isScmCommitPlanApplicationLocked } from '@happier-dev/protocol/scm/diffSummaryCommitPlan';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { runMachineScmRpcWithFallback } from '@/sync/ops/scm/machineScm';
import { runSessionScmRpc } from '@/sync/ops/sessionScm';
import type { LazyActionAccountContext } from './actionAccountContext';

/** Admission and schemas belong to Actions; repository policy belongs to SCM. */
export function createUiScmAction(account?: LazyActionAccountContext): NonNullable<ActionExecutorDeps['scmActionExecute']> {
    return async ({ actionId, input, context }) => {
        context.signal?.throwIfAborted();
        account?.assertCurrent();
        const method = getActionSpec(actionId).bindings?.rpcMethod;
        if (!method) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };

        // The canonical Action owner has already parsed this family's request schema.
        const request = input as Readonly<{ cwd?: string; backendPreference?: unknown; destinationParentPath?: string }>;
        const serverId = account?.serverId ?? context.serverId;
        const accountId = account?.accountId ?? context.runtimeAccountId;
        const target = context.externalActionTarget;
        const machineInventory = actionId === 'scm.diffSummary.result.list' || actionId === 'scm.diffSummary.result.clear';
        if (machineInventory && target?.kind !== 'machine') return { ok: false, errorCode: 'machine_not_selected', error: 'machine_not_selected' };
        if (target?.kind === 'machine') {
            const cwd = actionId === 'scm.repository.clone' ? request.destinationParentPath : request.cwd;
            if (!target.machineId.trim() || (!machineInventory && !cwd?.trim())) return { ok: false, errorCode: 'invalid_input', error: 'invalid_input' };
            if (actionId === 'scm.diffSummary.result.clear') {
                if (!account) return { success: false, errorCode: 'result_unavailable', error: 'Captured Account credentials are required to clear personal reviewed marks.' };
                const selection = ScmDiffSummaryResultClearInputSchema.parse(input);
                const deleted: Extract<ScmDiffSummaryResultClearResponse, { success: true }>['deleted'] = [];
                const failures: Extract<ScmDiffSummaryResultClearResponse, { success: true }>['failures'] = [];
                const current = () => { context.signal?.throwIfAborted(); account.assertCurrent(); };
                const shouldContinue = () => { try { current(); return true; } catch { return false; } };
                for (const item of selection.results) {
                    try {
                        current();
                        const observed = ScmDiffSummaryResultResponseSchema.safeParse(await runMachineScmRpcWithFallback(target.machineId,
                            RPC_METHODS.SCM_DIFF_SUMMARY_RESULT_READ, { cwd: item.cwd, resultId: item.resultId }, { serverId, accountId, signal: context.signal }));
                        current();
                        if (!observed.success) throw new Error('The current saved result could not be validated.');
                        if (!observed.data.success) { failures.push({ ...observed.data, resultId: item.resultId }); continue; }
                        const saved = observed.data.result;
                        if (saved.resultId !== item.resultId || saved.output.comparison?.id !== item.comparisonId) {
                            failures.push({ resultId: item.resultId, success: false, errorCode: 'invalid_edit', error: 'The listed comparison does not identify this saved result.' }); continue;
                        }
                        if (saved.revision !== item.expectedRevision) {
                            failures.push({ resultId: item.resultId, success: false, errorCode: 'revision_conflict', error: 'The saved result changed before Clear.', latestRevision: saved.revision }); continue;
                        }
                        if (isScmCommitPlanApplicationLocked(saved.application)) {
                            failures.push({ resultId: item.resultId, success: false, errorCode: 'application_locked', error: 'Resolve the accepted commit application before clearing its result.' }); continue;
                        }
                        // This is the admitted terminal, not a consumer pre-prepare effect.
                        // Keep the canonical saved identity for retry until Account cleanup succeeds.
                        const { clearScmReviewedMarksForComparisonId } = await import('@/sync/ops/scmDiffSummary/reviewedMarks');
                        current();
                        const { encryption } = await account.resolveAccountEncryption();
                        current();
                        const cleanup = await clearScmReviewedMarksForComparisonId({ comparisonId: item.comparisonId,
                            credentials: account.credentials, request: account.request, encryption, shouldContinue });
                        current();
                        if (!cleanup.success) {
                            failures.push({ resultId: item.resultId, success: false, errorCode: 'result_unavailable',
                                error: `${cleanup.errorCode}: ${cleanup.error}` }); continue;
                        }
                        // A concurrent edit/application may still win: the machine's existing
                        // locked revision/application check remains the deletion authority.
                        const cleared = ScmDiffSummaryResultClearResponseSchema.safeParse(await runMachineScmRpcWithFallback(target.machineId,
                            method, { results: [item] }, { serverId, accountId, signal: context.signal }));
                        current();
                        if (!cleared.success) throw new Error('The saved-result Clear response could not be validated.');
                        if (!cleared.data.success) failures.push({ ...cleared.data, resultId: item.resultId });
                        else {
                            failures.push(...cleared.data.failures);
                            deleted.push(...cleared.data.deleted.map(result => ({ ...result, marksCleanup: result.marksCleanup ?? { success: true } })));
                        }
                    } catch (error) {
                        failures.push({ resultId: item.resultId, success: false, errorCode: 'result_unavailable',
                            error: error instanceof Error ? error.message : 'Saved result or Account marks are unavailable.' });
                    }
                }
                return { success: true, deleted, failures };
            }
            const result = await runMachineScmRpcWithFallback(target.machineId, method, request, {
                serverId, accountId, signal: context.signal,
            });
            account?.assertCurrent();
            return result;
        }
        const sessionId = target?.kind === 'session' ? target.sessionId : context.defaultSessionId;
        if (!sessionId) return { ok: false, errorCode: 'session_not_selected', error: 'session_not_selected' };
        // Like the CLI Action adapter, Session Actions cannot substitute another
        // repository. The general SCM facade still owns caller-relative paths.
        const sessionRequest = actionId === 'scm.repository.clone' ? request : { ...request, cwd: undefined };
        const result = await runSessionScmRpc(sessionId, method, sessionRequest, serverId, context.signal, accountId,
            actionId === 'scm.pullRequest.prepareWorktree' ? (resolved) => ({ ...resolved, sourcePath: resolved.cwd }) : undefined);
        account?.assertCurrent();
        return result;
    };
}
