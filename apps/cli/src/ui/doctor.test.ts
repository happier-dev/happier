import { describe, it, expect } from 'vitest';
import {
  collectMissingRequiredWebhookFields,
  isMissingRequiredTelegramWebhookSecret,
  maskValue,
  redactDaemonStateForDisplay,
  shouldShowGlobalProcessInventory,
} from './doctor';

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

describe('telegram webhook secret requirements', () => {
    it('requires webhook secret only when webhook mode is enabled', () => {
        expect(isMissingRequiredTelegramWebhookSecret({ webhookEnabled: true, webhookSecret: '' })).toBe(true);
        expect(isMissingRequiredTelegramWebhookSecret({ webhookEnabled: true, webhookSecret: '   ' })).toBe(true);
        expect(isMissingRequiredTelegramWebhookSecret({ webhookEnabled: true, webhookSecret: 'secret-123' })).toBe(false);
        expect(isMissingRequiredTelegramWebhookSecret({ webhookEnabled: false, webhookSecret: '' })).toBe(false);
    });
});

describe('generic webhook field requirements', () => {
    it('returns no issues when webhook mode is disabled', () => {
        expect(
            collectMissingRequiredWebhookFields({
                webhookEnabled: false,
                webhookSecret: '',
                webhookHost: '',
                webhookPort: null,
            }),
        ).toEqual([]);
    });

    it('flags missing required webhook fields when enabled', () => {
        expect(
            collectMissingRequiredWebhookFields({
                webhookEnabled: true,
                webhookSecret: ' ',
                webhookHost: '',
                webhookPort: null,
            }),
        ).toEqual([
            'webhook.secret: <empty> (required when webhook.enabled=true)',
            'webhook.host: <empty> (required when webhook.enabled=true)',
            'webhook.port: <empty/invalid> (required when webhook.enabled=true)',
        ]);
    });

    it('accepts valid webhook secret, host, and port', () => {
        expect(
            collectMissingRequiredWebhookFields({
                webhookEnabled: true,
                webhookSecret: 'secret-1',
                webhookHost: '127.0.0.1',
                webhookPort: 8787,
            }),
        ).toEqual([]);
    });
});
