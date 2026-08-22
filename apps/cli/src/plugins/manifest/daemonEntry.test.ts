import { mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolvePluginDaemonEntryPath } from './daemonEntry';
import { normalizePluginManifestV2 } from './normalize';
import type { CanonicalPluginManifest } from './types';

async function writeFileFixture(path: string, contents = 'export const ok = true;\n'): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents, 'utf8');
}

function createManifestWithEntrypoints(entrypoints?: Readonly<{
    daemon?: string;
    development?: string;
}>): CanonicalPluginManifest {
    return normalizePluginManifestV2({
        schemaVersion: 2,
        id: 'acme.sample',
        version: '1.0.0',
        displayName: 'Acme Sample',
        description: 'Fixture plugin',
        engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 },
        activation: { events: [{ kind: 'startup' }] },
        ...(entrypoints ? { entrypoints } : {}),
        hostAccess: { required: [], optional: [] },
        contributes: {},
    });
}

describe('resolvePluginDaemonEntryPath', () => {
    it('fails closed when the daemon entry escapes the plugin root via path traversal', async () => {
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-root-'));
        const outsideFile = join(pluginRoot, '..', 'outside.mjs');
        await writeFileFixture(outsideFile);

        const result = await resolvePluginDaemonEntryPath({
            pluginRootPath: pluginRoot,
            manifest: createManifestWithEntrypoints({ daemon: '../outside.mjs' }),
        });

        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.diagnostic.code).toBe('plugin_manifest_semantic_invalid');
        expect(result.diagnostic.message).toMatch(/escapes the plugin root/i);
    });

    it('fails closed when the daemon entry is a symlink that resolves outside the plugin root', async () => {
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-root-'));
        const outsideDir = await mkdtemp(join(tmpdir(), 'happier-plugin-outside-'));
        const outsideFile = join(outsideDir, 'outside.mjs');
        await writeFileFixture(outsideFile);

        const daemonEntry = join(pluginRoot, 'daemon.mjs');
        await symlink(outsideFile, daemonEntry);

        const result = await resolvePluginDaemonEntryPath({
            pluginRootPath: pluginRoot,
            manifest: createManifestWithEntrypoints({ daemon: './daemon.mjs' }),
        });

        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.diagnostic.code).toBe('plugin_manifest_semantic_invalid');
        expect(result.diagnostic.message).toMatch(/escapes the plugin root/i);
    });

    it('accepts an existing daemon entry file inside the plugin root', async () => {
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-root-'));
        const daemonEntry = join(pluginRoot, 'daemon.mjs');
        await writeFileFixture(daemonEntry);

        const result = await resolvePluginDaemonEntryPath({
            pluginRootPath: pluginRoot,
            manifest: createManifestWithEntrypoints({ daemon: './daemon.mjs' }),
        });

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(typeof result.daemonEntryPath).toBe('string');
        expect(result.daemonEntryPath).toMatch(/daemon\.mjs$/);
    });

    it('accepts an in-root daemon entry whose directory starts with dot-dot', async () => {
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-root-'));
        const daemonEntry = join(pluginRoot, '..build', 'daemon.mjs');
        await writeFileFixture(daemonEntry);
        const canonicalDaemonEntry = await realpath(daemonEntry);

        const result = await resolvePluginDaemonEntryPath({
            pluginRootPath: pluginRoot,
            manifest: createManifestWithEntrypoints({ daemon: './..build/daemon.mjs' }),
        });

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.daemonEntryPath).toBe(canonicalDaemonEntry);
    });

    it('resolves an in-root TypeScript dev daemon entry when dev entrypoints are requested', async () => {
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-root-'));
        await writeFileFixture(join(pluginRoot, 'dist', 'daemon.mjs'));
        await writeFileFixture(join(pluginRoot, 'src', 'daemon.ts'));

        const result = await resolvePluginDaemonEntryPath({
            pluginRootPath: pluginRoot,
            manifest: createManifestWithEntrypoints({
                daemon: './dist/daemon.mjs',
                development: './src/daemon.ts',
            }),
            resolveDevEntrypoint: true,
        });

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.daemonEntryPath).toMatch(/dist\/daemon\.mjs$/);
        expect(result.devDaemonEntryPath).toMatch(/src\/daemon\.ts$/);
    });

    it('rejects a TSX development entry before daemon module loading', async () => {
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-root-'));
        await writeFileFixture(join(pluginRoot, 'src', 'daemon.tsx'));

        const result = await resolvePluginDaemonEntryPath({
            pluginRootPath: pluginRoot,
            manifest: createManifestWithEntrypoints({ development: './src/daemon.tsx' }),
            resolveDevEntrypoint: true,
        });

        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.diagnostic).toEqual({
            code: 'plugin_source_kind_unsupported',
            message: expect.stringContaining("daemon dev entry extension '.tsx'"),
        });
    });

    it('uses the development entry when the production build does not exist yet', async () => {
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-root-'));
        await writeFileFixture(join(pluginRoot, 'src', 'daemon.ts'));

        const result = await resolvePluginDaemonEntryPath({
            pluginRootPath: pluginRoot,
            manifest: createManifestWithEntrypoints({
                daemon: './dist/daemon.mjs',
                development: './src/daemon.ts',
            }),
            resolveDevEntrypoint: true,
        });

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.daemonEntryPath).toBeNull();
        expect(result.devDaemonEntryPath).toMatch(/src\/daemon\.ts$/);
    });

    it('resolves a development-only entry without fabricating a production daemon entry', async () => {
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-root-'));
        await writeFileFixture(join(pluginRoot, 'src', 'daemon.ts'));

        const result = await resolvePluginDaemonEntryPath({
            pluginRootPath: pluginRoot,
            manifest: createManifestWithEntrypoints({ development: './src/daemon.ts' }),
            resolveDevEntrypoint: true,
        });

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.daemonEntryPath).toBeNull();
        expect(result.devDaemonEntryPath).toMatch(/src\/daemon\.ts$/);
    });

    it('resolves portable Windows separators in a development entry', async () => {
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-root-'));
        await writeFileFixture(join(pluginRoot, 'src', 'daemon.ts'));

        const result = await resolvePluginDaemonEntryPath({
            pluginRootPath: pluginRoot,
            manifest: createManifestWithEntrypoints({ development: '.\\src\\daemon.ts' }),
            resolveDevEntrypoint: true,
        });

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.devDaemonEntryPath).toMatch(/src[/\\]daemon\.ts$/);
    });

    it('rejects a Windows-absolute development entry on every host platform', async () => {
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-root-'));
        const result = await resolvePluginDaemonEntryPath({
            pluginRootPath: pluginRoot,
            manifest: createManifestWithEntrypoints({ development: 'C:\\outside\\daemon.ts' }),
            resolveDevEntrypoint: true,
        });

        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.diagnostic.code).toBe('plugin_manifest_semantic_invalid');
    });

    it('rejects a Windows drive-relative development entry on every host platform', async () => {
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-root-'));
        const result = await resolvePluginDaemonEntryPath({
            pluginRootPath: pluginRoot,
            manifest: createManifestWithEntrypoints({ development: 'C:daemon.ts' }),
            resolveDevEntrypoint: true,
        });

        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.diagnostic.code).toBe('plugin_manifest_semantic_invalid');
    });

    it('fails closed when a development entry symlink resolves outside the plugin root', async () => {
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-root-'));
        const outsideDir = await mkdtemp(join(tmpdir(), 'happier-plugin-outside-'));
        const outsideFile = join(outsideDir, 'outside.ts');
        await writeFileFixture(outsideFile);
        await mkdir(join(pluginRoot, 'src'), { recursive: true });
        await symlink(outsideFile, join(pluginRoot, 'src', 'daemon.ts'));

        const result = await resolvePluginDaemonEntryPath({
            pluginRootPath: pluginRoot,
            manifest: createManifestWithEntrypoints({ development: './src/daemon.ts' }),
            resolveDevEntrypoint: true,
        });

        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.diagnostic.code).toBe('plugin_manifest_semantic_invalid');
    });

    it.each([
        ['escaping', '../outside.ts', 'plugin_manifest_semantic_invalid'],
        ['missing', './src/missing.ts', 'plugin_source_missing'],
    ] as const)('rejects a %s development-only entry', async (_label, development, code) => {
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-root-'));
        await writeFileFixture(join(pluginRoot, '..', 'outside.ts'));

        const result = await resolvePluginDaemonEntryPath({
            pluginRootPath: pluginRoot,
            manifest: createManifestWithEntrypoints({ development }),
            resolveDevEntrypoint: true,
        });

        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.diagnostic.code).toBe(code);
    });

    it('accepts a descriptor-only manifest with neither daemon entrypoint', async () => {
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-root-'));

        const result = await resolvePluginDaemonEntryPath({
            pluginRootPath: pluginRoot,
            manifest: createManifestWithEntrypoints(),
            resolveDevEntrypoint: true,
        });

        expect(result).toEqual({
            ok: true,
            daemonEntryPath: null,
            devDaemonEntryPath: null,
        });
    });
});
