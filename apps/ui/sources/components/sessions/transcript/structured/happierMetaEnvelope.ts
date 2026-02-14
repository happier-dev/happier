import { z } from 'zod';

const HappierMetaEnvelopeSchema = z.object({
    kind: z.string(),
    payload: z.unknown(),
});

export type HappierMetaEnvelope = z.infer<typeof HappierMetaEnvelopeSchema>;

export function parseHappierMetaEnvelope(meta: unknown): HappierMetaEnvelope | null {
    if (!meta || typeof meta !== 'object') return null;
    const record = meta as Record<string, unknown>;
    const parsed = HappierMetaEnvelopeSchema.safeParse(record.happier);
    if (!parsed.success) return null;
    return parsed.data;
}

