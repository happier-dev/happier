import { maxCodeUnits } from '../strings/maxCodeUnits.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod/mini';
import { NonBlankOpaqueIdentifierSchema } from '../strings/opaqueIdentifier.js';

import { AGENT_SESSION_RUNTIME_LIMITS_CANDIDATE_V1 as LIMITS } from './agentSessionLimitsV1.js';
import {
  AgentRuntimeDiagnosticDataV1Schema,
  type AgentRuntimeDiagnosticDataV1,
} from './agentRuntimeDiagnosticV1.js';

const SafeIntegerSchema = lazyZodSchema(() => z.number().check(z.int(), z.nonnegative(), z.maximum(LIMITS.safeIntegerMax)));
const MessageIdSchema = lazyZodSchema(() => NonBlankOpaqueIdentifierSchema.check(maxCodeUnits(LIMITS.providerIdMaxCodeUnits)));
const RunIdSchema = lazyZodSchema(() => z.string().check(z.minLength(1), z.refine((value) => value === value.trim(), 'Identifiers must not contain leading or trailing whitespace')));
const CheckpointIdSchema = lazyZodSchema(() => z.string().check(z.minLength(1), maxCodeUnits(LIMITS.providerIdMaxCodeUnits), z.refine((value) => value === value.trim(), 'Identifiers must not contain leading or trailing whitespace')));
const BaseShape = {
  sequence: SafeIntegerSchema,
  runId: RunIdSchema,
  emittedAtMs: SafeIntegerSchema,
};

export type AgentExecutionRunEventV1 =
  | Readonly<{
      sequence: number;
      runId: string;
      emittedAtMs: number;
      kind: 'run-start' | 'run-progress';
    }>
  | Readonly<{
      sequence: number;
      runId: string;
      emittedAtMs: number;
      kind: 'output-delta';
      channel: 'assistant' | 'reasoning';
      text: string;
      messageId?: string;
    }>
  | Readonly<{
      sequence: number;
      runId: string;
      emittedAtMs: number;
      kind: 'output-message-committed';
      channel: 'assistant';
      messageId: string;
      text: string;
    }>
  | Readonly<{
      sequence: number;
      runId: string;
      emittedAtMs: number;
      kind: 'checkpoint';
      checkpointId: string;
    }>
  | Readonly<{
      sequence: number;
      runId: string;
      emittedAtMs: number;
      kind: 'run-complete';
    }>
  | Readonly<{
      sequence: number;
      runId: string;
      emittedAtMs: number;
      kind: 'run-failed' | 'run-cancelled';
      diagnostic?: AgentRuntimeDiagnosticDataV1;
    }>;

/** Strict closed runtime boundary for finite Agent execution events. */
export const AgentExecutionRunEventV1Schema: z.ZodMiniType<AgentExecutionRunEventV1> = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ ...BaseShape, kind: z.literal('run-start') }),
  z.strictObject({ ...BaseShape, kind: z.literal('run-progress') }),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.strictObject({
    ...BaseShape,
    kind: z.literal('output-delta'),
    channel: z.enum(['assistant', 'reasoning']),
    text: z.string(),
    messageId: z.optional(MessageIdSchema),
  })),
  z.strictObject({
    ...BaseShape,
    kind: z.literal('output-message-committed'),
    channel: z.literal('assistant'),
    messageId: MessageIdSchema,
    text: z.string(),
  }),
  z.object({
    ...BaseShape,
    kind: z.literal('checkpoint'),
    checkpointId: CheckpointIdSchema,
  }),
  z.strictObject({ ...BaseShape, kind: z.literal('run-complete') }),
  z.strictObject({
    ...BaseShape,
    kind: z.literal('run-failed'),
    diagnostic: z.optional(AgentRuntimeDiagnosticDataV1Schema),
  }),
  z.strictObject({
    ...BaseShape,
    kind: z.literal('run-cancelled'),
    diagnostic: z.optional(AgentRuntimeDiagnosticDataV1Schema),
  }),
]));

export const AgentExecutionRunEventSchema = AgentExecutionRunEventV1Schema;
