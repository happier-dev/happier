import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAgentRuntimeDaemonServiceAuthorityFixture as createTestAuthority } from './agentRuntimeDaemonServiceAuthority.testkit';
import { hashProcessCommand } from '@/daemon/sessionRegistry';
import { publishAgentRuntimeDaemonServiceAuthority } from '@/daemon/agentRuntime/sessionBridgeAuthorization';
import { resolveCurrentAgentRuntimeDaemonTurnContributions } from './agentRuntimeDaemonServiceAuthorityClient';
const roots: string[] = [];
const servers: Server[] = [];
const processIdentityMock = vi.hoisted(() => vi.fn());
const runnerIdentityMock = vi.hoisted(() => vi.fn());
// Only OS process identity is substituted; daemon HTTP uses a real loopback server.
vi.mock('@/daemon/processIdentity', () => ({ readProcessIdentityByPid: processIdentityMock }));
vi.mock('@/daemon/sessionRunnerRuntime/resolveRunnerEntrypointIdentity', () => ({
  resolveSessionRunnerEntrypointIdentityFromProcessCommand: runnerIdentityMock,
}));
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  })));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
describe('turn contribution daemon refusal', () => {
  it.each([
    { code: 'triage_account_storage_unavailable', retryable: true },
    { code: 'triage_account_storage_unavailable', retryable: undefined },
    { code: 'native_agent_privileged_effect_authority_unavailable', retryable: true },
    { code: 'github_credential_unavailable', retryable: false },
  ])('retains the $code contribution refusal and its code-only preparation cause', async ({ code, retryable }) => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-contribution-refusal-'));
    roots.push(happyHomeDir);
    const command = `${process.execPath} /fixture/.runner-snapshots/contribution-refusal/index.mjs daemon start-sync`;
    const runner = { pid: process.pid, processStartTimeMs: 1_717_171_717_000,
      processCommandHash: hashProcessCommand(command), snapshotIdentity: 'snapshot:contribution-refusal' };
    processIdentityMock.mockResolvedValue({ pid: runner.pid, processStartTimeMs: runner.processStartTimeMs, command });
    const { resolveSessionRunnerEntrypointIdentityFromProcessCommand } = await vi.importActual<
      typeof import('@/daemon/sessionRunnerRuntime/resolveRunnerEntrypointIdentity')
    >('@/daemon/sessionRunnerRuntime/resolveRunnerEntrypointIdentity');
    runnerIdentityMock.mockImplementation(resolveSessionRunnerEntrypointIdentityFromProcessCommand);
    const authority = await createTestAuthority({ happyHomeDir, runner });
    const received: unknown[] = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      received.push(JSON.parse(Buffer.concat(chunks).toString()));
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: false, error: {
        code, message: 'PRIVATE_REMOTE_CONTENT', retryable,
        cause: { code: 'plugin_account_data_unavailable', stage: 'invocation_context' },
      } }));
    });
    servers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture HTTP port');
    await publishAgentRuntimeDaemonServiceAuthority({ ...authority, httpPort: address.port, capability: 'A'.repeat(43) });
    const refusal = await resolveCurrentAgentRuntimeDaemonTurnContributions({ authority,
      requestId: 'contribution-refusal', timeoutMs: null,
      request: { kind: 'transformSessionInput', payload: { input: 'hello' } },
    }).catch((error: unknown) => error);
    expect(received).toMatchObject([{ operation: { kind: 'turn_contributions.resolve' } }]);
    const cause = { code: 'plugin_account_data_unavailable', stage: 'invocation_context', requestId: 'contribution-refusal' };
    expect(refusal).toMatchObject({ code, retryable: retryable ?? true,
      ...(code === 'native_agent_privileged_effect_authority_unavailable'
        ? { preparationCause: cause } : { details: { cause } }) });
    expect(JSON.stringify(refusal)).not.toContain('PRIVATE_REMOTE_CONTENT');
  });

});
