import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { configuration, reloadConfiguration } from '@/configuration';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createAgentSessionRunnerFactoryBinding } from '@/plugins/runtime/runner/agentSessionRunnerFactoryBinding';
import { hashProcessCommand } from '@/daemon/sessionRegistry';
import { HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE_ENV_KEY,
  createAgentRuntimeDaemonServiceAuthorityPath, publishAgentRuntimeDaemonServiceAuthority } from '@/daemon/agentRuntime/sessionBridgeAuthorization';
import { AgentRuntimeDaemonServiceRequestV1Schema, AgentRuntimeDaemonServiceResponseV1Schema } from '@/agent/runtime/session/process/agentRuntimeDaemonServiceProtocol';
import { dispatchBridgeLifecycleHookEvent } from '@/plugins/runtime/hooks/execution/dispatchBridgeLifecycleHookEvent';
import type { startDaemonControlServer } from '@/daemon/controlServer';
import { startDaemonSessionControlRuntime } from './startDaemonSessionControlRuntime';
import { createDaemonSessionMutationCustody } from '../connectedServices/usageLimitRecovery/createDaemonUsageLimitRecoveryMutationCustody';

const boundary = vi.hoisted(() => ({ input: null as unknown, processIdentity: vi.fn() }));
// Only loopback HTTP and process identity are substituted; dispatch, admission,
// plugin activation and the physical observer module remain production owners.
vi.mock('@/daemon/controlServer', () => ({ startDaemonControlServer: async (input: unknown) => {
  boundary.input = input;
  return { port: 44123, stop: async () => {} };
} }));
vi.mock('@/daemon/processIdentity', async importOriginal => ({
  ...await importOriginal<typeof import('@/daemon/processIdentity')>(),
  readProcessIdentityByPid: boundary.processIdentity,
}));

const env = createEnvKeyScope(['HAPPIER_HOME_DIR', HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE_ENV_KEY]);
afterEach(() => { vi.unstubAllGlobals(); env.restore(); reloadConfiguration(); boundary.input = null; });

