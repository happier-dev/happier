import {
    SERVER_CONFIG_REGISTRY_BASE,
    composeServerConfigRegistry,
    type ServerConfigEntry,
    type ServerConfigRegistry,
} from '@happier-dev/protocol';

import { API_RATE_LIMIT_GLOBAL_SERVER_CONFIG, API_ROUTE_RATE_LIMIT_SERVER_CONFIG } from '@/app/api/utils/apiRateLimitDefaults';
import { FEATURE_SERVER_CONFIG } from '@/app/features/catalog/featureServerConfig';
import { RETENTION_DOMAIN_SERVER_CONFIG, RETENTION_SERVER_CONFIG } from '@/app/retention/config/retentionServerConfig';
import { USAGE_PRICE_SERVER_CONFIG } from '@/app/usage/usagePriceServerConfig';

type ServerConfigFamily = ServerConfigRegistry | readonly ServerConfigEntry[];

/**
 * Joins the protocol's hand-written entries with the families declared by their server owners
 * (feature keys, API rate limits, retention) into the one server configuration registry.
 * A key declared by two owners throws here, at module load.
 */
export function registerServerConfigFamilies(families: Readonly<{
    features: ServerConfigFamily;
    rateLimits: readonly ServerConfigFamily[];
    retention: readonly ServerConfigFamily[];
    usage?: ServerConfigFamily;
}>): ServerConfigRegistry {
    return composeServerConfigRegistry(
        SERVER_CONFIG_REGISTRY_BASE,
        families.features,
        ...families.rateLimits,
        ...families.retention,
        ...(families.usage ? [families.usage] : []),
    );
}

/** Every configuration key the server reads (plan §3.14, invariant I8). */
export const SERVER_CONFIG_REGISTRY: ServerConfigRegistry = registerServerConfigFamilies({
    features: FEATURE_SERVER_CONFIG,
    rateLimits: [API_RATE_LIMIT_GLOBAL_SERVER_CONFIG, API_ROUTE_RATE_LIMIT_SERVER_CONFIG],
    retention: [RETENTION_SERVER_CONFIG, RETENTION_DOMAIN_SERVER_CONFIG],
    usage: USAGE_PRICE_SERVER_CONFIG,
});
