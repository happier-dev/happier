import { Buffer } from 'node:buffer';
import { vi } from 'vitest';

/** QuickBase64's JSI functions are native; its SDK and app adapter stay real. */
export function installQuickBase64Boundary(): void {
    vi.stubGlobal('base64FromArrayBuffer', (bytes: ArrayBuffer, urlSafe: boolean) => Buffer.from(bytes).toString(urlSafe ? 'base64url' : 'base64'));
    vi.stubGlobal('base64ToArrayBuffer', (value: string) => Uint8Array.from(Buffer.from(value, 'base64')).buffer);
}
