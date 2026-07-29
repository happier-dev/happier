import { describe, expect, it } from 'vitest';
import { registerSensitiveDiagnosticValues } from '@happier-dev/protocol';

import { sanitizeRpcDiagnosticValue } from './sanitize';

describe('sanitizeRpcDiagnosticValue', () => {
    it('applies the active child-runtime exact-value lease to nested plugin exec diagnostics', () => {
        const credential = 'nested exec provider credential with spaces !';
        const lease = registerSensitiveDiagnosticValues([credential]);
        try {
            expect(sanitizeRpcDiagnosticValue({
                error: {
                    stderr: `provider rejected ${credential}`,
                },
            })).toEqual({
                error: {
                    stderr: 'provider rejected [REDACTED]',
                },
            });
        } finally {
            lease.close();
        }
    });
});
