import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1,
  type ConnectedServiceBindingsV1,
  type SessionAgentSpawnPolicyV1,
} from '@happier-dev/protocol';
import { buildOpenCodeAgentRuntimeDescriptor } from '@happier-dev/agents';
import type { Credentials } from '@/persistence';

import {
  normalizeSessionAgentSpawnActionRequest,
  type SessionAgentSpawnActionConnectedServicesDefaultResolver,
} from './normalizeSessionAgentSpawnActionRequest';

const credentials: Credentials = {
  token: 'token',
  encryption: {
    type: 'legacy',
    secret: new Uint8Array([1, 2, 3, 4]),
  },
};

function policy(overrides: Partial<SessionAgentSpawnPolicyV1> = {}): SessionAgentSpawnPolicyV1 {
  return {
    ...DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1,
    ...overrides,
  };
}

function connectedServices(serviceId = 'openai-codex'): ConnectedServiceBindingsV1 {
  return {
    v: 1,
    bindingsByServiceId: {
      [serviceId]: {
        source: 'connected',
        selection: 'profile',
        profileId: 'profile-1',
      },
    },
  };
}

const noConnectedServiceDefaults: SessionAgentSpawnActionConnectedServicesDefaultResolver = vi.fn(async () => null);

describe('normalizeSessionAgentSpawnActionRequest', () => {
  it('builds createSpawnedSession params from current session fallback plus metadata inheritance', async () => {
    const result = await normalizeSessionAgentSpawnActionRequest({
      credentials,
      surface: 'session_agent',
      input: {
        agentId: 'codex',
        title: '  Child analysis  ',
        initialMessage: '  Inspect the repo  ',
      },
      parentMetadata: {
        permissionMode: 'safe-yolo',
        permissionModeUpdatedAt: 101,
        modelOverrideV1: { v: 1, updatedAt: 102, modelId: 'codex-pro' },
        sessionModeOverrideV1: { v: 1, updatedAt: 103, modeId: 'plan' },
        sessionConfigOptionOverridesV1: {
          v: 1,
          updatedAt: 104,
          overrides: {
            reasoning_effort: { updatedAt: 104, value: 'high' },
          },
        },
        connectedServices: connectedServices(),
        connectedServicesUpdatedAt: 105,
        mcpSelectionV1: {
          v: 1,
          managedServersEnabled: false,
          forceIncludeServerIds: ['repo-tools'],
          forceExcludeServerIds: ['legacy-tool'],
        },
        profileId: 'standalone-profile',
      },
      currentSession: {
        path: '/repo/current',
        host: 'leeroy-mbp',
        machineId: 'machine-1',
      },
      spawnPolicy: policy(),
      resolveConnectedServicesDefaults: noConnectedServiceDefaults,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected normalized spawn request');

    expect(result.createParams).toMatchObject({
      credentials,
      directory: '/repo/current',
      machineId: 'machine-1',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      permissionMode: 'safe-yolo',
      permissionModeUpdatedAt: 101,
      modelId: 'codex-pro',
      modelUpdatedAt: 102,
      agentModeId: 'plan',
      agentModeUpdatedAt: 103,
      sessionConfigOptionOverrides: {
        v: 1,
        updatedAt: 104,
        overrides: {
          reasoning_effort: { updatedAt: 104, value: 'high' },
        },
      },
      profileId: 'standalone-profile',
      connectedServices: connectedServices(),
      connectedServicesUpdatedAt: 105,
      mcpSelection: {
        v: 1,
        managedServersEnabled: false,
        forceIncludeServerIds: ['repo-tools'],
        forceExcludeServerIds: ['legacy-tool'],
      },
      title: 'Child analysis',
      initialMessage: 'Inspect the repo',
    });
    expect(result.createParams).not.toHaveProperty('environmentVariables');
    expect(result.sources).toMatchObject({
      directory: { kind: 'currentSession', key: 'path' },
      machineId: { kind: 'currentSession', key: 'machineId' },
      backendTarget: { kind: 'explicit', key: 'agentId' },
      permissionMode: { kind: 'metadata', key: 'permissionMode' },
      modelId: { kind: 'metadata', key: 'modelOverrideV1' },
      agentModeId: { kind: 'metadata', key: 'sessionModeOverrideV1' },
      sessionConfigOptionOverrides: { kind: 'metadata', key: 'sessionConfigOptionOverridesV1' },
      connectedServices: { kind: 'metadata', key: 'connectedServices' },
      mcpSelection: { kind: 'metadata', key: 'mcpSelectionV1' },
      profileId: { kind: 'metadata', key: 'profileId' },
    });
    expect(noConnectedServiceDefaults).not.toHaveBeenCalled();
  });

  it('inherits backend target from parent runtime metadata when no explicit target is provided', async () => {
    const result = await normalizeSessionAgentSpawnActionRequest({
      credentials,
      surface: 'session_agent',
      input: {
        initialMessage: 'Spawn another session like this one',
      },
      parentMetadata: {
        permissionMode: 'safe-yolo',
        permissionModeUpdatedAt: 101,
        agentRuntimeDescriptorV1: buildOpenCodeAgentRuntimeDescriptor({
          backendMode: 'server',
          vendorSessionId: 'opencode-parent',
        }),
      },
      currentSession: {
        path: '/repo/current',
        host: 'leeroy-mbp',
        machineId: 'machine-1',
      },
      spawnPolicy: policy(),
      resolveConnectedServicesDefaults: noConnectedServiceDefaults,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected normalized spawn request');

    expect(result.createParams.backendTarget).toEqual({ kind: 'builtInAgent', agentId: 'opencode' });
    expect(result.sources.backendTarget).toEqual({
      kind: 'runtimeDescriptorMetadata',
      key: 'agentRuntimeDescriptorV1',
    });
  });

  it('inherits exact parent backend target before runtime metadata fallback', async () => {
    const result = await normalizeSessionAgentSpawnActionRequest({
      credentials,
      surface: 'session_agent',
      input: {
        initialMessage: 'Spawn another session like this one',
      },
      parentMetadata: {
        permissionMode: 'safe-yolo',
        permissionModeUpdatedAt: 101,
        agentRuntimeDescriptorV1: { v: 1, providerId: 'claude' },
      },
      currentSession: {
        path: '/repo/current',
        host: 'leeroy-mbp',
        machineId: 'machine-1',
        backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
      },
      spawnPolicy: policy(),
      resolveConnectedServicesDefaults: noConnectedServiceDefaults,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected normalized spawn request');

    expect(result.createParams.backendTarget).toEqual({
      kind: 'configuredAcpBackend',
      backendId: 'review-bot',
    });
    expect(result.sources.backendTarget).toEqual({
      kind: 'currentSession',
      key: 'backendTarget',
    });
  });

  it('preserves inherited permissionModeUpdatedAt when the live caller mode matches inherited metadata', async () => {
    const result = await normalizeSessionAgentSpawnActionRequest({
      credentials,
      surface: 'session_agent',
      input: {
        initialMessage: 'Spawn another session like this one',
      },
      parentMetadata: {
        permissionMode: 'safe-yolo',
        permissionModeUpdatedAt: 101,
        modelOverrideV1: { v: 1, updatedAt: 102, modelId: 'claude-opus-parent' },
      },
      currentSession: {
        path: '/repo/current',
        host: 'leeroy-mbp',
        machineId: 'machine-1',
        permissionMode: 'safe-yolo',
      },
      spawnPolicy: policy(),
      resolveConnectedServicesDefaults: noConnectedServiceDefaults,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected normalized spawn request');

    expect(result.createParams.permissionMode).toBe('safe-yolo');
    expect(result.createParams.permissionModeUpdatedAt).toBe(101);
  });

  it('inherits configured ACP backend metadata before runtime descriptor fallback', async () => {
    const result = await normalizeSessionAgentSpawnActionRequest({
      credentials,
      surface: 'session_agent',
      input: {
        initialMessage: 'Spawn another configured backend session like this one',
      },
      parentMetadata: {
        permissionMode: 'safe-yolo',
        permissionModeUpdatedAt: 101,
        acpConfiguredBackendV1: {
          v: 1,
          backendId: 'review-bot',
          title: 'Review Bot',
          updatedAt: 100,
        },
        agentRuntimeDescriptorV1: { v: 1, providerId: 'claude' },
      },
      currentSession: {
        path: '/repo/current',
        host: 'leeroy-mbp',
        machineId: 'machine-1',
      },
      spawnPolicy: policy(),
      resolveConnectedServicesDefaults: noConnectedServiceDefaults,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected normalized spawn request');

    expect(result.createParams.backendTarget).toEqual({
      kind: 'configuredAcpBackend',
      backendId: 'review-bot',
    });
    expect(result.sources.backendTarget).toEqual({
      kind: 'metadata',
      key: 'acpConfiguredBackendV1',
    });
  });

  it('merges canonical and shorthand config option overrides when option ids do not conflict', async () => {
    const result = await normalizeSessionAgentSpawnActionRequest({
      credentials,
      surface: 'session_agent',
      input: {
        agentId: 'claude',
        sessionConfigOptionOverrides: {
          v: 1,
          updatedAt: 10,
          overrides: {
            reasoning_effort: { updatedAt: 10, value: 'xhigh' },
          },
        },
        configOptions: {
          ultracode: true,
        },
      },
      parentMetadata: {
        permissionMode: 'safe-yolo',
        permissionModeUpdatedAt: 101,
      },
      currentSession: {
        path: '/repo/current',
        host: 'leeroy-mbp',
        machineId: 'machine-1',
      },
      spawnPolicy: policy(),
      resolveConnectedServicesDefaults: noConnectedServiceDefaults,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected normalized spawn request');

    expect(result.createParams.sessionConfigOptionOverrides?.overrides).toMatchObject({
      reasoning_effort: { updatedAt: 10, value: 'xhigh' },
      ultracode: { value: true },
    });
    expect(result.sources.sessionConfigOptionOverrides).toEqual({
      kind: 'explicit',
      key: 'sessionConfigOptionOverrides+configOptions',
    });
  });

  it('uses connected-service defaults only when explicit and inherited bindings are absent', async () => {
    const resolveConnectedServicesDefaults: SessionAgentSpawnActionConnectedServicesDefaultResolver = vi.fn(async () => ({
      connectedServices: connectedServices('claude-subscription'),
      connectedServicesUpdatedAt: 200,
    }));

    const result = await normalizeSessionAgentSpawnActionRequest({
      credentials,
      surface: 'session_agent',
      input: { backendTargetKey: 'agent:claude' },
      parentMetadata: { permissionMode: 'default', permissionModeUpdatedAt: 100 },
      currentSession: {
        path: '/repo/current',
        host: 'leeroy-mbp',
        machineId: 'machine-1',
      },
      spawnPolicy: policy(),
      resolveConnectedServicesDefaults,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected normalized spawn request');

    expect(result.createParams).toMatchObject({
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      connectedServices: connectedServices('claude-subscription'),
      connectedServicesUpdatedAt: 200,
    });
    expect(result.sources.connectedServices).toEqual({
      kind: 'default',
      key: 'connectedServicesDefaults',
    });
    expect(resolveConnectedServicesDefaults).toHaveBeenCalledWith({
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      credentials,
    });
  });

  it('rejects malformed backend target inputs instead of falling back to the default agent', async () => {
    for (const input of [
      { backendTargetKey: 'not-a-backend-target' },
      { backendTarget: { kind: 'unsupportedTarget', id: 'target-1' } },
    ]) {
      const result = await normalizeSessionAgentSpawnActionRequest({
        credentials,
        surface: 'session_agent',
        input,
        parentMetadata: { permissionMode: 'default', permissionModeUpdatedAt: 100 },
        currentSession: {
          path: '/repo/current',
          host: 'leeroy-mbp',
          machineId: 'machine-1',
        },
        spawnPolicy: policy(),
        resolveConnectedServicesDefaults: noConnectedServiceDefaults,
      });

      expect(result).toEqual({
        ok: false,
        result: {
          type: 'error',
          errorCode: 'invalid_parameters',
          errorMessage: 'invalid_parameters',
        },
      });
    }
  });

  it('does not emit an orphan model timestamp when explicit default clears the inherited model', async () => {
    const result = await normalizeSessionAgentSpawnActionRequest({
      credentials,
      surface: 'session_agent',
      input: {
        agentId: 'codex',
        modelId: 'default',
      },
      parentMetadata: {
        permissionMode: 'safe-yolo',
        modelOverrideV1: { v: 1, updatedAt: 102, modelId: 'codex-pro' },
      },
      currentSession: {
        path: '/repo/current',
        host: 'leeroy-mbp',
        machineId: 'machine-1',
      },
      spawnPolicy: policy(),
      resolveConnectedServicesDefaults: noConnectedServiceDefaults,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected normalized spawn request');

    expect(result.createParams).not.toHaveProperty('modelId');
    expect(result.createParams).not.toHaveProperty('modelUpdatedAt');
  });

  it('returns a structured policy denial for disallowed explicit session-agent overrides', async () => {
    const result = await normalizeSessionAgentSpawnActionRequest({
      credentials,
      surface: 'session_agent',
      input: {
        environmentVariables: { SECRET_TOKEN: 'do-not-log' },
      },
      parentMetadata: { permissionMode: 'safe-yolo', permissionModeUpdatedAt: 100 },
      currentSession: {
        path: '/repo/current',
        host: 'leeroy-mbp',
        machineId: 'machine-1',
      },
      spawnPolicy: policy({ allowEnvironmentVariables: false }),
      resolveConnectedServicesDefaults: noConnectedServiceDefaults,
    });

    expect(result).toEqual({
      ok: false,
      result: {
        type: 'error',
        errorCode: 'spawn_policy_denied',
        errorMessage: 'spawn_policy_denied',
        details: {
          field: 'environmentVariables',
          surface: 'session_agent',
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain('do-not-log');
  });

  it('rejects explicit permission escalation before daemon spawn params are built', async () => {
    const result = await normalizeSessionAgentSpawnActionRequest({
      credentials,
      surface: 'session_agent',
      input: {
        permissionMode: 'bypassPermissions',
      },
      parentMetadata: { permissionMode: 'default', permissionModeUpdatedAt: 100 },
      currentSession: {
        path: '/repo/current',
        host: 'leeroy-mbp',
        machineId: 'machine-1',
      },
      spawnPolicy: policy(),
      resolveConnectedServicesDefaults: noConnectedServiceDefaults,
    });

    expect(result).toMatchObject({
      ok: false,
      result: {
        type: 'error',
        errorCode: 'permission_escalation_denied',
        errorMessage: 'permission_escalation_denied',
        details: {
          requestedMode: 'yolo',
          requestedOrdinal: 3,
          callerMode: 'default',
          callerOrdinal: 1,
        },
      },
    });
  });

  it('allows an explicit direct-CLI permission mode above an ambient parent default', async () => {
    const result = await normalizeSessionAgentSpawnActionRequest({
      credentials,
      surface: 'cli',
      input: {
        agentId: 'codex',
        permissionMode: 'bypassPermissions',
      },
      parentMetadata: { permissionMode: 'safe-yolo', permissionModeUpdatedAt: 100 },
      currentSession: {
        path: '/repo/current',
        host: 'leeroy-mbp',
        machineId: 'machine-1',
      },
      resolveConnectedServicesDefaults: noConnectedServiceDefaults,
    });

    expect(result).toMatchObject({
      ok: true,
      createParams: { permissionMode: 'bypassPermissions' },
      sources: { permissionMode: { kind: 'explicit', key: 'permissionMode' } },
    });
  });

  it('inherits an ambient parent permission mode when direct CLI does not specify one', async () => {
    const result = await normalizeSessionAgentSpawnActionRequest({
      credentials,
      surface: 'cli',
      input: { agentId: 'codex' },
      parentMetadata: { permissionMode: 'safe-yolo', permissionModeUpdatedAt: 100 },
      currentSession: {
        path: '/repo/current',
        host: 'leeroy-mbp',
        machineId: 'machine-1',
      },
      resolveConnectedServicesDefaults: noConnectedServiceDefaults,
    });

    expect(result).toMatchObject({
      ok: true,
      createParams: {
        permissionMode: 'safe-yolo',
        permissionModeUpdatedAt: 100,
      },
      sources: { permissionMode: { kind: 'metadata', key: 'permissionMode' } },
    });
  });
});
