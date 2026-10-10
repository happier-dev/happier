import { describe, expect, it } from 'vitest';

import type { MarketplaceIndexSourceSnapshotV1 } from '@happier-dev/protocol';

import { createMarketplaceIndex } from './index';
import { projectMarketplaceArtifactAccess } from './service';

const entry = (pluginId: string, packageName: string, status: 'approved' | 'withdrawn' | 'blocked' = 'approved'): MarketplaceIndexSourceSnapshotV1['entries'][number] => ({
  pluginId,
  publisher: { id: 'acme', displayName: 'Acme' },
  display: { title: pluginId, description: `${pluginId} description` },
  distribution: { kind: 'npm', registryOrigin: 'https://registry.npmjs.org', packageName, version: '1.0.0', integrity: 'sha512-AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ==' },
  manifestDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  compatibility: { happier: '>=1.0.0', platforms: ['darwin', 'linux'] },
  summary: { contributions: ['agents'], requiredHostAccess: ['process'], optionalHostAccess: [], executableRealms: ['daemon'] },
  review: { status, reviewedAt: '2026-07-13T00:00:00.000Z' },
  categories: ['agents'], media: [], updatePolicy: 'allowed', links: { homepage: 'https://example.com/plugin' },
});

const source = (id: string, kind: 'curated' | 'user' | 'community-npm', entries: MarketplaceIndexSourceSnapshotV1['entries'], freshness: MarketplaceIndexSourceSnapshotV1['freshness'] = { state: 'fresh', fetchedAtMs: 100 }): MarketplaceIndexSourceSnapshotV1 => ({
  source: { id, title: id, kind, sourceUrl: kind === 'community-npm' ? 'https://registry.npmjs.org/-/v1/search' : `https://catalog.example/${id}.json` },
  freshness,
  entries,
  diagnostics: [],
});

