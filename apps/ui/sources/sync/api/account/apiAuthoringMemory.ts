import {
    AUTHORING_MEMORY_ROUTE_V1,
    AuthoringMemoryListResponseV1Schema,
    AuthoringMemoryReadResponseV1Schema,
    AuthoringMemoryMutationResponseV1Schema,
    AuthoringMemoryMutationRequestV1Schema,
} from '@happier-dev/protocol/account/authoringMemory';
import type { AuthoringMemoryTransport } from '@/sync/engine/authoringMemory/authoringMemorySync';

/** Reuses the reserved Account-row route shape with an exact Home/Account request. */
export function createApiAuthoringMemoryTransport(options: Readonly<{
    request(path: string, init?: RequestInit): Promise<Response>;
}>): AuthoringMemoryTransport {
    async function request(path: string, init?: RequestInit): Promise<unknown> {
        const response = await options.request(path, init);
        // CAS conflicts are typed successful domain outcomes, not transport retries.
        if (!response.ok && response.status !== 409) throw new Error(`Authoring memory request failed (${response.status})`);
        return await response.json();
    }
    const path = (key: string) => `${AUTHORING_MEMORY_ROUTE_V1}/${encodeURIComponent(key)}`;
    return {
        list: async () => AuthoringMemoryListResponseV1Schema.parse(await request(AUTHORING_MEMORY_ROUTE_V1)),
        read: async (key) => AuthoringMemoryReadResponseV1Schema.parse(await request(path(key))),
        mutate: async (key, expectedRevision, content) => AuthoringMemoryMutationResponseV1Schema.parse(await request(path(key), {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(AuthoringMemoryMutationRequestV1Schema.parse({ expectedRevision, content })),
        })),
    };
}
