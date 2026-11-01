import { appendFile, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { Logger } from './logger';

const paths: string[] = [];
const originalDebug = process.env.DEBUG;

function pluginInvocationRecord(message: string, sequence = 1): Readonly<Record<string, unknown>> {
    return Object.freeze({
        version: 1,
        kind: 'plugin_invocation_log',
        level: 'info',
        message,
        context: {
            plugin: { id: 'acme.example', version: '1.0.0' },
            contribution: { id: 'run', qualifiedId: 'acme.example/run' },
            occurrenceId: 'generation-1',
            correlationId: 'correlation-1',
            surface: 'cli' as const,
        },
        occurredAtMs: sequence,
        sequence,
    });
}

afterEach(async () => {
    vi.restoreAllMocks();
    if (originalDebug === undefined) delete process.env.DEBUG;
    else process.env.DEBUG = originalDebug;
    await Promise.all(paths.splice(0).map(async (path) => await rm(path, { force: true })));
});

describe('plugin invocation structured file sink', () => {
    it('wakes from external file appends without restarting the observer', async () => {
        const path = join(tmpdir(), `happier-plugin-external-follow-${process.pid}-${Date.now()}.log`);
        paths.push(path);
        await writeFile(path, '');
        const logger = new Logger({ logFilePath: path, pruneCurrentProcessLogs: false });
        const controller = new AbortController();
        const following = logger.waitForPluginInvocationLogRecords({ pluginId: 'acme.example' }, controller.signal);
        try {
            await appendFile(path, `${JSON.stringify(pluginInvocationRecord('external append'))}\n`);
            await expect(following).resolves.toMatchObject({ records: [{ message: 'external append' }] });
        } finally {
            controller.abort();
        }
    });
    it('parks a filtered follow until an appended record matches and cancels only its own waiter', async () => {
        const path = join(tmpdir(), `happier-plugin-follow-${process.pid}-${Date.now()}.log`);
        paths.push(path);
        await writeFile(path, '');
        const logger = new Logger({ logFilePath: path, pruneCurrentProcessLogs: false });
        const controller = new AbortController();
        let settled = false;
        const following = logger.waitForPluginInvocationLogRecords({ pluginId: 'acme.example', cursor: 0 }, controller.signal);
        void following.then(() => { settled = true; });
        logger.appendPluginInvocationLogRecord({ ...pluginInvocationRecord('other'), context: {
            ...pluginInvocationRecord('other').context as Record<string, unknown>,
            plugin: { id: 'other.plugin', version: '1' },
        } });
        await new Promise((resolve) => setImmediate(resolve));
        expect(settled).toBe(false);
        const sibling = new AbortController();
        const cancelled = logger.waitForPluginInvocationLogRecords({ pluginId: 'acme.example', cursor: 0 }, sibling.signal);
        sibling.abort(new Error('stop observing'));
        await expect(cancelled).rejects.toThrow('stop observing');
        logger.appendPluginInvocationLogRecord(pluginInvocationRecord('arrived'));
        await expect(following).resolves.toMatchObject({ records: [{ message: 'arrived' }], hasMore: false });
    });

    it('resets a cursor explicitly when the active logger is replaced, even when the new file is longer', async () => {
        const oldPath = join(tmpdir(), `happier-plugin-old-${process.pid}-${Date.now()}.log`);
        const newPath = `${oldPath}.new`;
        paths.push(oldPath, newPath);
        const previous = new Logger({ logFilePath: oldPath, pruneCurrentProcessLogs: false });
        previous.appendPluginInvocationLogRecord(pluginInvocationRecord('old'));
        const page = previous.readPluginInvocationLogRecords({ pluginId: 'acme.example' });
        if (page.kind !== 'available') throw new Error('Expected old log');
        const current = new Logger({ logFilePath: newPath, pruneCurrentProcessLogs: false });
        current.appendPluginInvocationLogRecord(pluginInvocationRecord('new '.repeat(200)));
        expect(current.readPluginInvocationLogRecords({ pluginId: 'acme.example', cursor: page.cursor, logId: page.logId }))
            .toMatchObject({ cursorReset: true, records: [{ message: 'new '.repeat(200) }] });
    });

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

    it('isolates a file write failure without using stderr even in debug mode', async () => {
        const blockedPath = join(tmpdir(), `happier-plugin-blocked-${process.pid}-${Date.now()}`);
        paths.push(blockedPath);
        await writeFile(blockedPath, 'not a directory');
        process.env.DEBUG = '1';
        const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        const logger = new Logger(join(blockedPath, 'plugin-invocation.log'));

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
        await expect(readFile(blockedPath, 'utf8')).resolves.toBe('not a directory');
    });

    it('reads only the exact plugin and correlation from interleaved structured records', async () => {
        const path = join(tmpdir(), `happier-plugin-log-${process.pid}-${Date.now()}.log`);
        paths.push(path);
        const logger = new Logger(path);
        const context = (pluginId: string, correlationId: string) => ({
            plugin: { id: pluginId, version: '1.0.0' },
            contribution: { id: 'run', qualifiedId: `${pluginId}/run` },
            occurrenceId: 'generation-1',
            correlationId,
            surface: 'cli' as const,
        });

        logger.appendPluginInvocationLogRecord(Object.freeze({
            version: 1,
            kind: 'plugin_invocation_log',
            level: 'error',
            message: 'first',
            fields: { apiKey: '[REDACTED]' },
            occurredAtMs: 1,
            sequence: 1,
            context: context('acme.example', 'correlation-1'),
        }));
        logger.appendPluginInvocationLogRecord(Object.freeze({
            version: 1,
            kind: 'plugin_invocation_log',
            level: 'error',
            message: 'belongs to another correlation-1 in plain text',
            occurredAtMs: 2,
            sequence: 2,
            context: context('acme.example', 'correlation-2'),
        }));
        logger.appendPluginInvocationLogRecord(Object.freeze({
            version: 1,
            kind: 'plugin_invocation_log',
            level: 'error',
            message: 'belongs to another plugin',
            occurredAtMs: 3,
            sequence: 3,
            context: context('acme.other', 'correlation-1'),
        }));

        const result = logger.readPluginInvocationLogRecords({
            pluginId: 'acme.example',
            correlationId: 'correlation-1',
        });

        expect(result.kind).toBe('available');
        if (result.kind !== 'available') throw new Error('Expected canonical plugin logs');
        expect(result.records).toHaveLength(1);
        expect(result.records[0]).toMatchObject({
            message: 'first',
            fields: { apiKey: '[REDACTED]' },
            context: { correlationId: 'correlation-1', plugin: { id: 'acme.example' } },
        });
    });

    it.each([1, 2])('advances through a generic line spanning %i read windows before retrieving the next record', async (windows) => {
        const path = join(tmpdir(), `happier-plugin-log-${process.pid}-${Date.now()}.log`);
        paths.push(path);
        await writeFile(path, `${'x'.repeat(1024 * 1024 * windows + 64)}\n`);
        const logger = new Logger(path);

        logger.appendPluginInvocationLogRecord(pluginInvocationRecord('after oversized generic line'));

        let cursor = 0;
        for (let page = 0; page < windows; page += 1) {
            const result = logger.readPluginInvocationLogRecords({ pluginId: 'acme.example', cursor });
            expect(result.kind).toBe('available');
            if (result.kind !== 'available') throw new Error('Expected canonical plugin logs');
            expect(result.records).toEqual([]);
            expect(result.cursor).toBeGreaterThan(cursor);
            expect(result.hasMore).toBe(true);
            cursor = result.cursor;
        }

        const second = logger.readPluginInvocationLogRecords({
            pluginId: 'acme.example',
            cursor,
        });
        expect(second.kind).toBe('available');
        if (second.kind !== 'available') throw new Error('Expected canonical plugin logs');
        expect(second.cursor).toBeGreaterThan(cursor);
        expect(second.records).toHaveLength(1);
        expect(second.records[0]).toMatchObject({
            message: 'after oversized generic line',
            context: { plugin: { id: 'acme.example' } },
        });
        expect(second.hasMore).toBe(false);
    });

    it('retries a short partial record after the remaining bytes are appended', async () => {
        const path = join(tmpdir(), `happier-plugin-log-${process.pid}-${Date.now()}.log`);
        paths.push(path);
        const encoded = JSON.stringify(pluginInvocationRecord('completed partial record'));
        if (!encoded) throw new Error('Expected a serializable plugin log record');
        const splitAt = Math.floor(encoded.length / 2);
        await writeFile(path, encoded.slice(0, splitAt));
        const logger = new Logger(path);

        const first = logger.readPluginInvocationLogRecords({ pluginId: 'acme.example' });
        expect(first.kind).toBe('available');
        if (first.kind !== 'available') throw new Error('Expected canonical plugin logs');
        expect(first.records).toEqual([]);
        expect(first.cursor).toBe(0);
        expect(first.hasMore).toBe(true);

        await appendFile(path, `${encoded.slice(splitAt)}\n`);

        const second = logger.readPluginInvocationLogRecords({
            pluginId: 'acme.example',
            cursor: first.cursor,
        });
        expect(second.kind).toBe('available');
        if (second.kind !== 'available') throw new Error('Expected canonical plugin logs');
        expect(second.records).toHaveLength(1);
        expect(second.records[0]).toMatchObject({ message: 'completed partial record' });
        expect(second.cursor).toBeGreaterThan(first.cursor);
        expect(second.hasMore).toBe(false);
    });
});
