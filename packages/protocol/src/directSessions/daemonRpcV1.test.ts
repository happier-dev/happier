import { describe, expect, it } from 'vitest';

import {
  DirectSessionAttachRequestSchema,
  DirectSessionDetachRequestSchema,
  DirectSessionFollowPolicySetRequestSchema,
  DirectSessionsSourceSchema,
} from './daemonRpcV1';

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
});
