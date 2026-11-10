import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';
import { createStoredReadSchema } from '../../json/storedReadSchema.js';

import { PromptArtifactRefV1Schema, type PromptArtifactRefV1 } from './promptArtifactRefsV1.js';
import { PromptPlacementV1Schema, PromptPlacementV1StoredSchema } from './promptPlacementV1.js';

export const PromptStackRefV1Schema = PromptArtifactRefV1Schema;
export type PromptStackRefV1 = PromptArtifactRefV1;

/** Full-row custody preserves predecessor placements during unrelated list edits. */
export const PromptStackEntryV1Schema = lazyZodSchema(() => z.strictObject({
  id: z.string().check(z.minLength(1)),
  ref: PromptStackRefV1Schema,
  enabled: z._default(z.boolean(), true),
  placement: z._default(PromptPlacementV1StoredSchema, 'system_append'),
  maxChars: z.optional(z.number().check(z.int(), z.minimum(1))),
  required: z.optional(z.boolean()),
  /** IR-101: consumed positive projection; retained ref/id still resolve exclusions. */
  skillMigrationV1: z.optional(z.literal(true)),
}));

export type PromptStackEntryV1 = z.infer<typeof PromptStackEntryV1Schema>;
export const PromptStackEntryV1StoredSchema = createStoredReadSchema(PromptStackEntryV1Schema);
/** Only new attach operands use this narrower current authoring contract. */
export const PromptStackEntryAuthoringV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(z.omit(PromptStackEntryV1Schema, { skillMigrationV1: true }), {
  placement: z._default(PromptPlacementV1Schema, 'system_append'),
})));

/** Semantic list edits shared by Account, Profile, Project, Source and Session Context owners. */
export const PromptStackSetEnabledIntentV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('set_enabled'), entryId: z.string().check(z.minLength(1)), enabled: z.boolean(),
}));
export const PromptStackIntentV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('attach'), entry: PromptStackEntryAuthoringV1Schema }),
  z.strictObject({ kind: z.literal('detach'), entryId: z.string().check(z.minLength(1)) }),
  z.strictObject({ kind: z.literal('reorder'), entryId: z.string().check(z.minLength(1)), siblingId: z.string().check(z.minLength(1)), position: z.enum(['before', 'after']) }),
  z.strictObject({ kind: z.literal('set_budget'), entryId: z.string().check(z.minLength(1)), maxChars: z.nullable(z.number().check(z.int(), z.positive())) }),
  PromptStackSetEnabledIntentV1Schema,
]));
export type PromptStackIntentV1 = z.infer<typeof PromptStackIntentV1Schema>;
export const PromptLibraryStackUpdateInputV1Schema = lazyZodSchema(() => z.strictObject({
  surface: z.enum(['coding', 'voice']),
  expectedRevision: z.union([z.number().check(z.int(), z.nonnegative(), z.maximum(Number.MAX_SAFE_INTEGER)), z.literal('absent')]),
  intent: PromptStackIntentV1Schema,
}));
export const PromptLibraryStackUpdateResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('updated'), revision: z.number().check(z.int(), z.nonnegative(), z.maximum(Number.MAX_SAFE_INTEGER)) }),
  z.strictObject({ status: z.literal('conflict'), revision: z.number().check(z.int(), z.minimum(-1)) }),
  z.strictObject({ status: z.literal('unavailable'), reason: z.string().check(z.minLength(1)) }),
  z.strictObject({ status: z.literal('invalid'), reason: z.enum(['entry_conflict', 'entry_not_found', 'invalid_parameters']) }),
]));
export type PromptStackMutationV1<Row> =
  | Readonly<{ ok: true; row: Row; changed: boolean }>
  | Readonly<{ ok: false; errorCode: 'entry_conflict' | 'entry_not_found' | 'invalid_parameters' }>;

export function applyPromptStackIntentV1<Row extends Readonly<{ promptStack?: readonly PromptStackEntryV1[] }>>(
  row: Row, intent: PromptStackIntentV1,
): PromptStackMutationV1<Row> {
  const entries = row.promptStack ?? [];
  const entryId = intent.kind === 'attach' ? intent.entry.id : intent.entryId;
  const index = entries.findIndex(entry => entry.id === entryId);
  let next: readonly PromptStackEntryV1[];
  if (intent.kind === 'attach') {
    if (index >= 0) {
      const candidate = PromptStackEntryAuthoringV1Schema.parse(intent.entry);
      const same = JSON.stringify(PromptStackEntryV1Schema.parse(entries[index]!)) === JSON.stringify(candidate);
      return same ? { ok: true, row, changed: false } : { ok: false, errorCode: 'entry_conflict' };
    }
    next = [...entries, PromptStackEntryAuthoringV1Schema.parse(intent.entry)];
  } else if (intent.kind === 'detach') {
    if (index < 0) return { ok: true, row, changed: false };
    next = entries.filter(entry => entry.id !== entryId);
  } else {
    if (index < 0) return { ok: false, errorCode: 'entry_not_found' };
    const selected = entries[index]!;
    if (intent.kind === 'set_budget') {
      if ((selected.maxChars ?? null) === intent.maxChars) return { ok: true, row, changed: false };
      const { maxChars: _previous, ...withoutBudget } = selected;
      const replacement = intent.maxChars === null ? withoutBudget : { ...withoutBudget, maxChars: intent.maxChars };
      next = entries.map((entry, entryIndex) => entryIndex === index ? replacement : entry);
    } else if (intent.kind === 'set_enabled') {
      if (selected.enabled === intent.enabled) return { ok: true, row, changed: false };
      next = entries.map((entry, entryIndex) => entryIndex === index ? { ...entry, enabled: intent.enabled } : entry);
    } else {
      if (intent.siblingId === entryId) return { ok: false, errorCode: 'invalid_parameters' };
      const remaining = entries.filter(entry => entry.id !== entryId);
      const siblingIndex = remaining.findIndex(entry => entry.id === intent.siblingId);
      if (siblingIndex < 0) return { ok: false, errorCode: 'entry_not_found' };
      const position = siblingIndex + (intent.position === 'after' ? 1 : 0);
      next = [...remaining.slice(0, position), selected, ...remaining.slice(position)];
      if (next.every((entry, entryIndex) => entry === entries[entryIndex])) return { ok: true, row, changed: false };
    }
  }
  return { ok: true, row: { ...row, promptStack: next }, changed: true };
}

export const PromptStacksV1Schema = lazyZodSchema(() => z.catch(z
  .object({
    v: z._default(z.literal(1), 1),
    surfaces: z._default(z
      .object({
        coding: z._default(z.array(PromptStackEntryV1StoredSchema), []),
        voice: z._default(z.array(PromptStackEntryV1StoredSchema), []),
        profilesById: z._default(z.record(z.string(), z.array(PromptStackEntryV1StoredSchema)), {}),
      }), { coding: [], voice: [], profilesById: {} }),
  }), { v: 1, surfaces: { coding: [], voice: [], profilesById: {} } }));

export type PromptStacksV1 = z.infer<typeof PromptStacksV1Schema>;
