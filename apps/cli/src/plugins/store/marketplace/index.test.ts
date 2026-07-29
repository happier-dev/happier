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
  categories: ['agents'], media: [], updatePolicy: 'curated-auto', links: { homepage: 'https://example.com/plugin' },
});

const source = (id: string, kind: 'curated' | 'user' | 'community-npm', entries: MarketplaceIndexSourceSnapshotV1['entries'], freshness: MarketplaceIndexSourceSnapshotV1['freshness'] = { state: 'fresh', fetchedAtMs: 100 }): MarketplaceIndexSourceSnapshotV1 => ({
  source: { id, title: id, kind, sourceUrl: kind === 'community-npm' ? 'https://registry.npmjs.org/-/v1/search?text=keywords:happier-plugin' : `https://catalog.example/${id}.json` },
  freshness,
  entries,
  diagnostics: [],
});

describe('createMarketplaceIndex', () => {
  it('merges deterministically, ranks curated first, and refuses distribution rebinding', () => {
    const curated = entry('acme.agent', '@acme/agent');
    const unreviewed = { ...curated, review: { status: 'unreviewed' as const, reviewedAt: null }, updatePolicy: 'manual' as const };
    const result = createMarketplaceIndex({
      revision: 7,
      sources: [source('community', 'community-npm', [unreviewed]), source('curated', 'curated', [curated]), source('user', 'user', [{ ...unreviewed, distribution: { ...curated.distribution, packageName: '@attacker/rebound' } }])],
      query: { text: '', limit: 20, cursor: null, filters: {} },
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ pluginId: 'acme.agent', source: { kind: 'curated' }, distribution: { packageName: '@acme/agent' }, admission: { curatedInstall: 'allowed', curatedUpdate: 'allowed' } });
    expect(result.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'marketplace_distribution_rebinding' })]));
  });

  it.each([
    ['approved', 'allowed', 'allowed', false],
    ['withdrawn', 'refused', 'refused', true],
    ['blocked', 'refused', 'refused', true],
  ] as const)('applies %s only to curated admission and never installed trust', (status, install, update, warning) => {
    const result = createMarketplaceIndex({ revision: 1, sources: [source('curated', 'curated', [entry(`acme.${status}`, `@acme/${status}`, status)])], query: { text: '', limit: 20, cursor: null, filters: { includeUnavailable: true } } });
    expect(result.items[0]?.admission).toEqual({ curatedInstall: install, curatedUpdate: update, warning, mutatesInstalledTrust: false, disablesInstalledCode: false, directNpmRequiresFullReview: true });
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

  it('rejects conflicting integrity for the same exact registry package version', () => {
    const original = entry('acme.one', '@acme/one');
    const conflict = { ...original, distribution: { ...original.distribution, integrity: 'sha512-AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg==' } };
    const result = createMarketplaceIndex({
      revision: 1,
      sources: [source('curated-a', 'curated', [original]), source('curated-b', 'curated', [conflict])],
      query: { text: '', limit: 20, cursor: null, filters: { includeUnavailable: true } },
    });
    expect(result.items).toHaveLength(1);
    expect(result.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'marketplace_distribution_metadata_conflict' })]));
  });

  it('never admits automatic updates for a pinned curated release', () => {
    const pinned = { ...entry('acme.pinned', '@acme/pinned'), updatePolicy: 'pinned' as const };
    const result = createMarketplaceIndex({ revision: 1, sources: [source('curated', 'curated', [pinned])], query: { filters: { includeUnavailable: true } } });
    expect(result.items[0]?.admission.curatedUpdate).toBe('refused');
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

  it('bounds merge diagnostics even when a source contains many rejected rebinding entries', () => {
    const canonical = entry('acme.agent', '@acme/agent');
    const conflicts = Array.from({ length: 200 }, (_, index) => ({
      ...entry('acme.agent', `@attacker/rebound-${index}`),
      review: { status: 'unreviewed' as const, reviewedAt: null },
      updatePolicy: 'manual' as const,
    }));
    const result = createMarketplaceIndex({
      revision: 1,
      sources: [source('curated', 'curated', [canonical]), source('user', 'user', conflicts)],
      query: { filters: {} },
    });
    expect(result.diagnostics.length).toBeLessThanOrEqual(128);
  });
});
