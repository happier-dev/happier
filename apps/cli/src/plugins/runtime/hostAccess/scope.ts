import { createHash } from 'node:crypto';

import type { PluginHostAccessRequestV2 } from '@happier-dev/protocol';

function stable(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.entries(value as Readonly<Record<string, unknown>>)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, entry]) => `${JSON.stringify(key)}:${stable(entry)}`)
            .join(',')}}`;
    }
    return JSON.stringify(value) ?? 'undefined';
}

export function fingerprintPluginHostAccessRequest(request: PluginHostAccessRequestV2): string {
    const canonicalRequest = request.capability === 'connectedAccounts'
        && request.scope.materializationKinds !== undefined
        ? {
            ...request,
            scope: {
                ...request.scope,
                materializationKinds: [...request.scope.materializationKinds].sort(),
            },
        }
        : request;
    return createHash('sha256').update(stable(canonicalRequest)).digest('hex');
}

export function matchesPluginHostAccessGrant(
    granted: PluginHostAccessRequestV2,
    requested: PluginHostAccessRequestV2,
): boolean {
    return fingerprintPluginHostAccessRequest(granted) === fingerprintPluginHostAccessRequest(requested);
}
