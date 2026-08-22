import { describe, expect, it, vi } from 'vitest';

import type {
  ExternalSessionsSource,
} from '@happier-dev/protocol';
import { PluginAgentContributionV2Schema } from '@happier-dev/protocol';

import type { ExternalSessionProviderOps } from './providerOps';
import {
  buildConfiguredExternalSessionSourceSnapshot as buildConfiguredExternalSessionSourceSnapshotWithProjection,
  type ConfiguredExternalSessionSourceSnapshotBasis,
} from './configuredSourceRegistry';
import { resolveExternalSessionSourceFromAgentProjection } from '../../plugins/projection/registry/externalSessionSources';
import type { ResolvedAgentContribution } from '../../plugins/projection/registry/types';

const basis: ConfiguredExternalSessionSourceSnapshotBasis = {
  contributionGenerationId: 'registry:g1',
  accountSettingsRevision: 'account:7',
};

const codexSourceDeclaration = {
  sourceKind: 'codexHome',
  schema: {
    fields: [
      { name: 'kind', kind: 'literal', value: 'codexHome' },
      { name: 'home', kind: 'enum', values: ['user', 'connectedService'] },
      { name: 'homePath', kind: 'string', optional: true },
      { name: 'connectedServiceId', kind: 'string', optional: true },
      { name: 'connectedServiceProfileId', kind: 'string', optional: true },
      { name: 'connectedServiceGroupId', kind: 'string', optional: true },
    ],
  },
  key: {
    segments: [
      { kind: 'literal', value: 'codexHome' },
      { kind: 'homeMode', field: 'home' },
      {
        kind: 'conditionalField',
        field: 'connectedServiceId',
        when: { field: 'home', equals: 'connectedService' },
      },
      {
        kind: 'connectedServiceScope',
        groupField: 'connectedServiceGroupId',
        profileField: 'connectedServiceProfileId',
        when: { field: 'home', equals: 'connectedService' },
      },
      { kind: 'field', field: 'homePath' },
    ],
  },
} as const;

function sourceAgent(
  id: string,
  sources: readonly (typeof codexSourceDeclaration)[],
): ResolvedAgentContribution {
  const definition = PluginAgentContributionV2Schema.parse({
    id,
    title: id,
    runtime: { kind: 'custom' },
    primary: 'sessions',
    capabilities: {
      sessions: { open: ['create'], delivery: ['newTurn'], cancel: true },
      ...(sources.length > 0 ? { surfaces: ['externalSessions'] } : {}),
    },
    ...(sources.length > 0 ? { surfaces: { externalSession: { sources } } } : {}),
  });
  return {
    id,
    provenance: 'first_party',
    source: { kind: 'bundled' },
    definition: { id },
    richDefinition: { provenance: 'first_party', definition },
  } as unknown as ResolvedAgentContribution;
}

const sourceProjection = {
  agents: [
    sourceAgent('codex', [codexSourceDeclaration]),
    sourceAgent('antigravity', [codexSourceDeclaration]),
    sourceAgent('claude', []),
  ],
};

async function buildConfiguredExternalSessionSourceSnapshot(
  params: Omit<
    Parameters<typeof buildConfiguredExternalSessionSourceSnapshotWithProjection>[0],
    'resolveSource'
  >,
) {
  return await buildConfiguredExternalSessionSourceSnapshotWithProjection({
    ...params,
    resolveSource: (agentId, source) => resolveExternalSessionSourceFromAgentProjection(
      sourceProjection,
      agentId,
      source,
    ),
  });
}

function providerOps(
  validateSource: ExternalSessionProviderOps['validateSource'],
): ExternalSessionProviderOps {
  return {
    validateSource,
    listCandidates: vi.fn(),
    pageTranscript: vi.fn(),
    readAfterTranscript: vi.fn(),
  };
}