describe('createMarketplaceIndex', () => {
  it('retains one listing per source and plugin while ranking sources deterministically', () => {
    const curated = entry('acme.agent', '@acme/agent');
    const unreviewed = { ...curated, review: { status: 'unreviewed' as const, reviewedAt: null }, updatePolicy: 'allowed' as const };
    const result = createMarketplaceIndex({
      revision: 7,
      sources: [source('community', 'community-npm', [unreviewed]), source('curated', 'curated', [curated]), source('user', 'user', [{ ...unreviewed, distribution: { ...curated.distribution, packageName: '@attacker/rebound' } }])],
      query: { text: '', limit: 20, cursor: null, filters: {} },
    });

    expect(result.items).toHaveLength(3);
    expect(result.items.map((item) => [item.source.kind, item.distribution.packageName])).toEqual([
      ['curated', '@acme/agent'],
      ['user', '@attacker/rebound'],
      ['community-npm', '@acme/agent'],
    ]);
    expect(result.diagnostics).toEqual([]);
  });

  it('does not let a withdrawn curated listing shadow an installable Community npm listing', () => {
    const withdrawn = entry('acme.agent', '@acme/agent', 'withdrawn');
    const community = {
      ...withdrawn,
      review: { status: 'unreviewed' as const, reviewedAt: null },
      updatePolicy: 'allowed' as const,
    };
    const result = createMarketplaceIndex({
      revision: 1,
      sources: [source('curated', 'curated', [withdrawn]), source('community', 'community-npm', [community])],
      query: { filters: {} },
    });
    expect(result.items).toMatchObject([{ pluginId: 'acme.agent', source: { kind: 'community-npm' } }]);
  });

  it('uses stable bounded pagination and exposes offline stale truth', () => {
    const entries = Array.from({ length: 5 }, (_, index) => entry(`acme.agent-${index}`, `@acme/agent-${index}`));
    const stale = source('curated', 'curated', entries, { state: 'stale-offline', fetchedAtMs: 100, staleSinceMs: 200 });
    const first = createMarketplaceIndex({ revision: 3, sources: [stale], query: { text: 'agent', limit: 2, cursor: null, filters: { categories: ['agents'] } } });
    const second = createMarketplaceIndex({ revision: 3, sources: [stale], query: { text: 'agent', limit: 2, cursor: first.nextCursor, filters: { categories: ['agents'] } } });
    expect(first.items.map((item) => item.pluginId)).toEqual(['acme.agent-0', 'acme.agent-1']);
    expect(second.items.map((item) => item.pluginId)).toEqual(['acme.agent-2', 'acme.agent-3']);
    expect(first.sources[0]?.freshness.state).toBe('stale-offline');
  });

  it('keeps a catalog-selected private profile unverified without mutating plugin trust', () => {
    const privateEntry = entry('acme.private', '@acme/private');
    const result = createMarketplaceIndex({
      revision: 1,
      sources: [source('curated', 'curated', [{ ...privateEntry, distribution: { ...privateEntry.distribution, registryProfileId: 'registry:private' } }])],
      query: { text: '', limit: 20, cursor: null, filters: {} },
    });
    const unavailable = projectMarketplaceArtifactAccess(result.items[0]!, [{ profileId: 'registry:private', origin: 'https://registry.npmjs.org', availability: 'sign_in_required' }]);
    expect(unavailable.artifactAccess).toEqual({ state: 'unverified-profile', registryProfileId: 'registry:private' });
    expect(unavailable.admission).toMatchObject({ mutatesInstalledTrust: false, disablesInstalledCode: false });
  });

  it('rejects a pagination cursor from a stale daemon revision', () => {
    expect(() => createMarketplaceIndex({
      revision: 4,
      sources: [source('curated', 'curated', [entry('acme.one', '@acme/one')])],
      query: { text: '', limit: 1, cursor: 'revision:3:offset:1', filters: {} },
    })).toThrow('cursor revision is stale');
  });

  it('rejects conflicting integrity for the same exact release within one source', () => {
    const original = entry('acme.one', '@acme/one');
    const conflict = { ...original, distribution: { ...original.distribution, integrity: 'sha512-AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg==' } };
    const result = createMarketplaceIndex({
      revision: 1,
      sources: [source('curated-a', 'curated', [original, conflict])],
      query: { text: '', limit: 20, cursor: null, filters: { includeUnavailable: true } },
    });
    expect(result.items).toHaveLength(1);
    expect(result.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'marketplace_distribution_metadata_conflict' })]));
  });

  it.each(['approved', 'withdrawn', 'blocked'] as const)(
    'carries %s through as a discovery fact without touching installed trust',
    (status) => {
      // Withdrawal is curation withdrawing a recommendation. It stays visible
      // on the listing and never becomes a decision that mutates or disables
      // installed code.
      const result = createMarketplaceIndex({ revision: 1, sources: [source('curated', 'curated', [entry(`acme.${status}`, `@acme/${status}`, status)])], query: { text: '', limit: 20, cursor: null, filters: { includeUnavailable: true } } });
      expect(result.items[0]?.review.status).toBe(status);
      expect(result.items[0]?.admission).toMatchObject({ mutatesInstalledTrust: false, disablesInstalledCode: false });
    },
  );

  it('never turns curation into install authorization, whatever the review status or update policy', () => {
    // Curation recommends discovery. A plausible wrong index would re-derive an
    // allow/refuse install decision from the review status or update policy;
    // every listing reaches the same full Install and Trust review instead.
    const variants = [
      entry('acme.approved', '@acme/approved'),
      { ...entry('acme.pinned', '@acme/pinned'), updatePolicy: 'pinned' as const },
      { ...entry('acme.withdrawn', '@acme/withdrawn', 'withdrawn'), updatePolicy: 'allowed' as const },
    ];
    const result = createMarketplaceIndex({ revision: 1, sources: [source('curated', 'curated', variants)], query: { filters: { includeUnavailable: true } } });
    expect(result.items).toHaveLength(3);
    for (const item of result.items) {
      expect(item.admission).toEqual({
        install: 'full-review',
        mutatesInstalledTrust: false,
        disablesInstalledCode: false,
        directNpmRequiresFullReview: true,
      });
    }
  });

  it('does not authenticate a catalog-selected profile even when a host profile exists', () => {
    const privateEntry = entry('acme.private', '@acme/private');
    const result = createMarketplaceIndex({
      revision: 1,
      sources: [source('curated', 'curated', [{ ...privateEntry, distribution: { ...privateEntry.distribution, registryProfileId: 'registry:private' } }])],
      query: { filters: {} },
    });
    const projected = projectMarketplaceArtifactAccess(result.items[0]!, [{ profileId: 'registry:private', origin: 'https://other.example', availability: 'available' }]);
    expect(projected.artifactAccess.state).toBe('unverified-profile');
  });

  it('binds pagination cursors to the exact query instead of reusing offsets across filters', () => {
    const entries = [entry('acme.linux', '@acme/linux'), { ...entry('acme.web', '@acme/web'), compatibility: { happier: '>=1.0.0', platforms: ['web' as const] } }];
    const first = createMarketplaceIndex({ revision: 9, sources: [source('curated', 'curated', entries)], query: { text: '', limit: 1, filters: {} } });
    expect(first.nextCursor).not.toBeNull();
    expect(() => createMarketplaceIndex({ revision: 9, sources: [source('curated', 'curated', entries)], query: { text: '', cursor: first.nextCursor, limit: 1, filters: { platforms: ['web'] } } })).toThrow(/cursor.*query/i);
  });

  it('projects one deterministic latest exact release per plugin identity', () => {
    const oldRelease = entry('acme.agent', '@acme/agent');
    const newRelease = { ...oldRelease, distribution: { ...oldRelease.distribution, version: '10.0.0' } };
    const result = createMarketplaceIndex({ revision: 1, sources: [source('curated', 'curated', [oldRelease, newRelease])], query: { filters: {} } });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.distribution.version).toBe('10.0.0');
  });

  it('preserves every merge diagnostic for rejected rebinding entries', () => {
    const canonical = entry('acme.agent', '@acme/agent');
    const conflicts = Array.from({ length: 200 }, (_, index) => ({
      ...entry('acme.agent', `@attacker/rebound-${index}`),
      review: { status: 'unreviewed' as const, reviewedAt: null },
      updatePolicy: 'allowed' as const,
    }));
    const result = createMarketplaceIndex({
      revision: 1,
      sources: [source('curated', 'curated', [canonical]), source('user', 'user', conflicts)],
      query: { filters: {} },
    });
    expect(result.diagnostics).toHaveLength(199);
    expect(result.diagnostics.every((diagnostic) => diagnostic.code === 'marketplace_distribution_rebinding')).toBe(true);
  });
});
