import { createImmutablePluginGenerationRecordFromSource } from '../store/registry/generationStore';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { readPluginManifest, readAdmittedGenerationNpmPackageName } from './read';
import { ingestCanonicalPluginManifest } from './ingest';
import { serializeCanonicalPluginManifest } from './serialize';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { projectPluginAttributedCompatibilityFailure } from './diagnostics';
import { CHANNEL_STATE_COLLECTION } from '../../../../../packages/plugins/channels/src/collections';

const roots: string[] = [];
const requireFromCli = createRequire(import.meta.url);
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe('readPluginManifest target route', () => {
  it('reloads a retained first-party npm generation using its acquired package identity', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'happier-retained-npm-'));
    roots.push(rootPath);
    await writeFile(join(rootPath, 'package.json'), JSON.stringify({ name: '@happier-dev/plugins-asciinema' }));
    const manifestPath = join(rootPath, 'plugin.json');
    await writeFile(manifestPath, JSON.stringify(createPluginManifestV2Fixture({ id: 'happier.asciinema' })));
    const record = await createImmutablePluginGenerationRecordFromSource({ pluginId: 'happier.asciinema',
      sourceRootPath: rootPath, manifestRelativePath: 'plugin.json',
      distribution: { kind: 'npm', registryOrigin: 'https://registry.npmjs.org', packageName: '@happier-dev/plugins-asciinema' },
      updatePolicy: 'allowed', createdAtMs: 1 });
    expect(await readPluginManifest({ manifestPath, sourceProvenance: record.sourceProvenance, purpose: 'installedRead',
      registryPackageName: await readAdmittedGenerationNpmPackageName({ rootPath, record }) }))
      .toMatchObject({ ok: true, manifest: { id: 'happier.asciinema' } });
  });

  it('loads stored retired families at installed-file ingress while keeping authoring strict', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-manifest-retired-'));
    roots.push(root);
    const manifestPath = join(root, 'plugin.json');
    const current = createPluginManifestV2Fixture({ contributes: { actions: [{
      id: 'healthy', title: 'Healthy', scopes: ['global'], surfaces: ['plugin'],
      execution: { target: 'daemon' }, dangerLevel: 'safe',
    }] } });
    for (const retired of [[], [{ id: 'retired' }]]) {
      await writeFile(manifestPath, JSON.stringify({ ...current,
        contributes: { ...current.contributes, tools: retired, commands: retired },
      }));
      const loaded = await readPluginManifest({ manifestPath, sourceProvenance: 'localSource', purpose: 'installedRead' });
      expect(loaded).toMatchObject({ ok: true, manifest: { contributes: { actions: [{ id: 'healthy' }] } } });
      if (!loaded.ok) throw new Error('Stored installed declaration must remain readable');
      expect(loaded.manifest.contributes).not.toHaveProperty('tools');
      expect(loaded.manifest.contributes).not.toHaveProperty('commands');
      expect(loaded.diagnostics ?? []).toEqual(retired.length === 0 ? [] : [
        expect.objectContaining({ code: 'plugin_contribution_skipped' }),
        expect.objectContaining({ code: 'plugin_contribution_skipped' }),
      ]);
      expect(await readPluginManifest({ manifestPath, sourceProvenance: 'localSource', purpose: 'authoring' }))
        .toMatchObject({ ok: false });
    }
  });

  it('keeps the typed engine refusal at the file boundary and cannot bypass host load', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-manifest-engine-'));
    roots.push(root);
    const manifestPath = join(root, 'plugin.json');
    await writeFile(manifestPath, JSON.stringify(createPluginManifestV2Fixture({ engines: { happier: '>=999.0.0' } })));
    const result = await readPluginManifest({ manifestPath, sourceProvenance: 'localSource',
      manifestAuthority: 'bundled_first_party', purpose: 'installedRead', enforceEngineCompatibility: false });
    expect(result).toMatchObject({ ok: false, diagnostics: [{ code: 'plugin_manifest_engine_incompatible' }] });
    if (result.ok) throw new Error('Incompatible host must be refused');
    expect(projectPluginAttributedCompatibilityFailure(result.diagnostics)).toEqual({
      code: 'plugin_manifest_engine_incompatible', message: 'Plugin manifest requires a compatible Happier CLI version',
    });
    expect(await readPluginManifest({ manifestPath, sourceProvenance: 'localSource', purpose: 'authoring' }))
      .toMatchObject({ ok: true });
  });
  it('rejects malformed UTF-8 bytes before materializing manifest text', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-manifest-'));
    roots.push(root);
    const path = join(root, 'plugin.json');
    await writeFile(path, Buffer.concat([
      Buffer.from('{"schemaVersion":2,"id":"com.acme.plugin","version":"1.0.0","displayName":"'),
      Buffer.from([0xff]),
      Buffer.from('","engines":{"happier":"^0.3.0"},"runtime":{"apiVersion":1},"contributes":{}}'),
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
      purpose: 'authoring' as const,
    };
    const compiledManifest = compiledManifestModule.PLUGIN_MANIFEST;
    const channelStateCollection = compiledManifest.contributes?.accountCollections?.find(
      (collection: { id?: unknown }) => collection.id === 'channel-state',
    );
    expect(channelStateCollection).toMatchObject({
      id: 'channel-state',
      schemaVersion: CHANNEL_STATE_COLLECTION.schemaVersion,
      readableSchemaVersions: CHANNEL_STATE_COLLECTION.readableSchemaVersions,
      migrations: CHANNEL_STATE_COLLECTION.migrations.map(({ id, fromSchemaVersion, toSchemaVersion }) => ({
        id, fromSchemaVersion, toSchemaVersion,
      })),
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

  it('reports a missing manifest file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-manifest-'));
    roots.push(root);
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
      engines: { happier: '^0.3.0' },
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
    const result = await readPluginManifest({ sourceProvenance: 'registryCustodied', manifestPath: path, purpose: 'authoring' });
    expect(result.ok).toBe(false);
    const message = result.ok ? '' : result.diagnostics.map((diagnostic) => diagnostic.message).join(' | ');
    expect(message).toContain('contributes.ui.renderers.0.root.children.0.kind');
  });
});
