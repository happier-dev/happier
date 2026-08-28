import { describe, expect, it } from 'vitest';

import * as bounds from './bounds.js';

describe('Channels V1 bounds', () => {
    it('exports the canonical bounded vocabulary without reviving provider Action conventions', () => {
        expect(bounds.CONVERSATION_PROVIDERS_CONTRIBUTION_POINT_ID_V1).toBe('providers');
        expect(bounds.CONVERSATION_PROVIDERS_CONTRIBUTION_PROTOCOL_ID_V1).toBe('happier.channels/providers');
        expect(bounds.CONVERSATION_PROVIDERS_CONTRIBUTION_PROTOCOL_VERSION_V1).toBe(1);
        expect(bounds.CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionPollRetry).toBe('connection/poll-retry-v1');
        expect(bounds.CONVERSATION_MANAGEMENT_ACTION_IDS_V1.sessionProjectionBaselineAccept)
            .toBe('binding/session-projection-baseline-accept-v1');
        expect(bounds.CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingRead).toBe('binding/read-v1');
        expect(bounds.CONVERSATION_MANAGEMENT_ACTION_IDS_V1).not.toHaveProperty('connectionSetEnabled');
        expect(bounds.CONVERSATION_MANAGEMENT_ACTION_IDS_V1).not.toHaveProperty('bindingTargetRotate');
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

    it('anchors the create-time observation age to the flagship provider retention ceiling', () => {
        // Telegram Bot API, "Getting updates": "Incoming updates are stored on
        // the server until the bot receives them either way, but they will not
        // be kept longer than 24 hours." For the flagship V1 provider the
        // default is exactly the provider's own ceiling, so it is pinned to 24
        // hours here rather than restated from the source literal or allowed to
        // follow MAX_CONVERSATION_RETRY_AFTER_MS, which merely coincides today.
        expect(bounds.CONVERSATION_OBSERVATION_AGE_MS_FOR_OMITTED_FIELD_V1).toBe(24 * 60 * 60 * 1000);
    });

    it('keeps the create-time observation age long enough to survive the longest provider-requested poll backoff', () => {
        // A provider may hold the poller off for up to
        // MAX_CONVERSATION_RETRY_AFTER_MS through its retry hint. A freshness
        // window shorter than that discards every observation that arrived
        // while the host was obeying the provider, so the create-time default
        // has to clear that backoff ceiling as well as the flagship retention
        // anchoring above. The two constraints are independent: this one fails
        // loudly if the retry-hint ceiling is ever raised past the anchoring.
        expect(bounds.CONVERSATION_OBSERVATION_AGE_MS_FOR_OMITTED_FIELD_V1)
            .toBeGreaterThanOrEqual(bounds.MAX_CONVERSATION_RETRY_AFTER_MS);
        expect(bounds.CONVERSATION_OBSERVATION_AGE_MS_FOR_OMITTED_FIELD_V1)
            .toBeGreaterThan(bounds.MIN_CONVERSATION_OBSERVATION_AGE_MS);
        expect(bounds.CONVERSATION_OBSERVATION_AGE_MS_FOR_OMITTED_FIELD_V1)
            .toBeLessThanOrEqual(bounds.MAX_CONVERSATION_OBSERVATION_AGE_MS);
    });
});
