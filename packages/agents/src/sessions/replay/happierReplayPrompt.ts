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

export function buildHappierReplayPromptFromDialog(params: Readonly<{
  previousSessionId: string;
  dialog: readonly HappierReplayDialogItem[];
  strategy: HappierReplayStrategy;
  recentMessagesCount: number;
  summaryText?: string | null;
  /**
   * Best-effort cap on the total replay seed prompt size.
   *
   * When provided, the builder will shrink the `Recent transcript:` tail (dropping the oldest
   * items first) until the total prompt length fits under this budget.
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

  const headerLines = [
    'This session is continuing from a previous Happy session that could not be vendor-resumed.',
    'The app is replaying recent transcript messages for context.',
    strategy === 'summary_plus_recent' && summaryText
      ? 'The summary below is the authoritative condensed context from earlier transcript history.'
      : null,
    strategy === 'summary_plus_recent' && summaryText
      ? 'The recent transcript is only the tail and may omit older important details.'
      : null,
    previousSessionId ? `Previous session id: ${previousSessionId}` : null,
  ].filter(Boolean);
  const summaryLines =
    strategy === 'summary_plus_recent' && summaryText
      ? ['Summary:', summaryText, '']
      : [];

  const prefix = [...headerLines, '', ...summaryLines, 'Recent transcript:'].join('\n') + '\n';
  const suffix =
    '\n\nContinue from here. Treat the summary as the durable source of older context, and use the recent transcript as the latest tail. If important details are still missing, ask clarifying questions.';

  const tailLines = boundedByCount.map((item) => `${item.role}: ${item.text}`);

  if (!maxPromptChars) {
    return prefix + tailLines.join('\n') + suffix;
  }

  const prefixLen = prefix.length;
  const suffixLen = suffix.length;
  const available = maxPromptChars - prefixLen - suffixLen;
  // If the budget is too small, still include at least one line.
  if (available <= 0) {
    const last = tailLines[tailLines.length - 1];
    return prefix + last + suffix;
  }

  let used = 0;
  const kept: string[] = [];
  for (let i = tailLines.length - 1; i >= 0; i -= 1) {
    const line = tailLines[i];
    const cost = (kept.length === 0 ? 0 : 1) + line.length; // + newline if not first kept
    if (kept.length > 0 && used + cost > available) break;
    if (kept.length === 0 && line.length > available) {
      // Single line doesn't fit; include it anyway (best-effort).
      kept.push(line);
      break;
    }
    if (used + cost > available) break;
    used += cost;
    kept.push(line);
  }
  kept.reverse();
  const finalTail = kept.length > 0 ? kept.join('\n') : tailLines[tailLines.length - 1];
  return prefix + finalTail + suffix;
}
