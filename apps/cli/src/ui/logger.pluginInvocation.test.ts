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
            generation: 'generation-1',
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

    it('reads only the exact plugin and correlation from interleaved structured records', async () => {
        const path = join(tmpdir(), `happier-plugin-log-${process.pid}-${Date.now()}.log`);
        paths.push(path);
        const logger = new Logger(path);
        const context = (pluginId: string, correlationId: string) => ({
            plugin: { id: pluginId, version: '1.0.0' },
            contribution: { id: 'run', qualifiedId: `${pluginId}/run` },
            generation: 'generation-1',
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

    it('advances past an oversized generic line and retrieves the next structured record', async () => {
        const path = join(tmpdir(), `happier-plugin-log-${process.pid}-${Date.now()}.log`);
        paths.push(path);
        await writeFile(path, `${'x'.repeat(1024 * 1024 + 64)}\n`);
        const logger = new Logger(path);

        logger.appendPluginInvocationLogRecord(pluginInvocationRecord('after oversized generic line'));

        const first = logger.readPluginInvocationLogRecords({ pluginId: 'acme.example' });
        expect(first.kind).toBe('available');
        if (first.kind !== 'available') throw new Error('Expected canonical plugin logs');
        expect(first.records).toEqual([]);
        expect(first.cursor).toBeGreaterThan(0);
        expect(first.hasMore).toBe(true);

        const second = logger.readPluginInvocationLogRecords({
            pluginId: 'acme.example',
            cursor: first.cursor,
        });
        expect(second.kind).toBe('available');
        if (second.kind !== 'available') throw new Error('Expected canonical plugin logs');
        expect(second.cursor).toBeGreaterThan(first.cursor);
        expect(second.records).toHaveLength(1);
        expect(second.records[0]).toMatchObject({
            message: 'after oversized generic line',
            context: { plugin: { id: 'acme.example' } },
        });
    });

    it('advances through a generic line exceeding two read windows before retrieving the next record', async () => {
        const path = join(tmpdir(), `happier-plugin-log-${process.pid}-${Date.now()}.log`);
        paths.push(path);
        await writeFile(path, `${'x'.repeat((1024 * 1024 * 2) + 64)}\n`);
        const logger = new Logger(path);
        logger.appendPluginInvocationLogRecord(pluginInvocationRecord('after two oversized windows'));

        const first = logger.readPluginInvocationLogRecords({ pluginId: 'acme.example' });
        expect(first.kind).toBe('available');
        if (first.kind !== 'available') throw new Error('Expected canonical plugin logs');
        expect(first.records).toEqual([]);
        expect(first.cursor).toBeGreaterThan(0);
        expect(first.hasMore).toBe(true);

        const second = logger.readPluginInvocationLogRecords({
            pluginId: 'acme.example',
            cursor: first.cursor,
        });
        expect(second.kind).toBe('available');
        if (second.kind !== 'available') throw new Error('Expected canonical plugin logs');
        expect(second.records).toEqual([]);
        expect(second.cursor).toBeGreaterThan(first.cursor);
        expect(second.hasMore).toBe(true);

        const third = logger.readPluginInvocationLogRecords({
            pluginId: 'acme.example',
            cursor: second.cursor,
        });
        expect(third.kind).toBe('available');
        if (third.kind !== 'available') throw new Error('Expected canonical plugin logs');
        expect(third.records).toHaveLength(1);
        expect(third.records[0]).toMatchObject({ message: 'after two oversized windows' });
        expect(third.cursor).toBeGreaterThan(second.cursor);
        expect(third.hasMore).toBe(false);
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
