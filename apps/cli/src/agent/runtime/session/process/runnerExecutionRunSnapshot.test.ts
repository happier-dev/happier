import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PluginError } from '@happier-dev/plugin-sdk';

import { configuration, reloadConfiguration } from '@/configuration';
import { hashProcessCommand } from '@/daemon/sessionRegistry';
import { createAgentRuntimeDaemonServiceAuthorityPath, publishAgentRuntimeDaemonServiceAuthority,
  HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE_ENV_KEY } from '@/daemon/agentRuntime/sessionBridgeAuthorization';
import { createAgentSessionRunnerFactoryBinding } from '@/plugins/runtime/runner/agentSessionRunnerFactoryBinding';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { createRunnerExecutionRunSnapshotResolver } from './runnerExecutionRunSnapshot';
import { projectRunnerDaemonPluginServicesFailure } from '@/daemon/agentRuntime/runnerDaemonPluginServicesHost';
import { runAddedHostedSession } from '@/agent/runtime/lifecycle/hostedSessionScope';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createRunnerExecutionRunSnapshots } from '@/daemon/agentRuntime/runnerExecutionRunSnapshots';
import { resolveRunnerAgentSessionDescriptorForLease } from '@/daemon/spawn/prepareAgentRuntimeSessionBridge';
import { AgentRuntimeDaemonServiceRequestV1Schema } from './agentRuntimeDaemonServiceProtocol';
import { legacyPidSessionTrackingKey } from '@/daemon/sessions/sessionTrackingKey';

// OS process inspection is the boundary; authority parsing/currentness and
// the actual Runner service transport remain real.
const processIdentity = vi.hoisted(() => vi.fn());
vi.mock('@/daemon/processIdentity', async importOriginal => ({
  ...await importOriginal<typeof import('@/daemon/processIdentity')>(),
  readProcessIdentityByPid: processIdentity,
}));
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); reloadConfiguration(); });

