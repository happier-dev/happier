import { createServer } from 'node:http';
import { vi } from 'vitest';
import type { ActionExecuteResult } from '@happier-dev/protocol';
import type { RequesterAgentStartPolicyV1 } from '@/daemon/sessionEncryption/requesterAgentStartPolicy';
import type { TrackedSession } from '@/daemon/types';
import { configuration } from '@/configuration';
import * as processIdentity from '@/daemon/processIdentity';
import { hashProcessCommand } from '@/daemon/sessionRegistry';
import { hashPrivateBearer } from '@/daemon/privateBearerFile';
import { createAgentSessionRunnerFactoryBinding } from '@/plugins/runtime/runner/agentSessionRunnerFactoryBinding';
import {
  createAgentRuntimeDaemonServiceAuthorityPath,
  publishAgentRuntimeDaemonServiceAuthority,
  removeAgentRuntimeDaemonServiceAuthorityIfOwned,
} from '@/daemon/agentRuntime/sessionBridgeAuthorization';
import {
  AGENT_RUNTIME_DAEMON_SERVICES_PATH,
  AgentRuntimeDaemonServiceRequestV1Schema,
  AgentRuntimeDaemonServiceResponseV1Schema,
  type AgentRuntimeDaemonServiceRequestV1,
} from '@/agent/runtime/session/process/agentRuntimeDaemonServiceProtocol';

type ActionOperation = Extract<AgentRuntimeDaemonServiceRequestV1['operation'], { kind: 'action.execute' }>;

/** Real capability files, admission parsers and TCP; only OS identity/remote daemon effects are fixtures. */
export async function createSessionDaemonAuthorityFixture(input: Readonly<{
  sessionId: string;
  retainedAgent?: ReturnType<typeof createAgentSessionRunnerFactoryBinding>;
  execute(operation: ActionOperation): Promise<ActionExecuteResult>;
  /** Explicit policy at the remote daemon boundary; absent never means defaults. */
  agentStartPolicy?: RequesterAgentStartPolicyV1;
  dispatchService?: (request: AgentRuntimeDaemonServiceRequestV1) => Promise<unknown>;
}>) {
  const command = 'node /runtime/.runner-snapshots/mcp-authority/dist/index.mjs';
  const runner = { pid: process.pid, processStartTimeMs: 23_346,
    processCommandHash: hashProcessCommand(command), snapshotIdentity: 'snapshot:mcp-authority' };
  const identity = vi.spyOn(processIdentity, 'readProcessIdentityByPid').mockResolvedValue({
    pid: runner.pid, processStartTimeMs: runner.processStartTimeMs, command,
  });
  const capability = 'A'.repeat(43);
  const errors: unknown[] = [];
  const server = createServer(async (request, response) => {
    try {
      // Match the control router: local-service discovery may inspect unrelated
      // endpoints on this listener; only the daemon Action POST is registered.
      if (request.method !== 'POST' || request.url !== AGENT_RUNTIME_DAEMON_SERVICES_PATH) {
        response.writeHead(404).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const parsed = AgentRuntimeDaemonServiceRequestV1Schema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      if (parsed.context.sessionId !== input.sessionId || parsed.context.token !== capability) throw new Error('Invalid daemon Action authority');
      if (parsed.operation.kind !== 'action.execute') {
        if (!input.dispatchService && parsed.operation.kind !== 'agent_start.policy.read') {
          throw new Error(`Unexpected daemon service: ${parsed.operation.kind}`);
        }
        const policy = input.agentStartPolicy;
        const result = AgentRuntimeDaemonServiceResponseV1Schema.parse(input.dispatchService
          ? await input.dispatchService(parsed)
          : parsed.operation.kind === 'agent_start.policy.read' && policy
            ? { ok: true, result: { kind: 'agent_start.policy', policy: {
              workDepthLimit: policy.workDepthLimit, sessionAgentStartAllowListsV1: policy.sessionAgentStartAllowListsV1,
              sessionAgentSpawnPolicyV1: policy.sessionAgentSpawnPolicyV1,
            } } }
            : { ok: false, error: { code: 'requester_agent_start_policy_unavailable', message: 'Fixture policy unavailable' } });
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify(result));
        return;
      }
      const outcome = await input.execute(parsed.operation);
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ ok: true, result: { kind: 'action.execution', requestId: parsed.operation.requestId, outcome } }));
    } catch (error) {
      errors.push(error);
      response.writeHead(500).end();
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing daemon endpoint');
  const path = await createAgentRuntimeDaemonServiceAuthorityPath(configuration);
  const authority = { happyHomeDir: configuration.happyHomeDir, publicReleaseRing: configuration.publicReleaseRing,
    path, sessionId: input.sessionId, runner, retainedAgent: input.retainedAgent ?? createAgentSessionRunnerFactoryBinding({
      v: 1, pluginId: 'acme.plugin', pluginVersion: '1.2.3', agentId: 'acme-agent', localAgentId: 'acme-agent',
      sourceCustody: { kind: 'managed', immutableGenerationId: `sha256:${'1'.repeat(64)}`, installSource: 'localPath' },
      locator: { module: './runtime.mjs', export: 'createRuntime', runtimeApiVersion: 1 },
      normalizedModulePath: '/immutable/acme/runtime.mjs', loadMode: 'immutable-js',
    }) };
  const previousAuthorityPath = process.env.HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE;
  await publishAgentRuntimeDaemonServiceAuthority({ ...authority, httpPort: address.port, capability });
  process.env.HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE = path;
  return {
    /** The same daemon-owned record consumed by approval Session-currentness. */
    trackedSession: {
      startedBy: 'daemon', pid: runner.pid, happySessionId: input.sessionId,
      runnerProcessIdentity: { pid: runner.pid, processStartTimeMs: runner.processStartTimeMs,
        processCommandHash: runner.processCommandHash },
      agentRuntimeDaemonServiceAuthorityFilePath: path,
      agentRuntimeDaemonServiceCapabilityHash: hashPrivateBearer(capability),
      runnerAgentSourceCustodyV1: authority.retainedAgent.sourceCustody,
      runnerAgentInvocationContext: { cwd: '/fixture', environment: {}, providerBindingActive: false },
    } satisfies TrackedSession,
    async close() {
      if (previousAuthorityPath === undefined) delete process.env.HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE;
      else process.env.HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE = previousAuthorityPath;
      try {
        await removeAgentRuntimeDaemonServiceAuthorityIfOwned({ ...authority, capabilityDigest: hashPrivateBearer(capability) });
      } finally {
        identity.mockRestore();
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      }
      if (errors.length > 0) throw new AggregateError(errors, 'Daemon Action boundary failed', { cause: errors[0] });
    },
  };
}
