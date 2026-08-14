import { describe, expect, it } from 'vitest';

import { projectSessionMetadataForAgentHandoff } from './handoff.js';

describe('projectSessionMetadataForAgentHandoff', () => {
  it('projects the canonical provider Session id instead of raw metadata aliases', () => {
    const projected = projectSessionMetadataForAgentHandoff({
      providerSessionId: 'stale-direct-id',
      codexSessionId: 'stale-legacy-id',
      agentRuntimeDescriptorV1: {
        v: 1,
        agentId: 'codex',
        provider: {
          backendMode: 'appServer',
          providerSessionId: 'canonical-provider-id',
          home: 'connectedService',
          connectedServiceId: 'openai-codex',
          connectedServiceProfileId: 'profile-1',
          connectedServiceGroupId: 'group-1',
          homePath: '/private/source-machine/codex-home',
        },
      },
    });

    expect(projected.providerSessionId).toBe('canonical-provider-id');
    expect(projected.codexSessionId).toBe('canonical-provider-id');
    expect(projected.codexBackendMode).toBe('appServer');
    expect(projected.externalSessionSource).toEqual({
      kind: 'codexHome',
      home: 'connectedService',
      connectedServiceId: 'openai-codex',
      connectedServiceProfileId: 'profile-1',
      connectedServiceGroupId: 'group-1',
    });
    expect(JSON.stringify(projected)).not.toContain('/private/source-machine/codex-home');
    expect(projectSessionMetadataForAgentHandoff({
      codexSessionId: ' legacy-provider-id ',
    }).providerSessionId).toBe('legacy-provider-id');
    expect(projectSessionMetadataForAgentHandoff({
      codexBackendMode: 'acp',
    })).toEqual({ codexBackendMode: 'acp' });
  });

  it('projects OpenCode-safe fields from the canonical runtime descriptor without exposing its envelope', () => {
    expect(projectSessionMetadataForAgentHandoff({
      runtimeDescriptorV1: {
        v: 1,
        agentId: 'opencode',
        agent: {
          backendMode: 'acp',
          providerSessionId: ' opencode-canonical-1 ',
          serverBaseUrl: 'http://127.0.0.1:49196',
          serverBaseUrlExplicit: true,
        },
      },
    })).toEqual({
      providerSessionId: 'opencode-canonical-1',
      opencodeSessionId: 'opencode-canonical-1',
      opencodeBackendMode: 'acp',
      opencodeServerBaseUrl: 'http://127.0.0.1:49196/',
      opencodeServerBaseUrlExplicit: true,
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

  it('projects linked Codex source data and derives its safe backend mode at the host', () => {
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
    })).toEqual({
      codexBackendMode: 'appServer',
      externalSessionSource: source,
    });
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

    expect(current).toEqual({
      codexBackendMode: 'appServer',
      externalSessionSource: source,
    });
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
    })).toEqual({ codexBackendMode: 'appServer' });

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
