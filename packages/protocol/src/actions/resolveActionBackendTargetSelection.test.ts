import { describe, expect, it } from 'vitest';

import { buildBackendTargetKeyV2 } from '../backends/targets/backendTargetRefV2.js';
import { resolveActionBackendTargetSelection } from './resolveActionBackendTargetSelection.js';

describe('resolveActionBackendTargetSelection (RU-02 customAcp ingress-only)', () => {
  it.each([
    ['agentId', { agentId: 'claude' }, 'agentId'],
    ['backendTargetKey', { backendTargetKey: 'agent:claude' }, 'backendTarget'],
    ['runtimeDescriptorV1', {
      runtimeDescriptorV1: {
        v: 1,
        agentId: 'claude',
        agent: {},
      },
    }, 'runtimeDescriptorV1'],
  ] as const)('rejects a structured built-in target that conflicts with %s', (_label, conflictingInput, path) => {
    expect(resolveActionBackendTargetSelection({
      backendTarget: {
        kind: 'backend',
        backendId: 'codex',
        sourceKind: 'built_in',
      },
      ...conflictingInput,
    })).toMatchObject({
      ok: false,
      path,
    });
  });

  it('accepts matching structured, key, Agent, and runtime-descriptor carriers', () => {
    expect(resolveActionBackendTargetSelection({
      agentId: 'codex',
      backendTargetKey: 'backend:codex',
      backendTarget: {
        kind: 'backend',
        backendId: 'codex',
        sourceKind: 'built_in',
      },
      runtimeDescriptorV1: {
        v: 1,
        agentId: 'codex',
        agent: {},
      },
    })).toMatchObject({
      ok: true,
      selection: {
        agentId: 'codex',
        backendTargetKey: 'backend:codex',
        canonicalBackendTarget: {
          kind: 'backend',
          backendId: 'codex',
          sourceKind: 'built_in',
        },
      },
    });
  });

  it('accepts a runtime descriptor as the explicit Agent carrier for a plugin backend key', () => {
    expect(resolveActionBackendTargetSelection({
      backendTargetKey: 'backend:plugin-review-bot',
      runtimeDescriptorV1: {
        v: 1,
        agentId: 'claude',
        agent: {},
      },
    })).toMatchObject({
      ok: true,
      selection: {
        agentId: null,
        backendTargetKey: 'backend:plugin-review-bot',
      },
    });
  });

  it('accepts an explicit Agent carrier whose id differs from an arbitrary plugin backend id', () => {
    expect(resolveActionBackendTargetSelection({
      agentId: 'claude',
      backendTargetKey: 'backend:plugin-review-bot',
    })).toMatchObject({
      ok: true,
      selection: {
        agentId: 'claude',
        backendTargetKey: 'backend:plugin-review-bot',
      },
    });
  });

  it('accepts a distinct runtime descriptor Agent for a plugin backend carried by a lossy V1 key', () => {
    expect(resolveActionBackendTargetSelection({
      backendTargetKey: 'agent:plugin-review-bot',
      runtimeDescriptorV1: {
        v: 1,
        agentId: 'claude',
        agent: {},
      },
    })).toMatchObject({
      ok: true,
      selection: {
        agentId: null,
        backendTargetKey: 'agent:plugin-review-bot',
        canonicalBackendTarget: {
          kind: 'backend',
          backendId: 'plugin-review-bot',
          sourceKind: 'built_in',
        },
      },
    });
  });

  it('requires an explicit runtime carrier for a plugin backend carried by a lossy V1 key', () => {
    expect(resolveActionBackendTargetSelection({
      backendTargetKey: 'agent:plugin-review-bot',
    })).toEqual({
      ok: false,
      message: 'agentId is required when backendTargetKey needs an explicit runtime carrier',
      path: 'agentId',
    });
  });

  it('reconciles a lossy V1 configured key with a lossless V2 target by configured identity', () => {
    expect(resolveActionBackendTargetSelection({
      backendTargetKey: 'acpBackend:kiro',
      backendTarget: {
        kind: 'backend',
        backendId: 'customAcpRuntimeCarrier',
        configuredBackendId: 'kiro',
        sourceKind: 'configured',
      },
    })).toMatchObject({
      ok: true,
      selection: {
        agentId: null,
        backendTargetKey: 'acpBackend:kiro',
        backendTarget: {
          kind: 'configuredAcpBackend',
          backendId: 'kiro',
        },
        canonicalBackendTarget: {
          kind: 'backend',
          backendId: 'customAcpRuntimeCarrier',
          configuredBackendId: 'kiro',
          sourceKind: 'configured',
        },
      },
    });
  });

  it('rejects a non-canonical runtime descriptor Agent id instead of validating a trimmed shadow value', () => {
    expect(resolveActionBackendTargetSelection({
      backendTargetKey: 'backend:plugin-review-bot',
      runtimeDescriptorV1: {
        v: 1,
        agentId: ' claude ',
        agent: {},
      },
    })).toMatchObject({
      ok: false,
      path: 'runtimeDescriptorV1',
    });
  });

  it.each(['customAcp', 'acp:kiro'])(
    'rejects legacy ACP runtime descriptor carrier %s for a configured target',
    (runtimeAgentId) => {
      expect(resolveActionBackendTargetSelection({
        backendTarget: {
          kind: 'backend',
          backendId: 'customAcpRuntimeCarrier',
          configuredBackendId: 'kiro',
          sourceKind: 'configured',
        },
        runtimeDescriptorV1: {
          v: 1,
          agentId: runtimeAgentId,
          agent: {},
        },
      })).toMatchObject({
        ok: false,
        path: 'runtimeDescriptorV1',
      });
    },
  );

  it('rejects legacy customAcp agentId when backendTargetKey is omitted', () => {
    expect(resolveActionBackendTargetSelection({ agentId: 'customAcp' })).toEqual({
      ok: false,
      message: 'backendTargetKey is required for legacy configured-backend carriers',
      path: 'backendTargetKey',
    });
  });

  it('rejects legacy configured ACP carriers when backendTargetKey is omitted', () => {
    expect(resolveActionBackendTargetSelection({ agentId: 'acp:kiro' })).toEqual({
      ok: false,
      message: 'backendTargetKey is required for legacy configured-backend carriers',
      path: 'backendTargetKey',
    });
  });

  it('never re-emits legacy customAcp carriers into canonical selection for configured targets', () => {
    const backendTargetKey = buildBackendTargetKeyV2({
      kind: 'backend',
      backendId: 'customAcpRuntimeCarrier',
      configuredBackendId: 'kiro',
      sourceKind: 'configured',
    });

    const res = resolveActionBackendTargetSelection({
      agentId: 'customAcp',
      backendTargetKey,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.selection.agentId).toBeNull();
    expect(res.selection.backendTargetKey).toBe(backendTargetKey);
    expect(res.selection.backendTarget).toMatchObject({
      kind: 'configuredAcpBackend',
      backendId: 'kiro',
    });
    expect(res.selection.canonicalBackendTarget).toMatchObject({
      kind: 'backend',
      backendId: 'customAcpRuntimeCarrier',
      configuredBackendId: 'kiro',
      sourceKind: 'configured',
    });
  });

  it('rejects legacy carriers for non-configured backendTargetKey', () => {
    const backendTargetKey = buildBackendTargetKeyV2({
      kind: 'backend',
      backendId: 'kiro',
      sourceKind: 'built_in',
    });

    const res = resolveActionBackendTargetSelection({
      agentId: 'customAcp',
      backendTargetKey,
    });

    expect(res).toEqual({
      ok: false,
      message: 'agentId must not use legacy ACP carriers for non-configured backendTargetKey',
      path: 'agentId',
    });
  });

  it('requires agentId when backendTargetKey needs an explicit runtime carrier', () => {
    const backendTargetKey = buildBackendTargetKeyV2({
      kind: 'backend',
      backendId: 'acme.runtime.backend',
      sourceKind: 'built_in',
    });

    const res = resolveActionBackendTargetSelection({
      backendTargetKey,
    });

    expect(res).toEqual({
      ok: false,
      message: 'agentId is required when backendTargetKey needs an explicit runtime carrier',
      path: 'agentId',
    });
  });

  it('infers the runtime carrier for first-party Antigravity backend keys', () => {
    const backendTargetKey = buildBackendTargetKeyV2({
      kind: 'backend',
      backendId: 'antigravity',
      sourceKind: 'built_in',
    });

    const res = resolveActionBackendTargetSelection({
      backendTargetKey,
    });

    expect(res).toEqual({
      ok: true,
      selection: {
        agentId: 'antigravity',
        backendTargetKey,
        backendTarget: {
          kind: 'builtInAgent',
          agentId: 'antigravity',
        },
        canonicalBackendTarget: {
          kind: 'backend',
          backendId: 'antigravity',
          sourceKind: 'built_in',
        },
      },
    });
  });
});
