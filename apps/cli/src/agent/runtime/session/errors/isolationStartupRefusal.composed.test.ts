import { createServer } from 'node:http';
import { expect, it } from 'vitest';
import { PluginError } from '@happier-dev/plugin-sdk';
import type { MachineAgentIsolationStatusV1 } from '@happier-dev/protocol';
import { encodeRunnerDaemonPluginServiceWireValueV1 } from '../process/agentRuntimeDaemonPluginServicesProtocol';
import { AgentRuntimeDaemonServiceResponseV1Schema } from '../process/agentRuntimeDaemonServiceProtocol';
import { dispatchCurrentRunnerDaemonPluginService } from '../process/agentRuntimeDaemonServiceAuthorityClient';
import { createAgentRuntimeDaemonServiceAuthorityPath, publishAgentRuntimeDaemonServiceAuthority } from '@/daemon/agentRuntime/sessionBridgeAuthorization';
import { projectRunnerDaemonPluginServicesFailure } from '@/daemon/agentRuntime/runnerDaemonPluginServicesHost';
import { assertHostRequesterExecutionAdmissionForHost } from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';
import { readAgentIsolationSnapshot } from '@/daemon/agentIsolation/agentIsolationPolicy';
import { withTempDir } from '@/testkit/fs/tempDir';
import { createAgentSessionRunnerFactoryBinding } from '@/plugins/runtime/runner/agentSessionRunnerFactoryBinding';
import { classifyPrimarySessionRuntimeIssue, readSessionPreparationFailureDiagnostic } from './classifyPrimarySessionRuntimeIssue';

it('preserves the isolation admission refusal through runner transport and retained Session presentation without another admission', async () => {
  await withTempDir('isolation-startup-refusal-', async happyHomeDir => {
    let admissions = 0;
    let launches = 0;
    let enabled = true;
    let status: MachineAgentIsolationStatusV1 = { kind: 'applying', phase: 'runtime_replacement' };
    const daemon = createServer(async (request, response) => {
      for await (const _chunk of request) { /* Drain the real runner transport request. */ }
      try {
        admissions += 1;
        assertHostRequesterExecutionAdmissionForHost({
          identity: { kind: 'isolated', separationRequired: false,
            requester: { serverId: 'home', accountId: 'owner', machineId: 'machine', installationId: 'installation' } },
          snapshot: { ...readAgentIsolationSnapshot({
            metadata: { status: 'ready', metadataVersion: 1, metadata: { agentIsolation: { enabled } } },
            daemonState: { runtimeId: 'current', agentIsolation: status },
            runtimeId: 'current', platform: 'linux',
          }), workspaceRoots: [] },
          agentLaunchKind: 'terminal',
        });
        launches += 1;
        response.end(JSON.stringify(AgentRuntimeDaemonServiceResponseV1Schema.parse({ ok: true,
          result: { kind: 'plugin_services.result_v1', requestId: 'request-1',
            value: encodeRunnerDaemonPluginServiceWireValueV1('started') } })));
      } catch (error) {
        response.end(JSON.stringify(AgentRuntimeDaemonServiceResponseV1Schema.parse({ ok: false,
          error: projectRunnerDaemonPluginServicesFailure(error) })));
      }
    });
    await new Promise<void>(resolve => daemon.listen(0, '127.0.0.1', resolve));
    try {
      const address = daemon.address();
      if (!address || typeof address === 'string') throw new Error('Expected a loopback daemon');
      const authority = { happyHomeDir, publicReleaseRing: 'stable' as const, sessionId: 'session-1',
        retainedAgent: createAgentSessionRunnerFactoryBinding({ v: 1, pluginId: 'fixture.plugin', pluginVersion: '1.0.0',
          agentId: 'fixture.agent', localAgentId: 'agent',
          sourceCustody: { kind: 'managed', immutableGenerationId: 'generation-1', installSource: 'localPath' },
          locator: { module: './agent.js', export: 'createRuntime', runtimeApiVersion: 1 },
          normalizedModulePath: '/plugins/fixture/agent.js', loadMode: 'immutable-js' }),
        runner: { pid: 123, processStartTimeMs: 1, processCommandHash: '4'.repeat(64), snapshotIdentity: 'snapshot-1' },
        path: await createAgentRuntimeDaemonServiceAuthorityPath({ happyHomeDir, publicReleaseRing: 'stable' }) };
      await publishAgentRuntimeDaemonServiceAuthority({ ...authority, httpPort: address.port });
      let refusal: unknown;
      try {
        await dispatchCurrentRunnerDaemonPluginService({ authority,
          operation: { kind: 'plugin_services.prepare_v1', invocationId: 'invocation-1', requestId: 'request-1' } });
      } catch (error) { refusal = error; }
      expect(refusal).toBeInstanceOf(PluginError);
      expect(refusal).toMatchObject({ code: 'agent_isolation_unavailable' });
      const diagnostic = readSessionPreparationFailureDiagnostic(refusal);
      expect(diagnostic.originalCode).toBe('agent_isolation_unavailable');
      const issue = classifyPrimarySessionRuntimeIssue({ cause: 'session_error', error: refusal, occurredAt: 100 });
      expect(issue).toMatchObject({ code: 'agent_isolation_unavailable', source: 'dependency_failure',
        sanitizedPreview: expect.any(String) });
      expect(classifyPrimarySessionRuntimeIssue({ cause: 'session_error', occurredAt: 100,
        error: { code: issue.code, details: { v: 1, source: issue.source } } })).toEqual(issue);
      expect({ admissions, launches }).toEqual({ admissions: 1, launches: 0 });
      for (const ready of [true, false]) {
        enabled = ready;
        status = ready ? { kind: 'effective', platform: 'linux', agentUser: 'happier-agent' } : { kind: 'disabled' };
        await expect(dispatchCurrentRunnerDaemonPluginService({ authority,
          operation: { kind: 'plugin_services.prepare_v1', invocationId: 'invocation-1', requestId: 'request-1' } }))
          .resolves.toBe('started');
      }
      expect({ admissions, launches }).toEqual({ admissions: 3, launches: 2 });
    } finally {
      await new Promise<void>((resolve, reject) => daemon.close(error => error ? reject(error) : resolve()));
    }
  });
});
