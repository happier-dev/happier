import { describe, expect, it } from 'vitest';

import * as protocol from '../../index.js';
import { normalizeLegacyContinueWithReplayRpcParamsInput } from './compat/continueWithReplayRpcParamsCompat.js';
import { buildBackendTargetKeyV2, BackendTargetKeyV2InputSchema, parseBackendTargetKeyV2 } from './backendTargetRefV2.js';

describe('BackendTargetRefV2 compatibility', () => {
  it('roundtrips distinct configured definition keys under the same real Agent contribution', () => {
    const identity = { pluginId: 'happier.agent.custom-acp', localId: 'custom-acp' };
    const a = { kind: 'agent' as const, identity, definitionId: 'review-a' };
    const b = { kind: 'agent' as const, identity, definitionId: 'review-b' };
    const aKey = buildBackendTargetKeyV2(a);
    const bKey = buildBackendTargetKeyV2(b);
    expect(aKey).not.toBe(bKey);
    expect(parseBackendTargetKeyV2(aKey)).toEqual(a);
    expect(parseBackendTargetKeyV2(bKey)).toEqual(b);
    expect(buildBackendTargetKeyV2({ kind: 'backend', backendId: 'review-a', configuredBackendId: 'review-a' })).toBe(aKey);
  });
  it('keys an installed Agent routing ref by its contribution identity without collapsing configured instances', () => {
    const backendId = 'acme.review/reviewer';
    expect(buildBackendTargetKeyV2({ kind: 'backend', backendId })).toBe(`agent:${backendId}`);
    expect(BackendTargetKeyV2InputSchema.parse(`backend:${backendId}`)).toBe(`agent:${backendId}`);
    expect(buildBackendTargetKeyV2({ kind: 'backend', backendId, configuredBackendId: 'instance-1' }))
      .toBe('agent:happier.agent.custom-acp/custom-acp:definition:instance-1');
  });
  it('exports additive V2 backend target schemas and helpers', () => {
    expect(typeof (protocol as any).BackendTargetRefV2Schema?.safeParse).toBe('function');
    expect(typeof (protocol as any).BackendTargetKeyV2Schema?.safeParse).toBe('function');
    expect(typeof (protocol as any).buildBackendTargetKeyV2).toBe('function');
    expect(typeof (protocol as any).parseBackendTargetKeyV2).toBe('function');
    expect(typeof (protocol as any).readBackendTargetRefV2).toBe('function');
    expect((protocol as any).BackendTargetKeyV2Schema.safeParse(
      'agent:acme.plugin/provider',
    ).success).toBe(true);
    expect((protocol as any).BackendTargetKeyV2InputSchema.parse('agent:ohMyPi')).toBe(
      'agent:happier.agent.ohmypi/ohmypi',
    );
  });

  it('reads V2 targets, V2 keys, and legacy V1 shapes into the additive V2 form', () => {
    const direct = (protocol as any).readBackendTargetRefV2({
      kind: 'backend',
      backendId: 'claude',
    });

    const builtInFromKey = (protocol as any).parseBackendTargetKeyV2('backend:claude');
    const fromKey = (protocol as any).parseBackendTargetKeyV2('backend:codex:configured:team-review');

    const fromBuiltInV1 = (protocol as any).readBackendTargetRefV2({
      kind: 'builtInAgent',
      agentId: 'opencode',
    });

    const fromConfiguredV1 = (protocol as any).readBackendTargetRefV2({
      kind: 'configuredAcpBackend',
      backendId: 'review-bot',
    });

    expect(direct).toEqual({
      kind: 'backend',
      backendId: 'claude',
    });
    // One bundled Agent has exactly one key: its qualified contribution identity,
    // whether a writer holds the routing ref or the Agent execution target.
    expect((protocol as any).buildBackendTargetKeyV2(direct)).toBe('agent:happier.agent.claude/claude');
    expect((protocol as any).buildBackendTargetKeyV2({
      kind: 'agent',
      identity: { pluginId: 'happier.agent.claude', localId: 'claude' },
    })).toBe('agent:happier.agent.claude/claude');
    expect((protocol as any).readBackendTargetRefV2('agent:happier.agent.claude/claude')).toEqual({
      kind: 'backend',
      backendId: 'claude',
      sourceKind: 'built_in',
    });
    expect(builtInFromKey).toEqual({
      kind: 'backend',
      backendId: 'claude',
      sourceKind: 'built_in',
    });
    expect(fromKey).toEqual({
      kind: 'backend',
      backendId: 'codex',
      configuredBackendId: 'team-review',
      sourceKind: 'configured',
    });
    expect(fromBuiltInV1).toEqual({
      kind: 'backend',
      backendId: 'opencode',
      sourceKind: 'built_in',
    });
    expect(fromConfiguredV1).toEqual({
      kind: 'backend',
      backendId: 'review-bot',
      configuredBackendId: 'review-bot',
      sourceKind: 'configured',
    });
  });

  it('parses a qualified Agent key without collapsing its plugin identity', () => {
    expect((protocol as any).parseBackendTargetKeyV2(
      'agent:acme.review/reviewer',
    )).toEqual({
      kind: 'agent',
      identity: {
        pluginId: 'acme.review',
        localId: 'reviewer',
      },
    });
  });

  it('reads legacy V1 backend target key strings into the additive V2 form', () => {
    expect((protocol as any).readBackendTargetRefV2('agent:codex')).toEqual({
      kind: 'backend',
      backendId: 'codex',
      sourceKind: 'built_in',
    });
    expect((protocol as any).readBackendTargetRefV2('acpBackend:review-bot')).toEqual({
      kind: 'backend',
      backendId: 'review-bot',
      configuredBackendId: 'review-bot',
      sourceKind: 'configured',
    });
    // `agent:claude` is the key 0.2's `buildBackendTargetKey` writes for a
    // built-in Agent (produced by ../0.2 packages/protocol dist at ff95c165);
    // it reads as the same Agent's canonical key.
    expect((protocol as any).BackendTargetKeyV2InputSchema.parse('agent:claude')).toBe(
      'agent:happier.agent.claude/claude',
    );
    expect((protocol as any).BackendTargetKeyV2InputSchema.parse('acpBackend:claude')).toBe(
      'agent:happier.agent.custom-acp/custom-acp:definition:claude',
    );
  });

  it('retains the legacy builtInAgent carrier for plugin backend ids at V1 compatibility boundaries', () => {
    expect((protocol as any).readBackendTargetRefV2({
      kind: 'builtInAgent',
      agentId: 'acme.review.backend',
    })).toEqual({
      kind: 'backend',
      backendId: 'acme.review.backend',
      sourceKind: 'built_in',
    });

    expect((protocol as any).convertBackendTargetRefV2ToV1({
      kind: 'backend',
      backendId: 'acme.review.backend',
      sourceKind: 'built_in',
    })).toEqual({
      kind: 'builtInAgent',
      agentId: 'acme.review.backend',
    });
  });

  it('converts additive V2 targets back to the legacy V1 transport shape for compatibility boundaries', () => {
    expect((protocol as any).convertBackendTargetRefV2ToV1({
      kind: 'backend',
      backendId: 'codex',
      sourceKind: 'built_in',
    })).toEqual({
      kind: 'builtInAgent',
      agentId: 'codex',
    });

    expect((protocol as any).convertBackendTargetRefV2ToV1({
      kind: 'backend',
      backendId: 'plugin-review-bot',
      configuredBackendId: 'plugin-review-bot',
      sourceKind: 'configured',
    })).toEqual({
      kind: 'configuredAcpBackend',
      backendId: 'plugin-review-bot',
    });
  });

  it('fails closed when configured source kind is missing configured backend identity', () => {
    expect(() => (protocol as any).readBackendTargetRefV2({
      kind: 'backend',
      backendId: 'codex',
      sourceKind: 'configured',
    })).toThrow();

    expect(() => (protocol as any).buildBackendTargetKeyV2({
      kind: 'backend',
      backendId: 'codex',
      sourceKind: 'configured',
    })).toThrow();
  });

  it('rejects customAcp placeholders as concrete backend targets', () => {
    expect(() => (protocol as any).readBackendTargetRefV2({
      kind: 'backend',
      backendId: 'customAcp',
      sourceKind: 'built_in',
    })).toThrow();

    expect(() => (protocol as any).readBackendTargetRefV2({
      kind: 'backend',
      backendId: 'codex',
      configuredBackendId: 'customAcp',
      sourceKind: 'configured',
    })).toThrow();

    expect(() => (protocol as any).readBackendTargetRefV2('backend:customAcp')).toThrow();

    expect(() => (protocol as any).readBackendTargetRefV2({
      kind: 'builtInAgent',
      agentId: 'customAcp',
    })).toThrow();
  });

  it('rejects legacy configured ACP flavor carriers as concrete backend targets', () => {
    expect(() => (protocol as any).readBackendTargetRefV2({
      kind: 'backend',
      backendId: 'acp:review-bot',
      sourceKind: 'built_in',
    })).toThrow();

    expect(() => (protocol as any).readBackendTargetRefV2({
      kind: 'backend',
      backendId: 'review-bot',
      configuredBackendId: 'acp:review-bot',
      sourceKind: 'configured',
    })).toThrow();
  });

  it('normalizes legacy continueWithReplay agent carriers into additive V2 backend targets at the backend-target compatibility seam', () => {
    const builtInCompat = normalizeLegacyContinueWithReplayRpcParamsInput({
      directory: '/repo',
      agent: 'claude',
      replay: { previousSessionId: 'sess-prev' },
    }) as { backendTarget?: unknown };

    const configuredCompat = normalizeLegacyContinueWithReplayRpcParamsInput({
      directory: '/repo',
      agent: 'acp:review-bot',
      replay: { previousSessionId: 'sess-prev' },
    }) as { backendTarget?: unknown };

    expect((protocol as any).readBackendTargetRefV2(builtInCompat.backendTarget)).toEqual({
      kind: 'backend',
      backendId: 'claude',
      sourceKind: 'built_in',
    });
    expect((protocol as any).readBackendTargetRefV2(configuredCompat.backendTarget)).toEqual({
      kind: 'backend',
      backendId: 'review-bot',
      configuredBackendId: 'review-bot',
      sourceKind: 'configured',
    });
  });

  it('uses structured durable Oh My Pi identity while keeping flat runtime routing derived', () => {
    const runtimeTarget = {
      kind: 'backend',
      backendId: 'ohMyPi',
      sourceKind: 'built_in',
    };
    const persistedTarget = {
      kind: 'agent',
      identity: {
        pluginId: 'happier.agent.ohmypi',
        localId: 'ohmypi',
      },
    };

    expect((protocol as any).writePersistedBackendTargetRefV2(runtimeTarget)).toEqual(persistedTarget);
    expect((protocol as any).readBackendTargetRefV2(persistedTarget)).toEqual(runtimeTarget);
    expect((protocol as any).readBackendTargetRefV2({
      kind: 'builtInAgent',
      agentId: 'ohMyPi',
    })).toEqual(runtimeTarget);
    expect((protocol as any).buildBackendTargetKeyV2(runtimeTarget)).toBe(
      'agent:happier.agent.ohmypi/ohmypi',
    );
    expect((protocol as any).parseBackendTargetKeyV2(
      'agent:happier.agent.ohmypi/ohmypi',
    )).toEqual(persistedTarget);
    expect((protocol as any).readBackendTargetRefV2(
      'agent:happier.agent.ohmypi/ohmypi',
    )).toEqual(runtimeTarget);
    expect((protocol as any).readBackendTargetRefV2('agent:ohMyPi')).toEqual(runtimeTarget);
    expect(JSON.stringify((protocol as any).writePersistedBackendTargetRefV2(runtimeTarget)))
      .not.toContain('ohMyPi');
  });
});
