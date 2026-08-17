import type { SessionWorkStateV1 } from '@happier-dev/protocol';

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
const WORK_STATE_SECTION_MARKER = 'Work state:';
const RESERVED_SCAFFOLD_MARKERS = [
  TRANSCRIPT_SECTION_MARKER,
  SUMMARY_SECTION_MARKER,
  WORK_STATE_SECTION_MARKER,
] as const;

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
 * line that looks like framer scaffolding or an authored `User:` / `Assistant:` turn. The
 * successor tree escapes at the same point; keeping the two in step is what stops replayed
 * history from breaking out of the untrusted frame in either tree.
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

const REPLAY_TRUNCATION_MARKER = '…[truncated]';
const REPLAY_OMISSION_NOTICE = '[Older context was omitted to fit the replay budget.]';

/** Clip `text` so the result is never longer than `maxChars`, marking the clip when it fits. */
function clipToBudget(text: string, maxChars: number): string {
  if (maxChars <= 0) return '';
  if (text.length <= maxChars) return text;
  if (maxChars <= REPLAY_TRUNCATION_MARKER.length) return text.slice(0, maxChars);
  return text.slice(0, maxChars - REPLAY_TRUNCATION_MARKER.length) + REPLAY_TRUNCATION_MARKER;
}

const REPLAY_WORK_STATE_OMISSION_NOTICE = '[Some work items were omitted to fit the replay budget.]';

/**
 * The snapshot's share of the total. The work state is the compact structured answer to "what was
 * under way"; the transcript is the conversation it is context for, so the snapshot may not grow
 * until it starves the tail.
 */
const WORK_STATE_BUDGET_SHARE = 4;

/**
 * The departing Agent's tracked work items, rendered as a bounded display-safe block (section 8 of
 * the cross-Agent continuation contract).
 *
 * This exists because the transition CLEARS `sessionWorkStateV1` — the target republishes its own —
 * and the items live in a structured projection rather than in the replayed prose, so without this
 * the in-flight plan is simply deleted at the cutover and the target continues the same Session
 * unaware of it.
 *
 * Only kind, status and title are carried: `vendorRef`, native ids, budgets and timings are the
 * departing runtime's own bookkeeping, and no Agent's native reference belongs in another's prompt.
 * Titles are agent-authored, so they go through the same untrusted-history escaper as a dialog turn
 * and can neither open a turn nor forge a section of their own.
 */
function buildWorkStateBlock(
  workState: SessionWorkStateV1 | null | undefined,
  budget: number | null,
): string | null {
  const lines: string[] = [];
  for (const item of workState?.items ?? []) {
    const title = normalizeText((item as { title?: unknown } | null)?.title);
    if (!title) continue;
    const status = normalizeText((item as { status?: unknown }).status) ?? 'unknown';
    const kind = normalizeText((item as { kind?: unknown }).kind) ?? 'task';
    lines.push(`- ${escapeUntrustedHistoryText(`[${status}] ${kind}: ${title}`)}`);
  }
  if (lines.length === 0) return null;
  if (budget === null) return lines.join('\n');

  const fill = (available: number): string[] => {
    const kept: string[] = [];
    let used = 0;
    for (const line of lines) {
      const cost = (kept.length === 0 ? 0 : 1) + line.length;
      if (used + cost > available) break;
      used += cost;
      kept.push(line);
    }
    return kept;
  };

  const whole = fill(budget);
  if (whole.length === lines.length) return whole.join('\n');

  // The notice is reserved BEFORE the fill, so a dropped item is always marked. Adding it
  // afterwards is what lets a snapshot silently present part of the plan as the whole plan.
  const available = budget - (REPLAY_WORK_STATE_OMISSION_NOTICE.length + 1);
  const kept = fill(available);
  if (kept.length === 0) {
    // The first item alone overflows. A clipped fragment of it is context; an absent block is not,
    // and the reader cannot tell the two apart.
    const clipped = clipToBudget(lines[0], available);
    if (!clipped) return null;
    kept.push(clipped);
  }
  return [...kept, REPLAY_WORK_STATE_OMISSION_NOTICE].join('\n');
}

/**
 * One replayed turn, with its role label kept separate from its text. The label is framer
 * scaffolding and is emitted whole or not at all; only the text may be clipped.
 */
type ReplayTailItem = Readonly<{ rolePrefix: string; text: string }>;

/**
 * Fill the transcript tail newest-first within `budget`, clipping the newest item's text when it
 * alone cannot fit. Reports whether any earlier context was dropped or clipped so the
 * caller can spend budget on an omission notice.
 */
