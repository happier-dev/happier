import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';

import { AGENT_SESSION_RUNTIME_LIMITS_CANDIDATE_V1 as LIMITS } from './agentSessionLimitsV1.js';
import {
  AgentRuntimeDiagnosticDataV1Schema,
  type AgentRuntimeDiagnosticDataV1,
} from './agentRuntimeDiagnosticV1.js';

const SafeIntegerSchema = lazyZodSchema(() => z.number().int().nonnegative().max(LIMITS.safeIntegerMax));
const RunIdSchema = lazyZodSchema(() => z.string()
  .min(1)
  .refine((value) => value === value.trim(), 'Identifiers must not contain leading or trailing whitespace'));
const CheckpointIdSchema = lazyZodSchema(() => z.string()
  .min(1)
  .max(LIMITS.providerIdMaxCodeUnits)
  .refine((value) => value === value.trim(), 'Identifiers must not contain leading or trailing whitespace'));
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

const AgentExecutionRunEventCoreV1Schema: z.ZodType<AgentExecutionRunEventV1> = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({ ...BaseShape, kind: z.literal('run-start') }).strict(),
  z.object({ ...BaseShape, kind: z.literal('run-progress') }).strict(),
  z.object({
    ...BaseShape,
    kind: z.literal('output-delta'),
    channel: z.enum(['assistant', 'reasoning']),
    text: z.string(),
  }).strict(),
  z.object({
    ...BaseShape,
    kind: z.literal('checkpoint'),
    checkpointId: CheckpointIdSchema,
  }).strict(),
  z.object({ ...BaseShape, kind: z.literal('run-complete') }).strict(),
  z.object({
    ...BaseShape,
    kind: z.literal('run-failed'),
    diagnostic: AgentRuntimeDiagnosticDataV1Schema.optional(),
  }).strict(),
  z.object({
    ...BaseShape,
    kind: z.literal('run-cancelled'),
    diagnostic: AgentRuntimeDiagnosticDataV1Schema.optional(),
  }).strict(),
]));

function jsonByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

/** Strict closed runtime boundary for finite Agent execution events. */
export const AgentExecutionRunEventV1Schema = lazyZodSchema(() => AgentExecutionRunEventCoreV1Schema.superRefine(
  (value, context) => {
    if (jsonByteLength(value) > LIMITS.p0MeasuredCandidates.eventMaxJsonBytes) {
      context.addIssue({ code: 'custom', message: 'Agent execution run event exceeds the runtime event byte bound' });
    }
  },
));
export const AgentExecutionRunEventSchema = AgentExecutionRunEventV1Schema;
