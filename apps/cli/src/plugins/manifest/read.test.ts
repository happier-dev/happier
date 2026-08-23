import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

const crypto = vi.hoisted(() => ({
  createHash: vi.fn(() => {
    throw new Error('ordinary manifest reads must not hash raw manifest contents');
  }),
}));

vi.mock('node:crypto', () => crypto);

import { readPluginManifest } from './read';
import { ingestCanonicalPluginManifest } from './ingest';
import { serializeCanonicalPluginManifest } from './serialize';

const roots: string[] = [];
const requireFromCli = createRequire(import.meta.url);
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe('readPluginManifest target route', () => {
  it('reads target bytes through canonical ingestion without exposing or hashing their raw contents', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-manifest-'));
    roots.push(root);
    const path = join(root, 'plugin.json');
    await writeFile(path, JSON.stringify({ schemaVersion: 2, id: 'com.acme.plugin', version: '1.0.0', displayName: 'Acme', engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 }, contributes: {} }));
    const result = await readPluginManifest({ sourceProvenance: 'registryCustodied', manifestPath: path });
    expect(result).toEqual(expect.objectContaining({ ok: true, manifestPath: path }));
    expect(result).not.toHaveProperty('manifestDigest');
    expect(crypto.createHash).not.toHaveBeenCalled();
  });

  it('rejects malformed UTF-8 bytes before materializing manifest text', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-manifest-'));
    roots.push(root);
    const path = join(root, 'plugin.json');
    await writeFile(path, Buffer.concat([
      Buffer.from('{"schemaVersion":2,"id":"com.acme.plugin","version":"1.0.0","displayName":"'),
      Buffer.from([0xff]),
      Buffer.from('","engines":{"happier":"^0.2.0"},"runtime":{"apiVersion":1},"contributes":{}}'),
    ]));

    await expect(readPluginManifest({ sourceProvenance: 'registryCustodied', manifestPath: path })).resolves.toEqual({
      ok: false,
      diagnostics: [expect.objectContaining({
        code: 'plugin_manifest_invalid',
        message: expect.stringContaining('plugin_manifest_invalid_json'),
      })],
    });
  });

  it('round-trips the compiled Channels manifest through canonical serialization and the installed reader', async () => {
    // Resolved and imported by file URL on purpose: a bare specifier is remapped to
    // `packages/plugins/channels/src/manifest.ts` by the workspace-sources vitest plugin,
    // and this case must round-trip the COMPILED artifact the installed reader will see.
    const compiledManifestModule = await import(
      pathToFileURL(requireFromCli.resolve('@happier-dev/plugins-channels/manifest')).href,
    );
    const compatibility = {
      manifestAuthority: 'bundled_first_party' as const,
      sourceProvenance: 'localSource' as const,
      enforceEngineCompatibility: false,
    };
    const compiledManifest = compiledManifestModule.PLUGIN_MANIFEST;
    const channelStateCollection = compiledManifest.contributes?.accountCollections?.find(
      (collection: { id?: unknown }) => collection.id === 'channel-state',
    );
    expect(channelStateCollection).toMatchObject({
      id: 'channel-state',
      schemaVersion: 2,
      readableSchemaVersions: [1],
      migrations: [{
        id: 'channel-state-v1-to-v2',
        fromSchemaVersion: 1,
        toSchemaVersion: 2,
      }],
    });
    expect(Object.hasOwn(channelStateCollection?.migrations?.[0] ?? {}, 'migrate')).toBe(false);

    const ingested = ingestCanonicalPluginManifest(compiledManifest, compatibility);
    expect(ingested).toMatchObject({ ok: true });
    if (!ingested.ok) throw new Error('Compiled Channels manifest must be accepted by canonical ingress');

    const root = await mkdtemp(join(tmpdir(), 'happier-channels-manifest-'));
    roots.push(root);
    const path = join(root, 'plugin.json');
    const manifestRawText = serializeCanonicalPluginManifest(ingested.manifest);
    await writeFile(path, manifestRawText);

    await expect(readPluginManifest({ manifestPath: path, ...compatibility })).resolves.toEqual(expect.objectContaining({
      ok: true,
      manifestPath: path,
      manifestRawText,
      manifest: ingested.manifest,
    }));
    // Budget derived from this case's own import cost, not from the file default (30 s).
    // Evaluating the compiled Channels graph is the dominant term: 8.1 s under bare `node`,
    // 12.1 s inside vitest on an idle machine, and >=77 s observed while the CLI suite ran
    // alongside other lanes. The 30 s default sits inside that measured range, so the case
    // could not pass at exactly the load the full suite creates.
  }, 180_000);

  it('rejects retired root fields and reports missing files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-manifest-'));
    roots.push(root);
    const path = join(root, 'plugin.json');
    await writeFile(path, JSON.stringify({ schemaVersion: 2, id: 'com.acme.plugin', version: '1.0.0', displayName: 'Acme', engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 }, uses: [] }));
    expect(await readPluginManifest({ sourceProvenance: 'registryCustodied', manifestPath: path })).toEqual({ ok: false, diagnostics: expect.any(Array) });
    expect(await readPluginManifest({ sourceProvenance: 'registryCustodied', manifestPath: join(root, 'missing.json') })).toEqual({ ok: false, diagnostics: [expect.objectContaining({ code: 'plugin_manifest_missing' })] });
  });

  it('keeps the failing manifest path in the surfaced diagnostic message', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-manifest-'));
    roots.push(root);
    const path = join(root, 'plugin.json');
    await writeFile(path, JSON.stringify({
      schemaVersion: 2,
      id: 'com.acme.plugin',
      version: '1.0.0',
      displayName: 'Acme',
      engines: { happier: '^0.2.0' },
      runtime: { apiVersion: 1 },
        contributes: {
        ui: {
          views: [{
            id: 'v',
            container: 'rightSidebarTab',
            target: { kind: 'app' },
            renderer: 'r',
            title: 'V',
          }],
          renderers: [{
            id: 'r',
            kind: 'declarative',
            root: {
              kind: 'section',
              children: [{ kind: 'list', children: [] }],
            },
          }],
        },
      },
    }));
    const result = await readPluginManifest({ sourceProvenance: 'registryCustodied', manifestPath: path });
    expect(result.ok).toBe(false);
    const message = result.ok ? '' : result.diagnostics.map((diagnostic) => diagnostic.message).join(' | ');
    expect(message).toContain('contributes.ui.renderers.0.root.children.0.kind');
  });
});
