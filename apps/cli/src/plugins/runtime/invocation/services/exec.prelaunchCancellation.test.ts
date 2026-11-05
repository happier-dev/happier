import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { createStablePluginExecService } from './exec';
import { withTempDir } from '@/testkit/fs/tempDir';
import { withCodexNativeStartupLock } from '../../../../../../../packages/plugins/codex/src/agent/runtime/appServer/nativeStartupLock';

const boundary = vi.hoisted(() => ({ home: '', spawnAttempts: 0 }));
vi.mock('node:os', async importOriginal => {
    const actual = await importOriginal<typeof import('node:os')>();
    return { ...actual, userInfo: () => ({ ...actual.userInfo(), homedir: boundary.home }) };
});
vi.mock('node:child_process', async importOriginal => {
    const actual = await importOriginal<typeof import('node:child_process')>();
    return { ...actual, spawn: (...args: Parameters<typeof actual.spawn>) => {
        if (args[0] !== 'fixture-cancelled-prelaunch') return actual.spawn(...args);
        boundary.spawnAttempts += 1;
        throw new Error('Cancelled preparation must never reach OS spawn');
    } };
});

describe('Exec prelaunch cancellation', () => {
    it.each([
        { phase: 'resolution', entry: 'process', source: 'caller' },
        { phase: 'admission', entry: 'jsonRpc', source: 'host' },
    ] as const)('settles $entry on $source cancellation during held $phase without a late spawn', async ({ phase, entry, source }) => {
        await withTempDir('codex-prelaunch-cancel-', async directory => {
            boundary.home = directory;
            const lockPath = join(directory, '.happier-codex-native-startup.lock');
            let entered!: () => void;
            const started = new Promise<void>(resolve => { entered = resolve; });
            let finishResponse = () => {};
            const server = createServer((_request, response) => {
                response.writeHead(200);
                response.write('preparing');
                finishResponse = () => response.end('ready');
                entered();
            });
            await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
            const address = server.address();
            if (!address || typeof address === 'string') throw new Error('Expected HTTP fixture address');
            // The external body deliberately does not consume the operation signal.
            const readExternalPreparation = async () => {
                const response = await fetch(`http://127.0.0.1:${address.port}`);
                await response.text();
            };
            const cancellation = new AbortController();
            let released!: () => void;
            const leaseReleased = new Promise<void>(resolve => { released = resolve; });
            let releaseCount = 0;
            boundary.spawnAttempts = 0;
            const service = createStablePluginExecService({
                signal: source === 'host' ? cancellation.signal : new AbortController().signal,
                isOccurrenceCurrent: () => true,
                resolveExecutable: async () => {
                    if (phase === 'resolution') await readExternalPreparation();
                    return { command: 'fixture-cancelled-prelaunch', release() { releaseCount += 1; released(); } };
                },
                resolvePath: async () => process.cwd(),
                ...(phase === 'admission' ? { assertLaunchCurrent: readExternalPreparation } : {}),
            });
            const launch = { executable: { kind: 'systemTool', id: 'fixture.cancel' } } as const;
            const options = source === 'caller' ? { signal: cancellation.signal } : undefined;
            let outcome: unknown;
            let unexpected: { dispose(): Promise<void> } | undefined;
            const pending = withCodexNativeStartupLock(async () => entry === 'process' ? service.spawn(launch, options)
                : service.clients.spawn({ kind: 'jsonRpc', framing: 'jsonLines', launch }, options))
                .then(handle => { unexpected = handle; outcome = { started: true }; }, error => { outcome = error; });
            try {
                await started;
                expect(existsSync(lockPath)).toBe(true);
                expect(outcome).toBeUndefined();
                cancellation.abort();

                await vi.waitFor(() => expect(outcome).toMatchObject({ code: 'plugin_exec_aborted', execLaunch: 'notStarted' }));
                expect(existsSync(lockPath)).toBe(false);
                expect(boundary.spawnAttempts).toBe(0);
                finishResponse();
                await leaseReleased;
                expect(releaseCount).toBe(1);
                expect(boundary.spawnAttempts).toBe(0);
            } finally {
                cancellation.abort();
                finishResponse();
                await pending;
                await unexpected?.dispose();
                server.closeAllConnections();
                await new Promise<void>(resolve => server.close(() => resolve()));
            }
        });
    });
});
