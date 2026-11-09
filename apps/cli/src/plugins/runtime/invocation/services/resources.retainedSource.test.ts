import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { PLUGIN_MANIFEST } from '../../../../../../../packages/plugins/custom-acp/src/manifest';
import { resolvePluginStorePaths } from '@/plugins/store/paths';
import { attestRetainedPluginSource } from '@/plugins/runtime/retainedPluginSourceAttestation';

import { createStableRetainedPluginResourcesOwner } from './resources';

const roots: string[] = [];
afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function retainedCustomAcpSource() {
    const directory = await mkdtemp(join(tmpdir(), 'happier-retained-acp-'));
    roots.push(directory);
    // Real source Stack paths include a runtime directory and its source identity.
    // The Resource owner must not impose the managed-store id limit on that path.
    const sourceRoot = join(directory, 'source-runtime-with-a-long-development-path'.repeat(3));
    const rootPath = join(sourceRoot, 'packages', 'plugins', 'custom-acp');
    await mkdir(join(sourceRoot, 'apps', 'cli'), { recursive: true });
    await mkdir(join(rootPath, '.happier-plugin'), { recursive: true });
    await mkdir(join(rootPath, 'assets'), { recursive: true });
    // A first-party development root is the checkout package that holds its source entry.
    await mkdir(join(rootPath, 'src'), { recursive: true });
    await writeFile(join(rootPath, 'src', 'index.ts'), 'export {};\n');
    await writeFile(join(rootPath, '.happier-plugin', 'plugin.json'), JSON.stringify(PLUGIN_MANIFEST));
    // Source-mode declarations are the runner's tracked CLI assets, which this runner publishes beside its source.
    await mkdir(join(sourceRoot, 'apps', 'cli', 'assets', 'bundled-plugin-manifests'), { recursive: true });
    await writeFile(join(sourceRoot, 'apps', 'cli', 'assets', 'bundled-plugin-manifests', 'custom-acp.json'),
        await readFile(new URL('../../../../../assets/bundled-plugin-manifests/custom-acp.json', import.meta.url)));
    const bytes = await readFile(new URL('../../../../../../../packages/plugins/custom-acp/assets/brand.png', import.meta.url));
    await writeFile(join(rootPath, 'assets', 'brand.png'), bytes);
    const source = await attestRetainedPluginSource({
        paths: resolvePluginStorePaths({ happyHomeDir: join(directory, 'home') }),
        pluginId: PLUGIN_MANIFEST.id,
        custody: { kind: 'development', registeredRootId: rootPath },
        manifestAuthority: 'bundled_first_party',
        runnerSnapshotIdentity: `path:${join(sourceRoot, 'apps', 'cli')}`,
    });
    return { source, bytes };
}

describe('retained Custom ACP source → strict Resource admission', () => {
    it('admits the real source producer identity and Resource declaration on long development paths', async () => {
        const { source, bytes } = await retainedCustomAcpSource();
        expect(source.cacheIdentity.length).toBeGreaterThan(160);
        const owner = await createStableRetainedPluginResourcesOwner({
            sourceIdentity: source.cacheIdentity,
            pluginId: source.manifest.id,
            rootPath: source.rootPath,
            declarations: source.manifest.contributes.resources,
            brandIconResourceId: source.manifest.brand?.iconResourceId,
        });
        const resource = await owner.bind({ pluginId: source.manifest.id,
            signal: new AbortController().signal, isOccurrenceCurrent: () => true }).read('brand-icon');
        expect(resource).toMatchObject({ kind: 'asset', contentType: 'image/png' });
        expect(resource.bytes).toEqual(new Uint8Array(bytes));
    });

    it('identifies the invalid identity field without disclosing its value', async () => {
        const { source } = await retainedCustomAcpSource();
        await expect(createStableRetainedPluginResourcesOwner({
            sourceIdentity: ' SECRET invalid identity ',
            pluginId: source.manifest.id,
            rootPath: source.rootPath,
            declarations: source.manifest.contributes.resources,
        })).rejects.toMatchObject({
            code: 'plugin_resource_declaration_invalid',
            details: { field: 'immutableGenerationId', reason: 'invalid_string' },
            message: expect.not.stringContaining('SECRET'),
        });
    });

    it('identifies a hostile declaration field without invoking or disclosing its getter', async () => {
        const { source } = await retainedCustomAcpSource();
        const brandResource = source.manifest.contributes.resources?.find(
            ({ id }) => id === source.manifest.brand?.iconResourceId,
        );
        if (!brandResource) throw new Error('Expected the retained manifest to declare its brand Resource.');
        const declaration = { ...brandResource };
        let reads = 0;
        Object.defineProperty(declaration, 'path', { get: () => {
            reads += 1;
            throw new Error('SECRET GETTER TEXT');
        } });
        await expect(createStableRetainedPluginResourcesOwner({
            sourceIdentity: 'retained-source', pluginId: source.manifest.id,
            rootPath: source.rootPath, declarations: [declaration],
        })).rejects.toMatchObject({
            code: 'plugin_resource_declaration_invalid',
            details: { field: 'path', reason: 'accessor' },
            message: expect.not.stringContaining('SECRET'),
        });
        expect(reads).toBe(0);
    });
});
