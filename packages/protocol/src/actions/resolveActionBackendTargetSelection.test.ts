import { describe, expect, it } from 'vitest';

import { buildBackendTargetKeyV2 } from '../backends/targets/backendTargetRefV2.js';
import { resolveActionBackendTargetSelection } from './resolveActionBackendTargetSelection.js';

describe('resolveActionBackendTargetSelection (RU-02 customAcp ingress-only)', () => {
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
