import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { definePlugin } from '@happier-dev/plugin-sdk';
import type { AgentSessionOpenRequest, AgentSessionRuntime, AgentSessionRuntimeEvent } from '@happier-dev/plugin-sdk/agents/runtime';
import { AccountSettingsSchema, ProviderBoundModelRefSchema, ProviderConnectionIdSchema,
    ProviderSettingsV1Schema, ProviderConnectionV1Schema, type PluginAgentContributionV2, setProviderExperimentalConfirmationV1, splitProviderSettingsV1 } from '@happier-dev/protocol';
import { normalizeCustomProviderTemplateV1 } from '@happier-dev/protocol/providers/connections/normalizeCustomTemplateV1';
import { mergeProviderCatalogV1 } from '@happier-dev/protocol/providers/catalog/merge';
import { composeProviderSettingsV1, DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1 } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { prepareProviderConnectionImportV1 } from '@happier-dev/protocol/providers/connections/providerConnectionsCatalogV1';
import { convertBackendTargetRefV2ToV1, readBackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import type { PluginDaemonModuleNamespace } from '@/plugins/runtime/types';
import { resolveProviderConnectionForMachine } from '@/providers/registry';
import { resolveProviderModelCompatibility } from '@/providers/catalog/compatibility';
import { readLeasedAgentProviderBindingAdapter } from '@/plugins/runtime/providerBindings/adapter';
import { createProviderLaunchResourceScope } from '@/providers/lifecycle/resourceScope';
import { resolveCliEngineRegistry } from '@/agent/runtime/registry/engineRegistry';
import { resolveRunnerAgentSessionDescriptorForLease } from '@/daemon/spawn/prepareAgentRuntimeSessionBridge';
import { createRunnerExecutionRunProviderLaunchServices, projectRunnerExecutionRunProviderLaunch } from '@/daemon/agentRuntime/runnerExecutionRunProviderLaunch';
import type { ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { AgentRuntimeDaemonServiceRequestV1Schema, AgentRuntimeDaemonServiceResponseV1Schema } from '@/agent/runtime/session/process/agentRuntimeDaemonServiceProtocol';
import { ExecutionRunHostBridge } from '../ExecutionRunHostBridge';
import { prepareExecutionRunProviderLaunch, type ExecutionRunProviderLaunchRequest } from './providerLaunch';
import { createExecutionRunRuntime } from './create';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { ProviderEnforcedPermissionHandler } from '@/agent/permissions/providerEnforced/handler';
import * as controlClient from '@/daemon/controlClient';
import * as persistence from '@/persistence';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';

async function createRecoveryFixture(publishCatalog = false) {
    const nativeRequests: AgentSessionOpenRequest[] = [];
    const open = async (request: AgentSessionOpenRequest): Promise<AgentSessionRuntime> => {
        nativeRequests.push(request);
        let emit: ((event: AgentSessionRuntimeEvent) => void) | undefined;
        let sequence = 0;
        return {
            watch(listener) {
                emit = listener;
                emit({ kind: 'provider-session-id', providerSessionId: 'custom-provider-thread',
                    sessionId: request.sessionId, sequence: ++sequence, emittedAtMs: sequence });
                return { dispose() { emit = undefined; } };
            },
            async send(input) {
                const turnId = input.delivery.turnId;
                emit?.({ kind: 'input-accepted', inputIds: input.inputIds, delivery: input.delivery,
                    sessionId: request.sessionId, sequence: ++sequence, emittedAtMs: sequence });
                emit?.({ kind: 'turn-start', turnId, startedBy: 'host',
                    sessionId: request.sessionId, sequence: ++sequence, emittedAtMs: sequence });
                if (request.kind === 'create' && !publishCatalog) {
                    emit?.({ kind: 'turn-failed', turnId, diagnostic: { code: 'fixture_provider_failed', severity: 'error' },
                        sessionId: request.sessionId, sequence: ++sequence, emittedAtMs: sequence });
                } else {
                    emit?.({ kind: 'message-delta', turnId, channel: 'assistant', text: 'Recovered with the selected Provider.',
                        sessionId: request.sessionId, sequence: ++sequence, emittedAtMs: sequence });
                    emit?.({ kind: 'turn-complete', turnId,
                        sessionId: request.sessionId, sequence: ++sequence, emittedAtMs: sequence });
                }
                return { status: 'admitted' };
            },
            async cancel(input) { return { status: 'requested', turnId: input.turnId }; },
            async dispose() { emit = undefined; },
        };
    };
    const support = { acceptsProtocols: ['openai-responses'], required: { streaming: true }, supportsReasoningEffort: true,
        credentialSupport: { supportsNoAuth: true, apiKeyTransports: [] },
        authIsolation: { suppressConnectedServiceIds: [], ownedEnvKeys: [] },
        materialization: 'spawnEnv', applyPolicy: 'restart_session', supportsFreeformModelIds: false } satisfies NonNullable<PluginAgentContributionV2['providerRequirements']>;
    const plugin = definePlugin({ id: 'test.provider-recovery', version: '0.0.0', displayName: 'Provider recovery boundary',
        entrypoints: { daemon: './daemon.mjs' }, agents: { agent: {
            declaration: { title: 'Boundary Agent', runtime: { kind: 'custom' }, primary: 'sessions',
                capabilities: { sessions: { open: ['create', 'resume'], delivery: ['newTurn'], cancel: true } },
                connectedAccounts: [{ purpose: 'primary', service: { pluginId: 'happier.agent.claude', localId: 'claude-subscription' }, credentialKinds: ['oauth', 'token'] }],
                providerRequirements: support },
            factory: () => ({ sessions: { open } }),
            sessionRunnerFactory: { module: './runtime.mjs', export: 'createRuntime', runtimeApiVersion: 1 },
        } } });
    // Only the native process boundary is substituted. Committed plugin admission,
    // Provider consent, materialization, runtime creation and Run recovery stay real.
    const fixture = await createAuthoredAdmittedPluginRuntimeFixture({ ...(publishCatalog ? { controller: pluginReloadController } : {}), plugins: [{ manifest: plugin.manifest, files: {
        'runtime.mjs': `let open; export function configure(value) { open = value; }
            export function createRuntime() { return { sessions: { open: request => open(request) } }; }`,
        'daemon.mjs': `import * as runtime from './runtime.mjs';
            export function activate(api) { api.agents.register('agent', runtime.createRuntime, {
                sessionRunnerFactory: { module: './runtime.mjs', export: 'createRuntime', runtimeApiVersion: 1 },
                providerBinding: { v: 1, adapterVersion: 1,
                    prepare() { return { v: 1, materialization: 'spawnEnv' }; },
                    materialize() { return { v: 1, kind: 'spawnEnv', env: [] }; } } }); }
            export function configure(open) { runtime.configure(open); return { activate }; }`,
    }, instantiateCommittedModule(module) {
        if (typeof module.configure !== 'function') throw new Error('Missing native boundary');
        return module.configure(open) as PluginDaemonModuleNamespace;
    } }] });
    onTestFinished(() => fixture.dispose());
    const agentId = `${plugin.manifest.id}/agent`;
    const agentTargetKey = `agent:${agentId}`;
    await fixture.registry.activateContributionsOnDemand([{ pluginId: plugin.manifest.id, family: 'agents', localId: 'agent' }]);
    const backendTarget = convertBackendTargetRefV2ToV1(readBackendTargetRefV2({ kind: 'backend', backendId: agentId }));
    const connectionId = ProviderConnectionIdSchema.parse('pc_recovery');
    const selection = ProviderBoundModelRefSchema.parse({ agentTargetKey, providerConnectionId: connectionId, modelId: 'gpt-5' });
    const imported = prepareProviderConnectionImportV1(DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, { connection: ProviderConnectionV1Schema.parse({
        v: 1, id: connectionId, source: { kind: 'custom', template: normalizeCustomProviderTemplateV1({
            name: 'Controlled Responses endpoint', protocol: 'openai-responses', baseUrl: 'http://127.0.0.1:43129/v1', catalog: 'manual',
        }) }, role: 'named', displayName: 'Recovery', displayNameMode: 'custom', revision: 1, createdAt: 1, updatedAt: 1,
    }), manualModels: [{ id: 'gpt-5', addedAt: 1, reasoningEffortLevels: ['low', 'high'] }] });
    if (imported.status !== 'prepared') throw new Error('Custom Provider import was refused');
    const initial = composeProviderSettingsV1(imported.catalog, {});
    const resolved = resolveProviderConnectionForMachine({ connectionId: 'pc_recovery', machineId: 'machine',
        providerSettings: initial, registry: fixture.registry.contributes, dnsEvidenceByEndpointUrl: new Map() });
    if (resolved.status !== 'resolved') throw new Error('Custom Provider did not resolve');
    const adapter = readLeasedAgentProviderBindingAdapter({ lease: fixture.lease, agentId });
    if (!adapter) throw new Error('Expected admitted Provider binding adapter');
    const model = mergeProviderCatalogV1({ staticModels: [], manualModels: initial.manualModelsByConnectionId[connectionId]!,
        probeState: { snapshot: null, staleProbeModels: [] } }).rows[0]!.descriptor;
    const compatibility = resolveProviderModelCompatibility({ record: resolved.record, providerSettings: initial,
        agentTargetKey, support: adapter.support, adapterVersion: adapter.adapter.adapterVersion, model });
    expect(compatibility.result.status).toBe('experimental');
    if (compatibility.result.status !== 'experimental') throw new Error('Expected experimental custom Provider');
    const settings = setProviderExperimentalConfirmationV1(ProviderSettingsV1Schema.parse({ ...initial, machineGrants: [{
        v: 1, connectionId: 'pc_recovery', machineId: 'machine', connectionSecurityFingerprint: resolved.record.connectionSecurityFingerprint,
        endpointSetFingerprint: resolved.record.endpointSetFingerprint, confirmedAt: 1,
    }] }), { connectionId, agentTargetKey,
        modelId: compatibility.result.confirmationScope.kind === 'model' ? model.id : null,
        compatibilityFingerprint: compatibility.compatibilityFingerprint, confirmedAt: 1 });
    const snapshot: ActiveAccountSettingsSnapshot = { source: 'cache', scopeKey: 'recovery-account',
        settings: AccountSettingsSchema.parse({}), settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [],
        providerConnectionsCatalog: { status: 'ready', revision: 1, catalog: splitProviderSettingsV1(settings).catalog } };
    const resources = createProviderLaunchResourceScope();
    const descriptor = await resolveRunnerAgentSessionDescriptorForLease({ target: readBackendTargetRefV2(backendTarget), lease: fixture.lease });
    const binding = fixture.registry.agentRuntimesByAgentId.get(agentId)?.sessionRunnerFactoryBinding;
    if (!descriptor || !binding) throw new Error('Expected committed executable Agent');
    const requests: ExecutionRunProviderLaunchRequest[] = [];
    const services = createRunnerExecutionRunProviderLaunchServices({ agent: { descriptor, binding }, backendTarget,
        runtimeRegistryLease: fixture.lease, retainCleanup: resources.register,
        resolvePreparation: async request => {
            AgentRuntimeDaemonServiceRequestV1Schema.parse({ v: 1, context: { token: 'A'.repeat(43), sessionId: 'parent' },
                operation: { kind: 'execution_run.provider.prepare_v1', ...request, backendTarget: readBackendTargetRefV2(request.backendTarget) } });
            requests.push(request);
            return { machineId: 'machine', featureEnabled: true, happyHomeDir: fixture.happyHomeDir,
                accountSettingsSnapshot: snapshot, readAccountSettingsSnapshot: () => snapshot, isCurrent: () => true };
        } });
    const providerLaunch = { ...services, prepareLaunch: async (...args: Parameters<typeof services.prepareLaunch>) => {
        const prepared = await services.prepareLaunch(...args);
        AgentRuntimeDaemonServiceResponseV1Schema.parse({ ok: true,
            result: { kind: 'execution_run.provider.prepared', ...projectRunnerExecutionRunProviderLaunch(prepared) } });
        return prepared;
    } };
    const engineRegistry = await resolveCliEngineRegistry({ runtimeRegistry: fixture.registry });
    const profileCatalog = await engineRegistry.resolveExecutionRunProfileCatalog({
        resolveAgentIdentity: () => ({ pluginId: plugin.manifest.id, localId: 'agent' }) });
    const session = createMutableApiSessionClientFixture({ sessionId: 'parent', metadata: createTestMetadata({ path: fixture.happyHomeDir }),
        overrides: { enqueueAgentMessageCommitted: async () => ({ persisted: true, delivered: true }),
            enqueueUserTextMessageCommitted: async () => ({ persisted: true, delivered: true }) } });
    const permissionHandler = new ProviderEnforcedPermissionHandler(session, { logPrefix: '[Provider recovery fixture]' });
    permissionHandler.setPermissionMode('read-only');
    let hasPinnedService = true;
    const bridge = new ExecutionRunHostBridge({ parentProvider: 'codex', cwd: fixture.happyHomeDir, happyHomeDir: fixture.happyHomeDir,
        machineId: 'machine', sendAcp: async () => {}, resolveProvidersFeatureEnabled: () => true,
        sessionInteractionHost: { session, machineId: 'machine', permissionHandler,
            prepareRunTeamCredentialProviderBinding: async () => null },
        resolveRunReportPolicy: async () => ({ preset: 'important' }),
        resolveAccountSettingsSnapshot: async () => snapshot,
        resolveExecutionRunProfileCatalog: async () => ({ engineRegistry, profileCatalog,
            ...(hasPinnedService ? { providerLaunch } : {}) }) });
    const input = { selection, backendTarget, agentId, runId: 'exact-recovery-run', machineId: 'machine',
        featureEnabled: true, happyHomeDir: fixture.happyHomeDir, accountSettingsSnapshot: snapshot };
    return { fixture, bridge, input, nativeRequests, requests, services, engineRegistry,
        removePinnedService() { hasPinnedService = false; },
        async cleanup() { await bridge.dispose(); await resources.release(); await fixture.dispose(); } };
}

describe('real custom Provider Run recovery', () => {
    it.each([false, true])('starts a native-model connected Run through the pinned daemon preparation (structured selection: %s)', async structured => {
        const test = await createRecoveryFixture(true);
        const bindings = { v: 2 as const, bindingsByServiceId: {
            'happier.agent.claude/claude-subscription': { source: 'connected' as const, selection: 'profile' as const, profileId: 'synthetic-profile' },
        } };
        const credentialRead = vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue({ token: 'synthetic-token', encryption: null });
        const sourceCustody = test.fixture.registry.readPluginSourceCustody?.('test.provider-recovery');
        if (!sourceCustody) throw new Error('Expected admitted source custody');
        const materialize = vi.spyOn(controlClient, 'requestExecutionRunConnectedServicesMaterialization').mockImplementation(async request => ({
            ok: true, result: { activationId: 'synthetic-activation', env: {}, connectedServicesBindings: bindings,
                registration: { v: 1, activationId: 'synthetic-activation', runKey: request.runId, agentId: test.input.agentId,
                    agentContribution: { pluginId: 'test.provider-recovery', localId: 'agent', sourceCustody },
                    materializationKey: request.runId, connectedServicesBindings: bindings, connectedServiceSelectionsEnv: {},
                    sessionDirectory: test.fixture.happyHomeDir, materializedRoot: test.fixture.happyHomeDir } },
        }));
        const release = vi.spyOn(controlClient, 'releaseExecutionRunConnectedServices').mockResolvedValue({ ok: true, released: true });
        try {
            const started = await test.bridge.start({ sessionId: 'parent', intent: 'agent', backendTarget: test.input.backendTarget,
                modelId: 'native-model', connectedServices: bindings, instructions: 'Use the selected subscription.',
                ...(structured ? { modelSelection: { ...test.input.selection, providerConnectionId: null, modelId: 'native-model' } } : {}),
                permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: 'bounded', ioMode: 'request_response' });
            await test.bridge.waitForTerminal(started.runId);
            expect(test.bridge.getPublic(started.runId)?.error?.code).not.toBe('PLUGIN_DAEMON_RUNTIME_UNAVAILABLE');
            expect(test.requests, JSON.stringify(test.bridge.getLatestToolResult(started.runId))).toContainEqual(expect.objectContaining({ runId: started.runId, connectedServices: bindings }));
            expect(materialize).toHaveBeenCalled();
            expect(test.bridge.getPublic(started.runId)).toMatchObject({ status: 'succeeded' });
            expect(test.nativeRequests).toHaveLength(1);
        } finally { await test.cleanup(); release.mockRestore(); materialize.mockRestore(); credentialRead.mockRestore(); }
    });
    it('admits an explicit-effort Run exactly once through real start before opening its Agent', async () => {
        const test = await createRecoveryFixture();
        try {
            const started = await test.bridge.start({ sessionId: 'parent', intent: 'agent', backendTarget: test.input.backendTarget,
                modelSelection: test.input.selection, instructions: 'Use the admitted Provider once.',
                sessionConfigOptionOverrides: { v: 1, updatedAt: 1, overrides: { reasoning_effort: { updatedAt: 1, value: 'high' } } },
                permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: 'bounded', ioMode: 'request_response' });
            await test.bridge.waitForTerminal(started.runId);
            expect(test.nativeRequests).toHaveLength(1);
            expect(test.requests.filter(request => request.runId === started.runId)).toHaveLength(1);
        } finally { await test.cleanup(); }
    });

    it.each([
        ['session_owned', 'execution_run_contribution_snapshot_unavailable'],
        ['detached', 'team_credential_provider_selection_not_current'],
    ] as const)('refuses a %s native Team Run without the pinned launch service before local preparation', async (scope, code) => {
        const test = await createRecoveryFixture();
        let snapshotReads = 0;
        let localPreparations = 0;
        const teamCredentialModel = { kind: 'team_credential_provider_model' as const,
            resourceId: 'resource-native', teamId: 'team-native', expectedResourceRevision: 1,
            agentTargetKey: test.input.selection.agentTargetKey, modelId: test.input.selection.modelId,
            deliveryMode: 'brokered' as const };
        // A future route reaches the existing launch owner without activating
        // it in the shared Protocol before every consumer has migrated.
        Reflect.set(teamCredentialModel, 'deliveryMode', 'vendor-native');
        const runtime = createExecutionRunRuntime({ ...test.input, scope,
            cwd: test.fixture.happyHomeDir, backendId: test.input.agentId, permissionMode: 'read_only',
            teamCredentialModel, engineRegistry: test.engineRegistry, connectedServices: null,
            resolveAccountSettingsSnapshot: async () => { snapshotReads++; return test.input.accountSettingsSnapshot; },
            prepareRunTeamCredentialProviderBinding: async () => {
                localPreparations++;
                throw new Error('Native Team preparation must stay pinned to its daemon service');
            } });
        try {
            await expect(runtime.readResumeSupport()).rejects.toMatchObject({ code });
            expect(snapshotReads).toBe(0);
            expect(localPreparations).toBe(0);
            expect(test.nativeRequests).toHaveLength(0);
        } finally { await runtime.dispose(); await test.cleanup(); }
    });

    it('refuses an explicit-effort Run without its pinned Session service before opening its Agent', async () => {
        const test = await createRecoveryFixture();
        test.removePinnedService();
        try {
            const started = await test.bridge.start({ sessionId: 'parent', intent: 'agent', backendTarget: test.input.backendTarget,
                modelSelection: test.input.selection, instructions: 'Do not launch without the Session service.',
                sessionConfigOptionOverrides: { v: 1, updatedAt: 1, overrides: { reasoning_effort: { updatedAt: 1, value: 'high' } } },
                permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: 'bounded', ioMode: 'request_response',
            });
            await test.bridge.waitForTerminal(started.runId);
            expect(test.bridge.getPublic(started.runId)).toMatchObject({ status: 'failed',
                error: { code: 'execution_run_contribution_snapshot_unavailable' } });
            expect(test.nativeRequests).toHaveLength(0);
            expect(test.requests).toHaveLength(0);
        } finally { await test.cleanup(); }
    });

    it('refuses missing Session Provider services as a typed snapshot failure without preparing a different local runtime', async () => {
        const test = await createRecoveryFixture();
        let snapshotReads = 0;
        const runtime = createExecutionRunRuntime({ ...test.input, scope: 'session_owned',
            cwd: test.fixture.happyHomeDir, backendId: test.input.agentId, permissionMode: 'read_only',
            modelSelection: test.input.selection, engineRegistry: test.engineRegistry, connectedServices: null,
            resolveProvidersFeatureEnabled: () => true,
            resolveAccountSettingsSnapshot: async () => { snapshotReads++; return test.input.accountSettingsSnapshot; } });
        try {
            await expect(runtime.readResumeSupport()).rejects.toMatchObject({ code: 'execution_run_contribution_snapshot_unavailable' });
            await expect(runtime.readResumeSupport()).rejects.toMatchObject({ code: 'execution_run_contribution_snapshot_unavailable' });
            expect(snapshotReads).toBe(0);
            expect(test.nativeRequests).toHaveLength(0);
            expect(test.requests).toHaveLength(0);
        } finally { await runtime.dispose(); await test.cleanup(); }
    });

    it('reproduces the missing-daemon-registry failure before confirmation, while the pinned Provider launch succeeds', async () => {
        const test = await createRecoveryFixture();
        try {
            await expect(prepareExecutionRunProviderLaunch(test.input)).rejects.toMatchObject({ code: 'PLUGIN_DAEMON_RUNTIME_UNAVAILABLE' });
            const prepared = await test.services.prepareLaunch({ selection: test.input.selection, backendTarget: test.input.backendTarget,
                agentId: test.input.agentId, runId: test.input.runId, expectedAccountSettingsScopeKey: 'recovery-account' });
            expect(prepared.providerBinding).toMatchObject({ connectionId: 'pc_recovery', model: { id: 'gpt-5' } });
            await prepared.cleanupOnExit?.();
        } finally { await test.cleanup(); }
    });

    it('recovers a failed attached Run with its exact experimental-confirmed custom Provider through the pinned service', async () => {
        const test = await createRecoveryFixture();
        try {
            const started = await test.bridge.start({ sessionId: 'parent', intent: 'agent', backendTarget: test.input.backendTarget,
                modelSelection: test.input.selection, instructions: 'Fail this first turn.', localInputId: 'first-input',
                permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: 'bounded', ioMode: 'request_response' });
            await test.bridge.waitForTerminal(started.runId);
            expect(test.bridge.getPublic(started.runId)).toMatchObject({ status: 'failed', lifecycle: { state: 'recoverable_with_input' } });
            const result = await test.bridge.send(started.runId, { message: 'Recover the same thread.', localInputId: 'recovery-input', resume: true });
            expect(result).toEqual({ ok: true });
            await test.bridge.waitForTerminal(started.runId);
            expect(test.bridge.getPublic(started.runId)).toMatchObject({ status: 'succeeded' });
            expect(test.nativeRequests.map(request => request.kind)).toEqual(['create', 'resume']);
            expect(test.nativeRequests.every(request => request.providerBinding?.connectionId === 'pc_recovery'
                && request.providerBinding.model.id === 'gpt-5')).toBe(true);
            expect(test.requests.filter(request => request.controllerOccurrenceId).map(request => request.runId))
                .toEqual([started.runId, started.runId]);
        } finally { await test.cleanup(); }
    });
});
