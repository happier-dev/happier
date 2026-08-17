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
 * has a budget-loss vocabulary. Clipping happens at the END so the header
 * framing that marks this content as replayed, untrusted history always
 * survives, and the loss is stated with the builder's own truncation marker.
 * When not even that marker fits, the seed is dropped rather than emitted as a
 * headless fragment of history that would read as authored content.
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
  return truncateToBudget(seedText, budget) ?? '';
}

export function buildHappierReplayPromptFromDialog(params: Readonly<{
  previousSessionId: string;
  dialog: readonly HappierReplayDialogItem[];
  strategy: HappierReplayStrategy;
  recentMessagesCount: number;
  summaryText?: string | null;
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
  const buildPrefix = (summary: string | null): string => {
    const summaryLines = summary ? ['Summary:', summary, ''] : [];
    return [...buildHeaderLines(summary !== null), '', ...summaryLines, 'Recent transcript:'].join('\n') + '\n';
  };

  const effectiveSummary = strategy === 'summary_plus_recent' && summaryText
    ? defangReservedScaffoldMarkers(summaryText)
    : null;
  const suffix =
    '\n\nContinue from here. Treat the summary as the durable source of older context, and use the recent transcript as the latest tail. If important details are still missing, ask clarifying questions.';

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
    return buildPrefix(effectiveSummary) + tailLines.join('\n') + suffix;
  }

  // The structural frame carries the untrusted-content framing and is never cut; everything the
  // caller can grow — summary and transcript — shares whatever the frame leaves.
  const frameLength = buildPrefix(null).length + suffix.length;
  const contentBudget = maxPromptChars - frameLength;
  // A frame with no transcript under it is not a smaller seed, it is a lie: it announces
  // replayed context that is not there, and it is the one output that could exceed the total.
  // No seed is the honest result, and the sole caller already treats an empty draft as "no seed".
  if (contentBudget <= 0) return '';

  // The summary is durable older context but must not starve the recent tail, so it may claim at
  // most half of the content budget before the tail is filled from the remainder.
  const summaryBlockOverhead = 'Summary:\n'.length + '\n\n'.length;
  const summary = effectiveSummary
    ? truncateToBudget(effectiveSummary, Math.max(0, Math.floor(contentBudget / 2) - summaryBlockOverhead))
    : null;
  const prefix = buildPrefix(summary);
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
