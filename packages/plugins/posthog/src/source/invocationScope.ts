/**
 * Pure recovery of the source-private routing facts carried by a configured instance.
 *
 * The target persists the configuration token opaquely. This is the one PostHog owner
 * that may decode it with the local instance key, so every call path validates the same
 * deployment, organization, and selected-environment facts before it can make a request.
 */

import {
    normalizePosthogApiOrigin,
    type PosthogApiOrigin,
} from '../connect/origin.js';
import {
    parsePosthogLocalInstanceKey,
} from './identity.js';
import {
    decodePosthogConfiguration,
    type PosthogConfigurationToken,
} from './instance.js';

export type PosthogInvocationScopeFailure =
    | 'instanceKeyUnreadable'
    | 'originInvalid'
    | 'configurationUndecodable'
    | 'instanceScopeMismatch';

export type PosthogInvocationScope =
    | Readonly<{
        ok: true;
        origin: PosthogApiOrigin;
        organizationUuid: string;
        configuration: PosthogConfigurationToken;
    }>
    | Readonly<{ ok: false; reason: PosthogInvocationScopeFailure }>;

export function resolvePosthogInvocationScope(
    instance: Readonly<{
        localInstanceKey: string;
        configuration: Readonly<{ v: 1; token: string }>;
    }>,
): PosthogInvocationScope {
    const key = parsePosthogLocalInstanceKey(instance.localInstanceKey);
    if (key === null) {
        return Object.freeze({ ok: false as const, reason: 'instanceKeyUnreadable' as const });
    }
    const origin = normalizePosthogApiOrigin(key.origin);
    if (!origin.ok) {
        return Object.freeze({ ok: false as const, reason: 'originInvalid' as const });
    }
    const configuration = decodePosthogConfiguration(instance.configuration);
    if (configuration === null) {
        return Object.freeze({ ok: false as const, reason: 'configurationUndecodable' as const });
    }
    if (configuration.organizationUuid !== key.organizationUuid) {
        return Object.freeze({ ok: false as const, reason: 'instanceScopeMismatch' as const });
    }
    return Object.freeze({
        ok: true as const,
        origin: origin.origin,
        organizationUuid: key.organizationUuid,
        configuration,
    });
}
