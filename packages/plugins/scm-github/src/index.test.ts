import { normalizePluginAccountCollectionMigrationRuntimeProjection } from '@happier-dev/plugin-sdk';
import { parsePluginManifest } from '@happier-dev/plugin-sdk/manifest';
import { describe, expect, it } from 'vitest';

import * as entry from './index.js';
import { PLUGIN_MANIFEST } from './manifest.js';
import { GITHUB_AUTOMATION_EVENT_CHECKPOINT_COLLECTION_ID } from './observations/githubAutomationEventCheckpoint.js';

describe('GitHub plugin daemon entry', () => {
  it('exports the executable Collection migration half the author-module guard requires', () => {
    // The host projects this exported namespace member against the parsed
    // manifest declarations before any candidate may be loaded or bundled, so
    // an author module that declares Collections without exporting their
    // migration projection is rejected outright rather than degraded.
    const parsed = parsePluginManifest(PLUGIN_MANIFEST);
    if (!parsed.ok) {
      throw new Error('The GitHub manifest must parse before its migrations can be projected.');
    }

    const projection = normalizePluginAccountCollectionMigrationRuntimeProjection(
      entry.collectionMigrations,
      parsed.manifest.contributes.accountCollections,
    );

    expect(Object.keys(projection)).toEqual([GITHUB_AUTOMATION_EVENT_CHECKPOINT_COLLECTION_ID]);
    for (const declaration of parsed.manifest.contributes.accountCollections) {
      expect(projection[declaration.id]?.map((migration) => migration.id)).toEqual(
        declaration.migrations.map((migration) => migration.id),
      );
    }
  });
});
