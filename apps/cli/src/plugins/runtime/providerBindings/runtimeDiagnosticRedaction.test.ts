import { describe, expect, it } from 'vitest';
import { redactBugReportSensitiveText } from '@happier-dev/protocol';

import { redactTranscriptSecrets } from '@/api/session/client/transport/transcriptSecretRedaction';
import { runAddedHostedSession } from '@/agent/runtime/lifecycle/hostedSessionScope';

import { beginSessionLaunchSecretRedaction } from './runtimeDiagnosticRedaction';

/** Run work as one Session hosted in this process (a session host runs several Accounts' Sessions). */
function inHostedSession<T>(account: string, run: () => T): T {
    return runAddedHostedSession({ environment: { HAPPIER_TEST_ACCOUNT: account }, workingDirectory: `/tmp/${account}`,
        end: () => {} }, run);
}

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
    it('keeps a Connected Account credential materialized for a Claude binding out of a transcript line that echoes it', () => inHostedSession('owner', () => {
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
    }));

    it('keeps a Profile saved-secret env value carried with the Session launch out of the transcript, with or without a Provider binding', () => inHostedSession('owner', () => {
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
    }));

    it("keeps one hosted Session's launch secret out of another Session's transcript in the same host", async () => {
        const secretA = 'dummy-account-a-launch-secret';
        const secretB = 'dummy-account-b-launch-secret';
        let releaseA: (() => void) | undefined;
        let markARegistered!: () => void;
        const aRegistered = new Promise<void>(resolve => { markARegistered = resolve; });
        const [a, b] = await Promise.all([
            inHostedSession('account-a', async () => {
                releaseA = beginSessionLaunchSecretRedaction({ agentId: 'claude', providerBindingActive: false,
                    launchSecretValues: [secretA] }).close;
                markARegistered();
                await new Promise(resolve => setTimeout(resolve, 1));
                return redactTranscriptSecrets({ text: `${secretA} ${secretB}` });
            }),
            inHostedSession('account-b', async () => {
                await aRegistered;
                const lease = beginSessionLaunchSecretRedaction({ agentId: 'claude', providerBindingActive: false,
                    launchSecretValues: [secretB] });
                try {
                    return redactTranscriptSecrets({ text: `${secretA} ${secretB}` });
                } finally {
                    lease.close();
                }
            }),
        ]);
        releaseA?.();
        // A's value neither masks B's text nor reveals itself to B, and the reverse.
        expect(a).toEqual({ text: `[redacted] ${secretB}` });
        expect(b).toEqual({ text: `${secretA} [redacted]` });
    });

    it('never puts a Session launch secret in the process set when it runs outside its hosted Session', async () => {
        const secret = 'dummy-launch-secret-outside-session';
        // A registration from a context that lost its Session scope must not mask every Session.
        const lease = beginSessionLaunchSecretRedaction({ agentId: 'claude', providerBindingActive: false,
            launchSecretValues: [secret] });
        try {
            expect(inHostedSession('other-account', () => redactTranscriptSecrets({ text: secret })))
                .toEqual({ text: secret });
            expect(redactBugReportSensitiveText(secret)).toBe('[REDACTED]');
        } finally {
            lease.close();
        }
    });
});
