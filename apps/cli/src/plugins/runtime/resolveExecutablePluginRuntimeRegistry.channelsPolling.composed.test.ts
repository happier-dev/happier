import { describe, expect, it, vi } from 'vitest';
import { definePlugin, PluginError, type PluginServices } from '@happier-dev/plugin-sdk';
import { ConversationProvidersContributionPointV1, ConversationProvidersContributionProtocolV1 } from '@happier-dev/channels-protocol/v1';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { loadInstalledPlugins } from '@/plugins/discovery/load/installed';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/fullProjection';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { createIngressSupervisor } from '../../../../../packages/plugins/channels/src/checkpointedPollSupervisor';
import { CHANNEL_STATE_COLLECTION } from '../../../../../packages/plugins/channels/src/collections';
import { createCurrentConversationConnectionFixture } from '../../../../../packages/plugins/channels/src/testkit/currentConnectionFixture';
import { MemoryCollection } from '../../../../../packages/plugins/channels/src/testkit/memoryCollection';

const providerId = 'acme.checkpointed-mail';
const home = { serverIdentityId: 'srv_background_poll', machineId: 'machine-background-poll' };

describe('admitted Channels checkpoint supervisor caller provenance', () => {
    it.each(['materialization', 'missing-origin', 'wrong-machine', 'missing-descriptor'] as const)(
        'runs the real supervisor through Actions and the installed provider with %s authority', async kind => {
            const state = new MemoryCollection();
            await state.put(createCurrentConversationConnectionFixture({
                connectionId: 'connection-background-poll',
                authority: {
                    providerPluginId: providerId,
                    providerContributionSelection: { contributionId: 'mail-provider' },
                    providerSetupInput: {}, credentialRef: null,
                    transportOrigin: home,
                    providerConnectionKey: 'mailbox-one', providerConfig: {},
                    routingIdentityKey: 'a'.repeat(43), integrationPrincipal: { id: 'mailbox-one' }, authorityEpoch: 1,
                },
            }), { expectedRevision: 'absent' });
            // The Collection is the persistent-database boundary. Scheduling,
            // admission, caller stamping, targeted handles and checkpointing stay real.
            const storage = { account: { collection(definition: { id: string }) {
                if (definition.id !== CHANNEL_STATE_COLLECTION.id) throw new Error('Unexpected Collection');
                return state;
            } } } as unknown as PluginServices['storage'];
            const supervisor = createIngressSupervisor();
            const core = definePlugin({
                id: 'happier.channels', version: '1.0.0', entrypoints: { daemon: './daemon.mjs' },
                contributionPoints: { providers: ConversationProvidersContributionPointV1 },
                backgroundServices: [{ declaration: { id: 'ingress-supervisor', title: 'Checkpointed polling' },
                    runner: context => supervisor.run({ ...context, services: { ...context.services, storage } }),
                }],
            });
            const protocol = ConversationProvidersContributionProtocolV1;
            let effects = 0;
            let callerOrigin: unknown;
            const provider = definePlugin({
                id: providerId, version: '1.0.0', entrypoints: { daemon: './daemon.mjs' },
                actions: {
                    prepare: { title: 'Prepare', surfaces: ['plugin', 'ui'], dangerLevel: 'safe',
                        inputSchema: { type: 'object', additionalProperties: false },
                        resultSchema: protocol.operations.setup.declaration.resultSchema.jsonSchema,
                        run() { throw new Error('Retained connection must not rerun setup'); } },
                    inspect: { title: 'Inspect', surfaces: ['plugin', 'ui'], dangerLevel: 'safe',
                        inputSchema: protocol.operations.connectionTest.declaration.input.schema.jsonSchema,
                        resultSchema: protocol.operations.connectionTest.declaration.resultSchema.jsonSchema,
                        run() { throw new Error('Background polling must not run connection setup/test'); } },
                    send: { title: 'Send', surfaces: ['plugin'], dangerLevel: 'writesRemote',
                        inputSchema: protocol.operations.messageDeliver.declaration.input.schema.jsonSchema,
                        resultSchema: protocol.operations.messageDeliver.declaration.resultSchema.jsonSchema,
                        run() { throw new Error('Baseline must not deliver'); } },
                    receive: { title: 'Receive', surfaces: ['plugin'], dangerLevel: 'safe',
                        inputSchema: protocol.operations.observationsPoll.declaration.input.schema.jsonSchema,
                        resultSchema: protocol.operations.observationsPoll.declaration.resultSchema.jsonSchema,
                        run(_input, context) {
                            const caller = context.caller;
                            if (caller?.kind !== 'plugin' || caller.pluginId !== 'happier.channels' || !caller.executionOrigin) {
                                throw new PluginError({ code: 'fixture_caller_missing', message: 'Caller origin must be host stamped' });
                            }
                            callerOrigin = caller.executionOrigin;
                            effects += 1;
                            return { kind: 'checkpointOnly', checkpointAfterBatch: { baseline: 'mailbox-one' }, retryHint: { retryAfterMs: 60_000 } };
                        } },
                },
                contributesTo: { 'happier.channels': { providers: { 'mail-provider': protocol.contribute({ descriptor: { v: 1, displayName: 'Checkpointed mail' }, operations: {
                    setup: protocol.operations.setup.bind('prepare'),
                    connectionTest: protocol.operations.connectionTest.bind('inspect'),
                    messageDeliver: protocol.operations.messageDeliver.bind('send'),
                    observationsPoll: protocol.operations.observationsPoll.bind('receive'),
                } }) } } },
            });
            // Installed manifests are an external boundary; bypass author validation
            // to prove the production target rejects a descriptor-less provider.
            const providerManifest = structuredClone(provider.manifest);
            if (kind === 'missing-descriptor') {
                delete providerManifest.contributes.targetedPluginContributions[0]!.descriptor;
            }
            const fixture = await createAuthoredAdmittedPluginRuntimeFixture({
                plugins: [core, provider].map(plugin => ({ manifest: plugin.manifest,
                    files: { 'daemon.mjs': 'export function activate() {}' },
                    instantiateCommittedModule: () => ({ activate: plugin.activate }),
                    ...(plugin === provider ? { manifest: providerManifest } : {}),
                })),
                async resolveContributes(happyHomeDir) {
                    // Isolate this Channels declaration from bundled Channels.
                    // Physical installed custody still comes from the admitted store.
                    return createResolvedContributionRegistry(projectLoadedPluginContributes({
                        loadResult: await loadInstalledPlugins({ happyHomeDir }), provenance: 'builtin',
                    }));
                },
                runtimeOptions: {
                    scopedActionRuntime: {
                        credentials: { token: 'fixture-account-token', encryption: null },
                        actionsSettingsProvider: createActionSettingsProvider({ getAccountSettings: () => null, allowEnvironmentOverride: false }),
                    },
                    resolveCurrentMachineId: () => home.machineId,
                    resolveCurrentMachineExecutionOriginContext: async () => kind === 'missing-origin' ? null
                        : { ...home, machineId: kind === 'wrong-machine' ? 'forged-machine' : home.machineId },
                },
            });
            try {
                const admitted = fixture.registry.readAdmittedTargetedContributions?.({
                    targetPluginId: 'happier.channels', pointId: 'providers',
                    protocol: { id: protocol.id, version: protocol.version },
                });
                if (kind === 'missing-descriptor') {
                    expect(admitted?.contributions).toEqual([]);
                    expect(effects).toBe(0);
                    return;
                }
                expect(admitted?.contributions).toEqual([expect.objectContaining({
                    descriptor: { v: 1, displayName: 'Checkpointed mail' },
                })]);
                fixture.registry.startAdoptedBackgroundServices?.();
                await vi.waitFor(async () => {
                    const connection = await state.get('connection-background-poll');
                    if (kind === 'missing-origin' || kind === 'wrong-machine') {
                        expect(connection?.value.payload).toMatchObject({ pollFailure: {
                            phase: 'blocked', evidence: { kind: 'action', code: 'plugin_action_caller_unavailable' },
                        } });
                        expect(effects).toBe(0);
                        expect([...state.rows.values()].some(row => row.value['record-kind'] === 'checkpoint')).toBe(false);
                    } else {
                        expect([...state.rows.values()].find(row => row.value['record-kind'] === 'checkpoint')?.value.payload)
                            .toMatchObject({ opaqueToken: { baseline: 'mailbox-one' }, authorityEpoch: 1 });
                        expect(connection?.value.payload).toMatchObject({ authorityEpoch: 1, pollFailure: null });
                        expect(effects).toBe(1);
                        expect(callerOrigin).toEqual({ serverIdentityId: home.serverIdentityId,
                            materializationRef: fixture.registry.resolveCurrentPluginMaterializationRef?.('happier.channels') });
                    }
                }, { timeout: 30_000 });
            } finally {
                await fixture.dispose();
                await supervisor.dispose();
            }
        },
    );
});
