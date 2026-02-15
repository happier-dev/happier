import { storage } from '@/sync/domains/state/storage';
import { formatSessionFull } from '@/voice/context/contextFormatters';

function getVoiceContextPrefs() {
  const settings = storage.getState().settings as any;
  const privacy = settings?.voice?.privacy ?? {};
  return {
    voiceShareSessionSummary: privacy.shareSessionSummary,
    voiceShareRecentMessages: privacy.shareRecentMessages,
    voiceRecentMessagesCount: privacy.recentMessagesCount,
    voiceShareToolNames: privacy.shareToolNames,
    voiceShareToolArgs: privacy.shareToolArgs,
    voiceShareFilePaths: privacy.shareFilePaths,
  };
}

export function buildVoiceInitialContext(sessionId: string): string {
  const session = (storage.getState() as any).sessions?.[sessionId] ?? null;
  if (!session) return '';
  const messages = (storage.getState() as any).sessionMessages?.[sessionId]?.messages ?? [];
  return `THIS IS AN ACTIVE SESSION:\n\n${formatSessionFull(session, messages, getVoiceContextPrefs())}`;
}
