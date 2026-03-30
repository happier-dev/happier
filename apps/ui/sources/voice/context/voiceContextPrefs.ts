import { readVoicePrivacySettings } from '@/sync/domains/settings/readVoicePrivacySettings';
import type { VoiceContextFormatterPrefs } from '@/voice/context/contextFormatters';
import { resolveVoiceSessionUpdatePolicy } from '@/voice/runtime/voiceUpdatePolicy';

function resolveVoicePrivacySettings(settings: unknown) {
  const privacy = readVoicePrivacySettings(settings);
  return {
    shareSessionSummary: privacy.shareSessionSummary,
    shareRecentMessages: privacy.shareRecentMessages,
    recentMessagesCount: privacy.recentMessagesCount,
    shareToolNames: privacy.shareToolNames,
    shareToolArgs: privacy.shareToolArgs,
    shareFilePaths: privacy.shareFilePaths,
  } as const;
}

export function getVoiceContextFormatterPrefs(params: Readonly<{
  settings: unknown;
  sessionId?: string | null;
  trackedSessionIds?: ReadonlyArray<string>;
}>): VoiceContextFormatterPrefs {
  const privacy = resolveVoicePrivacySettings(params.settings);
  const sessionId = typeof params.sessionId === 'string' ? params.sessionId.trim() : '';

  if (!sessionId) {
    return {
      voiceShareSessionSummary: privacy.shareSessionSummary,
      voiceShareRecentMessages: privacy.shareRecentMessages,
      voiceRecentMessagesCount: privacy.recentMessagesCount,
      voiceShareToolNames: privacy.shareToolNames,
      voiceShareToolArgs: privacy.shareToolArgs,
      voiceShareFilePaths: privacy.shareFilePaths,
    };
  }

  const level = resolveVoiceSessionUpdatePolicy({
    sessionId,
    settings: params.settings,
    trackedSessionIds: params.trackedSessionIds ?? [],
  }).level;
  const allowSummaries = level === 'summaries' || level === 'snippets';
  const allowSnippets = level === 'snippets';

  return {
    voiceShareSessionSummary: privacy.shareSessionSummary && allowSummaries,
    voiceShareRecentMessages: privacy.shareRecentMessages && allowSnippets,
    voiceRecentMessagesCount: privacy.recentMessagesCount,
    voiceShareToolNames: privacy.shareToolNames,
    voiceShareToolArgs: privacy.shareToolArgs,
    voiceShareFilePaths: privacy.shareFilePaths,
  };
}