describe('Runner pinned Execution Run snapshot', () => {
  it('resolves an attached Claude Review when its engine and selected runner are the same Agent', async () => {
    const runtime = await createAdmittedPluginRuntimeFixture({ runtimeOptions: {
      pluginIds: ['happier.agent.claude', 'happier.agent.codex'],
    } });
    const snapshots = createRunnerExecutionRunSnapshots({ machineId: 'machine-1', controller: runtime.controller });
    const sessionId = 'session-1';
    const backendTarget = { kind: 'backend' as const, backendId: 'claude' };
    const descriptor = await resolveRunnerAgentSessionDescriptorForLease({ target: backendTarget, lease: runtime.lease });
    const retainedAgent = descriptor && runtime.registry.agentRuntimesByAgentId.get(descriptor.agentId)?.sessionRunnerFactoryBinding;
    if (!retainedAgent) throw new Error('Missing admitted Claude Session runner');
    const command = `${process.execPath} ${process.cwd()}/src/index.ts`;
    const runner = { pid: process.pid, processStartTimeMs: 1_717_171_717_000,
      processCommandHash: hashProcessCommand(command), snapshotIdentity: `path:${process.cwd()}` };
    processIdentity.mockResolvedValue({ pid: runner.pid, processStartTimeMs: runner.processStartTimeMs, command });
    const server = createServer(async (request, response) => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const result = await snapshots.dispatch(AgentRuntimeDaemonServiceRequestV1Schema.parse(
          JSON.parse(Buffer.concat(chunks).toString())), {
          sessionId, runner, retainedAgent,
          invocationContext: { cwd: runtime.happyHomeDir, environment: {}, providerBindingActive: false },
          trackedSession: { trackingKey: legacyPidSessionTrackingKey(process.pid), pid: process.pid,
            startedBy: 'daemon', happySessionId: sessionId },
          isCurrent: async () => true,
        });
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(result));
      } catch (error) {
        response.writeHead(500);
        response.end(String(error));
      }
    });
    try {
      vi.stubEnv('HAPPIER_HOME_DIR', runtime.happyHomeDir);
      reloadConfiguration();
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing loopback address');
      const publicReleaseRing = configuration.publicReleaseRing;
      const path = await createAgentRuntimeDaemonServiceAuthorityPath({ happyHomeDir: runtime.happyHomeDir, publicReleaseRing });
      await publishAgentRuntimeDaemonServiceAuthority({ path, happyHomeDir: runtime.happyHomeDir, publicReleaseRing,
        sessionId, runner, retainedAgent, httpPort: address.port, capability: 'A'.repeat(43) });
      vi.stubEnv(HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE_ENV_KEY, path);
      const resolve = createRunnerExecutionRunSnapshotResolver({ sessionId });
      // The mixed-Agent control uses the same transport, authority and registry.
      for (const localId of ['codex', 'claude']) {
        const resolution = await resolve(backendTarget, {
          kind: 'agent', identity: { pluginId: `happier.agent.${localId}`, localId },
        });
        expect(resolution.engineRegistry?.contributions.agents).toHaveLength(localId === 'claude' ? 1 : 2);
        await resolution.release?.();
      }
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await snapshots.dispose();
      await runtime.dispose();
    }
  });
  it.each([
    { title: 'Team refusal', refusal: { code: 'team_credential_provider_selection_not_current', message: 'PRIVATE_REFUSAL' } },
    { title: 'unexpected exception', refusal: projectRunnerDaemonPluginServicesFailure(new TypeError('PRIVATE_REFUSAL')) },
    { title: 'typed source failure', refusal: projectRunnerDaemonPluginServicesFailure(new PluginError({
        code: 'managed_source_refused', message: 'PRIVATE_REFUSAL',
        details: { cause: { code: 'ENOENT', stage: 'registry_acquisition' } },
      })) },
    { title: 'hosted Session typed source failure', hosted: true, refusal: projectRunnerDaemonPluginServicesFailure(new PluginError({
        code: 'managed_source_refused', message: 'PRIVATE_REFUSAL',
        details: { cause: { code: 'ENOENT', stage: 'registry_acquisition' } },
      })) },
  ])('retains a $title across the pinned service transport without private error text', async ({ refusal, ...testCase }) => {
    const happyHomeDir = await createTempDir('happier-run-native-refusal-', tmpdir());
    const command = `${process.execPath} /fixture/.runner-snapshots/runner-a/index.mjs daemon start-sync`;
    const runner = { pid: process.pid, processStartTimeMs: 1_717_171_717_000,
      processCommandHash: hashProcessCommand(command), snapshotIdentity: 'snapshot:runner-a' };
    processIdentity.mockResolvedValue({ pid: runner.pid, processStartTimeMs: runner.processStartTimeMs, command });
    vi.stubEnv('HAPPIER_HOME_DIR', happyHomeDir);
    reloadConfiguration();
    const server = createServer((request, response) => {
      request.resume();
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: false, error: refusal }));
    });
    try {
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing loopback address');
      const publicReleaseRing = configuration.publicReleaseRing;
      const path = await createAgentRuntimeDaemonServiceAuthorityPath({ happyHomeDir, publicReleaseRing });
      const retainedAgent = createAgentSessionRunnerFactoryBinding({ v: 1, pluginId: 'acme.plugin', pluginVersion: '1.2.3',
        agentId: 'acme-agent', localAgentId: 'acme-agent', sourceCustody: { kind: 'managed',
          immutableGenerationId: `sha256:${'1'.repeat(64)}`, installSource: 'localPath' },
        locator: { module: './runtime.mjs', export: 'createRuntime', runtimeApiVersion: 1 },
        normalizedModulePath: '/immutable/acme/runtime.mjs', loadMode: 'immutable-js' });
      await publishAgentRuntimeDaemonServiceAuthority({ path, happyHomeDir, publicReleaseRing, runner, retainedAgent,
        sessionId: 'session-1', httpPort: address.port, capability: 'A'.repeat(43) });
      const read = () => createRunnerExecutionRunSnapshotResolver({ sessionId: 'session-1' })(undefined);
      const hosted = 'hosted' in testCase;
      vi.stubEnv(HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE_ENV_KEY, hosted ? undefined : path);
      const failure = await Promise.resolve(hosted ? runAddedHostedSession({
        environment: { ...process.env, [HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE_ENV_KEY]: path },
        workingDirectory: happyHomeDir, end: () => undefined,
      }, read) : read()).catch((error: unknown) => error);
      expect(failure).toMatchObject({ code: refusal.code });
      if ('cause' in refusal && refusal.cause) {
        expect(failure).toMatchObject({ cause: refusal.cause, details: { cause: refusal.cause } });
      }
      expect(String(failure)).not.toContain('PRIVATE_REFUSAL');
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await removeTempDir(happyHomeDir);
    }
  });
});
