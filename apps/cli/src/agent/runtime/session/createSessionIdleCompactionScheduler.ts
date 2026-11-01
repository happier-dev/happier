import type { SessionInputLiveWork } from './input/_types';
import { randomUUID } from 'node:crypto';
import type { IdleCompactionPreference } from '@happier-dev/protocol/account/settings/accountSettings';
import type { AgentSessionRuntimeEventV1 } from '@happier-dev/protocol/runtime';
import { projectSessionLiveWorkItems, readSessionLiveWorkEligibility } from './input/sessionLiveWorkEligibility';

type SchedulerOptions = Readonly<{
  mode: 'host' | 'native' | undefined;
  preference: IdleCompactionPreference;
  signal: AbortSignal;
  compact?: (request: Readonly<{ compactionId: string; trigger: 'idle' }>, options: Readonly<{ signal: AbortSignal }>) => Promise<unknown>;
  readLiveWork(): Promise<SessionInputLiveWork>;
  onError?(error: unknown): void;
}>;
type AcceptedUsage = Extract<AgentSessionRuntimeEventV1, { kind: 'usage-observed' }>;
type Usage = Readonly<Pick<AcceptedUsage, 'promptCache'> & { context?: Pick<NonNullable<AcceptedUsage['context']>, 'usedTokens'> }>;

export function createSessionIdleCompactionScheduler(options: SchedulerOptions) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let promptCache: Usage['promptCache'];
  let contextSize: number | undefined;
  let consumedIdlePeriod = false;
  let disposed = false;
  const clear = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  return {
    observeUsage(usage: Usage): void {
      if (!usage.promptCache && !usage.context) return;
      if (usage.promptCache) promptCache = usage.promptCache;
      if (usage.context) contextSize = usage.context.usedTokens;
      clear();
      const cache = promptCache;
      const window = options.preference.cacheWindowOverrideMs ?? cache?.ttlMs;
      const minimum = options.preference.minContextTokens;
      if (disposed || consumedIdlePeriod || options.mode !== 'host' || !options.preference.enabled || !options.compact
        || !cache || window === undefined
        || contextSize === undefined || (minimum !== undefined && contextSize < minimum)) return;
      const deadline = cache.lastUseAtMs + 0.9 * window;
      timer = setTimeout(() => {
        timer = undefined;
        promptCache = undefined;
        if (disposed || Date.now() - deadline > 60_000) return;
        void (async () => {
          const activity = await options.readLiveWork();
          if (disposed || options.signal.aborted || consumedIdlePeriod || !readSessionLiveWorkEligibility([
            ...projectSessionLiveWorkItems(activity),
            { category: 'session', state: activity.nativeRuntimeActivity ?? 'unknown' },
          ]).eligible) return;
          consumedIdlePeriod = true;
          await options.compact!({ compactionId: `host-idle-compact-${randomUUID()}`, trigger: 'idle' }, { signal: options.signal });
        })().catch(error => options.onError?.(error));
      }, Math.max(0, deadline - Date.now()));
    },
    notifyForegroundActivity(): void { consumedIdlePeriod = false; },
    dispose(): void { disposed = true; clear(); },
  };
}
