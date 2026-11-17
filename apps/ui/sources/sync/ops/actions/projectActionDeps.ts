import { PROJECT_ACTION_INPUT_SCHEMAS_V1, PROJECT_ACTION_OUTPUT_SCHEMAS_V1, PROJECT_FINITE_ACTION_RPC_METHODS_V1,
    readProjectSetupTrustRequestOperationV1 } from '@happier-dev/protocol/actions/projectActionFamily';
import { ActionApprovalRequestCreatedResultSchema, ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { resolveProjectActionMachineV1 } from '@happier-dev/protocol/actions/executor/projectActionPlacement';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { readHostReviewedParentV1 } from '@happier-dev/protocol/actions/actionExecutor';
import { projectExternalActionRequesterInvocationV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { randomUUID } from '@/platform/randomUUID';
import { createProjectTrustClientForAccount } from '@/sync/api/account/apiProjectTrust';
import { canUsePrivateProjectAccountAction } from '@/sync/api/projects/projectAccountRowsClient';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { withActionAccountRequestSignal, type LazyActionAccountContext } from './actionAccountContext';
import { executeOriginalAccountMachineAction } from '@/sync/api/externalActionAccountTransport';
import { getActionOperation } from '@/sync/ops/actionOperations';
import { rememberAdmittedProjectSetupConsent } from './projectSetupTrustConsent';

/** Delivery only: the incumbent executor already owns invocation authority, settings and approvals. */
export function createUiProjectAction(account?: LazyActionAccountContext): NonNullable<ActionExecutorDeps['projectAction']> {
    return async ({ actionId, input, context, executeCanonicalAction }) => {
        if (actionId === 'projects.prepare') {
            const request = PROJECT_ACTION_INPUT_SCHEMAS_V1[actionId].safeParse(input);
            if (request.success && request.data.consentScope === 'untilChanged') {
                if (!account || context.authority !== 'present_user' || !canUsePrivateProjectAccountAction(account, context)) {
                    return { ok: false, errorCode: 'present_user_required', error: 'present_user_required' };
                }
                account.assertCurrent();
                const workspace = { ...request.data.workspace, serverId: account.serverId };
                if (!areServerProfileIdentifiersEquivalent(account.serverId, request.data.workspace.serverId)) {
                    return { ok: false, errorCode: 'action_account_scope_changed', error: 'action_account_scope_changed' };
                }
                const response = await getActionOperation({ serverId: account.serverId, accountId: account.accountId,
                    machineId: workspace.machineId, operationId: request.data.heldOperationId!, requireCurrentDomainFacts: true,
                    signal: context.signal });
                account.assertCurrent();
                const retained = readProjectSetupTrustRequestOperationV1({ ...request.data, workspace }, response);
                const source = retained?.domainRef?.kind === 'projectCommand' ? retained.domainRef.sourceWorkspace : undefined;
                if (!retained || retained.scope.accountId !== account.accountId || !source) {
                    return { ok: false, errorCode: 'project_setup_review_unavailable', error: 'project_setup_review_unavailable' };
                }
                const decision = await rememberAdmittedProjectSetupConsent({ scope: { serverId: account.serverId, accountId: account.accountId },
                    workspace: source, reviewedEffectDigest: request.data.expectedEffectDigest!,
                    operation: { serverId: account.serverId, snapshot: retained }, signal: context.signal });
                if (decision.kind === 'remembered') return { operation: decision.operation };
                const code = decision.kind === 'changed' ? 'project_setup_effect_changed'
                    : decision.kind === 'unavailable' ? decision.code : 'project_setup_review_unavailable';
                return { ok: false, errorCode: code, error: code };
            }
        }
        if (actionId !== 'projects.trust.list' && actionId !== 'projects.trust.revoke') {
            if (!account) return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
            context.signal?.throwIfAborted();
            account.assertCurrent();
            const parsed = PROJECT_ACTION_INPUT_SCHEMAS_V1[actionId].safeParse(input);
            if (!parsed.success) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
            // Admission named the Home before review and signing. Delivery preserves those bytes.
            const canonicalInput = parsed.data;
            const originalAccount = !context.externalActionCredential && !context.externalActionExecutionAuthorization
                && !context.rpcSessionAuthorization && (!context.actionCaller || context.actionCaller.kind === 'host');
            const placement = await resolveProjectActionMachineV1({ actionId, input: canonicalInput, context,
                executeCanonicalAction, createRequestKey: randomUUID,
                ...(originalAccount && account.serverIdentityId ? { homeId: account.serverIdentityId } : {}) });
            if (!placement.ok) return placement;
            const { machineId } = placement;
            if (context.externalActionTarget && (context.externalActionTarget.kind !== 'machine'
                || context.externalActionTarget.machineId !== machineId)) {
                return { ok: false, errorCode: 'target_not_local', error: 'target_not_local' };
            }
            account.assertCurrent();
            try {
                if (originalAccount) {
                    if (context.surface !== 'ui' || context.authority !== 'present_user'
                        || !context.actionRequestId || !canUsePrivateProjectAccountAction(account, context)) {
                        return { ok: false, errorCode: 'admission_unavailable', error: 'admission_unavailable' };
                    }
                    const target = context.externalActionTarget?.kind === 'machine'
                        ? context.externalActionTarget : { kind: 'machine' as const, machineId };
                    // The executor consumed the native confirmation at admission;
                    // carry its admitted review through the same private requester projector.
                    const needsInvocation = context.presentUserConfirmation?.inputDigest !== undefined
                        || context.presentUserApproval?.actionId === actionId || Boolean(readHostReviewedParentV1(context));
                    const invocation = needsInvocation ? projectExternalActionRequesterInvocationV1({ actionId,
                        context: { ...context, actionCaller: context.actionCaller ?? { kind: 'host' } }, account, target }) : null;
                    if (needsInvocation && !invocation) return { ok: false, errorCode: 'admission_unavailable', error: 'admission_unavailable' };
                    const execution = await executeOriginalAccountMachineAction({ account, actionId, input: canonicalInput,
                        machineId, machineTarget: target, requestId: context.actionRequestId,
                        ...(invocation ? { invocation } : {}), ...(context.signal ? { signal: context.signal } : {}) });
                    account.assertResultCurrent(getActionSpec(actionId).sideEffectClass);
                    if (!execution.ok) return execution;
                    const approval = ActionApprovalRequestCreatedResultSchema.safeParse(execution.result);
                    if (approval.success && approval.data.actionId === actionId) return approval.data;
                    const result = PROJECT_ACTION_OUTPUT_SCHEMAS_V1[actionId].safeParse(execution.result);
                    return result.success ? result.data : { ok: false, errorCode: 'invalid_action_output', error: 'invalid_action_output' };
                }
                // A hosted origin cannot become this UI's ambient Account.
                // Only its existing typed Session carrier can authorize RPC.
                if (!context.rpcSessionAuthorization) return { ok: false, errorCode: 'admission_unavailable', error: 'admission_unavailable' };
                const raw = await withActionAccountRequestSignal(account, context.signal, signal => machineRpcWithServerScope({ serverId: account.serverId, accountId: account.accountId,
                    authorization: context.rpcSessionAuthorization,
                    machineId, method: PROJECT_FINITE_ACTION_RPC_METHODS_V1[actionId], payload: canonicalInput,
                    requestId: context.actionRequestId ?? undefined, operationTimeoutMs: null,
                    signal,
                }));
                // An actual finite receipt remains the invoker's disposition;
                // Account retirement suppresses projection, not this ACK.
                account.assertResultCurrent(getActionSpec(actionId).sideEffectClass);
                const failure = ActionExecuteFailureSchema.safeParse(raw);
                if (failure.success) return failure.data;
                const approval = ActionApprovalRequestCreatedResultSchema.safeParse(raw);
                if (approval.success && approval.data.actionId === actionId) return approval.data;
                const result = PROJECT_ACTION_OUTPUT_SCHEMAS_V1[actionId].safeParse(raw);
                return result.success ? result.data : { ok: false, errorCode: 'invalid_action_output', error: 'invalid_action_output' };
            } catch (error) {
                const code = readRpcErrorCode(error)
                    ?? (error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'project_transport_unavailable');
                return { ok: false, errorCode: code, error: code };
            }
        }
        if (!account || !canUsePrivateProjectAccountAction(account, context)) return { ok: false, errorCode: 'project_account_access_denied', error: 'project_account_access_denied' };
        const client = createProjectTrustClientForAccount(account);
        try {
            if (actionId === 'projects.trust.list') {
                const request = PROJECT_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input);
                return { trust: await client.list(request.project, context.signal) };
            }
            const request = PROJECT_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input);
            const result = await client.revoke(request, context.signal);
            return { project: request.project, status: result.status === 'updated' ? 'removed' : result.status };
        } catch (error) {
            if (error instanceof Error && 'code' in error && typeof error.code === 'string') return { ok: false, errorCode: error.code, error: error.code };
            return { ok: false, errorCode: 'project_trust_storage_unavailable', error: 'project_trust_storage_unavailable' };
        }
    };
}
