import { describe, expect, it } from 'vitest';

import { ConnectedServiceErrorCodeSchema } from './connectedServiceErrors.js';

describe('connectedServiceErrors', () => {
    it('parses connect_oauth_exchange_failed', () => {
        expect(ConnectedServiceErrorCodeSchema.parse('connect_oauth_exchange_failed')).toBe('connect_oauth_exchange_failed');
    });
});

