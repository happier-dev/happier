import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { FeaturesResponseSchema, accountSettingsParse } from '@happier-dev/protocol';
import type { startDaemonControlServer } from '@/daemon/controlServer';
import { createInstalledProjectAgentDaemonFixture } from '@/daemon/testkit/installedProjectAgentDaemonFixture';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { createAgentRuntimeDaemonServiceAuthorityPath, publishAgentRuntimeDaemonServiceAuthority } from '@/daemon/agentRuntime/sessionBridgeAuthorization';
import { AgentRuntimeDaemonServiceRequestV1Schema, AGENT_RUNTIME_DAEMON_SERVICES_PATH } from '@/agent/runtime/session/process/agentRuntimeDaemonServiceProtocol';
import { createRunnerAgentSessionRuntimeSource } from '@/agent/runtime/session/process/runnerAgentSessionRuntimeSource';
import { resolveBackendEngineAdapterResolution } from '../engineRegistry';
import { isHostSessionRuntimePlan } from '@/agent/runtime/session/loop/plan';
import { configuration } from '@/configuration';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { createProviderEnforcedPermissionHandler } from '@/agent/permissions/providerEnforced/createHandler';
import { createCurrentSessionPresentationHost } from '@/session/presentation/currentSessionPresentationService';
import { resolveCliFeatureDecision, type CliServerFeaturesSnapshot } from '@/features/featureDecisionService';
import { hashProcessCommand, writeSessionMarker } from '@/daemon/sessionRegistry';
import * as processIdentity from '@/daemon/processIdentity';
import * as daemonHttp from '@/daemon/controlHttp';
import { createNativeAgentFeatureService } from './nativeAgentSessionHostServiceOwners';

const boundary = vi.hoisted(() => ({ control: null as Parameters<typeof startDaemonControlServer>[0] | null }));
// Substitute only the other-process listener and HTTP transport. The daemon
// dispatcher, retained leaf, runner source, registry and feature owner are real.
vi.mock('@/daemon/controlServer', () => ({ startDaemonControlServer: async (input: Parameters<typeof startDaemonControlServer>[0]) => {
    boundary.control = input;
    return { port: 43129, stop: async () => {} };
} }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); boundary.control = null; });
afterAll(() => pluginReloadController.shutdown());

it.each([true, false, undefined])('advertises named Workflow tools only when the runner Session Home enables them (%s)', async enabled => {
    let runnerCommand = '';
    const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'owner',
        provenance: { v: 1, kind: 'terminal', authority: 'account_automation' } })).toString('base64url')}.signature`, encryption: null };
    const h = await createInstalledProjectAgentDaemonFixture(() => boundary.control, undefined, true, {
        manifest: createPluginManifestV2Fixture({ id: 'acme.project-launch', contributes: { agents: [{
            id: 'agent', title: 'Tool inventory native boundary', runtime: { kind: 'custom' }, primary: 'sessions',
            capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: false }, tools: { delivery: 'native_extension' } },
        }] } }),
        files: {
            'agent.mjs': `import { writeFile } from 'node:fs/promises'; import { join } from 'node:path';
