import { afterEach, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { PROVIDER_ACCOUNT_USAGE_ACCOUNT_CHANGE_ENTITY_ID_V1 } from '@happier-dev/protocol/changes';
import { ManagedMachineV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { installApprovalCommonModuleMocks } from '@/components/approvals/approvalsTestHelpers';
import { flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { invalidateAccountEncryptionModeCache } from '@/sync/api/account/apiAccountEncryptionMode';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { plannedChangesAffectMachineResources, plannedChangesAffectManagedMachineInventory, planSyncActionsFromChanges } from '@/sync/runtime/orchestration/changesPlanner';
import { resetRuntimeFetch } from '@/utils/system/runtimeFetch';
import { useManagedMachineInventory } from './useManagedMachineInventory';

installApprovalCommonModuleMocks();
afterEach(async () => {
    await standardCleanup(); retireActiveServerAccountScopeLifetime(); resetRuntimeFetch();
    invalidateAccountEncryptionModeCache(); vi.restoreAllMocks();
});

it('shares one active/archive inventory and ignores unrelated socket and consumed-page arrivals without losing real changes', async () => {
    const homeId = 'srv_managed_request_cost';
    const rows = Array.from({ length: 128 }, (_, index) => ManagedMachineV1Schema.parse({
        id: `managed-${index}`, homeId, custodianAccountId: 'owner',
        launch: { provider: { pluginId: 'custom.compute', localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} },
        controller: { machineId: 'controller', installationId: 'installation' }, allocation: 'may-exist', creationState: 'active',
        desired: 'start', desiredWhen: 'now', intentRevision: 1,
        retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
        ...(index === 127 ? { archivedAt: 1 } : {}),
    }));
    const homes = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://managed-request-cost.test',
        serverIdentityId: homeId, accountId: 'owner' }], route: request => request.path === '/v1/machines/managed/actions/list'
        ? Response.json({ machines: rows.filter(row => Boolean(row.archivedAt) === Boolean(
            request.body && typeof request.body === 'object' && 'archived' in request.body && request.body.archived)) }) : undefined });
    const serverId = homes.homes.a!.id;
    const realExecute = createDefaultActionExecutor().execute;
    let admissions = 0;
    // Observe the real executor as well as HTTP: superseded admissions still cost work.
    const execute: typeof realExecute = (...args) => {
        if (args[0] === 'machines.managed.list') admissions += 1;
        return realExecute(...args);
    };
    const ids = [serverId];
    const hook = await renderHook(() => ({ first: useManagedMachineInventory(ids, undefined, execute, true),
        second: useManagedMachineInventory(ids, undefined, execute, true) }), { flushOptions: { cycles: 30 } });
    try {
        const requests = () => homes.requests.filter(request => request.path === '/v1/machines/managed/actions/list').length;
        await vi.waitFor(() => expect(hook.getCurrent().first.entries[serverId]?.status).toBe('ready'));
        expect(hook.getCurrent().first.machinesByServerId[serverId]).toHaveLength(128);
        const before = { requests: requests(), admissions };
        for (let index = 0; index < 4; index += 1) {
            await act(async () => publishHomeAccountChange(serverId, ['controller'],
                { source: 'socket', changeKinds: ['machine'] }));
            const plan = planSyncActionsFromChanges([{ kind: 'machine', entityId: 'controller', cursor: index, changedAt: 0 }]);
            expect(plan.invalidate.machines).toBe(true);
            expect(plannedChangesAffectMachineResources(plan)).toBe(true);
            await act(async () => publishHomeAccountChange(serverId, ['controller'],
                { changeKinds: ['machine'], machineResourcesAffect: plannedChangesAffectMachineResources(plan),
                    managedMachineInventoryAffect: plannedChangesAffectManagedMachineInventory(plan) }));
            await flushHookEffects({ cycles: 30 });
            expect({ requests: requests(), admissions }).toEqual(before);
        }
        for (let index = 0; index < 4; index += 1) {
            await act(async () => publishHomeAccountChange(serverId, [PROVIDER_ACCOUNT_USAGE_ACCOUNT_CHANGE_ENTITY_ID_V1],
                { source: 'socket', changeKinds: ['account'] }));
            const plan = planSyncActionsFromChanges([
                { kind: 'account', entityId: PROVIDER_ACCOUNT_USAGE_ACCOUNT_CHANGE_ENTITY_ID_V1, cursor: index, changedAt: 0 },
                { kind: 'kv', entityId: 'unrelated', cursor: index, changedAt: 0 },
                { kind: 'machine', entityId: 'controller', cursor: index, changedAt: 0 },
            ]);
            await act(async () => publishHomeAccountChange(serverId, plan.changes.map(change => change.entityId),
                { changeKinds: ['account', 'kv', 'machine'], machineResourcesAffect: plannedChangesAffectMachineResources(plan),
                    managedMachineInventoryAffect: plannedChangesAffectManagedMachineInventory(plan) }));
            await flushHookEffects({ cycles: 30 });
            expect({ requests: requests(), admissions }).toEqual(before);
        }
        rows[64] = { ...rows[64]!, intentRevision: 2 };
        await act(async () => publishHomeAccountChange(serverId, ['managed-64'], { source: 'socket', changeKinds: ['account'] }));
        await vi.waitFor(() => expect(hook.getCurrent().first.machinesByServerId[serverId]?.find(row => row.id === 'managed-64')?.intentRevision).toBe(2));
        expect(requests()).toBe(before.requests + 2);
        expect(admissions).toBe(before.admissions + 2);
        expect(hook.getCurrent().second.machinesByServerId[serverId]).toBe(hook.getCurrent().first.machinesByServerId[serverId]);
        rows.splice(64, 1);
        await act(async () => publishHomeAccountChange(serverId, ['controller'],
            { source: 'socket', changeKinds: ['machineRecipientAccess'] }));
        await vi.waitFor(() => expect(hook.getCurrent().first.machinesByServerId[serverId]).toHaveLength(127));
        expect(requests()).toBe(before.requests + 4);
        expect(admissions).toBe(before.admissions + 4);
    } finally { await hook.unmount(); await homes.dispose(); }
});
