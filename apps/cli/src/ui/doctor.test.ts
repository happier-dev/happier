import { describe, it, expect } from 'vitest';
import {
  collectMissingRequiredWebhookFields,
  resolveTelegramWebhookValidationInputs,
  isMissingRequiredTelegramWebhookSecret,
  parseStrictWebhookPort,
  applyDoctorExitCode,
  maskValue,
  redactSettingsForDisplay,
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

    it('redacts channel bridge secret fields from settings output', () => {
        const input = {
            channelBridge: {
                byServerId: {
                    'local-3005': {
                        byAccountId: {
                            acct1: {
                                providers: {
                                    telegram: {
                                        botToken: 'bot-token-123',
                                        webhook: {
                                            enabled: true,
                                            host: '127.0.0.1',
                                            port: 8787,
                                            secret: 'legacy-webhook-secret',
                                        },
                                        secrets: {
                                            botToken: 'bot-token-123',
                                            webhookSecret: 'webhook-secret-123',
                                            extraSecret: 'extra-secret',
                                        },
                                    },
                                },
                            },
                        },
                    },
                },
            },
        };

        const redacted = redactSettingsForDisplay(input as never) as any;
        const telegram = redacted.channelBridge.byServerId['local-3005'].byAccountId.acct1.providers.telegram;
        expect(telegram.botToken).toBe('<redacted>');
        expect(telegram.webhook.secret).toBe('<redacted>');
        expect(telegram.secrets.botToken).toBe('<redacted>');
        expect(telegram.secrets.webhookSecret).toBe('<redacted>');
        expect(telegram.secrets.extraSecret).toBe('<redacted>');
        expect(telegram.webhook.host).toBe('127.0.0.1');
        expect(telegram.webhook.port).toBe(8787);
    });

    it('redacts global and server-scoped channel bridge provider secrets', () => {
        const input = {
            channelBridge: {
                providers: {
                    telegram: {
                        botToken: 'global-bot-token',
                        webhook: {
                            secret: 'global-webhook-secret',
                        },
                        secrets: {
                            botToken: 'global-bot-token',
                        },
                    },
                },
                byServerId: {
                    'local-3005': {
                        providers: {
                            telegram: {
                                botToken: 'server-bot-token',
                                webhook: {
                                    secret: 'server-webhook-secret',
                                },
                                secrets: {
                                    webhookSecret: 'server-webhook-secret',
                                },
                            },
                        },
                    },
                },
            },
        };

        const redacted = redactSettingsForDisplay(input as never) as any;
        expect(redacted.channelBridge.providers.telegram.botToken).toBe('<redacted>');
        expect(redacted.channelBridge.providers.telegram.webhook.secret).toBe('<redacted>');
        expect(redacted.channelBridge.providers.telegram.secrets.botToken).toBe('<redacted>');
        expect(redacted.channelBridge.byServerId['local-3005'].providers.telegram.botToken).toBe('<redacted>');
        expect(redacted.channelBridge.byServerId['local-3005'].providers.telegram.webhook.secret).toBe('<redacted>');
        expect(redacted.channelBridge.byServerId['local-3005'].providers.telegram.secrets.webhookSecret).toBe('<redacted>');
    });
});

describe('parseStrictWebhookPort', () => {
    it('rejects negative and out-of-range values', () => {
        expect(parseStrictWebhookPort('-1')).toBeNull();
        expect(parseStrictWebhookPort(' -8787 ')).toBeNull();
        expect(parseStrictWebhookPort('0')).toBeNull();
        expect(parseStrictWebhookPort(0)).toBeNull();
        expect(parseStrictWebhookPort('65536')).toBeNull();
        expect(parseStrictWebhookPort(70_000)).toBeNull();
    });

    it('accepts valid positive integer values', () => {
        expect(parseStrictWebhookPort('8787')).toBe(8787);
        expect(parseStrictWebhookPort(8787)).toBe(8787);
        expect(parseStrictWebhookPort('65535')).toBe(65_535);
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

    it('flags non-loopback webhook hosts when enabled', () => {
        expect(
            collectMissingRequiredWebhookFields({
                webhookEnabled: true,
                webhookSecret: 'secret-1',
                webhookHost: '0.0.0.0',
                webhookPort: 8787,
            }),
        ).toEqual([
            "webhook.host: '0.0.0.0' is not loopback-only (required when webhook.enabled=true)",
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

describe('telegram webhook validation inputs', () => {
    it('uses resolved runtime defaults for host and port validation', () => {
        expect(
            resolveTelegramWebhookValidationInputs({
                runtimeWebhookHost: '127.0.0.1',
                runtimeWebhookPort: 8787,
            }),
        ).toEqual({
            webhookHost: '127.0.0.1',
            webhookPort: 8787,
        });
    });

    it('flags invalid runtime values so critical checks can fail loudly', () => {
        expect(
            resolveTelegramWebhookValidationInputs({
                runtimeWebhookHost: '   ',
                runtimeWebhookPort: Number.NaN,
            }),
        ).toEqual({
            webhookHost: '',
            webhookPort: null,
    });
  });
});

describe('doctor exit code behavior', () => {
  it('sets process exit code to 1 when critical failures are present', () => {
    const previousExitCode = process.exitCode;
    try {
      process.exitCode = 0;
      applyDoctorExitCode(true);
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it('leaves process exit code unchanged when no critical failures are present', () => {
    const previousExitCode = process.exitCode;
    try {
      process.exitCode = 0;
      applyDoctorExitCode(false);
      expect(process.exitCode).toBe(0);
    } finally {
      process.exitCode = previousExitCode;
    }
  });
});
