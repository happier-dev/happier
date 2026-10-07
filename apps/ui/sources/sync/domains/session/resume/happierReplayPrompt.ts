import {
  HappierReplayRecentMessagesCountSchema,
  HappierReplayWritableMaxSeedCharsSchema,
} from '@happier-dev/protocol/sessions/replay-seed-budget';

import { settingsDefaults, type Settings } from '@/sync/domains/settings/settings';

export type HappierReplayStrategy = 'recent_messages' | 'summary_plus_recent';

function normalizeStrategy(value: unknown): HappierReplayStrategy {
  return value === 'summary_plus_recent' ? 'summary_plus_recent' : 'recent_messages';
}

/**
 * The exact settings this resolver reads. It is narrower than `Settings` on
 * purpose: transcript rows subscribe to only these four fields to keep render
 * locality, and requiring the whole settings object would force them to widen.
 */
export type HappierReplayConfigSource = Partial<Pick<
  Settings,
  'sessionReplayEnabled' | 'sessionReplayStrategy' | 'sessionReplayRecentMessagesCount' | 'sessionReplayMaxSeedChars'
>>;

export function resolveHappierReplayConfig(settings: HappierReplayConfigSource): Readonly<{
  enabled: boolean;
  strategy: HappierReplayStrategy;
  recentMessagesCount: number;
  maxSeedChars: number;
}> {
  const enabled = settings.sessionReplayEnabled === true;
  const strategy = normalizeStrategy(settings.sessionReplayStrategy);
  const recentMessagesCount = HappierReplayRecentMessagesCountSchema
    .catch(settingsDefaults.sessionReplayRecentMessagesCount)
    .parse(settings.sessionReplayRecentMessagesCount);
  const maxSeedChars = HappierReplayWritableMaxSeedCharsSchema
    .catch(settingsDefaults.sessionReplayMaxSeedChars)
    .parse(settings.sessionReplayMaxSeedChars);
  return { enabled, strategy, recentMessagesCount, maxSeedChars };
}
