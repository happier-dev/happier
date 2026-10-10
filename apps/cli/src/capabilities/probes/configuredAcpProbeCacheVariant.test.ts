import { describe, expect, it } from 'vitest';

import type { BackendTargetRefV1 } from '@happier-dev/protocol';
import { AcpCatalogRecordV1Schema, type AcpCatalogSnapshotV1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';

import { resolveConfiguredAcpProbeCacheVariant } from './configuredAcpProbeCacheVariant';

function buildCatalogWithConfiguredBackend(params: Readonly<{
  backendId: string;
  env: Readonly<Record<string, unknown>>;
}>): AcpCatalogSnapshotV1 {
  return { status: 'ready', revision: 1, record: AcpCatalogRecordV1Schema.parse({ v: 1,
      definitions: [
        {
          id: params.backendId,
          name: params.backendId,
          title: 'Configured ACP',
          command: '/bin/acp',
          args: [],
          env: params.env,
          auth: { support: 'manual_only' },
          capabilities: {},
          createdAt: 1,
          updatedAt: 1,
        },
      ],
  }) };
}

describe('resolveConfiguredAcpProbeCacheVariant', () => {
  it('does not leak secret env/auth values into the cache variant (uses a digest)', async () => {
    const backendTarget: BackendTargetRefV1 = { kind: 'configuredAcpBackend', backendId: 'b1' };
    const catalogSnapshot = buildCatalogWithConfiguredBackend({
      backendId: 'b1',
      env: {
        TOKEN: { t: 'literal', v: 'secret-value' },
      },
    });

    const variant = await resolveConfiguredAcpProbeCacheVariant({
      agentId: 'customAcp',
      backendTarget,
      accountSettings: {}, catalogSnapshot,
    });

    expect(variant).toMatch(/^configuredAcp:b1:[A-Za-z0-9_-]+$/);
    expect(variant).not.toContain('secret-value');
    expect(variant).not.toContain('TOKEN');
  });

  it('is stable across key ordering (env keys are sorted before hashing)', async () => {
    const backendTarget: BackendTargetRefV1 = { kind: 'configuredAcpBackend', backendId: 'b2' };
    const left = buildCatalogWithConfiguredBackend({
      backendId: 'b2',
      env: {
        B: { t: 'literal', v: 'b' },
        A: { t: 'literal', v: 'a' },
      },
    });
    const right = buildCatalogWithConfiguredBackend({
      backendId: 'b2',
      env: {
        A: { t: 'literal', v: 'a' },
        B: { t: 'literal', v: 'b' },
      },
    });

    const [leftVariant, rightVariant] = await Promise.all([resolveConfiguredAcpProbeCacheVariant({
      agentId: 'customAcp',
      backendTarget,
      accountSettings: {}, catalogSnapshot: left,
    }), resolveConfiguredAcpProbeCacheVariant({
      agentId: 'customAcp',
      backendTarget,
      accountSettings: {}, catalogSnapshot: right,
    })]);
    expect(leftVariant).toEqual(rightVariant);
  });

  it('does not treat a plugin Agent id as an account-configured ACP backend', async () => {
    const variant = await resolveConfiguredAcpProbeCacheVariant({
      agentId: 'customAcp',
      backendTarget: { kind: 'configuredAcpBackend', backendId: 'acme.probe.variant.backend' },
      accountSettings: {},
      catalogSnapshot: { status: 'ready', revision: 1, record: { v: 1, definitions: [] } },
    });

    expect(variant).toBe('configuredAcp:acme.probe.variant.backend:missing-backend');
  });

  it('invalidates the probe cache when the executable runtime rules change', async () => {
    const catalog = buildCatalogWithConfiguredBackend({ backendId: 'b1', env: {} });
    if (catalog.status !== 'ready') throw new Error('Expected ready fixture');
    const variants = await Promise.all(['first', 'second'].map(detail => resolveConfiguredAcpProbeCacheVariant({
      agentId: 'customAcp', backendTarget: { kind: 'configuredAcpBackend', backendId: 'b1' }, accountSettings: {},
      catalogSnapshot: { ...catalog, record: { ...catalog.record, definitions: catalog.record.definitions.map(definition => ({
        ...definition, runtime: { stderrRules: { authenticationErrorDetail: detail } },
      })) } },
    })));
    expect(variants[0]).not.toBe(variants[1]);
  });
});
