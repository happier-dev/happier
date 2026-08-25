import { describe, expect, it } from 'vitest';

import {
  ExternalSessionsAgentIdSchema,
  ExternalSessionAttachRequestSchema,
  ExternalSessionAttachResponseSchema,
  ExternalSessionDetachRequestSchema,
  ExternalSessionFollowPolicySetRequestSchema,
  ExternalSessionLinkEnsureRequestSchema,
  ExternalSessionsCandidatesListResponseSchema,
  ExternalSessionStatusGetResponseSchema,
  ExternalSessionStatusGetRequestSchema,
  ExternalSessionsCandidatesListRequestSchema,
  ExternalSessionTranscriptPageRequestSchema,
  ExternalSessionTranscriptReadAfterRequestSchema,
  ExternalSessionTranscriptRawMessageV1Schema,
  ExternalSessionsSourceSchema,
} from './daemonRpcV1';
import * as daemonRpcV1 from './daemonRpcV1';
import { AgentProviderIdV1Schema } from '../../generated/providers/agentProviderIdsV1';
import { SessionIndexedIdentifierMaxLengthV1 } from '../idsV1';
import { resolveExternalSessionsSourceKey } from './sourceCatalog';

describe('ExternalSessionsAgentIdSchema', () => {
  it('admits bounded manifest-projected Agent ids without adding them to a static protocol enum', () => {
    expect(AgentProviderIdV1Schema.parse('antigravity')).toBe('antigravity');
    expect(AgentProviderIdV1Schema.parse('pi')).toBe('pi');
    expect(AgentProviderIdV1Schema.parse('ohMyPi')).toBe('ohMyPi');
    expect(ExternalSessionsAgentIdSchema.parse('codex')).toBe('codex');
    expect(ExternalSessionsAgentIdSchema.parse('ohMyPi')).toBe('ohMyPi');
    expect(ExternalSessionsAgentIdSchema.parse('antigravity')).toBe('antigravity');
    expect(ExternalSessionsAgentIdSchema.parse('pi')).toBe('pi');
    expect(ExternalSessionsAgentIdSchema.parse('external-only-agent')).toBe('external-only-agent');
    expect(ExternalSessionsAgentIdSchema.safeParse('   ').success).toBe(false);
    expect(ExternalSessionsAgentIdSchema.safeParse(' codex ').success).toBe(false);
    expect(ExternalSessionsAgentIdSchema.safeParse('a'.repeat(129)).success).toBe(false);
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

  it('validates canonical message-role metadata on raw transcript items', () => {
    const item = {
      id: 'external-1',
      createdAtMs: 1_700,
      raw: { role: 'agent', content: { type: 'output', data: { type: 'assistant' } } },
    };

    expect(ExternalSessionTranscriptRawMessageV1Schema.parse({ ...item, messageRole: 'event' })).toMatchObject({
      messageRole: 'event',
    });
    expect(ExternalSessionTranscriptRawMessageV1Schema.safeParse({ ...item, messageRole: 'not-a-role' }).success).toBe(false);
  });

  it('admits a storage-safe sidechain identity and rejects malformed values', () => {
    const item = {
      id: 'external-sidechain-1',
      createdAtMs: 1_700,
      raw: { role: 'agent', content: { type: 'output', data: { type: 'assistant' } } },
    };
    const sidechainId = 's'.repeat(SessionIndexedIdentifierMaxLengthV1);

    expect(ExternalSessionTranscriptRawMessageV1Schema.parse({
      ...item,
      sidechainId,
    })).toMatchObject({ sidechainId });
    expect(ExternalSessionTranscriptRawMessageV1Schema.parse({
      ...item,
      sidechainId: ` ${sidechainId} `,
    })).toMatchObject({ sidechainId });
    expect(ExternalSessionTranscriptRawMessageV1Schema.safeParse({
      ...item,
      sidechainId: `${sidechainId}s`,
    }).success).toBe(false);
    expect(ExternalSessionTranscriptRawMessageV1Schema.safeParse({
      ...item,
      sidechainId: '',
    }).success).toBe(false);
  });

  it('accepts only the canonical terminal user-row classifications', () => {
    const item = {
      id: 'external-user-1',
      createdAtMs: 1_700,
      raw: { role: 'user', content: { type: 'text', text: 'hello' } },
    };

    for (const userProjection of [
      'source_fact',
      'terminal_origin',
      'host_prompt_echo',
    ] as const) {
      expect(ExternalSessionTranscriptRawMessageV1Schema.parse({
        ...item,
        userProjection,
      })).toMatchObject({ userProjection });
    }
    expect(ExternalSessionTranscriptRawMessageV1Schema.safeParse({
      ...item,
      userProjection: 'guessed_echo',
    }).success).toBe(false);
  });

  it('retains additive legacy item and raw fields without granting them canonical meaning', () => {
    expect(ExternalSessionTranscriptRawMessageV1Schema.parse({
      id: 'external-legacy-1',
      createdAtMs: 1_700,
      futureItemField: 'retained',
      raw: { role: 'agent', futureRawField: 'retained' },
    })).toMatchObject({
      futureItemField: 'retained',
      raw: { futureRawField: 'retained' },
    });
  });
});

describe('ExternalSessionStatusGetResponseSchema', () => {
  const response = {
    ok: true,
    machineOnline: true,
    runnerActive: false,
    activity: 'running',
    canTakeOverDirect: true,
    canTakeOverPersist: true,
    canForceStop: false,
    trustedPid: null,
  } as const;
  const externalAgent = {
    v: 1,
    qualifiedLinkIdentity: {
      v: 1,
      agent: {
        pluginId: 'happier.opencode',
        localId: 'opencode',
      },
      source: {
        kind: 'opencode.server',
        contractVersion: 1,
      },
    },
    linkGeneration: 'link-generation-1',
    status: 'working',
    observedAtMs: 1_000,
    expiresAtMs: 2_000,
  } as const;

  it('admits the canonical external-Agent snapshot or explicit absence', () => {
    expect(ExternalSessionStatusGetResponseSchema.parse({
      ...response,
      externalAgent,
    })).toMatchObject({ externalAgent });
    expect(ExternalSessionStatusGetResponseSchema.parse({
      ...response,
      externalAgent: null,
    })).toMatchObject({ externalAgent: null });
  });

  it('strictly validates the canonical snapshot carried by status', () => {
    expect(ExternalSessionStatusGetResponseSchema.safeParse({
      ...response,
      externalAgent: {
        ...externalAgent,
        nativePayload: { status: 'busy' },
      },
    }).success).toBe(false);
  });
});

describe('ExternalSessionsSourceSchema', () => {
  it('admits bounded manifest-declared source envelopes for runtime semantic validation', () => {
    expect(ExternalSessionsSourceSchema.parse({
      kind: 'piAgentDir',
      agentDir: '/tmp/pi',
    })).toEqual({
      kind: 'piAgentDir',
      agentDir: '/tmp/pi',
    });
    expect(ExternalSessionsSourceSchema.parse({
      kind: 'antigravityCliPrint',
      workspace: '/tmp/project',
    })).toEqual({
      kind: 'antigravityCliPrint',
      workspace: '/tmp/project',
    });
    expect(ExternalSessionsSourceSchema.parse({
      kind: 'syntheticSource',
      value: 'configured',
    })).toEqual({
      kind: 'syntheticSource',
      value: 'configured',
    });
    expect(ExternalSessionsSourceSchema.safeParse({ kind: '' }).success).toBe(false);
    expect(ExternalSessionsSourceSchema.safeParse({ kind: ' codexHome ' }).success).toBe(false);
    expect(ExternalSessionsSourceSchema.safeParse({ kind: 'syntheticSource', value: Symbol('no-json') }).success).toBe(false);
  });

  it('normalizes released providerId request identity before canonical action parsing', () => {
    const source = { kind: 'codexHome', home: 'user' } as const;
    const cases = [
      [ExternalSessionsCandidatesListRequestSchema, { machineId: 'machine-1', providerId: 'codex', source }],
      [ExternalSessionStatusGetRequestSchema, { machineId: 'machine-1', sessionId: 'session-1', providerId: 'codex', remoteSessionId: 'remote-1', source }],
      [ExternalSessionTranscriptPageRequestSchema, { machineId: 'machine-1', providerId: 'codex', remoteSessionId: 'remote-1', source, direction: 'older' }],
      [ExternalSessionTranscriptReadAfterRequestSchema, { machineId: 'machine-1', providerId: 'codex', remoteSessionId: 'remote-1', source, cursor: 'released-cursor' }],
    ] as const;

    for (const [schema, value] of cases) {
      expect(schema.parse(value)).toMatchObject({ agentId: 'codex' });
    }
  });

  it('admits only the explicit fresh takeover-readiness intent', () => {
    const request = {
      machineId: 'machine-1',
      sessionId: 'session-1',
      agentId: 'codex',
      remoteSessionId: 'remote-1',
      source: { kind: 'codexHome', home: 'user' },
    } as const;

    expect(ExternalSessionStatusGetRequestSchema.parse({
      ...request,
      takeoverReadiness: 'fresh',
    })).toMatchObject({
      takeoverReadiness: 'fresh',
    });
    expect(ExternalSessionStatusGetRequestSchema.safeParse({
      ...request,
      takeoverReadiness: 'stale',
    }).success).toBe(false);
  });

  it('accepts only exact provider-only released request identity', () => {
    const base = {
      machineId: 'machine-1',
      source: { kind: 'codexHome', home: 'user' },
    } as const;

    expect(ExternalSessionsCandidatesListRequestSchema.safeParse({
      ...base,
      agentId: 'claude',
      providerId: 'codex',
    }).success).toBe(false);
    expect(ExternalSessionsCandidatesListRequestSchema.safeParse({
      ...base,
      agentId: 'codex',
      providerId: 'codex',
    }).success).toBe(false);
    expect(ExternalSessionsCandidatesListRequestSchema.safeParse({
      ...base,
      providerId: ' codex ',
    }).success).toBe(false);
  });

  it('rejects undeclared authority fields on current requests', () => {
    expect(ExternalSessionAttachRequestSchema.safeParse({
      machineId: 'machine-1',
      sessionId: 'session-1',
      agentId: 'codex',
      remoteSessionId: 'remote-1',
      source: { kind: 'codexHome', home: 'user' },
      futureAttachFlag: 'must-not-reach-an-action',
    }).success).toBe(false);

    expect(ExternalSessionStatusGetRequestSchema.safeParse({
      machineId: 'machine-1',
      sessionId: 'session-1',
      agentId: 'codex',
      remoteSessionId: 'remote-1',
      source: { kind: 'codexHome', home: 'user' },
      runtimeDescriptor: {
        v: 1,
        providerId: 'codex',
        provider: { backendMode: 'appServer', providerSessionId: 'thread-1' },
      },
    }).success).toBe(false);

    expect(ExternalSessionLinkEnsureRequestSchema.safeParse({
      machineId: 'machine-1',
      agentId: 'codex',
      remoteSessionId: 'remote-1',
      source: { kind: 'codexHome', home: 'user' },
      runtimeDescriptor: {
        v: 1,
        providerId: 'codex',
        provider: { backendMode: 'appServer', providerSessionId: 'thread-1' },
      },
    }).success).toBe(false);

    expect(ExternalSessionLinkEnsureRequestSchema.safeParse({
      machineId: 'machine-1',
      providerId: 'codex',
      remoteSessionId: 'remote-1',
      source: { kind: 'codexHome', home: 'user' },
      runtimeDescriptorV1: {
        v: 1,
        agentId: 'codex',
        agent: { backendMode: 'appServer', providerSessionId: 'thread-1' },
      },
    }).success).toBe(false);
  });

  it('normalizes released runtimeDescriptor and rejects descriptor disagreement', () => {
    const request = {
      machineId: 'machine-1',
      providerId: 'codex',
      remoteSessionId: 'remote-1',
      source: { kind: 'codexHome', home: 'user' },
      runtimeDescriptor: {
        v: 1,
        providerId: 'codex',
        provider: { backendMode: 'appServer', providerSessionId: 'thread-1' },
      },
    } as const;
    expect(ExternalSessionLinkEnsureRequestSchema.parse(request)).toMatchObject({
      agentId: 'codex',
      runtimeDescriptorV1: {
        v: 1,
        agentId: 'codex',
        agent: { backendMode: 'appServer', providerSessionId: 'thread-1' },
      },
    });
    expect(ExternalSessionLinkEnsureRequestSchema.safeParse({
      ...request,
      agentId: 'codex',
      runtimeDescriptorV1: {
        v: 1,
        agentId: 'codex',
        agent: { backendMode: 'appServer', providerSessionId: 'thread-2' },
      },
    }).success).toBe(false);
  });

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

  it('preserves unknown future Codex backend modes for the Codex leaf to validate', () => {
    const parsed = ExternalSessionLinkEnsureRequestSchema.parse({
      machineId: 'machine-1',
      agentId: 'codex',
      remoteSessionId: 'remote-1',
      source: {
        kind: 'codexHome',
        home: 'user',
      },
      codexBackendMode: 'future-codex-mode',
    });

    expect(parsed.codexBackendMode).toBe('future-codex-mode');
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
      acceptedTailCursor: 'happier_external_cursor_v1:Y3Vyc29yLTA',
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
      acceptedTailCursor: 'happier_external_cursor_v1:Y3Vyc29yLTA',
    });
    expect((parsed as any).source.futureSourceFlag).toBe('keep-me');
  });

  it('rejects an empty accepted transcript tail cursor on attach', () => {
    expect(() => ExternalSessionAttachRequestSchema.parse({
      machineId: 'machine-1',
      sessionId: 'session-1',
      agentId: 'opencode',
      remoteSessionId: 'remote-1',
      source: {
        kind: 'opencodeServer',
        directory: '/tmp/workspace',
      },
      acceptedTailCursor: '   ',
    })).toThrow();
    expect(() => ExternalSessionAttachRequestSchema.parse({
      machineId: 'machine-1',
      sessionId: 'session-1',
      agentId: 'opencode',
      remoteSessionId: 'remote-1',
      source: {
        kind: 'opencodeServer',
        directory: '/tmp/workspace',
      },
      acceptedTailCursor: 'source-native-cursor',
    })).toThrow();
    expect(() => ExternalSessionAttachRequestSchema.parse({
      machineId: 'machine-1',
      sessionId: 'session-1',
      agentId: 'opencode',
      remoteSessionId: 'remote-1',
      source: {
        kind: 'opencodeServer',
        directory: '/tmp/workspace',
      },
      acceptedTailCursor: `happier_external_cursor_v1:${'a'.repeat(4_096)}`,
    })).toThrow();
  });

  it('uses the same strict accepted tail cursor contract in successful attach responses', () => {
    expect(ExternalSessionAttachResponseSchema.parse({
      ok: true,
      leaseId: 'lease-1',
      expiresAtMs: 42_000,
      acceptedTailCursor: 'happier_external_cursor_v1:Y3Vyc29yLTA',
    })).toEqual({
      ok: true,
      leaseId: 'lease-1',
      expiresAtMs: 42_000,
      acceptedTailCursor: 'happier_external_cursor_v1:Y3Vyc29yLTA',
    });
    expect(() => ExternalSessionAttachResponseSchema.parse({
      ok: true,
      leaseId: 'lease-1',
      expiresAtMs: 42_000,
      acceptedTailCursor: '',
    })).toThrow();
  });

  it('type-preserves attach failure retryability across the released producer directions', () => {
    const nonRetryable = ExternalSessionAttachResponseSchema.parse({
      ok: false,
      errorCode: 'agent_unavailable',
      error: 'external_session_follow_unavailable',
      retryable: false,
    });
    expect(nonRetryable).toEqual({
      ok: false,
      errorCode: 'agent_unavailable',
      error: 'external_session_follow_unavailable',
      retryable: false,
    });
    if (nonRetryable.ok) throw new Error('expected an attach failure');
    // Typed, not an opaque passthrough bag: the consumer decides on this value.
    const retryable: boolean | undefined = nonRetryable.retryable;
    expect(retryable).toBe(false);

    // Released producers (cli-v0.2.x, the inspected remote-dev predecessor)
    // answer without the field; the consumer must keep retrying those.
    const released = ExternalSessionAttachResponseSchema.parse({
      ok: false,
      errorCode: 'machine_offline',
      error: 'machine_offline',
    });
    if (released.ok) throw new Error('expected an attach failure');
    expect(released.retryable).toBeUndefined();

    expect(() => ExternalSessionAttachResponseSchema.parse({
      ok: false,
      errorCode: 'agent_unavailable',
      error: 'external_session_follow_unavailable',
      retryable: 'no',
    })).toThrow();
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
    })).toBe('codexHome:connectedService:openai-codex:group%3Ateam:/tmp/connected/__groups/team/codex/codex-home');
    expect(resolveExternalSessionsSourceKey({
      kind: 'ohMyPiAgentDir',
      agentDir: '/tmp/omp-agent',
    })).toBe('ohMyPiAgentDir:/tmp/omp-agent');
  });
});

