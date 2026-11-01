import { z } from 'zod/mini';

import { hasClaudeProviderIdentityValue } from '../../protocol/providerIdentity.js';
import { ClaudeSessionRuntimeIssueSchema } from './issues/runtimeIssues.js';

/**
 * Identity Claude minted. `.trim()` is a zod TRANSFORM, so using it on these
 * fields would hand every downstream reader a rewritten id — `--resume`, the
 * transcript file name and the statusline/hook arbitration all compare these
 * bytes. Presence is refined instead, leaving the provider's value untouched.
 * Happier-owned fields (`sessionId`, `turnId`, `localId`, labels) keep their
 * canonicalization.
 */
const providerIdentity = (): z.ZodMiniString<string> => z.string().check(z.refine(hasClaudeProviderIdentityValue));

const ProviderEventBaseSchema = z.looseObject({
  sessionId: z.string().check(z.trim(), z.minLength(1)),
  emittedAtMs: z.number().check(z.int(), z.nonnegative()),
});

const ProviderTurnEventBaseSchema = z.extend(ProviderEventBaseSchema, {
  turnId: z.string().check(z.trim(), z.minLength(1)),
  agentTurnId: z.optional(providerIdentity()),
});

export const ClaudeProviderEventSchema = z.discriminatedUnion('kind', [
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(ProviderTurnEventBaseSchema, {
    kind: z.literal('skill-usage'),
    skills: z.array(z.strictObject({ name: z.string().check(z.minLength(1)) })),
  })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(ProviderTurnEventBaseSchema, {
    kind: z.literal('mcp-tool-usage'),
    queuedTurnCount: z.optional(z.nullable(z.number().check(z.int(), z.nonnegative()))),
    window: z.strictObject({ startMs: z.number().check(z.int(), z.nonnegative()), endMs: z.number().check(z.int(), z.nonnegative()) }),
    coverage: z.enum(['complete', 'partial']),
    servers: z.array(z.strictObject({ serverName: z.string().check(z.minLength(1)), toolCallCount: z.number().check(z.int(), z.nonnegative()),
      schemaBytes: z.nullable(z.number().check(z.int(), z.nonnegative())) })),
  })),
  z.extend(ProviderEventBaseSchema, {
    kind: z.literal('available-commands'),
    commands: z.array(z.object({ name: z.string(), description: z.optional(z.string()) })),
  }),
  z.extend(ProviderEventBaseSchema, {
    kind: z.literal('context-compaction'),
    compactionId: z.string().check(z.trim(), z.minLength(1)),
    phase: z.literal('completed'),
    trigger: z.enum(['manual', 'automatic', 'idle', 'unknown']),
    tokenCountBefore: z.optional(z.number().check(z.int(), z.nonnegative())),
    tokenCountAfter: z.optional(z.number().check(z.int(), z.nonnegative())),
    tokenCountSource: z.optional(z.literal('providerReported')),
    turnId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  }),
  z.extend(ProviderTurnEventBaseSchema, {
    kind: z.literal('turn-start'),
    startedBy: z.optional(z.string()),
  }),
  z.extend(ProviderTurnEventBaseSchema, {
    kind: z.literal('turn-progress'),
  }),
  z.extend(ProviderTurnEventBaseSchema, {
    kind: z.literal('turn-agent-id-observed'),
    agentTurnId: providerIdentity(),
  }),
  z.extend(ProviderTurnEventBaseSchema, {
    kind: z.literal('turn-complete'),
    summary: z.optional(z.unknown()),
  }),
  z.extend(ProviderTurnEventBaseSchema, {
    kind: z.literal('turn-failed'),
    issue: ClaudeSessionRuntimeIssueSchema,
  }),
  z.extend(ProviderTurnEventBaseSchema, {
    kind: z.literal('turn-cancelled'),
    reason: z.optional(z.string()),
  }),
  z.extend(ProviderEventBaseSchema, {
    kind: z.literal('message-delta'),
    sidechainId: z.optional(providerIdentity()),
    turnId: z.optional(z.string().check(z.trim(), z.minLength(1))),
    delta: z.unknown(),
  }),
  z.extend(ProviderEventBaseSchema, {
    kind: z.literal('tool-call'),
    sidechainId: z.optional(providerIdentity()),
    turnId: z.optional(z.string().check(z.trim(), z.minLength(1))),
    toolCallId: providerIdentity(),
    toolName: z.string().check(z.trim(), z.minLength(1)),
    toolInput: z.unknown(),
  }),
  z.extend(ProviderEventBaseSchema, {
    kind: z.literal('tool-progress'),
    sidechainId: z.optional(providerIdentity()),
    turnId: z.string().check(z.trim(), z.minLength(1)),
    toolCallId: providerIdentity(),
    progress: z.unknown(),
  }),
  z.extend(ProviderEventBaseSchema, {
    kind: z.literal('tool-result'),
    sidechainId: z.optional(providerIdentity()),
    turnId: z.optional(z.string().check(z.trim(), z.minLength(1))),
    toolCallId: providerIdentity(),
    output: z.unknown(),
    isError: z.optional(z.boolean()),
  }),
  z.extend(ProviderEventBaseSchema, {
    kind: z.literal('transcript-user-text'),
    text: z.string(),
    localId: z.string().check(z.trim(), z.minLength(1)),
    meta: z.optional(z.record(z.string(), z.unknown())),
  }),
  z.extend(ProviderEventBaseSchema, {
    kind: z.literal('transcript-agent-message-committed'),
    sidechainId: z.optional(providerIdentity()),
    turnId: z.optional(z.string().check(z.trim(), z.minLength(1))),
    agentId: z.string().check(z.trim(), z.minLength(1)),
    localId: z.string().check(z.trim(), z.minLength(1)),
    body: z.unknown(),
    meta: z.optional(z.record(z.string(), z.unknown())),
  }),
  z.extend(ProviderEventBaseSchema, {
    kind: z.literal('session-id-publish'),
    publishedSessionId: providerIdentity(),
    source: z.string().check(z.trim(), z.minLength(1)),
    /**
     * Where Claude materialized this resume id's transcript. The path rides
     * this event so it is published in the SAME generation as the id whose
     * conversation it names; published separately it could be matched to a
     * different id and would point a reader at the wrong log.
     *
     * The value is a MACHINE-LOCAL path, and it is a POINTER rather than a
     * resume gate (`AM-24`): the host offers it to a successor Agent on the same
     * machine and never writes it to a server record.
     */
    nativeSessionLogPath: z.optional(z.string().check(z.maxLength(4_096), z.trim(), z.minLength(1))),
  }),
  z.extend(ProviderEventBaseSchema, {
    kind: z.literal('session-ended'),
    agentSessionId: z.optional(providerIdentity()),
    reason: z.optional(z.string().check(z.trim(), z.minLength(1))),
  }),
  z.extend(ProviderEventBaseSchema, {
    kind: z.literal('backend-error'),
    error: z.looseObject({
      message: z.string(),
      code: z.optional(z.string()),
      cause: z.optional(z.unknown()),
    }),
  }),
]);

export type ClaudeProviderEvent = z.infer<typeof ClaudeProviderEventSchema>;

export function readClaudeProviderEvent(value: unknown): ClaudeProviderEvent | null {
  const parsed = ClaudeProviderEventSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
