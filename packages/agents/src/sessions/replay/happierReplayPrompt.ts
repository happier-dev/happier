export type HappierReplayStrategy = 'recent_messages' | 'summary_plus_recent';

/**
 * What this seed is continuing FROM, which is the only thing that makes the
 * frame's opening claim true or false.
 *
 * - `previous_session` is a replay-seeded NEW Session (fork, sourceContext, the
 *   legacy continue-with-replay ingress): a different Session really is its
 *   predecessor.
 * - `same_session_agent_change` is the in-place Agent transition: the Session is
 *   the same one, and only the Agent running it changed. Framing it as
 *   "continuing from a previous session" and then printing that Session's own id
 *   as its predecessor tells the target Agent something untrue about the
 *   conversation it is being handed.
 */
export type HappierReplayContinuity = 'previous_session' | 'same_session_agent_change';

export type HappierReplayDialogItem = Readonly<{
  role: 'User' | 'Assistant';
  createdAt: number;
  text: string;
}>;

function normalizePositiveInt(value: unknown, fallback: number, opts?: { min?: number; max?: number }): number {
  const raw = typeof value === 'number' && Number.isFinite(value) ? value : Number(value);
  const n = Number.isFinite(raw) ? Math.floor(raw) : fallback;
  const min = opts?.min ?? 1;
  const max = opts?.max ?? 500;
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function normalizeNullablePositiveInt(value: unknown, opts: { min: number; max: number }): number | null {
  if (value == null) return null;
  const raw = typeof value === 'number' && Number.isFinite(value) ? value : Number(value);
  if (!Number.isFinite(raw)) return null;
  const n = Math.floor(raw);
  if (!Number.isFinite(n)) return null;
  return Math.max(opts.min, Math.min(opts.max, n));
}

function normalizeStrategy(value: unknown): HappierReplayStrategy {
  return value === 'summary_plus_recent' ? 'summary_plus_recent' : 'recent_messages';
}

function normalizeText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Literal markers the framer itself emits to structure the seed. Replayed history is untrusted,
 * so it must never be able to reproduce one verbatim and forge a second transcript section.
 */
const TRANSCRIPT_SECTION_MARKER = 'Recent transcript:';
const SUMMARY_SECTION_MARKER = 'Summary:';
const RESERVED_SCAFFOLD_MARKERS = [TRANSCRIPT_SECTION_MARKER, SUMMARY_SECTION_MARKER] as const;

/** Defangs a reserved marker the same way the Session reference block escapes delimiters. */
function defangReservedScaffoldMarkers(value: string): string {
  let defanged = value;
  for (const marker of RESERVED_SCAFFOLD_MARKERS) {
    defanged = defanged.split(marker).join(`${marker.slice(0, -1)}\\u003a`);
  }
  return defanged;
}

/**
 * Renders one untrusted history item as exactly one line.
 *
 * Newlines are escaped rather than emitted, because a raw newline lets replayed content start a
 * line that looks like framer scaffolding or an authored `User:` / `Assistant:` turn.
 */
function escapeUntrustedHistoryText(value: string): string {
  return defangReservedScaffoldMarkers(
    value
      .replaceAll('\\', '\\\\')
      .replaceAll('\r\n', '\\n')
      .replaceAll('\r', '\\n')
      .replaceAll('\n', '\\n'),
  );
}

const TRUNCATION_MARKER = ' … [truncated to fit the context budget]';

function truncateToBudget(value: string, budget: number): string | null {
  if (budget <= 0) return null;
  if (value.length <= budget) return value;
  if (budget <= TRUNCATION_MARKER.length) return null;
  return value.slice(0, budget - TRUNCATION_MARKER.length) + TRUNCATION_MARKER;
}

function renderOmissionLine(omitted: number): string {
  return `[${omitted} earlier message(s) omitted to fit the context budget]`;
}

/** Opening of the footer this builder emits, in every summary variant. */
const FOOTER_OPENING = '\n\nContinue from here.';
const TRANSCRIPT_SECTION_OPENING = `${TRANSCRIPT_SECTION_MARKER}\n`;

/**
 * Splits a sealed seed back into the three parts the builder emitted: the frame
 * (everything up to and including the transcript marker), the transcript body,
 * and the footer.
 *
 * Both boundaries are markers this builder owns and untrusted history cannot
 * reproduce: `Recent transcript:` is defanged in replayed text, and a body line
 * can never contain a raw blank line because history is escaped to one line per
 * turn. A seed that does not carry the frame did not come from this builder, and
 * nothing here can honestly bound it.
 */
function splitSealedReplaySeed(seedText: string): Readonly<{ frame: string; body: string; footer: string }> | null {
  const markerIndex = seedText.indexOf(TRANSCRIPT_SECTION_OPENING);
  if (markerIndex < 0) return null;
  const frame = seedText.slice(0, markerIndex + TRANSCRIPT_SECTION_OPENING.length);
  const rest = seedText.slice(frame.length);
  const footerIndex = rest.lastIndexOf(FOOTER_OPENING);
  if (footerIndex < 0) return { frame, body: rest, footer: '' };
  return { frame, body: rest.slice(0, footerIndex), footer: rest.slice(footerIndex) };
}

/**
 * Keeps whole transcript lines newest-first inside `budget`, marking the loss.
 *
 * Whole lines only: a character clip slices `User: ` in half and emits fragments
 * like `Assis …[truncated]`, which read as authored content — the invariant the
 * builder's own tail selection holds and the fit must not break.
 */
function selectSealedSeedBodyWithinBudget(body: string, budget: number): string {
  if (budget <= 0) return '';
  if (body.length <= budget) return body;

  const lines = body.split('\n');
  const kept: string[] = [];
  let used = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const cost = (kept.length === 0 ? 0 : 1) + lines[index].length;
    if (used + cost > budget) break;
    used += cost;
    kept.push(lines[index]);
  }
  if (kept.length === 0) return '';
  kept.reverse();

  const omitted = lines.length - kept.length;
  if (omitted <= 0) return kept.join('\n');
  // The build's own omission line survived at the head; it already states the
  // loss, so a second marker would only spend budget to repeat it.
  if (kept[0].startsWith('[')) return kept.join('\n');
  const omissionLine = renderOmissionLine(omitted);
  return used + omissionLine.length + 1 <= budget ? [omissionLine, ...kept].join('\n') : kept.join('\n');
}

