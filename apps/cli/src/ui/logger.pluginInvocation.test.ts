import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { Logger } from './logger';

const paths: string[] = [];
const originalDebug = process.env.DEBUG;

afterEach(async () => {
    vi.restoreAllMocks();
    if (originalDebug === undefined) delete process.env.DEBUG;
    else process.env.DEBUG = originalDebug;
    await Promise.all(paths.splice(0).map(async (path) => await rm(path, { force: true })));
});

describe('plugin invocation structured file sink', () => {
    it('appends one structured record without writing to stdout or stderr', async () => {
        const path = join(tmpdir(), `happier-plugin-log-${process.pid}-${Date.now()}.log`);
        paths.push(path);
        const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
        const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        const logger = new Logger(path);

        logger.appendPluginInvocationLogRecord(Object.freeze({
            version: 1,
            kind: 'plugin_invocation_log',
            level: 'error',
            message: 'structured',
        }));
        logger.flushSync();

        const lines = (await readFile(path, 'utf8')).trim().split('\n');
        expect(lines).toHaveLength(1);
        expect(JSON.parse(lines[0]!)).toMatchObject({ level: 'error', message: 'structured' });
        expect(stdout).not.toHaveBeenCalled();
        expect(stderr).not.toHaveBeenCalled();
    });

    it('isolates a file write failure without using stderr even in debug mode', () => {
        process.env.DEBUG = '1';
        const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        const logger = new Logger('/dev/null/plugin-invocation.log');

        expect(() => {
            logger.appendPluginInvocationLogRecord(Object.freeze({
                version: 1,
                kind: 'plugin_invocation_log',
                level: 'error',
            }));
            logger.flushSync();
        }).not.toThrow();
        expect(stderr).not.toHaveBeenCalled();
        expect(consoleError).not.toHaveBeenCalled();
    });
});
