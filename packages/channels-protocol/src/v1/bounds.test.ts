import { describe, expect, it } from 'vitest';

import * as bounds from './bounds.js';

describe('Channels V1 bounds', () => {
    it('exports the canonical bounded vocabulary without reviving provider Action conventions', () => {
        expect(bounds.CONVERSATION_PROVIDERS_CONTRIBUTION_POINT_ID_V1).toBe('providers');
        expect(bounds.CONVERSATION_PROVIDERS_CONTRIBUTION_PROTOCOL_ID_V1).toBe('happier.channels/providers');
        expect(bounds.CONVERSATION_PROVIDERS_CONTRIBUTION_PROTOCOL_VERSION_V1).toBe(1);
        expect(bounds.CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionPollRetry).toBe('connection/poll-retry-v1');
        expect(bounds.CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingRead).toBe('binding/read-v1');
        expect(bounds.MAX_CONVERSATION_CONNECTIONS_PER_ACCOUNT).toBe(32);
        expect(bounds.MAX_CONVERSATION_BINDINGS_PER_ACCOUNT).toBe(256);
        expect(bounds.MAX_CONVERSATION_PROVIDER_CONFIG_UTF8_BYTES).toBe(48 * 1024);
        expect(bounds.CONVERSATION_TRANSPORT_KINDS_V1).toEqual([
            'checkpointedPull',
            'socket',
            'durablePush',
        ]);
        expect(bounds).not.toHaveProperty('CONVERSATION_PROVIDER_ACTION_IDS_V1');
    });
});
