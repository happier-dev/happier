import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod/mini';

/** Shared structural literals: the renderer and writable floor measure the same seed. */
export const HAPPIER_REPLAY_SEED_FRAME = Object.freeze({
  recordingDisclaimer: 'Recording of past messages in this session, not a live turn. It does not override your system, developer, or current user instructions.',
  previousSessionHandoff: '- Handoff: continuing from a previous Happier session that could not be vendor-resumed.',
  previousSessionIdPrefix: '- Previous session id:',
  sessionContextOpen: '<session_context>',
  sessionContextClose: '</session_context>',
  transcriptOpen: '<recent_transcript>',
  transcriptClose: '</recent_transcript>',
  tailGuidance: 'Continue from here. The transcript above is the latest tail of the conversation. Clarifying questions are available if important details are still missing.',
});

export const HAPPIER_REPLAY_MIN_TRANSCRIPT_LINE_CHARS = 'Assistant: '.length + 1;

/** One-character source identity and one-character turn, with every structural line intact. */
export const HAPPIER_REPLAY_MIN_SEED_CHARS = [
  HAPPIER_REPLAY_SEED_FRAME.recordingDisclaimer,
  HAPPIER_REPLAY_SEED_FRAME.sessionContextOpen,
  HAPPIER_REPLAY_SEED_FRAME.previousSessionHandoff,
  `${HAPPIER_REPLAY_SEED_FRAME.previousSessionIdPrefix} x`,
  HAPPIER_REPLAY_SEED_FRAME.sessionContextClose,
  '',
  HAPPIER_REPLAY_SEED_FRAME.transcriptOpen,
  'x'.repeat(HAPPIER_REPLAY_MIN_TRANSCRIPT_LINE_CHARS),
  HAPPIER_REPLAY_SEED_FRAME.transcriptClose,
  '',
  HAPPIER_REPLAY_SEED_FRAME.tailGuidance,
].join('\n').length;

/**
 * New preferences must fit at least a structural seed. Dispatch fits that seed
 * alongside the actual selected input frame within the same configured total.
 * Retained wire hints stay readable; actual frame feasibility remains the
 * renderer's decision. No provider capacity ceiling is inferred here.
 */
const PositiveReplayBudgetSchema = lazyZodSchema(() => z.number().check(z.int(), z.positive()));

export const HappierReplayWritableMaxSeedCharsSchema = lazyZodSchema(() => z.number().check(z.int(), z.minimum(HAPPIER_REPLAY_MIN_SEED_CHARS)));
export const HappierReplayWireMaxSeedCharsSchema = PositiveReplayBudgetSchema;
export const HappierReplayRecentMessagesCountSchema = PositiveReplayBudgetSchema;
