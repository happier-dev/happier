import { mkdtemp, writeFile } from 'node:fs/promises';
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
            contents: 'export async function bindTranscript() { return "loaded"; }\n',
        });

        const first = await loadPluginDaemonModule({ daemonEntryPath });
        const second = await loadPluginDaemonModule({ daemonEntryPath });

        expect(typeof first.bindTranscript).toBe('function');
        expect(second).toBe(first);
    });

    it('fails clearly when the daemon entry path does not exist', async () => {
        const missingRootDir = await mkdtemp(join(tmpdir(), 'happier-plugin-daemon-missing-'));
        const daemonEntryPath = join(missingRootDir, 'missing.mjs');

        await expect(loadPluginDaemonModule({ daemonEntryPath })).rejects.toThrow(
            /Plugin daemon entry does not exist/,
        );
    });

    it('rejects unsupported daemon entry extensions instead of assuming a TypeScript runtime', async () => {
        const daemonEntryPath = await writeDaemonModule({
            extension: 'ts',
            contents: 'export function bindTranscript() { return "nope"; }\n',
        });

        await expect(loadPluginDaemonModule({ daemonEntryPath })).rejects.toThrow(
            /Unsupported plugin daemon entry extension/,
        );
    });
});
