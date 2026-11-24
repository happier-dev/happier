import { describe, expect, it } from 'vitest';
import { redactBugReportSensitiveText } from '@happier-dev/protocol';

import { redactTranscriptSecrets } from '@/api/session/client/transport/transcriptSecretRedaction';

import { beginSessionLaunchSecretRedaction } from './runtimeDiagnosticRedaction';

describe('beginSessionLaunchSecretRedaction', () => {
    it('uses an explicit external Agent declaration as the exact redaction authority', () => {
        const ownedCredential = 'external provider credential with spaces !';
        const unrelatedCredential = 'external unrelated credential with spaces !';
        const providerRequirements = {
            acceptsProtocols: ['openai-responses'],
            required: { streaming: true },
            credentialSupport: {
                supportsNoAuth: true,
                apiKeyTransports: [],
            },
            authIsolation: {
                suppressConnectedServiceIds: [],
                ownedEnvKeys: ['EXTERNAL_PROVIDER_TOKEN'],
            },
            materialization: 'spawnEnv',
            applyPolicy: 'restart_session',
            supportsFreeformModelIds: true,
        };
        const lease = beginSessionLaunchSecretRedaction({
            agentId: 'external-agent',
            providerBindingActive: true,
            providerRequirements,
            environment: {
                EXTERNAL_PROVIDER_TOKEN: ownedCredential,
                UNRELATED_SECRET: unrelatedCredential,
            },
        });
        try {
            expect(redactBugReportSensitiveText(ownedCredential))
                .toBe('[REDACTED]');
            expect(redactBugReportSensitiveText(unrelatedCredential))
                .toBe(unrelatedCredential);
        } finally {
            lease.close();
        }
    });

    it('fails closed for an explicitly missing or invalid declaration instead of using the built-in fallback', () => {
        expect(() => beginSessionLaunchSecretRedaction({
            agentId: 'claude',
            providerBindingActive: true,
            providerRequirements: undefined,
        })).toThrow(
            "Agent 'claude' has no valid static provider support for runtime redaction",
        );
        expect(() => beginSessionLaunchSecretRedaction({
            agentId: 'claude',
            providerBindingActive: true,
            providerRequirements: { authIsolation: {} },
        })).toThrow(
            "Agent 'claude' has no valid static provider support for runtime redaction",
        );
    });

    it('registers only the selected agent contribution owned environment values for the runtime lifetime', () => {
        const ownedCredential = 'claude provider credential with spaces !';
        const unrelatedCredential = 'unrelated credential with spaces !';
        const lease = beginSessionLaunchSecretRedaction({
            agentId: 'claude',
            providerBindingActive: true,
            environment: {
                ANTHROPIC_API_KEY: ownedCredential,
                UNRELATED_SECRET: unrelatedCredential,
            },
        });
        try {
            expect(redactBugReportSensitiveText(`owned=${ownedCredential}`)).toBe('owned=[REDACTED]');
            expect(redactBugReportSensitiveText(`other=${unrelatedCredential}`)).toBe(`other=${unrelatedCredential}`);
        } finally {
            lease.close();
        }
        expect(redactBugReportSensitiveText(`owned=${ownedCredential}`)).toBe(`owned=${ownedCredential}`);
    });

    it('does not register child environment values for a native launch', () => {
        const value = 'native env value with spaces !';
        const lease = beginSessionLaunchSecretRedaction({
            agentId: 'claude',
            providerBindingActive: false,
            environment: { ANTHROPIC_API_KEY: value },
        });

        try {
            expect(redactBugReportSensitiveText(value)).toBe(value);
        } finally {
            lease.close();
        }
    });
    it('keeps a Connected Account credential materialized for a Claude binding out of a transcript line that echoes it', () => {
        const credential = 'dummy-claude-oauth-credential-for-test';
        const lease = beginSessionLaunchSecretRedaction({
            agentId: 'claude',
            providerBindingActive: true,
            environment: { ANTHROPIC_OAUTH_TOKEN: credential },
        });
        const line = { type: 'tool-result', output: `ANTHROPIC_OAUTH_TOKEN=${credential}\ncontrol-ok` };
        try {
            expect(redactTranscriptSecrets(line))
                .toEqual({ type: 'tool-result', output: 'ANTHROPIC_OAUTH_TOKEN=[redacted]\ncontrol-ok' });
        } finally {
            lease.close();
        }
        expect(redactTranscriptSecrets(line)).toBe(line);
    });

    it('keeps a Profile saved-secret env value carried with the Session launch out of the transcript, with or without a Provider binding', () => {
        const savedSecret = 'dummy-profile-saved-secret-for-test';
        const lease = beginSessionLaunchSecretRedaction({
            agentId: 'claude',
            providerBindingActive: false,
            launchSecretValues: [savedSecret],
        });
        const line = { text: `printenv PROFILE_TOKEN -> ${savedSecret}` };
        try {
            expect(redactTranscriptSecrets(line)).toEqual({ text: 'printenv PROFILE_TOKEN -> [redacted]' });
            expect(redactBugReportSensitiveText(savedSecret)).toBe('[REDACTED]');
        } finally {
            lease.close();
        }
        expect(redactTranscriptSecrets(line)).toBe(line);
    });
});
