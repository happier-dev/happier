import { describe, expect, it } from 'vitest';
import { redactBugReportSensitiveText } from '@happier-dev/protocol';

import { beginProviderBindingRuntimeDiagnosticRedaction } from './runtimeDiagnosticRedaction';

describe('beginProviderBindingRuntimeDiagnosticRedaction', () => {
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
