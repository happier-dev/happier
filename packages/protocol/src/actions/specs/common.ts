import type { PreNormalizedActionSurfaces } from './definition.js';
import { SessionTargetV1Schema } from '../sessionTargetV1.js';
import { type ActionInputHints } from '../metadata.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';

import type { RuntimeActionIdV1 } from '../actionIds.js';
import type { PreNormalizedActionSpec } from '../actionSpecs.js';

export type RuntimeActionSpecTextMap = Readonly<Partial<Record<RuntimeActionIdV1, string>>>;

export type RuntimeActionSchemaMap = Readonly<Partial<Record<RuntimeActionIdV1, z.ZodMiniType>>>;

export type RuntimeActionSpecFamily = Readonly<{
  originalExecution?: Readonly<Partial<Record<RuntimeActionIdV1, PreNormalizedActionSpec['originalExecution']>>>;
  confirmationFacts?: Readonly<Partial<Record<RuntimeActionIdV1, Pick<PreNormalizedActionSpec, 'confirmVerb' | 'irreversible'>>>>;
  approvalPolicies?: Readonly<Partial<Record<RuntimeActionIdV1, PreNormalizedActionSpec['approvalPolicy']>>>;
  /** Input paths the approval page reads under Technical details (see ActionSpec `approvalPresentation`). */
  approvalTechnicalInputPaths?: Readonly<Partial<Record<RuntimeActionIdV1, readonly string[]>>>;
  /** Domain-written request summaries, for Actions whose spec description is agent-facing (see ActionSpec `approvalPresentation`). */
  approvalSummaries?: Readonly<Partial<Record<RuntimeActionIdV1, (input: unknown) => string | null>>>;
  titles: RuntimeActionSpecTextMap;
  descriptions?: RuntimeActionSpecTextMap;
  /** Canonical per-id schema rows for public/runtime projections. */
  inputSchemas?: RuntimeActionSchemaMap;
  outputSchemas?: RuntimeActionSchemaMap;
}>;

export const PassthroughEmptyObjectSchema = lazyZodSchema(() => z.looseObject({}));

export function refineKindSchema(
  schema: z.ZodMiniType,
  field: string,
  expected: string,
  label: string,
): z.ZodMiniType {
  return schema.check(z.refine((value) => (value as Record<string, unknown>)[field] === expected, {
    message: `${label} must be ${expected}.`,
    path: [field],
  }));
}


export const DAEMON_ADMIN_RPC_SURFACES = Object.freeze({
  ui: false,
  voice: false,
  agent: false,
  mcp: false,
  cli: false,
  rpc: true,
} satisfies PreNormalizedActionSurfaces);

export const DAEMON_ADMIN_INPUT_HINTS = Object.freeze({
  fields: [],
} satisfies ActionInputHints);

export const EmptyObjectSchema = lazyZodSchema(() => z.strictObject({}));
export const OptionalSessionIdInputSchema = lazyZodSchema(() => z.looseObject({
  sessionId: z.optional(z.string().check(z.minLength(1))),
}));

export const SessionIdRequiredInputSchema = lazyZodSchema(() => z.looseObject({
  sessionId: z.string().check(z.minLength(1)),
}));

export const SessionTargetRequiredInputSchema = lazyZodSchema(() => z.looseObject({
  sessionId: SessionTargetV1Schema,
}));