/**
 * Fit an already-built replay seed inside the total prompt budget once a caller
 * knows what else that same budget must carry.
 *
 * The seed's own cap is enforced when it is BUILT, but the Happier
 * Session-reference block is composed into the prompt at dispatch, long after
 * the seed was sealed into Session metadata. Without this, the configured cap
 * bounds the seed alone and the prompt overruns it by the reference block —
 * bounded, but not the single total the context contract states.
 *
 * The seed is the part that gives way, never the reference block: the block
 * carries Session identities that must not be truncated, while the seed already
 * has a budget-loss vocabulary.
 *
 * The seed gives way through its own grammar, not as an opaque string. Clipping
 * the sealed text blindly is what made this reachable and silent: at a
 * reservation the configured minimum can produce, the clip lands INSIDE the
 * header, so the provider received a sentence cut mid-word, no conversation and
 * no footer — and because that fragment is non-empty the caller counted the seed
 * as delivered and retired it, blanking `seedText` and destroying the replay
 * context it never sent. So the frame and footer are kept whole, only transcript
 * lines give way, and when no whole line survives the seed is dropped. The sole
 * callers treat an empty fit as an UNDELIVERED seed and leave it unsettled for
 * the next dispatch.
 */
export function fitHappierReplaySeedWithinTotalBudget(params: Readonly<{
  seedText: string;
  /** Characters the same total must also carry (for example the reference block). */
  reservedChars: number;
  maxPromptChars: number;
}>): string {
  const seedText = typeof params.seedText === 'string' ? params.seedText : '';
  if (!seedText) return '';
  const reserved = Number.isFinite(params.reservedChars)
    ? Math.max(0, Math.trunc(params.reservedChars))
    : 0;
  const total = Number.isFinite(params.maxPromptChars)
    ? Math.max(0, Math.trunc(params.maxPromptChars))
    : 0;
  const budget = total - reserved;
  if (budget >= seedText.length) return seedText;
  if (budget <= 0) return '';

  const sealed = splitSealedReplaySeed(seedText);
  if (!sealed) return '';
  const body = selectSealedSeedBodyWithinBudget(
    sealed.body,
    budget - sealed.frame.length - sealed.footer.length,
  );
  if (!body) return '';
  return sealed.frame + body + sealed.footer;
}

