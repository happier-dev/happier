import { normalizePluginAccountCollectionMigrationRuntimeProjection } from '@happier-dev/plugin-sdk';
import { parsePluginManifest } from '@happier-dev/plugin-sdk/manifest';
import { describe, expect, it } from 'vitest';

import {
  CHANNEL_DELIVERIES_COLLECTION_ID,
  CHANNEL_STATE_COLLECTION_ID,
} from './collections.js';
import * as entry from './index.js';
import { PLUGIN_MANIFEST } from './manifest.js';

describe('Channels plugin daemon entry', () => {
  it('exposes the callable activation the host resolves from the declared entrypoint', () => {
    expect(PLUGIN_MANIFEST.entrypoints?.daemon).toBe('./dist/index.js');
    expect(entry.activate).toBeTypeOf('function');
  });

  it('exports the executable Collection migration half the author-module guard requires', () => {
    // The host projects this exported namespace member against the parsed
    // manifest declarations before any candidate may be loaded or bundled, so
    // an author module that declares Collections without exporting their
    // migration projection is rejected outright rather than degraded.
    const parsed = parsePluginManifest(PLUGIN_MANIFEST);
    if (!parsed.ok) {
      throw new Error('The Channels manifest must parse before its migrations can be projected.');
    }

    const projection = normalizePluginAccountCollectionMigrationRuntimeProjection(
      entry.collectionMigrations,
      parsed.manifest.contributes.accountCollections,
    );

    // Both declared Collections are present, and each carries exactly the
    // migration edges the manifest declares — today none, because neither
    // Collection declares a readable schema version below its current one.
    expect(Object.keys(projection).sort()).toEqual(
      [CHANNEL_DELIVERIES_COLLECTION_ID, CHANNEL_STATE_COLLECTION_ID].sort(),
    );
    for (const declaration of parsed.manifest.contributes.accountCollections) {
      expect(projection[declaration.id]?.map((migration) => migration.id))
        .toEqual(declaration.migrations.map((migration) => migration.id));
    }
  });
});
