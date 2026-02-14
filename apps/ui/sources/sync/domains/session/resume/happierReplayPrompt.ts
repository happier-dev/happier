import type { Settings } from '@/sync/domains/settings/settings';

export type HappierReplayStrategy = 'recent_messages' | 'summary_plus_recent';

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

export function resolveHappierReplayConfig(settings: Settings): Readonly<{
  enabled: boolean;
  strategy: HappierReplayStrategy;
  recentMessagesCount: number;
}> {
  const enabled = settings.sessionReplayEnabled === true;
  const strategy = normalizeStrategy(settings.sessionReplayStrategy);
  const recentMessagesCount = normalizePositiveInt(settings.sessionReplayRecentMessagesCount, 16, { min: 1, max: 100 });
  return { enabled, strategy, recentMessagesCount };
}
