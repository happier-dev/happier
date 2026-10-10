import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';
import { createStoredReadSchema } from '../../json/storedReadSchema.js';

import { PromptArtifactRefV1Schema, type PromptArtifactRefV1 } from './promptArtifactRefsV1.js';
import { PromptPlacementV1Schema, type PromptPlacementV1 } from './promptPlacementV1.js';

export const PromptStackRefV1Schema = PromptArtifactRefV1Schema;
export type PromptStackRefV1 = PromptArtifactRefV1;

export const PromptStackEntryV1Schema = lazyZodSchema(() => z.object({
  id: z.string().min(1),
  ref: PromptStackRefV1Schema,
  enabled: z.boolean().default(true),
  placement: PromptPlacementV1Schema.default('system_append' satisfies PromptPlacementV1),
  maxChars: z.number().int().min(1).optional(),
  required: z.boolean().optional(),
}).strict());

export type PromptStackEntryV1 = z.infer<typeof PromptStackEntryV1Schema>;
export const PromptStackEntryV1StoredSchema = createStoredReadSchema(PromptStackEntryV1Schema);

/** Semantic list edits shared by Account, Profile, Project, Source and Session Context owners. */
export const PromptStackSetEnabledIntentV1Schema = lazyZodSchema(() => z.object({
  kind: z.literal('set_enabled'), entryId: z.string().min(1), enabled: z.boolean(),
}).strict());
export const PromptStackIntentV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('attach'), entry: PromptStackEntryV1Schema }).strict(),
  z.object({ kind: z.literal('detach'), entryId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('reorder'), entryId: z.string().min(1), siblingId: z.string().min(1), position: z.enum(['before', 'after']) }).strict(),
  z.object({ kind: z.literal('set_budget'), entryId: z.string().min(1), maxChars: z.number().int().positive().nullable() }).strict(),
  PromptStackSetEnabledIntentV1Schema,
]));
export type PromptStackIntentV1 = z.infer<typeof PromptStackIntentV1Schema>;
export const PromptLibraryStackUpdateInputV1Schema = lazyZodSchema(() => z.object({
  surface: z.enum(['coding', 'voice']),
  expectedRevision: z.union([z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), z.literal('absent')]),
  intent: PromptStackIntentV1Schema,
}).strict());
export const PromptLibraryStackUpdateResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.object({ status: z.literal('updated'), revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }).strict(),
  z.object({ status: z.literal('conflict'), revision: z.number().int().min(-1) }).strict(),
  z.object({ status: z.literal('unavailable'), reason: z.string().min(1) }).strict(),
  z.object({ status: z.literal('invalid'), reason: z.enum(['entry_conflict', 'entry_not_found', 'invalid_parameters']) }).strict(),
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
      const candidate = PromptStackEntryV1Schema.parse(intent.entry);
      const same = JSON.stringify(PromptStackEntryV1Schema.parse(entries[index]!)) === JSON.stringify(candidate);
      return same ? { ok: true, row, changed: false } : { ok: false, errorCode: 'entry_conflict' };
    }
    next = [...entries, PromptStackEntryV1Schema.parse(intent.entry)];
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

export const PromptStacksV1Schema = lazyZodSchema(() => z
  .object({
    v: z.literal(1).default(1),
    surfaces: z
      .object({
        coding: z.array(PromptStackEntryV1StoredSchema).default([]),
        voice: z.array(PromptStackEntryV1StoredSchema).default([]),
        profilesById: z.record(z.string(), z.array(PromptStackEntryV1StoredSchema)).default({}),
      })
      .default({ coding: [], voice: [], profilesById: {} }),
  })
  .catch({ v: 1, surfaces: { coding: [], voice: [], profilesById: {} } }));

export type PromptStacksV1 = z.infer<typeof PromptStacksV1Schema>;
