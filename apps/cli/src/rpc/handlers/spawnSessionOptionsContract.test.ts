import { describe, expect, it } from 'vitest';

import {
  SpawnDaemonSessionRequestSchema,
  pickDefinedSpawnSessionOptions,
} from './spawnSessionOptionsContract';

describe('SpawnDaemonSessionRequestSchema', () => {
  it('canonicalizes legacy built-in agent field into backendTarget when backendTarget is missing', () => {
    const parsed = SpawnDaemonSessionRequestSchema.parse({
      directory: '/tmp',
      agent: 'codex',
    });

    expect(parsed.backendTarget).toEqual({
      kind: 'backend',
      backendId: 'codex',
      sourceKind: 'built_in',
    });
  });

  it('preserves approvedNewDirectoryCreation in the canonical spawn request', () => {
    const parsed = SpawnDaemonSessionRequestSchema.parse({
      directory: '/tmp',
      approvedNewDirectoryCreation: true,
    });

    expect(parsed.approvedNewDirectoryCreation).toBe(true);
  });

  it('preserves account settings version hints in the canonical spawn request', () => {
    const parsed = SpawnDaemonSessionRequestSchema.parse({
      directory: '/tmp',
      accountSettingsVersionHint: 14,
    });

    expect(parsed.accountSettingsVersionHint).toBe(14);
    expect(pickDefinedSpawnSessionOptions(parsed)).toEqual(expect.objectContaining({
      accountSettingsVersionHint: 14,
    }));
  });

  it('accepts initial transcript catch-up cursors from resume requests', () => {
    const parsed = SpawnDaemonSessionRequestSchema.parse({
      directory: '/tmp',
      existingSessionId: 'session-1',
      initialTranscriptAfterSeq: 36,
    });

    expect(parsed.initialTranscriptAfterSeq).toBe(36);
    expect(pickDefinedSpawnSessionOptions(parsed)).toEqual(expect.objectContaining({
      initialTranscriptAfterSeq: 36,
    }));
  });

  it('rejects unknown legacy built-in agent field when backendTarget is missing', () => {
    expect(() =>
      SpawnDaemonSessionRequestSchema.parse({
        directory: '/tmp',
        agent: 'not-a-real-agent',
      }),
    ).toThrow();
  });

  it('rejects legacy customAcp built-in agent field when backendTarget is missing', () => {
    expect(() =>
      SpawnDaemonSessionRequestSchema.parse({
        directory: '/tmp',
        agent: 'customAcp',
      }),
    ).toThrow();
  });

  it('accepts V1 backendTarget carriers and canonicalizes them to the V2 backend transport shape', () => {
    expect(SpawnDaemonSessionRequestSchema.parse({
      directory: '/tmp',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
    }).backendTarget).toEqual({
      kind: 'backend',
      backendId: 'codex',
      sourceKind: 'built_in',
    });

    expect(SpawnDaemonSessionRequestSchema.parse({
      directory: '/tmp',
      backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
    }).backendTarget).toEqual({
      kind: 'backend',
      backendId: 'review-bot',
      configuredBackendId: 'review-bot',
      sourceKind: 'configured',
    });

    expect(SpawnDaemonSessionRequestSchema.parse({
      directory: '/tmp',
      backendTarget: 'agent:codex',
    }).backendTarget).toEqual({
      kind: 'backend',
      backendId: 'codex',
      sourceKind: 'built_in',
    });

    expect(SpawnDaemonSessionRequestSchema.parse({
      directory: '/tmp',
      backendTarget: 'acpBackend:review-bot',
    }).backendTarget).toEqual({
      kind: 'backend',
      backendId: 'review-bot',
      configuredBackendId: 'review-bot',
      sourceKind: 'configured',
    });
  });

  it('rejects canonical backendTarget values that identify customAcp', () => {
    expect(() =>
      SpawnDaemonSessionRequestSchema.parse({
        directory: '/tmp',
        backendTarget: { kind: 'backend', backendId: 'customAcp', sourceKind: 'built_in' },
      }),
    ).toThrow();
  });

  it('accepts V2 backendTarget input and preserves the canonical backend transport shape', () => {
    const parsed = SpawnDaemonSessionRequestSchema.parse({
      directory: '/tmp',
      backendTarget: {
        kind: 'backend',
        backendId: 'review-bot',
        configuredBackendId: 'review-bot',
        sourceKind: 'configured',
      },
    });

    expect(parsed.backendTarget).toEqual({
      kind: 'backend',
      backendId: 'review-bot',
      configuredBackendId: 'review-bot',
      sourceKind: 'configured',
    });
  });

  it('canonicalizes configured ACP backend targets that carry the legacy customAcp family marker', () => {
    const parsed = SpawnDaemonSessionRequestSchema.parse({
      directory: '/tmp',
      backendTarget: {
        kind: 'backend',
        backendId: 'customAcp',
        configuredBackendId: 'review-bot',
        sourceKind: 'configured',
      },
    });

    expect(parsed.backendTarget).toEqual({
      kind: 'backend',
      backendId: 'review-bot',
      configuredBackendId: 'review-bot',
      sourceKind: 'configured',
    });
  });

  it('accepts Windows terminal modes in the terminal payload', () => {
    const parsed = SpawnDaemonSessionRequestSchema.parse({
      directory: '/tmp',
      terminal: {
        mode: 'windows_terminal',
      },
      windowsRemoteSessionLaunchMode: 'windows_terminal',
      windowsTerminalWindowName: 'happier-qa',
    });

    expect(parsed.terminal?.mode).toBe('windows_terminal');
    expect(parsed.windowsRemoteSessionLaunchMode).toBe('windows_terminal');
    expect(parsed.windowsTerminalWindowName).toBe('happier-qa');
  });

  it('maps legacy experimentalCodexAcp requests onto canonical codexBackendMode', () => {
    const parsed = SpawnDaemonSessionRequestSchema.parse({
      directory: '/tmp',
      experimentalCodexAcp: true,
    });

    expect(parsed.codexBackendMode).toBe('acp');
    expect(parsed).not.toHaveProperty('experimentalCodexAcp');
  });

  it('drops legacy experimentalCodexAcp when false', () => {
    const parsed = SpawnDaemonSessionRequestSchema.parse({
      directory: '/tmp',
      experimentalCodexAcp: false,
    });

    expect(parsed.codexBackendMode).toBeUndefined();
    expect(parsed).not.toHaveProperty('experimentalCodexAcp');
  });

  it('preserves canonical codex backend mode from the transport request', () => {
    const parsed = SpawnDaemonSessionRequestSchema.parse({
      directory: '/tmp',
      codexBackendMode: 'appServer',
    });

    expect(parsed.codexBackendMode).toBe('appServer');
  });

  it('preserves canonical runtimeDescriptorV1 from the transport request', () => {
    const parsed = SpawnDaemonSessionRequestSchema.parse({
      directory: '/tmp',
      runtimeDescriptorV1: {
        v: 1,
        providerId: 'codex',
        provider: {
          backendMode: 'appServer',
          providerSessionId: 'runtime-thread',
        },
      },
    });

    expect(parsed.runtimeDescriptorV1).toEqual({
      v: 1,
      providerId: 'codex',
      provider: {
        backendMode: 'appServer',
        providerSessionId: 'runtime-thread',
      },
    });
    expect(parsed).not.toHaveProperty('agentRuntimeDescriptorV1');
  });

  it('prefers runtimeDescriptorV1 over the legacy agentRuntimeDescriptorV1 transport alias', () => {
    const parsed = SpawnDaemonSessionRequestSchema.parse({
      directory: '/tmp',
      runtimeDescriptorV1: {
        v: 1,
        providerId: 'codex',
        provider: {
          backendMode: 'appServer',
          providerSessionId: 'canonical-thread',
        },
      },
      agentRuntimeDescriptorV1: {
        v: 1,
        providerId: 'codex',
        provider: {
          backendMode: 'acp',
          providerSessionId: 'legacy-thread',
        },
      },
    });

    expect(parsed.runtimeDescriptorV1).toEqual({
      v: 1,
      providerId: 'codex',
      provider: {
        backendMode: 'appServer',
        providerSessionId: 'canonical-thread',
      },
    });
    expect(parsed).not.toHaveProperty('agentRuntimeDescriptorV1');
  });

  it('keeps runtimeDescriptorV1 when picking defined spawn-session options', () => {
    expect(pickDefinedSpawnSessionOptions({
      directory: '/tmp',
      runtimeDescriptorV1: {
        v: 1,
        providerId: 'codex',
        provider: {
          backendMode: 'appServer',
          providerSessionId: 'runtime-thread',
        },
      },
    })).toEqual({
      directory: '/tmp',
      runtimeDescriptorV1: {
        v: 1,
        providerId: 'codex',
        provider: {
          backendMode: 'appServer',
          providerSessionId: 'runtime-thread',
        },
      },
    });
  });

  it('accepts attach metadata identity policy from the transport request', () => {
    const parsed = SpawnDaemonSessionRequestSchema.parse({
      directory: '/tmp',
      attachMetadataIdentityPolicy: 'replace_with_runtime_identity',
    });

    expect(parsed.attachMetadataIdentityPolicy).toBe('replace_with_runtime_identity');
  });

});