describe('runner lifecycle hooks through the daemon contribution owner', () => {
  it('dispatches current hooks over authenticated runner services and never falls back locally after transport loss', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-runner-lifecycle-hook-'));
    const marker = join(home, 'observed.json');
    env.patch({ HAPPIER_HOME_DIR: home });
    reloadConfiguration();
    const fixture = await createAuthoredAdmittedPluginRuntimeFixture({ happyHomeDir: home,
      plugins: [{ manifest: createPluginManifestV2Fixture({ id: 'acme.lifecycle', contributes: {
        hooks: [
          { id: 'run-start', on: 'executionRun.started', category: 'lifecycle', scope: 'session', executionKind: 'observe' },
          { id: 'message-send', on: 'session.message.send', category: 'lifecycle', scope: 'session', executionKind: 'observe' },
        ],
      } }), files: { 'daemon.mjs': `import { writeFile } from 'node:fs/promises';
        export function activate(api) { for (const id of ['run-start', 'message-send']) {
          api.hooks.register(id, async event => { await writeFile(${JSON.stringify(marker)}, JSON.stringify(event)); });
        } }` } }],
    });
    const retainedAgent = createAgentSessionRunnerFactoryBinding({ v: 1, pluginId: 'acme.agent', pluginVersion: '1.0.0',
      agentId: 'hook-agent', localAgentId: 'hook-agent', sourceCustody: {
        kind: 'managed', immutableGenerationId: `sha256:${'1'.repeat(64)}`, installSource: 'npm' },
      locator: { module: './runtime.mjs', export: 'createRuntime', runtimeApiVersion: 1 },
      normalizedModulePath: '/immutable/runtime.mjs', loadMode: 'immutable-js' });
    const command = `${process.execPath} /opt/happier/versions/hooks/package-dist/index.mjs hook-agent`;
    boundary.processIdentity.mockResolvedValue({ pid: process.pid, processStartTimeMs: 123, command });
    const sessionId = 'hook-session';
    expect(pluginReloadController.getState().activeRegistry).toBeNull();
    const credentials = { token: 'test-token', encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) } };
    const daemonSessionMutationCustody = createDaemonSessionMutationCustody({ credentials });
    const daemon = await startDaemonSessionControlRuntime({ machineId: 'hook-machine',
      serverId: configuration.activeServerId, serverBaseUrl: configuration.apiServerUrl,
      daemonSessionMutationCustody, pluginRuntimeController: fixture.controller, credentials, api: {} as never,
      connectedServicesMaterializationBaseDir: join(home, 'connected-services'),
      getConnectedServiceRefreshCoordinator: () => null, getConnectedServiceQuotasCoordinator: () => null,
      trackedSessionsByKey: new Map(), spawnAwaiterByKey: new Map(), spawnResultResolverByKey: new Map(), spawnWebhookTimeoutByKey: new Map(),
      getApiMachineForSessions: () => null, spawnResourceCleanupByKey: new Map(), sessionAttachCleanupByKey: new Map(),
      connectedServicesRestartRequestedSessions: new Set(), beforeShutdown: async () => {}, onHappySessionWebhook: async () => {},
      requestShutdown: () => {}, processEnv: {},
    });
    try {
      const path = await createAgentRuntimeDaemonServiceAuthorityPath({ happyHomeDir: home, publicReleaseRing: configuration.publicReleaseRing });
      const authority = await publishAgentRuntimeDaemonServiceAuthority({ happyHomeDir: home, publicReleaseRing: configuration.publicReleaseRing,
        path, sessionId, httpPort: daemon.controlPort, capability: 'A'.repeat(43), retainedAgent,
        runner: { pid: process.pid, processStartTimeMs: 123, processCommandHash: hashProcessCommand(command), snapshotIdentity: 'version:hooks' },
        readPluginHardRevocationRevision: async () => 0 });
      env.patch({ [HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE_ENV_KEY]: path });
      const input = boundary.input as Parameters<typeof startDaemonControlServer>[0];
      const requests: unknown[] = [];
      vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
        const request = AgentRuntimeDaemonServiceRequestV1Schema.parse(JSON.parse(String(init.body)));
        expect(new Headers(init.headers).get('x-happier-daemon-token')).toBe(authority.document.capability);
        requests.push(request);
        const result = await input.agentRuntimeDaemonServices!.dispatch(request, { sessionId, runner: authority.document.runner,
          retainedAgent, invocationContext: { cwd: home, environment: {}, providerBindingActive: false }, isCurrent: async () => true });
        return new Response(JSON.stringify(AgentRuntimeDaemonServiceResponseV1Schema.parse(result)), { status: 200 });
      });
      const event = { eventId: 'executionRun.started' as const, happySessionId: sessionId, payload: {
        runId: 'run-1', intent: 'review', runtimeTargetKeys: ['agent:hook-agent'], retentionPolicy: 'ephemeral' as const,
        runClass: 'bounded' as const, ioMode: 'request_response' as const,
      } };
      const result = await dispatchBridgeLifecycleHookEvent({ happyHomeDir: home, event }, { nowMs: () => 123 });
      expect(requests).toEqual([expect.objectContaining({ context: expect.objectContaining({ sessionId }),
        operation: expect.objectContaining({ kind: 'turn_contributions.resolve', request: expect.objectContaining({ kind: 'lifecycleHook' }) }) })]);
      expect(result).toMatchObject({ matchedHandlerCount: 1, outcomes: [{ status: 'fulfilled' }] });
      // The public activate(api) hook callback receives the validated payload.
      expect(JSON.parse(await readFile(marker, 'utf8'))).toMatchObject({ runId: 'run-1', timestampMs: 123 });
      expect(pluginReloadController.getState().activeRegistry).toBeNull();
      await dispatchBridgeLifecycleHookEvent({ happyHomeDir: home, event: {
        eventId: 'session.message.send', happySessionId: 'child-session',
        payload: { sessionId: 'child-session', text: 'hello child', source: 'user' },
      } });
      expect(requests.at(-1)).toMatchObject({ context: { sessionId }, operation: {
        request: { event: { happySessionId: 'child-session' } },
      } });
      expect(JSON.parse(await readFile(marker, 'utf8'))).toMatchObject({ sessionId: 'child-session', text: 'hello child' });
      let failedDispatches = 0;
      vi.stubGlobal('fetch', async () => { failedDispatches += 1; throw new TypeError('fetch failed'); });
      await expect(dispatchBridgeLifecycleHookEvent({ happyHomeDir: home, event })).rejects.toBeDefined();
      expect(failedDispatches).toBe(1);
    } finally { await daemon.stopControlServer(); await daemonSessionMutationCustody.close(); await fixture.dispose(); await rm(home, { recursive: true, force: true }); }
  }, 120_000);
});
