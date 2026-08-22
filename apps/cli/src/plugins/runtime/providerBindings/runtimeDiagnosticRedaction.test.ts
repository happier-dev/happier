import { describe, expect, it } from 'vitest';
import { redactBugReportSensitiveText } from '@happier-dev/protocol';

import { beginProviderBindingRuntimeDiagnosticRedaction } from './runtimeDiagnosticRedaction';

describe('beginProviderBindingRuntimeDiagnosticRedaction', () => {
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
        const lease = beginProviderBindingRuntimeDiagnosticRedaction({
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
        expect(() => beginProviderBindingRuntimeDiagnosticRedaction({
            agentId: 'claude',
            providerBindingActive: true,
            providerRequirements: undefined,
        })).toThrow(
            "Agent 'claude' has no valid static provider support for runtime redaction",
        );
        expect(() => beginProviderBindingRuntimeDiagnosticRedaction({
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
        const lease = beginProviderBindingRuntimeDiagnosticRedaction({
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
        const lease = beginProviderBindingRuntimeDiagnosticRedaction({
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
});
