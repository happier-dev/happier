import { describe, expect, it } from 'vitest';

import * as directSessionsRpc from './daemonRpcV1';
import { DirectSessionsSourceSchema } from './daemonRpcV1';

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
});

describe('direct session follow lifecycle schemas', () => {
  it('parses attach, detach, and follow-policy requests', () => {
    const attachSchema = (directSessionsRpc as Record<string, any>).DirectSessionAttachRequestSchema;
    const detachSchema = (directSessionsRpc as Record<string, any>).DirectSessionDetachRequestSchema;
    const followPolicySchema = (directSessionsRpc as Record<string, any>).DirectSessionFollowPolicySetRequestSchema;

    expect(attachSchema.parse({
      machineId: 'machine-1',
      sessionId: 'session-1',
      providerId: 'claude',
      remoteSessionId: 'remote-1',
      source: { kind: 'claudeConfig', configDir: '/tmp/.claude', projectId: 'project-1' },
      leaseId: 'lease-1',
      ttlMs: 30_000,
    })).toEqual({
      machineId: 'machine-1',
      sessionId: 'session-1',
      providerId: 'claude',
      remoteSessionId: 'remote-1',
      source: { kind: 'claudeConfig', configDir: '/tmp/.claude', projectId: 'project-1' },
      leaseId: 'lease-1',
      ttlMs: 30_000,
    });

    expect(detachSchema.parse({
      machineId: 'machine-1',
      sessionId: 'session-1',
      leaseId: 'lease-1',
    })).toEqual({
      machineId: 'machine-1',
      sessionId: 'session-1',
      leaseId: 'lease-1',
    });

    expect(followPolicySchema.parse({
      machineId: 'machine-1',
      sessionId: 'session-1',
      providerId: 'claude',
      remoteSessionId: 'remote-1',
      source: { kind: 'claudeConfig', configDir: '/tmp/.claude', projectId: 'project-1' },
      enabled: true,
    })).toEqual({
      machineId: 'machine-1',
      sessionId: 'session-1',
      providerId: 'claude',
      remoteSessionId: 'remote-1',
      source: { kind: 'claudeConfig', configDir: '/tmp/.claude', projectId: 'project-1' },
      enabled: true,
    });
  });
});