export function factory() { return { sessions: { async open(request, context) {
 const inventory = async () => { const bridge = await context.session.services.happierTools.resolveNativeBridge({ systemPrompt: '' });
 await writeFile(join(request.cwd, 'inventory.json'), JSON.stringify(bridge.tools.map(tool => tool.name))); };
 await inventory(); return { send: async () => { await inventory(); return { status: 'admitted' }; },
 watch: () => ({ dispose() {} }), dispose: async () => {} }; } } }; }`,
            'daemon.mjs': `import { factory } from './agent.mjs'; export function activate(api) {
 api.agents.register('agent', factory, { sessionRunnerFactory: { module: './agent.mjs', export: 'factory', runtimeApiVersion: 1 } }); }`,
        },
    }, undefined, { credentials, externalActionAccountId: 'owner', ordinaryAccountSession: true,
        accountActionCredentials: credentials, runnerIdentity: directory => {
        runnerCommand = `${process.execPath} ${join(directory, '.runner-snapshots', 'features-runner', 'index.mjs')}`;
        return { pid: process.pid, processStartTimeMs: 1,
            processCommandHash: hashProcessCommand(runnerCommand), snapshotIdentity: 'snapshot:features-runner' };
    } });
    const readProcessIdentity = processIdentity.readProcessIdentityByPid;
    vi.spyOn(processIdentity, 'readProcessIdentityByPid').mockImplementation(async (pid, dependencies) => pid === h.runner.pid
        ? { pid, processStartTimeMs: 1, command: runnerCommand }
        : readProcessIdentity(pid, dependencies));
    const authorityFilePath = await createAgentRuntimeDaemonServiceAuthorityPath({ happyHomeDir: h.f.directory, publicReleaseRing: configuration.publicReleaseRing });
    await publishAgentRuntimeDaemonServiceAuthority({ happyHomeDir: h.f.directory, publicReleaseRing: configuration.publicReleaseRing,
        path: authorityFilePath, sessionId: h.sessionId, runner: h.runner, retainedAgent: h.retainedAgent, httpPort: 43129 });
    h.tracked.agentRuntimeDaemonServiceAuthorityFilePath = authorityFilePath;
    await writeSessionMarker({ trackingKey: h.tracked.trackingKey, pid: h.runner.pid, happySessionId: h.sessionId,
        startedBy: 'daemon', processStartTimeMs: h.runner.processStartTimeMs, processCommandHash: h.runner.processCommandHash,
        agentRuntimeDaemonServiceAuthorityFilePath: authorityFilePath });
    const readDaemonHttp = daemonHttp.readDaemonControlHttpResponse;
    const daemonResults: string[] = [];
    vi.spyOn(daemonHttp, 'readDaemonControlHttpResponse').mockImplementation(async input => {
        if (input.path !== AGENT_RUNTIME_DAEMON_SERVICES_PATH) return readDaemonHttp(input);
        const request = AgentRuntimeDaemonServiceRequestV1Schema.parse(input.body);
        const response = await h.dispatch(request.operation, request.context.executionRunSnapshotId);
        daemonResults.push(`${request.operation.kind}:${response.ok ? response.result.kind : response.error.code}`);
        return { ok: true, status: 200, body: JSON.stringify(response) };
    });
    const source = await createRunnerAgentSessionRuntimeSource({ happyHomeDir: h.f.directory, publicReleaseRing: configuration.publicReleaseRing,
        authorityFilePath, expectedSessionId: h.sessionId });
    if (!source) throw new Error('Missing admitted runner source');
    const resolution = await resolveBackendEngineAdapterResolution(source.identity.backendId, {
        happyHomeDir: h.f.directory, requireRunnerAgentSessionRuntimeSource: true, runnerAgentSessionRuntimeSource: source,
    });
    if (!resolution) throw new Error('Missing runner resolution');
    const plan = await resolution.engineAdapter.runtimeCore.createSessionRuntime({
        directory: h.cwd, happyHomeDir: h.f.directory, startedBy: 'daemon', credentials,
    });
    if (!isHostSessionRuntimePlan(plan) || !plan.config.createSessionRuntime) throw new Error('Missing runner plan');
    const snapshot: CliServerFeaturesSnapshot | undefined = enabled === undefined ? undefined : { status: 'ready',
        features: FeaturesResponseSchema.parse({ features: { workflows: { enabled } }, capabilities: {} }) };
    const session = createMutableApiSessionClientFixture({ sessionId: h.sessionId,
        metadata: createTestMetadata({ path: h.cwd }), overrides: { getServerFeaturesSnapshot: () => snapshot } });
    const open = () => plan.config.createSessionRuntime!({ directory: h.cwd, metadata: session.getMetadataSnapshot()!, machineId: 'machine',
        agentTargetKey: `backend:${source.identity.backendId}`, session, transcriptSession: session, messageBuffer: new MessageBuffer(),
        currentSessionPresentation: createCurrentSessionPresentationHost({ session, signal: h.signal }).bindCurrentSession,
        mcpServers: {}, permissionHandler: createProviderEnforcedPermissionHandler({ session, logPrefix: '[runner-features]' }),
        getPermissionMode: () => 'default', memoryRecallGuidanceEnabled: false, runnerProcessIdentity: null, startupModelSelection: null,
        accountSettings: accountSettingsParse({ actionsSettingsV1: { v: 1, actions: {
            'workflow.run.start': { enabled: true, toolExposureModes: { agent: 'direct' } },
        } } }),
        runWithTerminalModelSelection: async effect => ({ status: 'completed', value: await effect(null, async local => ({ status: 'completed', value: await local() })) }),
    }).catch(error => { throw new Error(`Runner fixture stages: ${daemonResults.join(', ')}`, { cause: error }); });
    const decision = resolveCliFeatureDecision({ featureId: 'workflows', serverSnapshot: snapshot });
    expect(decision.blockerCode).toBe(enabled === true ? 'none' : enabled === false ? 'feature_disabled' : 'probe_failed');
    const created = await open();
    try {
        const names: unknown = JSON.parse(await readFile(join(h.cwd, 'inventory.json'), 'utf8'));
        if (enabled) expect(names).toContain('workflow_run_start');
        else expect(names).not.toContain('workflow_run_start');
    } finally {
        await created.operations.resetOrDisposeRuntime('session_closed');
    }
}, 120_000);

it('reads a retained Session snapshot on demand and never borrows another Home when it is unavailable', () => {
    const enabled: CliServerFeaturesSnapshot = { status: 'ready', features: FeaturesResponseSchema.parse({
        features: { workflows: { enabled: true } }, capabilities: {},
    }) };
    let snapshot: CliServerFeaturesSnapshot | undefined = enabled;
    const features = createNativeAgentFeatureService(null, () => snapshot);
    expect(features.isEnabled('workflows')).toBe(true);
    snapshot = undefined;
    expect(features.isEnabled('workflows')).toBe(false);
    snapshot = enabled;
    expect(features.isEnabled('workflows')).toBe(true);
});
