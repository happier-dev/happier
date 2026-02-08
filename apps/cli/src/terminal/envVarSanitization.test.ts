import { describe, expect, it } from 'vitest';
import { isValidEnvVarKey, sanitizeEnvVarRecord, validateEnvVarRecordStrict } from './envVarSanitization';

describe('envVarSanitization', () => {
    it('validates env var key shapes', () => {
        const validKeys = ['GOOD', '_ALSO_GOOD', 'camelCase', 'with123'] as const;
        const invalidKeys = ['1BAD', 'BAD-NAME', '', '__proto__', 'constructor', 'prototype'] as const;

        for (const key of validKeys) {
            expect(isValidEnvVarKey(key)).toBe(true);
        }
        for (const key of invalidKeys) {
            expect(isValidEnvVarKey(key)).toBe(false);
        }
    });

    it('sanitizes records by filtering invalid keys and non-string values', () => {
        const out = sanitizeEnvVarRecord({
            GOOD: 'ok',
            ['__proto__']: 'bad',
            ALSO_BAD_VALUE: 123,
            ALSO_GOOD: 'yes',
            ['BAD-NAME']: 'ignored',
        });
        expect(out).toEqual({ GOOD: 'ok', ALSO_GOOD: 'yes' });
    });

    it('returns empty sanitized records for non-object input', () => {
        expect(sanitizeEnvVarRecord(null)).toEqual({});
        expect(sanitizeEnvVarRecord('BAD')).toEqual({});
        expect(sanitizeEnvVarRecord(123)).toEqual({});
    });

    it('strictly validates records for spawning', () => {
        expect(validateEnvVarRecordStrict({ GOOD: 'ok' })).toEqual({ ok: true, env: { GOOD: 'ok' } });
        expect(validateEnvVarRecordStrict({ ['__proto__']: 'x' })).toEqual({ ok: false, error: 'Invalid env var key: \"__proto__\"' });
        expect(validateEnvVarRecordStrict({ GOOD: 123 })).toEqual({ ok: false, error: 'Invalid env var value for \"GOOD\": expected string' });
        expect(validateEnvVarRecordStrict({ 'BAD-NAME': 'x' })).toEqual({ ok: false, error: 'Invalid env var key: \"BAD-NAME\"' });
    });

    it('treats non-object strict input as empty env', () => {
        expect(validateEnvVarRecordStrict(undefined)).toEqual({ ok: true, env: {} });
        expect(validateEnvVarRecordStrict('not-object')).toEqual({ ok: true, env: {} });
    });

    it('fails on mixed valid and invalid strict entries', () => {
        expect(validateEnvVarRecordStrict({
            GOOD: 'ok',
            BAD: 123,
        })).toEqual({ ok: false, error: 'Invalid env var value for \"BAD\": expected string' });
        expect(validateEnvVarRecordStrict({
            GOOD: 'ok',
            ['BAD-NAME']: 'oops',
        })).toEqual({ ok: false, error: 'Invalid env var key: \"BAD-NAME\"' });
    });

    it('sanitizes records by filtering invalid keys and non-string values without mutating input', () => {
        const input = {
            GOOD: 'ok',
            ['__proto__']: 'bad',
            ALSO_OK: 123,
        };
        const output = sanitizeEnvVarRecord(input);
        expect(output).toEqual({ GOOD: 'ok' });
        expect(input).toEqual({
            GOOD: 'ok',
            ['__proto__']: 'bad',
            ALSO_OK: 123,
        });
    });
});
