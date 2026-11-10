import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { ActionSessionAddressV1Schema } from '../actions/sessionTargetV1.js';
import { SessionSpawnNewSelectionV2Schema } from '../sessions/creation/sessionSpawnNewSelectionV2.js';

/** Shared read-only choice. A model has no Session or resource ownership until admission. */
export const ExecutableSessionParticipantSelectionV1Schema = lazyZodSchema(() =>
  z.strictObject({ kind: z.literal('session'), session: ActionSessionAddressV1Schema }));
export const ExecutableModelParticipantSelectionV1Schema = lazyZodSchema(() =>
  z.strictObject({ kind: z.literal('model'), launch: SessionSpawnNewSelectionV2Schema }));
export const ExecutableParticipantSelectionV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  ExecutableSessionParticipantSelectionV1Schema,
  ExecutableModelParticipantSelectionV1Schema,
]));
export type ExecutableParticipantSelectionV1 = z.infer<typeof ExecutableParticipantSelectionV1Schema>;

const BotSelectionV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('bot'), session: ActionSessionAddressV1Schema,
}));

/** A Bot is a Session display choice. Extra fields never become launch overrides or identity. */
export function normalizeExecutableParticipantSelectionV1(value: unknown): ExecutableParticipantSelectionV1 | null {
  const canonical = ExecutableParticipantSelectionV1Schema.safeParse(value);
  if (canonical.success) return canonical.data;
  const bot = BotSelectionV1Schema.safeParse(value);
  return bot.success ? { kind: 'session', session: bot.data.session } : null;
}
