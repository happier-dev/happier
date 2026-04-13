import { describe, expect, it } from 'vitest';

import { resolveConcreteBackendTargetRefs } from './resolveConcreteBackendTargetRefs';

describe('resolveConcreteBackendTargetRefs', () => {
  it('normalizes built-in targets into canonical V2 and legacy V1 views', () => {
    expect(resolveConcreteBackendTargetRefs({ kind: 'builtInAgent', agentId: 'claude' })).toEqual({
      backendTargetV2: {
        kind: 'backend',
        backendId: 'claude',
        sourceKind: 'built_in',
      },
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
    });
  });

  it('accepts canonical V2 built-in targets directly', () => {
    expect(resolveConcreteBackendTargetRefs({
      kind: 'backend',
      backendId: 'codex',
      sourceKind: 'built_in',
    })).toEqual({
      backendTargetV2: {
        kind: 'backend',
        backendId: 'codex',
        sourceKind: 'built_in',
      },
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
    });
  });

  it('normalizes configured ACP targets into canonical V2 and legacy V1 views', () => {
    expect(resolveConcreteBackendTargetRefs({ kind: 'configuredAcpBackend', backendId: 'review-bot' })).toEqual({
      backendTargetV2: {
        kind: 'backend',
        backendId: 'review-bot',
        configuredBackendId: 'review-bot',
        sourceKind: 'configured',
      },
      backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
    });
  });

  it('fails closed when customAcp leaks through as a concrete backend target', () => {
    expect(resolveConcreteBackendTargetRefs({ kind: 'builtInAgent', agentId: 'customAcp' })).toBeNull();
    expect(resolveConcreteBackendTargetRefs({
      kind: 'backend',
      backendId: 'customAcp',
      sourceKind: 'built_in',
    })).toBeNull();
  });
});
