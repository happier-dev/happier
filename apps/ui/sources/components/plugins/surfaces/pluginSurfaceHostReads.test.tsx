import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, onTestFailed, vi } from 'vitest';
import { createActionExecutor} from '@happier-dev/protocol/actions/actionExecutor';
import { type UsageAnalyticsQueryResponse } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import { UsageExportInputSchema, UsageFileResultSchema } from '@happier-dev/protocol/usage/usageExport';
import { decodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { projectNativeJsonValueForTransport } from '@happier-dev/protocol/json/strictJsonValue';
import { PluginUiActionOperationHostReadResultV1Schema, PluginUiHostApiWireEnvelopeV1Schema, PluginUiJsonValueV1Schema, type PluginUiJsonObjectV1 } from '@happier-dev/protocol/plugins/ui';
import { useLivePluginResource, type PluginUiResourceSnapshot } from '@happier-dev/plugin-ui/hostApi';
import { decodePluginUiManagedMachineInventory } from '@happier-dev/plugin-sdk/ui';
import type { PluginUiResourceEntry } from '@happier-dev/plugin-ui/advanced';
import { PluginHostApiProviderInternal } from '../../../../../../packages/plugin-ui/src/hostApi/context';
import { createDeferred, flushHookEffects, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { createPluginSurfaceContextFixture } from '@/dev/testkit/fixtures/pluginSurfaceContextFixture';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { captureActiveServerAccountScopeLifetime, retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { decodeUsageQueryResource, getUsageQueryResourceStore, invalidateUsageQueryResources, readUiUsageQueryBatch } from '@/sync/api/account/usageQueryResource';
import { createCanonicalPluginReactNativeHostApiAdapter } from '@/components/plugins/reactNative/hostApi';
import { createPluginHostedWebHostApiBridgeHandler } from '@/components/plugins/hostApi/hostedWebAdapter';
import { createBoundPluginSurfaceController } from './boundPluginSurfaceController';
import { UsageAnalyticsQueryRequestSchema } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import type { PluginUiHostReadReferenceV1 } from '@happier-dev/protocol/plugins/ui/client';
import { createDiscussionActionAdapter, createDiscussionClient } from '@/sync/api/discussions/discussionActions';
import { clearDiscussionRepositoryRegistryForTests, getDiscussionRepository } from '@/sync/ops/discussions/discussionRepositoryRegistry';
import { DiscussionDetailsResultV1Schema } from '@happier-dev/protocol/discussions/actions';
import { DiscussionDetailsResponseV1Schema } from '@happier-dev/protocol/discussions/api';
import { publishMountedDiscussionChanges } from '@/sync/domains/discussions/discussionChangeWatch';
import { ActionOperationSnapshotV1Schema } from '@happier-dev/protocol/actions/operations/v1';
import { actionOperationStore } from '@/sync/domains/actionOperations/actionOperationStore';
import { isPluginError } from '@happier-dev/plugin-sdk';
import { ManagedMachineV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { useManagedMachineInventory } from '@/components/settings/machines/managed/useManagedMachineInventory';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { sync } from '@/sync/sync';

const reference = { hostRead: 'usage.query' as const, input: { queries: [{}] } };
const quotaReference = { hostRead: 'connectedServices.quota.get' as const, input: { source: { bindingKind: 'account' as const,
    ref: { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'work' } } } };
const accounting = (input: number): UsageAnalyticsQueryResponse => ({ v: 1, totals: { eventCount: 1,
    tokens: { input, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: input + 5 },
    cost: { reportedUsd: 1, estimatedUsd: 0, currency: 'USD' } } });
let home: Awaited<ReturnType<typeof serveAccountHomes>> | undefined;
const controllers: ReturnType<typeof createBoundPluginSurfaceController>[] = [];
afterEach(async () => {
    standardCleanup();
    for (const controller of controllers.splice(0)) controller.dispose();
    clearDiscussionRepositoryRegistryForTests();
    retireActiveServerAccountScopeLifetime(); await home?.dispose(); home = undefined;
    actionOperationStore.reset();
});

async function mount(route: Parameters<typeof serveAccountHomes>[0]['route'], enabled: boolean | (() => boolean) = true,
    resource: PluginUiHostReadReferenceV1 = reference, serverIdentityId?: string, pluginId = 'acme.usage') {
    home = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://mounted-usage.test', accountId: 'account-a',
        ...(serverIdentityId ? { serverIdentityId } : {}) }], route: async request => await route(request)
            ?? createEmptyAccountBootstrapHttpResponse(request.url.pathname + request.url.search, { method: request.method }) ?? undefined });
    publishAppliedActiveServerSnapshot({ serverId: home.homes.a!.id, serverUrl: home.homes.a!.serverUrl, generation: 0 });
    // Bootstrap's Session corpus starts after foreground Settings/route acquisition
    // (syncEngine.ts:8373–8385). Settle that real HTTP owner before counting unrelated IO.
    await sync.awaitBootstrapForegroundAcquisition();
    await sync.refreshSessions();
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!lifetime) throw new Error('Missing captured test Account');
    if (resource.hostRead === 'deployments.environments.list') {
        resource = { ...resource, input: { ...resource.input, serverId: lifetime.scope.serverId } };
    }
    const executor = createActionExecutor(createActionExecutorBoundaryFixture({ isActionEnabled: () => typeof enabled === 'function' ? enabled() : enabled,
        discussionAction: async args => {
            const account = await captureLazyActionAccountContext(lifetime.scope.serverId);
            try {
                return await createDiscussionActionAdapter({ scope: lifetime.scope, request: account.request,
                    accountMode: 'plain', encryption: null, availability: 'available', assertCurrent: account.assertCurrent })(args);
            } finally { account.dispose(); }
        },
        usageActions: { query: async (input, options) => {
            const context = await captureLazyActionAccountContext(lifetime.scope.serverId);
            try { return await readUiUsageQueryBatch(context, input, options.signal); }
            finally { context.dispose(); }
        } },
    }));
    const mountController = () => createBoundPluginSurfaceController({ facts: {
        pluginId, contributionId: 'summary', surfaceId: 'usage-mount', placement: 'browserSurface', platform: 'web',
        machineId: 'machine-1', occurrenceId: 'bundled-summary-current', serverId: lifetime.scope.serverId,
        accountLifetime: lifetime, interactionEnabled: true, daemonInteractionEnabled: false,
    }, binding: { executeHostAction: Object.assign(executor.execute, { prepare: executor.prepare }) } });
    const controller = mountController();
    controllers.push(controller);
    const context = await captureLazyActionAccountContext(lifetime.scope.serverId);
    const hostEntry = resource.hostRead === 'discussion.get' || resource.hostRead === 'machines.managed.list'
        || resource.hostRead === 'deployments.environments.list'
        ? controller.resourceStore!.getEntry(resource) : getUsageQueryResourceStore(context).getEntry(resource);
    context.dispose();
    const native = createCanonicalPluginReactNativeHostApiAdapter({ surface: createPluginSurfaceContextFixture({
        mount: { kind: 'destination', destination: { pluginId, localId: 'summary' }, container: 'appPage' }, target: { kind: 'app' },
    }), requestSurface: controller.surfaceContext, handleRequest: controller.hostApi.handleRequest,
        installedMethods: controller.installedMethods });
    const unwatchNative = controller.subscribeResourceInvalidations(event => native.publishResourceSubscriptionEvent(event));
    return { controller, native: { ...native, dispose() { unwatchNative(); native.dispose(); } }, hostEntry, lifetime, resource,
        mountAnotherController() { const next = mountController(); controllers.push(next); return next; }, executor };
}

