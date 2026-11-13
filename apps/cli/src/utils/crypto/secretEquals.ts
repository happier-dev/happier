import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * The one constant-time comparison for presented local secrets (bearers, hook secrets, control
 * tokens). Both sides are hashed first, so neither content nor length leaks through timing.
 */
export function secretEquals(provided: string | undefined, expected: string): boolean {
    if (typeof provided !== 'string' || expected.length === 0) return false;
    return timingSafeEqual(createHash('sha256').update(provided).digest(), createHash('sha256').update(expected).digest());
}
