import { computeCanonicalDomainSeparatedDigest } from '@happier-dev/plugin-sdk';
import type { ObservedDatabaseEndpoint } from '../otlp/types.js';

/** A collector keeps the exporter endpoint out of retained and public capture details. */
export function databaseEndpointKey(endpoint: ObservedDatabaseEndpoint): string {
    return computeCanonicalDomainSeparatedDigest('happier.telemetry.database-endpoint.v1', [
        endpoint.engine, endpoint.hostname.toLowerCase().replace(/^\[|\]$/g, ''), String(endpoint.port), endpoint.database,
    ]);
}
