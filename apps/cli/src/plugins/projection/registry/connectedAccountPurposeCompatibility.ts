import {
    BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID,
    ConnectedServiceIdSchema,
    parseQualifiedPluginContributionKey,
    readBuiltInLegacyConnectedServiceIdForQualifiedService,
    type ConnectedServiceId,
    type QualifiedConnectedAccountRef,
} from '@happier-dev/protocol';
import {
    isBuiltInLegacyConnectedAccountPeerOperationSupported,
} from '@/api/client/qualifiedConnectedAccountApi';

function matchesService(
    left: QualifiedConnectedAccountRef['service'],
    right: QualifiedConnectedAccountRef['service'],
): boolean {
    return left.pluginId === right.pluginId && left.localId === right.localId;
}

/**
 * V2 runtime reports name only the legacy scalar service. Translate that ingress
 * to the canonical V4 identity before selecting a V4-owned group operation.
 */
export function resolveFirstPartyQualifiedConnectedAccountServiceForLegacyServiceId(
    serviceId: ConnectedServiceId,
): QualifiedConnectedAccountRef['service'] | null {
    const compatibility = Object.entries(
        BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID,
    ).find(([legacyServiceId]) => legacyServiceId === serviceId)?.[1];
    return compatibility?.service ?? null;
}

/**
 * Scalar service identifiers are a released ingress shape. Parse them before
 * projecting to the generated qualified owner; malformed and non-first-party
 * inputs deliberately have no qualified-group authority.
 */
export function resolveFirstPartyQualifiedConnectedAccountServiceForLegacyServiceInput(
    serviceId: unknown,
): QualifiedConnectedAccountRef['service'] | null {
    const parsed = ConnectedServiceIdSchema.safeParse(serviceId);
    return parsed.success
        ? resolveFirstPartyQualifiedConnectedAccountServiceForLegacyServiceId(
            parsed.data,
        )
        : null;
}

/**
 * Sole service-identity ingress translation for consumers that need the V4
 * qualified service ref from either released scalar ids or canonical qualified
 * keys. Qualified keys project directly; released bundled scalars project
 * through the generated compatibility owner; anything else has no group
 * authority.
 */
export function resolveQualifiedConnectedAccountServiceForIngressServiceId(
    serviceId: unknown,
): QualifiedConnectedAccountRef['service'] | null {
    if (typeof serviceId === 'string' && serviceId.includes('/')) {
        const parsed = parseQualifiedPluginContributionKey(serviceId.trim());
        return parsed
            ? { pluginId: parsed.pluginId, localId: parsed.localId }
            : null;
    }
    return resolveFirstPartyQualifiedConnectedAccountServiceForLegacyServiceInput(serviceId);
}

/**
 * Bounded reverse seam for inputs that still consume the released V2/V3 scalar
 * service id (sealed credential resolution and the scalar-session materialization
 * identity). Only first-party bundled services have a scalar identity; novel
 * external qualified services deliberately resolve to null and their consumers
 * must use the qualified owner (V4 API or contribution-keyed runtime) instead.
 */
export function resolveFirstPartyLegacyConnectedServiceIdForQualifiedServiceKey(
    serviceKey: unknown,
): ConnectedServiceId | null {
    const service = parseQualifiedPluginContributionKey(serviceKey);
    return service
        ? readBuiltInLegacyConnectedServiceIdForQualifiedService(service)
        : null;
}

/**
 * Sole closed-enum launch-ingress resolver. Eligibility is generated from the first-party
 * manifests and immutable peer evidence; SCM-only identities are deliberately excluded.
 */
export function resolveFirstPartyLegacyAgentConnectedAccountServiceId(
    service: QualifiedConnectedAccountRef['service'],
): ConnectedServiceId | null {
    for (const [legacyServiceId, compatibility] of Object.entries(
        BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID,
    )) {
        if (
            isBuiltInLegacyConnectedAccountPeerOperationSupported({
                serviceId: legacyServiceId,
                peerClass: 'exact_v0_2_1',
                operation: 'one_shot_materialization',
            })
            && matchesService(compatibility.service, service)
        ) {
            return legacyServiceId as ConnectedServiceId;
        }
    }
    return null;
}

export function resolveFirstPartyLegacyRequestAuthServiceId(
    service: QualifiedConnectedAccountRef['service'],
): ConnectedServiceId | null {
    for (const [legacyServiceId, compatibility] of Object.entries(
        BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID,
    )) {
        if (
            isBuiltInLegacyConnectedAccountPeerOperationSupported({
                serviceId: legacyServiceId,
                peerClass: 'revisioned_v2_v3',
                operation: 'request_auth',
            })
            && matchesService(compatibility.service, service)
        ) {
            return legacyServiceId as ConnectedServiceId;
        }
    }
    return null;
}
