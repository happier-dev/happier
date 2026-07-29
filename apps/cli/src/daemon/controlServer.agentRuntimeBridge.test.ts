import { describe, expect, it, vi } from 'vitest';

import { createDaemonControlApp } from './controlServer';
import { hashAgentRuntimeSessionBridgeToken } from './agentRuntime/sessionBridgeAuthorization';

describe('daemon control server: Agent runtime session bridge', () => {
  it('admits with the canonical daemon machine and releases without registering a fake child', async () => {
    const descriptor = {
      v: 1 as const,
      pluginId: 'acme.plugin',
      pluginVersion: '1.2.3',
      agentId: 'acme-agent',
      backendId: 'acme-agent',
      generation: 'generation-7',
      factoryControls: {
        continuation: false,
        goals: false,
        catalog: false,
        usageLimitRecovery: false,
      },
    };
    const admit = vi.fn(async () => ({
      ok: true as const,
      capability: {
        attemptId: 'attempt-1',
        tokenFilePath: '/private/token.json',
        descriptor,
      },
      launchPolicy: {
        reservedEnvironmentVariableNames: ['AGENT_AUTH'],
        profileSecretRequirementNamesMissingBinding: [],
      },
    }));
    const release = vi.fn(async () => undefined);
    const dispatch = vi.fn(async () => ({
      ok: true as const,
      result: {
        ok: true as const,
        environment: { AGENT_AUTH: 'secret' },
        unsetEnvironmentVariableNames: [],
      },
    }));
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine-1',
      stopSession: async () => ({ status: 'not_found' as const }),
      spawnSession: async () => ({ type: 'success', sessionId: 'unused' }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'control-token',
      agentRuntimeSessionBridge: {
        dispatch,
        disposeSession: async () => {},
        dispose: async () => {},
      },
      foregroundAgentRuntimeAdmission: {
        admit,
        release,
        releaseSession: async () => {},
        dispose: async () => {},
        claimEnvironment: async () => ({
          ok: true as const,
          environment: {},
          unsetEnvironmentVariableNames: [],
          sensitiveEnvironmentVariableNames: [],
        }),
        isBridgeRequestAuthorized: (request) =>
          request.context.token === 'scoped-token',
      },
    });
    const admission = {
      v: 1 as const,
      attemptId: 'attempt-1',
      sessionId: 'session-1',
      foregroundPid: 1234,
      directory: '/workspace',
      agentId: 'acme-agent',
      backendTarget: {
        kind: 'backend' as const,
        backendId: 'acme-agent',
        sourceKind: 'built_in' as const,
      },
    };

    try {
      await app.ready();
      expect((await app.inject({
        method: 'POST',
        url: '/agent-runtime/foreground/admit',
        payload: admission,
      })).statusCode).toBe(401);
      expect((await app.inject({
        method: 'POST',
        url: '/agent-runtime/foreground/admit',
        headers: { 'x-happier-daemon-token': 'control-token' },
        payload: {
          ...admission,
          machineId: 'foreign-machine',
        },
      })).statusCode).toBe(400);
      expect(admit).not.toHaveBeenCalled();
      const admitted = await app.inject({
        method: 'POST',
        url: '/agent-runtime/foreground/admit',
        headers: { 'x-happier-daemon-token': 'control-token' },
        payload: admission,
      });
      expect(admitted.statusCode).toBe(200);
      expect(admitted.json()).not.toHaveProperty('environment');
      expect(admit).toHaveBeenCalledTimes(1);
      expect(admit).toHaveBeenCalledWith({
        ...admission,
        machineId: 'machine-1',
      });

      const forbiddenClaim = await app.inject({
        method: 'POST',
        url: '/agent-runtime/session/bridge',
        headers: { 'x-happier-daemon-token': 'control-token' },
        payload: {
          v: 1,
          context: {
            token: 'wrong-token',
            sessionId: 'session-1',
            pluginId: descriptor.pluginId,
            agentId: descriptor.agentId,
            generation: descriptor.generation,
          },
          operation: {
            kind: 'foreground.environment.claim',
            requestId: 'claim-forbidden',
            attemptId: 'attempt-1',
            foregroundSatisfiedProfileSecretRequirementNames: [],
          },
        },
      });
      expect(forbiddenClaim.statusCode).toBe(403);
      expect(dispatch).not.toHaveBeenCalled();

      const claimed = await app.inject({
        method: 'POST',
        url: '/agent-runtime/session/bridge',
        headers: { 'x-happier-daemon-token': 'control-token' },
        payload: {
          v: 1,
          context: {
            token: 'scoped-token',
            sessionId: 'session-1',
            pluginId: descriptor.pluginId,
            agentId: descriptor.agentId,
            generation: descriptor.generation,
          },
          operation: {
            kind: 'foreground.environment.claim',
            requestId: 'claim-1',
            attemptId: 'attempt-1',
            foregroundSatisfiedProfileSecretRequirementNames: [],
          },
        },
      });
      expect(claimed.statusCode).toBe(200);
      expect(dispatch).toHaveBeenCalledTimes(1);

      expect((await app.inject({
        method: 'POST',
        url: '/agent-runtime/foreground/release',
        headers: { 'x-happier-daemon-token': 'control-token' },
        payload: {
          v: 1,
          attemptId: 'attempt-1',
          sessionId: 'session-1',
        },
      })).statusCode).toBe(200);
      expect(release).toHaveBeenCalledWith('attempt-1', 'session-1');
    } finally {
      await app.close();
    }
  });

  it('forbids a late pre-restart token even when all stale in-memory binding fields are present', async () => {
    const dispatch = vi.fn(async () => ({ ok: true as const, result: null }));
    const token = 'pre-restart-agent-bridge-token';
    const descriptor = {
      v: 1 as const,
      pluginId: 'happier.agent.grok',
      pluginVersion: '0.2.111',
      agentId: 'grok',
      backendId: 'grok',
      generation: 'pre-restart-generation',
      factoryControls: {
        continuation: false,
        goals: false,
        catalog: false,
        usageLimitRecovery: false,
      },
    };
    const app = createDaemonControlApp({
      getChildren: () => [{
        startedBy: 'daemon',
        pid: 85855,
        happySessionId: 'session-restarted',
        reattachedFromDiskMarker: true,
        agentRuntimeRestartDisposition: 'bridge_authority_unavailable',
        agentRuntimeBridgeTokenHash: hashAgentRuntimeSessionBridgeToken(token),
        agentRuntimeBridgePluginId: descriptor.pluginId,
        agentRuntimeBridgeAgentId: descriptor.agentId,
        agentRuntimeBridgeBackendId: descriptor.backendId,
        agentRuntimeBridgeGeneration: descriptor.generation,
      }],
      machineId: 'machine-1',
      stopSession: async () => ({ status: 'not_found' as const }),
      spawnSession: async () => ({ type: 'success', sessionId: 'unused' }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'control-token',
      agentRuntimeSessionBridge: { dispatch, disposeSession: async () => {}, dispose: async () => {} },
    });

    try {
      await app.ready();
      const response = await app.inject({
        method: 'POST',
        url: '/agent-runtime/session/bridge',
        headers: { 'x-happier-daemon-token': 'control-token' },
        payload: {
          v: 1,
          context: {
            token,
            sessionId: 'session-restarted',
            pluginId: descriptor.pluginId,
            agentId: descriptor.agentId,
            generation: descriptor.generation,
          },
          operation: {
            kind: 'factory.prepare',
            requestId: 'late-prepare',
            descriptor,
            request: {
              kind: 'resume',
              sessionId: 'session-restarted',
              cwd: '/workspace',
              providerSessionId: 'provider-1',
            },
          },
        },
      });

      expect(response.statusCode).toBe(403);
      expect(dispatch).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('binds factory.prepare to the tracked session and exact descriptor identity', async () => {
    const dispatch = vi.fn(async () => ({ ok: true as const, result: null }));
    const token = 'agent-bridge-token';
    const descriptor = {
      v: 1 as const,
      pluginId: 'acme.plugin',
      pluginVersion: '1.2.3',
      agentId: 'acme-agent',
      backendId: 'acme-backend',
      generation: 'generation-7',
      factoryControls: {
        continuation: true,
        goals: false,
        catalog: false,
        usageLimitRecovery: false,
      },
    };
    const app = createDaemonControlApp({
      getChildren: () => [{
        startedBy: 'daemon',
        pid: 1234,
        happySessionId: 'session-1',
        agentRuntimeBridgeTokenHash: hashAgentRuntimeSessionBridgeToken(token),
        agentRuntimeBridgePluginId: descriptor.pluginId,
        agentRuntimeBridgeAgentId: descriptor.agentId,
        agentRuntimeBridgeBackendId: descriptor.backendId,
        agentRuntimeBridgeGeneration: descriptor.generation,
      }],
      machineId: 'machine-1',
      stopSession: async () => ({ status: 'not_found' as const }),
      spawnSession: async () => ({ type: 'success', sessionId: 'unused' }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'control-token',
      agentRuntimeSessionBridge: { dispatch, disposeSession: async () => {}, dispose: async () => {} },
    });
    const request = {
      v: 1 as const,
      context: {
        token,
        sessionId: 'session-1',
        pluginId: descriptor.pluginId,
        agentId: descriptor.agentId,
        generation: descriptor.generation,
      },
      operation: {
        kind: 'factory.prepare' as const,
        requestId: 'prepare-1',
        descriptor,
        request: {
          kind: 'resume' as const,
          sessionId: 'session-1',
          cwd: '/workspace',
          providerSessionId: 'provider-1',
        },
      },
    };

    try {
      await app.ready();
      const send = async (body: typeof request) => await app.inject({
        method: 'POST',
        url: '/agent-runtime/session/bridge',
        headers: { 'x-happier-daemon-token': 'control-token' },
        payload: body,
      });

      expect((await send(request)).statusCode).toBe(200);
      for (const invalid of [
        {
          ...request,
          operation: {
            ...request.operation,
            request: { ...request.operation.request, sessionId: 'session-2' },
          },
        },
        {
          ...request,
          operation: {
            ...request.operation,
            descriptor: { ...descriptor, pluginId: 'other.plugin' },
          },
        },
        {
          ...request,
          operation: {
            ...request.operation,
            descriptor: { ...descriptor, agentId: 'other-agent' },
          },
        },
        {
          ...request,
          operation: {
            ...request.operation,
            descriptor: { ...descriptor, backendId: 'other-backend' },
          },
        },
        {
          ...request,
          operation: {
            ...request.operation,
            descriptor: { ...descriptor, generation: 'generation-8' },
          },
        },
      ]) {
        const response = await send(invalid);
        expect(response.statusCode).toBe(403);
        expect(response.json()).toEqual({
          ok: false,
          error: {
            code: 'agent_runtime_daemon_bridge_forbidden',
            message: 'Agent runtime daemon bridge request is forbidden',
          },
        });
      }
    } finally {
      await app.close();
    }

    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});
