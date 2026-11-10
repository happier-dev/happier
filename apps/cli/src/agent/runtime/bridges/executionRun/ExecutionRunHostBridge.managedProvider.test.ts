import { readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { expect, it, onTestFailed, vi } from 'vitest';
import { ProviderConnectionIdSchema } from '@happier-dev/protocol';
import { ExecutionRunTurnStreamReadResponseSchema, ExecutionRunTurnStreamStartResponseSchema } from '@happier-dev/protocol/execution/runs/streaming';
import { SESSION_FOLLOW_HTTP_PATHS_V1, SessionAutoFollowPreferencesResponseSchema } from '@happier-dev/protocol/sessions/follow/api';
import { DEFAULT_SESSION_AUTO_FOLLOW_PREFERENCES_V1, DEFAULT_SESSION_FOLLOW_CREATION_POLICIES_V1 } from '@happier-dev/protocol/sessions/follow/accountFollow';
import { readBackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { createSessionRunReportPolicyReader } from '@/api/sessionFollowCreationPreferences';
import { resolveCliVoicePromptPreparation } from '@/agent/prompts/library/resolveCliVoicePromptStackBlocks';
import { readStoredCredentials } from '@/persistence';
import { createExecutionRunManagedProviderEndpointPreparer } from './runtime/managedProvider';
import { createManagedRunLaunchFixture } from '@/providers/lifecycle/managedRunLaunch.testkit';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { ExecutionRunHostBridge } from './ExecutionRunHostBridge';
import { resolveCliEngineRegistry } from '@/agent/runtime/registry/engineRegistry';
import { acquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import { createRuntimeProviderModelManagementServices } from '@/providers/modelManagement/runtimeServices';
import { createAccountConnectionManagedConsumerSourceOpen } from '@/providers/broker/accountConnectionSource';
import { createManagedProviderExplicitStartCustody } from '@/providers/connections/publicManagedRuntimeStart';
import { createRunnerExecutionRunProviderLaunchServices } from '@/daemon/agentRuntime/runnerExecutionRunProviderLaunch';
import { resolveRunnerAgentSessionDescriptorForLease } from '@/daemon/spawn/prepareAgentRuntimeSessionBridge';
import { createProviderLaunchResourceScope } from '@/providers/lifecycle/resourceScope';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { ProviderEnforcedPermissionHandler } from '@/agent/permissions/providerEnforced/handler';

const { directory, originalHome } = await vi.hoisted(async () => {
    const [{ mkdtemp }, { tmpdir }, { join }] = await Promise.all([
        import('node:fs/promises'), import('node:os'), import('node:path'),
    ]);
    const directory = await mkdtemp(join(tmpdir(), 'happier-managed-run-host-'));
    const originalHome = process.env.HAPPIER_HOME_DIR;
    process.env.HAPPIER_HOME_DIR = join(directory, 'home');
    return { directory, originalHome };
});

it('admits a Voice Run once and forwards two spoken turns without reevaluating broker authority', async () => {
    let phase = 'committed Agent and Gateway fixture';
    onTestFailed(() => { console.info('managed Run host fixture phase:', phase); });
    const providerRequests: string[] = [];
    const followPreferences = SessionAutoFollowPreferencesResponseSchema.parse({
        ...DEFAULT_SESSION_AUTO_FOLLOW_PREFERENCES_V1,
        ...DEFAULT_SESSION_FOLLOW_CREATION_POLICIES_V1,
    });
    // A real HTTP origin observes model requests after the isolated consumer
    // listener, admitted Account source and physical managed Gateway.
    const upstream = createServer(async (request, response) => {
        if (request.method === 'GET' && request.url === SESSION_FOLLOW_HTTP_PATHS_V1.preferences) {
            response.setHeader('content-type', 'application/json');
            response.end(JSON.stringify(followPreferences));
            return;
        }
        let body = '';
        for await (const chunk of request) body += String(chunk);
        providerRequests.push(body);
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ output_text: 'Managed Voice reply' }));
    });
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
    const address = upstream.address();
    if (!address || typeof address === 'string') throw new Error('Expected Provider HTTP address');
    const fixture = await createManagedRunLaunchFixture({ directory, controller: pluginReloadController, physicalGateway: true,
        upstreamUrl: `http://127.0.0.1:${address.port}`, readUpstreamAnswer: true }).catch(async error => {
        await new Promise<void>((resolve, reject) => upstream.close(closeError => closeError ? reject(closeError) : resolve()));
        throw error;
    });
    const connectionId = ProviderConnectionIdSchema.parse('run-gateway');
    const otherConnectionId = ProviderConnectionIdSchema.parse('other-connection');
    let manager: InstanceType<typeof ExecutionRunHostBridge> | null = null;
    let sourceOpens = 0;
    let consumerAdmissions = 0;
    let sourceAuthorityReads = 0;
    let consumerClosed = false;
    let runSignal: AbortSignal | null = null;
    let endpointCleanup: (() => void | Promise<void>) | null = null;
    let differentProviderAuthority: ReturnType<ExecutionRunHostBridge['resolveLiveBrokerAuthority']> | null = null;
    const providerResources = createProviderLaunchResourceScope();
    try {
        phase = 'real engine registry';
        const engineRegistry = await resolveCliEngineRegistry({ runtimeRegistry: fixture.lease.registry });
        const profileCatalog = await engineRegistry.resolveExecutionRunProfileCatalog({
            resolveAgentIdentity: () => ({ pluginId: 'acme.managed-run', localId: 'agent' }),
        });
        const purposeResolver = fixture.gateway!.purposeBindingOwner.resolveBindingIntent;
        const models = createRuntimeProviderModelManagementServices({ machineId: fixture.machineId,
            happyHomeDir: fixture.happyHomeDir, registry: fixture.contributes, featureGate: { isEnabled: () => true },
            acquireRuntimeLease: async () => await acquireAuthoritativePluginRuntimeRegistryLease({ happyHomeDir: fixture.happyHomeDir }),
            modelSettingsMutation: async () => { throw new Error('Unexpected model mutation'); },
        });
        const prepareEndpoint = createExecutionRunManagedProviderEndpointPreparer({
          machineId: fixture.machineId, accountId: 'account', readAccountSettingsSnapshot: async () => fixture.snapshot,
          resolveManagedPurposeBindingIntent: purposeResolver,
          openSource: async ({ request: sourceRequest, signal, isCurrent }) => {
            runSignal = signal;
            const consumer = sourceRequest.consumer;
            if (consumer.kind !== 'execution_run') throw new Error('Expected Run consumer');
            const executionRunId = consumer.executionRunId;
            const executionRunOccurrenceId = sourceRequest.executionRunOccurrenceId;
            if (!executionRunOccurrenceId) throw new Error('Expected admitted Run occurrence');
            expect(await isCurrent()).toBe(true);
            expect(manager!.resolveLiveBrokerAuthority({ v: 1, executionRunId,
                expectedOccurrenceId: executionRunOccurrenceId })).toMatchObject({ status: 'current' });
            const otherProviderProof = { v: 1 as const, executionRunId,
                expectedOccurrenceId: executionRunOccurrenceId,
                expectedProviderConnectionModel: { agentId: fixture.agentId, agentTargetKey: fixture.agentTargetKey,
                    providerConnectionId: otherConnectionId, modelId: 'example' } };
            differentProviderAuthority = manager!.resolveLiveBrokerAuthority(otherProviderProof);
            expect(manager!.resolveLiveBrokerAuthority({ ...otherProviderProof,
                expectedProviderConnectionModel: { ...otherProviderProof.expectedProviderConnectionModel,
                    providerConnectionId: connectionId } })).toMatchObject({ status: 'current' });
            const open = createAccountConnectionManagedConsumerSourceOpen({ homeId: 'home', accountId: 'account', machineId: fixture.machineId,
                expectedAccountSettingsScopeKey: fixture.snapshot.scopeKey!, getAccountSettingsSnapshot: () => fixture.snapshot,
                custody: createManagedProviderExplicitStartCustody({ machineId: fixture.machineId, happyHomeDir: fixture.happyHomeDir,
                    controller: pluginReloadController }), withRegistry: async read => {
                    sourceAuthorityReads++;
                    return await read(fixture.contributes);
                },
                resolveBindingIntent: purposeResolver,
                admitConsumer: async request => {
                    consumerAdmissions++;
                    return await isCurrent()
                        && request.executionRunOccurrenceId === executionRunOccurrenceId
                        && manager!.resolveLiveBrokerAuthority({ v: 1, executionRunId,
                            expectedOccurrenceId: executionRunOccurrenceId }).status === 'current';
                },
                projectModels: async request => await models.projectModelsForAccount(request, {
                    getAccountSettingsSnapshot: () => fixture.snapshot, resolveManagedPurposeBindingIntent: purposeResolver, signal, isCurrent }),
            });
            const opened = await open({ ...sourceRequest, signal });
            expect(opened).not.toBeNull();
            if (!opened) throw new Error('Expected admitted Run source');
            sourceOpens++;
            return { ...opened, cleanup: async () => { await opened.cleanup(); consumerClosed = true; } };
          },
        });
        const prepareManagedEndpoint: NonNullable<ConstructorParameters<typeof ExecutionRunHostBridge>[0]['prepareManagedEndpoint']> = async input => {
            const endpoint = await prepareEndpoint(input);
            endpointCleanup = endpoint.cleanup;
            return endpoint;
        };
        const providerPorts = { prepareManagedEndpoint, resolveManagedPurposeBindingIntent: purposeResolver };
        const backendTarget = { kind: 'builtInAgent' as const, agentId: fixture.agentId };
        const descriptor = await resolveRunnerAgentSessionDescriptorForLease({ target: readBackendTargetRefV2(backendTarget), lease: fixture.lease });
        const binding = fixture.lease.registry.agentRuntimesByAgentId.get(fixture.agentId)?.sessionRunnerFactoryBinding;
        if (!descriptor || !binding) throw new Error('Expected admitted Session Agent descriptor and binding');
        const providerLaunch = createRunnerExecutionRunProviderLaunchServices({
            agent: { descriptor, binding }, backendTarget, runtimeRegistryLease: fixture.lease,
            retainCleanup: providerResources.register,
            resolvePreparation: async request => ({ machineId: fixture.machineId, happyHomeDir: fixture.happyHomeDir,
                featureEnabled: true, accountSettingsSnapshot: fixture.snapshot, readAccountSettingsSnapshot: () => fixture.snapshot,
                resolveManagedPurposeBindingIntent: purposeResolver,
                prepareManagedEndpoint: async input => {
                    if (!request.controllerOccurrenceId || !input.signal) throw new Error('Expected admitted Run occurrence and lifetime');
                    const signal = input.signal;
                    return await prepareManagedEndpoint({ ...input, agentId: request.agentId,
                        executionRunOccurrenceId: request.controllerOccurrenceId, signal,
                        isCurrent: () => !signal.aborted && manager?.get(request.runId)?.status === 'running' });
                },
                isCurrent: () => manager?.get(request.runId)?.status === 'running' }),
        });
        const credentials = await readStoredCredentials();
        if (!credentials) throw new Error('Expected authored fixture credentials');
        const parent = createMutableApiSessionClientFixture({ sessionId: 'voice-provider-parent',
            metadata: createTestMetadata({ path: fixture.happyHomeDir, machineId: fixture.machineId }) });
        manager = new ExecutionRunHostBridge({ parentProvider: 'codex', cwd: fixture.happyHomeDir,
            happyHomeDir: fixture.happyHomeDir, machineId: fixture.machineId, sendAcp: async () => {},
            resolveProvidersFeatureEnabled: () => true,
            resolveAccountSettingsSnapshot: async () => fixture.snapshot,
            resolveRunReportPolicy: createSessionRunReportPolicyReader({ serverId: 'fixture-home',
                serverHttpBaseUrl: `http://127.0.0.1:${address.port}`, accountId: 'account',
                readCredentials: readStoredCredentials, isCurrent: () => true }),
            // The authored Session has no prompt-library, Profile or Project
            // entries. Keep its actual Voice prompt preparation owner.
            resolveVoicePromptPreparation: async args => await resolveCliVoicePromptPreparation({ ...args, credentials,
                serverId: 'fixture-home', sessionMetadata: parent.getMetadataSnapshot(), machineId: fixture.machineId,
                directory: fixture.happyHomeDir, accountEntries: [], profileEntries: [], projectEntries: [] }),
            sessionInteractionHost: { session: parent, machineId: fixture.machineId,
                permissionHandler: new ProviderEnforcedPermissionHandler(parent, { logPrefix: '[Voice Provider]' }) },
            resolveExecutionRunProfileCatalog: async () => ({ profileCatalog, engineRegistry, providerLaunch }),
            ...providerPorts,
        });
        phase = 'Run start';
        const started = await manager.start({ sessionId: 'voice-provider-parent', intent: 'voice_agent',
            backendTarget,
            modelSelection: { agentTargetKey: fixture.agentTargetKey, providerConnectionId: connectionId, modelId: 'example' },
            accountSettings: fixture.snapshot.settings, instructions: 'Exercise the admitted Provider endpoint.',
            permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'streaming',
            chatModelId: 'example', commitModelId: 'example', bootstrapMode: 'none', initialContextMode: 'first_turn',
            connectedServices: null });
        expect(manager.get(started.runId), JSON.stringify({ summary: manager.get(started.runId)?.summary,
            result: manager.getLatestToolResult(started.runId), sourceOpens })).toMatchObject({ intent: 'voice_agent', status: 'running' });
        expect(differentProviderAuthority).toMatchObject({ status: 'not_current', reason: 'identity_mismatch' });
        expect(sourceOpens).toBe(1);
        expect(consumerAdmissions).toBeGreaterThan(0);
        expect(sourceAuthorityReads).toBeGreaterThan(0);
        expect(providerRequests).toHaveLength(0);
        const turnAuthorityEvaluations: { consumerAdmissions: number; sourceAuthorityReads: number }[] = [];
        for (const [index, message] of ['First spoken question', 'Second spoken question'].entries()) {
            phase = `spoken turn ${index + 1}`;
            const admittedCounts = { consumerAdmissions, sourceAuthorityReads };
            const stream = ExecutionRunTurnStreamStartResponseSchema.parse(await manager.startTurnStream(started.runId,
                { message, userTranscript: { mode: 'suppress' } }));
            let read = ExecutionRunTurnStreamReadResponseSchema.parse(await manager.readTurnStream(started.runId,
                { streamId: stream.streamId, cursor: 0, waitForEvents: true }));
            const events = [...read.events];
            while (!read.done) {
                read = ExecutionRunTurnStreamReadResponseSchema.parse(await manager.readTurnStream(started.runId,
                    { streamId: stream.streamId, cursor: read.nextCursor, waitForEvents: true }));
                events.push(...read.events);
            }
            expect(JSON.stringify(events)).toContain('Managed Voice reply');
            expect(providerRequests).toHaveLength(index + 1);
            expect(providerRequests[index]).toContain(message);
            turnAuthorityEvaluations.push({ consumerAdmissions: consumerAdmissions - admittedCounts.consumerAdmissions,
                sourceAuthorityReads: sourceAuthorityReads - admittedCounts.sourceAuthorityReads });
            expect(sourceOpens).toBe(1);
            expect(manager.get(started.runId)).toMatchObject({ intent: 'voice_agent', status: 'running' });
        }
        expect(await readFile(join(directory, 'gateway-started'), 'utf8')).toMatch(/^\d+$/);
        phase = 'Voice End';
        expect(await manager.stop(started.runId)).toMatchObject({ ok: true });
        await manager.waitForTerminal(started.runId);
        expect(runSignal && (runSignal as AbortSignal).aborted).toBe(true);
        await (endpointCleanup as (() => void | Promise<void>) | null)?.();
        expect(consumerClosed).toBe(true);
        expect(await manager.startTurnStream(started.runId, { message: 'Speech after End' }))
            .toMatchObject({ ok: false, errorCode: 'execution_run_not_allowed' });
        expect(providerRequests).toHaveLength(2);
        expect(manager.resolveLiveBrokerAuthority({ v: 1, executionRunId: started.runId, expectedOccurrenceId: null })).toMatchObject({ status: 'not_current', reason: 'terminal' });
        expect(turnAuthorityEvaluations).toEqual([
            { consumerAdmissions: 0, sourceAuthorityReads: 0 },
            { consumerAdmissions: 0, sourceAuthorityReads: 0 },
        ]);
    } finally {
        await manager?.dispose();
        await providerResources.release();
        await fixture.cleanup();
        await new Promise<void>((resolve, reject) => upstream.close(error => error ? reject(error) : resolve()));
        vi.unstubAllEnvs();
        if (originalHome === undefined) delete process.env.HAPPIER_HOME_DIR;
        else process.env.HAPPIER_HOME_DIR = originalHome;
        await rm(directory, { recursive: true, force: true });
    }
}, 30_000);
