import { z } from 'zod';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { ProviderBoundModelRefSchema } from '../../providers/selection/v1.js';

const Id = lazyZodSchema(() => z.string().min(1));
const Size = lazyZodSchema(() => z.number().int().nonnegative().safe());
const Digest = lazyZodSchema(() => z.string().regex(/^[a-f0-9]{64}$/u));

/** Equality of host-dispatched context only; hidden native history and task quality are not witnessed. */
export const UsageHostModelRequestIdentitySchema = lazyZodSchema(() => z.object({
    scopeKey: Digest, digest: Digest, selection: ProviderBoundModelRefSchema,
}).strict());
export const UsageCoachModelRequestSchema = lazyZodSchema(() => z.object({
    evidenceId: Id, observedAtMs: Size, startedAtMs: Size, sessionId: Id, turnId: Id,
    requestIdentity: UsageHostModelRequestIdentitySchema,
}).strict().refine(value => value.observedAtMs >= value.startedAtMs));
export type UsageCoachModelRequest = z.infer<typeof UsageCoachModelRequestSchema>;

/** Content-free, Session-protected evidence. Every object is closed; no source labels or paths. */
export const UsagePromptCompositionComponentSchema = lazyZodSchema(() => z.object({
    sourceId: Digest,
    kind: z.enum(['instructions', 'tool_guidance', 'mcp_schema', 'history', 'user_input', 'other']),
    digest: Digest,
    location: z.enum(['system', 'user', 'tool']),
    byteLength: Size,
    tokenCount: Size.nullable(),
    tokenizerId: Id.nullable(),
    cacheClass: z.enum(['unknown', 'cacheable', 'uncacheable']),
    overlap: z.enum(['none', 'known', 'unknown']),
}).strict().refine(value => (value.tokenCount === null) === (value.tokenizerId === null),
    'A token measurement requires its tokenizer basis'));
export type UsagePromptCompositionComponent = z.infer<typeof UsagePromptCompositionComponentSchema>;

export const UsagePromptCompositionSchema = lazyZodSchema(() => z.object({
    v: z.literal(1), evidenceId: Id, sessionId: Id, turnId: Id.nullable(), inputId: Id.nullable(),
    observedAtMs: Size,
    boundary: z.enum(['host_pre_dispatch', 'agent_native_request']),
    deliveryKind: z.enum(['newTurn', 'followUp', 'steer']),
    coverage: z.enum(['host_only', 'complete_native']),
    components: z.array(UsagePromptCompositionComponentSchema),
    nativePrefix: z.object({
        digest: Digest, tokenCount: Size.nullable(), tokenizerId: Id.nullable(),
        cacheOutcome: z.enum(['hit', 'miss', 'unknown']),
        missCause: z.enum(['prefix_change', 'ttl_expired', 'other', 'unknown']),
        cacheReadTokens: Size.nullable(), cacheWriteTokens: Size.nullable(), ttlMs: Size.nullable(),
    }).strict().refine(value => (value.tokenCount === null) === (value.tokenizerId === null),
        'A native token measurement requires its tokenizer basis').nullable(),
    contextWindowTokens: Size.nullable(),
    requestIdentity: UsageHostModelRequestIdentitySchema.optional(),
}).strict().superRefine((value, ctx) => {
    if (value.boundary === 'host_pre_dispatch' && (value.coverage !== 'host_only' || value.nativePrefix !== null)) {
        ctx.addIssue({ code: 'custom', message: 'Host preparation cannot claim the hidden native prefix' });
    }
    if (value.coverage === 'complete_native' && value.nativePrefix === null) {
        ctx.addIssue({ code: 'custom', message: 'Complete native coverage requires a witnessed prefix' });
    }
}));
export type UsagePromptComposition = z.infer<typeof UsagePromptCompositionSchema>;
