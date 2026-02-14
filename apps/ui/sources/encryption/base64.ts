import { decodeBase64 as decodeBase64Protocol, encodeBase64 as encodeBase64Protocol } from '@happier-dev/protocol';

export function decodeBase64(base64: string, encoding: 'base64' | 'base64url' = 'base64'): Uint8Array {
    return decodeBase64Protocol(base64, encoding);
}

export function encodeBase64(buffer: Uint8Array, encoding: 'base64' | 'base64url' = 'base64'): string {
    return encodeBase64Protocol(buffer, encoding);
}
