import { describe, expect, it } from 'vitest';

import {
  ExternalSessionsAgentIdSchema,
  ExternalSessionAttachRequestSchema,
  ExternalSessionDetachRequestSchema,
  ExternalSessionFollowPolicySetRequestSchema,
  ExternalSessionLinkEnsureRequestSchema,
  ExternalSessionsSourceSchema,
} from './daemonRpcV1';
import * as daemonRpcV1 from './daemonRpcV1';
import { AgentProviderIdV1Schema } from '../../generated/providers/agentProviderIdsV1';
import { resolveExternalSessionsSourceKey } from './sourceCatalog';

describe('ExternalSessionsAgentIdSchema', () => {
  it('stays scoped to direct-session browsing providers even when daemon-facing provider ids grow', () => {
    expect(AgentProviderIdV1Schema.parse('antigravity')).toBe('antigravity');
    expect(AgentProviderIdV1Schema.parse('pi')).toBe('pi');
    expect(AgentProviderIdV1Schema.parse('ohMyPi')).toBe('ohMyPi');
    expect(ExternalSessionsAgentIdSchema.parse('codex')).toBe('codex');
    expect(ExternalSessionsAgentIdSchema.parse('ohMyPi')).toBe('ohMyPi');
    expect(() => ExternalSessionsAgentIdSchema.parse('antigravity')).toThrow();
    expect(() => ExternalSessionsAgentIdSchema.parse('pi')).toThrow();
  });
});

describe('external-session transcript schemas', () => {
  it('exports canonical external-session transcript symbols', () => {
    expect(typeof (daemonRpcV1 as any).ExternalSessionTranscriptRawMessageV1Schema?.safeParse).toBe('function');
    expect(typeof (daemonRpcV1 as any).ExternalSessionTranscriptPageRequestSchema?.safeParse).toBe('function');
    expect(typeof (daemonRpcV1 as any).ExternalSessionTranscriptPageResponseSchema?.safeParse).toBe('function');
    expect(typeof (daemonRpcV1 as any).ExternalSessionTranscriptReadAfterRequestSchema?.safeParse).toBe('function');
    expect(typeof (daemonRpcV1 as any).ExternalSessionTranscriptReadAfterResponseSchema?.safeParse).toBe('function');
  });
});

describe('ExternalSessionsSourceSchema', () => {
  it('accepts exact Codex user-home identity', () => {
    const parsed = ExternalSessionsSourceSchema.parse({
      kind: 'codexHome',
      home: 'user',
      homePath: '/tmp/custom-codex-home',
      futureSourceFlag: 'keep-me',
    });
    expect(parsed).toMatchObject({
      kind: 'codexHome',
      home: 'user',
      homePath: '/tmp/custom-codex-home',
    });
    expect((parsed as any).futureSourceFlag).toBe('keep-me');
  });

  it('accepts exact Codex connected-service profile identity', () => {
    expect(ExternalSessionsSourceSchema.parse({
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

  it('accepts exact Codex connected-service group identity', () => {
    expect(ExternalSessionsSourceSchema.parse({
      kind: 'codexHome',
      home: 'connectedService',
      connectedServiceId: 'openai-codex',
      connectedServiceGroupId: 'team',
      homePath: '/tmp/connected/__groups/team/codex/codex-home',
    })).toEqual({
      kind: 'codexHome',
      home: 'connectedService',
      connectedServiceId: 'openai-codex',
      connectedServiceGroupId: 'team',
      homePath: '/tmp/connected/__groups/team/codex/codex-home',
    });
  });

  it('validates runtimeDescriptor as a schema-owned direct-session link field', () => {
    const parsed = ExternalSessionLinkEnsureRequestSchema.parse({
      machineId: 'machine-1',
      agentId: 'codex',
      remoteSessionId: 'remote-1',
      source: {
        kind: 'codexHome',
        home: 'user',
      },
      runtimeDescriptorV1: {
        v: 1,
        agentId: 'codex',
        provider: {
          backendMode: 'appServer',
          providerSessionId: 'thread_1',
        },
        futureRuntimeDescriptorField: 'keep-me',
      },
    });

    expect((parsed as any).runtimeDescriptorV1).toMatchObject({
      v: 1,
      agentId: 'codex',
      agent: {
        backendMode: 'appServer',
        providerSessionId: 'thread_1',
      },
    });
    expect(((parsed as any).runtimeDescriptorV1 as any).futureRuntimeDescriptorField).toBe('keep-me');
  });

  it('rejects invalid runtimeDescriptorV1 shapes', () => {
    expect(() => ExternalSessionLinkEnsureRequestSchema.parse({
      machineId: 'machine-1',
      agentId: 'codex',
      remoteSessionId: 'remote-1',
      source: {
        kind: 'codexHome',
        home: 'user',
      },
      runtimeDescriptorV1: {
        v: 1,
        agentId: 42,
        provider: {
          backendMode: 'appServer',
          providerSessionId: 'thread_1',
        },
      },
    })).toThrow();
  });

  it('accepts direct-session attach renew requests with an existing lease id', () => {
    const parsed = ExternalSessionAttachRequestSchema.parse({
      machineId: 'machine-1',
      sessionId: 'session-1',
      agentId: 'codex',
      remoteSessionId: 'remote-1',
      source: {
        kind: 'codexHome',
        home: 'user',
        futureSourceFlag: 'keep-me',
      },
      leaseId: 'lease-1',
      ttlMs: 30_000,
      futureAttachFlag: 'keep-me',
    });
    expect(parsed).toMatchObject({
      machineId: 'machine-1',
      sessionId: 'session-1',
      agentId: 'codex',
      remoteSessionId: 'remote-1',
      source: {
        kind: 'codexHome',
        home: 'user',
      },
      leaseId: 'lease-1',
      ttlMs: 30_000,
    });
    expect((parsed as any).futureAttachFlag).toBe('keep-me');
  });

  it('accepts direct-session detach requests', () => {
    expect(ExternalSessionDetachRequestSchema.parse({
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
    expect(ExternalSessionFollowPolicySetRequestSchema.parse({
      machineId: 'machine-1',
      sessionId: 'session-1',
      agentId: 'claude',
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
      agentId: 'claude',
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
    expect(ExternalSessionsSourceSchema.parse({
      kind: 'ohMyPiAgentDir',
      agentDir: '/tmp/omp-agent',
    })).toEqual({
      kind: 'ohMyPiAgentDir',
      agentDir: '/tmp/omp-agent',
    });
  });

  it('resolves source keys by source kind without provider-specific branching in core callers', () => {
    expect(resolveExternalSessionsSourceKey({
      kind: 'codexHome',
      home: 'user',
      homePath: '/tmp/codex-home',
    })).toBe('codexHome:user:::/tmp/codex-home');
    expect(resolveExternalSessionsSourceKey({
      kind: 'codexHome',
      home: 'connectedService',
      connectedServiceId: 'openai-codex',
      connectedServiceGroupId: 'team',
      homePath: '/tmp/connected/__groups/team/codex/codex-home',
    })).toBe('codexHome:connectedService:openai-codex:group:team:/tmp/connected/__groups/team/codex/codex-home');
    expect(resolveExternalSessionsSourceKey({
      kind: 'ohMyPiAgentDir',
      agentDir: '/tmp/omp-agent',
    })).toBe('ohMyPiAgentDir:/tmp/omp-agent');
  });
});
