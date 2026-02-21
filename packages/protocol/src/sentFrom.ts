import { z } from 'zod';

export const SENT_FROM_VALUES = [
    'unknown',
    'cli',
    'web',
    'android',
    'ios',
    'mac',
    'retry',
    'e2e',
    'voice_agent',
] as const;

export type SentFrom = (typeof SENT_FROM_VALUES)[number];

/**
 * Normalized source identifier for message-meta `sentFrom`.
 *
 * Behavior:
 * - Known values parse as-is.
 * - Unknown/invalid values parse as `'unknown'` (forward compatible; never throws).
 */
export function createSentFromSchema(zod: typeof z) {
    return zod.enum(SENT_FROM_VALUES).catch('unknown');
}

export const SentFromSchema = createSentFromSchema(z);
