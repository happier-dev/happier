import { storage } from '@/sync/domains/state/storage';
import { formatSessionFull } from '@/realtime/hooks/contextFormatters';

function getVoiceContextPrefs() {
  const settings = storage.getState().settings as any;
  return {
    voiceShareSessionSummary: settings.voiceShareSessionSummary,
    voiceShareRecentMessages: settings.voiceShareRecentMessages,
    voiceRecentMessagesCount: settings.voiceRecentMessagesCount,
    voiceShareToolNames: settings.voiceShareToolNames,
    voiceShareFilePaths: settings.voiceShareFilePaths,
  };
}

export function buildVoiceInitialContext(sessionId: string): string {
  const session = (storage.getState() as any).sessions?.[sessionId] ?? null;
  if (!session) return '';
  const messages = (storage.getState() as any).sessionMessages?.[sessionId]?.messages ?? [];
  return `THIS IS AN ACTIVE SESSION:\n\n${formatSessionFull(session, messages, getVoiceContextPrefs())}`;
}