function hosted(controller: ReturnType<typeof createBoundPluginSurfaceController>) {
    const identity = { instanceId: 'usage-frame', mountNonce: 'usage-frame-nonce' };
    const pushes: unknown[] = [];
    const bridge = createPluginHostedWebHostApiBridgeHandler({ surface: controller.surfaceContext, identity,
        requestIdPrefix: 'usage-hosted', handleRequest: controller.hostApi.handleRequest, isCurrent: controller.isCurrent,
        canonicalHostApi: { identity, surface: {}, methods: controller.installedMethods }, postToFrame: event => { pushes.push(event); } });
    const unwatch = controller.subscribeResourceInvalidations(event => bridge.publishResourceSubscriptionEvent(event));
    let sequence = 0;
    let ready = false;
    const send = async (message: PluginUiJsonObjectV1) => {
        let result: Awaited<ReturnType<typeof bridge>> | undefined;
        await act(async () => {
            if (!ready) {
                await bridge({ version: 1, identity, sequence: ++sequence, kind: 'ready', payload: {} });
                ready = true;
            }
            const payload = PluginUiHostApiWireEnvelopeV1Schema.parse({ ...message, wireVersion: 1, identity });
            result = await bridge({ version: 1, identity, sequence: ++sequence, kind: 'hostApi', payload: PluginUiJsonValueV1Schema.parse(payload) });
        });
        if (!result) throw new Error('Hosted request did not settle');
        return result;
    };
    return { pushes, send, dispose() { unwatch(); bridge.dispose(); } };
}

async function settleUsageDetail(entry: PluginUiResourceEntry) {
    await expect.poll(() => {
        const snapshot = entry.getSnapshot();
        if (!snapshot.value || snapshot.pending !== 'idle') return 'pending';
        return decodeUsageQueryResource(snapshot.value).results[0]?.sources.find(source => source.source === 'work')?.status ?? 'pending';
    }).not.toBe('pending');
}

