import { z } from 'zod';

import { ClaudeSessionRuntimeIssueSchema } from './issues/runtimeIssues.js';

const ProviderEventBaseSchema = z.object({
  sessionId: z.string().trim().min(1),
  emittedAtMs: z.number().int().nonnegative(),
}).passthrough();

const ProviderTurnEventBaseSchema = ProviderEventBaseSchema.extend({
  turnId: z.string().trim().min(1),
  agentTurnId: z.string().trim().min(1).optional(),
});

export const ClaudeProviderEventSchema = z.discriminatedUnion('kind', [
  ProviderTurnEventBaseSchema.extend({
    kind: z.literal('turn-start'),
    startedBy: z.string().optional(),
  }),
  ProviderTurnEventBaseSchema.extend({
    kind: z.literal('turn-progress'),
  }),
  ProviderTurnEventBaseSchema.extend({
    kind: z.literal('turn-agent-id-observed'),
    agentTurnId: z.string().trim().min(1),
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
    toolCallId: z.string().refine((value) => value.trim().length > 0),
    toolName: z.string().trim().min(1),
    toolInput: z.unknown(),
  }),
  ProviderEventBaseSchema.extend({
    kind: z.literal('tool-progress'),
    turnId: z.string().trim().min(1),
    toolCallId: z.string().refine((value) => value.trim().length > 0),
    progress: z.unknown(),
  }),
  ProviderEventBaseSchema.extend({
    kind: z.literal('tool-result'),
    turnId: z.string().trim().min(1),
    toolCallId: z.string().refine((value) => value.trim().length > 0),
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
    publishedSessionId: z.string().trim().min(1),
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
    nativeSessionLogPath: z.string().trim().min(1).max(4_096).optional(),
  }),
  ProviderEventBaseSchema.extend({
    kind: z.literal('session-ended'),
    agentSessionId: z.string().trim().min(1).optional(),
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
