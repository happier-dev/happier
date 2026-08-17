import {
    StoredJsonContentEnvelopeSchema,
    type StoredJsonContentEnvelope,
} from '@happier-dev/protocol';

import { decodeBase64, encodeBase64 } from '@/encryption/base64';

export function encodeBase64StoredJsonContentEnvelope(envelope: StoredJsonContentEnvelope): string {
    return encodeBase64(new TextEncoder().encode(JSON.stringify(envelope)), 'base64');
}

export function decodeBase64StoredJsonContentEnvelope(
    encoded: string,
): StoredJsonContentEnvelope | null {
    try {
        const json = new TextDecoder().decode(decodeBase64(encoded, 'base64'));
        const parsed = StoredJsonContentEnvelopeSchema.safeParse(JSON.parse(json));
        return parsed.success ? parsed.data : null;
    } catch {
        return null;
    }
}
