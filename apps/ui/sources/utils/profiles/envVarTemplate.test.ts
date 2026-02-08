import { describe, expect, it } from 'vitest';
import { formatEnvVarTemplate, parseEnvVarTemplate } from './envVarTemplate';

describe('envVarTemplate', () => {
    it('preserves := operator during parse/format round-trip', () => {
        const input = '${FOO:=bar}';
        const parsed = parseEnvVarTemplate(input);
        expect(parsed).toEqual({ sourceVar: 'FOO', operator: ':=', fallback: 'bar' });
        expect(formatEnvVarTemplate(parsed!)).toBe(input);
    });

    it('preserves :- operator during parse/format round-trip', () => {
        const input = '${FOO:-bar}';
        const parsed = parseEnvVarTemplate(input);
        expect(parsed).toEqual({ sourceVar: 'FOO', operator: ':-', fallback: 'bar' });
        expect(formatEnvVarTemplate(parsed!)).toBe(input);
    });

    it('round-trips templates without a fallback', () => {
        const input = '${FOO}';
        const parsed = parseEnvVarTemplate(input);
        expect(parsed).toEqual({ sourceVar: 'FOO', operator: null, fallback: '' });
        expect(formatEnvVarTemplate(parsed!)).toBe(input);
    });

    it('formats an empty fallback when operator is explicitly provided', () => {
        expect(formatEnvVarTemplate({ sourceVar: 'FOO', operator: ':=', fallback: '' })).toBe('${FOO:=}');
        expect(formatEnvVarTemplate({ sourceVar: 'FOO', operator: ':-', fallback: '' })).toBe('${FOO:-}');
    });

    it('defaults to :- operator when fallback is provided without explicit operator', () => {
        expect(formatEnvVarTemplate({ sourceVar: 'FOO', fallback: 'bar' })).toBe('${FOO:-bar}');
    });

    it('returns null for invalid templates', () => {
        expect(parseEnvVarTemplate('${1INVALID}')).toBeNull();
        expect(parseEnvVarTemplate('FOO')).toBeNull();
        expect(parseEnvVarTemplate('${FOO:bar}')).toBeNull();
    });
});
