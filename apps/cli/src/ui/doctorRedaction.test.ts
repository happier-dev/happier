import { describe, expect, it } from 'vitest';

import { redactDoctorDiagnosticValue } from './doctorRedaction';

describe('doctor diagnostic redaction', () => {
    it('uses the credential classifier without suppressing count and prose fields', () => {
        expect(redactDoctorDiagnosticValue({
            accessToken: 'doctor-access-secret',
            sessionId: 'doctor-session-secret',
            sessionCount: 3,
            tokenCount: 4,
            secretary: 'meeting-notes',
        })).toEqual({
            accessToken: '<redacted>',
            sessionId: '<redacted>',
            sessionCount: 3,
            tokenCount: 4,
            secretary: 'meeting-notes',
        });
    });
});
