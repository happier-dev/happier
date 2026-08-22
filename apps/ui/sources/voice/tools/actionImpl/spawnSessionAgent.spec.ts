import { describe, expect, it } from 'vitest';

import { buildBackendTargetKeyV2 } from '@happier-dev/protocol';

import { resolveVoiceToolSpawnBackendTarget } from './spawnSessionAgent';

describe('resolveVoiceToolSpawnBackendTarget (RU-02 customAcp ingress-only)', () => {
  it('rejects legacy customAcp agentId when backendTargetKey is omitted', () => {
    expect(resolveVoiceToolSpawnBackendTarget({
      state: {},
      agentId: 'customAcp',
    })).toEqual({
      ok: false,
      errorCode: 'invalid_parameters',
      errorMessage: 'invalid_parameters',
      agentId: 'customAcp',
    });
  });

  it('accepts matching legacy configured ACP flavor carrier for configured backendTargetKey, returning the canonical backend target', () => {
    const backendTargetKey = buildBackendTargetKeyV2({
      kind: 'backend',
      backendId: 'customAcpRuntimeCarrier',
      configuredBackendId: 'kiro',
      sourceKind: 'configured',
    });

    const res = resolveVoiceToolSpawnBackendTarget({
      state: {},
      agentId: 'acp:kiro',
      backendTargetKey,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.backendTarget).toEqual({
      kind: 'backend',
      backendId: 'customAcpRuntimeCarrier',
      configuredBackendId: 'kiro',
      sourceKind: 'configured',
    });
  });

  it('rejects legacy customAcp carrier for non-configured backend target keys', () => {
    const backendTargetKey = buildBackendTargetKeyV2({
      kind: 'backend',
      backendId: 'kiro',
      sourceKind: 'built_in',
    });

    expect(resolveVoiceToolSpawnBackendTarget({
      state: {},
      agentId: 'customAcp',
      backendTargetKey,
    })).toMatchObject({
      ok: false,
      errorCode: 'invalid_parameters',
      errorMessage: 'invalid_parameters',
      agentId: 'customAcp',
      backendTargetKey,
    });
  });
  it('accepts an externally installed Agent id and targets it directly', () => {
    // An installed non-bundled Agent is a legitimate voice spawn target: `isBundledAgentId`
    // answers only "is this one of the bundled ids" and must never reject an installed Agent.
    const res = resolveVoiceToolSpawnBackendTarget({
      state: {},
      agentId: 'acme-agent',
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.backendTarget).toEqual({ kind: 'backend', backendId: 'acme-agent' });
  });

  it('accepts an externally installed Agent id that matches its backendTargetKey', () => {
    const backendTargetKey = buildBackendTargetKeyV2({
      kind: 'backend',
      backendId: 'acme-agent',
    });

    const res = resolveVoiceToolSpawnBackendTarget({
      state: {},
      agentId: 'acme-agent',
      backendTargetKey,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.backendTarget.backendId).toBe('acme-agent');
  });
});
