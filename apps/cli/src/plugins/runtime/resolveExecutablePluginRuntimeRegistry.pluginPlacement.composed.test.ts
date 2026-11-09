import axios, { AxiosError, AxiosHeaders, type AxiosResponse } from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { definePlugin } from '@happier-dev/plugin-sdk';
import { FeaturesResponseSchema } from '@happier-dev/protocol';
import { PluginAvailabilityActionHttpPathsV1 } from '@happier-dev/protocol/plugins/availability';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { loadInstalledPlugins } from '@/plugins/discovery/load/installed';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/fullProjection';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { executeAppliedDaemonPluginActionWithController } from '@/plugins/daemon/controlRoutes';
import { createDaemonControlApp } from '@/daemon/controlServer';
import { createDaemonPluginChangeService } from '@/plugins/daemon/changeService';
import { createDaemonExternalActionTargetResolver } from '@/daemon/externalActions/daemonExternalActionTargetResolver';
import { createCliActionExecutor } from '@/session/actions/createCliActionExecutor';
import { createCommittedContributedActionInvoker, listRuntimeContributedActionDefinitions } from './invocation/actions/createCommittedContributedActionDeps';
import * as daemonControl from '@/daemon/controlClient';
import { createDiscordGatewaySupervisor } from '../../../../../packages/plugins/channel-discord/src/discordGatewaySupervisor';
import { listConversationProviderConnectionsForInvocation, readConversationProviderConnectionForInvocation } from '../../../../../packages/plugins/channels/src/reconciliation';
import { MemoryCollection } from '../../../../../packages/plugins/channels/src/testkit/memoryCollection';
import { createCurrentConversationConnectionFixture } from '../../../../../packages/plugins/channels/src/testkit/currentConnectionFixture';
import { CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1 } from '@happier-dev/channels-protocol/v1';
import type { PluginServices } from '@happier-dev/plugin-sdk';

const callerId = 'example.placefix-caller';
const receiverId = 'example.placefix-receiver';
const machineId = 'placefix-machine';
const serverIdentityId = 'srv_placefix';

function response<T>(data: T): AxiosResponse<T> {
    return { data, status: 200, statusText: 'OK', headers: new AxiosHeaders(), config: { headers: new AxiosHeaders() } };
}

afterEach(() => vi.restoreAllMocks());

