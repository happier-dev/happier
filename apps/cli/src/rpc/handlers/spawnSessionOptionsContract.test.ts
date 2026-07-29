import { describe, expect, it } from 'vitest';

import {
  mergeSpawnSessionOptions,
  SpawnDaemonSessionRequestSchema,
  pickDefinedSpawnSessionOptions,
} from './spawnSessionOptionsContract';

describe('SpawnDaemonSessionRequestSchema', () => {
  it('preserves the strict V1 startup-instructions carrier and rejects it for forks', () => {
    const agentSessionStartupInstructionsV1 = {
      v: 1 as const,
      id: 'happier.global_voice_agent',
      revision: 1,
      instructions: 'Global Voice startup instructions.',
    };

    expect(SpawnDaemonSessionRequestSchema.parse({
      directory: '/tmp/voice',
      agentSessionStartupInstructionsV1,
    }).agentSessionStartupInstructionsV1).toEqual(
      agentSessionStartupInstructionsV1,
    );
    expect(pickDefinedSpawnSessionOptions({
      directory: '/tmp/voice',
      agentSessionStartupInstructionsV1,
    })).toEqual({
      directory: '/tmp/voice',
      agentSessionStartupInstructionsV1,
    });
    expect(() => SpawnDaemonSessionRequestSchema.parse({
      directory: '/tmp/voice',
      nativeForkSource: {
        sessionId: 'host-parent',
        providerSessionId: 'provider-parent',
        cwd: '/source',
      },
      agentSessionStartupInstructionsV1,
    })).toThrow();
  });

  it('keeps old-UI requests without startup instructions valid and absent', () => {
    const parsed = SpawnDaemonSessionRequestSchema.parse({
      directory: '/tmp/ordinary',
      backendTarget: {
        kind: 'backend',
        backendId: 'codex',
        sourceKind: 'built_in',
      },
    });

    expect(parsed).not.toHaveProperty('agentSessionStartupInstructionsV1');
  });

  it('preserves one strict secret-free native fork-open source', () => {
    const nativeForkSource = {
      sessionId: 'host-parent',
      providerSessionId: 'provider-parent',
      cwd: '/source',
      target: {
        turnId: 'host-turn-42',
        providerCheckpoint: { kind: 'grok_prompt_index', promptIndex: 42 },
      },
    };

    expect(SpawnDaemonSessionRequestSchema.parse({
      directory: '/fork',
      nativeForkSource,
    }).nativeForkSource).toEqual(nativeForkSource);
    expect(() => SpawnDaemonSessionRequestSchema.parse({
      directory: '/fork',
      nativeForkSource: {
        sessionId: 'host-parent',
        providerSessionId: 'provider-parent',
        cwd: '/source',
        target: { turnId: 'host-turn-42' },
      },
    })).toThrow();
  });

  it('rejects a native fork checkpoint larger than the canonical turn checkpoint limit', () => {
    expect(() => SpawnDaemonSessionRequestSchema.parse({
      directory: '/fork',
      nativeForkSource: {
        sessionId: 'host-parent',
        providerSessionId: 'provider-parent',
        cwd: '/source',
        target: {
          turnId: 'host-turn-42',
          providerCheckpoint: 'x'.repeat(4097),
        },
      },
    })).toThrow();
  });

  it('accepts exact pending first-input custody and rejects blank handoffs', () => {
    expect(SpawnDaemonSessionRequestSchema.parse({
      directory: '/tmp/repo',
      pendingFirstInput: {
        text: '  exact prompt bytes  ',
        localId: '  opaque local id  ',
      },
    }).pendingFirstInput).toEqual({
      text: '  exact prompt bytes  ',
      localId: '  opaque local id  ',
    });

    expect(() => SpawnDaemonSessionRequestSchema.parse({
      directory: '/tmp/repo',
      pendingFirstInput: { text: '   ', localId: 'spawn-first-turn:launch-1' },
    })).toThrow();
    expect(() => SpawnDaemonSessionRequestSchema.parse({
      directory: '/tmp/repo',
      pendingFirstInput: { text: 'hello', localId: '   ' },
    })).toThrow();
  });

  it('preserves pending first-input custody through the canonical options merge', () => {
    const pendingFirstInput = {
      text: '  exact prompt bytes  ',
      localId: '  opaque local id  ',
    };

    expect(mergeSpawnSessionOptions({
      directory: '/tmp/repo',
      pendingFirstInput,
    })).toEqual({
      directory: '/tmp/repo',
      pendingFirstInput,
    });
  });

  it('normalizes deployed bare model input to a target-bound native selection', () => {
    const parsed = SpawnDaemonSessionRequestSchema.parse({
      directory: '/tmp',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      modelId: 'gpt-legacy',
      modelUpdatedAt: 42,
    });
    expect(parsed.modelSelection).toEqual({
      v: 1,
      updatedAt: 42,
      ref: { agentTargetKey: 'backend:codex', providerConnectionId: null, modelId: 'gpt-legacy' },
    });
    expect(parsed).not.toHaveProperty('modelId');
    expect(parsed).not.toHaveProperty('modelUpdatedAt');
  });

  it('preserves matching provider-bound identity and rejects a target mismatch', () => {
    const modelSelection = {
      v: 1 as const,
      updatedAt: 42,
      ref: { agentTargetKey: 'backend:codex', providerConnectionId: 'pc_work', modelId: 'provider-model' },
    };
    expect(SpawnDaemonSessionRequestSchema.parse({
      directory: '/tmp',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      modelSelection,
    }).modelSelection).toEqual(modelSelection);
    expect(() => SpawnDaemonSessionRequestSchema.parse({
      directory: '/tmp',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      modelSelection: { ...modelSelection, ref: { ...modelSelection.ref, agentTargetKey: 'backend:claude' } },
    })).toThrow(/target/i);
  });

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
      executionAuthorization: {
        provenance: 'user_request',
        requestId: ' pending-local-36 ',
      },
    });

    expect(parsed.initialTranscriptAfterSeq).toBe(36);
    expect(pickDefinedSpawnSessionOptions(parsed)).toEqual(expect.objectContaining({
      initialTranscriptAfterSeq: 36,
      executionAuthorization: {
        provenance: 'user_request',
        requestId: ' pending-local-36 ',
      },
    }));
  });

  it('does not accept first-turn content on the daemon spawn contract', () => {
    const parsed = SpawnDaemonSessionRequestSchema.parse({
      directory: '/tmp',
      spawnNonce: 'nonce-first-turn',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      initialPrompt: 'send this first turn',
    });

    expect(parsed.spawnNonce).toBe('nonce-first-turn');
    expect(parsed).not.toHaveProperty('initialPrompt');
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
        agentId: 'codex',
        agent: {
          backendMode: 'appServer',
          providerSessionId: 'runtime-thread',
        },
      },
    });

    expect(parsed.runtimeDescriptorV1).toEqual({
      v: 1,
      agentId: 'codex',
      agent: {
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
        agentId: 'codex',
        agent: {
          backendMode: 'appServer',
          providerSessionId: 'canonical-thread',
        },
      },
      agentRuntimeDescriptorV1: {
        v: 1,
        agentId: 'codex',
        agent: {
          backendMode: 'acp',
          providerSessionId: 'legacy-thread',
        },
      },
    });

    expect(parsed.runtimeDescriptorV1).toEqual({
      v: 1,
      agentId: 'codex',
      agent: {
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
        agentId: 'codex',
        agent: {
          backendMode: 'appServer',
          providerSessionId: 'runtime-thread',
        },
      },
    })).toEqual({
      directory: '/tmp',
      runtimeDescriptorV1: {
        v: 1,
        agentId: 'codex',
        agent: {
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
