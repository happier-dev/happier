import { describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { createServer } from 'node:http';
import { convertBackendTargetRefV2ToV1, readBackendTargetRefV2, ProviderConnectionIdSchema } from '@happier-dev/protocol';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createManagedRunLaunchFixture } from '@/providers/lifecycle/managedRunLaunch.testkit';
import { createProviderLaunchResourceScope } from '@/providers/lifecycle/resourceScope';
import { resolveRunnerAgentSessionDescriptorForLease } from '@/daemon/spawn/prepareAgentRuntimeSessionBridge';
import { createRunnerExecutionRunProviderLaunchServices, projectRunnerExecutionRunProviderLaunch } from '@/daemon/agentRuntime/runnerExecutionRunProviderLaunch';
import { AgentRuntimeDaemonServiceResponseV1Schema } from '@/agent/runtime/session/process/agentRuntimeDaemonServiceProtocol';
import { splitProviderSettingsV1 } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot,
    type AccountSettingsSnapshotResolver, type ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createExecutionRunAccountSettingsSnapshotResolver } from '@/api/machine/resolveExecutionRunAccountSettingsSnapshot';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { accountSettingsParse, sealSavedSecretResourceStoredContentV1 } from '@happier-dev/protocol';
import { prepareExecutionRunProviderLaunch } from './providerLaunch';
import { logger } from '@/ui/logger';
import { resolveCliEngineRegistry } from '@/agent/runtime/registry/engineRegistry';
import { createExecutionRunRuntime } from './create';
import { ExecutionRunHostBridge } from '../ExecutionRunHostBridge';
import { AgentRuntimeDaemonServiceRequestV1Schema } from '@/agent/runtime/session/process/agentRuntimeDaemonServiceProtocol';

