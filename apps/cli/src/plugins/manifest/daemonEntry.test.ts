import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolvePluginDaemonEntryPath } from './daemonEntry';
import type { CanonicalPluginManifest } from './types';

async function writeFileFixture(path: string, contents = 'export const ok = true;\n'): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents, 'utf8');
}

function createManifestWithDaemonEntry(entry: string): CanonicalPluginManifest {
    return {
        schemaVersion: 2,
        id: 'acme.sample',
        version: '1.0.0',
        displayName: 'Acme Sample',
        description: 'Fixture plugin',
        engines: { happier: '^0.2.0' },
        runtime: {
            apiVersion: 1,
            capabilities: [],
        },
        permissions: [],
        targets: {
            daemon: { entry },
        },
        contributes: {
            providers: [],
            backends: [],
            actions: [],
            tools: [],
            commands: [],
            resources: [],
            uiDescriptors: [],
            hooks: [],
            lifecycleHandlers: [],
        },
    };
}

describe('resolvePluginDaemonEntryPath', () => {
    it('fails closed when the daemon entry escapes the plugin root via path traversal', async () => {
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-root-'));
        const outsideFile = join(pluginRoot, '..', 'outside.mjs');
        await writeFileFixture(outsideFile);

        const result = await resolvePluginDaemonEntryPath({
            pluginRootPath: pluginRoot,
            manifest: createManifestWithDaemonEntry('../outside.mjs'),
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
            manifest: createManifestWithDaemonEntry('./daemon.mjs'),
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
            manifest: createManifestWithDaemonEntry('./daemon.mjs'),
        });

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(typeof result.daemonEntryPath).toBe('string');
        expect(result.daemonEntryPath).toMatch(/daemon\.mjs$/);
    });
});
