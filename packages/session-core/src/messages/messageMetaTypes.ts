import { z } from 'zod';
import { createSessionMessageMetaSchema } from '@happier-dev/protocol';

const DANGEROUS_META_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const CanonicalMessageMetaSchema = createSessionMessageMetaSchema(z);
type CanonicalMessageMeta = z.output<typeof CanonicalMessageMetaSchema>;

function sanitizeMessageMetaObject(meta: CanonicalMessageMeta): CanonicalMessageMeta {
    const out: CanonicalMessageMeta = {};
    for (const [key, value] of Object.entries(meta)) {
        if (DANGEROUS_META_KEYS.has(key)) continue;
        out[key] = value;
    }
    return out;
}

// Shared message metadata schema
export const MessageMetaSchema = CanonicalMessageMetaSchema
    .transform(sanitizeMessageMetaObject);

export type MessageMeta = z.infer<typeof MessageMetaSchema>;
