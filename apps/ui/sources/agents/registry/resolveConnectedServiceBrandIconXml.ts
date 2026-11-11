import type { Theme } from '@/theme';
import {
    BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID,
    type BuiltInLegacyConnectedAccountCompatibility,
} from '@happier-dev/protocol/connect/generatedBuiltInLegacyConnectedAccountCompatibility';
import { buildQualifiedPluginContributionKey, type PluginContributionIdentityV1 } from '@happier-dev/protocol/plugins/contribution-identity';

import { CONNECTED_SERVICE_LOGO_SVG_XML } from './agentLogoSvgXml';

const legacyServiceIdentities: Readonly<Record<string, BuiltInLegacyConnectedAccountCompatibility | undefined>> =
    BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID;

/** A qualified service owns its mark; released aliases translate to that same identity. */
export function resolveConnectedServiceBrandIconXml(
    serviceId: PluginContributionIdentityV1 | string | null | undefined,
    theme: Theme,
): string | null {
    const normalized = typeof serviceId === 'string' ? serviceId.trim().toLowerCase() : '';
    const service = typeof serviceId === 'object' && serviceId !== null
        ? serviceId
        : legacyServiceIdentities[normalized]?.service;
    if (!service) return null;
    return CONNECTED_SERVICE_LOGO_SVG_XML[buildQualifiedPluginContributionKey(service)]?.(theme) ?? null;
}
