import { beforeEach, describe, expect, it, vi } from 'vitest';

const { readAgentCatalogSnapshot } = vi.hoisted(() => ({
  readAgentCatalogSnapshot: vi.fn(),
}));

vi.mock('@/agent/catalog/snapshot', () => ({
  readAgentCatalogSnapshot,
}));

import {
  mergeSpawnSessionOptions,
  SpawnDaemonSessionRequestSchema,
  pickDefinedSpawnSessionOptions,
} from './spawnSessionOptionsContract';

describe('SpawnDaemonSessionRequestSchema', () => {
  it('preserves an authored workspace ceiling through daemon admission', () => {
    const request = { directory: '/workspace', workspaceWrites: 'deny' };
    expect(pickDefinedSpawnSessionOptions(SpawnDaemonSessionRequestSchema.parse(request))).toMatchObject(request);
  });
  it('preserves a strict private managed fork seed without accepting arbitrary source fields', () => {
    const request = { directory: '/private/child', directoryKind: 'managed', managedDirectorySeed: {
      sourceSessionId: 'source-1', sourcePath: '/private/source',
    } };
    expect(SpawnDaemonSessionRequestSchema.parse(request)).toMatchObject(request);
    expect(pickDefinedSpawnSessionOptions(SpawnDaemonSessionRequestSchema.parse(request))).toMatchObject(request);
    expect(SpawnDaemonSessionRequestSchema.safeParse({ ...request, managedDirectorySeed: { ...request.managedDirectorySeed, copyAnything: true } }).success).toBe(false);
  });
  it('preserves private fresh-row evidence on an already committed replay attachment', () => {
    const request = { directory: '/private/allocation', existingSessionId: 'replay-child', freshSessionCreation: true };
    expect(SpawnDaemonSessionRequestSchema.parse(request)).toMatchObject(request);
  });
  it.each([
    null,
    {},
    { v: 1, bindingsByServiceId: { 'happier.agent.codex/openai-codex': { source: 'connected' } } },
    { v: 1, bindingsByServiceId: { 'happier.agent.codex/openai-codex': { source: 'connected', selection: 'group', groupId: '../invalid', profileId: 'work' } } },
  ])('rejects malformed present connected-account intent: %j', (connectedServices) => {
    const result = SpawnDaemonSessionRequestSchema.safeParse({ directory: '/workspace', connectedServices });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.path[0]).toBe('connectedServices');
  });

  it('admits an empty V2 binding map as the distinct "no explicit binding" state', () => {
    // normalizeConnectedServiceSelectionInput.ts:37-40 keeps "no selection
    // supplied", "a named service wants its account default" and "no explicit
    // binding" as three distinct states; an empty canonical map is the third,
    // not malformed input.
    const result = SpawnDaemonSessionRequestSchema.safeParse({
      directory: '/workspace',
      connectedServices: { v: 2, bindingsByServiceId: {} },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.connectedServices).toEqual({ v: 2, bindingsByServiceId: {} });
    }
  });

  it('normalizes supported scalar profile and group selections at spawn ingress', () => {
    const parsed = SpawnDaemonSessionRequestSchema.parse({
      directory: '/workspace',
      connectedServices: { v: 1, bindingsByServiceId: {
        'openai-codex': { source: 'connected', profileId: 'work' },
        anthropic: { source: 'connected', selection: 'group', groupId: 'team' },
      } },
    });
    // The ingress writes the canonical current spelling; `v: 1` stays a
    // supported input shape, never an output one.
    expect(parsed.connectedServices).toEqual({ v: 2, bindingsByServiceId: {
      'happier.agent.codex/openai-codex': { source: 'connected', selection: 'profile', profileId: 'work' },
      'happier.agent.claude/anthropic': { source: 'connected', selection: 'group', groupId: 'team' },
    } });
  });

  it('accepts only the strict Machine Pool placement origin', () => {
    const request = {
      directory: '/workspace/project',
      placementOrigin: {
        kind: 'machine_pool' as const,
        poolId: '0191f11b-4ab2-7ef2-8dd2-268abc9c191f',
      },
    };

    expect(SpawnDaemonSessionRequestSchema.parse(request)).toMatchObject(request);
    expect(SpawnDaemonSessionRequestSchema.safeParse({
      ...request,
      placementOrigin: { ...request.placementOrigin, name: 'Private pool' },
    }).success).toBe(false);
    expect(SpawnDaemonSessionRequestSchema.safeParse({
      ...request,
      existingSessionId: 'existing-session',
    }).success).toBe(false);
  });

  beforeEach(() => {
    readAgentCatalogSnapshot.mockReturnValue({
      agentDefinitionsById: new Map(),
      catalogEntriesById: {
        codex: { id: 'codex', cliSubcommand: 'codex', vendorResumeSupport: 'supported' },
        'acme-agent': {
          id: 'acme-agent',
          cliSubcommand: 'acme-agent',
          vendorResumeSupport: 'supported',
        },
      },
    });
  });

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

  it('accepts exact text or structured pending first-input custody and rejects empty handoffs', () => {
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

    expect(SpawnDaemonSessionRequestSchema.parse({
      directory: '/tmp/repo',
      pendingFirstInput: {
        text: '',
        localId: 'spawn-first-turn:structured',
        meta: {
          happierStructuredInputV1: {
            v: 1,
            composerAttachments: [{
              v: 1,
              instanceId: 'spawn-first-turn:structured#0',
              attachment: { pluginId: 'happier.triage', localId: 'entry' },
              key: 'entry:42',
              value: { v: 1, entryId: '42' },
              presentation: { label: 'Fix the race', typeLabel: 'Triage entry' },
            }],
          },
        },
      },
    }).pendingFirstInput).toMatchObject({
      text: '',
      localId: 'spawn-first-turn:structured',
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

  it('accepts Workflow V2 pending first input without requiring an Automation id', () => {
    const parsed = SpawnDaemonSessionRequestSchema.parse({
      directory: '/tmp/repo',
      pendingFirstInput: {
        text: 'workflow first turn',
        localId: 'workflow-input-v2:stable',
        inputAdmission: {
          provenance: {
            v: 2,
            kind: 'workflow_invocation',
            runId: 'run-1',
            invocationRecordId: 'invocation-1',
          },
          request: {
            v: 2,
            producer: 'workflow',
            caller: { kind: 'host' },
            workflow: {
              purpose: 'invocation',
              runId: 'run-1',
              invocationRecordId: 'invocation-1',
            },
            permission: { requestedPermissionCeiling: 'read-only' },
          },
        },
      },
    });

    expect(parsed.pendingFirstInput?.inputAdmission).toMatchObject({
      provenance: { v: 2, kind: 'workflow_invocation' },
      request: { v: 2, producer: 'workflow' },
    });
  });

  it('retains Team resource identity through canonical daemon spawn admission', () => {
    const modelSelection = { v: 2 as const, updatedAt: 42, ref: { source: 'team_resource' as const,
      agentTargetKey: 'agent:happier.agent.codex/codex', modelId: 'team-model', resourceId: 'resource-1',
      teamId: 'team-1', expectedResourceRevision: 4, deliveryMode: 'brokered' as const } };
    const request = { directory: '/tmp', agentTarget: { kind: 'agent' as const,
      identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } };
    expect(SpawnDaemonSessionRequestSchema.parse({ ...request, modelSelection }).modelSelection).toEqual(modelSelection);
    expect(SpawnDaemonSessionRequestSchema.parse(request).modelSelection).toBeUndefined();
    expect(SpawnDaemonSessionRequestSchema.safeParse({ ...request, modelSelection: null }).success).toBe(false);
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
      ref: { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: null, modelId: 'gpt-legacy' },
    });
    expect(parsed).not.toHaveProperty('modelId');
    expect(parsed).not.toHaveProperty('modelUpdatedAt');
  });

  it('preserves matching provider-bound identity and rejects a target mismatch', () => {
    const modelSelection = {
      v: 1 as const,
      updatedAt: 42,
      // The app and the public Action author this canonical key; the daemon
      // keys the same bundled Agent identically from its routing target.
      ref: { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: 'pc_work', modelId: 'provider-model' },
    };
    expect(SpawnDaemonSessionRequestSchema.parse({
      directory: '/tmp',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      modelSelection,
    }).modelSelection).toEqual(modelSelection);
    expect(() => SpawnDaemonSessionRequestSchema.parse({
      directory: '/tmp',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      modelSelection: { ...modelSelection, ref: { ...modelSelection.ref, agentTargetKey: 'agent:happier.agent.claude/claude' } },
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

  it('accepts an installed external Session Agent from V2 and legacy transport input', () => {
    expect(SpawnDaemonSessionRequestSchema.parse({
      directory: '/tmp',
      backendTarget: { kind: 'backend', backendId: 'acme-agent', sourceKind: 'built_in' },
    }).backendTarget).toEqual({
      kind: 'backend',
      backendId: 'acme-agent',
      sourceKind: 'built_in',
    });

    expect(SpawnDaemonSessionRequestSchema.parse({
      directory: '/tmp',
      agent: 'acme-agent',
    }).backendTarget).toEqual({
      kind: 'backend',
      backendId: 'acme-agent',
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

  it('admits an initial goal on resume and preserves it for the runtime', () => {
    const initialGoal = { objective: 'Finish the review' };
    const parsed = SpawnDaemonSessionRequestSchema.parse({
      type: 'resume-session',
      directory: '/tmp',
      existingSessionId: 'session-1',
      initialGoal,
    });

    expect(pickDefinedSpawnSessionOptions(parsed).initialGoal).toEqual(initialGoal);
    expect(SpawnDaemonSessionRequestSchema.safeParse({
      directory: '/tmp',
      initialGoal,
    }).success).toBe(false);
  });

  it('rejects synthetic Action fields rather than stripping them from the daemon spawn contract', () => {
    const privateSpawn = {
      directory: '/tmp',
      spawnNonce: 'nonce-first-turn',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
    };

    for (const syntheticActionInput of [
      { tag: 'legacy-label' },
      { initialPrompt: 'send this first turn' },
      {
        tag: 'legacy-label',
        creationKey: 'create:feature-1',
        executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
        agentTarget: { kind: 'agent', agentId: 'codex' },
      },
    ]) {
      expect(SpawnDaemonSessionRequestSchema.safeParse({
        ...privateSpawn,
        ...syntheticActionInput,
      }).success).toBe(false);
    }
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

  it('maps legacy experimentalCodexAcp requests onto the canonical runtime descriptor', () => {
    const parsed = SpawnDaemonSessionRequestSchema.parse({
      directory: '/tmp',
      experimentalCodexAcp: true,
    });

    expect(parsed.runtimeDescriptorV1).toEqual({
      v: 1,
      agentId: 'codex',
      agent: { backendMode: 'acp' },
    });
    expect(parsed).not.toHaveProperty('experimentalCodexAcp');
    expect(parsed).not.toHaveProperty('codexBackendMode');
  });

  it('drops legacy experimentalCodexAcp when false', () => {
    const parsed = SpawnDaemonSessionRequestSchema.parse({
      directory: '/tmp',
      experimentalCodexAcp: false,
    });

    expect(parsed.runtimeDescriptorV1).toBeUndefined();
    expect(parsed).not.toHaveProperty('experimentalCodexAcp');
  });

  it('normalizes released codex backend mode from the transport request', () => {
    const parsed = SpawnDaemonSessionRequestSchema.parse({
      directory: '/tmp',
      codexBackendMode: 'appServer',
    });

    expect(parsed.runtimeDescriptorV1).toEqual({
      v: 1,
      agentId: 'codex',
      agent: { backendMode: 'appServer' },
    });
    expect(parsed).not.toHaveProperty('codexBackendMode');
  });

  it('prefers the opaque current descriptor over a conflicting released Codex ingress hint', () => {
    const parsed = SpawnDaemonSessionRequestSchema.parse({
      directory: '/tmp',
      codexBackendMode: 'acp',
      runtimeDescriptorV1: {
        v: 1,
        agentId: 'codex',
        agent: { backendMode: 'appServer' },
      },
    });

    expect(parsed.runtimeDescriptorV1).toEqual({
      v: 1,
      agentId: 'codex',
      agent: { backendMode: 'appServer' },
    });
    expect(parsed).not.toHaveProperty('codexBackendMode');
  });

  it('preserves a qualified Agent target and binds model selection to it', () => {
    const agentTarget = {
      kind: 'agent' as const,
      identity: { pluginId: 'acme.agent.runtime', localId: 'runtime' },
    };
    const parsed = SpawnDaemonSessionRequestSchema.parse({
      directory: '/tmp',
      agentTarget,
      modelSelection: {
        v: 1,
        updatedAt: 42,
        ref: {
          agentTargetKey: 'agent:acme.agent.runtime/runtime',
          providerConnectionId: null,
          modelId: 'model-1',
        },
      },
    });

    expect(parsed.agentTarget).toEqual(agentTarget);
    expect(pickDefinedSpawnSessionOptions(parsed).agentTarget).toEqual(agentTarget);
  });

  it('rejects the undeployed generic backendMode alias', () => {
    expect(() => SpawnDaemonSessionRequestSchema.parse({
      directory: '/tmp',
      backendMode: 'appServer',
    })).toThrow();
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

  it('accepts the deployed agentRuntimeDescriptorV1 private transport alias', () => {
    const parsed = SpawnDaemonSessionRequestSchema.parse({
      directory: '/tmp',
      agentRuntimeDescriptorV1: {
        v: 1,
        agentId: 'codex',
        agent: {
          backendMode: 'appServer',
          providerSessionId: 'legacy-private-thread',
        },
      },
    });

    expect(parsed.runtimeDescriptorV1).toEqual({
      v: 1,
      agentId: 'codex',
      agent: {
        backendMode: 'appServer',
        providerSessionId: 'legacy-private-thread',
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
