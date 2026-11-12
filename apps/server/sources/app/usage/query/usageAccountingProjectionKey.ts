import { createHash } from 'node:crypto';

/** Stable opaque keys shared by the existing usage projection storage owners. */
export function usageAccountingProjectionKey(parts: readonly unknown[]): string {
    return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}
