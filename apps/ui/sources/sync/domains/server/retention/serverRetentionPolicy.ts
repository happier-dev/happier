import type { FeaturesResponse } from '@happier-dev/protocol';

import { SERVER_RETENTION_DOMAIN_METADATA } from './serverRetentionDomainMetadata';

export type ServerRetentionPolicy = NonNullable<FeaturesResponse['capabilities']['server']['retention']>;

export function readServerRetentionPolicy(features: FeaturesResponse): ServerRetentionPolicy | null {
    const retention = features.capabilities.server.retention;
    return retention ?? null;
}

export function hasFiniteRetentionPolicy(policy: ServerRetentionPolicy | null | undefined): boolean {
    if (!policy) return false;
    if (!policy.enabled) return false;
    return SERVER_RETENTION_DOMAIN_METADATA.some(({ key }) => {
        const domainPolicy = policy[key];
        return domainPolicy !== undefined && domainPolicy.mode !== 'keep_forever';
    });
}
