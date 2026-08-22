import { describe, expect, it } from 'vitest';

import {
  createMarketplaceNpmDiscoveryProjectionV1,
  deriveMarketplaceNpmCompatibilityPlatformsV1,
  MarketplaceIndexQueryResultV1Schema,
  MarketplaceIndexQueryV1Schema,
  MarketplaceNpmDiscoveryProjectionV1Schema,
  MarketplaceIndexSourceSnapshotV1Schema,
} from './marketplaceIndexV1.js';
import { PluginCompatibilityProjectionV1Schema } from '../plugins/availability/v1.js';

describe('MarketplaceIndexV1', () => {
  it('derives a closed npm discovery projection from generated compatibility facts', () => {
    const compatibility = PluginCompatibilityProjectionV1Schema.parse({
      version: 1,
      manifest: {
        schemaVersion: 2,
        id: 'acme.discovery',
        version: '1.0.0',
        displayName: { key: 'plugin.title', fallback: 'Acme Discovery' },
        description: { key: 'plugin.description', fallback: 'Derived from the manifest' },
        engines: { happier: '>=1.0.0' },
        runtime: { apiVersion: 1 },
        entrypoints: { daemon: './dist/index.js' },
        hostAccess: {
          required: [{
            id: 'network',
            reason: 'Connect to Acme',
            capability: 'network',
            scope: { targets: [{ kind: 'fixedOrigin', origin: 'https://api.example.test' }] },
          }],
          optional: [],
        },
        contributes: {},
      },
      uiArtifacts: { version: 1, entries: [] },
    });

    const projection = createMarketplaceNpmDiscoveryProjectionV1({
      compatibility,
      manifestDigest: `sha256:${'a'.repeat(64)}`,
    });

    expect(projection).toEqual({
      version: 1,
      pluginId: 'acme.discovery',
      manifestDigest: `sha256:${'a'.repeat(64)}`,
      display: { title: 'Acme Discovery', description: 'Derived from the manifest' },
      summary: {
        contributions: [],
        requiredHostAccess: ['network'],
        optionalHostAccess: [],
        executableRealms: ['daemon'],
      },
    });
    expect(deriveMarketplaceNpmCompatibilityPlatformsV1(compatibility)).toEqual([]);
    expect(MarketplaceNpmDiscoveryProjectionV1Schema.safeParse({
      ...projection,
      compatibility: compatibility.manifest.engines,
    }).success).toBe(false);
  });

  it('bounds query pagination and source documents', () => {
    expect(MarketplaceIndexQueryV1Schema.safeParse({ text: 'x'.repeat(257), limit: 101, cursor: null, filters: {} }).success).toBe(false);
    expect(MarketplaceIndexSourceSnapshotV1Schema.safeParse({
      source: { id: 'user', title: 'User', kind: 'user', sourceUrl: 'https://catalog.example/index.json' },
      freshness: { state: 'fresh', fetchedAtMs: 1 },
      entries: Array.from({ length: 5_001 }, () => ({})),
      diagnostics: [],
    }).success).toBe(false);
  });

  it('applies the lifecycle projector UTF-8 byte ceiling to every outward diagnostic schema', () => {
    const source = { id: 'user', title: 'User', kind: 'user' as const, sourceUrl: 'https://catalog.example/index.json' };
    const freshness = { state: 'fresh' as const, fetchedAtMs: 1 };
    const exact = { code: 'source_failed', message: 'é'.repeat(1_024) };
    const oversized = { code: 'source_failed', message: 'é'.repeat(1_025) };

    expect(MarketplaceIndexSourceSnapshotV1Schema.safeParse({
      source, freshness, entries: [], diagnostics: [exact],
    }).success).toBe(true);
    expect(MarketplaceIndexSourceSnapshotV1Schema.safeParse({
      source, freshness, entries: [], diagnostics: [oversized],
    }).success).toBe(false);

    expect(MarketplaceIndexQueryResultV1Schema.safeParse({
      revision: 1,
      items: [],
      nextCursor: null,
      sources: [{ source, freshness, diagnostics: [exact] }],
      diagnostics: [exact],
    }).success).toBe(true);
    expect(MarketplaceIndexQueryResultV1Schema.safeParse({
      revision: 1,
      items: [],
      nextCursor: null,
      sources: [{ source, freshness, diagnostics: [oversized] }],
      diagnostics: [oversized],
    }).success).toBe(false);
  });

  it.each(['http://catalog.example/index.json', 'javascript:alert(1)', 'https://token@catalog.example/index.json'])(
    'rejects unsafe source URL %s',
    (sourceUrl) => {
      expect(MarketplaceIndexSourceSnapshotV1Schema.safeParse({
        source: { id: 'user', title: 'User', kind: 'user', sourceUrl },
        freshness: { state: 'fresh', fetchedAtMs: 1 },
        entries: [], diagnostics: [],
      }).success).toBe(false);
    },
  );

  it('rejects registry URLs that are not canonical origins', () => {
    const base = {
      pluginId: 'acme.plugin', publisher: { id: 'acme', displayName: 'Acme' }, display: { title: 'Acme', description: null },
      distribution: { kind: 'npm', registryOrigin: 'https://registry.example/path?token=x', packageName: '@acme/plugin', version: '1.0.0', integrity: `sha512-${Buffer.alloc(64, 1).toString('base64')}` },
      manifestDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', compatibility: { happier: '>=1', platforms: ['linux'] },
      summary: { contributions: [], requiredHostAccess: [], optionalHostAccess: [], executableRealms: ['daemon'] }, review: { status: 'approved', reviewedAt: '2026-07-13T00:00:00.000Z' },
      categories: [], media: [], updatePolicy: 'curated-auto', links: {},
    };
    expect(MarketplaceIndexSourceSnapshotV1Schema.safeParse({ source: { id: 'curated', title: 'Curated', kind: 'curated', sourceUrl: 'https://catalog.example/index.json' }, freshness: { state: 'fresh', fetchedAtMs: 1 }, entries: [base], diagnostics: [] }).success).toBe(false);
  });

  it.each([
    { version: 'latest', integrity: `sha512-${Buffer.alloc(64, 1).toString('base64')}` },
    { version: '1.0', integrity: `sha512-${Buffer.alloc(64, 1).toString('base64')}` },
    { version: '1.0.0', integrity: 'sha512-YWJjZA==' },
  ])('rejects a marketplace release without exact canonical version and full SHA-512 SRI: $version', (distribution) => {
    const entry = {
      pluginId: 'acme.plugin', publisher: { id: 'acme', displayName: 'Acme' }, display: { title: 'Acme', description: null },
      distribution: { kind: 'npm', registryOrigin: 'https://registry.example', packageName: '@acme/plugin', ...distribution },
      manifestDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', compatibility: { happier: '>=1', platforms: ['linux'] },
      summary: { contributions: [], requiredHostAccess: [], optionalHostAccess: [], executableRealms: ['daemon'] }, review: { status: 'approved', reviewedAt: '2026-07-13T00:00:00.000Z' },
      categories: [], media: [], updatePolicy: 'curated-auto', links: {},
    };
    expect(MarketplaceIndexSourceSnapshotV1Schema.safeParse({ source: { id: 'curated', title: 'Curated', kind: 'curated', sourceUrl: 'https://catalog.example/index.json' }, freshness: { state: 'fresh', fetchedAtMs: 1 }, entries: [entry], diagnostics: [] }).success).toBe(false);
  });
});