async function fixture(crossMachine = false) {
    let effects = 0;
    const callers: unknown[] = [];
    const accountReads: string[] = [];
    const transportRequests: Parameters<typeof daemonControl.requestDaemonPluginActionExecution>[0][] = [];
    const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'placefix-account' })).toString('base64url')}.signature`,
        encryption: null, credentialProvenance: 'stored_session' as const };
    // Home HTTP and daemon control are the external boundaries. Keep both
    // daemon executions, plugin admission, SDK services and Action policy real.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async url => {
        if (!['/v1/features', '/v1/features/authenticated'].includes(new URL(String(url)).pathname)) throw new Error('Unexpected fetch');
        return new Response(JSON.stringify(FeaturesResponseSchema.parse({ features: {},
            capabilities: { serverIdentity: { serverIdentityId } } })), { status: 200 });
    });
    vi.spyOn(axios, 'get').mockImplementation(async url => {
        if (new URL(String(url)).pathname === '/v1/account/profile') return response({ id: 'placefix-account' });
        throw new Error(`Unexpected Home GET ${new URL(String(url)).pathname}`);
    });
    vi.spyOn(axios, 'post').mockImplementation(async url => {
        const path = new URL(String(url)).pathname;
        if (path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intent.read']) {
            accountReads.push(path);
        }
        throw new AxiosError(`Home unavailable: ${path}`, 'ECONNREFUSED');
    });
    const caller = definePlugin({ id: callerId, version: '1.0.0', entrypoints: { daemon: './daemon.mjs' },
        actions: { run: { title: 'Call receiver', surfaces: ['cli'], dangerLevel: 'safe',
            inputSchema: { type: 'object', additionalProperties: false },
            run: async (_input, context) => crossMachine
                ? await context.services.actions.executeWithExecutionOrigin({ pluginId: receiverId, localId: 'read' }, {}, {
                    expectedExecutionRouting: { serverIdentityId, machineId: 'other-machine', pluginId: receiverId },
                })
                : await context.services.actions.execute({ pluginId: receiverId, localId: 'read' }, {}),
        } },
    });
    const receiver = definePlugin({ id: receiverId, version: '1.0.0', entrypoints: { daemon: './daemon.mjs' },
        actions: { read: { title: 'Plugin-only read', surfaces: ['plugin'], dangerLevel: 'safe',
            inputSchema: { type: 'object', additionalProperties: false },
            run(_input, context) { effects++; callers.push(context.caller); return { received: true }; },
        } },
    });
    const runtime = await createAuthoredAdmittedPluginRuntimeFixture({
        plugins: [caller, receiver].map(plugin => ({ manifest: plugin.manifest,
            files: { 'daemon.mjs': 'export function activate() {}' },
            instantiateCommittedModule: () => ({ activate: plugin.activate }) })),
        async resolveContributes(happyHomeDir) {
            return createResolvedContributionRegistry(projectLoadedPluginContributes({
                loadResult: await loadInstalledPlugins({ happyHomeDir }), provenance: 'external',
            }));
        },
        runtimeOptions: {
            scopedActionRuntime: { credentials,
                actionsSettingsProvider: createActionSettingsProvider({ getAccountSettings: () => null, allowEnvironmentOverride: false }) },
            resolveCurrentMachineId: () => machineId,
            resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId, machineId }),
        },
    });
    const executor = createCliActionExecutor({ token: credentials.token, credentials, sessionId: 'cli-global', mode: 'plain', ctx: null,
        pluginActionExecutionOwner: 'current_process',
        actionsSettingsProvider: createActionSettingsProvider({ getAccountSettings: () => null, allowEnvironmentOverride: false }),
        listContributedActionDefinitions: selection => listRuntimeContributedActionDefinitions(runtime.registry, selection),
        invokeContributedAction: createCommittedContributedActionInvoker({ acquireRuntimeRegistryLease: async () => {
            const lease = runtime.controller.tryAcquireRuntimeRegistry();
            if (!lease) throw new Error('Fixture runtime retired');
            return lease;
        } }),
    });
    const app = createDaemonControlApp({ machineId, controlToken: 'placefix-control', getChildren: () => [],
        stopSession: async () => ({ status: 'not_found' }),
        spawnSession: async () => ({ type: 'success', sessionId: 'unused' }),
        requestShutdown() {}, onHappySessionWebhook() {},
        pluginChangeService: createDaemonPluginChangeService({ prepare: async () => { throw new Error('Unexpected install'); } }),
        externalActionApi: { currentServerId: 'placefix-home', currentAccountId: 'placefix-account',
            verifyPat: async () => { throw new Error('Unexpected PAT verification'); },
            resolveTarget: createDaemonExternalActionTargetResolver({ credentials }),
            executor, resolvePatExecutor: () => executor },
    });
    vi.spyOn(daemonControl, 'requestDaemonPluginActionExecution').mockImplementation(async request => {
        transportRequests.push(request);
        const result = await app.inject({ method: 'POST', url: '/plugins/actions/execute', payload: request,
            headers: { 'x-happier-daemon-token': 'placefix-control' } });
        expect(result.statusCode).toBe(200);
        return result.json();
    });
    return { ...runtime, app, accountReads, transportRequests, callers, effects: () => effects,
        async dispose() { try { await app.close(); } finally { await runtime.dispose(); } } };
}

describe('daemon plugin caller execution placement', () => {
    it('reconciles a retained Discord background caller after Channels is admitted and invalidated', async () => {
        const state = new MemoryCollection();
        await state.put(createCurrentConversationConnectionFixture({ connectionId: 'discord-placement', enabled: false,
            transport: { kind: 'socket' }, authority: {
                providerPluginId: 'happier.channel.discord', providerContributionSelection: { contributionId: 'discord-provider' },
                providerSetupInput: {}, credentialRef: null, transportOrigin: { serverIdentityId, machineId },
                providerConnectionKey: 'discord:application:placement', providerConfig: { applicationId: 'placement', botUserId: 'bot' },
                routingIdentityKey: 'a'.repeat(43), integrationPrincipal: { id: 'bot' }, authorityEpoch: 1,
            } }), { expectedRevision: 'absent' });
        const storage = { account: { collection: () => state } } as unknown as PluginServices['storage'];
        let reads = 0;
        const coreEvents = { 'connections-invalidated-v1': {
            declaration: { kind: 'event' as const, title: 'Connections invalidated', payloadSchema: { type: 'object' } },
        } };
        const publisher = definePlugin({ id: 'happier.channels', version: '1.0.0', entrypoints: { daemon: './daemon.mjs' }, events: coreEvents });
        const core = definePlugin({ id: 'happier.channels', version: '1.0.0', entrypoints: { daemon: './daemon.mjs' }, events: coreEvents, actions: {
            [CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.connectionsList]: { title: 'Current connections', surfaces: ['plugin'], dangerLevel: 'safe',
                run: async (_input, context) => await listConversationProviderConnectionsForInvocation({}, {
                    ...context, services: { ...context.services, storage },
                }) },
            [CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.connectionRead]: { title: 'Current connection', surfaces: ['plugin'], dangerLevel: 'safe',
                run: async (_input, context) => {
                    reads++;
                    return await readConversationProviderConnectionForInvocation({ connectionId: 'discord-placement' }, {
                        ...context, services: { ...context.services, storage },
                    });
                } },
        } });
        const supervisor = createDiscordGatewaySupervisor();
        const discoveryFailures: unknown[] = [];
        let starts = 0;
        let backgroundSignal: AbortSignal | undefined;
        let backgroundActions: PluginServices['actions'] | undefined;
        let hints = 0;
        const provider = definePlugin({ id: 'happier.channel.discord', version: '1.0.0', entrypoints: { daemon: './daemon.mjs' },
            events: { invalidated: { declaration: { kind: 'subscription', target: { kind: 'plugin',
                event: { pluginId: 'happier.channels', localId: 'connections-invalidated-v1' } } },
                handler() { hints++; supervisor.invalidateConnections(); } } },
            backgroundServices: [{ declaration: { id: 'gateway-supervisor', title: 'Gateway' }, runner: context => {
                starts++;
                backgroundSignal = context.signal;
                backgroundActions = context.services.actions;
                return supervisor.run({
                ...context, services: { ...context.services, logger: { ...context.services.logger, info(message, fields) {
                    if (fields?.phase === 'reconciliationFailed') discoveryFailures.push(fields.errorCode);
                    context.services.logger.info(message, fields);
                } }, connectedAccounts: {
                    ...context.services.connectedAccounts, watch: () => ({ dispose() {} }),
                } },
            }); } }],
        });
        const authored = (plugin: typeof provider) => ({ manifest: plugin.manifest,
            files: { 'daemon.mjs': 'export function activate() {}' }, instantiateCommittedModule: () => ({ activate: plugin.activate }) });
        const runtimeOptions = {
            scopedActionRuntime: { credentials: { token: 'fixture-token', encryption: null },
                actionsSettingsProvider: createActionSettingsProvider({ getAccountSettings: () => null, allowEnvironmentOverride: false }) },
            resolveCurrentMachineId: () => machineId,
            resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId, machineId }),
        };
        const resolveContributes = async (happyHomeDir: string) => createResolvedContributionRegistry(projectLoadedPluginContributes({
            loadResult: await loadInstalledPlugins({ happyHomeDir }), provenance: 'external' }));
        const runtime = await createAuthoredAdmittedPluginRuntimeFixture({
            plugins: [authored(provider), authored(publisher)],
            resolveContributes, runtimeOptions,
        });
        let peer: Awaited<ReturnType<typeof createAuthoredAdmittedPluginRuntimeFixture>> | undefined;
        let adopted: Awaited<ReturnType<typeof createAuthoredAdmittedPluginRuntimeFixture>> | undefined;
        try {
            runtime.registry.startAdoptedBackgroundServices?.();
            await vi.waitFor(() => expect(discoveryFailures).toContain('plugin_action_execution_placement_unavailable'));
            // The daemon publishes a composite around already-prepared peer
            // components; that wrapper owns no new activation component.
            const peerRetained = runtime.controller.retainServingSlots!(new Set());
            peer = await createAuthoredAdmittedPluginRuntimeFixture({ plugins: [],
                happyHomeDir: runtime.happyHomeDir, controller: runtime.controller, resolveContributes,
                runtimeOptions: { ...runtimeOptions, retainedActivationRegistryLeases: peerRetained.leases,
                    servingPluginOccurrences: peerRetained.occurrencesByPluginId } });
            await runtime.lease.release();
            const retained = runtime.controller.retainServingSlots!(new Set(['happier.channels']));
            adopted = await createAuthoredAdmittedPluginRuntimeFixture({ plugins: [{ ...authored(core), replaceExisting: true }],
                happyHomeDir: runtime.happyHomeDir, controller: runtime.controller, resolveContributes,
                runtimeOptions: { ...runtimeOptions, retainedActivationRegistryLeases: retained.leases,
                    servingPluginOccurrences: retained.occurrencesByPluginId } });
            expect(adopted.registry.readPluginOccurrenceId?.('happier.channel.discord'))
                .toBe(runtime.registry.readPluginOccurrenceId?.('happier.channel.discord'));
            // Release the predecessor's last registry lease while its exact
            // provider activation component is retained by the successor.
            await peer.lease.release();
            expect(starts).toBe(1);
            const events = adopted.registry.createPluginEventsService!({ pluginId: 'happier.channels', pluginVersion: '1.0.0' });
            await expect(events.emit('connections-invalidated-v1', {})).resolves.toMatchObject({ status: 'admitted', subscriberCount: 1 });
            await vi.waitFor(() => expect(hints).toBe(1));
            expect(backgroundSignal?.aborted).toBe(false);
            await vi.waitFor(() => expect(reads).toBeGreaterThan(0));
            const before = reads;
            await events.emit('connections-invalidated-v1', {});
            await vi.waitFor(() => expect(reads).toBeGreaterThan(before));
            await adopted.registry.retirePluginConsumers?.(['happier.channel.discord']);
            await vi.waitFor(() => expect(backgroundSignal?.aborted).toBe(true));
            const settledReads = reads;
            await expect(backgroundActions!.execute({ pluginId: 'happier.channels',
                localId: CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.connectionsList }, {}))
                .rejects.toMatchObject({ code: 'plugin_action_generation_retired' });
            expect(reads).toBe(settledReads);
        } finally { await adopted?.dispose(); await peer?.dispose(); await runtime.dispose(); await supervisor.dispose(); }
    });

    it('executes a plugin-only same-Machine Action once through its current plugin caller without Account or CLI placement', async () => {
        const runtime = await fixture();
        try {
            const result = await executeAppliedDaemonPluginActionWithController({
                actionId: `${callerId}/run`, input: {}, surface: 'cli',
            }, runtime.controller);
            expect(result).toEqual({ matched: true, result: { ok: true, result: { received: true } } });
            expect(runtime.effects()).toBe(1);
            expect(runtime.callers).toEqual([expect.objectContaining({ kind: 'plugin', pluginId: callerId,
                contribution: expect.objectContaining({ id: 'run' }), originSurface: 'cli',
                occurrenceId: runtime.registry.readPluginOccurrenceId?.(callerId),
                sourceCustody: runtime.registry.readPluginSourceCustody?.(callerId),
            })]);
            expect(runtime.accountReads).toEqual([]);
            expect(runtime.transportRequests).toEqual([]);
        } finally { await runtime.dispose(); }
    });

    it('keeps the plugin-only descriptor and handler unavailable to a CLI caller', async () => {
        const runtime = await fixture();
        try {
            expect(await daemonControl.requestDaemonPluginActionExecution({ actionId: 'action.spec.get',
                input: { id: `${receiverId}/actions/read` }, surface: 'cli' }))
                .toMatchObject({ matched: true, result: { ok: false, errorCode: 'invalid_parameters' } });
            expect(await executeAppliedDaemonPluginActionWithController({ actionId: `${receiverId}/read`,
                input: {}, surface: 'cli' }, runtime.controller)).toMatchObject({ matched: true, result: { ok: false } });
            expect(runtime.effects()).toBe(0);
        } finally { await runtime.dispose(); }
    });

    it('retains the canonical refusal of a different-Machine execution routing before the handler starts', async () => {
        const runtime = await fixture(true);
        try {
            expect(await executeAppliedDaemonPluginActionWithController({
                actionId: `${callerId}/run`, input: {}, surface: 'cli',
            }, runtime.controller)).toMatchObject({ matched: true,
                result: { ok: false, errorCode: 'plugin_action_execution_origin_mismatch' } });
            expect(runtime.effects()).toBe(0);
            expect(runtime.accountReads).toEqual([]);
            expect(runtime.transportRequests).toEqual([]);
        } finally { await runtime.dispose(); }
    });
});
