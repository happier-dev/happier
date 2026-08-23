import { describe, expect, it } from 'vitest';

import { ingestCanonicalPluginManifest } from './ingest';

const fixture = {
  schemaVersion: 2,
  id: 'com.acme.parity',
  version: '1.0.0',
  displayName: 'Parity',
  engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 },
  entrypoints: { daemon: './dist/plugin.js' },
  contributes: {
    actions: [{ id: 'run', title: 'Run', scopes: ['session'], surfaces: ['cli'], execution: { target: 'daemon' }, placementBindings: ['primary'], dangerLevel: 'safe' }],
    tools: [{ id: 'run-tool', title: 'Run', name: 'run', action: 'run' }],
  },
} as const;

describe('CLI canonical manifest ingestion', () => {
  it('normalizes installed UTF-8 bytes and bundled objects identically', () => {
    const installed = ingestCanonicalPluginManifest(Buffer.from(JSON.stringify(fixture), 'utf8'), { sourceProvenance: 'registryCustodied' });
    const bundled = ingestCanonicalPluginManifest(fixture, { sourceProvenance: 'registryCustodied' });

    expect(installed).toEqual(bundled);
    expect(installed).toEqual({ ok: true, manifest: expect.any(Object) });
  });

  it('returns identical coded diagnostics for malformed installed and bundled input', () => {
    const malformed = { ...fixture, unexpectedBehavior: true };
    const installed = ingestCanonicalPluginManifest(Buffer.from(JSON.stringify(malformed), 'utf8'), { sourceProvenance: 'registryCustodied' });
    const bundled = ingestCanonicalPluginManifest(malformed, { sourceProvenance: 'registryCustodied' });

    expect(installed).toEqual(bundled);
    expect(installed).toEqual({
      ok: false,
      diagnostics: [expect.objectContaining({ code: 'plugin_manifest_invalid' })],
    });
  });

  it('keeps bundled first-party namespace and engine exceptions explicit at ingestion', () => {
    const bundledFixture = {
      ...fixture,
      id: 'happier.fixture.parity',
      engines: { happier: '^0.0.0' }, runtime: { apiVersion: 1 },
    };

    expect(ingestCanonicalPluginManifest(bundledFixture, { sourceProvenance: 'registryCustodied' }).ok).toBe(false);
    expect(ingestCanonicalPluginManifest(bundledFixture, { sourceProvenance: 'localSource',
      manifestAuthority: 'bundled_first_party',
      enforceEngineCompatibility: false,
    })).toEqual({ ok: true, manifest: expect.any(Object) });
  });
});
