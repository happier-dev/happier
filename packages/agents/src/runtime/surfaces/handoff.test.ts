import { describe, expect, it } from 'vitest';

import { projectSessionMetadataForAgentHandoff } from './handoff.js';

describe('projectSessionMetadataForAgentHandoff', () => {
  it('forwards the bounded canonical runtime descriptor without Agent-specific fields', () => {
    const runtimeDescriptorV1 = {
      v: 1 as const,
      agentId: 'codex',
      agent: {
        backendMode: 'appServer',
        providerSessionId: 'canonical-provider-id',
        home: 'connectedService',
        connectedServiceId: 'openai-codex',
        connectedServiceProfileId: 'profile-1',
        connectedServiceGroupId: 'group-1',
        homePath: '/private/source-machine/codex-home',
      },
    };
    const projected = projectSessionMetadataForAgentHandoff({
      providerSessionId: 'stale-direct-id',
      codexSessionId: 'stale-legacy-id',
      runtimeDescriptorV1,
    });

    expect(projected).toEqual({ runtimeDescriptorV1 });
    expect('providerSessionId' in projected).toBe(false);
    expect('codexSessionId' in projected).toBe(false);
    expect('codexBackendMode' in projected).toBe(false);
    expect(JSON.stringify(projected)).toContain('/private/source-machine/codex-home');
  });

  it('forwards an OpenCode runtime descriptor without reconstructing a second owner view', () => {
    const runtimeDescriptorV1 = {
      v: 1 as const,
      agentId: 'opencode',
      agent: {
        backendMode: 'acp',
        providerSessionId: ' opencode-canonical-1 ',
        serverBaseUrl: 'http://127.0.0.1:49196',
        serverBaseUrlExplicit: true,
      },
    };
    expect(projectSessionMetadataForAgentHandoff({
      runtimeDescriptorV1,
    })).toEqual({
      runtimeDescriptorV1,
    });
  });

  it('projects linked Claude source data without exposing link-owner metadata', () => {
    const source = {
      kind: 'claudeConfig',
      configDir: '/tmp/claude:%-config',
      projectId: 'project:%/punctuation',
      nested: { punctuation: '::%/?#[]@!' },
    };
    const projected = projectSessionMetadataForAgentHandoff({
      externalSessionV1: {
        v: 1,
        agentId: 'claude',
        machineId: 'machine-1',
        remoteSessionId: 'remote-1',
        source,
        linkedAtMs: 100,
        lastKnownActivityAtMs: 200,
        runtimeDescriptorV1: {
          v: 1,
          agentId: 'claude',
          agent: { providerSessionId: 'private-linked-session-id' },
        },
      },
    });

    expect(projected).toEqual({
      externalSessionSource: source,
    });
  });

  it('projects linked Codex source data without interpreting its runtime descriptor at the host', () => {
    const source = {
      kind: 'codexHome',
      home: 'connectedService',
      connectedServiceId: 'openai-codex:%',
      connectedServiceProfileId: 'profile::%/one',
      connectedServiceGroupId: 'group?#[]',
    };

    expect(projectSessionMetadataForAgentHandoff({
      externalSessionV1: {
        v: 1,
        agentId: 'codex',
        machineId: 'machine-codex',
        remoteSessionId: 'remote-codex',
        source,
        linkedAtMs: 123,
        codexBackendMode: 'appServer',
      },
    })).toEqual({ externalSessionSource: source });
  });

  it('projects the same typed source from current and released linked metadata', () => {
    const source = {
      kind: 'codexHome',
      home: 'connectedService',
      connectedServiceId: 'openai-codex:%',
      connectedServiceProfileId: 'profile::%/one',
    };
    const sharedLink = {
      v: 1 as const,
      machineId: 'machine-codex',
      remoteSessionId: 'remote-codex',
      source,
      linkedAtMs: 123,
      codexBackendMode: 'appServer',
    };

    const current = projectSessionMetadataForAgentHandoff({
      externalSessionV1: { ...sharedLink, agentId: 'codex' },
    });
    const released = projectSessionMetadataForAgentHandoff({
      directSessionV1: { ...sharedLink, providerId: 'codex' },
    });

    expect(current).toEqual({ externalSessionSource: source });
    expect(released).toEqual(current);
  });

  it('does not expose mismatched, malformed, or raw owner metadata', () => {
    expect(projectSessionMetadataForAgentHandoff({
      runtimeDescriptorV1: {
        v: 1,
        agentId: 'codex',
        agent: { backendMode: 'appServer' },
      },
      agentRuntimeDescriptorV1: {
        v: 1,
        agentId: 'claude',
        agent: {},
      },
      externalSessionV1: {
        v: 1,
        agentId: 'claude',
        machineId: 'machine-private',
        remoteSessionId: 'remote-private',
        source: { kind: 'codexHome', home: 'user' },
        linkedAtMs: 456,
        codexBackendMode: 'mcp',
      },
      machineId: 'machine-top-level',
      linkedAtMs: 789,
      ownerProjection: { custody: 'private' },
    })).toEqual({
      runtimeDescriptorV1: {
        v: 1,
        agentId: 'codex',
        agent: { backendMode: 'appServer' },
      },
    });

    expect(projectSessionMetadataForAgentHandoff({
      externalSessionV1: {
        v: 1,
        agentId: 'codex',
        machineId: 'machine-private',
        remoteSessionId: 'remote-private',
        source: { kind: 'codexHome', home: () => 'not-json' },
        codexBackendMode: 'appServer',
      },
    })).toEqual({});
  });
});
