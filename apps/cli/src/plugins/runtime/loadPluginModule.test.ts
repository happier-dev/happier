import { mkdtemp, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { PluginModuleNamespace } from './loadPluginModule';
import { loadPluginModule } from './loadPluginModule';

async function writeDaemonModule(params: Readonly<{ extension: string; contents: string }>): Promise<string> {
    const rootDir = await mkdtemp(join(tmpdir(), 'happier-plugin-daemon-module-'));
    const daemonEntryPath = join(rootDir, `daemon.${params.extension}`);
    await writeFile(daemonEntryPath, params.contents, 'utf8');
    return daemonEntryPath;
}

describe('loadPluginModule', () => {
    it('loads a trusted file-backed daemon entry and caches repeated loads by entry path + fingerprint', async () => {
        const entryPath = await writeDaemonModule({
            extension: 'mjs',
            contents: 'export async function resolveTranscriptBinding() { return "loaded"; }\n',
        });

        const first = await loadPluginModule({
            source: { kind: 'file_backed', entryPath, trustPolicy: 'local_trusted' },
        });
        const second = await loadPluginModule({
            source: { kind: 'file_backed', entryPath, trustPolicy: 'local_trusted' },
        });

        expect(typeof (first as PluginModuleNamespace).resolveTranscriptBinding).toBe('function');
        expect(second).toBe(first);
    });

    it('fails clearly when a file-backed daemon entry path does not exist', async () => {
        const missingRootDir = await mkdtemp(join(tmpdir(), 'happier-plugin-daemon-missing-'));
        const entryPath = join(missingRootDir, 'missing.mjs');

        await expect(loadPluginModule({
            source: { kind: 'file_backed', entryPath, trustPolicy: 'local_trusted' },
        })).rejects.toThrow(/daemon entry does not exist/i);
    });

    it('rejects unsupported file-backed daemon entry extensions', async () => {
        const entryPath = await writeDaemonModule({
            extension: 'ts',
            contents: 'export function resolveTranscriptBinding() { return "nope"; }\n',
        });

        await expect(loadPluginModule({
            source: { kind: 'file_backed', entryPath, trustPolicy: 'local_trusted' },
        })).rejects.toThrow(/Unsupported .* daemon entry extension/i);
    });

    it('fails closed when file-backed executable trust metadata is missing', async () => {
        const entryPath = await writeDaemonModule({
            extension: 'mjs',
            contents: 'export const version = 1;\n',
        });

        await expect(loadPluginModule({
            source: { kind: 'file_backed', entryPath },
        })).rejects.toThrow(/requires explicit trust approval/i);
    });

    it('invalidates cached file-backed daemon modules when the on-disk fingerprint changes', async () => {
        const entryPath = await writeDaemonModule({
            extension: 'mjs',
            contents: 'export const version = 1;\n',
        });

        const first = await loadPluginModule({
            source: { kind: 'file_backed', entryPath, trustPolicy: 'local_trusted' },
        });
        expect((first as { version?: number }).version).toBe(1);

        await new Promise((resolve) => setTimeout(resolve, 20));
        await writeFile(entryPath, 'export const version = 2;\n', 'utf8');

        const second = await loadPluginModule({
            source: { kind: 'file_backed', entryPath, trustPolicy: 'local_trusted' },
        });
        expect((second as { version?: number }).version).toBe(2);
        expect(second).not.toBe(first);
    });

    it('invalidates cached file-backed daemon modules even when size and mtime are preserved (archive reinstall)', async () => {
        const entryPath = await writeDaemonModule({
            extension: 'mjs',
            contents: 'export const version = 1;\n',
        });

        const first = await loadPluginModule({
            source: { kind: 'file_backed', entryPath, trustPolicy: 'local_trusted' },
        });
        expect((first as { version?: number }).version).toBe(1);

        const before = await stat(entryPath);
        const preservedMtime = before.mtime;
        const preservedAtime = before.atime;

        await writeFile(entryPath, 'export const version = 2;\n', 'utf8');
        await utimes(entryPath, preservedAtime, preservedMtime);

        const second = await loadPluginModule({
            source: { kind: 'file_backed', entryPath, trustPolicy: 'local_trusted' },
        });
        expect((second as { version?: number }).version).toBe(2);
        expect(second).not.toBe(first);
    });

    it('loads a bundled activation source via the provided loader and caches by moduleId + cacheKey', async () => {
        let loads = 0;
        const source = {
            kind: 'bundled' as const,
            moduleId: '@happier-dev/plugins-acme/daemon:test-cache-1',
            load: async () => {
                loads += 1;
                return { version: 1 } as unknown as PluginModuleNamespace;
            },
        };

        const first = await loadPluginModule({ source, cacheKey: 'gen:1' });
        const second = await loadPluginModule({ source, cacheKey: 'gen:1' });

        expect(first).toBe(second);
        expect(loads).toBe(1);
    });

    it('invalidates bundled module caches when cacheKey changes', async () => {
        let loads = 0;
        const source = {
            kind: 'bundled' as const,
            moduleId: '@happier-dev/plugins-acme/daemon:test-cache-2',
            load: async () => {
                loads += 1;
                return { version: loads } as unknown as PluginModuleNamespace;
            },
        };

        const first = await loadPluginModule({ source, cacheKey: 'gen:1' });
        const second = await loadPluginModule({ source, cacheKey: 'gen:2' });

        expect((first as { version?: number }).version).toBe(1);
        expect((second as { version?: number }).version).toBe(2);
        expect(second).not.toBe(first);
        expect(loads).toBe(2);
    });
});
