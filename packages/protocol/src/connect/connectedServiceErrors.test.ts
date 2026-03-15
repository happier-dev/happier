import { describe, expect, it } from 'vitest';

import { ConnectedServiceErrorCodeSchema } from './connectedServiceErrors.js';

describe('connectedServiceErrors', () => {
    it('parses connect_oauth_exchange_failed', () => {
        expect(ConnectedServiceErrorCodeSchema.parse('connect_oauth_exchange_failed')).toBe('connect_oauth_exchange_failed');
    });

    it('parses specific oauth exchange failure codes', () => {
        expect(ConnectedServiceErrorCodeSchema.parse('connect_oauth_invalid_grant')).toBe('connect_oauth_invalid_grant');
        expect(ConnectedServiceErrorCodeSchema.parse('connect_oauth_invalid_client')).toBe('connect_oauth_invalid_client');
        expect(ConnectedServiceErrorCodeSchema.parse('connect_oauth_missing_refresh_token')).toBe(
            'connect_oauth_missing_refresh_token',
        );
    });
});
