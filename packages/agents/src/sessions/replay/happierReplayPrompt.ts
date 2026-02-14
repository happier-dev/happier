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
  const max = opts?.max ?? 200;
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
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
}>): string {
  const previousSessionId = String(params.previousSessionId ?? '').trim();
  const recentMessagesCount = normalizePositiveInt(params.recentMessagesCount, 16, { min: 1, max: 100 });
  const strategy = normalizeStrategy(params.strategy);

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
  const tail = dialog.length > recentMessagesCount ? dialog.slice(dialog.length - recentMessagesCount) : dialog;
  if (tail.length === 0) return '';

  const lines: string[] = [];
  lines.push(
    [
      'This session is continuing from a previous Happy session that could not be vendor-resumed.',
      'The app is replaying recent transcript messages for context.',
      previousSessionId ? `Previous session id: ${previousSessionId}` : null,
    ]
      .filter(Boolean)
      .join('\n'),
  );
  lines.push('');

  if (strategy === 'summary_plus_recent') {
    // Future: insert a compact summary block before recent messages.
    // For now, fall back to recent_messages to keep behavior predictable.
  }

  lines.push('Recent transcript:');
  for (const item of tail) {
    lines.push(`${item.role}: ${item.text}`);
  }
  lines.push('');
  lines.push('Continue from here. If important details are missing, ask clarifying questions.');
  return lines.join('\n');
}

