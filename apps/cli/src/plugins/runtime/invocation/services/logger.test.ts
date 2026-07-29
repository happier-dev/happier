import { describe, expect, it, vi } from 'vitest';

import type { PluginInvocationServicesSeed } from './types';
import {
    createPluginInvocationLogger,
    createPluginInvocationSecretRedactor,
    PLUGIN_LOG_MAX_RECORD_BYTES,
    type PluginInvocationLogRecord,
} from './logger';

function seed(overrides: Partial<PluginInvocationServicesSeed> = {}): PluginInvocationServicesSeed {
    return Object.freeze({
        plugin: Object.freeze({ id: 'acme.alpha', version: '1.2.3' }),
        contribution: Object.freeze({ id: 'run', qualifiedId: 'acme.alpha/actions/run' }),
        generation: '7',
        correlationId: 'correlation-host-owned',
        surface: 'cli',
        signal: new AbortController().signal,
        isGenerationCurrent: () => true,
        ...overrides,
    });
}

function capture() {
    const records: PluginInvocationLogRecord[] = [];
    return {
        records,
        sink: Object.freeze({ write: (record: PluginInvocationLogRecord) => { records.push(record); } }),
    };
}

describe('stable invocation logger service', () => {
    it('redacts exact secret values registered by the stable secrets owner until generation retirement', () => {
        const secretRedactor = createPluginInvocationSecretRedactor();
        const invocationSeed = seed();
        const firstCapture = capture();
        const logger = createPluginInvocationLogger({
            seed: invocationSeed,
            sink: firstCapture.sink,
            secretRedactor,
        });
        secretRedactor.register({
            pluginId: invocationSeed.plugin.id,
            generation: invocationSeed.generation,
        }, 'provider-value-without-a-sensitive-shape');

        logger.info('provider-value-without-a-sensitive-shape', {
            ordinary: 'prefix provider-value-without-a-sensitive-shape suffix',
        });

        expect(JSON.stringify(firstCapture.records)).not.toContain('provider-value-without-a-sensitive-shape');
        expect(JSON.stringify(firstCapture.records)).toContain('[REDACTED]');

        secretRedactor.retireGeneration(invocationSeed.generation, invocationSeed.plugin.id);
        const secondCapture = capture();
        const afterRetirement = createPluginInvocationLogger({
            seed: invocationSeed,
            sink: secondCapture.sink,
            secretRedactor,
        });
        afterRetirement.info('provider-value-without-a-sensitive-shape');
        expect(JSON.stringify(secondCapture.records)).toContain('provider-value-without-a-sensitive-shape');
    });

    it('injects immutable host identity and preserves every severity exactly', () => {
        const { records, sink } = capture();
        const logger = createPluginInvocationLogger({ seed: seed(), sink, now: () => 123 });

        logger.debug('debug', { pluginId: 'forged' });
        logger.info('info');
        logger.warn('warn');
        logger.error('error');
        logger.diagnostic({ code: 'plugin_notice', severity: 'warning', message: 'notice' });

        expect(records.map((record) => record.level)).toEqual(['debug', 'info', 'warn', 'error', 'diagnostic']);
        expect(records[0]).toMatchObject({
            context: {
                plugin: { id: 'acme.alpha', version: '1.2.3' },
                contribution: { id: 'run', qualifiedId: 'acme.alpha/actions/run' },
                generation: '7',
                correlationId: 'correlation-host-owned',
                surface: 'cli',
            },
            fields: { pluginId: 'forged' },
            occurredAtMs: 123,
            sequence: 1,
        });
        expect(records[4]).toMatchObject({ diagnostic: { code: 'plugin_notice', severity: 'warning' } });
        expect(Object.isFrozen(records[0])).toBe(true);
        expect(Object.isFrozen(records[0]!.context)).toBe(true);
    });

    it('redacts sensitive fields and deterministically bounds cyclic and oversized input', () => {
        const { records, sink } = capture();
        const logger = createPluginInvocationLogger({ seed: seed(), sink, now: () => 123 });
        const cyclic: Record<string, unknown> = {
            password: 'raw-secret',
            authorization: 'Bearer secret-token',
            huge: 'x'.repeat(PLUGIN_LOG_MAX_RECORD_BYTES * 2),
        };
        cyclic.self = cyclic;

        // Runtime JavaScript can violate the SDK's JSON-only field type; the host boundary must remain safe.
        const runtimeLogger = logger as unknown as Readonly<{
            info(message: string, fields?: Readonly<Record<string, unknown>>): void;
        }>;
        expect(() => runtimeLogger.info('token=raw-secret', cyclic)).not.toThrow();

        const serialized = JSON.stringify(records[0]);
        expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThanOrEqual(PLUGIN_LOG_MAX_RECORD_BYTES);
        expect(serialized).not.toContain('raw-secret');
        expect(serialized).not.toContain('secret-token');
        expect(serialized).toMatch(/REDACTED/);
        expect(serialized).toMatch(/TRUNCATED|Circular/);
    });

    it('redacts URL credentials and sensitive query parameters in messages and nested values', () => {
        const { records, sink } = capture();
        const logger = createPluginInvocationLogger({ seed: seed(), sink, now: () => 123 });
        const sensitiveUrl = 'https://alice:supersecret@example.test/path?token=query-secret&safe=yes';

        logger.info(sensitiveUrl, { nested: { url: sensitiveUrl } });

        const serialized = JSON.stringify(records[0]);
        expect(serialized).not.toContain('alice');
        expect(serialized).not.toContain('supersecret');
        expect(serialized).not.toContain('query-secret');
        expect(serialized).toContain('example.test');
        expect(serialized).toContain('safe=yes');
        expect(serialized).toMatch(/REDACTED/);
    });

    it('redacts the complete sensitive identity and credential key family', () => {
        const { records, sink } = capture();
        const logger = createPluginInvocationLogger({ seed: seed(), sink, now: () => 123 });

        logger.info('sensitive keys', {
            sessionId: 'SID-SECRET-123',
            jwt: 'JWT-SECRET-123',
            privateKey: 'KEY-SECRET-123',
            passphrase: 'PASS-SECRET-123',
        });

        const serialized = JSON.stringify(records[0]);
        expect(serialized).not.toContain('SID-SECRET-123');
        expect(serialized).not.toContain('JWT-SECRET-123');
        expect(serialized).not.toContain('KEY-SECRET-123');
        expect(serialized).not.toContain('PASS-SECRET-123');
        expect(serialized.match(/\[REDACTED\]/g)).toHaveLength(4);
    });

    it('isolates sink exceptions and fences aborted or stale generations', () => {
        const throwing = createPluginInvocationLogger({
            seed: seed(),
            sink: { write: () => { throw new Error('disk failed'); } },
            now: () => 123,
        });
        expect(() => throwing.error('primary work must continue')).not.toThrow();

        let current = false;
        const staleCapture = capture();
        const stale = createPluginInvocationLogger({
            seed: seed({ isGenerationCurrent: () => current }),
            sink: staleCapture.sink,
            now: () => 123,
        });
        stale.info('stale');

        const controller = new AbortController();
        const abortedCapture = capture();
        const aborted = createPluginInvocationLogger({
            seed: seed({ signal: controller.signal }),
            sink: abortedCapture.sink,
            now: () => 123,
        });
        controller.abort();
        aborted.info('aborted');

        expect(staleCapture.records).toEqual([]);
        expect(abortedCapture.records).toEqual([]);
    });

    it('rechecks generation after sanitizing plugin-controlled fields', () => {
        let current = true;
        const { records, sink } = capture();
        const logger = createPluginInvocationLogger({
            seed: seed({ isGenerationCurrent: () => current }),
            sink,
            now: () => 123,
        });
        const fields = Object.create(null) as Record<string, unknown>;
        Object.defineProperty(fields, 'retireDuringRead', {
            enumerable: true,
            get() {
                current = false;
                return 'retired';
            },
        });

        const runtimeLogger = logger as unknown as Readonly<{
            info(message: string, fields: Readonly<Record<string, unknown>>): void;
        }>;
        runtimeLogger.info('must not cross generation', fields);

        expect(records).toEqual([]);
    });

    it('assigns a deterministic invocation-local sequence under concurrent calls', async () => {
        const { records, sink } = capture();
        const logger = createPluginInvocationLogger({ seed: seed(), sink, now: () => 123 });

        await Promise.all(Array.from({ length: 20 }, async (_, index) => {
            logger.info(`message-${index}`);
        }));

        expect(records.map((record) => record.sequence)).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
        expect(new Set(records.map((record) => record.context.correlationId))).toEqual(new Set(['correlation-host-owned']));
    });

    it('bounds host-supplied context without allowing it to exceed the record ceiling', () => {
        const { records, sink } = capture();
        const logger = createPluginInvocationLogger({
            seed: seed({
                plugin: Object.freeze({ id: `acme.${'x'.repeat(40_000)}`, version: '1.2.3' }),
            }),
            sink,
            now: () => 123,
        });

        logger.info('bounded context');

        expect(records).toHaveLength(1);
        expect(Buffer.byteLength(JSON.stringify(records[0]), 'utf8')).toBeLessThanOrEqual(PLUGIN_LOG_MAX_RECORD_BYTES);
        expect(records[0]!.context.plugin.id).toMatch(/^sha256:[a-f0-9]{64}$/);
    });
});
