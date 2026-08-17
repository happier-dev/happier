export type HappierReplayStrategy = 'recent_messages' | 'summary_plus_recent';

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
const RESERVED_SCAFFOLD_MARKERS = ['Recent transcript:', 'Summary:'] as const;

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
 * budget-loss vocabulary. Clipping happens at the END so the header framing that
 * marks this content as replayed, untrusted history always survives, and the
 * loss is stated with the same omission notice the builder uses.
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

  const noticeCost = REPLAY_OMISSION_NOTICE.length + 1;
  // Not even the notice fits: emit as much of it as the budget allows rather
  // than a headless fragment of history that reads as authored content.
  if (budget <= noticeCost) return REPLAY_OMISSION_NOTICE.slice(0, budget);
  return `${clipToBudget(seedText, budget - noticeCost)}\n${REPLAY_OMISSION_NOTICE}`;
}

export function buildHappierReplayPromptFromDialog(params: Readonly<{
  previousSessionId: string;
  dialog: readonly HappierReplayDialogItem[];
  strategy: HappierReplayStrategy;
  recentMessagesCount: number;
  summaryText?: string | null;
  /**
   * Hard cap on the TOTAL replay seed prompt size.
   *
   * Every part the builder emits — header, summary, omission notice, transcript tail and
   * footer — is spent from this budget, and the returned string never exceeds it. The
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
      'This session is continuing from a previous Happy session that could not be vendor-resumed.',
      'The app is replaying recent transcript messages for context.',
      includesSummary
        ? 'The summary below is the authoritative condensed context from earlier transcript history.'
        : null,
      includesSummary
        ? 'The recent transcript is only the tail and may omit older important details.'
        : null,
      previousSessionId ? `Previous session id: ${previousSessionId}` : null,
    ].filter((line): line is string => Boolean(line));
  const summaryLines =
    strategy === 'summary_plus_recent' && summaryText
      ? ['Summary:', defangReservedScaffoldMarkers(summaryText), '']
      : [];

  const buildPrefix = (summary: readonly string[]): string =>
    [...buildHeaderLines(summary.length > 0), '', ...summary, 'Recent transcript:'].join('\n') + '\n';
  const suffix =
    '\n\nContinue from here. Treat the summary as the durable source of older context, and use the recent transcript as the latest tail. If important details are still missing, ask clarifying questions.';

  // Escape before the budget is measured: escaping changes a line's length, so counting the raw
  // text would let the escaped prompt exceed the total cap.
  const tailItems: ReplayTailItem[] = boundedByCount.map((item) => ({
    rolePrefix: `${item.role}: `,
    text: escapeUntrustedHistoryText(item.text),
  }));
  const tailLines = tailItems.map((item) => item.rolePrefix + item.text);

  if (!maxPromptChars) {
    return buildPrefix(summaryLines) + tailLines.join('\n') + suffix;
  }

  const framingLen = buildPrefix([]).length + suffix.length;
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

  let resolvedSummaryLines: readonly string[] = [];
  if (summaryLines.length > 0 && summaryText) {
    const summaryOverhead = buildPrefix(['Summary:', '', '']).length - buildPrefix([]).length;
    const summaryBudget = maxPromptChars - framingLen - newestReserve - summaryOverhead;
    const clippedSummary = clipToBudget(summaryText, summaryBudget);
    if (clippedSummary) resolvedSummaryLines = ['Summary:', clippedSummary, ''];
  }

  const prefix = buildPrefix(resolvedSummaryLines);
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
