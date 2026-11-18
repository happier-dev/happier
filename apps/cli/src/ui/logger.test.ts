import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { Console } from 'node:console';
import { AxiosError, AxiosHeaders } from 'axios';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDirSync, removeTempDirSync } from '@/testkit/fs/tempDir';

describe('logger.debugLargeJson', () => {
    const envKeys = ['DEBUG', 'HAPPIER_HOME_DIR', 'HAPPIER_LOG_LEVEL', 'HAPPIER_WEB_LATENCY_TRACE', 'HAPPIER_DAEMON_LOG_KEEP_COUNT', 'HAPPIER_SESSION_LOG_KEEP_COUNT', 'HAPPIER_CRASHED_SESSION_LOG_KEEP_COUNT', 'DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING', 'HAPPIER_SERVER_URL', 'TZ'] as const;
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
            DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING: undefined,
            HAPPIER_SERVER_URL: undefined,
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

    it.each(['warn', 'debug'])('keeps routine Action and RPC tracing below warnings at file level %s', async level => {
        envScope.patch({ HAPPIER_LOG_LEVEL: level, HAPPIER_WEB_LATENCY_TRACE: '1' });
        const { logger } = await import('@/ui/logger');
        const { runTracedExternalActionStage, runTracedExternalActionInnerStage, refuseExternalActionPhase } = await import('@/daemon/externalActions/externalActionPhase');
        const { withWebLatencyTrace, timeWebLatencyPhase } = await import('@/daemon/externalActions/webLatencyTrace');
        const requestId = '70cc64d3-0386-4914-b7d8-713b7879e99f';
        const value = await withWebLatencyTrace(requestId, () => runTracedExternalActionStage('action.invoke', requestId, 'target_resolution', () =>
            runTracedExternalActionInnerStage('collection.encryption.currentness', () => timeWebLatencyPhase('machine.rpc', () => 42))));
        expect(value).toBe(42);
        refuseExternalActionPhase('requester_prepare', 'machine', undefined, { refusalBranch: 'custody' });
        logger.flushSync();
        const content = readFileSync(logger.getLogPath(), 'utf8');
        expect(content).toContain('[WARN] [external-action-phase]');
        if (level === 'warn') {
            expect(content).not.toContain('[external-action-stage]');
            expect(content).not.toContain('[web-latency]');
        } else {
            expect(content).toContain('[external-action-stage]');
            expect(content).toContain('[web-latency]');
            expect(content).not.toContain('[WARN] [external-action-stage]');
            expect(content).not.toContain('[WARN] [web-latency]');
        }
    });

    it('keeps local debug diagnostics redacted and out of opt-in remote logging', async () => {
        envScope.patch({ HAPPIER_LOG_LEVEL: 'debug', DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING: '1',
            HAPPIER_SERVER_URL: 'https://debug-logs.example.test' });
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        try {
            const { logger } = await import('@/ui/logger');
            logger.debugLocalFile('[TEST] local debug', 'Authorization: Bearer private-fixture-token');
            logger.flushSync();
            const content = readFileSync(logger.getLogPath(), 'utf8');
            expect(content).toContain('[TEST] local debug');
            expect(content).not.toContain('private-fixture-token');
            expect(fetchSpy).not.toHaveBeenCalled();
        } finally {
            fetchSpy.mockRestore();
            consoleSpy.mockRestore();
        }
    });

    it.each([undefined, '1'])('keeps shared logger diagnostics scoped to interleaved Sessions (host DEBUG %s)', async hostDebug => {
        envScope.patch({ DEBUG: hostDebug, HAPPIER_LOG_LEVEL: 'silent' });
        const { Logger } = await import('@/ui/logger');
        const { runAddedHostedSession } = await import('@/agent/runtime/lifecycle/hostedSessionScope');
        const logPath = join(tempDir, 'shared-session.log');
        const sharedLogger = new Logger({ logFilePath: logPath, pruneCurrentProcessLogs: false });
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        try {
            await Promise.all([true, false].map(debugEnabled => runAddedHostedSession({
                environment: { NODE_ENV: 'test', DEBUG: debugEnabled ? '1' : undefined }, workingDirectory: tempDir, end: () => {},
            }, async () => {
                await Promise.resolve();
                const label = debugEnabled ? 'debug-session' : 'quiet-session';
                sharedLogger.debug(`${label} debug`);
                sharedLogger.debugLargeJson(`${label} json`, { value: label });
                sharedLogger.infoDeveloper(`${label} developer`);
                sharedLogger.infoFile(`${label} info`);
            })));
            sharedLogger.debug('host debug');
            sharedLogger.flushSync();
            expect(existsSync(logPath)).toBe(true);
            const content = readFileSync(logPath, 'utf8');
            expect(content).toContain('debug-session debug');
            expect(content).toContain('debug-session json');
            expect(content).toContain('debug-session developer');
            expect(content).toContain('debug-session info');
            expect(content).toContain('quiet-session info');
            expect(content).not.toContain('quiet-session debug');
            expect(content).not.toContain('quiet-session json');
            expect(content).not.toContain('quiet-session developer');
            expect(content).not.toContain('host debug');
            expect(consoleSpy.mock.calls.flat().join(' ')).toContain('debug-session developer');
            expect(consoleSpy.mock.calls.flat().join(' ')).not.toContain('quiet-session developer');
        } finally { consoleSpy.mockRestore(); }
    });

    it('routes opt-in remote diagnostics by Session and preserves an explicitly local-only sink', async () => {
        envScope.patch({ DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING: '1', HAPPIER_SERVER_URL: 'https://host-logs.example.test' });
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        const { Logger } = await import('@/ui/logger');
        const { runAddedHostedSession } = await import('@/agent/runtime/lifecycle/hostedSessionScope');
        const sharedLogger = new Logger({ logFilePath: join(tempDir, 'remote-sessions.log'), pruneCurrentProcessLogs: false });
        const localOnlyLogger = new Logger({ logFilePath: join(tempDir, 'local-sessions.log'), pruneCurrentProcessLogs: false,
            allowDangerousRemoteLogging: false, redactFileOutput: true });
        try {
            await Promise.all(['first', 'second', 'quiet'].map(id => runAddedHostedSession({
                environment: { NODE_ENV: 'test', ...(id === 'quiet' ? {} : { DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING: '1' }),
                    HAPPIER_SERVER_URL: `https://${id}-logs.example.test` }, workingDirectory: tempDir, end: () => {},
            }, async () => {
                await Promise.resolve();
                sharedLogger.infoFile(`${id} remote`);
                localOnlyLogger.infoFile(`${id} local Authorization: Bearer private-fixture-token`);
            })));
            sharedLogger.infoFile('host remote');
            sharedLogger.flushSync(); localOnlyLogger.flushSync();
            expect(fetchSpy.mock.calls.map(call => String(call[0]))).toEqual([
                'https://first-logs.example.test/logs-combined-from-cli-and-mobile-for-simple-ai-debugging',
                'https://second-logs.example.test/logs-combined-from-cli-and-mobile-for-simple-ai-debugging',
                'https://host-logs.example.test/logs-combined-from-cli-and-mobile-for-simple-ai-debugging',
            ]);
            expect(readFileSync(localOnlyLogger.logFilePath, 'utf8')).not.toContain('private-fixture-token');
        } finally { consoleSpy.mockRestore(); fetchSpy.mockRestore(); }
    });

    it.each([undefined, '1'])('retains Session DEBUG for file failures flushed after the Session ends (host DEBUG %s)', async hostDebug => {
        envScope.patch({ DEBUG: hostDebug });
        const { Logger } = await import('@/ui/logger');
        const { runAddedHostedSession } = await import('@/agent/runtime/lifecycle/hostedSessionScope');
        const blockedParent = join(tempDir, 'blocked-parent');
        writeFileSync(blockedParent, 'not a directory');
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        try {
            for (const debugEnabled of [false, true]) {
                const sharedLogger = new Logger({ logFilePath: join(blockedParent, `${debugEnabled}.log`), pruneCurrentProcessLogs: false });
                runAddedHostedSession({ environment: { NODE_ENV: 'test', DEBUG: debugEnabled ? '1' : undefined }, workingDirectory: tempDir,
                    end: () => {} }, () => sharedLogger.infoFile('deferred write failure'));
                consoleSpy.mockClear();
                sharedLogger.flushSync();
                expect(consoleSpy.mock.calls.length > 0).toBe(debugEnabled);
            }
        } finally { consoleSpy.mockRestore(); }
    });

    it.each(['UTC', 'Europe/Amsterdam', 'America/New_York'])('preserves local millisecond timestamps in %s across midnight and daylight saving', async timeZone => {
        process.env.TZ = timeZone;
        const { logger } = await import('@/ui/logger');
        vi.useFakeTimers({ toFake: ['Date'] });
        try {
            for (const instant of ['2026-01-01T00:00:00.007Z', '2026-03-29T00:59:59.999Z', '2026-03-29T01:00:00.000Z', '2026-11-01T06:00:00.123Z']) {
                const date = new Date(instant);
                vi.setSystemTime(date);
                logger.infoFile('timestamp-format');
                logger.flushSync();
                const expected = date.toLocaleTimeString('en-US', { timeZone, hour12: false,
                    hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 });
                expect(readFileSync(logger.getLogPath(), 'utf8')).toContain(`[${expected}] timestamp-format`);
            }
        } finally { vi.useRealTimers(); }
    });

    it('follows an explicit timezone change in a running process', async () => {
        process.env.TZ = 'UTC';
        const { logger } = await import('@/ui/logger');
        vi.useFakeTimers({ toFake: ['Date'] });
        try {
            const date = new Date('2026-01-01T00:00:00.007Z');
            vi.setSystemTime(date);
            for (const timeZone of ['UTC', 'America/New_York', 'Europe/Amsterdam']) {
                process.env.TZ = timeZone;
                logger.infoFile('timezone-change');
                logger.flushSync();
                const expected = date.toLocaleTimeString('en-US', { timeZone, hour12: false,
                    hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 });
                expect(readFileSync(logger.getLogPath(), 'utf8')).toContain(`[${expected}] timezone-change`);
            }
        } finally { vi.useRealTimers(); }
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

    it.each([
        { label: 'HTTP provider', error: Object.assign(new Error('request failed'), { status: 429 }),
            cause: { phase: 'cli.log', errorClass: 'Error', errorCode: null, httpStatus: 429 } },
        { label: 'Action refusal', error: Object.assign(new Error('refused'), { failureCause: {
            phase: 'execution_authorization', errorClass: 'TypeError', errorCode: 'ECONNRESET', httpStatus: 503 } }),
            cause: { phase: 'execution_authorization', errorClass: 'TypeError', errorCode: 'ECONNRESET', httpStatus: 503 } },
        { label: 'native session', error: Object.assign(new Error('turn failed'), { details: { failureCause: {
            phase: 'turn', failureReason: 'rate_limit', providerErrorCode: 'rate_limit_exceeded', httpStatus: 429 } } }),
            cause: { phase: 'turn', failureReason: 'rate_limit', providerErrorCode: 'rate_limit_exceeded', httpStatus: 429 } },
    ])('retains typed $label causes in top-level, nested and large JSON file logs', async ({ error, cause }) => {
        process.env.DEBUG = '1';
        const { logger } = await import('@/ui/logger');
        logger.debug('typed-top', error);
        logger.debug('typed-nested', { error });
        logger.debugLargeJson('typed-large', { error });
        logger.flushSync();
        const content = readFileSync(logger.getLogPath(), 'utf8');
        for (const marker of ['typed-top', 'typed-nested', 'typed-large']) {
            const section = content.split(marker)[1]?.split(/\n\[/)[0] ?? '';
            expect(JSON.parse(section.trim())).toMatchObject(marker === 'typed-top'
                ? { failureCause: cause } : { error: { failureCause: cause } });
        }
    });

    it('logs a nested HTTP failure without visiting its request configuration graph', async () => {
        process.env.DEBUG = '1';
        const { logger } = await import('@/ui/logger');

        let requestGraphVisits = 0;
        let graph: object = {
            get diagnosticLeaf() {
                ++requestGraphVisits;
                return 'private request state';
            },
        };
        for (let depth = 0; depth < 8; depth++) {
            graph = { left: graph, right: graph };
        }
        // The same subgraph can be reachable through several branches of a live HTTP agent.
        const requestConfig = { headers: new AxiosHeaders(), httpsAgent: graph };
        const error = new AxiosError('startup request refused', 'ERR_BAD_REQUEST', requestConfig);
        logger.debug('failed startup', { errors: [error] });
        logger.flushSync();

        expect(requestGraphVisits).toBe(0);
        const log = readFileSync(logger.getLogPath(), 'utf8');
        expect(log).toContain('startup request refused');
        expect(log).toContain('ERR_BAD_REQUEST');
        expect(log).not.toContain('private request state');
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

    it('writes file-only info diagnostics without touching the interactive console', async () => {
        const { Logger } = (await import('@/ui/logger')) as typeof import('@/ui/logger');
        const logPath = join(tempDir, 'logs', 'file-only-info.log');
        const isolatedLogger = new Logger(logPath);
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

        isolatedLogger.infoFile('[TEST] slow queue', { queueName: 'test-queue' });
        isolatedLogger.flushSync();

        expect(readFileSync(logPath, 'utf8')).toContain('[TEST] slow queue');
        expect(consoleSpy).not.toHaveBeenCalled();
        consoleSpy.mockRestore();
    });

    it('supports one scoped redacted local-only process logger and restores the prior logger', async () => {
        process.env.DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING = '1';
        process.env.HAPPIER_SERVER_URL = 'https://logs.example.test';
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
        const loggerModule = (await import('@/ui/logger')) as typeof import('@/ui/logger');
        const priorLogger = loggerModule.logger;
        const logPath = join(tempDir, 'runner', 'logs', 'runner.log');
        const scopedLogger = new loggerModule.Logger({
            logFilePath: logPath,
            redactFileOutput: true,
            allowDangerousRemoteLogging: false,
            pruneCurrentProcessLogs: false,
        });

        const restore = loggerModule.bindProcessLogger(scopedLogger);
        loggerModule.logger.infoFile(
            '[RUNNER] startup failure',
            'Authorization: Bearer runner-secret-token',
        );
        restore();

        expect(readFileSync(logPath, 'utf8')).toContain('[RUNNER] startup failure');
        expect(readFileSync(logPath, 'utf8')).toContain('[REDACTED]');
        expect(readFileSync(logPath, 'utf8')).not.toContain('runner-secret-token');
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(loggerModule.logger).toBe(priorLogger);
        fetchSpy.mockRestore();
    });

    it('keeps local file warnings actionable at warn level without forwarding them to console or remote logging', async () => {
        process.env.HAPPIER_LOG_LEVEL = 'warn';
        process.env.DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING = '1';
        process.env.HAPPIER_SERVER_URL = 'https://logs.example.test';
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
        const { Logger } = await import('@/ui/logger');
        const logPath = join(tempDir, 'logs', 'local-warning.log');
        const isolatedLogger = new Logger({ logFilePath: logPath, pruneCurrentProcessLogs: false });
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        const missingPath = join(tempDir, 'node_modules', 'missing-package');
        try {
            isolatedLogger.warnLocalFile('plugin_dev_dependency_preparation_failed', {
                error: Object.assign(new Error(`ENOENT, lstat '${missingPath}'; Authorization: Bearer local-warning-secret-token`), { code: 'ENOENT' }),
            });
            isolatedLogger.flushSync();
            const content = readFileSync(logPath, 'utf8');
            expect(content).toContain('[WARN]');
            expect(content).toContain('plugin_dev_dependency_preparation_failed');
            expect(content).toContain(missingPath);
            expect(content).toContain('[REDACTED]');
            expect(content).not.toContain('local-warning-secret-token');
            expect(consoleSpy).not.toHaveBeenCalled();
            expect(fetchSpy).not.toHaveBeenCalled();
        } finally {
            consoleSpy.mockRestore();
            fetchSpy.mockRestore();
        }
    });

    it.each(['ordinary', 'axios'] as const)('writes sanitized %s error diagnostics to stderr even when file logging is silent', async kind => {
        envScope.patch({ HAPPIER_LOG_LEVEL: 'silent' });
        const { Logger } = await import('@/ui/logger');
        const { serializeAxiosErrorForLog } = await import('@/api/client/serializeAxiosErrorForLog');
        const { AxiosError } = await import('axios');
        const { captureStderr } = await import('@/testkit/logger/captureOutput');
        const output = captureStderr();
        // Vitest replaces console.error; retain Node's real stderr binding.
        const errorConsole = vi.spyOn(console, 'error').mockImplementation(new Console(process.stdout, process.stderr).error);
        try {
            const isolatedLogger = new Logger({ logFilePath: join(tempDir, 'logs', 'startup.log'), pruneCurrentProcessLogs: false });
            // Exercise the real serializer -> stderr path used by fatal startup.
            const message = 'native initialization failed password=PRIVATE_PASSWORD api_key=PRIVATE_API_KEY {"client_secret":"PRIVATE_QUOTED_SECRET"}';
            const code = 'ERR_NATIVE token=PRIVATE_CODE_SECRET';
            const error = kind === 'axios' ? new AxiosError(message, code) : Object.assign(new Error(message), { code });
            error.stack = 'Error: native initialization failed\n    at bootstrap secret=PRIVATE_STACK_SECRET';
            isolatedLogger.error('Daemon startup failed', serializeAxiosErrorForLog(error));
            expect(output.text()).toContain('native initialization failed');
            expect(output.text()).toContain('ERR_NATIVE');
            if (kind === 'ordinary') expect(output.text()).toContain('at bootstrap');
            for (const secret of ['PRIVATE_PASSWORD', 'PRIVATE_API_KEY', 'PRIVATE_QUOTED_SECRET', 'PRIVATE_CODE_SECRET', 'PRIVATE_STACK_SECRET']) {
                expect(output.text()).not.toContain(secret);
            }
            isolatedLogger.flushSync();
            expect(existsSync(isolatedLogger.logFilePath)).toBe(false);
        } finally { errorConsole.mockRestore(); output.restore(); }
    });

    it('durably records sanitized fatal errors without serializing argv or env fields', async () => {
        const { Logger } = (await import('@/ui/logger')) as typeof import('@/ui/logger');
        const logPath = join(tempDir, 'logs', 'fatal.log');
        const isolatedLogger = new Logger(logPath);
        const error = Object.assign(
            new Error('provider startup rejected; Authorization: Bearer fatal-secret-token'),
            {
                argv: ['--token', 'argv-secret-value'],
                env: { OPENAI_API_KEY: 'env-secret-value' },
            },
        );

        expect(() => isolatedLogger.fatal(error)).not.toThrow();

        const content = readFileSync(logPath, 'utf8');
        expect(content).toContain('[FATAL] Unhandled CLI error');
        expect(content).toContain('provider startup rejected');
        expect(content).toContain('[REDACTED]');
        expect(content).not.toContain('fatal-secret-token');
        expect(content).not.toContain('argv-secret-value');
        expect(content).not.toContain('env-secret-value');
        expect(content).not.toContain('OPENAI_API_KEY');
    });

    it('keeps fatal reporting best-effort when thrown values cannot be inspected', async () => {
        const { Logger } = (await import('@/ui/logger')) as typeof import('@/ui/logger');
        const logPath = join(tempDir, 'logs', 'hostile-fatal.log');
        const isolatedLogger = new Logger(logPath);
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

        expect(() => isolatedLogger.fatal(hostileError)).not.toThrow();
        expect(readFileSync(logPath, 'utf8')).toContain('[FATAL] Unhandled CLI error');
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
});
