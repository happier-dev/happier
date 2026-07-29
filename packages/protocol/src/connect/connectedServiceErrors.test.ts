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

    it('parses reconnect and auth-group failure codes', () => {
        expect(ConnectedServiceErrorCodeSchema.parse('connect_reconnect_required')).toBe('connect_reconnect_required');
        expect(ConnectedServiceErrorCodeSchema.parse('connect_reconnect_provider_identity_mismatch')).toBe(
            'connect_reconnect_provider_identity_mismatch',
        );
        expect(ConnectedServiceErrorCodeSchema.parse('connect_group_not_found')).toBe('connect_group_not_found');
        expect(ConnectedServiceErrorCodeSchema.parse('connect_group_generation_conflict')).toBe(
            'connect_group_generation_conflict',
        );
        expect(ConnectedServiceErrorCodeSchema.parse('connect_credential_mutation_superseded')).toBe(
            'connect_credential_mutation_superseded',
        );
    });
});
