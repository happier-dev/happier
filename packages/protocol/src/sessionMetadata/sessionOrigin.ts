import { z } from 'zod';
import { lazySchema } from '../lazySchema.js';

/**
 * How an agent-created session came to exist. Absent means a direct `session.spawn_new` by the
 * creator. Older readers ignore it (the origin is passthrough) and still nest by `creatorSessionId`.
 */
export function createSessionOriginViaV1Schema(zod: typeof z) {
    return zod.discriminatedUnion('kind', [
        zod.object({ kind: zod.literal('execution_run'), runId: zod.string().trim().min(1) }).passthrough(),
        zod.object({ kind: zod.literal('team_assembly'), assignmentId: zod.string().trim().min(1) }).passthrough(),
    ]);
}

export const SessionOriginViaV1Schema = lazySchema(() => createSessionOriginViaV1Schema(z));
export type SessionOriginViaV1 = z.infer<typeof SessionOriginViaV1Schema>;

/** Creation provenance only. This is neither transcript ancestry nor runtime authority. */
export function createSessionOriginV1Schema(zod: typeof z) {
    return zod.object({
        v: zod.literal(1),
        kind: zod.literal('agent'),
        creatorSessionId: zod.string().trim().min(1),
    }).passthrough();
}

export const SessionOriginV1Schema = lazySchema(() => createSessionOriginV1Schema(z));
export type SessionOriginV1 = z.infer<typeof SessionOriginV1Schema> & { via?: SessionOriginViaV1 };

/** Missing, malformed, and newer unsupported origins are unknown, never evidence of user creation. */
export function readSessionOriginV1(metadata: unknown): SessionOriginV1 | null {
    if (!metadata || typeof metadata !== 'object' || !('sessionOriginV1' in metadata)) return null;
    const parsed = SessionOriginV1Schema.safeParse(metadata.sessionOriginV1);
    return parsed.success ? parsed.data : null;
}

/** The recognized `via` form of a readable origin; an unknown future form reads as null. */
export function readSessionOriginViaV1(metadata: unknown): SessionOriginViaV1 | null {
    const origin = readSessionOriginV1(metadata);
    if (!origin || !('via' in origin)) return null;
    const parsed = SessionOriginViaV1Schema.safeParse((origin as { via?: unknown }).via);
    return parsed.success ? parsed.data : null;
}

/** The single builder for a new origin. The creator always comes from the execution context, never tool input. */
export function buildSessionOriginV1(params: Readonly<{ creatorSessionId: string; via?: SessionOriginViaV1 }>): SessionOriginV1 {
    const creatorSessionId = params.creatorSessionId.trim();
    if (!creatorSessionId) throw new Error('session-origin-creator-required');
    return {
        v: 1,
        kind: 'agent',
        creatorSessionId,
        ...(params.via ? { via: SessionOriginViaV1Schema.parse(params.via) } : {}),
    };
}
