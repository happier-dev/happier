import { describe, expect, it } from 'vitest';

import { classifyConnectedServiceSensitiveDiagnosticKey } from './sensitiveConnectedServiceDiagnosticFields';

describe('Connected Account diagnostic-key redaction', () => {
    it('shares the base credential family without treating counts and prose as credentials', () => {
        for (const key of [
            'authorization',
            'accessToken',
            'refresh_token',
            'apiKey',
            'clientSecret',
            'password',
            'cookie',
            'jwt',
            'privateKey',
            'passphrase',
        ]) {
            expect(classifyConnectedServiceSensitiveDiagnosticKey(key)).toBe('secret');
        }

        expect(classifyConnectedServiceSensitiveDiagnosticKey('sessionCount')).toBeNull();
        expect(classifyConnectedServiceSensitiveDiagnosticKey('tokenCount')).toBeNull();
        expect(classifyConnectedServiceSensitiveDiagnosticKey('secretary')).toBeNull();
    });
});
