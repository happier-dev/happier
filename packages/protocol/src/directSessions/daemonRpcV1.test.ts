import { describe, expect, it } from 'vitest';

import {
  DirectSessionsProviderIdSchema,
  DirectSessionAttachRequestSchema,
  DirectSessionDetachRequestSchema,
  DirectSessionFollowPolicySetRequestSchema,
  DirectSessionsSourceSchema,
} from './daemonRpcV1';
import { AgentProviderIdV1Schema } from '../providers/agentProviderIdsV1';
import { resolveDirectSessionsSourceKey } from '../providers/directSessionsCatalog';

describe('DirectSessionsProviderIdSchema', () => {
  it('stays scoped to direct-session browsing providers even when daemon-facing provider ids grow', () => {
    expect(AgentProviderIdV1Schema.parse('pi')).toBe('pi');
    expect(AgentProviderIdV1Schema.parse('ohMyPi')).toBe('ohMyPi');
    expect(DirectSessionsProviderIdSchema.parse('codex')).toBe('codex');
    expect(DirectSessionsProviderIdSchema.parse('ohMyPi')).toBe('ohMyPi');
    expect(() => DirectSessionsProviderIdSchema.parse('pi')).toThrow();
  });
});

describe('DirectSessionsSourceSchema', () => {
  it('accepts exact Codex user-home identity', () => {
    expect(DirectSessionsSourceSchema.parse({
      kind: 'codexHome',
      home: 'user',
      homePath: '/tmp/custom-codex-home',
    })).toEqual({
      kind: 'codexHome',
      home: 'user',
      homePath: '/tmp/custom-codex-home',
    });
  });

  it('accepts exact Codex connected-service profile identity', () => {
    expect(DirectSessionsSourceSchema.parse({
      kind: 'codexHome',
      home: 'connectedService',
      connectedServiceId: 'openai-codex',
      connectedServiceProfileId: 'work',
      homePath: '/tmp/connected/work/codex-home',
    })).toEqual({
      kind: 'codexHome',
      home: 'connectedService',
      connectedServiceId: 'openai-codex',
      connectedServiceProfileId: 'work',
      homePath: '/tmp/connected/work/codex-home',
    });
  });

  it('accepts direct-session attach renew requests with an existing lease id', () => {
    expect(DirectSessionAttachRequestSchema.parse({
      machineId: 'machine-1',
      sessionId: 'session-1',
      providerId: 'codex',
      remoteSessionId: 'remote-1',
      source: {
        kind: 'codexHome',
        home: 'user',
      },
      leaseId: 'lease-1',
      ttlMs: 30_000,
    })).toEqual({
      machineId: 'machine-1',
      sessionId: 'session-1',
      providerId: 'codex',
      remoteSessionId: 'remote-1',
      source: {
        kind: 'codexHome',
        home: 'user',
      },
      leaseId: 'lease-1',
      ttlMs: 30_000,
    });
  });

  it('accepts direct-session detach requests', () => {
    expect(DirectSessionDetachRequestSchema.parse({
      machineId: 'machine-1',
      sessionId: 'session-1',
      leaseId: 'lease-1',
    })).toEqual({
      machineId: 'machine-1',
      sessionId: 'session-1',
      leaseId: 'lease-1',
    });
  });

  it('accepts direct-session background follow policy updates', async () => {
    expect(DirectSessionFollowPolicySetRequestSchema.parse({
      machineId: 'machine-1',
      sessionId: 'session-1',
      providerId: 'claude',
      remoteSessionId: 'remote-1',
      source: {
        kind: 'claudeConfig',
        configDir: '/tmp/claude',
        projectId: 'proj-1',
      },
      enabled: true,
    })).toEqual({
      machineId: 'machine-1',
      sessionId: 'session-1',
      providerId: 'claude',
      remoteSessionId: 'remote-1',
      source: {
        kind: 'claudeConfig',
        configDir: '/tmp/claude',
        projectId: 'proj-1',
      },
      enabled: true,
    });
  });

  it('accepts exact ohMyPi agent-dir identity', () => {
    expect(DirectSessionsSourceSchema.parse({
      kind: 'ohMyPiAgentDir',
      agentDir: '/tmp/omp-agent',
    })).toEqual({
      kind: 'ohMyPiAgentDir',
      agentDir: '/tmp/omp-agent',
    });
  });

  it('resolves source keys by source kind without provider-specific branching in core callers', () => {
    expect(resolveDirectSessionsSourceKey({
      kind: 'codexHome',
      home: 'user',
      homePath: '/tmp/codex-home',
    })).toBe('codexHome:user:::/tmp/codex-home');
    expect(resolveDirectSessionsSourceKey({
      kind: 'ohMyPiAgentDir',
      agentDir: '/tmp/omp-agent',
    })).toBe('ohMyPiAgentDir:/tmp/omp-agent');
  });
});
