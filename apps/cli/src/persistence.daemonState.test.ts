import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('readDaemonState', () => {
    const previousHomeDir = process.env.HAPPIER_HOME_DIR;
    const previousActiveServerId = process.env.HAPPIER_ACTIVE_SERVER_ID;

    afterEach(() => {
        if (previousHomeDir === undefined) delete process.env.HAPPIER_HOME_DIR;
        else process.env.HAPPIER_HOME_DIR = previousHomeDir;

        if (previousActiveServerId === undefined) delete process.env.HAPPIER_ACTIVE_SERVER_ID;
        else process.env.HAPPIER_ACTIVE_SERVER_ID = previousActiveServerId;
    });

    it('retries when the daemon state file appears shortly after the call starts', async () => {
        const homeDir = mkdtempSync(join(tmpdir(), 'happier-cli-daemon-state-'));

        vi.resetModules();
        process.env.HAPPIER_HOME_DIR = homeDir;

        const [{ configuration }, { readDaemonState }] = await Promise.all([
            import('./configuration'),
            import('./persistence'),
        ]);

        setTimeout(() => {
            writeFileSync(
                configuration.daemonStateFile,
                JSON.stringify(
                    {
                        pid: 123,
                        httpPort: 5173,
                        startedAt: Date.now(),
                        startedWithCliVersion: '0.0.0-test',
                        controlToken: 'token-123',
                    },
                    null,
                    2
                ),
                'utf-8'
            );
        }, 5);

        const state = await readDaemonState();
        expect(state?.pid).toBe(123);
    });

    it('falls back to any daemon state file under servers/ when the active server daemon state path is missing', async () => {
        const homeDir = mkdtempSync(join(tmpdir(), 'happier-cli-daemon-state-fallback-'));

        vi.resetModules();
        process.env.HAPPIER_HOME_DIR = homeDir;
        // Choose an active server id that does not have a daemon state file.
        process.env.HAPPIER_ACTIVE_SERVER_ID = 'localhost-53288';

        const [{ configuration }, { readDaemonState }] = await Promise.all([
            import('./configuration'),
            import('./persistence'),
        ]);

        // Write a daemon state file under a different server id to simulate stack-managed daemon ids.
        const fallbackPath = join(homeDir, 'servers', 'stack_test__id_default', 'daemon.state.json');
        mkdirSync(dirname(fallbackPath), { recursive: true });
        writeFileSync(
            fallbackPath,
            JSON.stringify(
                {
                    pid: 456,
                    httpPort: 5173,
                    startedAt: Date.now(),
                    startedWithCliVersion: '0.0.0-test',
                    controlToken: 'token-456',
                },
                null,
                2
            ),
            'utf-8'
        );

        // Sanity: active daemon state path should be different (and missing).
        expect(configuration.daemonStateFile).not.toBe(fallbackPath);

        const state = await readDaemonState();
        expect(state?.pid).toBe(456);
    });

    it('accepts legacy startTime fields and normalizes to startedAt', async () => {
        const homeDir = mkdtempSync(join(tmpdir(), 'happier-cli-daemon-state-legacy-'));

        vi.resetModules();
        process.env.HAPPIER_HOME_DIR = homeDir;

        const [{ configuration }, { readDaemonState }] = await Promise.all([
            import('./configuration'),
            import('./persistence'),
        ]);

        const legacyStarted = new Date().toISOString();
        writeFileSync(
            configuration.daemonStateFile,
            JSON.stringify(
                {
                    pid: 123,
                    httpPort: 5173,
                    startTime: legacyStarted,
                    startedWithCliVersion: '0.0.0-test',
                },
                null,
                2
            ),
            'utf-8'
        );

        const state = await readDaemonState();
        expect(state?.pid).toBe(123);
        expect(typeof state?.startedAt).toBe('number');
    });
});
