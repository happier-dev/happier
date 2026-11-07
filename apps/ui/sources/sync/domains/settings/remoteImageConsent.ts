import { z } from 'zod/mini';

export type RemoteImageConsentV1 = readonly (readonly [workspaceCacheKey: string, filePath: string])[];

export const RemoteImageConsentV1Schema = z.catch(z.pipe(z.array(z.unknown()), z.transform(values => {
    const entries: [string, string][] = [];
    const seen = new Set<string>();
    for (const value of values) {
        if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== 'string' || !value[0]
            || typeof value[1] !== 'string' || !value[1]) continue;
        const key = JSON.stringify(value);
        if (seen.has(key)) continue;
        seen.add(key);
        entries.push([value[0], value[1]]);
    }
    return entries;
})), []);

export function hasRemoteImageConsent(consent: RemoteImageConsentV1, workspaceCacheKey: string, filePath: string): boolean {
    return consent.some(([workspace, file]) => workspace === workspaceCacheKey && file === filePath);
}
