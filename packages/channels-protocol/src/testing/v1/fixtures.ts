import {
    ConversationProviderSetupResultV1Schema,
    type ConversationProviderSetupResultV1,
} from '../../v1/provider/setup.js';

/**
 * Creates a valid, non-durable Channels provider setup result for public
 * protocol consumers. Provider execution, Action bindings, and endpoint setup
 * stay outside this test-only fixture.
 */
export function createConversationProviderSetupResultV1Fixture(
    overrides: Partial<ConversationProviderSetupResultV1> = {},
): ConversationProviderSetupResultV1 {
    return ConversationProviderSetupResultV1Schema.parse({
        v: 1,
        credentialRef: null,
        providerConnectionKey: 'fixture:provider',
        providerConfigVersion: 1,
        providerConfig: {},
        integrationPrincipal: { id: 'fixture:integration', label: 'Fixture integration' },
        supportedTransports: ['checkpointedPull'],
        recommendedTransport: 'checkpointedPull',
        overlapSafety: 'safe',
        replayContinuity: 'checkpointed',
        outboundTextLimit: { maximum: 4_000, unit: 'unicodeCodePoints' },
        ...overrides,
    });
}
