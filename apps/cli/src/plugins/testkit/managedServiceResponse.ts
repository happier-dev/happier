import { Buffer } from 'node:buffer';
import type { ManagedServiceResponse } from '@happier-dev/plugin-sdk/managed-services';

/** Consume the portable managed-service reader without assuming a DOM stream. */
export async function readManagedServiceResponseText(response: ManagedServiceResponse): Promise<string> {
    if (!response.body) return '';
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    try {
        while (true) {
            const result = await reader.read();
            if (result.done) break;
            chunks.push(result.value);
        }
    } finally {
        reader.releaseLock();
    }
    return Buffer.concat(chunks).toString('utf8');
}

export async function readManagedServiceResponseJson(response: ManagedServiceResponse): Promise<unknown> {
    return JSON.parse(await readManagedServiceResponseText(response));
}