describe('ExternalSessionsCandidatesListResponseSchema', () => {
  it('accepts only a strict content-free auto-link policy scope on success', () => {
    const scope = {
      qualifiedIdentity: {
        v: 1,
        agent: {
          pluginId: 'com.example.external-agent',
          localId: 'assistant',
        },
        source: {
          kind: 'claudeConfig',
          contractVersion: 1,
        },
      },
      sourcePolicyId: `es-source-policy:v1:${'a'.repeat(64)}`,
    };
    expect(ExternalSessionsCandidatesListResponseSchema.parse({
      ok: true,
      candidates: [],
      nextCursor: null,
      autoLinkPolicyScopeV1: scope,
    })).toEqual({
      ok: true,
      candidates: [],
      nextCursor: null,
      autoLinkPolicyScopeV1: scope,
    });

    for (const privateField of [
      { machineId: 'machine-1' },
      { sourceKey: 'claudeConfig:/private' },
      { source: { kind: 'claudeConfig', configDir: '/private' } },
      { path: '/private/session.jsonl' },
      { url: 'https://private.example' },
      { profile: 'work' },
      { service: 'connected-service-1' },
      { title: 'Private candidate' },
      { candidate: { remoteSessionId: 'private' } },
      { linkData: { projectId: 'private' } },
    ]) {
      expect(ExternalSessionsCandidatesListResponseSchema.safeParse({
        ok: true,
        candidates: [],
        autoLinkPolicyScopeV1: { ...scope, ...privateField },
      }).success).toBe(false);
    }

    expect(ExternalSessionsCandidatesListResponseSchema.safeParse({
      ok: false,
      errorCode: 'invalid_request',
      error: 'invalid_request',
      autoLinkPolicyScopeV1: scope,
    }).success).toBe(false);
  });

  it('admits only the strict visible candidate-index preparation state', () => {
    const response = {
      ok: true,
      candidates: [],
      nextCursor: null,
      preparation: {
        kind: 'building_candidate_index',
        scanned: 50,
        total: 10_000,
      },
    };

    expect(ExternalSessionsCandidatesListResponseSchema.parse(response)).toMatchObject(response);
    expect(ExternalSessionsCandidatesListResponseSchema.safeParse({
      ...response,
      preparation: {
        ...response.preparation,
        privateChunk: [{ remoteSessionId: 'must-not-cross-rpc' }],
      },
    }).success).toBe(false);
  });

  it('accepts bounded canonical link and import annotations on candidates', () => {
    const parsed = ExternalSessionsCandidatesListResponseSchema.parse({
      ok: true,
      candidates: [{
        remoteSessionId: 'remote-1',
        candidateKey: 'candidate-key-1',
        updatedAtMs: 1,
        linkedSessionId: 'session-1',
        imported: true,
        materializedThrough: 1_700_000_000_000,
      }],
      nextCursor: null,
      annotationsIncomplete: true,
    });

    expect(parsed.annotationsIncomplete).toBe(true);
    expect(parsed.candidates[0]).toMatchObject({
      candidateKey: 'candidate-key-1',
      linkedSessionId: 'session-1',
      imported: true,
      materializedThrough: 1_700_000_000_000,
    });
    expect(ExternalSessionsCandidatesListResponseSchema.safeParse({
      ok: true,
      candidates: [{
        remoteSessionId: 'remote-1',
        candidateKey: 'x'.repeat(129),
        updatedAtMs: 1,
      }],
      nextCursor: null,
    }).success).toBe(false);
    expect(ExternalSessionsCandidatesListResponseSchema.safeParse({
      ok: true,
      candidates: [{
        remoteSessionId: 'remote-1',
        updatedAtMs: 1,
        linkedSessionId: 'x'.repeat(2_001),
      }],
      nextCursor: null,
    }).success).toBe(false);
    expect(ExternalSessionsCandidatesListResponseSchema.safeParse({
      ok: true,
      candidates: [{
        remoteSessionId: 'remote-1',
        updatedAtMs: 1,
        materializedThrough: -1,
      }],
      nextCursor: null,
    }).success).toBe(false);
    expect(ExternalSessionsCandidatesListResponseSchema.safeParse({
      ok: true,
      candidates: [],
      nextCursor: null,
      annotationsIncomplete: 'unknown',
    }).success).toBe(false);
  });

  it('carries only bounded candidate link data into link ensure requests', () => {
    const linkData = { projectId: 'project-b' };
    expect(ExternalSessionsCandidatesListResponseSchema.parse({
      ok: true,
      candidates: [{
        remoteSessionId: 'duplicate-native-id',
        updatedAtMs: 1,
        linkData,
      }],
      nextCursor: null,
    }).candidates[0]?.linkData).toEqual(linkData);
    expect(ExternalSessionLinkEnsureRequestSchema.parse({
      machineId: 'machine-1',
      agentId: 'claude',
      remoteSessionId: 'duplicate-native-id',
      source: { kind: 'claudeConfig', configDir: '/tmp/claude' },
      linkData,
    }).linkData).toEqual(linkData);
    expect(ExternalSessionLinkEnsureRequestSchema.safeParse({
      machineId: 'machine-1',
      agentId: 'claude',
      remoteSessionId: 'duplicate-native-id',
      source: { kind: 'claudeConfig', configDir: '/tmp/claude' },
      linkData: [],
    }).success).toBe(false);
  });
});