export function buildHappierReplayPromptFromDialog(params: Readonly<{
  previousSessionId: string;
  dialog: readonly HappierReplayDialogItem[];
  strategy: HappierReplayStrategy;
  recentMessagesCount: number;
  summaryText?: string | null;
  /** Defaults to `previous_session`; the in-place Agent transition passes its own. */
  continuity?: HappierReplayContinuity;
  /**
   * True when the bounded retrieval EXAMINED rows it could not read — malformed,
   * undecryptable, or a whole segment that could not be fetched. The decoder is
   * the only owner that can tell an unreadable row from a row with nothing to
   * replay, and without carrying that fact here the target Agent is handed a
   * conversation with silent holes and told it is the conversation.
   */
  historyIncomplete?: boolean;
  /**
   * Hard cap on the **total** replay seed prompt size, counting the header, summary, recent
   * transcript, omission markers, and footer.
   *
   * The builder drops the oldest transcript items first, then truncates the summary, then
   * truncates the newest item's TEXT, marking every omission. The returned prompt is never
   * longer than this value at ANY budget: when the structural frame plus one marked fragment
   * cannot fit, the builder returns `''` rather than a frame that announces replayed context it
   * did not carry. The sole caller treats an empty draft as "no replay seed".
   *
   * The floor that matters is NOT the env var. `HAPPIER_REPLAY_MAX_SEED_CHARS` is clamped to
   * `min: 500` (apps/cli/src/configuration.ts), but `maxSeedChars` is also caller-supplied on
   * the wire with `min(200)` (packages/protocol/src/execution/runs/startRequest.ts) and
   * continueWithReplay/fork/execution-run callers pass it through in place of the configured
   * value, so 200..499 is reachable in production. The spec sweeps every budget from 200 and
   * pins both invariants: within the total, and never a sliced `User: ` / `Assistant: ` label.
   */
  maxPromptChars?: number | null;
}>): string {
  const previousSessionId = String(params.previousSessionId ?? '').trim();
  const recentMessagesCount = normalizePositiveInt(params.recentMessagesCount, 16, { min: 1, max: 500 });
  const strategy = normalizeStrategy(params.strategy);
  const summaryText = normalizeText(params.summaryText ?? null);
  const maxPromptChars = normalizeNullablePositiveInt(params.maxPromptChars, { min: 200, max: 200_000 });
  const sameSession = params.continuity === 'same_session_agent_change';
  const historyIncomplete = params.historyIncomplete === true;

  const dialog: Array<{ role: 'User' | 'Assistant'; createdAt: number; text: string }> = [];
  for (const item of params.dialog ?? []) {
    if (!item) continue;
    const text = normalizeText((item as any).text);
    if (!text) continue;
    const role = (item as any).role === 'Assistant' ? 'Assistant' : 'User';
    const createdAtRaw = Number((item as any).createdAt ?? 0);
    const createdAt = Number.isFinite(createdAtRaw) ? createdAtRaw : 0;
    dialog.push({ role, createdAt, text });
  }

  dialog.sort((a, b) => a.createdAt - b.createdAt);
  const boundedByCount = dialog.length > recentMessagesCount ? dialog.slice(dialog.length - recentMessagesCount) : dialog;
  if (boundedByCount.length === 0) return '';

  // The summary-explanatory lines describe a summary block that is actually rendered. Keying
  // them on `summaryText` instead would make the no-summary fallback announce a summary that is
  // not there — untrue to the model, and 167 characters of frame that the budget must still
  // carry in exactly the branch where there is no room for anything.
  const buildHeaderLines = (includesSummary: boolean): string[] =>
    [
      sameSession
        ? 'This is the same Happy session, now running under a different coding agent.'
        : 'This session is continuing from a previous Happy session that could not be vendor-resumed.',
      sameSession
        ? "The previous agent's own conversation state does not carry over, so the app is replaying recent transcript messages for context."
        : 'The app is replaying recent transcript messages for context.',
      historyIncomplete
        ? 'Some messages in the range below could not be read, so this replay is incomplete.'
        : null,
      includesSummary
        ? 'The summary below is the authoritative condensed context from earlier transcript history.'
        : null,
      includesSummary
        ? 'The recent transcript is only the tail and may omit older important details.'
        : null,
      previousSessionId
        ? `${sameSession ? 'Session id' : 'Previous session id'}: ${previousSessionId}`
        : null,
    ].filter((line): line is string => Boolean(line));
  const buildPrefix = (summary: string | null): string => {
    const summaryLines = summary ? [SUMMARY_SECTION_MARKER, summary, ''] : [];
    return [...buildHeaderLines(summary !== null), '', ...summaryLines, TRANSCRIPT_SECTION_MARKER].join('\n') + '\n';
  };

  // The synopsis is transcript-derived, so it is exactly as untrusted as a
  // dialog turn and goes through the SAME escaper. Defanging the reserved
  // markers alone left its raw newlines intact, which let summary text open a
  // line that reads as framer scaffolding or an authored `User:` turn in the
  // target's prompt — the one thing the escaping exists to prevent.
  const effectiveSummary = strategy === 'summary_plus_recent' && summaryText
    ? escapeUntrustedHistoryText(summaryText)
    : null;
  // The footer tells the reader how to treat the summary. Emitting that
  // instruction with no summary rendered describes a block that is not there.
  const buildSuffix = (includesSummary: boolean): string =>
    includesSummary
      ? '\n\nContinue from here. Treat the summary as the durable source of older context, and use the recent transcript as the latest tail. If important details are still missing, ask clarifying questions.'
      : '\n\nContinue from here. Use the recent transcript as the latest tail of the conversation. If important details are still missing, ask clarifying questions.';

  // Escape before the budget is measured: escaping changes a line's length, so counting the raw
  // text would let the escaped prompt exceed the total cap.
  //
  // The role label is kept separate from the text because it is framer scaffolding, not content.
  // Truncating a whole rendered line slices into `User: ` and emits fragments like
  // `As … [truncated]`, which read as authored content; only the text may be cut.
  const tailItems = boundedByCount.map((item) => ({
    rolePrefix: `${item.role}: `,
    text: escapeUntrustedHistoryText(item.text),
  }));
  const tailLines = tailItems.map((item) => item.rolePrefix + item.text);

  if (!maxPromptChars) {
    return buildPrefix(effectiveSummary) + tailLines.join('\n') + buildSuffix(effectiveSummary !== null);
  }

  // The structural frame carries the untrusted-content framing and is never cut; everything the
  // caller can grow — summary and transcript — shares whatever the frame leaves.
  const frameLength = buildPrefix(null).length + buildSuffix(false).length;
  const contentBudget = maxPromptChars - frameLength;
  // A frame with no transcript under it is not a smaller seed, it is a lie: it announces
  // replayed context that is not there, and it is the one output that could exceed the total.
  // No seed is the honest result, and the sole caller already treats an empty draft as "no seed".
  if (contentBudget <= 0) return '';

  // The summary is durable older context but must not starve the recent tail, so it may claim at
  // most half of the content budget before the tail is filled from the remainder.
  //
  // Sized against the frame a rendered summary ACTUALLY costs — two extra header lines, the
  // summary block, and the longer footer — not against the no-summary frame. Planning against
  // the smaller frame lets a summary be admitted that the real frame then cannot carry, and the
  // builder returns nothing at exactly the budgets where a summary-less seed would have fitted.
  const SUMMARY_PROBE = 'x';
  const summaryFrameLength =
    buildPrefix(SUMMARY_PROBE).length - SUMMARY_PROBE.length + buildSuffix(true).length;
  const summary = effectiveSummary
    ? truncateToBudget(effectiveSummary, Math.max(0, Math.floor((maxPromptChars - summaryFrameLength) / 2)))
    : null;
  const prefix = buildPrefix(summary);
  const suffix = buildSuffix(summary !== null);
  const available = maxPromptChars - prefix.length - suffix.length;
  if (available <= 0) return '';

  let used = 0;
  const kept: string[] = [];
  for (let i = tailLines.length - 1; i >= 0; i -= 1) {
    const line = tailLines[i];
    const separatorCost = kept.length === 0 ? 0 : 1;
    if (used + separatorCost + line.length > available) {
      if (kept.length > 0) break;
      // The newest item alone overflows. Truncate its TEXT — carrying its own omission marker —
      // rather than keeping it whole, which is what pushed oversized messages past the cap.
      // The role label is emitted whole or not at all: when the remaining budget cannot hold the
      // label plus a marked fragment of text, the turn is dropped and counted as omitted instead.
      const { rolePrefix } = tailItems[i];
      const truncatedText = truncateToBudget(tailItems[i].text, available - rolePrefix.length);
      if (truncatedText) {
        const truncatedLine = rolePrefix + truncatedText;
        used += truncatedLine.length;
        kept.push(truncatedLine);
      }
      break;
    }
    used += separatorCost + line.length;
    kept.push(line);
  }
  kept.reverse();

  const omitted = tailLines.length - kept.length;
  const omissionLine = omitted > 0 ? renderOmissionLine(omitted) : null;
  // The marker is informative, so it is added only when the budget genuinely has room left.
  // It must never evict transcript content that already fits.
  const finalTail = omissionLine && used + omissionLine.length + 1 <= available
    ? [omissionLine, ...kept].join('\n')
    : kept.join('\n');
  return prefix + finalTail + suffix;
}
