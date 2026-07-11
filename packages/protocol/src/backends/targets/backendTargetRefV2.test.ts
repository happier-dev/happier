import { describe, expect, it } from 'vitest';

import * as protocol from '../../index.js';
import { normalizeLegacyContinueWithReplayRpcParamsInput } from './compat/continueWithReplayRpcParamsCompat.js';

describe('BackendTargetRefV2 compatibility', () => {
  it('exports additive V2 backend target schemas and helpers', () => {
    expect(typeof (protocol as any).BackendTargetRefV2Schema?.safeParse).toBe('function');
    expect(typeof (protocol as any).BackendTargetKeyV2Schema?.safeParse).toBe('function');
    expect(typeof (protocol as any).buildBackendTargetKeyV2).toBe('function');
    expect(typeof (protocol as any).parseBackendTargetKeyV2).toBe('function');
    expect(typeof (protocol as any).readBackendTargetRefV2).toBe('function');
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
    expect((protocol as any).buildBackendTargetKeyV2(direct)).toBe('backend:claude');
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
});
