import { mkdtemp, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadPluginDaemonModule } from './loadPluginDaemonModule';

async function writeDaemonModule(params: Readonly<{ extension: string; contents: string }>): Promise<string> {
    const rootDir = await mkdtemp(join(tmpdir(), 'happier-plugin-daemon-module-'));
    const daemonEntryPath = join(rootDir, `daemon.${params.extension}`);
    await writeFile(daemonEntryPath, params.contents, 'utf8');
    return daemonEntryPath;
}

describe('loadPluginDaemonModule', () => {
    it('loads a supported daemon entry path and caches repeated loads by absolute path', async () => {
        const daemonEntryPath = await writeDaemonModule({
            extension: 'mjs',
            contents: 'export async function resolveTranscriptBinding() { return "loaded"; }\n',
        });

        const first = await loadPluginDaemonModule({ daemonEntryPath, trustPolicy: 'local_trusted' });
        const second = await loadPluginDaemonModule({ daemonEntryPath, trustPolicy: 'local_trusted' });

        expect(typeof first.resolveTranscriptBinding).toBe('function');
        expect(second).toBe(first);
    });

    it('fails clearly when the daemon entry path does not exist', async () => {
        const missingRootDir = await mkdtemp(join(tmpdir(), 'happier-plugin-daemon-missing-'));
        const daemonEntryPath = join(missingRootDir, 'missing.mjs');

        await expect(loadPluginDaemonModule({ daemonEntryPath, trustPolicy: 'local_trusted' })).rejects.toThrow(
            /Plugin daemon entry does not exist/,
        );
    });

    it('rejects unsupported daemon entry plugins instead of assuming a TypeScript runtime', async () => {
        const daemonEntryPath = await writeDaemonModule({
            extension: 'ts',
            contents: 'export function resolveTranscriptBinding() { return "nope"; }\n',
        });

        await expect(loadPluginDaemonModule({ daemonEntryPath, trustPolicy: 'local_trusted' })).rejects.toThrow(
            /Unsupported plugin daemon entry extension/,
        );
    });

    it('fails closed when executable trust metadata is missing', async () => {
        const daemonEntryPath = await writeDaemonModule({
            extension: 'mjs',
            contents: 'export const version = 1;\n',
        });

        await expect(loadPluginDaemonModule({ daemonEntryPath })).rejects.toThrow(
            /requires explicit trust approval/,
        );
    });

    it('invalidates cached daemon modules when the on-disk module fingerprint changes', async () => {
        const daemonEntryPath = await writeDaemonModule({
            extension: 'mjs',
            contents: 'export const version = 1;\n',
        });

        const first = await loadPluginDaemonModule({ daemonEntryPath, trustPolicy: 'local_trusted' });
        expect(first.version).toBe(1);

        await new Promise((resolve) => setTimeout(resolve, 20));
        await writeFile(daemonEntryPath, 'export const version = 2;\n', 'utf8');

        const second = await loadPluginDaemonModule({ daemonEntryPath, trustPolicy: 'local_trusted' });
        expect(second.version).toBe(2);
        expect(second).not.toBe(first);
    });

    it('invalidates cached daemon modules even when size and mtime are preserved (archive reinstall)', async () => {
        const daemonEntryPath = await writeDaemonModule({
            extension: 'mjs',
            contents: 'export const version = 1;\n',
        });

        const first = await loadPluginDaemonModule({ daemonEntryPath, trustPolicy: 'local_trusted' });
        expect(first.version).toBe(1);

        const before = await stat(daemonEntryPath);
        const preservedMtime = before.mtime;
        const preservedAtime = before.atime;

        // Same byte length, different contents.
        await writeFile(daemonEntryPath, 'export const version = 2;\n', 'utf8');
        await utimes(daemonEntryPath, preservedAtime, preservedMtime);

        const second = await loadPluginDaemonModule({ daemonEntryPath, trustPolicy: 'local_trusted' });
        expect(second.version).toBe(2);
        expect(second).not.toBe(first);
    });
});
