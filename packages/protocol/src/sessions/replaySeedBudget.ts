import { z } from 'zod';

/**
 * Replay budgets are selected positive integers, not provider capacity guesses.
 * The builder fits the actual frame and dispatch reservation to the selected
 * total; the machine's operator cap and containing transport admission still
 * apply. A recent-message count bounds the aggregate dialog, not one page.
 */
const PositiveReplayBudgetSchema = z.number().int().positive();

export const HappierReplayWritableMaxSeedCharsSchema = PositiveReplayBudgetSchema;
export const HappierReplayWireMaxSeedCharsSchema = PositiveReplayBudgetSchema;
export const HappierReplayRecentMessagesCountSchema = PositiveReplayBudgetSchema;
