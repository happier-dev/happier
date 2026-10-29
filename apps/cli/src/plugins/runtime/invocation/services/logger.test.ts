import { describe, expect, it, vi } from 'vitest';
import { redactBugReportSensitiveText } from '@happier-dev/protocol';

import type { PluginInvocationServicesSeed } from './types';
import {
    createPluginInvocationLogger,
    createPluginInvocationSecretRedactor,
    type PluginInvocationLogRecord,
} from './logger';

function seed(overrides: Partial<PluginInvocationServicesSeed> = {}): PluginInvocationServicesSeed {
    return Object.freeze({
        plugin: Object.freeze({ id: 'acme.alpha', version: '1.2.3' }),
        contribution: Object.freeze({ id: 'run', qualifiedId: 'acme.alpha/actions/run' }),
        occurrenceId: '7',
        correlationId: 'correlation-host-owned',
        surface: 'cli',
        signal: new AbortController().signal,
        isOccurrenceCurrent: () => true,
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
    it('isolates exact secret values to one invocation and releases them on completion', () => {
        const secretRedactor = createPluginInvocationSecretRedactor();
        const invocationSeed = seed();
        const scope = {
            pluginId: invocationSeed.plugin.id,
            occurrenceId: invocationSeed.occurrenceId,
            correlationId: invocationSeed.correlationId,
        };
        secretRedactor.beginInvocation(scope, invocationSeed.signal);
        const firstCapture = capture();
        const logger = createPluginInvocationLogger({
            seed: invocationSeed,
            sink: firstCapture.sink,
            secretRedactor,
        });
        const rawValue = 'provider "value"\nwithout a sensitive shape';
        secretRedactor.registerRaw(scope, rawValue);

        logger.info('provider "value"\nwithout a sensitive shape', {
            ordinary: 'prefix provider "value"\nwithout a sensitive shape suffix',
            jsonEscaped: JSON.stringify('provider "value"\nwithout a sensitive shape').slice(1, -1),
            urlEncoded: encodeURIComponent('provider "value"\nwithout a sensitive shape'),
            formEncoded: new URLSearchParams({
                value: rawValue,
            }).toString().slice('value='.length),
            base64: Buffer.from(rawValue).toString('base64'),
            base64url: Buffer.from(rawValue).toString('base64url'),
            hex: Buffer.from(rawValue).toString('hex'),
        });

        const serialized = JSON.stringify(firstCapture.records);
        expect(serialized).not.toContain('provider \\"value\\"\\nwithout a sensitive shape');
        expect(serialized).not.toContain('provider%20%22value%22%0Awithout%20a%20sensitive%20shape');
        expect(serialized).not.toContain('provider+%22value%22%0Awithout+a+sensitive+shape');
        expect(JSON.stringify(firstCapture.records)).toContain('[REDACTED]');
        expect(redactBugReportSensitiveText(
            `support=${encodeURIComponent('provider "value"\nwithout a sensitive shape')}`,
        )).toBe(`support=${encodeURIComponent('provider "value"\nwithout a sensitive shape')}`);

        secretRedactor.completeInvocation(scope);
        const secondCapture = capture();
        const afterRetirement = createPluginInvocationLogger({
            seed: invocationSeed,
            sink: secondCapture.sink,
            secretRedactor,
        });
        afterRetirement.info('provider "value"\nwithout a sensitive shape');
        expect(JSON.stringify(secondCapture.records)).toContain('provider \\"value\\"\\nwithout a sensitive shape');

        const revokedController = new AbortController();
        const revokedScope = {
            pluginId: invocationSeed.plugin.id,
            occurrenceId: invocationSeed.occurrenceId,
            correlationId: 'revoked-correlation',
        };
        secretRedactor.beginInvocation(revokedScope, revokedController.signal);
        secretRedactor.registerRaw(revokedScope, 'revoked ordinary value');
        revokedController.abort();
        expect(secretRedactor.redact(revokedScope, 'revoked ordinary value'))
            .toBe('revoked ordinary value');
    });

    it('prefers the longest overlapping credential and preserves diagnostics with many large registered secrets', () => {
        const secretRedactor = createPluginInvocationSecretRedactor();
        const invocationSeed = seed();
        const firstCapture = capture();
        const logger = createPluginInvocationLogger({
            seed: invocationSeed,
            sink: firstCapture.sink,
            secretRedactor,
        });
        const scope = {
            pluginId: invocationSeed.plugin.id,
            occurrenceId: invocationSeed.occurrenceId,
            correlationId: invocationSeed.correlationId,
        };
        const siblingScope = {
            pluginId: invocationSeed.plugin.id,
            occurrenceId: invocationSeed.occurrenceId,
            correlationId: 'concurrent-sibling',
        };
        secretRedactor.beginInvocation(scope, invocationSeed.signal);
        secretRedactor.beginInvocation(siblingScope, invocationSeed.signal);
        secretRedactor.registerRaw(scope, 'Bearer overlapping-credential');
        secretRedactor.registerRaw(scope, 'overlapping-credential');

        logger.info('Bearer overlapping-credential');
        expect(firstCapture.records[0]?.message).toBe('[REDACTED]');

        const largeSecret = 'x'.repeat(16 * 1024 + 1);
        secretRedactor.registerRaw(scope, largeSecret);
        const secrets = Array.from({ length: 130 }, (_, index) => `opaque-value-${index}-${'y'.repeat(2048)}`);
        for (const value of secrets) secretRedactor.registerExact(scope, value);
        logger.info('ordinary status after registration');
        expect(firstCapture.records[1]?.message).toBe('ordinary status after registration');
        expect(secretRedactor.redact(scope, `prefix ${largeSecret} suffix`)).toBe('prefix [REDACTED] suffix');
        expect(secretRedactor.redact(scope, `prefix ${secrets.at(-1)!} suffix`)).toBe('prefix [REDACTED] suffix');
        expect(secretRedactor.redact(siblingScope, 'ordinary status after sibling saturation'))
            .toBe('ordinary status after sibling saturation');
        secretRedactor.completeInvocation(scope);
        secretRedactor.registerRaw(scope, 'late-registration-must-not-recreate');
        expect(secretRedactor.redact(scope, 'overlapping-credential')).toBe('overlapping-credential');
        expect(secretRedactor.redact(scope, 'late-registration-must-not-recreate'))
            .toBe('late-registration-must-not-recreate');
        secretRedactor.completeInvocation(siblingScope);
        const retiredScope = {
            pluginId: invocationSeed.plugin.id,
            occurrenceId: invocationSeed.occurrenceId,
            correlationId: 'retired-occurrenceId',
        };
        secretRedactor.beginInvocation(retiredScope, invocationSeed.signal);
        secretRedactor.registerRaw(retiredScope, 'registered-before-retirement');
        secretRedactor.retireGeneration(invocationSeed.occurrenceId, invocationSeed.plugin.id);
        secretRedactor.registerRaw(retiredScope, 'late-after-occurrenceId-retirement');
        expect(secretRedactor.redact(retiredScope, 'registered-before-retirement'))
            .toBe('registered-before-retirement');
        expect(secretRedactor.redact(retiredScope, 'late-after-occurrenceId-retirement'))
            .toBe('late-after-occurrenceId-retirement');
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
                occurrenceId: '7',
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

    it('preserves large structured diagnostics while redacting secrets and marking cycles', () => {
        const { records, sink } = capture();
        const logger = createPluginInvocationLogger({ seed: seed(), sink, now: () => 123 });
        const cyclic: Record<string, unknown> = {
            password: 'raw-secret',
            authorization: 'Bearer secret-token',
            huge: 'x'.repeat(64 * 1024),
            entries: Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`entry-${index}`, { nested: { value: index } }])),
            ['long-key-' + 'z'.repeat(256)]: 'kept',
        };
        let deep: unknown = { value: 'deep leaf' };
        for (let depth = 0; depth < 10; depth += 1) deep = { child: deep };
        cyclic.deep = deep;
        cyclic.self = cyclic;

        // Runtime JavaScript can violate the SDK's JSON-only field type; the host boundary must remain safe.
        const runtimeLogger = logger as unknown as Readonly<{
            info(message: string, fields?: Readonly<Record<string, unknown>>): void;
        }>;
        expect(() => runtimeLogger.info('token=raw-secret', cyclic)).not.toThrow();

        const serialized = JSON.stringify(records[0]);
        expect(records[0]?.fields).toMatchObject({ huge: cyclic.huge, entries: cyclic.entries, deep,
            ['long-key-' + 'z'.repeat(256)]: 'kept' });
        expect(serialized).not.toContain('raw-secret');
        expect(serialized).not.toContain('secret-token');
        expect(serialized).toMatch(/REDACTED/);
        expect(serialized).toContain('[Circular]');
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

    it('preserves the complete redacted failure message', () => {
        const { records, sink } = capture();
        const logger = createPluginInvocationLogger({ seed: seed(), sink, now: () => 123 });

        logger.error([
            'BEGIN_FAILURE client_secret=log-secret',
            '🙂'.repeat(3_000),
            'END_STACK',
        ].join(' '));

        const message = records[0]?.message ?? '';
        expect(message).toMatch(/^BEGIN_FAILURE/u);
        expect(message).not.toContain('log-secret');
        expect(message).toContain('END_STACK');
        expect(message).toContain('🙂'.repeat(3_000));
    });

    it('preserves complete diagnostic messages and details after redaction', () => {
        const { records, sink } = capture();
        const invocationSeed = seed();
        const secretRedactor = createPluginInvocationSecretRedactor();
        const scope = {
            pluginId: invocationSeed.plugin.id,
            occurrenceId: invocationSeed.occurrenceId,
            correlationId: invocationSeed.correlationId,
        };
        secretRedactor.beginInvocation(scope, invocationSeed.signal);
        secretRedactor.registerRaw(scope, 'opaque-diagnostic-secret');
        const logger = createPluginInvocationLogger({
            seed: invocationSeed,
            sink,
            now: () => 123,
            secretRedactor,
        });

        logger.diagnostic({
            code: 'plugin_failure',
            severity: 'error',
            message: [
                'BEGIN_FAILURE client_secret=diagnostic-secret opaque-diagnostic-secret',
                '🙂'.repeat(3_000),
                'END_STACK',
            ].join(' '),
            details: Object.fromEntries(Array.from({ length: 64 }, (_, index) => [
                `detail_${index}`,
                'x'.repeat(4 * 1024),
            ])),
        });

        const message = records[0]?.diagnostic?.message;
        if (typeof message !== 'string') {
            throw new Error('Expected a diagnostic message');
        }
        expect(message).toMatch(/^BEGIN_FAILURE/u);
        expect(message).not.toContain('diagnostic-secret');
        expect(message).not.toContain('opaque-diagnostic-secret');
        expect(message).toContain('END_STACK');
        expect(records[0]?.diagnostic?.details).toEqual(Object.fromEntries(Array.from({ length: 64 }, (_, index) => [
            `detail_${index}`, 'x'.repeat(4 * 1024),
        ])));
    });

    it('redacts the whole quoted credential while preserving surrounding diagnostic text', () => {
        const { records, sink } = capture();
        const logger = createPluginInvocationLogger({ seed: seed(), sink, now: () => 123 });
        const leakedTail = 'credential-tail-must-not-survive';

        logger.error(
            `BEGIN_FAILURE client_secret="first-word ${leakedTail} ${'padding '.repeat(20_000)}" END_STACK`,
        );

        const message = records[0]?.message ?? '';
        expect(message).toMatch(/^BEGIN_FAILURE/u);
        expect(message).not.toContain('first-word');
        expect(message).not.toContain(leakedTail);
        expect(message).toContain('END_STACK');
    });

    it('redacts segment-aware credential keys without treating counts and prose as credentials', () => {
        const { records, sink } = capture();
        const logger = createPluginInvocationLogger({ seed: seed(), sink, now: () => 123 });

        logger.info('credential fields', {
            authorization: 'authorization-secret',
            accessToken: 'access-token-secret',
            refresh_token: 'refresh-token-secret',
            apiKey: 'api-key-secret',
            client_secret: 'client-secret-value',
            password: 'password-secret',
            cookie: 'cookie-secret',
            jwt: 'jwt-secret',
            privateKey: 'private-key-secret',
            passphrase: 'passphrase-secret',
            sessionCount: 'seven-sessions',
            tokenCount: 'eight-tokens',
            secretary: 'meeting-notes',
        });

        const serialized = JSON.stringify(records[0]);
        for (const secret of [
            'authorization-secret',
            'access-token-secret',
            'refresh-token-secret',
            'api-key-secret',
            'client-secret-value',
            'password-secret',
            'cookie-secret',
            'jwt-secret',
            'private-key-secret',
            'passphrase-secret',
        ]) {
            expect(serialized).not.toContain(secret);
        }
        expect(serialized).toContain('seven-sessions');
        expect(serialized).toContain('eight-tokens');
        expect(serialized).toContain('meeting-notes');
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
            seed: seed({ isOccurrenceCurrent: () => current }),
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

    it('rechecks occurrenceId after sanitizing plugin-controlled fields', () => {
        let current = true;
        const { records, sink } = capture();
        const logger = createPluginInvocationLogger({
            seed: seed({ isOccurrenceCurrent: () => current }),
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
        runtimeLogger.info('must not cross occurrenceId', fields);

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

    it('preserves host-supplied diagnostic context without hashing it', () => {
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
        expect(records[0]!.context.plugin.id).toBe(`acme.${'x'.repeat(40_000)}`);
    });
});