describe('mounted native and hosted host reads', () => {
    it('admits preview collection reads through the original deployment Action before opening its shared owner', async () => {
        let enabled = false;
        const resource = { hostRead: 'deployments.environments.list', input: {
            serverId: 'mounted-home',
            previewRepository: { kind: 'github', deployment: 'https://github.com', repository: 'owner/repo' },
            previewPullRequestIds: ['17'],
        } } satisfies PluginUiHostReadReferenceV1;
        const { native, resource: mountedResource } = await mount(request => request.url.pathname === '/v1/deployments/environments'
            ? Response.json({ ok: true, items: [], nextCursor: null }) : undefined, () => enabled, resource, undefined, 'happier.scm.forge.github');
        const lists = () => home!.requests.filter(request => request.path.split('?')[0] === '/v1/deployments/environments');
        try {
            await expect(native.api.readResource(mountedResource)).rejects.toMatchObject({ code: 'action_disabled' });
            expect(lists()).toHaveLength(0);
            enabled = true;
            const content = await native.api.readResource(mountedResource);
            expect(JSON.parse(new TextDecoder().decode(content.bytes))).toMatchObject({ items: [] });
            expect(lists()).toHaveLength(1);
            await expect(native.api.readResource({ ...resource, input: {
                ...resource.input, serverId: 'foreign-home',
            } })).rejects.toMatchObject({ code: 'action_account_scope_changed' });
            expect(lists()).toHaveLength(1);
        } finally { native.dispose(); }
    });
    it('does not admit or read the disabled managed inventory binding of an older Machine target', async () => {
        const { controller, native, lifetime } = await mount(() => undefined);
        const resource = { hostRead: 'machines.managed.list', input: { homeId: '' } } as const;
        function Probe() { useLivePluginResource(resource, { enabled: false }); return null; }
        const screen = await renderScreen(<PluginHostApiProviderInternal hostApi={native.api} resourceStore={controller.resourceStore}
            accountLifetime={lifetime} mountedPluginId="acme.usage"><Probe /></PluginHostApiProviderInternal>);
        try {
            await flushHookEffects({ cycles: 30 });
            expect(home!.requests.filter(request => request.path === '/v1/machines/managed/actions/list')).toHaveLength(0);
        } finally { await act(async () => screen.tree.unmount()); native.dispose(); }
    });

    it('observes cross-entry managed inventory changes through one shared reader without equal or idle work', async () => {
        const homeId = 'srv_managed_observation';
        const resource = { hostRead: 'machines.managed.list', input: { homeId } } as const;
        let enabled = true;
        let failList = false;
        let machines = Array.from({ length: 128 }, (_, index) => ManagedMachineV1Schema.parse({
            id: `sandbox-${index}`, homeId, custodianAccountId: 'account-a',
            launch: { provider: { pluginId: 'happier.machine.docker-sandboxes', localId: 'docker-sandboxes' },
                schemaVersion: 1, name: `Sandbox ${index}`, choices: { name: `sandbox-${index}` } },
            controller: { machineId: 'machine-1', installationId: 'installation-1' },
            allocation: 'bound', creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 1,
            resource: { contributionRef: { pluginId: 'happier.machine.docker-sandboxes', localId: 'docker-sandboxes' },
                schemaVersion: 1, value: { sandboxName: `sandbox-${index}` } },
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
            observation: { observedAt: 1, availability: 'present', power: 'running' },
        }));
        const { controller, native, hostEntry, lifetime } = await mount(request =>
            request.path === '/v1/machines/managed/actions/list' ? failList
                ? Response.json({ code: 'provider_unavailable' }, { status: 503 }) : Response.json({ machines }) : undefined,
            () => enabled, resource, homeId);
        const host = await renderHook(() => useManagedMachineInventory([lifetime.scope.serverId]), { flushOptions: { cycles: 30 } });
        await expect.poll(() => host.getCurrent().entries[lifetime.scope.serverId]?.status).toBe('ready');
        await flushHookEffects({ cycles: 30 });
        const lists = () => home!.requests.filter(request => request.path === '/v1/machines/managed/actions/list');
        const warmReads = lists().length;
        // The inventory owner revalidates real Home wakes (useManagedMachineInventory.ts:179–183).
        // Initial sync can publish snapshot recovery (syncEngine.ts:8463) before this new plugin demand.
        // The shared-reader contract is zero additional IO when the plugin joins the warm exact input.
        const snapshots: PluginUiResourceSnapshot[] = [];
        function Probe() { snapshots.push(useLivePluginResource(resource).resource); return null; }
        const screen = await renderScreen(<PluginHostApiProviderInternal hostApi={native.api} resourceStore={controller.resourceStore}
            accountLifetime={lifetime} mountedPluginId="acme.usage"><Probe /></PluginHostApiProviderInternal>);
        const readRows = () => {
            const value = snapshots.at(-1)?.value;
            return value ? decodePluginUiManagedMachineInventory(value.bytes) : null;
        };
        try {
            await expect.poll(() => host.getCurrent().entries[lifetime.scope.serverId]?.status).toBe('ready');
            await expect.poll(() => hostEntry.getSnapshot().value).toBeDefined();
            await flushHookEffects({ cycles: 30 });
            expect(readRows()?.machines).toHaveLength(128);
            expect(lists()).toHaveLength(warmReads);
            snapshots.length = 0;
            await act(async () => publishHomeAccountChange(lifetime.scope.serverId));
            await expect.poll(() => lists().length).toBe(warmReads + 1);
            await flushHookEffects({ cycles: 30 });
            expect(snapshots).toHaveLength(0);
            for (let index = 0; index < 128; index += 1) publishHomeAccountChange('another-home');
            publishHomeAccountChange(lifetime.scope.serverId, ['unrelated-artifact'], { changeKinds: ['artifact'] });
            await flushHookEffects({ cycles: 30 });
            expect(lists()).toHaveLength(warmReads + 1);
            vi.useFakeTimers();
            try { await act(async () => { await vi.advanceTimersByTimeAsync(60_000); }); }
            finally { vi.useRealTimers(); }
            expect(lists()).toHaveLength(warmReads + 1);

            // Another entry changes one admitted row; the already-mounted plugin and host must both see it.
            machines = machines.map((machine, index): typeof machine => index === 64 ? { ...machine,
                observation: { observedAt: 2, availability: 'present', power: 'stopped' } } : machine);
            await act(async () => publishHomeAccountChange(lifetime.scope.serverId));
            await expect.poll(() => host.getCurrent().machinesByServerId[lifetime.scope.serverId]?.[64]?.observation?.power).toBe('stopped');
            await expect.poll(() => readRows()?.machines[64]?.observation?.power).toBe('stopped');
            expect(lists()).toHaveLength(warmReads + 2);

            failList = true;
            await act(async () => { await hostEntry.refresh(); });
            await flushHookEffects({ cycles: 30 });
            expect(hostEntry.getSnapshot()).toMatchObject({ freshness: 'stale', error: expect.anything(), value: expect.anything() });
            expect(readRows()?.machines[64]?.observation?.power).toBe('stopped');
            expect(lists()).toHaveLength(warmReads + 3);
            failList = false;
            await act(async () => { await hostEntry.refresh(); });
            await flushHookEffects({ cycles: 30 });
            expect(hostEntry.getSnapshot()).toMatchObject({ freshness: 'fresh', pending: 'idle' });
            expect(hostEntry.getSnapshot().error).toBeUndefined();
            expect(lists()).toHaveLength(warmReads + 4);

            // A warm host receipt is not authority after the plugin's Action admission changes.
            enabled = false;
            await expect(native.api.readResource(resource)).rejects.toMatchObject({ code: 'action_disabled' });
            expect(lists()).toHaveLength(warmReads + 4);
            enabled = true;
            await expect(native.api.readResource(resource)).resolves.toMatchObject({ contentType: 'application/json' });
            expect(lists()).toHaveLength(warmReads + 4);
            retireActiveServerAccountScopeLifetime();
            expect(hostEntry.getSnapshot().value).toBeUndefined();
            await expect(native.api.readResource(resource)).rejects.toMatchObject({ code: 'stale_surface' });
        } finally {
            vi.useRealTimers();
            await act(async () => screen.tree.unmount());
            await host.unmount();
            native.dispose();
        }
        const settledReads = lists().length;
        publishHomeAccountChange(lifetime.scope.serverId);
        await flushHookEffects({ cycles: 30 });
        expect(lists()).toHaveLength(settledReads);
    });

    it('shares the qualified operation owner with native and hosted readers without unrelated invalidations or stale disclosure', async () => {
        let phase = 'mount';
        onTestFailed(() => { console.error('Qualified operation host-read failed during:', phase); });
        let enabled = true;
        const { controller, native, lifetime } = await mount(() => undefined, () => enabled);
        const frame = hosted(controller);
        const address = { serverId: lifetime.scope.serverId, machineId: 'machine-1', operationId: 'command-a' };
        const resource = { hostRead: 'action.operations.get', input: address } as const;
        const accepted = ActionOperationSnapshotV1Schema.parse({ version: 1, operationId: address.operationId,
            revision: 1, actionId: 'projects.compute.exec', state: 'accepted',
            scope: { accountId: lifetime.scope.accountId, machineId: address.machineId },
            title: 'Local command', createdAt: 1, cancellation: 'supported' });
        const publish = (snapshot: typeof accepted) => actionOperationStore.mergeSnapshots({ serverId: address.serverId, snapshots: [snapshot] });
        const decode = (content: Awaited<ReturnType<typeof native.api.readResource>>) =>
            PluginUiActionOperationHostReadResultV1Schema.parse(JSON.parse(new TextDecoder().decode(content.bytes)));
        const events: unknown[] = [];
        let watch: Awaited<ReturnType<typeof native.api.watchResource>> | undefined;
        const invalidations = () => frame.pushes.filter(value => value && typeof value === 'object'
            && 'payload' in value && JSON.stringify(value).includes('"kind":"invalidated"'));
        try {
            publish(accepted);
            phase = 'raw admission read';
            expect(await controller.hostApi.handleRequest({ version: 1, requestId: 'operation-admission',
                surface: controller.surfaceContext, method: 'readResource', payload: { resource } }))
                .toMatchObject({ contentType: 'application/json' });
            phase = 'native initial read';
            expect(decode(await native.api.readResource(resource))).toEqual({ operation: accepted, observation: 'available' });
            phase = 'native watch acknowledgment';
            watch = await native.api.watchResource(resource, event => events.push(event));
            phase = 'hosted negotiate';
            await frame.send({ kind: 'negotiate', apiRange: '*' });
            phase = 'hosted watch acknowledgment';
            expect((await frame.send({ kind: 'subscribe', method: 'watchResource', requestId: 'operation-watch',
                subscriptionId: 'operation-watch', payload: { resource } })).payload).toMatchObject({ kind: 'result' });
            const readsBefore = home!.requests.length;
            const unrelated = Array.from({ length: 1000 }, (_, index) => ({ ...accepted, operationId: `unrelated-${index}` }));
            actionOperationStore.mergeSnapshots({ serverId: address.serverId, snapshots: unrelated });
            actionOperationStore.mergeSnapshots({ serverId: 'other-home', snapshots: [accepted] });
            actionOperationStore.setMachineObservation({ serverId: address.serverId, machineId: 'other-machine' }, 'reconnecting');
            phase = 'unrelated changes';
            await flushHookEffects();
            expect(events).toHaveLength(0);
            expect(invalidations()).toHaveLength(0);
            expect(home!.requests).toHaveLength(readsBefore);
            const running = ActionOperationSnapshotV1Schema.parse({ ...accepted, revision: 2, state: 'running', startedAt: 2 });
            publish(running);
            phase = 'running invalidation';
            await expect.poll(() => events.length).toBe(1);
            await expect.poll(() => invalidations().length).toBe(1);
            expect(decode(await native.api.readResource(resource))).toEqual({ operation: running, observation: 'available' });
            phase = 'hosted current read';
            const hostedRead = await frame.send({ kind: 'request', method: 'readResource', requestId: 'operation-read', payload: { resource } });
            expect(hostedRead.payload).toMatchObject({ kind: 'result' });
            const hostedPayload = hostedRead.payload as { result: { bytesBase64: string } };
            expect(PluginUiActionOperationHostReadResultV1Schema.parse(JSON.parse(new TextDecoder().decode(decodeBase64(hostedPayload.result.bytesBase64)))))
                .toEqual({ operation: running, observation: 'available' });
            actionOperationStore.setMachineObservation(address, 'reconnecting');
            phase = 'reconnecting invalidation';
            await expect.poll(() => events.length).toBe(2);
            expect(decode(await native.api.readResource(resource))).toEqual({ operation: running, observation: 'reconnecting' });
            actionOperationStore.setMachineObservation(address, 'unavailable');
            phase = 'unavailable invalidation';
            await expect.poll(() => events.length).toBe(3);
            expect(decode(await native.api.readResource(resource))).toEqual({ operation: running, observation: 'unavailable' });
            const stopped = ActionOperationSnapshotV1Schema.parse({ ...running, revision: 3,
                observation: { kind: 'stop_unconfirmed', code: 'machine_rpc_failed' } });
            publish(stopped);
            phase = 'unconfirmed-stop invalidation';
            await expect.poll(() => events.length).toBe(4);
            expect(decode(await native.api.readResource(resource))).toEqual({ operation: stopped, observation: 'unavailable' });
            const failed = ActionOperationSnapshotV1Schema.parse({ ...running, revision: 4, state: 'failed', settledAt: 4,
                error: { errorCode: 'command_failed', error: 'Exited with an error' } });
            publish(failed);
            phase = 'settled invalidation';
            await expect.poll(() => events.length).toBe(5);
            expect(decode(await native.api.readResource(resource))).toEqual({ operation: failed, observation: 'available' });
            const wrongMachine = { ...resource, input: { ...address, machineId: 'other-machine' } };
            phase = 'qualified authority denials';
            expect(decode(await native.api.readResource(wrongMachine))).toEqual({ operation: null, observation: 'unavailable' });
            const otherAccount = ActionOperationSnapshotV1Schema.parse({ ...accepted, operationId: 'other-account',
                scope: { ...accepted.scope, accountId: 'other-account' } });
            publish(otherAccount);
            expect(decode(await native.api.readResource({ ...resource, input: { ...address, operationId: otherAccount.operationId } })))
                .toEqual({ operation: null, observation: 'unavailable' });
            await expect(native.api.readResource({ ...resource, input: { ...address, serverId: 'other-home' } }))
                .rejects.toMatchObject({ code: 'server_scope_mismatch' });
            enabled = false;
            phase = 'revoked admission';
            await expect(native.api.readResource(resource)).rejects.toMatchObject({ code: 'action_disabled' });
            controller.dispose();
            phase = 'retired surface';
            await expect(native.api.readResource(resource)).rejects.toMatchObject({ code: 'stale_surface' });
        } finally { phase = `cleanup after ${phase}`; await watch?.dispose(); frame.dispose(); native.dispose(); }
    });

    it('publishes one content-free Discussion invalidation to both SDK transports, with no unrelated work and no out-of-scope read', async () => {
        const resource = { hostRead: 'discussion.get', input: { discussionId: 'discussion-a' } } as const;
        let readable = true;
        const { controller, native, lifetime, mountAnotherController, executor } = await mount(request => {
            if (!request.path.startsWith('/v1/discussions/')) return undefined;
            if (!readable || request.path !== '/v1/discussions/discussion-a') {
                return Response.json({ error: 'discussion_not_found' }, { status: 404 });
            }
            return Response.json(DiscussionDetailsResponseV1Schema.parse({ discussion: {
                id: 'discussion-a', ownerAccountId: 'account-a', encryptionMode: 'plain', anchor: null,
                access: 'owner', keyReadiness: true, dataEncryptionKey: null, creationLocalId: null,
                titleContent: { t: 'plain', v: { v: 1, title: 'Private title' } },
                latestMessage: { id: 'message-a', localId: null, seq: 1, authorAccountId: 'account-a',
                    accountActor: { v: 1, accountId: 'account-a', profile: null }, producerV1: null, createdAt: 1 },
                messageSeq: 1, lastReadSeq: null, unreadCount: 1, unreadMentionCount: 0,
                recentAuthorAccountIds: ['account-a'], archivedAt: null,
                capabilities: { postMessages: true, rename: true, archive: true, restore: false,
                    askAgent: true, sendToSession: true, manageAccess: true, leave: false },
            } }));
        }, true, resource);
        // The real Action/HTTP adapter is the system boundary for the core reader;
        // every plugin mount must borrow this Account/Home repository's reads.
        const repository = getDiscussionRepository({ scope: lifetime.scope, address: lifetime.scope,
            client: { ...createDiscussionClient({ scope: lifetime.scope, availability: 'available' }),
                async get(discussionId, signal) {
                    const result = await executor.execute('discussion.get', { discussionId }, { surface: 'ui', serverId: lifetime.scope.serverId, signal });
                    return result.ok ? { kind: 'succeeded', value: DiscussionDetailsResultV1Schema.parse(result.result) }
                        : { kind: 'failed', errorCode: result.errorCode };
                } } });
        await repository.refreshSummary('discussion-a');
        const leaveCore = repository.mount({ discussionId: 'discussion-a', projection: 'summary' });
        const siblingWatches: (() => void)[] = [];
        for (let index = 0; index < 3; index++) siblingWatches.push(mountAnotherController().resourceStore!.getEntry(resource).subscribe(() => {}, true));
        const frame = hosted(controller);
        const events: unknown[] = [];
        let watch: Awaited<ReturnType<typeof native.api.watchResource>> | undefined;
        const publish = (cursor: number, entityId = 'discussion-a', accountId = 'account-a', kind: 'discussion' | 'session' = 'discussion') =>
            publishMountedDiscussionChanges({ serverId: lifetime.scope.serverId, accountId,
                changes: [{ cursor, kind, entityId, changedAt: cursor }] });
        const invalidations = () => frame.pushes.filter(value => value && typeof value === 'object'
            && 'payload' in value && JSON.stringify(value).includes('"kind":"invalidated"'));
        try {
            const initial = await native.api.readResource(resource).catch((error: unknown) => {
                if (isPluginError(error)) throw new Error(JSON.stringify(error.data), { cause: error });
                throw error;
            });
            expect(JSON.parse(new TextDecoder().decode(initial.bytes))).toEqual({ discussionId: 'discussion-a', revision: 0 });
            watch = await native.api.watchResource(resource, event => { events.push(event); });
            await frame.send({ kind: 'negotiate', apiRange: '*' });
            expect((await frame.send({ kind: 'subscribe', method: 'watchResource', requestId: 'discussion-watch',
                subscriptionId: 'discussion-watch', payload: { resource } })).payload).toMatchObject({ kind: 'result' });
            const readsBefore = home!.requests.filter(request => request.path.startsWith('/v1/discussions/')).length;
            for (let index = 1; index <= 1000; index++) publish(index, 'other-discussion');
            publish(1001, 'discussion-a', 'other-account');
            publish(1002, 'discussion-a', 'account-a', 'session');
            await flushHookEffects();
            expect(events).toHaveLength(0);
            expect(invalidations()).toHaveLength(0);
            expect(home!.requests.filter(request => request.path.startsWith('/v1/discussions/'))).toHaveLength(readsBefore);
            publish(1003);
            await expect.poll(() => events.length).toBe(1);
            await expect.poll(() => invalidations().length).toBe(1);
            expect(events[0]).toMatchObject({ kind: 'invalidated' });
            const updated = await native.api.readResource(resource);
            expect(JSON.parse(new TextDecoder().decode(updated.bytes))).toEqual({ discussionId: 'discussion-a', revision: 1003 });
            expect(updated.digest).not.toBe(initial.digest);
            expect(JSON.stringify(frame.pushes)).not.toContain('Private title');
            expect(home!.requests.filter(request => request.path === '/v1/discussions/discussion-a')).toHaveLength(readsBefore + 1);
            await expect(native.api.watchResource({ hostRead: 'discussion.get', input: { discussionId: 'outsider' } }, () => {})).rejects.toMatchObject({ code: 'plugin_resource_not_found' });
            expect((await frame.send({ kind: 'subscribe', method: 'watchResource', requestId: 'outside',
                subscriptionId: 'outside', payload: { resource: { hostRead: 'discussion.get', input: { discussionId: 'outsider' } } } })).payload)
                .toMatchObject({ kind: 'error', error: { code: 'plugin_resource_not_found' } });
            readable = false;
            publish(1004);
            await expect.poll(() => events.length).toBe(2);
            expect(events[1]).toMatchObject({ kind: 'error' });
            expect(invalidations()).toHaveLength(1);
            controller.dispose();
            publish(1005);
            await expect(native.api.readResource(resource)).rejects.toMatchObject({ code: 'stale_surface' });
        } finally { leaveCore(); siblingWatches.forEach(release => release()); await watch?.dispose(); frame.dispose(); native.dispose(); }
    });
    it('exports only selected fields through native and hosted executeAction, and refuses denied or retired mounts', async () => {
        let enabled = true;
        const { controller, native } = await mount(request => request.path === '/v2/usage/query'
            ? Response.json(accounting(10)) : undefined, () => enabled);
        const frame = hosted(controller);
        const input = UsageExportInputSchema.parse({ query: {}, format: 'json', fields: ['totals'] });
        const wireInput = projectNativeJsonValueForTransport(input);
        const bytes = (value: unknown) => JSON.parse(new TextDecoder().decode(decodeBase64(UsageFileResultSchema.parse(value).base64)));
        try {
            const exported = await native.api.executeAction('usage.export', input);
            expect(bytes(exported)).toMatchObject({ accounting: { totals: accounting(10).totals } });
            expect(Object.keys(bytes(exported).accounting)).toEqual(['totals']);
            await frame.send({ kind: 'negotiate', apiRange: '*' });
            const hostedExport = await frame.send({ kind: 'request', method: 'executeAction', requestId: 'export',
                payload: { action: 'usage.export', input: wireInput } });
            expect(hostedExport.payload).toMatchObject({ kind: 'result' });
            const payload = hostedExport.payload as { result: unknown };
            expect(bytes(payload.result)).toEqual(bytes(exported));
            enabled = false;
            await expect(native.api.executeAction('usage.export', input)).rejects.toMatchObject({ code: 'unavailable' });
            expect((await frame.send({ kind: 'request', method: 'executeAction', requestId: 'denied-export',
                payload: { action: 'usage.export', input: wireInput } })).payload).toMatchObject({ kind: 'error', error: { code: 'unavailable' } });
            controller.dispose();
            await expect(native.api.executeAction('usage.export', input)).rejects.toMatchObject({ code: 'stale_surface' });
            expect(await frame.send({ kind: 'request', method: 'executeAction', requestId: 'retired-export',
                payload: { action: 'usage.export', input: wireInput } })).toMatchObject({ kind: 'error', payload: { code: 'stale_surface' } });
        } finally { frame.dispose(); native.dispose(); }
    });
    it('delivers ready accounting to native and hosted readers while its comparison is still pending', async () => {
        const comparison = createDeferred<Response>();
        const resource = { hostRead: 'usage.query' as const, input: { queries: [{ period: { startMs: 1000, endMs: 2000 } }] } };
        const { controller, native, hostEntry, lifetime } = await mount(request => {
            if (request.path !== '/v2/usage/query') return undefined;
            return UsageAnalyticsQueryRequestSchema.parse(request.body).dateRange?.startMs === 1000
                ? Response.json(accounting(10)) : comparison.promise;
        }, true, resource);
        const unwatchHost = hostEntry.subscribe(() => {}, true);
        const frame = hosted(controller);
        try {
            await expect.poll(() => hostEntry.getSnapshot().value !== undefined).toBe(true);
            expect(decodeUsageQueryResource(hostEntry.getSnapshot().value!).results[0]?.accounting?.totals).toEqual(accounting(10).totals);
            expect(hostEntry.getSnapshot().pending).toBe('initial');
            const nativeRead = await native.api.readResource(resource);
            expect(nativeRead.digest).toBe(hostEntry.getSnapshot().digest);
            const snapshots: PluginUiResourceSnapshot[] = [];
            function Probe() { snapshots.push(useLivePluginResource(resource).resource); return null; }
            const screen = await renderScreen(<PluginHostApiProviderInternal hostApi={native.api} resourceStore={controller.resourceStore}
                accountLifetime={lifetime} mountedPluginId="acme.usage"><Probe /></PluginHostApiProviderInternal>);
            try {
                await frame.send({ kind: 'negotiate', apiRange: '*' });
                const watch = await frame.send({ kind: 'subscribe', method: 'watchResource', requestId: 'held-watch',
                    subscriptionId: 'held-watch', payload: { resource } });
                expect(watch.payload).toMatchObject({ kind: 'result', result: { digest: hostEntry.getSnapshot().digest } });
                const before = hostEntry.getSnapshot().digest;
                comparison.resolve(Response.json(accounting(20)));
                await act(async () => { await expect.poll(() => hostEntry.getSnapshot().pending).toBe('idle'); });
                await flushHookEffects();
                expect(snapshots.at(-1)).toBe(hostEntry.getSnapshot());
                expect(hostEntry.getSnapshot().digest).not.toBe(before);
                expect(frame.pushes).toContainEqual(expect.objectContaining({ payload: expect.objectContaining({ kind: 'subscription',
                    event: expect.objectContaining({ kind: 'invalidated', digest: hostEntry.getSnapshot().digest }) }) }));
                const read = await frame.send({ kind: 'request', method: 'readResource', requestId: 'held-read', payload: { resource } });
                expect(read.payload).toMatchObject({ kind: 'result', result: { digest: hostEntry.getSnapshot().digest } });
            } finally { await act(async () => screen.tree.unmount()); }
        } finally { comparison.resolve(Response.json(accounting(20))); frame.dispose(); native.dispose(); unwatchHost(); }
    });

    it('borrows the host widget entry for a native live hook and delivers the same progressive hosted read', async () => {
        let tokens = 10;
        const { controller, native, hostEntry, lifetime } = await mount(request => request.path === '/v2/usage/query'
            ? Response.json(accounting(tokens)) : undefined);
        // Keep the real host-widget demand active while native and hosted consumers join.
        const unwatchHost = hostEntry.subscribe(() => {}, true);
        await settleUsageDetail(hostEntry);
        await native.api.readResource(reference);
        const queriesBefore = home!.requests.filter(request => request.path === '/v2/usage/query').length;
        const snapshots: PluginUiResourceSnapshot[] = [];
        function Probe() { snapshots.push(useLivePluginResource(reference).resource); return null; }
        const screen = await renderScreen(<PluginHostApiProviderInternal hostApi={native.api} resourceStore={controller.resourceStore}
            accountLifetime={lifetime} mountedPluginId="acme.usage"><Probe /></PluginHostApiProviderInternal>);
        await flushHookEffects({ cycles: 20 });
        expect(snapshots.at(-1)?.value).toBeDefined();
        expect(snapshots.at(-1)).toBe(hostEntry.getSnapshot());
        const frame = hosted(controller);
        try {
            await frame.send({ kind: 'negotiate', apiRange: '*' });
            const watch = await frame.send({ kind: 'subscribe', method: 'watchResource', requestId: 'watch', subscriptionId: 'usage-watch', payload: { resource: reference } });
            expect(watch.payload).toMatchObject({ kind: 'result', result: { digest: hostEntry.getSnapshot().digest } });
            const read = await frame.send({ kind: 'request', method: 'readResource', requestId: 'read', payload: { resource: reference } });
            expect(read.payload).toMatchObject({ kind: 'result', result: { digest: hostEntry.getSnapshot().digest } });
            expect(home!.requests.filter(request => request.path === '/v2/usage/query')).toHaveLength(queriesBefore);
            const beforeDigest = hostEntry.getSnapshot().digest;
            await act(async () => { tokens = 20; invalidateUsageQueryResources(lifetime);
                await expect.poll(() => hostEntry.getSnapshot().digest).not.toBe(beforeDigest); });
            await flushHookEffects({ cycles: 20 });
            expect(snapshots.at(-1)).toBe(hostEntry.getSnapshot());
            expect(home!.requests.filter(request => request.path === '/v2/usage/query')).toHaveLength(queriesBefore + 1);
            expect(frame.pushes).toContainEqual(expect.objectContaining({ payload: expect.objectContaining({ kind: 'subscription',
                event: expect.objectContaining({ kind: 'invalidated', digest: hostEntry.getSnapshot().digest }) }) }));
            const progressive = await frame.send({ kind: 'request', method: 'readResource', requestId: 'progressive-read', payload: { resource: reference } });
            expect(progressive.payload).toMatchObject({ kind: 'result', result: { digest: hostEntry.getSnapshot().digest } });
            expect(home!.requests.filter(request => request.path === '/v2/usage/query')).toHaveLength(queriesBefore + 1);
            await act(async () => { controller.dispose(); });
            await flushHookEffects();
            expect(snapshots.at(-1)?.value).toBeUndefined();
            expect(hostEntry.getSnapshot().value).toBeDefined();
            await expect(native.api.readResource(reference)).rejects.toMatchObject({ code: 'stale_surface' });
            await expect(native.api.watchResource(reference, () => {})).rejects.toMatchObject({ code: 'stale_surface' });
            const retiredMessages: readonly PluginUiJsonObjectV1[] = [
                { kind: 'request', method: 'readResource', requestId: 'retired-read', payload: { resource: reference } },
                { kind: 'subscribe', method: 'watchResource', requestId: 'retired-watch', subscriptionId: 'retired-watch', payload: { resource: reference } },
            ];
            for (const message of retiredMessages) {
                expect(await frame.send(message)).toMatchObject({ kind: 'error', payload: { code: 'stale_surface' } });
            }
        } finally { frame.dispose(); await act(async () => { screen.tree.unmount(); }); native.dispose(); unwatchHost(); }
    });

    it('refuses native and hosted reads and watches when canonical Action settings deny admission', async () => {
        const { controller, native } = await mount(() => undefined, false);
        for (const resource of [reference, quotaReference]) {
            await expect(native.api.readResource(resource)).rejects.toMatchObject({ code: 'action_disabled' });
            await expect(native.api.watchResource(resource, () => {})).rejects.toMatchObject({ code: 'action_disabled' });
            const snapshot = await controller.resourceStore!.getEntry(resource).refresh();
            expect(snapshot).toMatchObject({ error: { code: 'action_disabled' } });
            expect(snapshot.value).toBeUndefined();
        }
        const frame = hosted(controller);
        try {
            await frame.send({ kind: 'negotiate', apiRange: '*' });
            for (const [index, resource] of [reference, quotaReference].entries()) {
                const deniedMessages: readonly PluginUiJsonObjectV1[] = [
                    { kind: 'request', method: 'readResource', requestId: `denied-read-${index}`, payload: { resource } },
                    { kind: 'subscribe', method: 'watchResource', requestId: `denied-watch-${index}`, subscriptionId: `denied-watch-${index}`, payload: { resource } },
                ];
                for (const message of deniedMessages) {
                    const result = await frame.send(message);
                    expect(result.payload).toMatchObject({ kind: 'error', error: { code: 'action_disabled' } });
                }
            }
            expect(home!.requests.filter(request => request.path === '/v2/usage/query' || request.path.includes('/provider-account-usage/'))).toEqual([]);
        } finally { frame.dispose(); native.dispose(); }
    });

    it('borrows the canonical quota entry for native hooks and hosted reads and watches', async () => {
        const { controller, native, lifetime } = await mount(request => {
            if (request.path === '/v4/connect/qualified/provider-account-usage/sources/resolve') return Response.json({ error: 'not_found' }, { status: 404 });
            if (request.path === '/v2/pending/reset-starts/read') return Response.json({ entries: [] });
            return undefined;
        });
        const account = await captureLazyActionAccountContext(lifetime.scope.serverId);
        const hostEntry = getUsageQueryResourceStore(account).getEntry(quotaReference);
        account.dispose();
        const read = await native.api.readResource(quotaReference);
        expect(JSON.parse(new TextDecoder().decode(read.bytes))).toMatchObject({ source: quotaReference.input.source, current: null });
        const snapshots: PluginUiResourceSnapshot[] = [];
        function Probe() { snapshots.push(useLivePluginResource(quotaReference).resource); return null; }
        const screen = await renderScreen(<PluginHostApiProviderInternal hostApi={native.api} resourceStore={controller.resourceStore}
            accountLifetime={lifetime} mountedPluginId="acme.usage"><Probe /></PluginHostApiProviderInternal>);
        await flushHookEffects({ cycles: 20 });
        expect(snapshots.at(-1)).toBe(hostEntry.getSnapshot());
        const frame = hosted(controller);
        try {
            await frame.send({ kind: 'negotiate', apiRange: '*' });
            const watch = await frame.send({ kind: 'subscribe', method: 'watchResource', requestId: 'quota-watch', subscriptionId: 'quota-watch', payload: { resource: quotaReference } });
            expect(watch.payload).toMatchObject({ kind: 'result', result: { digest: hostEntry.getSnapshot().digest } });
            const result = await frame.send({ kind: 'request', method: 'readResource', requestId: 'quota-read', payload: { resource: quotaReference } });
            expect(result.payload).toMatchObject({ kind: 'result', result: { digest: read.digest } });
            expect(home!.requests.filter(request => request.path.includes('/provider-account-usage/'))
                .every(request => request.method === 'GET')).toBe(true);
        } finally { frame.dispose(); await act(async () => { screen.tree.unmount(); }); native.dispose(); }
    });

    it('withdraws native and hosted visibility when Action admission is revoked before a progressive update', async () => {
        let enabled = true;
        let tokens = 10;
        const { controller, native, hostEntry, lifetime } = await mount(request => request.path === '/v2/usage/query'
            ? Response.json(accounting(tokens)) : undefined, () => enabled);
        await native.api.readResource(reference);
        const snapshots: PluginUiResourceSnapshot[] = [];
        function Probe() { snapshots.push(useLivePluginResource(reference).resource); return null; }
        const screen = await renderScreen(<PluginHostApiProviderInternal hostApi={native.api} resourceStore={controller.resourceStore}
            accountLifetime={lifetime} mountedPluginId="acme.usage"><Probe /></PluginHostApiProviderInternal>);
        await flushHookEffects({ cycles: 20 });
        expect(snapshots.at(-1)?.value).toBeDefined();
        const frame = hosted(controller);
        try {
            await frame.send({ kind: 'negotiate', apiRange: '*' });
            await frame.send({ kind: 'subscribe', method: 'watchResource', requestId: 'watch', subscriptionId: 'revoked-watch', payload: { resource: reference } });
            await act(async () => { enabled = false; tokens = 99; invalidateUsageQueryResources(lifetime); });
            await expect.poll(() => controller.resourceStore!.getEntry(reference).getSnapshot().error?.code).toBe('action_disabled');
            await flushHookEffects({ cycles: 20 });
            expect(snapshots.at(-1)?.value).toBeUndefined();
            expect(snapshots.at(-1)?.error?.code).toBe('action_disabled');
            expect(frame.pushes).toContainEqual(expect.objectContaining({ payload: expect.objectContaining({ kind: 'subscription',
                event: expect.objectContaining({ kind: 'error', code: 'denied' }) }) }));
            expect(frame.pushes).not.toContainEqual(expect.objectContaining({ payload: expect.objectContaining({ kind: 'subscription',
                event: expect.objectContaining({ kind: 'invalidated', digest: hostEntry.getSnapshot().digest }) }) }));
        } finally { frame.dispose(); await act(async () => { screen.tree.unmount(); }); native.dispose(); }
    });

    it('does not reuse an earlier admission for a subsequent cached native or hosted read', async () => {
        let enabled = true;
        const { controller, native, hostEntry } = await mount(request => request.path === '/v2/usage/query'
            ? Response.json(accounting(10)) : undefined, () => enabled);
        const unwatchHost = hostEntry.subscribe(() => {}, true);
        await settleUsageDetail(hostEntry);
        await native.api.readResource(reference);
        const queriesBefore = home!.requests.filter(request => request.path === '/v2/usage/query').length;
        enabled = false;
        await expect(native.api.readResource(reference)).rejects.toMatchObject({ code: 'action_disabled' });
        const frame = hosted(controller);
        try {
            await frame.send({ kind: 'negotiate', apiRange: '*' });
            const result = await frame.send({ kind: 'request', method: 'readResource', requestId: 'cached-read', payload: { resource: reference } });
            expect(result.payload).toMatchObject({ kind: 'error', error: { code: 'action_disabled' } });
            expect(home!.requests.filter(request => request.path === '/v2/usage/query')).toHaveLength(queriesBefore);
        } finally { frame.dispose(); native.dispose(); unwatchHost(); }
    });

    it('cancels a native read before snapshot admission and withholds later results after mount retirement', async () => {
        const delayed = createDeferred<Response>();
        const { controller, native } = await mount(request => request.path === '/v2/usage/query' ? delayed.promise : undefined);
        const abort = new AbortController();
        const pending = native.api.readResource(reference, { signal: abort.signal });
        const rejected = expect(pending).rejects.toMatchObject({ code: 'unavailable' });
        // Usage publishes source-only progress before accounting settles. Cancel
        // before the first snapshot; a completed progress read cannot be retracted.
        abort.abort(); controller.dispose(); delayed.resolve(Response.json(accounting(99)));
        await rejected;
        await flushHookEffects({ cycles: 20 });
        expect(controller.resourceStore!.getEntry(reference).getSnapshot().value).toBeUndefined();
        native.dispose();
    });
});
