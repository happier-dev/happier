import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAgentRuntimeDaemonServiceAuthorityFixture as createTestAuthority } from './agentRuntimeDaemonServiceAuthority.testkit';
import { hashProcessCommand } from '@/daemon/sessionRegistry';
import { publishAgentRuntimeDaemonServiceAuthority } from '@/daemon/agentRuntime/sessionBridgeAuthorization';
import { openCurrentRunnerTeamCredentialProviderBinding } from './agentRuntimeDaemonServiceAuthorityClient';

const roots: string[] = [];
const servers: Server[] = [];
const processIdentityMock = vi.hoisted(() => vi.fn());
const runnerIdentityMock = vi.hoisted(() => vi.fn());
// Only OS process identity is substituted; daemon HTTP uses a real loopback server.
vi.mock('@/daemon/processIdentity', () => ({
  readProcessIdentityByPid: processIdentityMock,
}));
vi.mock(
  '@/daemon/sessionRunnerRuntime/resolveRunnerEntrypointIdentity',
  () => ({
    resolveSessionRunnerEntrypointIdentityFromProcessCommand:
      runnerIdentityMock,
  }),
);
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeAllConnections();
        }),
    ),
  );
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('daemon service refusal cause', () => {
  it.each(['unparsed 500', 'typed daemon result', 'connect refused'] as const)(
    'keeps the failed daemon boundary in an authority-unavailable cause (%s)',
    async (scenario) => {
      const happyHomeDir = await mkdtemp(
        join(tmpdir(), 'happier-daemon-boundary-cause-'),
      );
      roots.push(happyHomeDir);
      const command = `${process.execPath} /fixture/.runner-snapshots/boundary-cause/index.mjs daemon start-sync`;
      const runner = {
        pid: process.pid,
        processStartTimeMs: 1_717_171_717_000,
        processCommandHash: hashProcessCommand(command),
        snapshotIdentity: 'snapshot:boundary-cause',
      };
      processIdentityMock.mockResolvedValue({
        pid: runner.pid,
        processStartTimeMs: runner.processStartTimeMs,
        command,
      });
      const { resolveSessionRunnerEntrypointIdentityFromProcessCommand } =
        await vi.importActual<
          typeof import('@/daemon/sessionRunnerRuntime/resolveRunnerEntrypointIdentity')
        >('@/daemon/sessionRunnerRuntime/resolveRunnerEntrypointIdentity');
      runnerIdentityMock.mockImplementation(
        resolveSessionRunnerEntrypointIdentityFromProcessCommand,
      );
      const authority = await createTestAuthority({ happyHomeDir, runner });
      // The daemon control route is the HTTP boundary; the runner client is real.
      const server = createServer((_request, response) => {
        response.setHeader('content-type', 'application/json');
        if (scenario === 'unparsed 500') {
          response.statusCode = 500;
          response.end(
            JSON.stringify({
              statusCode: 500,
              error: 'Internal Server Error',
              message: 'private-response-body',
            }),
          );
        } else
          response.end(
            JSON.stringify({
              ok: false,
              error: {
                code: 'agent_runtime_daemon_service_generation_not_current',
                message: 'private-response-body',
              },
            }),
          );
      });
      servers.push(server);
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new Error('Missing fixture HTTP port');
      await publishAgentRuntimeDaemonServiceAuthority({
        ...authority,
        httpPort: address.port,
        capability: 'A'.repeat(43),
      });
      // A departed daemon leaves its published port refusing connections.
      if (scenario === 'connect refused') {
        servers.splice(servers.indexOf(server), 1);
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      const expected =
        scenario === 'unparsed 500'
          ? {
              phase: 'agent_runtime.daemon_response',
              errorClass: 'HttpStatusError',
              errorCode: null,
              httpStatus: 500,
            }
          : scenario === 'typed daemon result'
            ? {
                phase: 'agent_runtime.daemon_result',
                errorCode:
                  'agent_runtime_daemon_service_generation_not_current',
              }
            : {
                phase: 'agent_runtime.daemon_connect',
                errorClass: 'TypeError',
                errorCode: 'ECONNREFUSED',
              };
      const error = await openCurrentRunnerTeamCredentialProviderBinding({
        authority,
        operation: {
          kind: 'provider_broker.binding.open',
          resourceId: 'resource-1',
          expectedResourceRevision: 3,
          agentTargetKey: 'agent:acme.plugin/acme-agent',
          modelId: 'model',
        },
      }).then(
        () => null,
        (failure: unknown) => failure,
      );
      expect(error).toMatchObject({
        code: 'native_agent_privileged_effect_authority_unavailable',
        failureCause: { phase: 'turn_start', actionCause: expected },
      });
      expect(JSON.stringify(error)).not.toContain('private-response-body');
    },
  );
});
