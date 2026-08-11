import { z } from 'zod';

import { SessionAgentActivityEntryV1Schema, type SessionAgentActivityEntryV1 } from './agentActivityEntryV1.js';

/**
 * The session-metadata key the unified agent-activity headline is published under.
 *
 * A CROSS-REPO WIRE LITERAL: remote-dev and `../dev` both write and read this exact string, so it
 * is protocol-owned rather than restated at each producer and consumer, and it is pinned by a
 * hand-written literal in `agentActivityHeadlineMetadataKey.test.ts`. It is published ALONGSIDE
 * `sessionWorkflowActivityHeadlineV1`, which keeps its name, its shape and its own parity lock —
 * this program is the expand step only (PLAN §5.2); removing the older key is out of scope.
 */
export const SESSION_AGENT_ACTIVITY_HEADLINE_METADATA_KEY = 'sessionAgentActivityHeadlineV1';

export const SessionAgentActivityHeadlineTruncationV1Schema = z
  .object({
    reason: z.literal('entry_limit'),
    /** Terminal entries the producer's history bound dropped. Never a parse-time drop count. */
    omittedCount: z.number().int().nonnegative(),
  })
  .strip();
export type SessionAgentActivityHeadlineTruncationV1 = z.infer<typeof SessionAgentActivityHeadlineTruncationV1Schema>;

/**
 * The unified agent-activity headline: a count-only live pointer published into session metadata.
 *
 * Shaped deliberately like `SessionWorkflowActivityHeadlineV1` — same envelope, same active/recent
 * split, same derived-primary hint — because it is DERIVED from that headline rather than parallel
 * to it (PLAN §3.1), and the two are ported to `../dev` together. What it adds is the ability to
 * describe kinds of work beyond a workflow run; what it deliberately does not add is detail.
 *
 * `activeEntries` is never bounded: a roster that is quietly incomplete is the failure R-3 exists to
 * prevent. Only `recentEntries` is bounded, and `truncated` says so out loud.
 */
export const SessionAgentActivityHeadlineV1Schema = z
  .object({
    v: z.literal(1),
    backendId: z.string().trim().min(1),
    agentId: z.string().trim().min(1).optional(),
    updatedAt: z.number().int().nonnegative(),
    /** Derived hint, not a second source of truth: the first active entry, or null when none. */
    primaryEntryId: z.string().trim().min(1).nullable().optional(),
    activeEntries: z.array(SessionAgentActivityEntryV1Schema),
    recentEntries: z.array(SessionAgentActivityEntryV1Schema).optional(),
    truncated: SessionAgentActivityHeadlineTruncationV1Schema.optional(),
  })
  .strip();
export type SessionAgentActivityHeadlineV1 = z.infer<typeof SessionAgentActivityHeadlineV1Schema>;

/**
 * The same envelope with unvalidated entries, so the reader below can decide per entry.
 *
 * Derived from the canonical schema with `.extend`, not restated, so an envelope field added above
 * cannot go missing here.
 */
const SessionAgentActivityHeadlineEnvelopeV1Schema = SessionAgentActivityHeadlineV1Schema.extend({
  activeEntries: z.array(z.unknown()),
  recentEntries: z.array(z.unknown()).optional(),
});

function keepReadableEntries(entries: readonly unknown[]): SessionAgentActivityEntryV1[] {
  const readable: SessionAgentActivityEntryV1[] = [];
  for (const candidate of entries) {
    const parsed = SessionAgentActivityEntryV1Schema.safeParse(candidate);
    if (parsed.success) readable.push(parsed.data);
  }
  return readable;
}

/**
 * Read a headline written by any build of either repo, tolerating entries this build cannot parse.
 *
 * The tolerance is the point, and it is not defensive habit: `AgentActivityKindV1` grows a member
 * every time a kind gains a proven writer (PLAN §5.1 item 11 — `background_task` is already
 * scheduled), and statuses can follow. With a whole-array parse, the first entry from a newer
 * producer would take the ENTIRE roster down to `null` on every client that predates it, turning a
 * forward-compatible addition into a regression for everyone else. Dropping the rows this build
 * genuinely cannot render, and keeping the ones it can, is the degrade PLAN §5.2 requires.
 *
 * Dropped entries are NOT folded into `truncated`: that field means the producer bounded terminal
 * history, and reusing it for a parse failure would report a producer decision that never happened.
 *
 * Returns `null` — never throws — for anything that is not a v1 headline.
 */
export function parseSessionAgentActivityHeadlineV1(value: unknown): SessionAgentActivityHeadlineV1 | null {
  const envelope = SessionAgentActivityHeadlineEnvelopeV1Schema.safeParse(value);
  if (!envelope.success) return null;

  const headline: SessionAgentActivityHeadlineV1 = {
    v: 1,
    backendId: envelope.data.backendId,
    updatedAt: envelope.data.updatedAt,
    activeEntries: keepReadableEntries(envelope.data.activeEntries),
  };
  if (envelope.data.agentId !== undefined) headline.agentId = envelope.data.agentId;
  if (envelope.data.primaryEntryId !== undefined) headline.primaryEntryId = envelope.data.primaryEntryId;
  if (envelope.data.recentEntries !== undefined) {
    headline.recentEntries = keepReadableEntries(envelope.data.recentEntries);
  }
  if (envelope.data.truncated !== undefined) headline.truncated = envelope.data.truncated;
  return headline;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The one reader of the agent-activity headline out of a session-metadata object.
 *
 * Every consumer — CLI, UI, `../dev` — goes through this rather than reaching for the key itself,
 * so the cross-repo literal has exactly one spelling and the parity lock actually locks something.
 */
export function readSessionAgentActivityHeadlineFromMetadata(
  metadata: unknown,
): SessionAgentActivityHeadlineV1 | null {
  if (!isRecord(metadata)) return null;
  return parseSessionAgentActivityHeadlineV1(metadata[SESSION_AGENT_ACTIVITY_HEADLINE_METADATA_KEY]);
}
