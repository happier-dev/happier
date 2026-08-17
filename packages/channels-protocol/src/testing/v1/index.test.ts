import { describe, expect, it } from 'vitest';

import { ConversationProviderSetupResultV1Schema } from '../../v1/provider/setup.js';
import { createConversationProviderSetupResultV1Fixture } from './index.js';

describe('Channels V1 testing setup fixture', () => {
    it('produces only a valid public setup result and preserves explicit safe overrides', () => {
        const fixture = createConversationProviderSetupResultV1Fixture({
            providerConfig: { installation: 'fixture-installation' },
            outboundTextLimit: { maximum: 2_000, unit: 'utf8Bytes' },
        });

        expect(ConversationProviderSetupResultV1Schema.parse(fixture)).toEqual(fixture);
        expect(fixture).toMatchObject({
            v: 1,
            credentialRef: null,
            providerConnectionKey: 'fixture:provider',
            supportedTransports: ['checkpointedPull'],
            recommendedTransport: 'checkpointedPull',
            providerConfig: { installation: 'fixture-installation' },
            outboundTextLimit: { maximum: 2_000, unit: 'utf8Bytes' },
        });
        expect(fixture).not.toHaveProperty('webhookEndpointSetup');
    });

    it('keeps structurally valid durable-push facts available for setup admission to validate', () => {
        const fixture = createConversationProviderSetupResultV1Fixture({
            supportedTransports: ['durablePush'],
        });

        expect(ConversationProviderSetupResultV1Schema.parse(fixture)).toEqual(fixture);
        expect(fixture).not.toHaveProperty('webhookContributionRef');
    });
});
