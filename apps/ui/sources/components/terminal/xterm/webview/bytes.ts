import { decodeBase64, encodeBase64 } from '@/encryption/base64';

export function encodeTerminalBytesBase64(bytes: Uint8Array): string {
    return encodeBase64(bytes, 'base64');
}

export function decodeTerminalBytesBase64(base64: string): Uint8Array {
    return decodeBase64(base64, 'base64');
}
