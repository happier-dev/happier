import { ActionApprovalRequestCreatedResultSchema, ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { ProjectWorkerActionInputSchemasV1, ProjectWorkerActionOutputSchemasV1 } from '@happier-dev/protocol/actions/specs/projectWorkers';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import type { AccountScopedCryptoMaterial } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { createWorkspaceExecutionConfigClientV1 } from '@happier-dev/protocol/workspaces/workspaceExecutionConfigClientV1';
import { observeProjectServicePlacementActualV1 } from '@happier-dev/protocol/workspaces/projectServicePlacementV1';
import { getRandomBytes } from '@/platform/cryptoRandom';
import { createWorkspaceExecutionConfigApiV1 } from '@/sync/api/workspaces/workspaceExecutionConfig';
import { resolveAccountScopedCryptoMaterialFromCredentials } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';
import { areServerProfileIdentifiersEquivalent, getActiveServerSnapshot, resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { storage } from '@/sync/domains/state/storage';
import { readCurrentProjectAccountRows } from '@/sync/store/domains/projectAccountRows';
import { fetchLocalServiceLauncherSnapshotViaMachineRpc } from '@/sync/domains/local/services/launch/machineRpc';
import { machineWorkerPolicyGet, machineWorkerPolicySet } from '@/sync/ops/machineFinitePolicy';
import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import type { LazyActionAccountContext } from './actionAccountContext';

/** Account Action port; row content is never published into a consumer-owned settings cache. */
export function createUiProjectWorkerActionV1(account: LazyActionAccountContext): NonNullable<ActionExecutorDeps['projectWorkerAction']> {
    return async ({ actionId, input, signal, context }) => {
        account.assertCurrent();
        if (actionId === 'projects.worker.status' || actionId === 'projects.worker.copy.inspect' || actionId === 'projects.worker.copy.retire') {
            const request = ProjectWorkerActionInputSchemasV1[actionId].parse(input);
            const machineId = 'destination' in request ? request.destination.machineId : request.machineId;
            if (!areServerProfileIdentifiersEquivalent(request.workspace.serverId, account.serverId)) {
                return { ok: false, errorCode: 'action_account_scope_changed', error: 'action_account_scope_changed' };
            }
            if (context.externalActionTarget && (context.externalActionTarget.kind !== 'machine'
                || context.externalActionTarget.machineId !== machineId)) {
                return { ok: false, errorCode: 'target_not_local', error: 'target_not_local' };
            }
            const spec = getActionSpec(actionId);
            const method = spec.bindings?.rpcMethod;
            if (!method) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
            const raw = await machineRpcWithServerScope({
                serverId: account.serverId, machineId, accountId: account.accountId, method, payload: request,
                ...(signal ? { signal } : {}),
            });
            account.assertResultCurrent(spec.sideEffectClass);
            const failure = ActionExecuteFailureSchema.safeParse(raw);
            if (failure.success) return failure.data;
            const approval = ActionApprovalRequestCreatedResultSchema.safeParse(raw);
            if (approval.success && approval.data.actionId === actionId) return approval.data;
            const output = ProjectWorkerActionOutputSchemasV1[actionId].safeParse(raw);
            if (!output.success || ('candidate' in output.data && output.data.eligible
                && (!areServerProfileIdentifiersEquivalent(output.data.candidate.serverId, request.workspace.serverId)
                    || output.data.candidate.machineId !== machineId))
                || ('targetMachineId' in request && 'preview' in output.data && output.data.ok
                    && (output.data.preview.targetMachineId !== request.targetMachineId || output.data.preview.workspaceRefId !== request.targetWorkspaceRefId))) {
                const errorCode = actionId === 'projects.worker.copy.retire' ? 'outcome_unknown' : 'invalid_action_output';
                return { ok: false, errorCode, error: errorCode };
            }
            return output.data;
        }
        if (actionId === 'machines.worker.policy.get' || actionId === 'machines.worker.policy.set') {
            const parsed = ProjectWorkerActionInputSchemasV1[actionId].parse(input);
            const active = getActiveServerSnapshot();
            const scope = storage.getState().profileScope;
            // The incumbent Machine metadata port is active-Home bound, unlike the row transport.
            if (!areServerProfileIdentifiersEquivalent(parsed.serverId, account.serverId)
                || !areServerProfileIdentifiersEquivalent(active.serverId, account.serverId)
                || !scope || scope.accountId !== account.accountId || !areServerProfileIdentifiersEquivalent(scope.serverId, account.serverId)) {
                return { status: 'unavailable' };
            }
            if (actionId === 'machines.worker.policy.get') {
                const result = await machineWorkerPolicyGet(parsed.machineId, { signal, isCredentialCurrent: account.accountLifetime.isCurrent });
                return account.accountLifetime.isCurrent() ? result : { status: 'unavailable' };
            }
            const mutation = ProjectWorkerActionInputSchemasV1['machines.worker.policy.set'].parse(input);
            const result = await machineWorkerPolicySet(mutation.machineId, {
                expectedPolicy: mutation.expectedPolicy, expectedMetadataVersion: mutation.expectedMetadataVersion, policy: mutation.policy,
            }, { signal, isCredentialCurrent: account.accountLifetime.isCurrent });
            // The metadata port verifies any applied receipt and independently
            // fences publication; Account retirement cannot erase that receipt.
            return result;
        }
        if (actionId !== 'projects.worker.preferences.get' && actionId !== 'projects.worker.preferences.set'
            && actionId !== 'projects.worker.preferences.reset' && actionId !== 'projects.service.placement.get'
            && actionId !== 'projects.service.placement.set') {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
        }
        const parsed = ProjectWorkerActionInputSchemasV1[actionId].parse(input);
        if (!areServerProfileIdentifiersEquivalent(parsed.workspace.serverId, account.serverId)) return { status: 'unavailable' };
        let mode: 'plain' | 'e2ee';
        let material: AccountScopedCryptoMaterial | null = null;
        try { mode = (await account.resolveAccountEncryption()).accountMode; }
        catch { return { status: 'unavailable' }; }
        if (mode === 'e2ee') {
            try { material = resolveAccountScopedCryptoMaterialFromCredentials(account.credentials); }
            catch { return { status: account.accountLifetime.isCurrent() ? 'locked' : 'unavailable' }; }
        }
        const client = createWorkspaceExecutionConfigClientV1({
            mode, material, randomBytes: getRandomBytes, signal,
            isCurrent: () => account.accountLifetime.isCurrent(),
            transport: createWorkspaceExecutionConfigApiV1({ request: account.request }),
        });
        if (actionId === 'projects.service.placement.get') {
            const request = ProjectWorkerActionInputSchemasV1[actionId].parse(input);
            const desired = await client.getService(request);
            if (desired.status !== 'ready') return desired;
            const unavailable = { ...desired, actual: { status: 'unavailable' as const } };
            const rows = readCurrentProjectAccountRows(storage.getState());
            if (context.externalActionCredential || context.externalActionExecutionAuthorization || !rows || rows.status !== 'ready'
                || rows.coverage !== 'complete' || rows.scope.accountId !== account.accountId
                || !areServerProfileIdentifiersEquivalent(rows.scope.serverId, account.serverId)) return unavailable;
            const isCurrent = () => account.accountLifetime.isCurrent()
                && readCurrentProjectAccountRows(storage.getState()) === rows;
            const actual = await observeProjectServicePlacementActualV1({ ...request,
                workspaceRefs: rows.workspaceRefs, relationships: rows.relationships, isCurrent,
                context: { normalizeServerId: resolveServerProfileScopeIdForIdentifier },
                readSnapshot: async snapshot => {
                    const result = await fetchLocalServiceLauncherSnapshotViaMachineRpc({ ...snapshot,
                        serverId: account.serverId, accountId: account.accountId, signal });
                    if (!result.ok) throw new Error('Project Service binding read is unavailable');
                    return { protocolVersion: 1, snapshot: result.snapshot };
                },
            });
            return account.accountLifetime.isCurrent() ? { ...desired, actual } : { status: 'unavailable' };
        }
        if (actionId === 'projects.service.placement.set') return await client.setService(ProjectWorkerActionInputSchemasV1[actionId].parse(input));
        if (actionId === 'projects.worker.preferences.get') return await client.get(ProjectWorkerActionInputSchemasV1[actionId].parse(input));
        if (actionId === 'projects.worker.preferences.set') return await client.set(ProjectWorkerActionInputSchemasV1[actionId].parse(input));
        if (actionId === 'projects.worker.preferences.reset') return await client.reset(ProjectWorkerActionInputSchemasV1[actionId].parse(input));
        return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
    };
}
