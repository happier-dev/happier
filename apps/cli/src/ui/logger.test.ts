import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createContext, runInContext } from 'node:vm';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDirSync, removeTempDirSync } from '@/testkit/fs/tempDir';

describe('logger', () => {
    const envKeys = ['DEBUG', 'HAPPIER_HOME_DIR', 'HAPPIER_LOG_LEVEL', 'HAPPIER_SESSION_LOG_KEEP_COUNT', 'HAPPIER_CRASHED_SESSION_LOG_KEEP_COUNT'] as const;
    let envScope = createEnvKeyScope(envKeys);
    let tempDir: string;
    let originalArgv: string[];

    beforeEach(() => {
        envScope = createEnvKeyScope(envKeys);
        tempDir = createTempDirSync('happier-cli-logger-test-');
        originalArgv = [...process.argv];
        envScope.patch({
            HAPPIER_HOME_DIR: tempDir,
            DEBUG: undefined,
            HAPPIER_LOG_LEVEL: undefined,
            HAPPIER_SESSION_LOG_KEEP_COUNT: undefined,
            HAPPIER_CRASHED_SESSION_LOG_KEEP_COUNT: undefined,
        });
        vi.resetModules();
    });

    afterEach(() => {
        removeTempDirSync(tempDir);
        envScope.restore();
        process.argv = originalArgv;
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

    it('keeps logger.debug enabled by default in daemon processes', async () => {
        process.argv = ['node', 'happier', 'daemon', 'start'];

        const { logger } = (await import('@/ui/logger')) as typeof import('@/ui/logger');

        logger.debug('[TEST] daemon debug default');
        logger.flushSync();

        expect(readFileSync(logger.getLogPath(), 'utf8')).toContain('[TEST] daemon debug default');
    });

    it('still writes info and warn entries to the log file when debug is disabled', async () => {
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        const { logger } = (await import('@/ui/logger')) as typeof import('@/ui/logger');

        try {
            logger.info('[TEST] info entry');
            logger.warn('[TEST] warn entry');
        } finally {
            logSpy.mockRestore();
        }
        logger.flushSync();

        const content = readFileSync(logger.getLogPath(), 'utf8');
        expect(content).toContain('[TEST] info entry');
        expect(content).toContain('[WARN] [TEST] warn entry');
    });

    it('writes file-only info diagnostics without polluting the interactive console', async () => {
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        const { logger } = (await import('@/ui/logger')) as typeof import('@/ui/logger');

        logger.infoFile('[TEST] file-only incident', { queueName: 'test-queue' });
        logger.flushSync();

        expect(logSpy).not.toHaveBeenCalled();
        expect(readFileSync(logger.getLogPath(), 'utf8')).toContain('[TEST] file-only incident');
        logSpy.mockRestore();
    });

    it('durably records sanitized fatal errors without serializing argv or env fields', async () => {
        const { logger } = (await import('@/ui/logger')) as typeof import('@/ui/logger');
        const error = Object.assign(
            new Error('provider startup rejected; Authorization: Bearer fatal-secret-token'),
            {
                argv: ['--token', 'argv-secret-value'],
                env: { OPENAI_API_KEY: 'env-secret-value' },
            },
        );

        expect(() => logger.fatal(error)).not.toThrow();

        const content = readFileSync(logger.getLogPath(), 'utf8');
        expect(content).toContain('[FATAL] Unhandled CLI error');
        expect(content).toContain('provider startup rejected');
        expect(content).toContain('[REDACTED]');
        expect(content).not.toContain('fatal-secret-token');
        expect(content).not.toContain('argv-secret-value');
        expect(content).not.toContain('env-secret-value');
        expect(content).not.toContain('OPENAI_API_KEY');
    });

    it('keeps fatal reporting best-effort when thrown values cannot be inspected', async () => {
        const { logger } = (await import('@/ui/logger')) as typeof import('@/ui/logger');
        const hostileError = {
            get stack(): string {
                throw new Error('stack getter failed');
            },
            get message(): string {
                throw new Error('message getter failed');
            },
            toString(): string {
                throw new Error('toString failed');
            },
        };

        expect(() => logger.fatal(hostileError)).not.toThrow();
        expect(readFileSync(logger.getLogPath(), 'utf8')).toContain('[FATAL] Unhandled CLI error');
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

    it('writes a NESTED Error with its message and code instead of "{}"', async () => {
        // The observed defect: every daemon failure logged as `{ pid, error }`
        // reached the log file as `{"pid":95632,"error":{}}`, because an Error
        // carries no enumerable own properties for `JSON.stringify` to find. The
        // top-level case was already handled; the carrying object — which is how
        // these are actually logged — was not, and root-causing a permanently
        // broken stop path cost a lane real time for exactly that reason.
        process.env.DEBUG = '1';

        const { logger } = (await import('@/ui/logger')) as typeof import('@/ui/logger');

        const error = Object.assign(new Error('directory not empty'), { code: 'ENOTEMPTY' });
        logger.debug('[TEST] nested error serialization', { pid: 95632, error });
        logger.debugLargeJson('[TEST] nested error in large json', { pid: 95632, error });
        logger.flushSync();

        const content = readFileSync(logger.getLogPath(), 'utf8');
        expect(content).not.toContain('"error":{}');
        for (const marker of ['[TEST] nested error serialization', '[TEST] nested error in large json']) {
            const line = content.split(marker)[1] ?? '';
            expect(line).toContain('directory not empty');
            expect(line).toContain('ENOTEMPTY');
            expect(line).toContain('95632');
        }
    });

    it('does not throw when a nested error causes a cycle', async () => {
        process.env.DEBUG = '1';

        const { logger } = (await import('@/ui/logger')) as typeof import('@/ui/logger');

        const error: Error & { cause?: unknown } = new Error('looping');
        error.cause = error;

        expect(() => {
            logger.debug('[TEST] nested cyclic error', { pid: 1, error });
        }).not.toThrow();
        logger.flushSync();

        const content = readFileSync(logger.getLogPath(), 'utf8');
        expect(content).toContain('[TEST] nested cyclic error');
        expect(content).toContain('looping');
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
        process.argv = ['node', 'happier', 'daemon', 'start'];
        const logsDir = join(tempDir, 'logs');
        mkdirSync(logsDir, { recursive: true });
        for (let index = 0; index < 52; index += 1) {
            writeFileSync(
                join(logsDir, `2026-06-30-10-${String(index).padStart(2, '0')}-00-pid-${index}-daemon.log`),
                `old ${index}\n`,
                'utf8',
            );
        }

        const { logger } = (await import('@/ui/logger')) as typeof import('@/ui/logger');
        logger.debug('[TEST] current daemon log');
        logger.flushSync();

        await vi.waitFor(() => {
            const daemonLogs = readdirSync(logsDir).filter(file => file.endsWith('-daemon.log'));
            expect(daemonLogs).toHaveLength(50);
            expect(daemonLogs).toContain(logger.getLogPath().split('/').pop());
        });
    });

    it('prunes session logs best-effort when constructing a session logger, leaving daemon logs alone', async () => {
        process.env.HAPPIER_SESSION_LOG_KEEP_COUNT = '3';
        const logsDir = join(tempDir, 'logs');
        mkdirSync(logsDir, { recursive: true });
        for (let index = 0; index < 6; index += 1) {
            writeFileSync(
                join(logsDir, `2026-06-30-10-${String(index).padStart(2, '0')}-00-pid-${910_000 + index}.log`),
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
                join(logsDir, `2026-06-30-10-${String(index).padStart(2, '0')}-00-pid-${920_000 + index}.log`),
                `old session ${index}\n`,
                'utf8',
            );
        }
        writeFileSync(
            join(sessionExitDir, 'z-session-crashed-old-pid-3.json'),
            JSON.stringify({ sessionId: 'crashed-old', pid: 920_003, observedAt: 10, reason: 'process-exited', code: 1 }),
            'utf8',
        );
        writeFileSync(
            join(sessionExitDir, 'a-session-crashed-new-pid-2.json'),
            JSON.stringify({ sessionId: 'crashed-new', pid: 920_002, observedAt: 20, reason: 'process-exited', code: 1 }),
            'utf8',
        );
        writeFileSync(
            join(sessionExitDir, 'session-clean-pid-1.json'),
            JSON.stringify({ sessionId: 'clean', pid: 920_001, reason: 'process-exited', code: 0 }),
            'utf8',
        );

        await import('@/ui/logger');

        await vi.waitFor(() => {
            const sessionLogs = readdirSync(logsDir)
                .filter(file => file.endsWith('.log') && !file.endsWith('-daemon.log'))
                .sort();
            expect(sessionLogs).toHaveLength(4);
            expect(sessionLogs).toContain('2026-06-30-10-02-00-pid-920002.log');
            expect(sessionLogs).not.toContain('2026-06-30-10-03-00-pid-920003.log');
            expect(sessionLogs).not.toContain('2026-06-30-10-01-00-pid-920001.log');
        });
    });

    it('retains a live runner log outside the normal session log budget', async () => {
        process.env.HAPPIER_SESSION_LOG_KEEP_COUNT = '3';
        const logsDir = join(tempDir, 'logs');
        mkdirSync(logsDir, { recursive: true });
        const liveRunnerLog = `2020-01-01-00-00-00-pid-${process.pid}.log`;
        writeFileSync(join(logsDir, liveRunnerLog), 'live runner history\n', 'utf8');
        for (let index = 1; index <= 7; index += 1) {
            writeFileSync(
                join(logsDir, `2026-06-30-10-${String(index).padStart(2, '0')}-00-pid-${900_000 + index}.log`),
                `inactive session ${index}\n`,
                'utf8',
            );
        }

        await import('@/ui/logger');

        await vi.waitFor(() => {
            const sessionLogs = readdirSync(logsDir)
                .filter(file => file.endsWith('.log') && !file.endsWith('-daemon.log'))
                .sort();
            expect(sessionLogs).toHaveLength(4);
            expect(sessionLogs).toContain(liveRunnerLog);
        });
    });

    it('registers process flush hooks only once across repeated logger module reloads', async () => {
        await import('@/ui/logger');
        const exitListenersAfterFirstImport = process.listenerCount('exit');
        const uncaughtListenersAfterFirstImport = process.listenerCount('uncaughtExceptionMonitor');

        vi.resetModules();
        await import('@/ui/logger');
        vi.resetModules();
        await import('@/ui/logger');

        expect(process.listenerCount('exit')).toBe(exitListenersAfterFirstImport);
        expect(process.listenerCount('uncaughtExceptionMonitor')).toBe(uncaughtListenersAfterFirstImport);
    });
});
