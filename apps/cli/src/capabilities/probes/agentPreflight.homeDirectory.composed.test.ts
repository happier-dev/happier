import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { projectAgentPreflightSessionControlsCatalogEntry } from '@/plugins/projection/registry/agentCatalogEntryHooks';
import { writeExecutableShimSync } from '@/testkit/fs/executableShim';
import { invokeCliPreflightMethod } from './agentPreflight';
import { preflightCatalogEntryFixture } from './preflightSessionControlsProbeAdapter.testkit';

describe('native Agent preflight home directory intent', () => {
    it('expands the default home in the executing process and preserves an explicit directory', async () => {
        const root = await realpath(await mkdtemp(join(tmpdir(), 'happier-preflight-home-')));
        const nativeHome = join(root, 'native-home');
        const explicitDirectory = join(root, 'explicit-project');
        await mkdir(nativeHome);
        await mkdir(explicitDirectory);
        const script = join(root, 'probe.cjs');
        await writeFile(script, 'process.stdout.write(process.cwd());');
        const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
        const executable = writeExecutableShimSync({
            dir: root,
            fileName: process.platform === 'win32' ? 'native.cmd' : 'native',
            contents: process.platform === 'win32'
                ? `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`
                : `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n`,
        });
        // HOME is the OS boundary already selected by the native worker. The
        // real preflight dispatcher, catalog, Exec owner and process stay live.
        vi.stubEnv('HOME', nativeHome);
        vi.stubEnv('USERPROFILE', nativeHome);
        try {
            const projected = projectAgentPreflightSessionControlsCatalogEntry({
                agentId: 'opencode',
                systemTools: [{ id: 'native-cwd', title: 'Native cwd', executableNames: [executable] }],
                preflightSessionControls: {
                    models: {
                        command: { toolId: 'native-cwd', args: [] },
                        parseOutput: (result) => [{ id: 'observed-cwd', name: result.stdout.trim() }],
                    },
                },
                retirementSignal: new AbortController().signal,
                isCurrent: () => true,
            });
            const adapter = await projected.getPreflightSessionControlsProbeAdapter?.();
            if (!adapter) throw new Error('Missing real native preflight adapter');
            const catalogEntry = preflightCatalogEntryFixture('opencode', adapter);
            const probe = async (cwd: string) => await invokeCliPreflightMethod(
                'opencode', 'probeModels', { cwd, bypassCache: true },
                { agentCatalogEntry: catalogEntry, accountContext: { credentials: null, accountSettings: null } }, {},
            );
            // Discriminates home expansion from blindly replacing every cwd.
            expect(await probe(explicitDirectory)).toMatchObject({ ok: true, result: {
                source: 'dynamic', availableModels: expect.arrayContaining([{ id: 'observed-cwd', name: explicitDirectory }]),
            } });
            expect(await probe('~')).toMatchObject({ ok: true, result: {
                source: 'dynamic', availableModels: expect.arrayContaining([{ id: 'observed-cwd', name: nativeHome }]),
            } });
        } finally {
            vi.unstubAllEnvs();
            await rm(root, { recursive: true, force: true });
        }
    }, 60_000);
});
