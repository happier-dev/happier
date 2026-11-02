import { z } from 'zod/mini';

/** The persisted Account mode admits the matching arm before disclosure or mutation. */
export function deploymentStoredContentV1Schema<T extends z.ZodMiniType>(content: T) {
    return z.discriminatedUnion('t', [
        z.strictObject({ t: z.literal('plain'), v: content }),
        z.strictObject({ t: z.literal('encrypted'), c: z.string().check(z.minLength(1)) }),
    ]);
}