describe('configured external-session source registry', () => {
  it('canonicalizes sources through provider ops and exposes opaque-key immutable entries', async () => {
    const canonicalSource = {
      kind: 'codexHome',
      home: 'connectedService',
      connectedServiceId: 'openai-codex',
      connectedServiceProfileId: 'work',
      connectedServiceGroupId: 'primary-pool',
    } satisfies ExternalSessionsSource;
    const validateSource = vi.fn<ExternalSessionProviderOps['validateSource']>(() => ({
      ok: true,
      source: canonicalSource,
    }));

    const snapshot = await buildConfiguredExternalSessionSourceSnapshot({
      basis,
      candidates: [{
        agentId: 'codex',
        source: { ...canonicalSource, connectedServiceProfileId: ' work ' },
      }],
      resolveProviderOps: () => providerOps(validateSource),
    });

    const entries = snapshot.list(basis);
    expect(validateSource).toHaveBeenCalledOnce();
    expect(entries).toEqual([{
      agentId: 'codex',
      sourceKey: 'codexHome:connectedService:openai-codex:group%3Aprimary-pool:',
      source: canonicalSource,
    }]);
    expect(snapshot.resolve(entries[0]!.agentId, entries[0]!.sourceKey, basis)).toBe(entries[0]);
    expect(snapshot.resolve(
      entries[0]!.agentId,
      'codexHome:connectedService:openai-codex:group:primary-pool:',
      basis,
    )).toBeNull();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(entries)).toBe(true);
    expect(Object.isFrozen(entries[0])).toBe(true);
    expect(Object.isFrozen(entries[0]!.source)).toBe(true);
  });

  it('keeps every other Agent projecting when one Agent refuses its own configured source', async () => {
    const source = {
      kind: 'codexHome',
      home: 'user',
    } satisfies ExternalSessionsSource;
    const healthy = providerOps(({ source: candidate }) => ({ ok: true, source: candidate }));

    const snapshot = await buildConfiguredExternalSessionSourceSnapshot({
      basis,
      candidates: [
        { agentId: 'codex', source },
        { agentId: 'antigravity', source },
      ],
      resolveProviderOps: (agentId) => (agentId === 'codex'
        ? providerOps(async () => {
            throw new Error('codex home probe failed');
          })
        : healthy),
    });

    expect(snapshot.list(basis)).toEqual([{
      agentId: 'antigravity',
      sourceKey: 'codexHome:user:::',
      source,
    }]);
    expect(snapshot.resolve('antigravity', 'codexHome:user:::', basis)).not.toBeNull();
    expect(snapshot.resolve('codex', 'codexHome:user:::', basis)).toBeNull();
    expect(snapshot.refusals).toEqual([{
      agentId: 'codex',
      code: 'provider_source_invalid',
      message: expect.stringMatching(/agent 'codex'/i),
    }]);
    expect(Object.isFrozen(snapshot.refusals)).toBe(true);
  });

  it('still fails the whole snapshot closed on a host-owned integrity failure beside a healthy Agent', async () => {
    const source = {
      kind: 'codexHome',
      home: 'user',
    } satisfies ExternalSessionsSource;
    const healthy = providerOps(({ source: candidate }) => ({ ok: true, source: candidate }));

    // `source_undeclared` is decided by the host's own declaration index, and
    // `duplicate_source_key` by the host's own persisted key identity. A partial
    // snapshot built on either would publish an incomplete or order-dependent
    // view of the user's configuration as if it were complete.
    await expect(buildConfiguredExternalSessionSourceSnapshot({
      basis,
      candidates: [
        { agentId: 'antigravity', source },
        { agentId: 'codex', source: { kind: 'not-real' } },
      ],
      resolveProviderOps: () => healthy,
    })).rejects.toMatchObject({ code: 'source_undeclared' });

    await expect(buildConfiguredExternalSessionSourceSnapshot({
      basis,
      candidates: [
        { agentId: 'antigravity', source },
        { agentId: 'codex', source },
        { agentId: 'codex', source: { ...source } },
      ],
      resolveProviderOps: () => healthy,
    })).rejects.toMatchObject({ code: 'duplicate_source_key' });
  });

  it('scopes identical opaque source ids to their Agent contribution', async () => {
    const source = {
      kind: 'codexHome',
      home: 'user',
    } satisfies ExternalSessionsSource;
    const snapshot = await buildConfiguredExternalSessionSourceSnapshot({
      basis,
      candidates: [
        { agentId: 'codex', source },
        { agentId: 'antigravity', source },
      ],
      resolveProviderOps: () => providerOps(({ source: candidate }) => ({
        ok: true,
        source: candidate,
      })),
    });

    const entries = snapshot.list(basis);
    expect(entries).toHaveLength(2);
    expect(entries[0]!.sourceKey).toBe(entries[1]!.sourceKey);
    expect(snapshot.resolve('codex', entries[0]!.sourceKey, basis)).toBe(entries[0]);
    expect(snapshot.resolve('antigravity', entries[1]!.sourceKey, basis)).toBe(entries[1]);
    expect(snapshot.resolve('claude', entries[0]!.sourceKey, basis)).toBeNull();
  });

  it.each([
    ['empty', ''],
    ['padded', ' padded-source-key '],
    ['overlong', 'x'.repeat(2_001)],
  ])('rejects a noncanonical %s opaque source key before snapshot publication', async (_name, sourceKey) => {
    const source = {
      kind: 'codexHome',
      home: 'user',
    } satisfies ExternalSessionsSource;
    const projected = resolveExternalSessionSourceFromAgentProjection(
      sourceProjection,
      'codex',
      source,
    );
    if (!projected.ok) throw new Error('Expected the fixture source to resolve');

    const snapshot = await buildConfiguredExternalSessionSourceSnapshotWithProjection({
      basis,
      candidates: [{ agentId: 'codex', source }],
      resolveProviderOps: () => providerOps(({ source: candidate }) => ({
        ok: true,
        source: candidate,
      })),
      resolveSource: () => ({
        ...projected,
        sourceKey,
      }),
    });
    expect(snapshot.list(basis)).toEqual([]);
    expect(snapshot.refusals).toEqual([{
      agentId: 'codex',
      code: 'malformed_canonical_source',
      message: expect.stringMatching(/malformed canonical/i),
    }]);
  });

  it('rejects a noncanonical Agent id before snapshot publication', async () => {
    const source = {
      kind: 'codexHome',
      home: 'user',
    } satisfies ExternalSessionsSource;
    const projected = resolveExternalSessionSourceFromAgentProjection(
      sourceProjection,
      'codex',
      source,
    );
    if (!projected.ok) throw new Error('Expected the fixture source to resolve');

    await expect(buildConfiguredExternalSessionSourceSnapshotWithProjection({
      basis,
      candidates: [{ agentId: ' codex ', source }],
      resolveProviderOps: () => providerOps(({ source: candidate }) => ({
        ok: true,
        source: candidate,
      })),
      resolveSource: () => projected,
    })).rejects.toMatchObject({ code: 'malformed_source' });
  });

  it('fails closed on host-owned source integrity and refuses only the provider-rejected candidate', async () => {
    const valid = {
      kind: 'codexHome',
      home: 'user',
    } satisfies ExternalSessionsSource;
    const validOps = providerOps(({ source }) => ({ ok: true, source }));

    await expect(buildConfiguredExternalSessionSourceSnapshot({
      basis,
      candidates: [{ agentId: 'codex', source: { kind: 'not-real' } }],
      resolveProviderOps: () => validOps,
    })).rejects.toMatchObject({ code: 'source_undeclared' });

    const providerInvalid = await buildConfiguredExternalSessionSourceSnapshot({
      basis,
      candidates: [{ agentId: 'codex', source: valid }],
      resolveProviderOps: () => providerOps(() => ({ ok: false, error: 'secret=/credentials/token' })),
    });
    expect(providerInvalid.list(basis)).toEqual([]);
    expect(providerInvalid.refusals).toEqual([{
      agentId: 'codex',
      code: 'provider_source_invalid',
      message: expect.stringMatching(/rejected by its provider/i),
    }]);
    expect(providerInvalid.refusals[0]!.message).not.toMatch(/secret|credentials|token/i);

    await expect(buildConfiguredExternalSessionSourceSnapshot({
      basis,
      candidates: [{ agentId: 'claude', source: valid }],
      resolveProviderOps: () => validOps,
    })).rejects.toThrow(/does not own/i);

    await expect(buildConfiguredExternalSessionSourceSnapshot({
      basis,
      candidates: [
        { agentId: 'codex', source: valid },
        { agentId: 'codex', source: { ...valid } },
      ],
      resolveProviderOps: () => validOps,
    })).rejects.toThrow(/duplicate/i);
  });

  it('refuses only the candidate whose Agent ops are absent or whose canonical output is malformed', async () => {
    const valid = {
      kind: 'codexHome',
      home: 'user',
    } satisfies ExternalSessionsSource;

    const opsAbsent = await buildConfiguredExternalSessionSourceSnapshot({
      basis,
      candidates: [{ agentId: 'codex', source: valid }],
      resolveProviderOps: () => null,
    });
    expect(opsAbsent.list(basis)).toEqual([]);
    expect(opsAbsent.refusals).toEqual([{
      agentId: 'codex',
      code: 'provider_ops_unavailable',
      message: expect.stringMatching(/Agent operations/i),
    }]);

    const malformedCanonical = await buildConfiguredExternalSessionSourceSnapshot({
      basis,
      candidates: [{ agentId: 'codex', source: valid }],
      resolveProviderOps: () => providerOps(() => ({
        ok: true,
        source: { kind: 'not-real' } as unknown as ExternalSessionsSource,
      })),
    });
    expect(malformedCanonical.list(basis)).toEqual([]);
    expect(malformedCanonical.refusals).toEqual([{
      agentId: 'codex',
      code: 'malformed_canonical_source',
      message: expect.stringMatching(/malformed canonical/i),
    }]);
  });

  it('rejects retired contribution generations and account-settings drift on every read', async () => {
    const source = {
      kind: 'codexHome',
      home: 'user',
    } satisfies ExternalSessionsSource;
    const snapshot = await buildConfiguredExternalSessionSourceSnapshot({
      basis,
      candidates: [{ agentId: 'codex', source }],
      resolveProviderOps: () => providerOps(({ source: candidate }) => ({ ok: true, source: candidate })),
    });

    expect(() => snapshot.list({ ...basis, contributionGenerationId: 'registry:g2' })).toThrow(/retired/i);
    expect(() => snapshot.resolve('codex', 'codex:user:', {
      ...basis,
      accountSettingsRevision: 'account:8',
    })).toThrow(/account settings/i);
  });

  it('fences generation and account drift around every provider await', async () => {
    let currentBasis = basis;
    const source = {
      kind: 'codexHome',
      home: 'user',
    } satisfies ExternalSessionsSource;

    const retiredDuringResolution = buildConfiguredExternalSessionSourceSnapshot({
      basis,
      candidates: [{ agentId: 'codex', source }],
      readCurrentBasis: () => currentBasis,
      isCurrent: () => true,
      resolveProviderOps: async () => {
        currentBasis = { ...basis, contributionGenerationId: 'registry:g2' };
        return providerOps(({ source: candidate }) => ({ ok: true, source: candidate }));
      },
    });
    await expect(retiredDuringResolution).rejects.toMatchObject({ code: 'retired_generation' });

    currentBasis = basis;
    const driftDuringValidation = buildConfiguredExternalSessionSourceSnapshot({
      basis,
      candidates: [{ agentId: 'codex', source }],
      readCurrentBasis: () => currentBasis,
      isCurrent: () => true,
      resolveProviderOps: () => providerOps(async ({ source: candidate }) => {
        currentBasis = { ...basis, accountSettingsRevision: 'account:8' };
        return { ok: true, source: candidate };
      }),
    });
    await expect(driftDuringValidation).rejects.toMatchObject({ code: 'account_settings_drift' });
  });

  it('rejects accessor-backed and throwing provider output without invoking or exposing it', async () => {
    const source = {
      kind: 'codexHome',
      home: 'user',
    } satisfies ExternalSessionsSource;
    let accessorReads = 0;
    const accessorSource = Object.defineProperty({}, 'kind', {
      enumerable: true,
      get() {
        accessorReads += 1;
        throw new Error('secret=/credentials/token');
      },
    });

    const accessorResult = await buildConfiguredExternalSessionSourceSnapshot({
      basis,
      candidates: [{ agentId: 'codex', source }],
      resolveProviderOps: () => providerOps(() => ({
        ok: true,
        source: accessorSource as ExternalSessionsSource,
      })),
    });
    expect(accessorResult.list(basis)).toEqual([]);
    expect(accessorResult.refusals[0]).toMatchObject({ code: 'malformed_canonical_source' });
    expect(accessorResult.refusals[0]!.message).not.toMatch(/secret|credentials|token/i);
    expect(accessorReads).toBe(0);

    const thrownResult = await buildConfiguredExternalSessionSourceSnapshot({
      basis,
      candidates: [{ agentId: 'codex', source }],
      resolveProviderOps: () => providerOps(async () => {
        throw new Error('secret=/credentials/token');
      }),
    });
    expect(thrownResult.list(basis)).toEqual([]);
    expect(thrownResult.refusals[0]).toMatchObject({ code: 'provider_source_invalid' });
    expect(thrownResult.refusals[0]!.message).not.toMatch(/secret|credentials|token/i);
  });
});