describe('external-session cursor admission', () => {
  it('admits one cursor spelling across the daemon request and Action input routes', () => {
    const padded = '  happier_external_cursor_v1:abc-DEF_123  ';
    const canonical = 'happier_external_cursor_v1:abc-DEF_123';

    const request = daemonRpcV1.ExternalSessionAttachRequestSchema.safeParse({
      machineId: 'machine-1',
      sessionId: 'session-1',
      agentId: 'claude',
      remoteSessionId: 'remote-1',
      source: { kind: 'claudeConfig', configDir: '/tmp/claude' },
      acceptedTailCursor: padded,
    });
    expect(request.success).toBe(true);
    expect(request.success && request.data.acceptedTailCursor).toBe(canonical);

    const action = daemonRpcV1.ExternalSessionViewerFollowActionInputV1Schema.safeParse({
      sessionId: 'session-1',
      acceptedTailCursor: padded,
    });
    expect(action.success).toBe(true);
    expect(action.success && action.data.acceptedTailCursor).toBe(canonical);

    // Each route is rejected with its OWN minimal payload so the refusal is
    // attributable to the cursor: the Action input is `.strict()`, so a shared
    // daemon-shaped payload would be refused for `unrecognized_keys` whatever
    // the cursor said.
    const routes = [
      {
        schema: daemonRpcV1.ExternalSessionAttachRequestSchema,
        payload: (acceptedTailCursor: string) => ({
          machineId: 'machine-1',
          sessionId: 'session-1',
          agentId: 'claude',
          remoteSessionId: 'remote-1',
          source: { kind: 'claudeConfig', configDir: '/tmp/claude' },
          acceptedTailCursor,
        }),
      },
      {
        schema: daemonRpcV1.ExternalSessionViewerFollowActionInputV1Schema,
        payload: (acceptedTailCursor: string) => ({
          sessionId: 'session-1',
          acceptedTailCursor,
        }),
      },
    ];
    for (const route of routes) {
      expect(route.schema.safeParse(route.payload(canonical)).success).toBe(true);
      const rejected = route.schema.safeParse(route.payload('not-a-happier-cursor'));
      expect(rejected.success).toBe(false);
      expect(
        rejected.success
          ? []
          : rejected.error.issues.map((issue) => issue.path.join('.')),
      ).toEqual(['acceptedTailCursor']);
    }
  });
});
