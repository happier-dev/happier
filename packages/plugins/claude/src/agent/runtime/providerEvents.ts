import { z } from 'zod';

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
const providerIdentity = (): z.ZodString => z.string().refine(hasClaudeProviderIdentityValue);

const ProviderEventBaseSchema = z.object({
  sessionId: z.string().trim().min(1),
  emittedAtMs: z.number().int().nonnegative(),
}).passthrough();

const ProviderTurnEventBaseSchema = ProviderEventBaseSchema.extend({
  turnId: z.string().trim().min(1),
  agentTurnId: providerIdentity().optional(),
});

export const ClaudeProviderEventSchema = z.discriminatedUnion('kind', [
  ProviderEventBaseSchema.extend({
    kind: z.literal('available-commands'),
    commands: z.array(z.object({ name: z.string(), description: z.string().optional() })),
  }),
  ProviderEventBaseSchema.extend({
    kind: z.literal('context-compaction'),
    compactionId: z.string().trim().min(1),
    phase: z.literal('completed'),
    trigger: z.enum(['manual', 'automatic', 'unknown']),
    turnId: z.string().trim().min(1).optional(),
  }),
  ProviderTurnEventBaseSchema.extend({
    kind: z.literal('turn-start'),
    startedBy: z.string().optional(),
  }),
  ProviderTurnEventBaseSchema.extend({
    kind: z.literal('turn-progress'),
  }),
  ProviderTurnEventBaseSchema.extend({
    kind: z.literal('turn-agent-id-observed'),
    agentTurnId: providerIdentity(),
  }),
  ProviderTurnEventBaseSchema.extend({
    kind: z.literal('turn-complete'),
    summary: z.unknown().optional(),
  }),
  ProviderTurnEventBaseSchema.extend({
    kind: z.literal('turn-failed'),
    issue: ClaudeSessionRuntimeIssueSchema,
  }),
  ProviderTurnEventBaseSchema.extend({
    kind: z.literal('turn-cancelled'),
    reason: z.string().optional(),
  }),
  ProviderEventBaseSchema.extend({
    kind: z.literal('message-delta'),
    turnId: z.string().trim().min(1),
    delta: z.unknown(),
  }),
  ProviderEventBaseSchema.extend({
    kind: z.literal('tool-call'),
    turnId: z.string().trim().min(1),
    toolCallId: providerIdentity(),
    toolName: z.string().trim().min(1),
    toolInput: z.unknown(),
  }),
  ProviderEventBaseSchema.extend({
    kind: z.literal('tool-progress'),
    turnId: z.string().trim().min(1),
    toolCallId: providerIdentity(),
    progress: z.unknown(),
  }),
  ProviderEventBaseSchema.extend({
    kind: z.literal('tool-result'),
    turnId: z.string().trim().min(1),
    toolCallId: providerIdentity(),
    output: z.unknown(),
    isError: z.boolean().optional(),
  }),
  ProviderEventBaseSchema.extend({
    kind: z.literal('transcript-user-text'),
    text: z.string(),
    localId: z.string().trim().min(1),
    meta: z.record(z.string(), z.unknown()).optional(),
  }),
  ProviderEventBaseSchema.extend({
    kind: z.literal('transcript-agent-message-committed'),
    agentId: z.string().trim().min(1),
    localId: z.string().trim().min(1),
    body: z.unknown(),
    meta: z.record(z.string(), z.unknown()).optional(),
  }),
  ProviderEventBaseSchema.extend({
    kind: z.literal('session-id-publish'),
    publishedSessionId: providerIdentity(),
    source: z.string().trim().min(1),
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
    nativeSessionLogPath: z.string().max(4_096).trim().min(1).optional(),
  }),
  ProviderEventBaseSchema.extend({
    kind: z.literal('session-ended'),
    agentSessionId: providerIdentity().optional(),
    reason: z.string().trim().min(1).optional(),
  }),
  ProviderEventBaseSchema.extend({
    kind: z.literal('backend-error'),
    error: z.object({
      message: z.string(),
      code: z.string().optional(),
      cause: z.unknown().optional(),
    }).passthrough(),
  }),
]);

export type ClaudeProviderEvent = z.infer<typeof ClaudeProviderEventSchema>;

export function readClaudeProviderEvent(value: unknown): ClaudeProviderEvent | null {
  const parsed = ClaudeProviderEventSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
