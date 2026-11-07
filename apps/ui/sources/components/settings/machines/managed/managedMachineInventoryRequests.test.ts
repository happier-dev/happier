import { afterEach, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { PROVIDER_ACCOUNT_USAGE_ACCOUNT_CHANGE_ENTITY_ID_V1 } from '@happier-dev/protocol/changes';
import { ManagedMachineV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { installApprovalCommonModuleMocks } from '@/components/approvals/approvalsTestHelpers';
import { createDeferred, flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { invalidateAccountEncryptionModeCache } from '@/sync/api/account/apiAccountEncryptionMode';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { plannedChangesAffectMachineResources, plannedChangesAffectManagedMachineInventory, planSyncActionsFromChanges } from '@/sync/runtime/orchestration/changesPlanner';
import { resetRuntimeFetch } from '@/utils/system/runtimeFetch';
import { applyUsageSocketUpdate } from '@/sync/engine/socket/usageUpdates';
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
    const held = createDeferred<void>();
    let holdChangedRow = false;
    const homes = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://managed-request-cost.test',
        serverIdentityId: homeId, accountId: 'owner' }], route: async request => {
        if (request.path === '/v1/machines/managed/actions/get') {
            const row = rows.find(row => request.body && typeof request.body === 'object' && 'managedId' in request.body && row.id === request.body.managedId);
            if (holdChangedRow && row?.id === 'managed-64') await held.promise;
            return row ? Response.json(row) : Response.json({ error: 'managed_not_found' }, { status: 404 });
        }
        return request.path === '/v1/machines/managed/actions/list'
        ? Response.json({ machines: rows.filter(row => Boolean(row.archivedAt) === Boolean(
            request.body && typeof request.body === 'object' && 'archived' in request.body && request.body.archived)) }) : undefined;
    } });
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
        second: useManagedMachineInventory(ids, undefined, execute, true),
        detail: useManagedMachineInventory(ids, 'managed-2', execute),
        changedDetail: useManagedMachineInventory(ids, 'managed-64', execute),
        active: useManagedMachineInventory(ids, undefined, execute) }), { flushOptions: { cycles: 30 } });
    try {
        const requests = () => homes.requests.filter(request => request.path === '/v1/machines/managed/actions/list').length;
        await vi.waitFor(() => expect(hook.getCurrent().first.entries[serverId]?.status).toBe('ready'));
        await vi.waitFor(() => expect(hook.getCurrent().detail.entries[serverId]?.status).toBe('ready'));
        await vi.waitFor(() => expect(hook.getCurrent().changedDetail.entries[serverId]?.status).toBe('ready'));
        await vi.waitFor(() => expect(hook.getCurrent().active.entries[serverId]?.status).toBe('ready'));
        expect(hook.getCurrent().first.machinesByServerId[serverId]).toHaveLength(128);
        const exactReads = () => homes.requests.filter(request => request.path === '/v1/machines/managed/actions/get').length;
        const before = { requests: requests(), admissions };
        const previousRows = hook.getCurrent().first.machinesByServerId[serverId];
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
        const beforeExact = exactReads();
        rows[64] = { ...rows[64]!, intentRevision: 2 };
        const changedPlan = planSyncActionsFromChanges([{ kind: 'account', entityId: 'managed-64', cursor: 5, changedAt: 0,
            hint: { managedMachinePolicy: true, machineId: 'controller' } }]);
        await act(async () => publishHomeAccountChange(serverId, ['managed-64'], { ...changedPlan, changeKinds: ['account'],
            managedMachineInventoryAffect: plannedChangesAffectManagedMachineInventory(changedPlan) }));
        await vi.waitFor(() => expect(hook.getCurrent().first.machinesByServerId[serverId]?.find(row => row.id === 'managed-64')?.intentRevision).toBe(2));
        // PERF-MANAGED F5: one known row is one exact read, never two inventory reads.
        expect({ lists: requests() - before.requests, exact: exactReads() - beforeExact, listAdmissions: admissions - before.admissions })
            .toEqual({ lists: 0, exact: 1, listAdmissions: 0 });
        expect(hook.getCurrent().first.machinesByServerId[serverId]?.every((row, index) => index === 64 || row === previousRows?.[index])).toBe(true);
        expect(hook.getCurrent().second.machinesByServerId[serverId]).toBe(hook.getCurrent().first.machinesByServerId[serverId]);
        expect(hook.getCurrent().changedDetail.machinesByServerId[serverId]?.[0]?.intentRevision).toBe(2);
        expect(hook.getCurrent().active.machinesByServerId[serverId]?.find(row => row.id === 'managed-64')?.intentRevision).toBe(2);
        rows[64] = { ...rows[64]!, archivedAt: 2 };
        await act(async () => publishHomeAccountChange(serverId, ['managed-64'], { ...changedPlan, changeKinds: ['account'],
            managedMachineInventoryAffect: plannedChangesAffectManagedMachineInventory(changedPlan) }));
        await vi.waitFor(() => expect(hook.getCurrent().active.machinesByServerId[serverId]).toHaveLength(126));
        expect(hook.getCurrent().first.machinesByServerId[serverId]).toHaveLength(128);
        delete rows[64]!.archivedAt;
        await act(async () => publishHomeAccountChange(serverId, ['managed-64'], { ...changedPlan, changeKinds: ['account'],
            managedMachineInventoryAffect: plannedChangesAffectManagedMachineInventory(changedPlan) }));
        await vi.waitFor(() => expect(hook.getCurrent().active.machinesByServerId[serverId]).toHaveLength(127));
        expect(requests()).toBe(before.requests);
        const overlappingReads = exactReads();
        rows[64] = { ...rows[64]!, intentRevision: 3 };
        rows[65] = { ...rows[65]!, intentRevision: 2 };
        holdChangedRow = true;
        await act(async () => publishHomeAccountChange(serverId, ['managed-64'], { ...changedPlan, changeKinds: ['account'],
            managedMachineInventoryAffect: plannedChangesAffectManagedMachineInventory(changedPlan) }));
        await vi.waitFor(() => expect(exactReads()).toBe(overlappingReads + 1));
        const nextPlan = planSyncActionsFromChanges([{ kind: 'account', entityId: 'managed-65', cursor: 6, changedAt: 0,
            hint: { managedMachinePolicy: true, machineId: 'controller' } }]);
        await act(async () => {
            publishHomeAccountChange(serverId, ['managed-65'], { ...nextPlan, changeKinds: ['account'],
                managedMachineInventoryAffect: plannedChangesAffectManagedMachineInventory(nextPlan) });
            held.resolve();
        });
        await vi.waitFor(() => expect(hook.getCurrent().first.machinesByServerId[serverId]?.find(row => row.id === 'managed-65')?.intentRevision).toBe(2));
        expect(hook.getCurrent().first.machinesByServerId[serverId]?.find(row => row.id === 'managed-64')?.intentRevision).toBe(3);
        expect({ lists: requests() - before.requests, exact: exactReads() - overlappingReads }).toEqual({ lists: 0, exact: 2 });
        rows.splice(64, 1);
        await act(async () => publishHomeAccountChange(serverId, ['controller'],
            { source: 'socket', changeKinds: ['machineRecipientAccess'] }));
        await vi.waitFor(() => expect(hook.getCurrent().first.machinesByServerId[serverId]).toHaveLength(127));
        await vi.waitFor(() => expect(hook.getCurrent().active.machinesByServerId[serverId]).toHaveLength(126));
        expect(requests()).toBe(before.requests + 3);
        expect(admissions).toBe(before.admissions + 3);
    } finally { held.resolve(); await hook.unmount(); await homes.dispose(); }
});

