import { describe, expect, it } from 'vitest';

import { ingestPluginManifestV2 } from './ingest.js';

function manifest(runtime: unknown): Readonly<Record<string, unknown>> {
  return {
    schemaVersion: 2,
    id: 'com.acme.runtime-api-fixture',
    version: '1.0.0',
    displayName: 'Runtime API fixture',
    engines: { happier: '^0.2.0' },
    ...(runtime === undefined ? {} : { runtime }),
    hostAccess: { required: [], optional: [] },
    contributes: {},
  };
}

describe('plugin manifest runtime API compatibility', () => {
  it('accepts only the current required runtime API generation', () => {
    expect(ingestPluginManifestV2(manifest({ apiVersion: 1 }))).toMatchObject({
      ok: true,
      manifest: {
        runtime: { apiVersion: 1 },
      },
    });

    expect(ingestPluginManifestV2(manifest(undefined))).toMatchObject({
      ok: false,
      diagnostics: [
        expect.objectContaining({
          code: 'plugin_manifest_invalid',
          path: ['runtime'],
        }),
      ],
    });

    expect(ingestPluginManifestV2(manifest({ apiVersion: 2 }))).toMatchObject({
      ok: false,
      diagnostics: [
        expect.objectContaining({
          code: 'plugin_manifest_invalid',
          path: ['runtime', 'apiVersion'],
        }),
      ],
    });

    expect(ingestPluginManifestV2(manifest({
      apiVersion: 1,
      capabilities: ['agents'],
    }))).toMatchObject({
      ok: false,
      diagnostics: [
        expect.objectContaining({
          code: 'plugin_manifest_invalid',
          path: ['runtime', 'capabilities'],
        }),
      ],
    });
  });
});
