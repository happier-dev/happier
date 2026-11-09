import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';

const MinuteOfDaySchema = lazyZodSchema(() => z.number().check(z.int(), z.minimum(0), z.maximum(24 * 60 - 1)));
const WeekdaySchema = lazyZodSchema(() => z.number().check(z.int(), z.minimum(0), z.maximum(6)));

export const SessionReminderPresetRuleSchema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('relative_day'), daysAhead: z.number().check(z.int(), z.minimum(1)), minuteOfDay: MinuteOfDaySchema }),
  z.object({ kind: z.literal('next_weekday'), weekday: WeekdaySchema, minuteOfDay: MinuteOfDaySchema }),
  z.object({ kind: z.literal('next_calendar_weekday'), weekday: WeekdaySchema, weeksAhead: z.optional(z.number().check(z.int(), z.minimum(1))), minuteOfDay: MinuteOfDaySchema }),
]));

export const SessionReminderPresetV1Schema = lazyZodSchema(() => z.object({
  rule: SessionReminderPresetRuleSchema,
  label: z.optional(z.string().check(z.trim(), z.minLength(1))),
}));

export const SessionReminderPresetsV1Schema = lazyZodSchema(() => (<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform((value) => {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const parsed = SessionReminderPresetV1Schema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}), z.array(SessionReminderPresetV1Schema)));

export type SessionReminderPresetRule = z.infer<typeof SessionReminderPresetRuleSchema>;
export type SessionReminderPresetV1 = z.infer<typeof SessionReminderPresetV1Schema>;

/** Edits are applied to the latest Account value by the Settings CAS owner. */
export const SessionReminderPresetIntentSchema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('upsert'), preset: SessionReminderPresetV1Schema }),
  z.strictObject({ kind: z.literal('replace'), presets: z.array(SessionReminderPresetV1Schema), expectedPresets: z.array(SessionReminderPresetV1Schema) }),
]));
export type SessionReminderPresetIntent =
  | Readonly<{ kind: 'upsert'; preset: SessionReminderPresetV1 }>
  | Readonly<{ kind: 'replace'; presets: readonly SessionReminderPresetV1[]; expectedPresets: readonly SessionReminderPresetV1[] }>;

export function sessionReminderPresetRuleKey(rule: SessionReminderPresetRule): string {
  if (rule.kind === 'relative_day') return `${rule.kind}:${rule.daysAhead}:${rule.minuteOfDay}`;
  if (rule.kind === 'next_calendar_weekday') return `${rule.kind}:${rule.weekday}:${rule.weeksAhead ?? 1}:${rule.minuteOfDay}`;
  return `${rule.kind}:${rule.weekday}:${rule.minuteOfDay}`;
}

export function upsertSessionReminderPreset(presets: readonly SessionReminderPresetV1[], preset: SessionReminderPresetV1): SessionReminderPresetV1[] {
  const key = sessionReminderPresetRuleKey(preset.rule);
  const index = presets.findIndex(candidate => sessionReminderPresetRuleKey(candidate.rule) === key);
  return index < 0 ? [...presets, preset] : presets.map((candidate, offset) => offset === index ? preset : candidate);
}

export class SessionReminderPresetConflictError extends Error {
  constructor() {
    super('Reminder presets changed while editing');
    this.name = 'SessionReminderPresetConflictError';
  }
}

export function applySessionReminderPresetIntent(presets: readonly SessionReminderPresetV1[], intent: SessionReminderPresetIntent): SessionReminderPresetV1[] {
  if (intent.kind === 'upsert') return upsertSessionReminderPreset(presets, intent.preset);
  if (presets.length !== intent.expectedPresets.length || presets.some((preset, index) => {
    const expected = intent.expectedPresets[index];
    return !expected || preset.label !== expected.label || sessionReminderPresetRuleKey(preset.rule) !== sessionReminderPresetRuleKey(expected.rule);
  })) throw new SessionReminderPresetConflictError();
  return [...intent.presets];
}
