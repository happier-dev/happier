import { z } from 'zod';
import { createSessionMessageMetaSchema } from '@happier-dev/protocol';

const DANGEROUS_META_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function sanitizeMessageMetaObject(meta: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(meta)) {
        if (DANGEROUS_META_KEYS.has(key)) continue;
        out[key] = value;
    }
    return out;
}

// Shared message metadata schema
export const MessageMetaSchema = createSessionMessageMetaSchema(z)
    .transform((meta) => sanitizeMessageMetaObject(meta as Record<string, unknown>));

export type MessageMeta = z.infer<typeof MessageMetaSchema>;
