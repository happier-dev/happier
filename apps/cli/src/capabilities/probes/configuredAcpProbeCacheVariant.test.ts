import { describe, expect, it } from 'vitest';

import type { BackendTargetRefV1 } from '@happier-dev/protocol';

import { resolveConfiguredAcpProbeCacheVariant } from './configuredAcpProbeCacheVariant';

function buildAccountSettingsWithConfiguredBackend(params: Readonly<{
  backendId: string;
  env: Readonly<Record<string, unknown>>;
}>): Readonly<Record<string, unknown>> {
  return {
    acpCatalogSettingsV1: {
      backends: [
        {
          id: params.backendId,
          name: params.backendId,
          title: 'Configured ACP',
          command: '/bin/acp',
          args: [],
          env: params.env,
          auth: { support: 'manual_only' },
          transportProfile: 'generic',
          capabilities: {},
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    },
  };
}

describe('resolveConfiguredAcpProbeCacheVariant', () => {
  it('does not leak secret env/auth values into the cache variant (uses a digest)', () => {
    const backendTarget: BackendTargetRefV1 = { kind: 'configuredAcpBackend', backendId: 'b1' };
    const accountSettings = buildAccountSettingsWithConfiguredBackend({
      backendId: 'b1',
      env: {
        TOKEN: { t: 'literal', v: 'secret-value' },
      },
    });

    const variant = resolveConfiguredAcpProbeCacheVariant({
      agentId: 'customAcp',
      backendTarget,
      accountSettings,
    });

    expect(variant).toMatch(/^configuredAcp:b1:[A-Za-z0-9_-]+$/);
    expect(variant).not.toContain('secret-value');
    expect(variant).not.toContain('TOKEN');
  });

  it('is stable across key ordering (env keys are sorted before hashing)', () => {
    const backendTarget: BackendTargetRefV1 = { kind: 'configuredAcpBackend', backendId: 'b2' };
    const left = buildAccountSettingsWithConfiguredBackend({
      backendId: 'b2',
      env: {
        B: { t: 'literal', v: 'b' },
        A: { t: 'literal', v: 'a' },
      },
    });
    const right = buildAccountSettingsWithConfiguredBackend({
      backendId: 'b2',
      env: {
        A: { t: 'literal', v: 'a' },
        B: { t: 'literal', v: 'b' },
      },
    });

    expect(resolveConfiguredAcpProbeCacheVariant({
      agentId: 'customAcp',
      backendTarget,
      accountSettings: left,
    })).toEqual(resolveConfiguredAcpProbeCacheVariant({
      agentId: 'customAcp',
      backendTarget,
      accountSettings: right,
    }));
  });
});
