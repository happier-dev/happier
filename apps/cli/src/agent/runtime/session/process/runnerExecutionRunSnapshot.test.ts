import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { configuration, reloadConfiguration } from '@/configuration';
import { hashProcessCommand } from '@/daemon/sessionRegistry';
import { createAgentRuntimeDaemonServiceAuthorityPath, publishAgentRuntimeDaemonServiceAuthority,
  HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE_ENV_KEY } from '@/daemon/agentRuntime/sessionBridgeAuthorization';
import { createAgentSessionRunnerFactoryBinding } from '@/plugins/runtime/runner/agentSessionRunnerFactoryBinding';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { createRunnerExecutionRunSnapshotResolver } from './runnerExecutionRunSnapshot';

// OS process inspection is the boundary; authority parsing/currentness and
// the actual Runner service transport remain real.
const processIdentity = vi.hoisted(() => vi.fn());
vi.mock('@/daemon/processIdentity', () => ({ readProcessIdentityByPid: processIdentity }));
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); reloadConfiguration(); });

describe('Runner pinned Execution Run snapshot', () => {
  it('retains a typed Team refusal across the pinned service transport without private error text', async () => {
    const happyHomeDir = await createTempDir('happier-run-native-refusal-', tmpdir());
    const command = `${process.execPath} /fixture/.runner-snapshots/runner-a/index.mjs daemon start-sync`;
    const runner = { pid: process.pid, processStartTimeMs: 1_717_171_717_000,
      processCommandHash: hashProcessCommand(command), snapshotIdentity: 'snapshot:runner-a' };
    processIdentity.mockResolvedValue({ pid: runner.pid, processStartTimeMs: runner.processStartTimeMs, command });
    vi.stubEnv('HAPPIER_HOME_DIR', happyHomeDir);
    reloadConfiguration();
    try {
      const publicReleaseRing = configuration.publicReleaseRing;
      const path = await createAgentRuntimeDaemonServiceAuthorityPath({ happyHomeDir, publicReleaseRing });
      const retainedAgent = createAgentSessionRunnerFactoryBinding({ v: 1, pluginId: 'acme.plugin', pluginVersion: '1.2.3',
        agentId: 'acme-agent', localAgentId: 'acme-agent', sourceCustody: { kind: 'managed',
          immutableGenerationId: `sha256:${'1'.repeat(64)}`, installSource: 'localPath' },
        locator: { module: './runtime.mjs', export: 'createRuntime', runtimeApiVersion: 1 },
        normalizedModulePath: '/immutable/acme/runtime.mjs', loadMode: 'immutable-js' });
      await publishAgentRuntimeDaemonServiceAuthority({ path, happyHomeDir, publicReleaseRing, runner, retainedAgent,
        sessionId: 'session-1', httpPort: 31_001, capability: 'A'.repeat(43) });
      vi.stubEnv(HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE_ENV_KEY, path);
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: false,
        error: { code: 'team_credential_provider_selection_not_current', message: 'PRIVATE_REFUSAL' },
      }), { status: 200, headers: { 'content-type': 'application/json' } })));
      const failure = await Promise.resolve(createRunnerExecutionRunSnapshotResolver({ sessionId: 'session-1' })(undefined)).catch((error: unknown) => error);
      expect(fetch).toHaveBeenCalled();
      expect(failure).toMatchObject({ code: 'team_credential_provider_selection_not_current' });
      expect(String(failure)).not.toContain('PRIVATE_REFUSAL');
    } finally { await removeTempDir(happyHomeDir); }
  });
});