function selectReplayTailWithinBudget(
  tailItems: readonly ReplayTailItem[],
  budget: number,
): Readonly<{ body: string; omitted: boolean }> {
  if (budget <= 0) return { body: '', omitted: tailItems.length > 0 };

  const kept: string[] = [];
  let used = 0;
  let omitted = false;

  for (let i = tailItems.length - 1; i >= 0; i -= 1) {
    const item = tailItems[i];
    const line = item.rolePrefix + item.text;
    const separator = kept.length === 0 ? 0 : 1;
    const cost = separator + line.length;
    if (used + cost <= budget) {
      used += cost;
      kept.push(line);
      continue;
    }
    if (kept.length === 0) {
      // The newest turn alone overflows: carry as much of its TEXT as the budget allows.
      // Clipping the rendered line instead slices into `User: ` and emits fragments like
      // `As …[truncated]`, which read as authored content. When the label plus a clipped
      // fragment cannot fit, drop the turn and let the omission notice account for it.
      const clipped = clipToBudget(item.text, budget - item.rolePrefix.length);
      if (clipped) kept.push(item.rolePrefix + clipped);
    }
    omitted = true;
    break;
  }

  kept.reverse();
  return { body: kept.join('\n'), omitted: omitted || kept.length < tailItems.length };
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
 * like `Assi…[truncated]`, which read as authored content — the invariant
 * `selectReplayTailWithinBudget` holds when the seed is BUILT and the fit must
 * not break when it is delivered.
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

  if (kept.length === lines.length) return kept.join('\n');
  // The build's own notice survived at the head; it already states the loss, so
  // a second one would only spend budget to repeat it.
  if (kept[0] === REPLAY_OMISSION_NOTICE) return kept.join('\n');
  return used + REPLAY_OMISSION_NOTICE.length + 1 <= budget
    ? [REPLAY_OMISSION_NOTICE, ...kept].join('\n')
    : kept.join('\n');
}

/**
 * Fit an already-built replay seed inside the total prompt budget once a caller
 * knows what else that same budget must carry.
 *
 * The seed's own cap is enforced when it is BUILT, but the Happier
 * Session-reference block is appended at dispatch, long after the seed was
 * sealed into session metadata. Without this the seed's configured cap bounds
 * the seed alone and the prompt overruns it by the reference block — bounded,
 * but not the single total the context contract states.
 *
 * The seed is the part that gives, not the reference block: the block carries
 * Session identities that must never be truncated, while the seed already has a
 * budget-loss vocabulary.
 *
 * The seed gives way through its own grammar, not as an opaque string. Clipping
 * the sealed text blindly is what made this reachable and silent: at a
 * reservation the configured minimum can produce, the clip landed inside the
 * header — or, smaller still, returned a sliced omission notice — so the
 * provider received no conversation and no footer, and because that fragment is
 * non-empty the caller counted the seed as delivered and retired it, blanking
 * `seedText` and destroying the replay context it never sent. So the frame and
 * footer are kept whole, only transcript lines give way, and when no whole line
 * survives the seed is dropped. The sole caller treats an empty fit as an
 * UNDELIVERED seed and leaves it unsettled for the next dispatch.
 */
