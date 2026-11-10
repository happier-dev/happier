import { z } from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { ProviderBoundModelRefSchema } from '../../providers/selection/v1.js';

const Id = lazyZodSchema(() => z.string().check(z.minLength(1)));
const Size = lazyZodSchema(() => z.number().check(z.int(), z.nonnegative(), z.int()));
const Digest = lazyZodSchema(() => z.string().check(z.regex(/^[a-f0-9]{64}$/u)));

/** Equality of host-dispatched context only; hidden native history and task quality are not witnessed. */
export const UsageHostModelRequestIdentitySchema = lazyZodSchema(() => z.strictObject({
    scopeKey: Digest, digest: Digest, selection: ProviderBoundModelRefSchema,
}));
export const UsageCoachModelRequestSchema = lazyZodSchema(() => z.strictObject({
    evidenceId: Id, observedAtMs: Size, startedAtMs: Size, sessionId: Id, turnId: Id,
    requestIdentity: UsageHostModelRequestIdentitySchema,
}).check(z.refine(value => value.observedAtMs >= value.startedAtMs)));
export type UsageCoachModelRequest = z.infer<typeof UsageCoachModelRequestSchema>;

/** Content-free, Session-protected evidence. Every object is closed; no source labels or paths. */
export const UsagePromptCompositionComponentSchema = lazyZodSchema(() => z.strictObject({
    sourceId: Digest,
    kind: z.enum(['instructions', 'tool_guidance', 'mcp_schema', 'history', 'user_input', 'other']),
    digest: Digest,
    location: z.enum(['system', 'user', 'tool']),
    byteLength: Size,
    tokenCount: z.nullable(Size),
    tokenizerId: z.nullable(Id),
    cacheClass: z.enum(['unknown', 'cacheable', 'uncacheable']),
    overlap: z.enum(['none', 'known', 'unknown']),
}).check(z.refine(value => (value.tokenCount === null) === (value.tokenizerId === null), 'A token measurement requires its tokenizer basis')));
export type UsagePromptCompositionComponent = z.infer<typeof UsagePromptCompositionComponentSchema>;

export const UsagePromptCompositionSchema = lazyZodSchema(() => z.strictObject({
    v: z.literal(1), evidenceId: Id, sessionId: Id, turnId: z.nullable(Id), inputId: z.nullable(Id),
    observedAtMs: Size,
    boundary: z.enum(['host_pre_dispatch', 'agent_native_request']),
    deliveryKind: z.enum(['newTurn', 'followUp', 'steer']),
    coverage: z.enum(['host_only', 'complete_native']),
    components: z.array(UsagePromptCompositionComponentSchema),
    nativePrefix: z.nullable(z.strictObject({
        digest: Digest, tokenCount: z.nullable(Size), tokenizerId: z.nullable(Id),
        cacheOutcome: z.enum(['hit', 'miss', 'unknown']),
        missCause: z.enum(['prefix_change', 'ttl_expired', 'other', 'unknown']),
        cacheReadTokens: z.nullable(Size), cacheWriteTokens: z.nullable(Size), ttlMs: z.nullable(Size),
    }).check(z.refine(value => (value.tokenCount === null) === (value.tokenizerId === null), 'A native token measurement requires its tokenizer basis'))),
    contextWindowTokens: z.nullable(Size),
    requestIdentity: z.optional(UsageHostModelRequestIdentitySchema),
}).check(z.superRefine((value, ctx) => {
    if (value.boundary === 'host_pre_dispatch' && (value.coverage !== 'host_only' || value.nativePrefix !== null)) {
        ctx.addIssue({ code: 'custom', message: 'Host preparation cannot claim the hidden native prefix' });
    }
    if (value.coverage === 'complete_native' && value.nativePrefix === null) {
        ctx.addIssue({ code: 'custom', message: 'Complete native coverage requires a witnessed prefix' });
    }
})));
export type UsagePromptComposition = z.infer<typeof UsagePromptCompositionSchema>;
