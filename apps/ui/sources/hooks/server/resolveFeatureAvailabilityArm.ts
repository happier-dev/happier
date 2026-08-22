import type { FeatureDecision } from '@happier-dev/protocol';

/**
 * The one classification of a {@link FeatureDecision} into the arms a product
 * surface can present.
 *
 * `checking` and `unknown` are deliberately separate from every "not available"
 * arm: an unresolved or probe-failed decision is an absence of knowledge, and a
 * surface must never render it as a confirmed statement about the server. Copy
 * stays with each surface; the classification does not.
 */
export type FeatureAvailabilityArm =
    | 'checking'
    | 'available'
    | 'unknown'
    | 'unsupported_context'
    | 'unsupported'
    | 'server_disabled'
    | 'policy_disabled';

export function resolveFeatureAvailabilityArm(
    decision: FeatureDecision | null,
): FeatureAvailabilityArm {
    if (!decision) return 'checking';
    if (decision.state === 'enabled') return 'available';
    if (decision.state === 'unknown') return 'unknown';
    if (decision.state === 'unsupported') {
        return decision.blockedBy === 'server' && decision.blockerCode === 'endpoint_missing'
            ? 'unsupported'
            : 'unsupported_context';
    }
    return decision.blockedBy === 'server' ? 'server_disabled' : 'policy_disabled';
}
