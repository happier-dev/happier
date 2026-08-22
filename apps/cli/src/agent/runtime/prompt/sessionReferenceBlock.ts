import {
  MENTION_BOUNDS,
  MENTION_KIND_V1,
  readMentionRefOpaqueForKindV1,
  sanitizeMentionRefsV1,
  type MentionRefV1,
} from '@happier-dev/protocol';

/**
 * A Session mention reaches an agent as an identity/tool hint only. Transcript text remains
 * behind the Session tool boundary: it is current at read time, subject to that tool's
 * authority checks, and never becomes stale prompt context.
 */
const OPEN_TAG = '<happier_session_reference>';
const CLOSE_TAG = '</happier_session_reference>';
const HEADER = 'The user referenced other Happier session(s) in this message. Use them only if the request calls for it.';
const FOOTER = [
  'Happier session tools may be available to you (for example: read a session\'s transcript or status, or send it a message).',
  'No transcript content is included here — read it with a tool if you need it.',
  'If a tool call fails, or no such tool is available, say so to the user instead of guessing or working around it.',
].join(' ');

type SessionReferenceEntry =
  | Readonly<{ status: 'resolved'; sessionId: string; label: string | null }>
  | Readonly<{ status: 'unreadable' }>;

/**
 * What one rendered block costs the budgets that bound it, in **UTF-16 code
 * units**.
 *
 * `MENTION_BOUNDS.maxReferenceBlockChars` is a mention-domain bound and that
 * domain counts code points. This block is bounded by it too, but it is not the
 * only budget it spends: the block is composed into the replay-seed prompt at
 * dispatch, and the seed was already built against a reservation of exactly this
 * bound (`HAPPIER_REPLAY_SEED_DISPATCH_RESERVED_CHARS` in `@happier-dev/agents`,
 * the owner of that unit). Every measurement and every slice in that budget is
 * `String.prototype.length`, so the reservation is denominated in UTF-16 code
 * units.
 *
 * Counting code points here would let one astral character in a Session title
 * cost two of the reserved units while spending only one of the counted ones, so
 * a block within its bound could still cost up to twice what was reserved — and
 * the dispatch refit, which exists to be a no-op, would delete transcript lines
 * the seed was entitled to keep.
 *
 * UTF-16 length dominates code-point length for every string, so measuring in
 * the reservation's unit satisfies the mention domain's code-point contract at
 * the same time. That is why one measure can serve both, and why it must be this
 * one rather than the looser one.
 */
function measureReferenceBlockChars(value: string): number {
  return value.length;
}

function encodeModelText(value: string): string {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e');
}

function readSessionReferenceEntries(mentions: readonly MentionRefV1[]): readonly SessionReferenceEntry[] {
  const entries: SessionReferenceEntry[] = [];
  const seen = new Set<string>();
  let sawUnreadable = false;
  for (const mention of sanitizeMentionRefsV1(mentions)) {
    if (mention.kind !== MENTION_KIND_V1.session || seen.has(mention.ref)) continue;
    seen.add(mention.ref);

    const sessionId = readMentionRefOpaqueForKindV1(MENTION_KIND_V1.session, mention.ref);
    if (!sessionId) {
      // The wire identity is authoritative. A malformed or stale reference is stated without
      // trying an id-or-prefix lookup that could send the agent to a different Session.
      if (!sawUnreadable) {
        sawUnreadable = true;
        entries.push({ status: 'unreadable' });
      }
      continue;
    }
    entries.push({
      status: 'resolved',
      sessionId,
      label: typeof mention.label === 'string' && mention.label.trim().length > 0
        ? mention.label.trim()
        : null,
    });
  }
  return entries;
}

function formatEntry(entry: SessionReferenceEntry): string {
  if (entry.status === 'unreadable') {
    return '- a Session reference in this message could not be read; no Session id is available for it, and none must be guessed';
  }
  const label = entry.label
    ? `; inserted label=${encodeModelText(entry.label)} (advisory only; it may have changed)`
    : '';
  return `- session_id=${encodeModelText(entry.sessionId)}${label}`;
}

function renderBlock(lines: readonly string[], omitted: number): string {
  return [
    OPEN_TAG,
    HEADER,
    ...lines,
    ...(omitted > 0
      ? [`- ${omitted} further reference(s) omitted to stay within the reference budget`]
      : []),
    '',
    FOOTER,
    CLOSE_TAG,
  ].join('\n');
}

/**
 * Builds the one provider-prompt projection for built-in `@session` references. The dispatch
 * owner supplies it after parsing the canonical mention source; it is never persisted into the
 * message metadata or display text.
 *
 * Only the queued prompt-dispatch path renders it, and that is sufficient rather than a gap: a
 * `@session` mention exists only inside the structured-input envelope, and a message carrying
 * that envelope is excluded from in-flight steering, so it always reaches this path. A change
 * that lets structured input steer must also supply this block at the steer dispatch.
 */
export function buildSessionReferenceContextBlockForDispatch(mentions: readonly MentionRefV1[]): string {
  const entries = readSessionReferenceEntries(mentions);
  if (entries.length === 0) return '';

  const included: string[] = [];
  let omitted = 0;
  for (const entry of entries) {
    const candidate = renderBlock([...included, formatEntry(entry)], omitted);
    if (measureReferenceBlockChars(candidate) <= MENTION_BOUNDS.maxReferenceBlockChars) {
      included.push(formatEntry(entry));
    } else {
      omitted += 1;
    }
  }
  while (
    included.length > 0
    && measureReferenceBlockChars(renderBlock(included, omitted)) > MENTION_BOUNDS.maxReferenceBlockChars
  ) {
    included.pop();
    omitted += 1;
  }

  const block = renderBlock(included, omitted);
  return measureReferenceBlockChars(block) <= MENTION_BOUNDS.maxReferenceBlockChars ? block : '';
}
