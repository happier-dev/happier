import { z } from 'zod';

/**
 * The one owner of the Replay seed budget bounds.
 *
 * Before this module the same two numbers were written as literals in five
 * places — the account settings catalog, the settings screen, the UI clamp, the
 * three wire schemas, and the daemon's env clamp — and they disagreed. A user
 * could type a budget the screen accepted, the catalog stored, the clamp passed
 * through and the wire forwarded, and still receive no seed at all, because it
 * sat below the budget at which the seed frame can carry any conversation.
 * Everything that states a bound now derives it from here.
 */

/**
 * The smallest budget that can still produce a real seed.
 *
 * MEASURED, not chosen. `packages/agents/src/sessions/replay/happierReplayPrompt.spec.ts`
 * seals the widest undroppable frame at 814 characters; 1024 is that measured
 * floor with headroom for the frame text to grow. Below it the builder's
 * contract is to return nothing rather than a frame announcing replayed context
 * it did not carry, so every WRITER — the settings screen, the account catalog,
 * the UI clamp, the daemon env clamp — refuses to produce a smaller number.
 */
export const HAPPIER_REPLAY_SEED_MIN_CHARS = 1_024;

/** Upper bound on a seed budget, shared by every owner that states one. */
export const HAPPIER_REPLAY_SEED_MAX_CHARS = 200_000;

/**
 * The floor a READER accepts off the wire, which is deliberately lower than
 * {@link HAPPIER_REPLAY_SEED_MIN_CHARS}.
 *
 * `maxSeedChars` is caller-supplied, and released clients clamp it against
 * their own older floor of 500 before sending. Narrowing the accepted range to
 * the writer floor would reject those requests outright — a worse outcome than
 * the documented degrade, and a released-contract break. The builder owns its
 * contract at every budget in this range (see the "caller-supplied budgets
 * below the configured floor" block in the agents spec), so accepting them
 * stays safe. New writers must not emit a value below the writer floor.
 */
export const HAPPIER_REPLAY_SEED_ACCEPTED_MIN_CHARS = 200;

/** Bounds on the legacy `recentMessagesCount` window. */
export const HAPPIER_REPLAY_RECENT_MESSAGES_MIN_COUNT = 1;
export const HAPPIER_REPLAY_RECENT_MESSAGES_MAX_COUNT = 500;

/** The budget an owner may WRITE: settings catalog, settings screen, env clamp. */
export const HappierReplayWritableMaxSeedCharsSchema = z
  .number()
  .int()
  .min(HAPPIER_REPLAY_SEED_MIN_CHARS)
  .max(HAPPIER_REPLAY_SEED_MAX_CHARS);

/** The budget a wire READER accepts, including from released older clients. */
export const HappierReplayWireMaxSeedCharsSchema = z
  .number()
  .int()
  .min(HAPPIER_REPLAY_SEED_ACCEPTED_MIN_CHARS)
  .max(HAPPIER_REPLAY_SEED_MAX_CHARS);

/** The `recentMessagesCount` window, identical for writers and the wire. */
export const HappierReplayRecentMessagesCountSchema = z
  .number()
  .int()
  .min(HAPPIER_REPLAY_RECENT_MESSAGES_MIN_COUNT)
  .max(HAPPIER_REPLAY_RECENT_MESSAGES_MAX_COUNT);
