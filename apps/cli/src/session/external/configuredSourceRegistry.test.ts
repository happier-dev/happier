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
    expect(snapshot.resolve(entries[0]!.sourceKey, basis)).toBe(entries[0]);
    expect(snapshot.resolve(
      'codexHome:connectedService:openai-codex:group:primary-pool:',
      basis,
    )).toBeNull();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(entries)).toBe(true);
    expect(Object.isFrozen(entries[0])).toBe(true);
    expect(Object.isFrozen(entries[0]!.source)).toBe(true);
  });

  it('rejects malformed, provider-invalid, mismatched-agent, and duplicate canonical sources', async () => {
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

    const providerInvalid = buildConfiguredExternalSessionSourceSnapshot({
      basis,
      candidates: [{ agentId: 'codex', source: valid }],
      resolveProviderOps: () => providerOps(() => ({ ok: false, error: 'secret=/credentials/token' })),
    });
    await expect(providerInvalid).rejects.toMatchObject({ code: 'provider_source_invalid' });
    await expect(providerInvalid).rejects.not.toThrow(/secret|credentials|token/i);

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

  it('fails closed when provider ops are absent or return malformed canonical output', async () => {
    const valid = {
      kind: 'codexHome',
      home: 'user',
    } satisfies ExternalSessionsSource;

    await expect(buildConfiguredExternalSessionSourceSnapshot({
      basis,
      candidates: [{ agentId: 'codex', source: valid }],
      resolveProviderOps: () => null,
    })).rejects.toThrow(/Agent operations/i);

    await expect(buildConfiguredExternalSessionSourceSnapshot({
      basis,
      candidates: [{ agentId: 'codex', source: valid }],
      resolveProviderOps: () => providerOps(() => ({
        ok: true,
        source: { kind: 'not-real' } as unknown as ExternalSessionsSource,
      })),
    })).rejects.toThrow(/malformed canonical/i);
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
    expect(() => snapshot.resolve('codex:user:', {
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

    const accessorResult = buildConfiguredExternalSessionSourceSnapshot({
      basis,
      candidates: [{ agentId: 'codex', source }],
      resolveProviderOps: () => providerOps(() => ({
        ok: true,
        source: accessorSource as ExternalSessionsSource,
      })),
    });
    await expect(accessorResult).rejects.toMatchObject({ code: 'malformed_canonical_source' });
    await expect(accessorResult).rejects.not.toThrow(/secret|credentials|token/i);
    expect(accessorReads).toBe(0);

    const thrownResult = buildConfiguredExternalSessionSourceSnapshot({
      basis,
      candidates: [{ agentId: 'codex', source }],
      resolveProviderOps: () => providerOps(async () => {
        throw new Error('secret=/credentials/token');
      }),
    });
    await expect(thrownResult).rejects.toMatchObject({ code: 'provider_source_invalid' });
    await expect(thrownResult).rejects.not.toThrow(/secret|credentials|token/i);
  });
});
