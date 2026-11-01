import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { derivePluginAccountContributionRegistrationRights } from '@happier-dev/protocol/plugins/contributions/catalog';
import { createPluginRegistrationScope } from '../../packages/plugin-sdk/src/registration/scope.ts';
import { parsePluginManifest } from '../../packages/plugin-sdk/src/manifest.ts';
import { discoverExecutablePluginUiArtifacts } from '../../packages/plugin-sdk/src/ui/build/manifestArtifactDiscovery.ts';

for (const name of ['fly', 'hetzner', 'vercel', 'boat', 'daytona', 'e2b', 'digitalocean',
    'upstash-box', 'freestyle', 'superserve', 'railway']) {
    test(`loads and activates every declared Account artifact for ${name}`, async () => {
        const root = resolve(import.meta.dirname, '../../packages/plugins', `machine-${name}`);
        const source = await import(pathToFileURL(join(root, 'src/manifest.ts')).href);
        const parsed = parsePluginManifest(source.PLUGIN_MANIFEST);
        if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
        const manifest = parsed.manifest;
        const directory = await mkdtemp(join(tmpdir(), 'machine-account-artifacts-'));
        try {
            const manifestPath = join(directory, 'plugin.json');
            await writeFile(manifestPath, JSON.stringify(manifest));
            const artifacts = await discoverExecutablePluginUiArtifacts(root, manifestPath, ['happier-source']);
            assert(artifacts.some(artifact => artifact.artifactId === 'account-runtime'));
            for (const artifact of artifacts) {
                const module = await import(pathToFileURL(artifact.entryPath).href);
                for (const exportName of artifact.requestedExports) {
                    const binding = { artifactId: artifact.artifactId, exportName };
                    const scope = createPluginRegistrationScope({ pluginId: manifest.id,
                        target: { realm: 'account', ...binding },
                        rights: derivePluginAccountContributionRegistrationRights(manifest.contributes, binding) });
                    try {
                        assert.equal(typeof module[exportName], 'function');
                        await module[exportName](scope.api);
                        assert(scope.commit().length > 0);
                    } finally { await scope.dispose(); }
                }
            }
        } finally { await rm(directory, { recursive: true, force: true }); }
    });
}
