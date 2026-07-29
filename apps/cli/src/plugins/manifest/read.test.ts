import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';

import { readPluginManifest } from './read';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe('readPluginManifest target route', () => {
  it('reads target bytes through canonical ingestion and records their digest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-manifest-'));
    roots.push(root);
    const path = join(root, 'plugin.json');
    await writeFile(path, JSON.stringify({ schemaVersion: 2, id: 'com.acme.plugin', version: '1.0.0', displayName: 'Acme', engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 }, contributes: {} }));
    const result = await readPluginManifest({ manifestPath: path });
    expect(result).toEqual(expect.objectContaining({ ok: true, manifestDigest: expect.stringMatching(/^sha256:/) }));
  });

  it('rejects retired root fields and reports missing files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-manifest-'));
    roots.push(root);
    const path = join(root, 'plugin.json');
    await writeFile(path, JSON.stringify({ schemaVersion: 2, id: 'com.acme.plugin', version: '1.0.0', displayName: 'Acme', engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 }, uses: [] }));
    expect(await readPluginManifest({ manifestPath: path })).toEqual({ ok: false, diagnostics: expect.any(Array) });
    expect(await readPluginManifest({ manifestPath: join(root, 'missing.json') })).toEqual({ ok: false, diagnostics: [expect.objectContaining({ code: 'plugin_manifest_missing' })] });
  });
});
