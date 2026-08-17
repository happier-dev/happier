import {
    checkConversationProviderContributionV1,
    type ConversationProviderContributionConformanceV1,
} from './conformance.js';

/**
 * Asserts that one external provider manifest declares a complete Channels V1
 * provider contribution before it reaches host admission.
 */
export function assertConversationProviderContributionV1(
    manifest: unknown,
): ConversationProviderContributionConformanceV1 {
    const result = checkConversationProviderContributionV1(manifest);
    if (!result.ok) {
        throw new TypeError(`Channels V1 provider contribution is not conformant: ${result.errors.join(' ')}`);
    }
    return result.value;
}
