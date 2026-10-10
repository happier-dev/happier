import { z } from 'zod';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { SessionSurfaceItemIdSchema } from './ids.js';

const origin = {
    originServerId: z.string().trim().min(1),
    originSessionId: z.string().trim().min(1),
    originItemId: SessionSurfaceItemIdSchema,
};

/** Presentation correspondence only; these source hints confer no parent read authority. */
export const SessionForkVisualCopyV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
    z.object({ ...origin, status: z.literal('copied'), itemId: SessionSurfaceItemIdSchema }).strict(),
    z.object({ ...origin, status: z.literal('not_copied') }).strict(),
]));
export type SessionForkVisualCopyV1 = Readonly<z.infer<typeof SessionForkVisualCopyV1Schema>>;

export const SessionForkVisualsV1Schema = lazyZodSchema(() => z.object({
    v: z.literal(1),
    copies: z.array(SessionForkVisualCopyV1Schema),
}).strict());

export type SessionForkVisualContextV1 = Readonly<{
    sessionId: string;
    copies: readonly SessionForkVisualCopyV1[];
    /** Recognition-only source address for imported child transcript rows. */
    originAddress?: Readonly<{ serverId: string; sessionId: string }>;
}>;

/** Presentation provenance only; never grants access to the source Session. */
export const SessionForkVisualOriginV1Schema = lazyZodSchema(() => z.object({
    v: z.literal(1),
    serverId: z.string().trim().min(1),
    sessionId: z.string().trim().min(1),
    sourceMessageId: z.string().trim().min(1),
    sourceSeq: z.number().int().nonnegative(),
}).strict());
export type SessionForkVisualOriginV1 = Readonly<z.infer<typeof SessionForkVisualOriginV1Schema>>;

/** An inherited hint never authorizes a parent read when its child copy is absent. */
export function resolveSessionForkVisualReferenceTargetV1(input: Readonly<{
    reference: Readonly<{ address: Readonly<{ serverId: string; sessionId: string }>; itemId: string }>;
    childAddress: Readonly<{ serverId: string; sessionId: string }>;
    copies: readonly SessionForkVisualCopyV1[];
}>): Readonly<{ status: 'copied'; address: Readonly<{ serverId: string; sessionId: string }>; itemId: string }>
    | Readonly<{ status: 'not_copied' }> {
    const copy = input.copies.find(candidate => candidate.originServerId === input.reference.address.serverId
        && candidate.originSessionId === input.reference.address.sessionId && candidate.originItemId === input.reference.itemId);
    return copy?.status === 'copied'
        ? { status: 'copied', address: input.childAddress, itemId: copy.itemId }
        : { status: 'not_copied' };
}
