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

// OS process inspection is the boundary; authority parsing/currentness and
// the actual Runner service transport remain real.
const processIdentity = vi.hoisted(() => vi.fn());
vi.mock('@/daemon/processIdentity', async importOriginal => ({
  ...await importOriginal<typeof import('@/daemon/processIdentity')>(),
  readProcessIdentityByPid: processIdentity,
}));
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); reloadConfiguration(); });

describe('Runner pinned Execution Run snapshot', () => {
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
