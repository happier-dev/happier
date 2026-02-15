import { storage } from '@/sync/domains/state/storage';
import { useVoiceTargetStore } from '@/voice/runtime/voiceTargetStore';

export type VoiceUpdateLevel = 'none' | 'activity' | 'summaries' | 'snippets';

export type VoiceSessionUpdatePolicy = Readonly<{
  level: VoiceUpdateLevel;
  isTrackedSession: boolean;
  includeUserMessagesInSnippets: boolean;
  snippetsMaxMessages: number;
}>;

function clampInt(value: unknown, { min, max, fallback }: { min: number; max: number; fallback: number }): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const rounded = Math.floor(value);
  if (rounded < min) return min;
  if (rounded > max) return max;
  return rounded;
}

function normalizeUpdateLevel(value: unknown, fallback: VoiceUpdateLevel): VoiceUpdateLevel {
  if (value === 'none' || value === 'activity' || value === 'summaries' || value === 'snippets') return value;
  return fallback;
}

export function resolveVoiceSessionUpdatePolicy(params: Readonly<{
  sessionId: string;
  settings: unknown;
  trackedSessionIds: ReadonlyArray<string>;
}>): VoiceSessionUpdatePolicy {
  const settings = (params.settings ?? {}) as any;
  const updates = settings?.voice?.ui?.updates ?? {};

  const activeLevel = normalizeUpdateLevel(updates.activeSession, 'summaries');
  const otherLevel = normalizeUpdateLevel(updates.otherSessions, 'activity');
  const otherSnippetsMode = String(updates.otherSessionsSnippetsMode ?? 'on_demand_only');

  const isTrackedSession = params.trackedSessionIds.includes(params.sessionId);
  const baseLevel = isTrackedSession ? activeLevel : otherLevel;

  const level = (!isTrackedSession && baseLevel === 'snippets' && otherSnippetsMode !== 'auto')
    ? 'summaries'
    : baseLevel;

  return {
    level,
    isTrackedSession,
    includeUserMessagesInSnippets: updates.includeUserMessagesInSnippets === true,
    snippetsMaxMessages: clampInt(updates.snippetsMaxMessages, { min: 1, max: 10, fallback: 3 }),
  };
}

export function getVoiceSessionUpdatePolicy(sessionId: string): VoiceSessionUpdatePolicy {
  const trackedSessionIds = useVoiceTargetStore.getState().trackedSessionIds;
  return resolveVoiceSessionUpdatePolicy({
    sessionId,
    settings: storage.getState().settings,
    trackedSessionIds,
  });
}
