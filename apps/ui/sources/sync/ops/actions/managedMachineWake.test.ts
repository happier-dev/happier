import { afterEach, describe, expect, it, vi } from 'vitest';
import { ManagedMachineV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { createActionExecutor, createHostReviewedChildPortV1, readHostReviewedChildOperationV1 } from '@happier-dev/protocol/actions/actionExecutor';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { installApprovalCommonModuleMocks } from '@/components/approvals/approvalsTestHelpers';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createDeferred, flushHookEffects, standardCleanup } from '@/dev/testkit';
import { createMachineFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { observeMachinePresenceForTest } from '@/dev/testkit/harness/machinePresence';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { storage } from '@/sync/domains/state/storage';
import { captureLazyActionAccountContext } from './actionAccountContext';
import { prepareUiManagedMachineWake } from './managedMachineWakePreparation';

const packaged = vi.hoisted(() => ({ artifacts: [] as unknown[], declarations: [] as unknown[],
    files: new Map<number, Uint8Array>(), reads: 0 }));
// Bundled plugin inventory is a platform boundary. Account selection and
// descriptor-derived admission remain real, as in the Account origination test.
vi.mock('@/sync/domains/plugins/availability/generatedBundledPluginUiArtifacts', () => ({
    get BUNDLED_PLUGIN_UI_APP_ARTIFACTS() { return packaged.artifacts; },
    get BUNDLED_PLUGIN_UI_APP_DECLARATIONS() { return packaged.declarations; },
    BUNDLED_PLUGIN_BRAND_MARKS: [], BUNDLED_PLUGIN_PACKAGED_RESOURCES: [],
}));
const [{ PLUGIN_MANIFEST }, { prepareAuthenticationInventory }, { replacePluginAccountAvailabilityProjection }] = await Promise.all([
    import('../../../../../../packages/plugins/machine-vercel/src/manifest'),
    import('@/dev/testkit/fixtures/connectedAccountAuthentication'),
    import('@/sync/domains/plugins/availability/projection'),
]);
await prepareAuthenticationInventory(packaged, { manifest: PLUGIN_MANIFEST,
    target: { artifactId: 'account-runtime', exportName: 'activateAccount' },
    projectPath: 'packages/plugins/machine-vercel', entryPath: 'packages/plugins/machine-vercel/src/manifest.ts',
    packageName: '@happier-dev/plugins-machine-vercel' });

installApprovalCommonModuleMocks();
afterEach(async () => { await standardCleanup(); });

describe('managed explicit execution readiness', () => {
    it.each([
        { active: true, classified: true }, { active: false, classified: true },
        { active: true, classified: false }, { active: false, classified: false },
    ])('spawns on an ordinary Machine without managed wake (active=$active, classified=$classified)', async ({ active, classified }) => {
        const managedReads: unknown[] = [];
        const targetReads: unknown[] = [];
        const machine = createMachineFixture({ id: 'ordinary', active, managedMachineRef: classified ? null : undefined });
        const homes = await serveAccountHomes({ homes: [
            { key: 'a', serverUrl: 'https://ordinary-spawn.test', serverIdentityId: 'srv_ordinary_spawn', accountId: 'owner' },
        ], route: request => {
            if (request.path === '/v1/machines/read-batch') {
                targetReads.push(request.body);
                return Response.json({ results: [{ machineId: machine.id, status: 'found',
                    machine: createPlainMachineRowFixture({ id: machine.id, accountId: 'owner', machine }) }] });
            }
            if (!request.path.includes('/machines/managed/')) return undefined;
            managedReads.push({ path: request.path, body: request.body });
            return Response.json({ machines: [] });
        } });
        const account = await captureLazyActionAccountContext(homes.homes.a!.id);
        let spawns = 0;
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({
            isActionApprovalRequired: () => false,
            prepareHostReviewedChildren: request => prepareUiManagedMachineWake(request, account),
            // The daemon transport is the boundary; real Action admission and wake preparation stay in the path.
            sessionSpawnNew: async () => {
                spawns++;
                return active ? { type: 'pending', retryWithSameCreationKey: true, outcome: 'accepted' }
                    : { type: 'error', code: 'machine_offline', retryable: true };
            },
        }));
        try {
            storage.getState().applyMachines([machine], false,
                { sourceServerId: account.serverId, sourceAccountId: account.accountId });
            if (active) observeMachinePresenceForTest(account.accountLifetime.scope, ['ordinary']);
            const result = await executor.execute('session.spawn_new', {
                creationKey: 'ordinary-spawn', executionTarget: { serverId: account.serverId, machineId: 'ordinary' },
                directory: { kind: 'path', path: '/repo' }, organizationPlacement: { sectionId: null, tagIds: [] },
                agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
            }, { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
                serverId: account.serverId, serverIdentityId: account.serverIdentityId, runtimeAccountId: account.accountId });
            expect(result).toMatchObject(active ? { ok: true, result: { type: 'pending', outcome: 'accepted' } }
                : { ok: true, result: { type: 'error', code: 'machine_offline', retryable: true } });
            expect(spawns).toBe(1);
            expect(managedReads).toEqual([]);
            expect(targetReads).toEqual(classified ? [] : [{ machineIds: ['ordinary'] }]);
        } finally { account.dispose(); await homes.dispose(); }
    });

    it.each(['session.open', 'session.spawn_new', 'machines.terminal.open', 'execution.run.start'] as const)(
        'runs admitted %s on the exactly enrolled connected guest when native Inspect is unavailable', async actionId => {
        const managed = ManagedMachineV1Schema.parse({ id: 'managed', homeId: 'srv_wake_unavailable', custodianAccountId: 'owner', enrolledMachineId: 'guest',
            launch: { provider: { pluginId: 'custom.compute', localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} },
            resource: { contributionRef: { pluginId: 'custom.compute', localId: 'vm' }, schemaVersion: 1, value: { id: 'same-native' } },
            allocation: 'bound', creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 1,
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
            observation: { availability: 'unavailable', observedAt: 2 },
        });
        const homes = await serveAccountHomes({ homes: [
            { key: 'a', serverUrl: 'https://managed-wake-unavailable.test', serverIdentityId: managed.homeId, accountId: 'owner' },
        ], route: request => request.path === '/v1/machines/managed/actions/get' ? Response.json(managed) : undefined });
        const account = await captureLazyActionAccountContext(homes.homes.a!.id);
        const signal = new AbortController();
        try {
            storage.getState().applyMachines([createMachineFixture({ id: 'guest', active: true, presenceProtocolVersion: 1,
                managedMachineRef: { homeId: managed.homeId, managedId: managed.id } })], false,
                { sourceServerId: account.serverId, sourceAccountId: account.accountId });
            observeMachinePresenceForTest(account.accountLifetime.scope, ['guest']);
            const input = actionId === 'session.open' ? { sessionId: 'same-session', intent: 'resume' } : { machineId: 'guest' };
            const context = { surface: 'ui' as const, signal: signal.signal };
            const plan = await prepareUiManagedMachineWake({ actionId, input, context,
                machineRuntimeDemand: { target: { kind: 'machine', machineId: 'guest' } } }, account);
            if (!plan || 'ok' in plan || !plan.executeAdmittedAction) throw new Error('Expected runtime preparation');
            expect(plan.children).toEqual([]);
            const result = await plan.executeAdmittedAction({ actionId, input, context,
                execute: async (_original, target) => ({ ok: true, result: target }) });
            expect(result).toEqual({ ok: true, result: { machineId: 'guest' } });
        } finally { signal.abort(); account.dispose(); await homes.dispose(); }
    });

    it.each(['execution.run.start', 'machines.terminal.open', 'daemon.filesystem.readFile', 'workspace.sync.relationship.flush'] as const)(
        'does not run admitted %s before its original reviewed wake settles', async actionId => {
        const provisioner = PLUGIN_MANIFEST.contributes.machineProvisioners?.[0];
        if (!provisioner) throw new Error('Missing packaged Vercel provisioner');
        const launch = { provider: { pluginId: PLUGIN_MANIFEST.id, localId: provisioner.id }, schemaVersion: 1, name: 'Guest', choices: {} };
        const retention = { kind: 'until-delete' as const };
        let managed = ManagedMachineV1Schema.parse({ id: 'managed', homeId: 'srv_generic_wake', custodianAccountId: 'owner', enrolledMachineId: 'guest',
            launch,
            resource: { contributionRef: launch.provider, schemaVersion: 1, value: { id: 'same-native' } },
            allocation: 'bound', creationState: 'active', desired: 'stop', desiredWhen: 'now', intentRevision: 3,
            retention, wakeOnAcceptedMessage: false,
            reviewedFacts: { launch, provisioner, retention, retentionCapabilities: provisioner.retention,
                billing: provisioner.billing, optionStatus: 'current', prerequisites: [], wakeOnAcceptedMessage: false },
            observation: { availability: 'present', power: 'stopped', storage: 'retained', observedAt: 1 },
        });
        const homes = await serveAccountHomes({ homes: [
            { key: 'a', serverUrl: 'https://generic-wake.test', serverIdentityId: 'srv_generic_wake', accountId: 'owner' },
        ], route: request => request.path === '/v1/machines/managed/actions/get' ? Response.json(managed) : undefined });
        const account = await captureLazyActionAccountContext(homes.homes.a!.id);
        storage.getState().applyMachines([createMachineFixture({ id: 'guest', active: false,
            managedMachineRef: { homeId: managed.homeId, managedId: managed.id } })], false,
            { sourceServerId: account.serverId, sourceAccountId: account.accountId });
        replacePluginAccountAvailabilityProjection({ scope: account.accountLifetime.scope,
            snapshot: { availabilityCursor: 1, intentReads: [], materializations: [], snapshots: [] } });
        const signal = new AbortController();
        const entered = createDeferred<void>();
        const release = createDeferred<void>();
        const effects: string[] = [];
        const base: ActionExecutorContext = { signal: signal.signal, surface: 'ui', serverId: account.serverId,
            externalActionTarget: { kind: 'machine', machineId: 'guest' } };
        const input = actionId === 'workspace.sync.relationship.flush'
            ? { controllerMachineId: 'guest', relationshipId: 'sync-link' }
            : { sessionId: null, machineId: 'guest', serverId: account.serverId };
        const demand = getActionSpec(actionId).machineRuntimeDemandForInput?.(input, base);
        expect(demand?.target).toEqual({ kind: 'machine', machineId: 'guest' });
        const plan = await prepareUiManagedMachineWake({ actionId, input, context: base,
            machineRuntimeDemand: demand ?? undefined }, account);
        if (!plan || 'ok' in plan || !plan.executeAdmittedAction) throw new Error('Expected canonical wake preparation');
        managed = { ...managed, intentRevision: 4, observation: { ...managed.observation!, power: 'running' } };
        // Real host child issuer; only the eventual native Action effect is an external boundary.
        const context: ActionExecutorContext = { ...base,
            hostReviewedChild: createHostReviewedChildPortV1({ actionId, input, context: base, plan,
                policies: [{ action: 'machines.managed.power.set', role: 'managed-wake', surface: 'ui', requiredActionIds: [] }],
                execute: async (childInput, childContext, childActionId) => {
                effects.push('power');
                expect(childActionId).toBe('machines.managed.power.set');
                expect(childInput).toEqual({ homeId: 'srv_generic_wake', managedId: 'managed', intent: 'start', when: 'now', expectedRevision: 3 });
                expect(readHostReviewedChildOperationV1(childContext, childActionId, childInput)?.parent.actionId).toBe(actionId);
                entered.resolve();
                await release.promise;
                return { ok: false, errorCode: 'native_intent_unconfirmed', error: 'native_intent_unconfirmed' };
            } }),
        };
        const operation = plan.executeAdmittedAction({ actionId, input, context,
            execute: async original => { expect(original).toBe(context); effects.push('original'); return { ok: true, result: actionId }; },
        });
        try {
            await flushHookEffects();
            expect(effects).toEqual(['power']);
            await entered.promise;
            expect(effects).toEqual(['power']);
            release.resolve();
            await expect(operation).rejects.toMatchObject({ code: 'native_intent_unconfirmed' });
            expect(effects).toEqual(['power']);
        } finally { signal.abort(); release.resolve(); await operation.catch(() => {}); account.dispose(); await homes.dispose(); }
    });

    it('runs a passive original with no Machine reads or child power', async () => {
        const context = { surface: 'ui' as const };
        expect(await prepareUiManagedMachineWake({ actionId: 'session.open', input: { sessionId: 'same-session' }, context }, undefined)).toBeNull();
    });

    it('holds the original operation across native running until the same guest actually connects', async () => {
        let managed = ManagedMachineV1Schema.parse({ id: 'managed', homeId: 'srv_wake_ready', custodianAccountId: 'owner', enrolledMachineId: 'guest',
            launch: { provider: { pluginId: 'custom.compute', localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} },
            resource: { contributionRef: { pluginId: 'custom.compute', localId: 'vm' }, schemaVersion: 1, value: { id: 'same-native' } },
            allocation: 'bound', creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 1,
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
            submittedNativeEffect: { intent: 'start', requestId: 'existing-start', intentRevision: 1 },
            observation: { availability: 'present', power: 'stopped', storage: 'retained', observedAt: 1 },
        });
        const read = createDeferred<void>();
        const requests: string[] = [];
        const homes = await serveAccountHomes({ homes: [
            { key: 'a', serverUrl: 'https://managed-wake-ready.test', serverIdentityId: 'srv_wake_ready', accountId: 'owner' },
        ], route: request => {
            if (!request.path.includes('/machines/managed/')) return undefined;
            requests.push(request.path);
            expect(request.path).toBe('/v1/machines/managed/actions/get');
            expect(request.body).toEqual({ homeId: 'srv_wake_ready', managedId: 'managed' });
            read.resolve();
            return Response.json(managed);
        } });
        const account = await captureLazyActionAccountContext(homes.homes.a!.id);
        storage.getState().applyMachines([createMachineFixture({ id: 'guest', active: false,
            managedMachineRef: { homeId: managed.homeId, managedId: managed.id } })], false,
            { sourceServerId: account.serverId, sourceAccountId: account.accountId });
        const signal = new AbortController();
        let executions = 0;
        const context = { signal: signal.signal };
        const plan = await prepareUiManagedMachineWake({ actionId: 'machines.terminal.open', input: { machineId: 'guest' },
            machineRuntimeDemand: { target: { kind: 'machine', machineId: 'guest' } }, context }, account);
        if (!plan || 'ok' in plan || !plan.executeAdmittedAction) throw new Error('Expected runtime preparation');
        const operation = plan.executeAdmittedAction({ actionId: 'machines.terminal.open', input: { machineId: 'guest' }, context,
            execute: async (original, target) => {
                expect(original).toBe(context);
                expect(target).toEqual({ machineId: 'guest' });
                executions++; return { ok: true, result: 'same-session' };
            },
        });
        try {
            await Promise.resolve();
            expect(executions).toBe(0);
            await read.promise;
            expect(executions).toBe(0);
            managed = { ...managed, observation: { ...managed.observation!, power: 'running', observedAt: 2 } };
            const runningRead = createDeferred<void>();
            publishHomeAccountChange(account.serverId, ['managed'], { source: 'socket', machineResourcesAffect: true });
            // The existing inventory refresh promise ends at publication, without a timer.
            const { retainManagedMachineInventory } = await import('@/components/settings/machines/managed/useManagedMachineInventory');
            const inventory = retainManagedMachineInventory(account.accountLifetime, entry => {
                if (entry.machines[0]?.observation?.power === 'running') runningRead.resolve();
            }, { managedId: 'managed' });
            try { await runningRead.promise; } finally { inventory.dispose(); }
            expect(executions).toBe(0);
            storage.getState().applyMachines([createMachineFixture({ id: 'guest', active: true, activeAt: 2, presenceProtocolVersion: 1,
                managedMachineRef: { homeId: managed.homeId, managedId: managed.id } })], false,
                { sourceServerId: account.serverId, sourceAccountId: account.accountId });
            observeMachinePresenceForTest(account.accountLifetime.scope, ['guest']);
            expect(await operation).toEqual({ ok: true, result: 'same-session' });
            expect(executions).toBe(1);
            const readsBeforeDisposeNotification = requests.length;
            publishHomeAccountChange(account.serverId, ['managed'], { source: 'socket', machineResourcesAffect: true });
            await flushHookEffects();
            expect(requests).toHaveLength(readsBeforeDisposeNotification);
        } finally { signal.abort(); await operation.catch(() => {}); account.dispose(); await homes.dispose(); }
    });
});
