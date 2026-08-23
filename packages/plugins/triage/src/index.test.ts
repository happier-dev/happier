import { normalizePluginAccountCollectionMigrationRuntimeProjection } from '@happier-dev/plugin-sdk';
import { parsePluginManifest } from '@happier-dev/plugin-sdk/manifest';
import { describe, expect, it } from 'vitest';

import {
  CORPUS_SESSION_LINKS_COLLECTION_ID,
  CORPUS_SOURCE_INSTANCES_COLLECTION_ID,
  CORPUS_USER_MARKS_COLLECTION_ID,
} from './corpus/collections/ids.js';
import * as entry from './index.js';
import { PLUGIN_MANIFEST } from './manifest.js';

describe('Triage plugin daemon entry', () => {
  it('exposes the callable activation the host resolves from the declared entrypoint', () => {
    // `PLUGIN_MANIFEST.entrypoints.daemon` points the host at the packaged
    // daemon runtime the canonical packager emits from this module, and the
    // host loader requires a callable `activate` export.
    expect(PLUGIN_MANIFEST.entrypoints.daemon).toBe('./.happier-plugin/daemon.js');
    expect(entry.activate).toBeTypeOf('function');
    expect(entry.activate.length).toBe(1);
  });

  it('re-exports the one manifest the bundled registry imports', () => {
    expect(entry.PLUGIN_MANIFEST).toBe(PLUGIN_MANIFEST);
    expect(entry.manifest).toBe(PLUGIN_MANIFEST);
  });

  it('exports the executable Collection migration half the author-module guard requires', () => {
    // The host projects this exported namespace member against the parsed
    // manifest declarations before any candidate may be loaded or bundled, so
    // an author module that declares Collections without exporting their
    // migration projection is rejected outright rather than degraded.
    const parsed = parsePluginManifest(PLUGIN_MANIFEST);
    if (!parsed.ok) {
      throw new Error('The Triage manifest must parse before its migrations can be projected.');
    }

    const projection = normalizePluginAccountCollectionMigrationRuntimeProjection(
      entry.collectionMigrations,
      parsed.manifest.contributes.accountCollections,
    );

    // All three declared Collections are present, and each carries exactly the
    // migration edges the manifest declares — today none, because none of them
    // declares a readable schema version below its current one.
    expect(Object.keys(projection).sort()).toEqual([
      CORPUS_SESSION_LINKS_COLLECTION_ID,
      CORPUS_SOURCE_INSTANCES_COLLECTION_ID,
      CORPUS_USER_MARKS_COLLECTION_ID,
    ].sort());
    for (const declaration of parsed.manifest.contributes.accountCollections) {
      expect(projection[declaration.id]?.map((migration) => migration.id))
        .toEqual(declaration.migrations.map((migration) => migration.id));
    }
  });
});
