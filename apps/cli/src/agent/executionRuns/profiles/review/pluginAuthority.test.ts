import { once } from 'node:events';
import { createServer } from 'node:http';
import { rm } from 'node:fs/promises';
import { afterAll, afterEach, expect, it, vi } from 'vitest';

const home = vi.hoisted(() => {
  const directory = `${process.env.TMPDIR ?? '/tmp'}/happier-review-authority-${process.pid}-${Date.now()}`;
  process.env.HAPPIER_HOME_DIR = directory;
  return directory;
});
const osIdentity = vi.hoisted(() => vi.fn());
// Process identity is the OS boundary; authority publication and HTTP remain real.
vi.mock('@/daemon/processIdentity', async importOriginal => ({
  ...await importOriginal<typeof import('@/daemon/processIdentity')>(),
  readProcessIdentityByPid: osIdentity,
}));

import { configuration } from '@/configuration';
import { hashProcessCommand } from '@/daemon/sessionRegistry';
import { createAgentRuntimeDaemonServiceAuthorityFixture } from '@/agent/runtime/session/process/agentRuntimeDaemonServiceAuthority.testkit';
import { publishAgentRuntimeDaemonServiceAuthority, HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE_ENV_KEY } from '@/daemon/agentRuntime/sessionBridgeAuthorization';
import { AgentRuntimeDaemonServiceResponseV1Schema } from '@/agent/runtime/session/process/agentRuntimeDaemonServiceProtocol';
import { createRunnerReviewHostPluginAuthorityReader, readCurrentReviewHostPluginAuthority } from './pluginAuthority';

afterEach(() => vi.unstubAllEnvs());
afterAll(() => rm(home, { recursive: true, force: true }));

it('preserves the unavailable registry refusal instead of reporting absent plugin authority', async () => {
  await expect(readCurrentReviewHostPluginAuthority('acme.plugin')).rejects.toMatchObject({
    code: 'PLUGIN_DAEMON_RUNTIME_UNAVAILABLE',
  });
});

it('keeps the daemon refusal after a successful review authority read', async () => {
  const command = `${process.execPath} /fixture/.runner-snapshots/runner-a/index.mjs daemon start-sync`;
  const runner = { pid: process.pid, processStartTimeMs: 1_717_171_717_000,
    processCommandHash: hashProcessCommand(command), snapshotIdentity: 'snapshot:runner-a' };
  osIdentity.mockResolvedValue({ pid: runner.pid, processStartTimeMs: runner.processStartTimeMs, command });
  const authority = await createAgentRuntimeDaemonServiceAuthorityFixture({ happyHomeDir: configuration.happyHomeDir, runner });
  const expected = { sourceCustody: authority.retainedAgent.sourceCustody, caller: null };
  const refusal = { code: 'execution_run_host_action_stale', message: 'The review runner was replaced.',
    failureCause: { phase: 'review.authority.resolve', errorClass: 'Error', errorCode: 'execution_run_host_action_stale', httpStatus: null } };
  let refused = false;
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(AgentRuntimeDaemonServiceResponseV1Schema.parse(refused
      ? { ok: false, error: refusal }
      : { ok: true, result: { kind: 'execution_run.review_plugin_authority', authority: expected } })));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing HTTP port');
    await publishAgentRuntimeDaemonServiceAuthority({ ...authority, httpPort: address.port, capability: 'A'.repeat(43) });
    vi.stubEnv(HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE_ENV_KEY, authority.path);
    const read = createRunnerReviewHostPluginAuthorityReader(authority.sessionId);
    await expect(read('acme.plugin')).resolves.toEqual(expected);
    refused = true;
    await expect(read('acme.plugin')).rejects.toMatchObject({ code: refusal.code, message: refusal.message, failureCause: refusal.failureCause });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
