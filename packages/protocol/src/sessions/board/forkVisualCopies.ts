import { z } from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { SessionSurfaceItemIdSchema } from './ids.js';
import { SessionSystemRecordRevisionSchema } from '../system/records/sessionSystemRecordRevision.js';
import { areServerProfileIdentifiersEquivalent, type ServerProfileScopeResolver } from '../../features/payload/capabilities/serverIdentityCapabilities.js';

const origin = {
    originServerId: z.string().check(z.trim(), z.minLength(1)),
    originSessionId: z.string().check(z.trim(), z.minLength(1)),
    originItemId: SessionSurfaceItemIdSchema,
};

/** Presentation correspondence only; these source hints confer no parent read authority. */
export const SessionForkVisualCopyV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
    z.strictObject({ ...origin, status: z.literal('copied'), itemId: SessionSurfaceItemIdSchema }),
    z.strictObject({ ...origin, status: z.literal('not_copied') }),
]));
export type SessionForkVisualCopyV1 = Readonly<z.infer<typeof SessionForkVisualCopyV1Schema>>;

export const SessionForkVisualsV1Schema = lazyZodSchema(() => z.strictObject({
    v: z.literal(1),
    copies: z.array(SessionForkVisualCopyV1Schema),
}));

export type SessionForkVisualContextV1 = Readonly<{
    sessionId: string;
    copies: readonly SessionForkVisualCopyV1[];
    /** Recognition-only source address for imported child transcript rows. */
    originAddress?: Readonly<{ serverId: string; sessionId: string }>;
}>;

/** Presentation provenance only; never grants access to the source Session. */
export const SessionForkVisualOriginV1Schema = lazyZodSchema(() => z.strictObject({
    v: z.literal(1),
    serverId: z.string().check(z.trim(), z.minLength(1)),
    sessionId: z.string().check(z.trim(), z.minLength(1)),
    sourceMessageId: z.string().check(z.trim(), z.minLength(1)),
    sourceSeq: z.number().check(z.int(), z.nonnegative()),
    // Source-only settled correspondence survives an unavailable child copy; it grants no read.
    settledApprovalReferences: z.optional(z.array(z.strictObject({
        approvalRequestArtifactId: z.string().check(z.minLength(1)),
        sourceItemId: SessionSurfaceItemIdSchema,
        sourceItemRevision: SessionSystemRecordRevisionSchema,
    }))),
}));
export type SessionForkVisualOriginV1 = Readonly<z.infer<typeof SessionForkVisualOriginV1Schema>>;

/** An inherited hint never authorizes a parent read when its child copy is absent. */
export function resolveSessionForkVisualReferenceTargetV1(input: Readonly<{
    reference: Readonly<{ address: Readonly<{ serverId: string; sessionId: string }>; itemId: string }>;
    childAddress: Readonly<{ serverId: string; sessionId: string }>;
    copies: readonly SessionForkVisualCopyV1[];
    resolveServerScopeId?: ServerProfileScopeResolver;
}>): Readonly<{ status: 'copied'; address: Readonly<{ serverId: string; sessionId: string }>; itemId: string }>
    | Readonly<{ status: 'not_copied' }> {
    if (!areServerProfileIdentifiersEquivalent(input.reference.address.serverId, input.childAddress.serverId,
        input.resolveServerScopeId)) return { status: 'not_copied' };
    const copy = input.copies.find(candidate => areServerProfileIdentifiersEquivalent(candidate.originServerId,
        input.reference.address.serverId, input.resolveServerScopeId)
        && candidate.originSessionId === input.reference.address.sessionId && candidate.originItemId === input.reference.itemId);
    return copy?.status === 'copied'
        ? { status: 'copied', address: input.childAddress, itemId: copy.itemId }
        : { status: 'not_copied' };
}
