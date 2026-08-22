import { describe, expect, it } from 'vitest';

import { ingestPluginManifestV2 } from '@happier-dev/protocol';

import { serializeCanonicalPluginManifest } from './serialize';

describe('serializeCanonicalPluginManifest', () => {
  it('produces the same canonical bytes from equivalent authored field orders', () => {
    const first = ingestPluginManifestV2({
      schemaVersion: 2,
      id: 'example.canonical-bytes',
      version: '0.1.0',
      displayName: 'Canonical bytes',
      engines: { happier: '>=0.0.0' },
      runtime: { apiVersion: 1 },
      hostAccess: { required: [], optional: [] },
      contributes: {},
    });
    const reordered = ingestPluginManifestV2({
      contributes: {},
      hostAccess: { optional: [], required: [] },
      runtime: { apiVersion: 1 },
      engines: { happier: '>=0.0.0' },
      displayName: 'Canonical bytes',
      version: '0.1.0',
      id: 'example.canonical-bytes',
      schemaVersion: 2,
    });
    if (!first.ok || !reordered.ok) throw new Error('Fixture manifest must be valid');

    expect(serializeCanonicalPluginManifest(reordered.manifest)).toBe(
      serializeCanonicalPluginManifest(first.manifest),
    );
    expect(serializeCanonicalPluginManifest(first.manifest).endsWith('\n')).toBe(true);
  });

  it('recursively canonicalizes nested record keys while preserving array order', () => {
    const first = ingestPluginManifestV2({
      schemaVersion: 2,
      id: 'example.nested-canonical-bytes',
      version: '0.1.0',
      displayName: 'Nested canonical bytes',
      engines: { happier: '>=0.0.0' },
      runtime: { apiVersion: 1 },
      hostAccess: { required: [], optional: [] },
      contributes: {},
      metadata: {
        outer: { beta: 2, alpha: 1 },
        ordered: [{ second: true, first: false }, 'tail'],
      },
    });
    const reordered = ingestPluginManifestV2({
      schemaVersion: 2,
      id: 'example.nested-canonical-bytes',
      version: '0.1.0',
      displayName: 'Nested canonical bytes',
      engines: { happier: '>=0.0.0' },
      runtime: { apiVersion: 1 },
      hostAccess: { required: [], optional: [] },
      contributes: {},
      metadata: {
        ordered: [{ first: false, second: true }, 'tail'],
        outer: { alpha: 1, beta: 2 },
      },
    });
    if (!first.ok || !reordered.ok) throw new Error('Fixture manifest must be valid');

    expect(serializeCanonicalPluginManifest(reordered.manifest)).toBe(
      serializeCanonicalPluginManifest(first.manifest),
    );
  });
});