describe('execution-run pinned Provider preparation', () => {
    it('keeps a finite managed-purpose Run acquisition owned through disposal', async () => {
        let enterMaterialization!: () => void;
        const enteredMaterialization = new Promise<'materializing'>(resolve => { enterMaterialization = () => resolve('materializing'); });
        let releaseMaterialization!: () => void;
        const materializationReleased = new Promise<void>(resolve => { releaseMaterialization = resolve; });
        const adapterBoundary = createServer(async (_request, response) => {
            enterMaterialization();
            await materializationReleased;
            response.end('ready');
        });
        await new Promise<void>(resolve => adapterBoundary.listen(0, '127.0.0.1', resolve));
        const address = adapterBoundary.address();
        if (!address || typeof address === 'string') throw new Error('Expected adapter boundary address');
        const fixture = await createManagedRunLaunchFixture({ physicalGateway: true,
            materializationUrl: 'http://127.0.0.1:' + address.port,
            connectedAccountModels: [{ id: 'example', name: 'Example' }],
        });
        const resources = createProviderLaunchResourceScope();
        let runtime: ReturnType<typeof createExecutionRunRuntime> | undefined;
        let provisioning: Promise<unknown> | undefined;
        let disposal: Promise<void> | undefined;
        try {
            const backendTarget = { kind: 'backend' as const, backendId: fixture.agentId };
            const descriptor = await resolveRunnerAgentSessionDescriptorForLease({ target: backendTarget, lease: fixture.lease });
            const binding = fixture.lease.registry.agentRuntimesByAgentId.get(fixture.agentId)?.sessionRunnerFactoryBinding;
            if (!descriptor || !binding) throw new Error('Expected admitted executable Agent source');
            const providerLaunch = createRunnerExecutionRunProviderLaunchServices({ agent: { descriptor, binding }, backendTarget,
                runtimeRegistryLease: fixture.lease, retainCleanup: resources.register,
                resolvePreparation: async () => ({ machineId: fixture.machineId, happyHomeDir: fixture.happyHomeDir,
                    featureEnabled: true, accountSettingsSnapshot: fixture.snapshot,
                    resolveManagedPurposeBindingIntentSelection: fixture.gateway!.purposeBindingOwner.resolveBindingIntentSelection,
                    readCurrentnessRefusal: async () => null }),
            });
            runtime = createExecutionRunRuntime({ cwd: fixture.happyHomeDir, happyHomeDir: fixture.happyHomeDir,
                scope: 'detached', runId: 'managed-purpose-finite-run', backendId: fixture.agentId, backendTarget,
                modelSelection: { source: 'connected_account', purpose: fixture.gateway!.purposeBindings.bindings[0]!.purpose,
                    endpointTemplateId: 'api', agentTargetKey: fixture.agentTargetKey, modelId: 'example' },
                modelId: 'example', permissionMode: 'default', start: { intent: 'agent' },
                machineId: fixture.machineId, engineRegistry: await resolveCliEngineRegistry({ runtimeRegistry: fixture.lease.registry }),
                connectedServices: { v: 2, bindingsByServiceId: { 'acme.shared-registry/accounts': { source: 'connected', profileId: 'upstream-account' } } },
                resolveProvidersFeatureEnabled: () => true, resolveAccountSettingsSnapshot: async () => fixture.snapshot, providerLaunch,
            });
            provisioning = runtime.provisionRuntime({ initialPrompt: 'Use the selected managed source.' });
            const phase = await Promise.race([enteredMaterialization, provisioning.then(() => 'native_bypass' as const)]);
            expect(phase).toBe('materializing');
            let disposed = false;
            disposal = runtime.dispose().then(() => { disposed = true; });
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(disposed, 'Disposal must retain the in-flight managed acquisition until it can retire').toBe(false);
            releaseMaterialization();
            await provisioning.catch(() => undefined);
            await disposal;
            expect(disposed).toBe(true);
        } finally {
            releaseMaterialization();
            await provisioning?.catch(() => undefined);
            await (disposal ?? runtime?.dispose());
            await resources.retire();
            await fixture.cleanup();
            await new Promise<void>((resolve, reject) => adapterBoundary.close(error => error ? reject(error) : resolve()));
        }
    });
    it.each(['runtime', 'bridge'] as const)('keeps the admitted launch overlay across an unrelated publication in the %s continuation', async entry => {
        const fixture = await createManagedRunLaunchFixture();
        const credentials = { token: 'run-account', encryption: null } as const;
        const resource = { resourceId: 'overlay-secret', ownerAccountId: 'run-account', displayName: 'Overlay secret',
            kind: 'token' as const, encryptionMode: 'plain' as const, revision: 1, materialStatus: 'ready' as const,
            storedContent: sealSavedSecretResourceStoredContentV1({ resourceId: 'overlay-secret', mode: 'plain',
                content: { v: 1, name: 'Overlay secret', kind: 'token', value: 'overlay-fixture-material' } }) };
        setActiveAccountSettingsSnapshot({ ...fixture.snapshot, source: 'network', rawSettings: {},
            scopeKey: runWithServerHttpBaseUrl('https://overlay-home.test', () => resolveAccountSettingsScopeKey(credentials)),
            savedSecretResources: [resource], savedSecretCatalogState: 'ready' });
        const home = vi.spyOn(axios, 'get').mockImplementation(async url => {
            const path = new URL(String(url)).pathname;
            if (path === '/v1/account/saved-secrets/resources/materials') return { status: 200, data: { resources: [{
                resourceId: resource.resourceId, encryptionMode: resource.encryptionMode, storedContent: resource.storedContent,
                recipientEnvelope: null, entry: { ref: 'happier:shared-secret:v1:overlay-secret', source: 'shared_resource',
                    relationship: 'owner', ownerAccountId: 'run-account', name: 'Overlay secret', kind: 'token', revision: 1,
                    materialStatus: 'ready', capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } },
            }] } };
            if (path === '/v1/account/encryption/currentness') return { status: 200, data: {
                mode: 'plain', version: 1, settingsVersion: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
            throw new Error(`Unexpected fixture Home read: ${path}`);
        });
        const resolver = createExecutionRunAccountSettingsSnapshotResolver({ machineId: fixture.machineId,
            serverHttpBaseUrl: 'https://overlay-home.test', readCredentials: async () => credentials,
            isOwnerCurrent: () => true, onSettings() {} });
        let publications = 0;
        // Preserve the real resolver and operation. Place a genuine preference
        // publication in the await continuation before the launch consumes it.
        const scheduled: AccountSettingsSnapshotResolver = Object.assign((demand: Parameters<AccountSettingsSnapshotResolver>[0]) => {
            const read = resolver(demand);
            void read.then(async snapshot => {
                if (!demand?.secretReferenceOverlay || !snapshot || publications > 0) return;
                publications++;
                await resolver.readOperationContext()!.replaceAccountSettings({ ...snapshot,
                    settingsVersion: snapshot.settingsVersion + 1,
                    settings: accountSettingsParse({ ...snapshot.settings, preferredLanguage: 'fr' }) });
            });
            return read;
        }, { readOperationContext: resolver.readOperationContext });
        const secretReferenceOverlay = { v: 1 as const, bindings: { TOKEN: { ref: 'happier:shared-secret:v1:overlay-secret', revision: 1 } } };
        let runtime: ReturnType<typeof createExecutionRunRuntime> | undefined;
        let manager: ExecutionRunHostBridge | undefined;
        try {
            const engineRegistry = await resolveCliEngineRegistry({ runtimeRegistry: fixture.lease.registry });
            if (entry === 'runtime') {
                runtime = createExecutionRunRuntime({ cwd: fixture.happyHomeDir, happyHomeDir: fixture.happyHomeDir,
                    scope: 'detached', runId: 'overlay-publication-run', backendId: fixture.agentId, permissionMode: 'default',
                    start: { intent: 'review' }, connectedServices: null, engineRegistry, secretReferenceOverlay,
                    resolveAccountSettingsSnapshot: scheduled });
                await expect(runtime.readResumeSupport()).resolves.toBeDefined();
            } else {
                const profileCatalog = await engineRegistry.resolveExecutionRunProfileCatalog({
                    resolveAgentIdentity: () => ({ pluginId: 'acme.managed-run', localId: 'agent' }) });
                manager = new ExecutionRunHostBridge({ parentProvider: 'codex', cwd: fixture.happyHomeDir,
                    happyHomeDir: fixture.happyHomeDir, machineId: fixture.machineId, sendAcp: async () => {},
                    resolveAccountSettingsSnapshot: scheduled,
                    resolveExecutionRunProfileCatalog: async () => ({ profileCatalog, engineRegistry }) });
                await expect(manager.start({ sessionId: null, intent: 'agent',
                    backendTarget: convertBackendTargetRefV2ToV1({ kind: 'backend', backendId: fixture.agentId }),
                    instructions: 'Inspect project.', permissionMode: 'read_only', retentionPolicy: 'ephemeral',
                    runClass: 'bounded', ioMode: 'request_response', secretReferenceOverlay })).resolves.toMatchObject({ runId: expect.any(String) });
            }
            expect(publications).toBe(1);
        } finally {
            await runtime?.dispose(); await manager?.dispose(); await resolver.dispose(); home.mockRestore();
            resetActiveAccountSettingsSnapshotForTests(); await fixture.cleanup();
        }
    });

    it('refuses an explicitly undeclared effort at launch before acquiring an endpoint', async () => {
        const fixture = await createManagedRunLaunchFixture({ physicalGateway: true, supportsReasoningEffort: true });
        const catalog = splitProviderSettingsV1({ ...fixture.providerSettings,
            manualModelsByConnectionId: { [ProviderConnectionIdSchema.parse('run-gateway')]: [{ id: 'example', addedAt: 1, reasoningEffortLevels: ['low', 'high'] }] },
        }).catalog;
        const snapshot: ActiveAccountSettingsSnapshot = { ...fixture.snapshot,
            providerConnectionsCatalog: { status: 'ready', revision: 2, catalog } };
        const resources = createProviderLaunchResourceScope();
        let manager: ExecutionRunHostBridge | undefined;
        let endpoints = 0;
        try {
            const backendTarget = { kind: 'backend' as const, backendId: fixture.agentId };
            const descriptor = await resolveRunnerAgentSessionDescriptorForLease({ target: backendTarget, lease: fixture.lease });
            const binding = fixture.lease.registry.agentRuntimesByAgentId.get(fixture.agentId)?.sessionRunnerFactoryBinding;
            if (!descriptor || !binding) throw new Error('Expected admitted executable Agent source');
            const providerLaunch = createRunnerExecutionRunProviderLaunchServices({ agent: { descriptor, binding }, backendTarget,
                runtimeRegistryLease: fixture.lease, retainCleanup: resources.register,
                resolvePreparation: async request => {
                    // The bridge is the real producer; its exact request must
                    // also be accepted by the runner's strict transport reader.
                    AgentRuntimeDaemonServiceRequestV1Schema.parse({ v: 1,
                        context: { token: 'A'.repeat(43), sessionId: 'effort-session' },
                        operation: { kind: 'execution_run.provider.prepare_v1', ...request,
                            backendTarget: readBackendTargetRefV2(request.backendTarget) },
                    });
                    return { machineId: fixture.machineId, featureEnabled: true,
                    happyHomeDir: fixture.happyHomeDir, accountSettingsSnapshot: snapshot,
                    readCurrentnessRefusal: async () => null,
                    resolveManagedPurposeBindingIntent: fixture.gateway!.purposeBindingOwner.resolveBindingIntent,
                    prepareManagedEndpoint: async () => { endpoints += 1; throw new Error('Endpoint must not be reached'); },
                    };
                },
            });
            const engineRegistry = await resolveCliEngineRegistry({ runtimeRegistry: fixture.lease.registry });
            const profileCatalog = await engineRegistry.resolveExecutionRunProfileCatalog({
                resolveAgentIdentity: () => ({ pluginId: 'acme.managed-run', localId: 'agent' }),
            });
            manager = new ExecutionRunHostBridge({ parentProvider: 'codex', cwd: fixture.happyHomeDir,
                happyHomeDir: fixture.happyHomeDir, machineId: fixture.machineId, sendAcp: async () => {},
                resolveProvidersFeatureEnabled: () => true, resolveAccountSettingsSnapshot: async () => snapshot,
                resolveExecutionRunProfileCatalog: async () => ({ profileCatalog, engineRegistry, providerLaunch }),
            });
            const started = await manager.start({ sessionId: null, intent: 'agent', backendTarget: convertBackendTargetRefV2ToV1(backendTarget),
                modelSelection: { agentTargetKey: fixture.agentTargetKey, providerConnectionId: ProviderConnectionIdSchema.parse('run-gateway'), modelId: 'example' },
                sessionConfigOptionOverrides: { v: 1, updatedAt: 1, overrides: { reasoning_effort: { updatedAt: 1, value: 'ultra' } } },
                accountSettings: fixture.snapshot.settings, instructions: 'Do not create a Run.', permissionMode: 'read_only',
                retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'request_response',
            });
            await manager.waitForTerminal(started.runId);
            expect(manager.getPublic(started.runId)).toMatchObject({ status: 'failed',
                error: { code: 'provider_model_config_option_unsupported' } });
            expect(endpoints).toBe(0);
        } finally { await manager?.dispose(); await resources.release(); await fixture.cleanup(); }
    });

    it('attributes the real lazy runtime shell once without provisioning a native Agent', async () => {
        const fixture = await createManagedRunLaunchFixture();
        const diagnostics = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
        const runtime = createExecutionRunRuntime({ cwd: fixture.happyHomeDir, happyHomeDir: fixture.happyHomeDir,
            scope: 'detached', runId: 'lazy-preparation-run', backendId: fixture.agentId, permissionMode: 'default',
            start: { intent: 'review' }, connectedServices: null,
            engineRegistry: await resolveCliEngineRegistry({ runtimeRegistry: fixture.lease.registry }) });
        try {
            await runtime.readResumeSupport();
            await runtime.readResumeSupport();
            const phases = diagnostics.mock.calls.flatMap(([marker, record]) =>
                marker === '[PROVIDER] Run preparation phase' ? [record] : []);
            expect(phases).toHaveLength(4);
            expect(phases).toEqual(['engine_resolution', 'connected_services_selection',
                'connected_services_materialization', 'runtime_create'].map(phase => ({
                runId: 'lazy-preparation-run', phase, outcome: 'completed', startedAtMs: expect.any(Number),
                finishedAtMs: expect.any(Number), elapsedMs: expect.any(Number),
            })));
        } finally { await runtime.dispose(); diagnostics.mockRestore(); await fixture.cleanup(); }
    });
    it.each(['failed', 'cancelled'] as const)('records one payload-free endpoint phase when its boundary is %s', async outcome => {
        const fixture = await createManagedRunLaunchFixture({ physicalGateway: true });
        const diagnostics = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
        const controller = new AbortController();
        const failure = new Error('private-endpoint-credential');
        try {
            await expect(prepareExecutionRunProviderLaunch({
                selection: { agentTargetKey: fixture.agentTargetKey, providerConnectionId: ProviderConnectionIdSchema.parse('run-gateway'), modelId: 'example' },
                backendTarget: { kind: 'backend', backendId: fixture.agentId },
                agentId: fixture.agentId, runId: 'endpoint-failure-run', machineId: fixture.machineId,
                featureEnabled: true, happyHomeDir: fixture.happyHomeDir, accountSettingsSnapshot: fixture.snapshot,
                runtimeRegistryLease: fixture.lease, signal: controller.signal,
                resolveManagedPurposeBindingIntent: fixture.gateway!.purposeBindingOwner.resolveBindingIntent,
                // The endpoint acquisition is the OS/network boundary; real
                // authorization and cleanup run beneath the public Run owner.
                prepareManagedEndpoint: async () => {
                    if (outcome === 'cancelled') controller.abort(failure);
                    throw failure;
                },
            })).rejects.toMatchObject({ code: 'agent_error' });
            const phases = diagnostics.mock.calls.filter(([marker]) => marker === '[PROVIDER] Run preparation phase');
            expect(phases.filter(([, record]) => typeof record === 'object' && record !== null
                && 'phase' in record && record.phase === 'managed_endpoint')).toEqual([
                ['[PROVIDER] Run preparation phase', { runId: 'endpoint-failure-run', phase: 'managed_endpoint', outcome,
                    startedAtMs: expect.any(Number), finishedAtMs: expect.any(Number), elapsedMs: expect.any(Number) }],
            ]);
            expect(JSON.stringify(phases)).not.toContain(failure.message);
        } finally { diagnostics.mockRestore(); await fixture.cleanup(); }
    });
    it('uses the retained executable snapshot for admission and materialization without a runner daemon singleton', async () => {
        const fixture = await createManagedRunLaunchFixture({ physicalGateway: true });
        let endpointReleased = false;
        try {
            expect(pluginReloadController.getState().activeRegistry).toBeNull();
            const input = {
                selection: { agentTargetKey: fixture.agentTargetKey, providerConnectionId: ProviderConnectionIdSchema.parse('run-gateway'), modelId: 'example' },
                backendTarget: { kind: 'backend' as const, backendId: fixture.agentId },
                agentId: fixture.agentId, runId: 'pinned-provider-run', machineId: fixture.machineId,
                featureEnabled: true, happyHomeDir: fixture.happyHomeDir, accountSettingsSnapshot: fixture.snapshot,
                runtimeRegistryLease: fixture.lease,
                resolveManagedPurposeBindingIntent: fixture.gateway!.purposeBindingOwner.resolveBindingIntent,
            };
            // The endpoint is the sole external boundary: real admitted Agent
            // preparation, Provider policy and materialization remain in process.
            const prepared = await prepareExecutionRunProviderLaunch({ ...input,
                prepareManagedEndpoint: async () => ({ normalizedUrl: 'http://127.0.0.1:43129', downstreamBearer: 'pinned-consumer-token',
                    revalidateBeforeCommit: async () => ({ ok: true as const }), cleanup: async () => { endpointReleased = true; } }),
            });
            expect(prepared.providerBinding).toMatchObject({ connectionId: 'run-gateway', model: { id: 'example' } });
            expect(prepared.environment.RUN_PROVIDER_TOKEN).toBe('pinned-consumer-token');
            expect(prepared.sanitizeDiagnosticText('token pinned-consumer-token')).not.toContain('pinned-consumer-token');
            await expect(prepared.revalidateBeforeCommit()).resolves.toEqual({ ok: true });
            await prepared.cleanupOnExit?.();
            expect(endpointReleased).toBe(true);
            expect(fixture.lease.registry.agentRuntimesByAgentId.get(fixture.agentId)?.isCurrent()).toBe(true);
            expect(pluginReloadController.getState().activeRegistry).toBeNull();
        } finally { await fixture.cleanup(); }
    });

    it('keeps exact Agent and Account custody through the daemon adapter and retires prepared access after authority withdrawal', async () => {
        const fixture = await createManagedRunLaunchFixture({ physicalGateway: true });
        const resources = createProviderLaunchResourceScope();
        let current = true;
        let acquired = 0;
        let released = false;
        try {
            const backendTarget = { kind: 'backend' as const, backendId: fixture.agentId };
            const descriptor = await resolveRunnerAgentSessionDescriptorForLease({ target: backendTarget, lease: fixture.lease });
            const binding = fixture.lease.registry.agentRuntimesByAgentId.get(fixture.agentId)?.sessionRunnerFactoryBinding;
            if (!descriptor || !binding) throw new Error('Expected admitted executable Agent source');
            if (!fixture.snapshot.scopeKey) throw new Error('Expected Account snapshot scope');
            const services = createRunnerExecutionRunProviderLaunchServices({ agent: { descriptor, binding }, backendTarget, runtimeRegistryLease: fixture.lease,
                retainCleanup: resources.register,
                resolvePreparation: async () => ({ machineId: fixture.machineId, featureEnabled: true,
                    happyHomeDir: fixture.happyHomeDir, accountSettingsSnapshot: fixture.snapshot,
                    readCurrentnessRefusal: async () => current ? null : 'account_settings_lifetime_changed',
                    resolveManagedPurposeBindingIntent: fixture.gateway!.purposeBindingOwner.resolveBindingIntent,
                    prepareManagedEndpoint: async () => {
                        acquired += 1;
                        return { normalizedUrl: 'http://127.0.0.1:43129', downstreamBearer: 'private-consumer-token',
                            revalidateBeforeCommit: async () => ({ ok: true as const }), cleanup: async () => { released = true; } };
                    },
                }),
            });
            const request = { backendTarget, agentId: fixture.agentId, runId: 'pinned-context-run',
                selection: { agentTargetKey: fixture.agentTargetKey, providerConnectionId: ProviderConnectionIdSchema.parse('run-gateway'), modelId: 'example' },
                expectedAccountSettingsScopeKey: fixture.snapshot.scopeKey };
            await expect(services.prepareLaunch({ ...request, expectedAccountSettingsScopeKey: 'foreign-account' })).rejects.toMatchObject({ code: 'provider_authorization_changed' });
            await expect(services.prepareLaunch({ ...request, agentId: 'foreign-agent' })).rejects.toMatchObject({ code: 'provider_authorization_changed' });
            expect(acquired).toBe(0);
            const prepared = await services.prepareLaunch(request);
            const transported = AgentRuntimeDaemonServiceResponseV1Schema.parse({ ok: true,
                result: { kind: 'execution_run.provider.prepared', ...projectRunnerExecutionRunProviderLaunch(prepared) } });
            expect(transported).toMatchObject({ ok: true, result: { providerBinding: { connectionId: 'run-gateway', model: { id: 'example' } },
                additionalRedactionValues: expect.arrayContaining(['private-consumer-token']) } });
            current = false;
            await expect(prepared.revalidateBeforeCommit()).resolves.toMatchObject({ ok: false, error: { code: 'provider_authorization_changed' } });
            expect(released).toBe(true);
            expect(pluginReloadController.getState().activeRegistry).toBeNull();
        } finally { await resources.release(); await fixture.cleanup(); }
    });

    it('keeps an admitted Run across grant withdrawal and refuses the next admission', async () => {
        const fixture = await createManagedRunLaunchFixture({ physicalGateway: true });
        let current: ActiveAccountSettingsSnapshot = fixture.snapshot;
        let released = false;
        try {
            const input = { selection: { agentTargetKey: fixture.agentTargetKey,
                providerConnectionId: ProviderConnectionIdSchema.parse('run-gateway'), modelId: 'example' },
                backendTarget: { kind: 'backend' as const, backendId: fixture.agentId }, agentId: fixture.agentId,
                runId: 'revoked-grant-run', machineId: fixture.machineId, featureEnabled: true,
                happyHomeDir: fixture.happyHomeDir, accountSettingsSnapshot: fixture.snapshot,
                readAccountSettingsSnapshot: () => current, runtimeRegistryLease: fixture.lease,
                resolveManagedPurposeBindingIntent: fixture.gateway!.purposeBindingOwner.resolveBindingIntent,
                prepareManagedEndpoint: async () => ({ normalizedUrl: 'http://127.0.0.1:43129', downstreamBearer: 'revoked-consumer-token',
                    revalidateBeforeCommit: async () => ({ ok: true as const }), cleanup: async () => { released = true; } }),
            };
            const prepared = await prepareExecutionRunProviderLaunch(input);
            const catalog = splitProviderSettingsV1({ ...fixture.providerSettings, machineGrants: [] }).catalog;
            current = { ...current, settingsVersion: current.settingsVersion + 1,
                providerConnectionsCatalog: { status: 'ready', revision: 2, catalog } };
            await expect(prepared.revalidateBeforeCommit()).resolves.toMatchObject({ ok: true });
            expect(released).toBe(false);
            await expect(prepareExecutionRunProviderLaunch({ ...input, accountSettingsSnapshot: current }))
                .rejects.toMatchObject({ code: 'provider_not_enabled_on_machine' });
            await prepared.cleanupOnExit?.();
            expect(released).toBe(true);
            expect(pluginReloadController.getState().activeRegistry).toBeNull();
        } finally { await fixture.cleanup(); }
    });
});
