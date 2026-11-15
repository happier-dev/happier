import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { installApprovalCommonModuleMocks } from '@/components/approvals/approvalsTestHelpers';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { createAccountTokenForTests, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createDeferred, createMachineFixture, createRenderCommitCounter, flushHookEffects, renderHook, renderScreen, standardCleanup, useRenderCommitCounter } from '@/dev/testkit';
import { publishMachineActivityForTest, publishMachineInventoryForTest } from '@/dev/testkit/harness/machinePresence';
import { useMachineCollection } from '../collection/useMachineCollection';
import { machineCollectionRowKey, type MachineCollectionRow } from '../collection/machineCollectionModel';
import { upsertAndActivateServer, upsertServerProfileOnly } from '@/sync/domains/server/serverRuntime';
import { setServerProfileIdentityForUrl } from '@/sync/domains/server/serverProfiles';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { retainManagedMachineInventory, useAdmittedManagedMachineAbsentEnrolledIds, useManagedMachineInventory, type ManagedMachineInventoryEntry } from './useManagedMachineInventory';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { invalidateAccountEncryptionModeCache } from '@/sync/api/account/apiAccountEncryptionMode';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { ManagedMachineV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { ManagedMachineActionOutputSchemasV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { buildManagedConfigurationFactsV1 } from '@happier-dev/protocol/machines/managed/managedConfigurationV1';
import { MachineProvisionerContributionV1Schema } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { defineProtocolObject, defineProtocolString } from '@happier-dev/protocol/plugins/actions/protocol-composable-schema';
import { createPluginJsonSchemaZodValueAdapter } from '@happier-dev/protocol/plugins/actions/json-schema-validation';
import { ActionsSettingsV1Schema, setActionApprovalOverride } from '@happier-dev/protocol/actions/actionSettings';
import { storage } from '@/sync/domains/state/storageStore';

installApprovalCommonModuleMocks();
const { t } = await import('@/text');
const { Modal } = await import('@/modal');
afterEach(async () => { await standardCleanup(); retireActiveServerAccountScopeLifetime(); resetRuntimeFetch(); invalidateAccountEncryptionModeCache(); vi.restoreAllMocks(); });

function managedUiApprovalSettings(actionIds: readonly ('machines.managed.list' | 'machines.managed.get')[]) {
    let actionsSettingsV1 = ActionsSettingsV1Schema.parse({ v: 1, actions: {} });
    for (const actionId of actionIds) {
        actionsSettingsV1 = setActionApprovalOverride({
            settings: actionsSettingsV1, actionId, surface: 'ui', approvalRequired: true,
        });
    }
    return { actionsSettingsV1 };
}

describe('managed Machine inventory', () => {
    it('publishes changed admitted inventory without a third output admission and rejects malformed HTTP rows', async () => {
        const homeId = 'srv_inventory_admission_cost';
        const native = defineProtocolObject(Object.fromEntries(Array.from({ length: 64 }, (_, index) =>
            [`field${index}`, defineProtocolString()])), { policy: 'closed' });
        const provisioner = MachineProvisionerContributionV1Schema.parse({
            id: 'native', title: 'Native', icon: 'server', resourceKind: 'sandbox', schemaVersion: 1,
            launchSchema: native.jsonSchema, resourceSchema: native.jsonSchema, platforms: ['linux'], prerequisites: [],
            billing: { location: 'cloud', stoppedBilling: 'not-billed' }, retention: { supportedIntents: ['delete'] },
            actions: { check: 'check', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', destroy: 'destroy' },
        });
        const launch = { provider: { pluginId: 'custom.provisioner', localId: 'native' }, schemaVersion: 1,
            name: 'Guest', choices: Object.fromEntries(Array.from({ length: 64 }, (_, index) => [`field${index}`, 'value'])) };
        const reviewedFacts = buildManagedConfigurationFactsV1({
            choicesSchema: createPluginJsonSchemaZodValueAdapter(provisioner.launchSchema), launch, provisioner,
            optionStatus: 'current', prerequisites: [], billing: provisioner.billing,
            retentionCapabilities: provisioner.retention,
        });
        const machines = Array.from({ length: 16 }, (_, index) => ManagedMachineV1Schema.parse({
            id: `managed-${index}`, homeId, custodianAccountId: 'owner', enrolledMachineId: `guest-${index}`,
            launch, reviewedFacts, allocation: 'may-exist', creationState: 'active', desired: 'start', desiredWhen: 'now',
            intentRevision: 1, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
        }));
        let malformed = false;
        const homes = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://inventory-admission-cost.test',
            serverIdentityId: homeId, accountId: 'owner' }], route: request => request.path === '/v1/machines/managed/actions/list'
            ? Response.json({ machines: malformed ? [{ ...machines[0], allocation: 'invalid' }] : machines }) : undefined });
        const serverId = homes.homes.a!.id;
        const ids = [serverId];
        // Default dispatch traverses the real lazy Action front door, HTTP adapter and terminal settlement.
        const hook = await renderHook(() => useManagedMachineInventory(ids));
        try {
            await waitForHomeGovernance(() => expect(hook.getCurrent().entries[serverId]?.status).toBe('ready'));
            await flushHookEffects({ cycles: 30 });
            const initialReads = homes.requests.filter(request => request.path === '/v1/machines/managed/actions/list').length;
            const output = ManagedMachineActionOutputSchemasV1['machines.managed.list'];
            // Transparent call-through observations count full output admissions, without replacing any validation.
            const parse = vi.spyOn(output, 'parse');
            const safeParse = vi.spyOn(output, 'safeParse');
            machines[8] = { ...machines[8]!, intentRevision: 2 };
            await act(async () => publishHomeAccountChange(serverId));
            await waitForHomeGovernance(() => expect(hook.getCurrent().machinesByEnrolledMachineIdByServerId[serverId]?.['guest-8']?.intentRevision).toBe(2));
            await flushHookEffects({ cycles: 30 });
            expect(homes.requests.filter(request => request.path === '/v1/machines/managed/actions/list')).toHaveLength(initialReads + 1);
            // HTTP response admission and canonical terminal settlement each validate once; inventory trusts their result.
            expect(parse.mock.calls.length + safeParse.mock.calls.length).toBe(2);
            malformed = true;
            await act(async () => publishHomeAccountChange(serverId));
            await waitForHomeGovernance(() => expect(hook.getCurrent().entries[serverId]?.status).toBe('error'));
            expect(hook.getCurrent().entries[serverId]?.errorCode).toBe('managed_response_invalid');
            expect(hook.getCurrent().machinesByEnrolledMachineIdByServerId[serverId]?.['guest-8']?.intentRevision).toBe(2);
        } finally {
            await hook.unmount();
            await homes.dispose();
        }
    });
    it('publishes zero equal automatic failures while initial load, changed failures and recovery still settle', async () => {
        let reply: 'unavailable' | 'denied' | 'unsupported' | 'ready' = 'unavailable';
        const initial = createDeferred<Response>();
        let reads = 0;
        const homes = await serveAccountHomes({ homes: [
            { key: 'a', serverUrl: 'https://inventory-equal-failures.test', serverIdentityId: 'srv_equal_failures', accountId: 'owner' },
        ], route: request => {
            if (request.path !== '/v1/machines/managed/actions/list') return undefined;
            reads += 1;
            if (reads === 1) return initial.promise;
            if (reply === 'unavailable') throw new Error('network_unavailable');
            if (reply === 'denied') return Response.json({ code: 'permission_denied' }, { status: 403 });
            if (reply === 'unsupported') return new Response('Not found', { status: 404 });
            return Response.json({ machines: [] });
        } });
        const serverId = homes.homes.a!.id;
        const account = await captureLazyActionAccountContext(serverId);
        const publications: ManagedMachineInventoryEntry[] = [];
        const inventory = retainManagedMachineInventory(account.accountLifetime, entry => publications.push(entry));
        try {
            expect(inventory.getSnapshot().status).toBe('loading');
            await waitForHomeGovernance(() => expect(reads).toBe(1));
            await act(async () => initial.reject(new Error('network_unavailable')));
            await waitForHomeGovernance(() => expect(inventory.getSnapshot().status).toBe('error'));
            expect(publications.length).toBeGreaterThan(0);
            for (const [failure, status] of [['unavailable', 'error'], ['denied', 'denied'], ['unsupported', 'unsupported']] as const) {
                if (reply !== failure) {
                    reply = failure;
                    publications.length = 0;
                    await act(async () => publishHomeAccountChange(serverId));
                    await waitForHomeGovernance(() => expect(inventory.getSnapshot().status).toBe(status));
                    expect(publications.length).toBeGreaterThan(0);
                }
                const settled = inventory.getSnapshot();
                publications.length = 0;
                for (let repeat = 0; repeat < 2; repeat += 1) {
                    const before = reads;
                    await act(async () => publishHomeAccountChange(serverId));
                    await waitForHomeGovernance(() => expect(reads).toBe(before + 1));
                    await flushHookEffects({ cycles: 30 });
                }
                expect(publications).toHaveLength(0);
                expect(inventory.getSnapshot()).toBe(settled);
            }
            publications.length = 0;
            reply = 'ready';
            await act(async () => publishHomeAccountChange(serverId));
            await waitForHomeGovernance(() => expect(inventory.getSnapshot().status).toBe('ready'));
            expect(publications.map(entry => entry.status)).toEqual(['ready']);
        } finally {
            inventory.dispose();
            account.dispose();
            await homes.dispose();
        }
    });
    it('publishes a real approval transition from a settled failure and clears it on recovery', async () => {
        const settings = managedUiApprovalSettings(['machines.managed.list']);
        const homes = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://inventory-failure-approval.test',
            serverIdentityId: 'srv_failure_approval', accountId: 'owner', currentAccount: true,
            settings,
        }], route: request => request.path === '/v1/features' || request.path === '/v1/features/authenticated'
                ? Response.json(createRootLayoutFeaturesResponse())
                : request.path === '/v1/machines/managed/actions/list' ? Response.json({ machines: [] }) : undefined });
        const serverId = homes.homes.a!.id;
        homes.replaceAccountSettings('a', { settings, version: 2 });
        const account = await captureLazyActionAccountContext(serverId);
        try {
            // Mirror the persisted Home policy at the restored live settings scope.
            await act(async () => storage.getState().applySettingsLocal(settings));
            await waitForHomeGovernance(async () => expect((await account.readSettings()).actionsSettingsV1?.actions?.['machines.managed.list']
                ?.approvalRequiredSurfaces).toEqual(['ui']));
        } catch (error) { account.dispose(); await homes.dispose(); throw error; }
        const publications: ManagedMachineInventoryEntry[] = [];
        // The real presenter uses native confirmation for reads without discovered preview facts.
        const decline = createDeferred<boolean>();
        const accept = createDeferred<boolean>();
        const confirmation = vi.spyOn(Modal, 'confirm')
            .mockImplementationOnce(() => decline.promise).mockImplementationOnce(() => accept.promise);
        const inventory = retainManagedMachineInventory(account.accountLifetime, entry => publications.push(entry));
        try {
            await vi.waitFor(() => expect(confirmation).toHaveBeenCalledTimes(1));
            expect(inventory.getSnapshot()).toMatchObject({ status: 'loading' });
            expect(inventory.getSnapshot().approval).toBeUndefined();
            expect(homes.requests.filter(request => request.path === '/v1/machines/managed/actions/list')).toEqual([]);
            await act(async () => decline.resolve(false));
            await waitForHomeGovernance(() => expect(inventory.getSnapshot()).toMatchObject({ status: 'error', errorCode: 'approval_canceled' }));
            const settled = inventory.getSnapshot();
            publications.length = 0;
            await act(async () => publishHomeAccountChange(serverId));
            await vi.waitFor(() => expect(confirmation).toHaveBeenCalledTimes(2));
            // Native Ask belongs to its presenter; revalidation retains the settled inventory until its answer changes.
            expect(inventory.getSnapshot()).toBe(settled);
            expect(inventory.getSnapshot()).toMatchObject({ status: 'error', errorCode: 'approval_canceled' });
            expect(publications).toEqual([]);
            await act(async () => accept.resolve(true));
            await waitForHomeGovernance(() => expect(inventory.getSnapshot().status).toBe('ready'));
            expect(inventory.getSnapshot()).toMatchObject({ status: 'ready', machines: [] });
            expect(inventory.getSnapshot().approval).toBeUndefined();
            expect(inventory.getSnapshot().errorCode).toBeUndefined();
        } finally {
            inventory.dispose();
            account.dispose();
            await homes.dispose();
        }
    });
    it('never publishes an unpartitioned collection frame on cold or warm route mounts', async () => {
        const homeId = 'srv_route_collection';
        const managed = ManagedMachineV1Schema.parse({ id: 'created', homeId, custodianAccountId: 'owner', enrolledMachineId: 'guest',
            launch: { provider: { pluginId: 'custom.compute', localId: 'vm' }, schemaVersion: 1, name: 'Build box', choices: {} },
            resource: { contributionRef: { pluginId: 'custom.compute', localId: 'vm' }, schemaVersion: 1, value: { id: 'native' } },
            allocation: 'bound', creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 1,
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
            observation: { observedAt: 1, availability: 'present', power: 'running', storage: 'retained' },
        });
        let answer = createDeferred<Response>();
        const homes = await serveAccountHomes({ homes: [
            { key: 'a', serverUrl: 'https://route-collection.test', serverIdentityId: homeId, accountId: 'owner' },
        ], route: request => request.path === '/v1/machines/managed/actions/list'
            ? request.body && typeof request.body === 'object' && 'archived' in request.body && request.body.archived
                ? Response.json({ machines: [] }) : answer.promise
            : undefined });
        const serverId = homes.homes.a!.id;
        const ids = [serverId];
        const groups = [{ serverId, serverName: 'Home', accountScope: { serverId, accountId: 'owner' }, status: 'idle' as const,
            machines: [createMachineFixture({ id: 'guest' })] }];
        await publishMachineInventoryForTest({ serverId, accountId: 'owner' }, groups[0]!.machines);
        publishMachineActivityForTest(groups[0]!.machines);
        type Frame = ReturnType<typeof useMachineCollection>;
        const frames: Frame[] = [];
        const publicSections = (collection: Frame) => collection.sections.map(section => ({
            serverId: section.serverId, title: section.title, archived: section.archived,
            rows: section.rows.map(row => ({ key: machineCollectionRowKey(row), title: row.title, host: row.host,
                platform: row.platform, online: row.online, status: row.status, presence: row.presence,
                presenceWord: row.presenceWord, reason: row.reason, ownership: row.ownership, ownerName: row.ownerName })),
        }));
        function useRouteCollection() {
            const inventory = useManagedMachineInventory(ids, undefined, undefined, true);
            const collection = useMachineCollection({ groups, groupedByHome: false,
                managedByServerId: inventory.machinesByServerId, managedFirstAnswerPending: inventory.firstAnswerPending });
            frames.push(collection);
            return collection;
        }
        const cold = await renderHook(useRouteCollection);
        try {
            expect(frames.length).toBeGreaterThan(0);
            expect(frames.every(frame => frame.count === 0 && frame.sections.length === 0)).toBe(true);
            answer.resolve(Response.json({ machines: [managed] }));
            await waitForHomeGovernance(() => expect(cold.getCurrent().machineCount).toBe(1));
            const settled = cold.getCurrent();
            const rows = settled.sections.flatMap(section => section.rows);
            expect(rows).toHaveLength(1);
            expect(settled.sections.find(section => section.rows.length > 0)?.title).toBe(t('machines.destinations.created'));
            expect(rows[0]).toMatchObject({ kind: 'machine', machineId: 'guest', host: null });
            await cold.unmount();
            const idleRequests = homes.requests.length;
            await act(async () => publishHomeAccountChange(serverId));
            await flushHookEffects();
            expect(homes.requests.length).toBe(idleRequests);
            answer = createDeferred<Response>();
            const requestCount = homes.requests.length;
            frames.length = 0;
            const warm = await renderHook(useRouteCollection);
            try {
                expect(frames.length).toBeGreaterThan(0);
                expect(frames.every(frame => frame.machineCount === 1 && frame.sections.some(section =>
                    section.title === t('machines.destinations.created') && section.rows.length === 1))).toBe(true);
                expect(warm.getCurrent().machineCount).toBe(1);
                // Presence sources are deliberately compact linked projections, not a stable public row shape.
                expect(publicSections(warm.getCurrent())).toEqual(publicSections(settled));
                await waitForHomeGovernance(() => expect(homes.requests.length).toBeGreaterThan(requestCount));
                answer.resolve(Response.json({ machines: [] }));
                await waitForHomeGovernance(() => expect(warm.getCurrent().sections.some(section =>
                    section.title === t('machines.destinations.created') && section.rows.length === 1)).toBe(false));
            } finally { await warm.unmount(); }
            retireActiveServerAccountScopeLifetime();
            answer = createDeferred<Response>();
            frames.length = 0;
            const retired = await renderHook(useRouteCollection);
            try {
                expect(frames[0]).toMatchObject({ count: 0, firstAnswerPending: true });
            } finally {
                answer.resolve(Response.json({ machines: [] }));
                await retired.unmount();
            }
        } finally {
            answer.resolve(Response.json({ machines: [managed] }));
            await cold.unmount();
        }
    });
    it('pushes a removal receipt into mounted rail rows with no reload or unrelated row renders', async () => {
        const homeId = 'srv_rail_removal';
        const managed = ManagedMachineV1Schema.parse({ id: 'removed', homeId, custodianAccountId: 'owner', enrolledMachineId: 'guest-0',
            launch: { provider: { pluginId: 'custom.compute', localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} },
            resource: { contributionRef: { pluginId: 'custom.compute', localId: 'vm' }, schemaVersion: 1, value: { id: 'native' } },
            allocation: 'bound', creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 1,
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
            observation: { observedAt: 1, availability: 'present', power: 'running', storage: 'retained' },
        });
        let current = managed;
        const homes = await serveAccountHomes({ homes: [
            { key: 'a', serverUrl: 'https://rail-removal.test', serverIdentityId: homeId, accountId: 'owner' },
        ], route: request => {
            if (request.path === '/v1/machines/managed/actions/list') return Response.json({ machines:
                request.body && typeof request.body === 'object' && 'archived' in request.body && request.body.archived ? [] : [current] });
            if (request.path === '/v1/machines/managed/actions/get') return Response.json(current);
            return undefined;
        } });
        const serverId = homes.homes.a!.id;
        const ids = [serverId];
        const scope = { serverId, accountId: 'owner' };
        // RELOAD 81's rail had 62 Machines. Keep their heartbeats fresh across removal.
        const machines = Array.from({ length: 62 }, (_, index) => createMachineFixture({
            id: `guest-${index}`, active: true, activeAt: Date.now(),
        }));
        await publishMachineInventoryForTest(scope, machines);
        publishMachineActivityForTest(machines);
        const groups = [{ serverId, serverName: 'Home', accountScope: scope, status: 'idle' as const, machines }];
        const counters = new Map<string, ReturnType<typeof createRenderCommitCounter>>();
        const Row = React.memo(function Row({ row }: Readonly<{ row: MachineCollectionRow }>) {
            const key = machineCollectionRowKey(row);
            let counter = counters.get(key);
            if (!counter) { counter = createRenderCommitCounter(); counters.set(key, counter); }
            useRenderCommitCounter(counter);
            return React.createElement('row', { row });
        });
        function Rail() {
            const inventory = useManagedMachineInventory(ids, undefined, undefined, true);
            const collection = useMachineCollection({ groups, groupedByHome: false, managedByServerId: inventory.machinesByServerId });
            return collection.sections.flatMap(section => section.rows.map(row => React.createElement(Row, { key: machineCollectionRowKey(row), row })));
        }
        const screen = await renderScreen(React.createElement(Rail));
        const detail = await renderHook(() => useManagedMachineInventory(ids, managed.id));
        const rows = () => screen.tree.findAll(node => String(node.type) === 'row').map(node => node.props.row as MachineCollectionRow);
        try {
            await waitForHomeGovernance(() => {
                expect(detail.getCurrent().entries[serverId]?.status).toBe('ready');
                expect(rows().find(row => row.machineId === 'guest-0')?.online).toBe(true);
            });
            const requests = homes.requests.length;
            for (const counter of counters.values()) counter.reset();
            current = { ...managed, allocation: 'confirmed-absent', desired: 'delete', intentRevision: 2,
                observation: { observedAt: 2, availability: 'absent' } };
            await act(async () => { await detail.getCurrent().refresh(); });
            await flushHookEffects({ cycles: 30 });
            expect(detail.getCurrent().machinesByServerId[serverId]?.[0]).toMatchObject({ allocation: 'confirmed-absent' });
            expect(rows().find(row => row.managedId === managed.id)).toMatchObject({ online: false, status: 'offline', presence: t('managedPower.resourceAbsent') });
            expect(rows().filter(row => row.online)).toHaveLength(61);
            expect([...counters.entries()].filter(([key]) => !key.endsWith(':guest-0') && !key.endsWith(':removed'))
                .reduce((sum, [, counter]) => sum + counter.read().renders, 0)).toBe(0);
            expect(homes.requests.slice(requests).map(request => request.path)).toEqual(['/v1/machines/managed/actions/get']);

            for (const counter of counters.values()) counter.reset();
            await act(async () => { await detail.getCurrent().refresh(); });
            await flushHookEffects({ cycles: 30 });
            expect([...counters.values()].reduce((sum, counter) => sum + counter.read().renders, 0)).toBe(0);

            // Exercise the ordinary push path too, including restored native presence.
            current = { ...managed, intentRevision: 3 };
            await act(async () => publishHomeAccountChange(serverId, [managed.id], { source: 'socket', machineResourcesAffect: true }));
            await waitForHomeGovernance(() => expect(rows().find(row => row.machineId === 'guest-0')?.online).toBe(true));
            for (const counter of counters.values()) counter.reset();
            current = { ...managed, allocation: 'confirmed-absent', desired: 'delete', intentRevision: 4,
                observation: { observedAt: 4, availability: 'absent' } };
            await act(async () => publishHomeAccountChange(serverId, [managed.id], { source: 'socket', machineResourcesAffect: true }));
            await waitForHomeGovernance(() => expect(rows().find(row => row.managedId === managed.id))
                .toMatchObject({ online: false, status: 'offline', presence: t('managedPower.resourceAbsent') }));
            expect([...counters.entries()].filter(([key]) => !key.endsWith(':guest-0') && !key.endsWith(':removed'))
                .reduce((sum, [, counter]) => sum + counter.read().renders, 0)).toBe(0);
        } finally {
            await detail.unmount();
            await screen.unmount();
        }
    });
    it('retains only the addressed execution target and settles pushed power changes without passive power effects', async () => {
        const asleep = ManagedMachineV1Schema.parse({ id: 'managed', homeId: 'srv_target', custodianAccountId: 'owner', enrolledMachineId: 'guest',
            launch: { provider: { pluginId: 'custom.compute', localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} },
            resource: { contributionRef: { pluginId: 'custom.compute', localId: 'vm' }, schemaVersion: 1, value: { id: 'native' } },
            allocation: 'bound', creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 1,
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
            observation: { observedAt: 1, availability: 'present', power: 'stopped', storage: 'retained' },
        });
        let current = asleep;
        const selections: unknown[] = [];
        const effects: string[] = [];
        const homes = await serveAccountHomes({ homes: [
            { key: 'a', serverUrl: 'https://exact-wake-inventory.test', serverIdentityId: 'srv_target', accountId: 'owner' },
        ], route: request => {
            if (request.path === '/v1/machines/managed/actions/list') {
                selections.push(request.body);
                return Response.json({ machines: [current] });
            }
            if (request.path.includes('/managed/')) effects.push(request.path);
            return undefined;
        } });
        const account = await captureLazyActionAccountContext(homes.homes.a!.id);
        let latest: ManagedMachineInventoryEntry | undefined;
        const inventory = retainManagedMachineInventory(account.accountLifetime, entry => { latest = entry; }, { enrolledMachineId: 'guest' });
        try {
            await vi.waitFor(() => expect(latest?.status).toBe('ready'));
            expect(selections).toEqual([{ homeId: 'srv_target', enrolledMachineId: 'guest' }]);
            current = { ...asleep, observation: { ...asleep.observation!, power: 'running', observedAt: 2 } };
            publishHomeAccountChange(account.serverId, ['managed'], { source: 'socket', machineResourcesAffect: true });
            await vi.waitFor(() => expect(latest?.machines[0]?.observation?.power).toBe('running'));
            expect(selections).toHaveLength(2);
            expect(selections[1]).toEqual(selections[0]);
            expect(effects).toEqual([]);
            inventory.dispose();
            publishHomeAccountChange(account.serverId, ['managed'], { source: 'socket', machineResourcesAffect: true });
            await flushHookEffects();
            expect(selections).toHaveLength(2);
        } finally { inventory.dispose(); account.dispose(); await homes.dispose(); }
    });
    it('keeps admitted absence visible across a narrower overlapping inventory admitted from the held census', async () => {
        const absent = ManagedMachineV1Schema.parse({ id: 'removed', homeId: 'srv_absence', custodianAccountId: 'owner', enrolledMachineId: 'ghost',
            launch: { provider: { pluginId: 'custom.provisioner', localId: 'native' }, schemaVersion: 1, name: 'Guest', choices: {} },
            controller: { machineId: 'controller', installationId: 'installation' }, allocation: 'confirmed-absent', creationState: 'active',
            desired: 'delete', desiredWhen: 'now', intentRevision: 1, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false });
        const archived = { ...absent, id: 'archived', enrolledMachineId: 'retired', archivedAt: 1 };
        const coldRead = createDeferred<Response>();
        let activeReads = 0;
        let archiveReads = 0;
        const target = await upsertAndActivateServer({ serverUrl: 'https://inventory-absence.test', scope: 'tab' });
        await setServerProfileIdentityForUrl(target.serverUrl, 'srv_absence');
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token: createAccountTokenForTests('owner') });
        // Secure storage and HTTP are boundaries; both inventory readers and admission stay real.
        setRuntimeFetch(async (input, init) => {
            const path = new URL(String(input)).pathname;
            if (path === '/v1/auth/ping') return Response.json({ ok: true });
            if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (path !== '/v1/machines/managed/actions/list') return Response.json({ error: 'not_found' }, { status: 404 });
            const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
            if (body && typeof body === 'object' && 'archived' in body && body.archived) {
                archiveReads += 1;
                return Response.json({ machines: [archived] });
            }
            return ++activeReads === 1 ? Response.json({ machines: [absent] }) : coldRead.promise;
        });
        const serverId = 'srv_absence';
        const execute = createDefaultActionExecutor().execute;
        const held = await renderHook(() => useManagedMachineInventory([serverId], undefined, execute, true), { flushOptions: { cycles: 30 } });
        const narrow = await renderHook(() => useManagedMachineInventory([serverId], undefined, execute), { flushOptions: { cycles: 30 } });
        const observer = await renderHook(() => useAdmittedManagedMachineAbsentEnrolledIds(serverId,
            held.getCurrent().bindings.get(serverId), execute));
        try {
            expect(held.getCurrent().entries[serverId]?.status).toBe('ready');
            // The narrower current-only reader is admitted from the held settled census, not read again.
            expect(narrow.getCurrent().entries[serverId]?.status).toBe('ready');
            expect([...observer.getCurrent()]).toEqual(['ghost']);
            expect(activeReads + archiveReads).toBe(2);
            coldRead.resolve(Response.json({ machines: [absent] }));
            await flushHookEffects({ cycles: 30 });
            expect([...observer.getCurrent()]).toEqual(['ghost']);
        } finally {
            coldRead.resolve(Response.json({ machines: [absent] }));
            await observer.unmount();
            await narrow.unmount();
            await held.unmount();
        }
    });
    it('publishes only changed rows and Home indexes across a shared 128-Machine active/archive refresh', async () => {
        const rows = (homeId: string, accountId: string) => Array.from({ length: 128 }, (_, index) => ManagedMachineV1Schema.parse({
            id: `managed-${index}`, homeId, custodianAccountId: accountId, enrolledMachineId: `guest-${index}`,
            launch: { provider: { pluginId: 'custom.provisioner', localId: 'native' }, schemaVersion: 1, name: `Guest ${index}`, choices: {} },
            controller: { machineId: 'controller', installationId: 'installation' }, allocation: 'may-exist', creationState: 'active',
            desired: 'start', desiredWhen: 'now', intentRevision: 1, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
            ...(index === 127 ? { archivedAt: 1 } : {}),
        }));
        const machines = { a: rows('srv_cost_a', 'owner'), b: rows('srv_cost_b', 'owner') };
        const homes = await serveAccountHomes({ homes: [
            { key: 'a', serverUrl: 'https://inventory-cost-a.test', serverIdentityId: 'srv_cost_a', accountId: 'owner' },
            { key: 'b', serverUrl: 'https://inventory-cost-b.test', serverIdentityId: 'srv_cost_b', accountId: 'owner' },
        ], route: request => request.path === '/v1/machines/managed/actions/list'
            ? Response.json({ machines: machines[request.home as keyof typeof machines].filter(row => Boolean(row.archivedAt) === Boolean(
                request.body && typeof request.body === 'object' && 'archived' in request.body && request.body.archived)) }) : undefined });
        const realExecute = createDefaultActionExecutor().execute;
        let readAdmissions = 0;
        // Transparent observation at the public Action boundary: cancelled admission
        // is still work even when supersession prevents its later HTTP request.
        const execute: typeof realExecute = (...args) => {
            if (args[0] === 'machines.managed.list') readAdmissions += 1;
            return realExecute(...args);
        };
        const ids = [homes.homes.a!.id, homes.homes.b!.id];
        let publications = 0;
        const hook = await renderHook(() => {
            publications += 1;
            return ({
            first: useManagedMachineInventory(ids, undefined, execute, true),
            second: useManagedMachineInventory(ids, undefined, execute, true),
        }); }, { flushOptions: { cycles: 30 } });
        try {
            const lists = () => homes.requests.filter(request => request.path === '/v1/machines/managed/actions/list');
            await vi.waitFor(() => expect(Object.values(hook.getCurrent().first.entries).map(entry => entry.status)).toEqual(['ready', 'ready']));
            // Account restoration may revalidate during bootstrap (the isolation case below).
            // PERF-L12-I-BRIEF.md P-04 counts steady equal refreshes, once both Homes are ready.
            const initialReads = lists().length;
            const initialAdmissions = readAdmissions;
            const before = hook.getCurrent().first;
            expect(before.machinesByServerId[ids[0]!]).toHaveLength(128);
            publications = 0;
            for (const kind of ['session', 'discussion', 'automation'] as const) {
                for (let index = 0; index < 4; index += 1) {
                    await act(async () => publishHomeAccountChange(ids[0]!, [`unrelated-${index}`], { source: 'socket', changeKinds: [kind] }));
                    await flushHookEffects({ cycles: 30 });
                }
            }
            await act(async () => publishHomeAccountChange(ids[0]!, ['workflow-run:unrelated'], { source: 'socket', changeKinds: ['account'] }));
            await flushHookEffects({ cycles: 30 });
            expect(lists()).toHaveLength(initialReads);
            expect(readAdmissions).toBe(initialAdmissions);
            expect(publications).toBe(0);
            for (let index = 0; index < 4; index += 1) {
                await act(async () => publishHomeAccountChange(ids[0]!));
                await vi.waitFor(() => expect(lists()).toHaveLength(initialReads + (index + 1) * 2));
                await flushHookEffects({ cycles: 30 });
            }
            expect(lists()).toHaveLength(initialReads + 8);
            expect(readAdmissions).toBe(initialAdmissions + 8);
            expect(publications).toBe(0);
            expect(hook.getCurrent().first.entries).toBe(before.entries);
            expect(hook.getCurrent().first.machinesByServerId).toBe(before.machinesByServerId);
            expect(hook.getCurrent().first.machinesByEnrolledMachineIdByServerId).toBe(before.machinesByEnrolledMachineIdByServerId);
            machines.a[64] = { ...machines.a[64]!, intentRevision: 2 };
            await act(async () => publishHomeAccountChange(ids[0]!));
            await vi.waitFor(() => expect(hook.getCurrent().first.machinesByEnrolledMachineIdByServerId[ids[0]!]!['guest-64']?.intentRevision).toBe(2));
            await flushHookEffects({ cycles: 30 });
            const after = hook.getCurrent().first;
            const changed = after.machinesByServerId[ids[0]!]!.filter((row, index) => row !== before.machinesByServerId[ids[0]!]![index]);
            expect(changed.map(row => row.id)).toEqual(['managed-64']);
            expect(after.machinesByServerId[ids[1]!]).toBe(before.machinesByServerId[ids[1]!]);
            expect(after.machinesByEnrolledMachineIdByServerId[ids[1]!]).toBe(before.machinesByEnrolledMachineIdByServerId[ids[1]!]);
            expect(after.machinesByEnrolledMachineIdByServerId[ids[0]!]!['guest-0']).toBe(before.machinesByEnrolledMachineIdByServerId[ids[0]!]!['guest-0']);
            expect(after.machinesByEnrolledMachineIdByServerId[ids[0]!]!['guest-64']?.intentRevision).toBe(2);
            expect(publications).toBeGreaterThan(0);
            expect(after.machinesByEnrolledMachineIdByServerId[ids[0]!]!['guest-127']).toBeUndefined();
            expect(hook.getCurrent().second.machinesByServerId[ids[0]!]).toBe(after.machinesByServerId[ids[0]!]);
        } finally { await hook.unmount(); await homes.dispose(); }
    });
    it('keeps a hydrated same-Home inventory ready while its revalidation is in flight', async () => {
        const target = await upsertAndActivateServer({ serverUrl: 'https://managed-inventory-revalidate.test', scope: 'tab' });
        await setServerProfileIdentityForUrl(target.serverUrl, 'srv_inventory_revalidate');
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token: createAccountTokenForTests('owner') });
        const machine = ManagedMachineV1Schema.parse({ id: 'pending', homeId: 'srv_inventory_revalidate', custodianAccountId: 'owner',
            launch: { provider: { pluginId: 'custom.provisioner', localId: 'native' }, schemaVersion: 1, name: 'Guest', choices: {} },
            controller: { machineId: 'controller', installationId: 'installation' }, allocation: 'may-exist', creationState: 'active',
            desired: 'start', desiredWhen: 'now', intentRevision: 1, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false });
        const revalidation = createDeferred<Response>();
        let reads = 0;
        setRuntimeFetch(async input => {
            const path = new URL(String(input)).pathname;
            if (path === '/v1/auth/ping') return Response.json({ ok: true });
            if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (path === '/v1/machines/managed/actions/list') return reads++ === 0
                ? Response.json({ machines: [machine] }) : revalidation.promise;
            return Response.json({ error: 'not_found' }, { status: 404 });
        });
        const execute = createDefaultActionExecutor().execute;
        const hook = await renderHook(() => useManagedMachineInventory([target.id], undefined,
            execute), { flushOptions: { cycles: 20 } });
        await waitForHomeGovernance(() => expect(hook.getCurrent().entries.srv_inventory_revalidate?.status).toBe('ready'));
        expect(hook.getCurrent().entries.srv_inventory_revalidate?.status).toBe('ready');
        const displayRows = hook.getCurrent().machinesByServerId;
        const enrolledRows = hook.getCurrent().machinesByEnrolledMachineIdByServerId;
        await act(async () => publishHomeAccountChange(target.id));
        await waitForHomeGovernance(() => expect(reads).toBe(2));
        expect(reads).toBe(2);
        expect(hook.getCurrent().entries.srv_inventory_revalidate).toMatchObject({ status: 'ready', machines: [{ id: 'pending' }] });
        expect(hook.getCurrent().loading).toBe(false);
        await act(async () => revalidation.resolve(Response.json({ machines: [machine] })));
        await flushHookEffects({ cycles: 20 });
        expect(hook.getCurrent().entries.srv_inventory_revalidate?.status).toBe('ready');
        // The completed read is a new receipt, not new Machine display facts.
        // A rebuilt index invalidates the entire open picker even though its
        // admitted row array was retained by this same inventory owner.
        expect(hook.getCurrent().machinesByServerId).toBe(displayRows);
        expect(hook.getCurrent().machinesByEnrolledMachineIdByServerId).toBe(enrolledRows);
        await hook.unmount();
    });
    it('isolates shared demand by Home and retires old Account reads before accepting a replacement', async () => {
        const oldReply = createDeferred<Response>();
        let delayAlice = false;
        const row = (homeId: string, accountId: string) => ManagedMachineV1Schema.parse({ id: 'guest', homeId,
            custodianAccountId: accountId,
            launch: { provider: { pluginId: 'custom.provisioner', localId: 'native' }, schemaVersion: 1, name: `${accountId} guest`, choices: {} },
            controller: { machineId: 'controller', installationId: 'installation' }, allocation: 'may-exist', creationState: 'active',
            desired: 'start', desiredWhen: 'now', intentRevision: 1, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false });
        const homes = await serveAccountHomes({ homes: [
            { key: 'a', serverUrl: 'https://shared-inventory-a.test', serverIdentityId: 'srv_shared_a', accountId: 'alice' },
            { key: 'b', serverUrl: 'https://shared-inventory-b.test', serverIdentityId: 'srv_shared_b', accountId: 'cara' },
        ], route: request => request.path === '/v1/machines/managed/actions/get'
            ? delayAlice && request.accountId === 'alice' ? oldReply.promise
                : Response.json(row(request.home === 'a' ? 'srv_shared_a' : 'srv_shared_b', request.accountId!)) : undefined });
        const execute = createDefaultActionExecutor().execute;
        const a = homes.homes.a!.id;
        const b = homes.homes.b!.id;
        const hook = await renderHook(() => ({
            first: useManagedMachineInventory([a], 'guest', execute),
            second: useManagedMachineInventory([a], 'guest', execute),
            other: useManagedMachineInventory([b], 'guest', execute),
        }), { flushOptions: { cycles: 25 } });
        try {
            const requests = () => homes.requests.filter(request => request.path === '/v1/machines/managed/actions/get');
            // Real connection restoration can invalidate the focused Home during bootstrap.
            // This case owns Account isolation; the scale-shaped case above owns shared-read cost.
            expect(hook.getCurrent().first.machinesByServerId[a]).toMatchObject([{ custodianAccountId: 'alice' }]);
            expect(hook.getCurrent().other.machinesByServerId[b]).toMatchObject([{ custodianAccountId: 'cara' }]);
            expect(hook.getCurrent().first.machinesByServerId[a]).toBe(hook.getCurrent().second.machinesByServerId[a]);
            const previousAccountReads = requests().filter(request => request.home === 'a').length;
            const otherRows = hook.getCurrent().other.machinesByServerId[b];
            delayAlice = true;
            await act(async () => publishHomeAccountChange(a));
            await waitForHomeGovernance(() => expect(requests().filter(request => request.home === 'a')).toHaveLength(previousAccountReads + 1));
            await act(async () => homes.switchAccount('a', 'bob'));
            await waitForHomeGovernance(() => expect(hook.getCurrent().first.machinesByServerId[a]).toMatchObject([{ launch: { name: 'bob guest' } }]));
            expect(hook.getCurrent().first.machinesByServerId[a]).toMatchObject([{ launch: { name: 'bob guest' } }]);
            expect(hook.getCurrent().second.machinesByServerId[a]).toBe(hook.getCurrent().first.machinesByServerId[a]);
            await act(async () => oldReply.resolve(Response.json(row('srv_shared_a', 'alice'))));
            await flushHookEffects({ cycles: 25 });
            expect(hook.getCurrent().first.machinesByServerId[a]).toMatchObject([{ launch: { name: 'bob guest' } }]);
            expect(hook.getCurrent().other.machinesByServerId[b]).toBe(otherRows);
            expect(requests().filter(request => request.home === 'a').slice(previousAccountReads).map(request => request.accountId))
                .toEqual(['alice', 'bob']);
        } finally { oldReply.resolve(Response.json(row('srv_shared_a', 'alice'))); await hook.unmount(); await homes.dispose(); }
    });
    it('reads archived recovery alongside current resources only for the Machines collection', async () => {
        const target = await upsertAndActivateServer({ serverUrl: 'https://archived-inventory.test', scope: 'tab' });
        await setServerProfileIdentityForUrl(target.serverUrl, 'srv_archived');
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token: createAccountTokenForTests('owner') });
        const inputs: unknown[] = [];
        let archiveReply: 'ready' | 'unavailable' | 'denied' = 'ready';
        const machine = { id: 'active', homeId: 'srv_archived', custodianAccountId: 'owner',
            launch: { provider: { pluginId: 'custom.provisioner', localId: 'native' }, schemaVersion: 1, name: 'Guest', choices: {} },
            controller: { machineId: 'controller', installationId: 'installation' }, allocation: 'may-exist', creationState: 'active',
            desired: 'start', desiredWhen: 'now', intentRevision: 1, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false };
        setRuntimeFetch(async (raw, init) => {
            const path = new URL(String(raw)).pathname;
            if (path === '/v1/auth/ping') return Response.json({ ok: true });
            if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            const input = JSON.parse(String(init?.body));
            inputs.push(input);
            if (input.archived && archiveReply === 'unavailable') throw new Error('archive_unavailable');
            if (input.archived && archiveReply === 'denied') return Response.json({ code: 'permission_denied' }, { status: 403 });
            return Response.json({ machines: [input.archived ? { ...machine, id: 'retired', archivedAt: 1 } : machine] });
        });
        const execute = createDefaultActionExecutor().execute;
        const hook = await renderHook(() => useManagedMachineInventory([target.id], undefined, execute, true), { flushOptions: { cycles: 20 } });
        await waitForHomeGovernance(() => expect(hook.getCurrent().entries.srv_archived?.status).toBe('ready'));
        expect(inputs).toEqual([{ homeId: 'srv_archived' }, { homeId: 'srv_archived', archived: true }]);
        expect(hook.getCurrent().machinesByServerId[target.id]?.map(row => row.id)).toEqual(['active', 'retired']);
        archiveReply = 'unavailable';
        machine.launch.name = 'Current guest';
        await act(async () => publishHomeAccountChange(target.id));
        await waitForHomeGovernance(() => expect(hook.getCurrent().entries.srv_archived?.status).toBe('error'));
        expect(hook.getCurrent().entries.srv_archived?.status).toBe('error');
        expect(hook.getCurrent().machinesByServerId[target.id]?.[0]?.launch?.name).toBe('Current guest');
        expect(hook.getCurrent().machinesByServerId[target.id]?.map(row => row.id)).toEqual(['active', 'retired']);
        archiveReply = 'denied';
        await act(async () => publishHomeAccountChange(target.id));
        await waitForHomeGovernance(() => expect(hook.getCurrent().entries.srv_archived?.status).toBe('denied'));
        expect(hook.getCurrent().machinesByServerId[target.id]).toEqual([]);
        await hook.unmount();
    });
    it('admits a later current-only reader from a settled archive-including inventory without a second list read', async () => {
        const target = await upsertAndActivateServer({ serverUrl: 'https://derived-inventory.test', scope: 'tab' });
        await setServerProfileIdentityForUrl(target.serverUrl, 'srv_derived');
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token: createAccountTokenForTests('owner') });
        const inputs: unknown[] = [];
        const machine = { id: 'active', homeId: 'srv_derived', custodianAccountId: 'owner',
            launch: { provider: { pluginId: 'custom.provisioner', localId: 'native' }, schemaVersion: 1, name: 'Guest', choices: {} },
            controller: { machineId: 'controller', installationId: 'installation' }, allocation: 'may-exist', creationState: 'active',
            desired: 'start', desiredWhen: 'now', intentRevision: 1, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false };
        setRuntimeFetch(async (raw, init) => {
            const path = new URL(String(raw)).pathname;
            if (path === '/v1/auth/ping') return Response.json({ ok: true });
            if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            const input = JSON.parse(String(init?.body));
            inputs.push(input);
            return Response.json({ machines: [input.archived ? { ...machine, id: 'retired', archivedAt: 1 } : machine] });
        });
        const execute = createDefaultActionExecutor().execute;
        const collection = await renderHook(() => useManagedMachineInventory([target.id], undefined, execute, true), { flushOptions: { cycles: 20 } });
        await waitForHomeGovernance(() => expect(collection.getCurrent().entries.srv_derived?.status).toBe('ready'));
        const picker = await renderHook(() => useManagedMachineInventory([target.id], undefined, execute), { flushOptions: { cycles: 20 } });
        await waitForHomeGovernance(() => expect(picker.getCurrent().entries.srv_derived?.status).toBe('ready'));
        expect({ reads: inputs.length, rows: picker.getCurrent().machinesByServerId[target.id]?.map(row => row.id) })
            .toEqual({ reads: 2, rows: ['active'] });
        // Both readers still follow a real change.
        machine.launch.name = 'Renamed';
        await act(async () => publishHomeAccountChange(target.id));
        await waitForHomeGovernance(() => expect(picker.getCurrent().machinesByServerId[target.id]?.[0]?.launch?.name).toBe('Renamed'));
        await picker.unmount();
        await collection.unmount();
    });
    it('keeps Ask-first list and saved-resource reads on the mounted public review while retaining rows after cancellation', async () => {
        const target = await upsertAndActivateServer({ serverUrl: 'https://managed-inventory-approval.test', scope: 'tab' });
        await setServerProfileIdentityForUrl(target.serverUrl, 'srv_inventory_approval');
        const other = await upsertServerProfileOnly({ serverUrl: 'https://other-inventory-approval.test' });
        await setServerProfileIdentityForUrl(other.serverUrl, 'srv_other_inventory');
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token: createAccountTokenForTests('owner', { currentAccount: true }) });
        const machine = { id: 'pending', homeId: 'srv_inventory_approval', custodianAccountId: 'owner',
            launch: { provider: { pluginId: 'custom.provisioner', localId: 'native' }, schemaVersion: 1, name: 'Guest', choices: {} },
            controller: { machineId: 'controller', installationId: 'installation' }, allocation: 'may-exist', creationState: 'active',
            desired: 'start', desiredWhen: 'now', intentRevision: 1, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false };
        const settings = managedUiApprovalSettings(['machines.managed.list', 'machines.managed.get']);
        const reads: string[] = [];
        let otherListReads = 0;
        setRuntimeFetch(async (raw, init) => {
            const url = new URL(String(raw));
            const path = url.pathname;
            if (path === '/v1/auth/ping') return Response.json({ ok: true });
            if (url.host === 'other-inventory-approval.test') {
                if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
                if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
                if (path === '/v1/machines/managed/actions/list') { otherListReads++; return Response.json({ machines: [{ ...machine, homeId: 'srv_other_inventory' }] }); }
                if (path === '/v1/machines/managed/actions/get') return Response.json({ ...machine, homeId: 'srv_other_inventory' });
            }
            if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: settings }, version: 1 });
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse());
            if (path === '/v1/machines/managed/actions/list') { reads.push('list'); return Response.json({ machines: [machine] }); }
            if (path === '/v1/machines/managed/actions/get') { reads.push('get'); return Response.json(machine); }
            return Response.json({ error: 'unexpected_route' }, { status: 404 });
        });
        await act(async () => storage.getState().applySettingsLocal(settings));
        const execute = createDefaultActionExecutor().execute;
        const decisions = Array.from({ length: 4 }, () => createDeferred<boolean>());
        const confirmation = vi.spyOn(Modal, 'confirm');
        for (const decision of decisions) confirmation.mockImplementationOnce(() => decision.promise);
        const hook = await renderHook(({ id }: { id?: string }) => {
            const inventory = useManagedMachineInventory([target.id, other.id], id, execute);
            const joined = useManagedMachineInventory([target.id], id, execute);
            return { ...inventory, joined };
        },
            { initialProps: {}, flushOptions: { cycles: 20 } });
        try {
            await vi.waitFor(() => expect(confirmation).toHaveBeenCalledTimes(1));
            expect(hook.getCurrent().entries.srv_inventory_approval).toMatchObject({ status: 'loading' });
            expect(hook.getCurrent().entries.srv_inventory_approval?.approval).toBeUndefined();
            expect(reads).toEqual([]);
            expect(hook.getCurrent().machinesByServerId[target.id]).toEqual([]);
            await act(async () => decisions[0]!.resolve(true));
            await waitForHomeGovernance(() => expect(hook.getCurrent().entries.srv_inventory_approval)
                .toMatchObject({ status: 'ready', machines: [{ id: 'pending' }] }));
            expect(reads).toEqual(['list']);
            const otherReadsBefore = otherListReads;
            await act(async () => publishHomeAccountChange(other.id));
            await waitForHomeGovernance(() => expect(otherListReads).toBe(otherReadsBefore + 1));
            await act(async () => publishHomeAccountChange(target.id, ['unrelated-artifact'], { changeKinds: ['artifact'] }));
            await flushHookEffects({ cycles: 20 });
            expect(reads).toEqual(['list']);
            await hook.rerender({ id: machine.id });
            await vi.waitFor(() => expect(confirmation).toHaveBeenCalledTimes(2));
            expect(hook.getCurrent().machinesByServerId[target.id]).toEqual([]);
            await act(async () => decisions[1]!.resolve(true));
            await waitForHomeGovernance(() => expect(hook.getCurrent().entries.srv_inventory_approval)
                .toMatchObject({ status: 'ready', machines: [{ id: 'pending' }] }));
            // Naming the exact saved resource for native Ask is separate from its accepted inventory read.
            expect(reads).toEqual(['list', 'get', 'get']);
            await act(async () => publishHomeAccountChange(target.id));
            await vi.waitFor(() => expect(confirmation).toHaveBeenCalledTimes(3));
            expect(hook.getCurrent().machinesByServerId[target.id]).toMatchObject([{ id: 'pending' }]);
            await act(async () => decisions[2]!.resolve(false));
            await waitForHomeGovernance(() => expect(hook.getCurrent().entries.srv_inventory_approval)
                .toMatchObject({ status: 'error', errorCode: 'approval_canceled', machines: [{ id: 'pending' }] }));
            expect(reads).toEqual(['list', 'get', 'get', 'get']);
            await act(async () => publishHomeAccountChange(target.id));
            await vi.waitFor(() => expect(confirmation).toHaveBeenCalledTimes(4));
            await act(async () => decisions[3]!.resolve(true));
            await waitForHomeGovernance(() => expect(hook.getCurrent().entries.srv_inventory_approval)
                .toMatchObject({ status: 'ready', machines: [{ id: 'pending' }] }));
            expect(hook.getCurrent().entries.srv_inventory_approval?.errorCode).toBeUndefined();
            expect(reads).toEqual(['list', 'get', 'get', 'get', 'get', 'get']);
        } finally {
            await hook.unmount();
        }
    });

    it('retains rows through network failure, then removes protected content after current access refusal', async () => {
        const target = await upsertAndActivateServer({ serverUrl: 'https://managed-inventory.test', scope: 'tab' });
        await setServerProfileIdentityForUrl(target.serverUrl, 'srv_inventory');
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token: createAccountTokenForTests('owner') });
        let reply: 'row' | 'unavailable' | 'unsupported' | 'denied' = 'row';
        const machine = { id: 'pending', homeId: 'srv_inventory', custodianAccountId: 'owner',
            launch: { provider: { pluginId: 'custom.provisioner', localId: 'native' }, schemaVersion: 1, name: 'Guest', choices: {} },
            controller: { machineId: 'controller', installationId: 'installation' }, allocation: 'may-exist', creationState: 'active',
            desired: 'start', desiredWhen: 'now', intentRevision: 1, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
            enrolledMachineId: 'joined-machine' };
        setRuntimeFetch(async input => {
            const url = new URL(String(input));
            if (url.pathname === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (reply === 'unavailable') throw new Error('network_unavailable');
            if (reply === 'unsupported') return new Response('Not found', { status: 404 });
            if (reply === 'denied') return Response.json({ code: 'permission_denied' }, { status: 403 });
            return Response.json({ machines: [machine] });
        });
        // The real executor bypasses only Metro's module loader, not Action policy or Account capture.
        const execute = createDefaultActionExecutor().execute;
        const hook = await renderHook(() => useManagedMachineInventory([target.id], undefined, execute), { flushOptions: { cycles: 20 } });
        await waitForHomeGovernance(() => expect(hook.getCurrent().entries.srv_inventory?.status).toBe('ready'));
        expect(hook.getCurrent().entries.srv_inventory?.status).toBe('ready');
        expect(hook.getCurrent().machinesByServerId[target.id]).toMatchObject([{ id: 'pending' }]);
        expect(hook.getCurrent()).toMatchObject({ machinesByEnrolledMachineIdByServerId: {
            [target.id]: { 'joined-machine': { id: 'pending' } },
        } });
        reply = 'unavailable';
        await act(async () => publishHomeAccountChange(target.id));
        await waitForHomeGovernance(() => expect(hook.getCurrent().entries.srv_inventory?.status).toBe('error'));
        expect(hook.getCurrent().machinesByServerId[target.id]).toMatchObject([{ id: 'pending' }]);
        reply = 'unsupported';
        await act(async () => publishHomeAccountChange(target.id));
        await waitForHomeGovernance(() => expect(hook.getCurrent().entries.srv_inventory?.status).toBe('unsupported'));
        expect(hook.getCurrent().machinesByServerId[target.id]).toMatchObject([{ id: 'pending' }]);
        expect(hook.getCurrent().entries.srv_inventory?.status).toBe('unsupported');
        reply = 'denied';
        await act(async () => publishHomeAccountChange(target.id));
        await waitForHomeGovernance(() => expect(hook.getCurrent().entries.srv_inventory?.status).toBe('denied'));
        expect(hook.getCurrent().machinesByServerId[target.id]).toEqual([]);
        expect(hook.getCurrent()).toMatchObject({ machinesByEnrolledMachineIdByServerId: { [target.id]: {} } });
        await hook.unmount();
    });

    it('does not fetch protected inventory or spin forever for a signed-out Home', async () => {
        const target = await upsertAndActivateServer({ serverUrl: 'https://signed-out-inventory.test', scope: 'tab' });
        await setServerProfileIdentityForUrl(target.serverUrl, 'srv_signed_out');
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue(null);
        const network = vi.fn(async () => Response.json({ machines: [] }));
        setRuntimeFetch(network);
        const hook = await renderHook(() => useManagedMachineInventory([target.id]), { flushOptions: { cycles: 20 } });
        expect(hook.getCurrent().machinesByServerId[target.id]).toEqual([]);
        expect(hook.getCurrent().loading).toBe(false);
        expect(network).not.toHaveBeenCalled();
        await hook.unmount();
    });

    it('does not retain the previous resource while a different saved destination is being read', async () => {
        const target = await upsertAndActivateServer({ serverUrl: 'https://managed-target-switch.test', scope: 'tab' });
        await setServerProfileIdentityForUrl(target.serverUrl, 'srv_switch');
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token: createAccountTokenForTests('owner') });
        const machine = { id: 'first', homeId: 'srv_switch', custodianAccountId: 'owner',
            launch: { provider: { pluginId: 'custom.provisioner', localId: 'native' }, schemaVersion: 1, name: 'First resource', choices: {} },
            controller: { machineId: 'controller', installationId: 'installation' }, allocation: 'may-exist', creationState: 'active',
            desired: 'start', desiredWhen: 'now', intentRevision: 1, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false };
        const second = createDeferred<Response>();
        setRuntimeFetch(async (input, init) => {
            const url = new URL(String(input));
            if (url.pathname === '/v1/auth/ping') return Response.json({ ok: true });
            if (url.pathname === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            return JSON.parse(String(init?.body)).managedId === 'second' ? second.promise : Response.json(machine);
        });
        const execute = createDefaultActionExecutor().execute;
        const hook = await renderHook(({ id }: { id: string }) => useManagedMachineInventory([target.id], id, execute),
            { initialProps: { id: 'first' }, flushOptions: { cycles: 20 } });
        await waitForHomeGovernance(() => expect(hook.getCurrent().machinesByServerId[target.id]).toMatchObject([{ id: 'first' }]));
        expect(hook.getCurrent().machinesByServerId[target.id]).toMatchObject([{ id: 'first' }]);
        await hook.rerender({ id: 'second' });
        expect(hook.getCurrent().machinesByServerId[target.id]).toEqual([]);
        await act(async () => second.resolve(Response.json({ ...machine, id: 'second', launch: { ...machine.launch, name: 'Second resource' } })));
        await waitForHomeGovernance(() => expect(hook.getCurrent().machinesByServerId[target.id]).toMatchObject([{ id: 'second' }]));
        expect(hook.getCurrent().machinesByServerId[target.id]).toMatchObject([{ id: 'second' }]);
        await hook.unmount();
    });
});
