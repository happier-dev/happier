import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createContext, runInContext } from 'node:vm';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDirSync, removeTempDirSync } from '@/testkit/fs/tempDir';

describe('logger.debugLargeJson', () => {
    const envKeys = ['DEBUG', 'HAPPIER_HOME_DIR', 'HAPPIER_LOG_LEVEL', 'HAPPIER_DAEMON_LOG_KEEP_COUNT', 'HAPPIER_SESSION_LOG_KEEP_COUNT', 'HAPPIER_CRASHED_SESSION_LOG_KEEP_COUNT'] as const;
    let envScope = createEnvKeyScope(envKeys);
    let tempDir: string;

    beforeEach(() => {
        envScope = createEnvKeyScope(envKeys);
        tempDir = createTempDirSync('happier-cli-logger-test-');
        envScope.patch({
            HAPPIER_HOME_DIR: tempDir,
            DEBUG: undefined,
            HAPPIER_LOG_LEVEL: undefined,
            HAPPIER_DAEMON_LOG_KEEP_COUNT: undefined,
            HAPPIER_SESSION_LOG_KEEP_COUNT: undefined,
            HAPPIER_CRASHED_SESSION_LOG_KEEP_COUNT: undefined,
        });
        vi.resetModules();
    });

    afterEach(() => {
        removeTempDirSync(tempDir);
        envScope.restore();
    });

    it('does not write to log file when DEBUG is not set', async () => {
        const { logger } = (await import('@/ui/logger')) as typeof import('@/ui/logger');

        logger.debugLargeJson('[TEST] debugLargeJson', { secret: 'value' });
        logger.flushSync();

        expect(existsSync(logger.getLogPath())).toBe(false);
    });

    it('writes to log file when DEBUG is set', async () => {
        process.env.DEBUG = '1';

        const { logger } = (await import('@/ui/logger')) as typeof import('@/ui/logger');

        logger.debugLargeJson('[TEST] debugLargeJson', { secret: 'value' });
        logger.flushSync();

        expect(existsSync(logger.getLogPath())).toBe(true);
        const content = readFileSync(logger.getLogPath(), 'utf8');
        expect(content).toContain('[TEST] debugLargeJson');
    });

    it('gates logger.debug off by default in session processes', async () => {
        const { logger } = (await import('@/ui/logger')) as typeof import('@/ui/logger');

        logger.debug('[TEST] should not be written', { payload: 'value' });
        logger.flushSync();

        expect(existsSync(logger.getLogPath())).toBe(false);
    });

    it('enables logger.debug via HAPPIER_LOG_LEVEL=debug', async () => {
        process.env.HAPPIER_LOG_LEVEL = 'debug';

        const { logger } = (await import('@/ui/logger')) as typeof import('@/ui/logger');

        logger.debug('[TEST] level override', { payload: 'value' });
        logger.flushSync();

        expect(existsSync(logger.getLogPath())).toBe(true);
        expect(readFileSync(logger.getLogPath(), 'utf8')).toContain('[TEST] level override');
    });

    it('writes Error objects with message/stack instead of "{}" when DEBUG is set', async () => {
        process.env.DEBUG = '1';

        const { logger } = (await import('@/ui/logger')) as typeof import('@/ui/logger');

        logger.debug('[TEST] error serialization', new Error('boom'));
        logger.flushSync();

        expect(existsSync(logger.getLogPath())).toBe(true);
        const content = readFileSync(logger.getLogPath(), 'utf8');
        expect(content).toContain('[TEST] error serialization');
        expect(content).toContain('boom');
    });

    it('does not throw when debugLargeJson receives circular objects', async () => {
        process.env.DEBUG = '1';

        const { logger } = (await import('@/ui/logger')) as typeof import('@/ui/logger');

        const obj: { a: number; self?: unknown } = { a: 1 };
        obj.self = obj;

        expect(() => {
            logger.debugLargeJson('[TEST] circular json', obj);
        }).not.toThrow();
        logger.flushSync();

        expect(existsSync(logger.getLogPath())).toBe(true);
        const content = readFileSync(logger.getLogPath(), 'utf8');
        expect(content).toContain('[TEST] circular json');
    });

    it('does not throw when logging a cross-realm Error with circular refs', async () => {
        process.env.DEBUG = '1';

        const { logger } = (await import('@/ui/logger')) as typeof import('@/ui/logger');

        const ctx = createContext({});
        const err = runInContext(
            "(() => { const e = new Error('boom'); e.error = e; return e; })()",
            ctx,
        );

        expect(err instanceof Error).toBe(false);

        expect(() => {
            logger.debug('[TEST] cross-realm error', err);
        }).not.toThrow();
        logger.flushSync();

        expect(existsSync(logger.getLogPath())).toBe(true);
        const content = readFileSync(logger.getLogPath(), 'utf8');
        expect(content).toContain('[TEST] cross-realm error');
        expect(content).toContain('boom');
    });

    it('creates logs dir on demand when writing the first debug entry', async () => {
        process.env.DEBUG = '1';

        const { logger } = (await import('@/ui/logger')) as typeof import('@/ui/logger');
        const logsDir = dirname(logger.getLogPath());
        rmSync(logsDir, { recursive: true, force: true });

        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            logger.debugLargeJson('[TEST] create logs dir', { secret: 'value' });
            logger.flushSync();
        } finally {
            errorSpy.mockRestore();
        }

        expect(existsSync(logsDir)).toBe(true);
        expect(existsSync(logger.getLogPath())).toBe(true);
        const content = readFileSync(logger.getLogPath(), 'utf8');
        expect(content).toContain('[TEST] create logs dir');
    });

    it('does not throw if log file cannot be written (even when DEBUG is set)', async () => {
        process.env.DEBUG = '1';

        const { logger } = (await import('@/ui/logger')) as typeof import('@/ui/logger');
        // Deterministic cross-platform write failure: path points to a directory, not a file.
        mkdirSync(logger.getLogPath(), { recursive: true });
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        try {
            expect(() => {
                logger.debugLargeJson('[TEST] debugLargeJson write should not throw', { secret: 'value' });
                logger.flushSync();
            }).not.toThrow();
        } finally {
            errorSpy.mockRestore();
        }
    });

    it('does not throw when console logging hits EPIPE', async () => {
        const { logger } = (await import('@/ui/logger')) as typeof import('@/ui/logger');
        const epipeError = Object.assign(new Error('broken pipe'), { code: 'EPIPE' });
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {
            throw epipeError;
        });

        try {
            expect(() => {
                logger.warn('[TEST] warn survives broken stdout');
            }).not.toThrow();
        } finally {
            consoleSpy.mockRestore();
        }
    });

    it('prunes daemon logs best-effort when constructing a daemon logger', async () => {
        const previousArgv = process.argv;
        process.argv = ['node', 'happier', 'daemon', 'start'];
        process.env.HAPPIER_DAEMON_LOG_KEEP_COUNT = '3';
        const logsDir = join(tempDir, 'logs');
        mkdirSync(logsDir, { recursive: true });
        for (let index = 0; index < 6; index += 1) {
            writeFileSync(
                join(logsDir, `2026-06-30-10-${String(index).padStart(2, '0')}-00-pid-${index}-daemon.log`),
                `old ${index}\n`,
                'utf8',
            );
        }

        try {
            const { logger } = (await import('@/ui/logger')) as typeof import('@/ui/logger');
            logger.debug('[TEST] current daemon log');
            logger.flushSync();

            await vi.waitFor(() => {
                const daemonLogs = readdirSync(logsDir).filter(file => file.endsWith('-daemon.log'));
                expect(daemonLogs).toHaveLength(3);
                expect(daemonLogs).toContain(logger.getLogPath().split('/').pop());
            });
        } finally {
            process.argv = previousArgv;
        }
    });

    it('prunes session logs best-effort when constructing a session logger, leaving daemon logs alone', async () => {
        process.env.HAPPIER_SESSION_LOG_KEEP_COUNT = '3';
        const logsDir = join(tempDir, 'logs');
        mkdirSync(logsDir, { recursive: true });
        for (let index = 0; index < 6; index += 1) {
            writeFileSync(
                join(logsDir, `2026-06-30-10-${String(index).padStart(2, '0')}-00-pid-${index}.log`),
                `old session ${index}\n`,
                'utf8',
            );
        }
        writeFileSync(join(logsDir, '2026-06-30-09-00-00-pid-99-daemon.log'), 'daemon\n', 'utf8');

        await import('@/ui/logger');

        await vi.waitFor(() => {
            const entries = readdirSync(logsDir);
            const sessionLogs = entries.filter(file => file.endsWith('.log') && !file.endsWith('-daemon.log'));
            expect(sessionLogs).toHaveLength(3);
            expect(entries).toContain('2026-06-30-09-00-00-pid-99-daemon.log');
        });
    });

    it('retains bounded non-zero crashed runner session logs outside the normal session log budget', async () => {
        process.env.HAPPIER_SESSION_LOG_KEEP_COUNT = '3';
        process.env.HAPPIER_CRASHED_SESSION_LOG_KEEP_COUNT = '1';
        const logsDir = join(tempDir, 'logs');
        const sessionExitDir = join(logsDir, 'session-exit');
        mkdirSync(sessionExitDir, { recursive: true });
        for (let index = 1; index <= 7; index += 1) {
            writeFileSync(
                join(logsDir, `2026-06-30-10-${String(index).padStart(2, '0')}-00-pid-${index}.log`),
                `old session ${index}\n`,
                'utf8',
            );
        }
        writeFileSync(
            join(sessionExitDir, 'z-session-crashed-old-pid-3.json'),
            JSON.stringify({ sessionId: 'crashed-old', pid: 3, observedAt: 10, reason: 'process-exited', code: 1 }),
            'utf8',
        );
        writeFileSync(
            join(sessionExitDir, 'a-session-crashed-new-pid-2.json'),
            JSON.stringify({ sessionId: 'crashed-new', pid: 2, observedAt: 20, reason: 'process-exited', code: 1 }),
            'utf8',
        );
        writeFileSync(
            join(sessionExitDir, 'session-clean-pid-1.json'),
            JSON.stringify({ sessionId: 'clean', pid: 1, reason: 'process-exited', code: 0 }),
            'utf8',
        );

        await import('@/ui/logger');

        await vi.waitFor(() => {
            const sessionLogs = readdirSync(logsDir)
                .filter(file => file.endsWith('.log') && !file.endsWith('-daemon.log'))
                .sort();
            expect(sessionLogs).toHaveLength(4);
            expect(sessionLogs).toContain('2026-06-30-10-02-00-pid-2.log');
            expect(sessionLogs).not.toContain('2026-06-30-10-03-00-pid-3.log');
            expect(sessionLogs).not.toContain('2026-06-30-10-01-00-pid-1.log');
        });
    });
});
