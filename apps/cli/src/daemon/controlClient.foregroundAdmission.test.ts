import http from 'node:http';
import { SessionModelSelectionSchema } from '@happier-dev/protocol/providers/selection/v2';

import { afterEach, describe, expect, it } from 'vitest';

import { reloadConfiguration } from '@/configuration';
import {
  admitDaemonForegroundAgentRuntime,
} from '@/daemon/controlClient';
import {
  AgentCliSessionCommandBuildInputV1Schema,
  AgentCliSessionCommandOptionsV1Schema,
  ForegroundAgentRuntimeAdmissionRequestV1Schema,
  ForegroundAgentRuntimeClaimRequestV1Schema,
} from '@/daemon/agentRuntime/foregroundAdmissionContract';
import { clearDaemonStateForTestTeardown, writeDaemonState } from '@/persistence';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';

function listen(server: http.Server): Promise<{ port: number }> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('unexpected server address'));
        return;
      }
      resolve({ port: address.port });
    });
  });
}

describe('daemon control client: foreground Agent runtime admission', () => {
  let envScope = createEnvKeyScope(['HAPPIER_HOME_DIR']);
  let tmpHomeDir: string | null = null;

  afterEach(async () => {
    await clearDaemonStateForTestTeardown();
    envScope.restore();
    envScope = createEnvKeyScope(['HAPPIER_HOME_DIR']);
    reloadConfiguration();
    if (tmpHomeDir) {
      await removeTempDir(tmpHomeDir);
      tmpHomeDir = null;
    }
  });

  it('carries the full canonical qualified Agent routing identity through admission and claim', () => {
    const agentId = `${'p'.repeat(256)}/${'a'.repeat(256)}`;
    const tooLongAgentId = `${agentId}x`;
    const admission = {
      v: 1 as const,
      attemptId: 'attempt-1',
      sessionId: 'session-1',
      foregroundPid: process.pid,
      directory: '/workspace',
      agentId,
      backendTarget: {
        kind: 'backend' as const,
        backendId: agentId,
        configuredBackendId: 'configured-agent',
        sourceKind: 'configured' as const,
      },
    };
    const claim = {
      v: 1 as const,
      attemptId: 'attempt-1',
      provisionalSessionId: 'session-1',
      canonicalSessionId: 'session-2',
      foregroundPid: process.pid,
      pluginId: 'p'.repeat(256),
      agentId,
      occurrenceId: 'occurrence-1',
      sourceCustody: { kind: 'development' as const, registeredRootId: 'registered-root-1' },
      capability: 'capability-1',
      foregroundSatisfiedProfileSecretRequirementNames: [],
    };

    expect(ForegroundAgentRuntimeAdmissionRequestV1Schema.parse(admission))
      .toEqual(admission);
    expect(ForegroundAgentRuntimeClaimRequestV1Schema.parse(claim))
      .toEqual(claim);
    expect(ForegroundAgentRuntimeAdmissionRequestV1Schema.safeParse({
      ...admission,
      agentId: tooLongAgentId,
    }).success).toBe(false);
    expect(ForegroundAgentRuntimeClaimRequestV1Schema.safeParse({
      ...claim,
      agentId: tooLongAgentId,
    }).success).toBe(false);
  });

  it('accepts only qualified service-keyed Connected Services intent and rejects client-qualified purpose authority', () => {
    const request = {
      v: 1 as const,
      attemptId: 'attempt-1',
      sessionId: 'session-1',
      foregroundPid: process.pid,
      directory: '/workspace',
      agentId: 'codex',
      backendTarget: {
        kind: 'backend' as const,
        backendId: 'codex',
        sourceKind: 'built_in' as const,
      },
      connectedServices: {
        v: 2 as const,
        bindingsByServiceId: {
          'happier.agent.codex/openai-codex': {
            source: 'connected' as const,
            selection: 'profile' as const,
            profileId: 'work',
          },
        },
      },
    };

    expect(ForegroundAgentRuntimeAdmissionRequestV1Schema.parse(request))
      .toEqual(request);
    expect(ForegroundAgentRuntimeAdmissionRequestV1Schema.safeParse({
      ...request,
      qualifiedPurposeBindingSnapshot: {
        purposes: [],
        bindings: [],
      },
    }).success).toBe(false);
  });

  it('rejects non-string foreground session-option environment values at the wire boundary', () => {
    const input = {
      isExplicitCliSubcommand: true,
      parsed: { agentArgs: [] },
      settings: {},
      pluginSettings: {
        account: { ownedMode: 'safe' },
        daemon: { daemonOnly: true },
      },
      environment: { KEEP: 'value' },
      startOrigin: 'terminal',
    } as const;

    expect(AgentCliSessionCommandBuildInputV1Schema.parse(input)).toEqual(input);
    expect(AgentCliSessionCommandBuildInputV1Schema.safeParse({
      ...input,
      environment: { KEEP: 'value', DROP: 1 },
    }).success).toBe(false);
    expect(AgentCliSessionCommandBuildInputV1Schema.safeParse({
      ...input,
      pluginSettings: { ownedMode: 'legacy-flat-value' },
    }).success).toBe(false);
    const { pluginSettings: _pluginSettings, ...missingPluginSettings } = input;
    expect(AgentCliSessionCommandBuildInputV1Schema.safeParse(missingPluginSettings).success).toBe(false);
  });

  it('accepts nested strict JSON foreground session options and rejects undefined values', () => {
    expect(AgentCliSessionCommandOptionsV1Schema.parse({
      mode: 'safe',
      nested: { list: [true, null, { depth: 2 }] },
    })).toEqual({
      mode: 'safe',
      nested: { list: [true, null, { depth: 2 }] },
    });
    expect(AgentCliSessionCommandOptionsV1Schema.safeParse({
      omitted: undefined,
    }).success).toBe(false);
  });

  it.each([1, 2] as const)('normalizes an older daemon refusal with V%s Provider identity', async version => {
    const server = http.createServer((_request, response) => {
      response.statusCode = 404;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ error: 'route_not_found' }));
    });

    try {
      const { port } = await listen(server);
      tmpHomeDir = await createTempDir(
        'happier-foreground-admission-client-',
      );
      envScope.patch({ HAPPIER_HOME_DIR: tmpHomeDir });
      reloadConfiguration();
      writeDaemonState({
        pid: process.pid,
        httpPort: port,
        startedAt: Date.now(),
        startedWithCliVersion: 'older-test',
        controlToken: 'control-token',
      });

      await expect(admitDaemonForegroundAgentRuntime({
        v: 1,
        attemptId: 'attempt-1',
        sessionId: 'session-1',
        foregroundPid: process.pid,
        directory: '/workspace',
        agentId: 'codex',
        selection: SessionModelSelectionSchema.parse({ v: version, updatedAt: 1, ref: {
          agentTargetKey: 'agent:happier.agent.codex/codex', modelId: 'model-a', providerConnectionId: 'pc_work',
          ...(version === 2 ? { source: 'account_provider_connection' } : {}),
        } }),
        backendTarget: {
          kind: 'backend',
          backendId: 'codex',
          sourceKind: 'built_in',
        },
      })).resolves.toMatchObject({
        ok: false,
        error: {
          code: 'provider_agent_runtime_unsupported',
          connectionId: 'pc_work',
        },
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
