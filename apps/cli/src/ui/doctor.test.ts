import { describe, it, expect } from 'vitest';
import { maskValue, redactDaemonStateForDisplay, shouldShowGlobalProcessInventory } from './doctor';

describe('doctor redaction', () => {
    it('does not treat ${VAR:-default} templates as safe', () => {
        expect(maskValue('${SAFE_TEMPLATE}')).toBe('${SAFE_TEMPLATE}');
        expect(maskValue('${LEAK:-sk-live-secret}')).toMatch(/^\$\{LEAK:-<\d+ chars>\}$/);
        expect(maskValue('${LEAK:=sk-live-secret}')).toMatch(/^\$\{LEAK:=<\d+ chars>\}$/);
        expect(maskValue('${LEAK:-}')).toBe('${LEAK:-}');
    });

    it('handles empty, undefined, and plain secret values', () => {
        expect(maskValue('')).toBe('<empty>');
        expect(maskValue(undefined)).toBeUndefined();
        expect(maskValue('sk-live-secret')).toBe('<14 chars>');
    });

    it('redacts daemon control tokens from daemon state', () => {
        const redacted = redactDaemonStateForDisplay({
            pid: 123,
            httpPort: 456,
            startedAt: 1,
            startedWithCliVersion: '0.0.0',
            controlToken: 'secret-token',
        });
        expect(redacted).toEqual({
            pid: 123,
            httpPort: 456,
            startedAt: 1,
            startedWithCliVersion: '0.0.0',
            controlToken: '<redacted>',
        });
    });

    it('keeps daemon state unchanged when control token is missing or blank', () => {
        expect(redactDaemonStateForDisplay({
            pid: 123,
            httpPort: 456,
            startedAt: 1,
            startedWithCliVersion: '0.0.0',
        })).toMatchObject({
            pid: 123,
            httpPort: 456,
            startedAt: 1,
            startedWithCliVersion: '0.0.0',
        });

        expect(redactDaemonStateForDisplay({
            pid: 123,
            httpPort: 456,
            startedAt: 1,
            startedWithCliVersion: '0.0.0',
            controlToken: '',
        })).toMatchObject({
            controlToken: '',
        });
    });
});

describe('doctor process inventory visibility', () => {
    it('hides global process inventory for daemon-only status output', () => {
        expect(shouldShowGlobalProcessInventory('daemon')).toBe(false);
    });

    it('shows global process inventory for full doctor output', () => {
        expect(shouldShowGlobalProcessInventory('all')).toBe(true);
    });
});
