import { describe, expect, it } from 'vitest';

import { resolveConcreteBackendTargetRefV2 } from './resolveConcreteBackendTargetRefs';

describe('resolveConcreteBackendTargetRefV2', () => {
  it('accepts canonical V2 built-in targets directly', () => {
    expect(resolveConcreteBackendTargetRefV2({
      kind: 'backend',
      backendId: 'claude',
      sourceKind: 'built_in',
    })).toEqual({
      kind: 'backend',
      backendId: 'claude',
      sourceKind: 'built_in',
    });
  });

  it('accepts canonical V2 built-in targets with surrounding whitespace and normalizes them', () => {
    expect(resolveConcreteBackendTargetRefV2({
      kind: 'backend',
      backendId: ' codex ',
      sourceKind: 'built_in',
    })).toEqual({
      kind: 'backend',
      backendId: 'codex',
      sourceKind: 'built_in',
    });
  });

  it('normalizes configured ACP targets into the canonical V2 view', () => {
    expect(resolveConcreteBackendTargetRefV2({
      kind: 'backend',
      backendId: ' review-bot ',
      configuredBackendId: ' review-bot ',
    })).toEqual({
      kind: 'backend',
      backendId: 'review-bot',
      configuredBackendId: 'review-bot',
      sourceKind: 'configured',
    });
  });

  it('trims backend identifiers before returning canonical targets', () => {
    expect(resolveConcreteBackendTargetRefV2({
      kind: 'backend',
      backendId: ' review-bot ',
      configuredBackendId: ' review-bot ',
      sourceKind: 'configured',
    })).toEqual({
      kind: 'backend',
      backendId: 'review-bot',
      configuredBackendId: 'review-bot',
      sourceKind: 'configured',
    });
  });

  it('fails closed when configured identity becomes empty after normalization', () => {
    expect(resolveConcreteBackendTargetRefV2({
      kind: 'backend',
      backendId: 'codex',
      configuredBackendId: '   ',
    })).toBeNull();
  });

  it('fails closed when V1 compat carriers are passed into the canonical helper', () => {
    expect(resolveConcreteBackendTargetRefV2({ kind: 'builtInAgent', agentId: 'claude' } as never)).toBeNull();
    expect(resolveConcreteBackendTargetRefV2({ kind: 'configuredAcpBackend', backendId: 'review-bot' } as never)).toBeNull();
    expect(resolveConcreteBackendTargetRefV2('agent:claude' as never)).toBeNull();
    expect(resolveConcreteBackendTargetRefV2('acpBackend:review-bot' as never)).toBeNull();
  });

  it('fails closed when customAcp leaks through as a canonical concrete backend target', () => {
    expect(resolveConcreteBackendTargetRefV2({
      kind: 'backend',
      backendId: 'customAcp',
      sourceKind: 'built_in',
    })).toBeNull();
  });

  it('fails closed when legacy configured ACP flavor carriers leak through as canonical concrete backend targets', () => {
    expect(resolveConcreteBackendTargetRefV2({
      kind: 'backend',
      backendId: 'acp:review-bot',
      sourceKind: 'built_in',
    } as never)).toBeNull();
  });
});