export function fitHappierReplaySeedWithinTotalBudget(params: Readonly<{
  seedText: string;
  /** Characters the same total must also carry (for example the reference block). */
  reservedChars: number;
  maxPromptChars: number;
}>): string {
  const seedText = typeof params.seedText === 'string' ? params.seedText : '';
  if (!seedText) return '';
  const reserved = Number.isFinite(params.reservedChars) ? Math.max(0, Math.trunc(params.reservedChars)) : 0;
  const total = Number.isFinite(params.maxPromptChars) ? Math.max(0, Math.trunc(params.maxPromptChars)) : 0;
  const budget = total - reserved;
  if (budget >= seedText.length) return seedText;
  if (budget <= 0) return '';

  const sealed = splitSealedReplaySeed(seedText);
  if (!sealed) return '';
  const contentBudget = budget - sealed.frame.length;
  if (contentBudget <= 0) return '';

  // The footer is instruction; the transcript is the conversation. So the footer
  // is what gives way first — a tight reservation costs the reader guidance it
  // can infer, not context it cannot.
  const withFooter = selectSealedSeedBodyWithinBudget(sealed.body, contentBudget - sealed.footer.length);
  if (withFooter) return sealed.frame + withFooter + sealed.footer;
  const bodyOnly = selectSealedSeedBodyWithinBudget(sealed.body, contentBudget);
  if (!bodyOnly) return '';
  return sealed.frame + bodyOnly;
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
   * The departing Agent's `sessionWorkStateV1` (section 8). Supplied by the same-Session Agent
   * transition, whose cutover clears the field; a replay-seeded NEW Session has no departing Agent
   * and passes nothing.
   */
  workState?: SessionWorkStateV1 | null;
  /**
   * Hard cap on the TOTAL replay seed prompt size.
   *
   * Every part the builder emits — header, summary, work state, omission notice, transcript tail
   * and footer — is spent from this budget, and the returned string never exceeds it. The
   * summary and an oversized single transcript item are clipped rather than allowed to
   * overflow, and budget-driven loss is marked with an omission notice.
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
  // them on `summaryText` instead makes the no-summary prefix announce a summary that is not
  // there — untrue to the model, and ~167 characters of frame that the budget must still carry
  // in exactly the branch where there is no room for anything.
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
  // The synopsis is transcript-derived, so it is exactly as untrusted as a
  // dialog turn and goes through the SAME escaper. Defanging the reserved
  // markers alone left its raw newlines intact — and the budgeted path below did
  // not even defang, clipping the RAW summary — which let summary text open a
  // line that reads as framer scaffolding or an authored `User:` turn in the
  // target's prompt.
  const escapedSummaryText =
    strategy === 'summary_plus_recent' && summaryText ? escapeUntrustedHistoryText(summaryText) : null;
  const summaryLines = escapedSummaryText ? [SUMMARY_SECTION_MARKER, escapedSummaryText, ''] : [];

  // Bounded before the frame is composed, so every downstream length — the no-summary frame, the
  // summary's own share, and the tail's remainder — is measured against the block the prompt will
  // actually carry.
  const workStateBlock = buildWorkStateBlock(
    params.workState,
    maxPromptChars ? Math.floor(maxPromptChars / WORK_STATE_BUDGET_SHARE) : null,
  );
  const workStateLines = workStateBlock ? [WORK_STATE_SECTION_MARKER, workStateBlock, ''] : [];

  const buildPrefix = (summary: readonly string[]): string =>
    [
      ...buildHeaderLines(summary.length > 0),
      '',
      ...summary,
      ...workStateLines,
      TRANSCRIPT_SECTION_MARKER,
    ].join('\n') + '\n';
  // The footer tells the reader how to treat the summary. Emitting that
  // instruction with no summary rendered describes a block that is not there.
  const buildSuffix = (includesSummary: boolean): string =>
    includesSummary
      ? '\n\nContinue from here. Treat the summary as the durable source of older context, and use the recent transcript as the latest tail. If important details are still missing, ask clarifying questions.'
      : '\n\nContinue from here. Use the recent transcript as the latest tail of the conversation. If important details are still missing, ask clarifying questions.';

  // Escape before the budget is measured: escaping changes a line's length, so counting the raw
  // text would let the escaped prompt exceed the total cap.
  const tailItems: ReplayTailItem[] = boundedByCount.map((item) => ({
    rolePrefix: `${item.role}: `,
    text: escapeUntrustedHistoryText(item.text),
  }));
  const tailLines = tailItems.map((item) => item.rolePrefix + item.text);

  if (!maxPromptChars) {
    return buildPrefix(summaryLines) + tailLines.join('\n') + buildSuffix(summaryLines.length > 0);
  }

  const framingLen = buildPrefix([]).length + buildSuffix(false).length;
  if (maxPromptChars - framingLen <= 0) {
    // The cap cannot hold the framing. Emitting the newest turn without it would hand the
    // provider raw untrusted transcript with the untrusted-content framing stripped off — the
    // one thing the frame exists to prevent. No seed is the honest result, and the sole caller
    // already treats an empty draft as "no replay seed".
    return '';
  }

  // Reserve the newest turn before the summary so the latest exchange always survives,
  // then let the summary take what is left, then refill older turns.
  const newestLine = tailLines[tailLines.length - 1];
  const newestReserve = Math.min(newestLine.length, maxPromptChars - framingLen);

  // Sized against the frame a rendered summary ACTUALLY costs — two extra header lines, the
  // summary block, and the longer footer — not against the no-summary frame. Planning against
  // the smaller frame admits a summary the real frame cannot carry.
  let resolvedSummaryLines: readonly string[] = [];
  if (escapedSummaryText) {
    const summaryFrameLen = buildPrefix([SUMMARY_SECTION_MARKER, '', '']).length + buildSuffix(true).length;
    const summaryBudget = maxPromptChars - summaryFrameLen - newestReserve;
    const clippedSummary = clipToBudget(escapedSummaryText, summaryBudget);
    if (clippedSummary) resolvedSummaryLines = [SUMMARY_SECTION_MARKER, clippedSummary, ''];
  }

  const prefix = buildPrefix(resolvedSummaryLines);
  const suffix = buildSuffix(resolvedSummaryLines.length > 0);
  const tailBudget = maxPromptChars - prefix.length - suffix.length;

  const withoutNotice = selectReplayTailWithinBudget(tailItems, tailBudget);
  if (!withoutNotice.omitted) {
    return prefix + withoutNotice.body + suffix;
  }

  // Budget-driven loss must be visible to the reader, and the notice is itself budgeted.
  const noticeCost = REPLAY_OMISSION_NOTICE.length + 1;
  const withNotice = selectReplayTailWithinBudget(tailItems, tailBudget - noticeCost);
  return withNotice.body
    ? prefix + REPLAY_OMISSION_NOTICE + '\n' + withNotice.body + suffix
    : prefix + withoutNotice.body + suffix;
}
