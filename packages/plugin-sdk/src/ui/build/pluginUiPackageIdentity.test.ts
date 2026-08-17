import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
    assertSinglePluginUiPackageInstance,
    createPluginUiPackageInstanceRepackPlugin,
    createPluginUiPackageInstanceVitePlugin,
} from './pluginUiPackageIdentity.js';

let fixtureRoot: string | undefined;

async function createPackageRoot(relativePath: string): Promise<string> {
    if (!fixtureRoot) {
        fixtureRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-ui-package-identity-'));
    }
    const packageRoot = join(fixtureRoot, relativePath);
    await mkdir(join(packageRoot, 'dist'), { recursive: true });
    await writeFile(join(packageRoot, 'package.json'), '{"name":"@happier-dev/plugin-ui"}\n', 'utf8');
    return packageRoot;
}

afterEach(async () => {
    if (fixtureRoot) {
        await rm(fixtureRoot, { recursive: true, force: true });
        fixtureRoot = undefined;
    }
});

describe('plugin UI package identity build guard', () => {
    it('allows the public Voice client graph with no Plugin UI package while retaining duplicate-root protection', async () => {
        const first = await createPackageRoot('node_modules/@happier-dev/plugin-ui');
        const second = await createPackageRoot('feature/node_modules/@happier-dev/plugin-ui');
        const voiceEntry = fileURLToPath(new URL(
            '../../../examples/public-authoring/voiceProvider.ts',
            import.meta.url,
        ));
        const plugin = createPluginUiPackageInstanceVitePlugin();

        expect(assertSinglePluginUiPackageInstance([{ resource: voiceEntry }])).toEqual([]);
        expect(() => plugin.generateBundle.call({
            getModuleIds: () => [voiceEntry],
        })).not.toThrow();
        expect(() => assertSinglePluginUiPackageInstance([
            { resource: join(first, 'dist/surfaceEntry.js') },
            { resource: join(second, 'dist/components/Button.js') },
        ])).toThrow('must not bundle more than one physical @happier-dev/plugin-ui package');
    });

    it('accepts one physical package root and rejects a nested second root', async () => {
        const first = await createPackageRoot('node_modules/@happier-dev/plugin-ui');
        const second = await createPackageRoot('feature/node_modules/@happier-dev/plugin-ui');

        expect(assertSinglePluginUiPackageInstance([
            { resource: join(first, 'dist/surfaceEntry.js') },
            { resource: join(first, 'dist/components/Button.js') },
        ])).toHaveLength(1);
        expect(() => assertSinglePluginUiPackageInstance([
            { resource: join(first, 'dist/surfaceEntry.js') },
            { resource: join(second, 'dist/components/Button.js') },
        ])).toThrow('must not bundle more than one physical @happier-dev/plugin-ui package');
    });

    it('fails the RNW Vite graph before output generation when a second package root is reachable', async () => {
        const first = await createPackageRoot('node_modules/@happier-dev/plugin-ui');
        const second = await createPackageRoot('feature/node_modules/@happier-dev/plugin-ui');
        const plugin = createPluginUiPackageInstanceVitePlugin();

        expect(plugin.name).toBe('happier-plugin-ui-package-instance');
        expect(() => plugin.generateBundle.call({
            getModuleIds: () => [
                join(first, 'dist/surfaceEntry.js'),
                join(second, 'dist/components/Button.js'),
            ],
        })).toThrow('must not bundle more than one physical @happier-dev/plugin-ui package');
    });

    it('records a Re.Pack compilation error before the artifact stager can replace the last-known-good tree', async () => {
        const first = await createPackageRoot('node_modules/@happier-dev/plugin-ui');
        const second = await createPackageRoot('feature/node_modules/@happier-dev/plugin-ui');
        let afterCompile: ((compilation: { modules: readonly unknown[]; errors: Error[] }) => void) | undefined;
        const plugin = createPluginUiPackageInstanceRepackPlugin();

        plugin.apply({
            hooks: {
                afterCompile: {
                    tap: (_name, callback) => { afterCompile = callback; },
                },
            },
        });
        const compilation = {
            modules: [
                { resource: join(first, 'dist/surfaceEntry.js') },
                { resource: join(second, 'dist/components/Button.js') },
            ],
            errors: [] as Error[],
        };
        afterCompile?.(compilation);

        expect(compilation.errors).toHaveLength(1);
        expect(compilation.errors[0]?.message).toContain('must not bundle more than one physical @happier-dev/plugin-ui package');
    });
});
