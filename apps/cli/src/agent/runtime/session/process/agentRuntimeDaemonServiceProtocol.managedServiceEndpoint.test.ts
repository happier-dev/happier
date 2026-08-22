import { describe, expect, it } from 'vitest';

import { createManagedServiceEndpointProjectionV1 } from '@/plugins/runtime/invocation/services/managedServiceEndpointProjection';

import {
  AgentRuntimeDaemonServiceRequestV1Schema,
  AgentRuntimeDaemonServiceResponseV1Schema,
} from './agentRuntimeDaemonServiceProtocol';

const projectionToken = 'b'.repeat(64);
const witness = {
  turnId: 'turn-1',
  inputId: 'input-1',
  userMessageSeq: 1,
  userMessageSeqs: [1],
};

function projection() {
  return {
    sessionId: 'session-1',
    pluginId: 'opencode',
    contributionId: 'opencode',
    serverId: 'opencode',
    instanceId: 'instance-1',
    immutableGenerationId: 'immutable-generation-1',
    custodyOwner: 'sessionRunner' as const,
    mode: 'managedSpawn' as const,
    endpoint: {
      baseUrl: 'http://127.0.0.1:3210',
      host: '127.0.0.1' as const,
      port: 3210,
    },
    process: {
      pid: 4321,
      startIdentity: 'process-start-1',
    },
    createdAtMs: 1,
  };
}

function request(operation: unknown) {
  return {
    v: 1,
    context: {
      token: 'A'.repeat(43),
      sessionId: 'session-1',
    },
    operation,
  };
}

describe('Agent runtime daemon managed-server endpoint service protocol', () => {
  it('admits strict direct-custody publish and release operations', () => {
    expect(AgentRuntimeDaemonServiceRequestV1Schema.safeParse(request({
      kind: 'managed_server.supervision.authorize',
      requestId: 'authorize-1',
      contributionId: 'opencode/agents/opencode',
      serverId: 'opencode-server',
      executable: {
        kind: 'systemTool',
        id: 'opencode-cli',
      },
      environmentKeys: ['OPENCODE_SERVER_PASSWORD'],
    })).success).toBe(true);
    expect(AgentRuntimeDaemonServiceRequestV1Schema.safeParse(request({
      kind: 'managed_server.endpoint.publish',
      requestId: 'publish-1',
      projection: projection(),
    })).success).toBe(true);
    expect(AgentRuntimeDaemonServiceRequestV1Schema.safeParse(request({
      kind: 'managed_server.endpoint.release',
      requestId: 'release-1',
      pluginId: 'opencode',
      instanceId: 'instance-1',
      projectionToken,
    })).success).toBe(true);
    expect(AgentRuntimeDaemonServiceRequestV1Schema.safeParse(request({
      kind: 'managed_server.endpoint.read.claim',
      requestId: '00000000-0000-4000-8000-000000000001',
      projectionToken,
    })).success).toBe(true);

    expect(AgentRuntimeDaemonServiceRequestV1Schema.safeParse(request({
      kind: 'managed_server.endpoint.publish',
      requestId: 'publish-1',
      projection: {
        ...projection(),
        custodyOwner: 'daemon',
      },
    })).success).toBe(false);
    for (const forbiddenProjectionFact of [
      { headers: { authorization: 'Basic raw-secret' } },
      { serverFingerprint: 'f'.repeat(64) },
    ]) {
      expect(AgentRuntimeDaemonServiceRequestV1Schema.safeParse(request({
        kind: 'managed_server.endpoint.publish',
        requestId: 'publish-secret-fact',
        projection: {
          ...projection(),
          ...forbiddenProjectionFact,
        },
      })).success).toBe(false);
    }
    expect(AgentRuntimeDaemonServiceRequestV1Schema.safeParse(request({
      kind: 'managed_server.endpoint.release',
      requestId: 'release-1',
      pluginId: 'opencode',
      instanceId: 'instance-1',
      projectionToken,
      unexpected: true,
    })).success).toBe(false);
    expect(AgentRuntimeDaemonServiceRequestV1Schema.safeParse(request({
      kind: 'managed_server.endpoint.read.claim',
      requestId: '00000000-0000-4000-8000-000000000001',
      projectionToken,
      authorization: 'Basic raw-secret',
    })).success).toBe(false);
  });

  it('requires an exact admitted-turn witness before resolving credential material', () => {
    const resolve = {
      kind: 'managed_server.endpoint.resolve',
      requestId: 'resolve-1',
      witness,
      selector: {
        kind: 'projectionToken',
        projectionToken,
      },
    };
    expect(AgentRuntimeDaemonServiceRequestV1Schema.safeParse(
      request(resolve),
    ).success).toBe(true);
    const { witness: _witness, ...withoutWitness } = resolve;
    expect(AgentRuntimeDaemonServiceRequestV1Schema.safeParse(
      request(withoutWitness),
    ).success).toBe(false);
  });

  it('admits only strict endpoint service results', () => {
    expect(AgentRuntimeDaemonServiceResponseV1Schema.safeParse({
      ok: true,
      result: {
        kind: 'managed_server.supervision',
        status: 'authorized',
        launch: {
          kind: 'daemonResolved',
          value: {
            command: '/managed/opencode',
            args: [],
            env: { PATH: '' },
          },
        },
      },
    }).success).toBe(true);
    expect(AgentRuntimeDaemonServiceResponseV1Schema.safeParse({
      ok: true,
      result: {
        kind: 'managed_server.supervision',
        status: 'authorized',
        launch: { kind: 'runnerPackagedRuntime' },
      },
    }).success).toBe(true);
    expect(AgentRuntimeDaemonServiceResponseV1Schema.safeParse({
      ok: true,
      result: {
        kind: 'managed_server.supervision',
        status: 'authorized',
        launch: {
          command: '/managed/opencode',
          args: [],
          env: { PATH: '' },
        },
      },
    }).success).toBe(false);
    expect(AgentRuntimeDaemonServiceResponseV1Schema.safeParse({
      ok: true,
      result: {
        kind: 'managed_server.endpoint.read',
        status: 'claimed',
        requestId: '00000000-0000-4000-8000-000000000001',
      },
    }).success).toBe(true);
    expect(AgentRuntimeDaemonServiceResponseV1Schema.safeParse({
      ok: true,
      result: {
        kind: 'managed_server.endpoint.read',
        status: 'claimed',
        requestId: '00000000-0000-4000-8000-000000000001',
        authorization: 'Basic raw-secret',
      },
    }).success).toBe(false);
    expect(AgentRuntimeDaemonServiceResponseV1Schema.safeParse({
      ok: true,
      result: {
        kind: 'managed_server.endpoint',
        status: 'resolved',
        projection: createManagedServiceEndpointProjectionV1(projection()),
      },
    }).success).toBe(true);
    expect(AgentRuntimeDaemonServiceResponseV1Schema.safeParse({
      ok: true,
      result: {
        kind: 'managed_server.endpoint',
        status: 'unavailable',
      },
    }).success).toBe(true);
    expect(AgentRuntimeDaemonServiceResponseV1Schema.safeParse({
      ok: true,
      result: {
        kind: 'managed_server.endpoint',
        status: 'resolved',
        projection: {
          ...createManagedServiceEndpointProjectionV1(projection()),
          unexpected: true,
        },
      },
    }).success).toBe(false);
  });
});