it('keeps the app-wide inventory quiet while Usage pushes arrive, and still re-reads a real Machine access change', async () => {
    // P03-ARRIVAL-STORM: live, every `usage` / `usage-sources-invalidated` push re-listed managed Machines
    // (DEV, idle Session open: 8 plain + 1 archived list in 40 s, all from applyUsageSocketUpdate).
    const homeId = 'srv_managed_usage_quiet';
    const row = ManagedMachineV1Schema.parse({
        id: 'managed-1', homeId, custodianAccountId: 'owner',
        launch: { provider: { pluginId: 'custom.compute', localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} },
        controller: { machineId: 'controller', installationId: 'installation' }, allocation: 'may-exist', creationState: 'active',
        desired: 'start', desiredWhen: 'now', intentRevision: 1,
        retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
    });
    const homes = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://managed-usage-quiet.test',
        serverIdentityId: homeId, accountId: 'owner' }], route: request => request.path === '/v1/machines/managed/actions/list'
        ? Response.json({ machines: request.body && typeof request.body === 'object' && 'archived' in request.body ? [] : [row] }) : undefined });
    const serverId = homes.homes.a!.id;
    const ids = [serverId];
    // The deletion reminder shape: an always-mounted active + archived inventory.
    const hook = await renderHook(() => useManagedMachineInventory(ids, undefined, undefined, true), { flushOptions: { cycles: 30 } });
    try {
        const lists = () => homes.requests.filter(request => request.path === '/v1/machines/managed/actions/list').length;
        await vi.waitFor(() => expect(hook.getCurrent().entries[serverId]?.status).toBe('ready'));
        await flushHookEffects({ cycles: 30 });
        const before = lists();
        for (let index = 0; index < 5; index += 1) {
            await act(async () => {
                applyUsageSocketUpdate({ type: 'usage', id: null, key: `fact-${index}`, tokens: { total: 1 }, cost: { total: 0 },
                    timestamp: index, accountingChange: { sessionId: null } }, serverId, 'owner');
                applyUsageSocketUpdate({ type: 'usage-sources-invalidated', machineId: 'capture-machine', installationId: 'installation' },
                    serverId, 'owner');
            });
            await flushHookEffects({ cycles: 30 });
        }
        expect(lists() - before, '10 Usage pushes change no managed Machine').toBe(0);
        await act(async () => publishHomeAccountChange(serverId, ['controller'],
            { source: 'socket', changeKinds: ['machineRecipientAccess'] }));
        await vi.waitFor(() => expect(lists() - before, 'a Machine access change still re-reads active + archived').toBe(2));
    } finally { await hook.unmount(); await homes.dispose(); }
});
