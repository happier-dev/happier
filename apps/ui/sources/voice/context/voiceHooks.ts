import {
  formatNewMessages,
  formatPermissionRequest,
  formatReadyEvent,
  formatSessionFocus,
  formatSessionFull,
  formatSessionOffline,
  formatSessionOnline,
} from './contextFormatters';
import { storage } from '@/sync/domains/state/storage';
import type { Message } from '@/sync/domains/messages/messageTypes';
import { VOICE_CONFIG } from '@/voice/runtime/voiceConfig';
import { getVoiceContextSinkForSession } from '@/voice/context/getVoiceContextSinkForSession';
import { useVoiceContextSeenStore } from '@/voice/runtime/voiceContextSeenStore';
import { useVoiceTargetStore } from '@/voice/runtime/voiceTargetStore';
import { resolveVoiceSessionUpdatePolicy, type VoiceSessionUpdatePolicy } from '@/voice/runtime/voiceUpdatePolicy';

/**
 * Centralized voice assistant hooks for multi-session context updates.
 *
 * These hooks route app events to the active voice context sink (realtime voice session, or local agent).
 */

interface SessionMetadata {
  summary?: { text?: string };
  path?: string;
  machineId?: string;
  [key: string]: any;
}

function resolvePolicy(sessionId: string): VoiceSessionUpdatePolicy {
  // NOTE: we deliberately avoid a session-scoped API here; global voice uses explicit target.
  const store = useVoiceTargetStore.getState();

  return resolveVoiceSessionUpdatePolicy({
    sessionId,
    settings: storage.getState().settings,
    trackedSessionIds: store.trackedSessionIds,
  });
}

function getVoiceContextPrefs(sessionId: string) {
  const settings = storage.getState().settings as any;
  const privacy = settings?.voice?.privacy ?? {};
  const level = resolvePolicy(sessionId).level;
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

function reportContextualUpdate(sessionId: string, update: string | null | undefined) {
  if (VOICE_CONFIG.ENABLE_DEBUG_LOGGING) {
    // eslint-disable-next-line no-console
    console.log('🎤 Voice: Reporting contextual update:', update);
  }
  if (!update) return;
  const sink = getVoiceContextSinkForSession(sessionId);
  if (!sink) return;
  sink.sendContextualUpdate(sessionId, update);
}

function reportTextUpdate(sessionId: string, update: string | null | undefined) {
  if (VOICE_CONFIG.ENABLE_DEBUG_LOGGING) {
    // eslint-disable-next-line no-console
    console.log('🎤 Voice: Reporting text update:', update);
  }
  if (!update) return;
  const sink = getVoiceContextSinkForSession(sessionId);
  if (!sink) return;
  sink.sendTextMessage(sessionId, update);
}

function reportSession(sessionId: string) {
  const seen = useVoiceContextSeenStore.getState();
  if (seen.hasShownSession(sessionId)) return;
  const level = resolvePolicy(sessionId).level;
  if (level !== 'summaries' && level !== 'snippets') return;
  const session = (storage.getState() as any).sessions?.[sessionId];
  if (!session) return;
  const messages = (storage.getState() as any).sessionMessages?.[sessionId]?.messages ?? [];
  const contextUpdate = formatSessionFull(session, messages, getVoiceContextPrefs(sessionId));
  reportContextualUpdate(sessionId, contextUpdate);
  // Mark as shown only once we've actually emitted the full context.
  seen.markSessionShown(sessionId);
}

function formatNewMessagesActivity(sessionId: string, messages: Message[]): string {
  const count = Array.isArray(messages) ? messages.length : 0;
  const plural = count === 1 ? '' : 's';
  return `New messages in session: ${sessionId}\n\n(${count} new message${plural})`;
}

export const voiceHooks = {
  onSessionOnline(sessionId: string, metadata?: SessionMetadata) {
    if (VOICE_CONFIG.DISABLE_SESSION_STATUS) return;
    if (resolvePolicy(sessionId).level === 'none') return;

    reportSession(sessionId);
    const contextUpdate = formatSessionOnline(sessionId, metadata);
    reportContextualUpdate(sessionId, contextUpdate);
  },

  onSessionOffline(sessionId: string, metadata?: SessionMetadata) {
    if (VOICE_CONFIG.DISABLE_SESSION_STATUS) return;
    if (resolvePolicy(sessionId).level === 'none') return;

    reportSession(sessionId);
    const contextUpdate = formatSessionOffline(sessionId, metadata);
    reportContextualUpdate(sessionId, contextUpdate);
  },

  onSessionFocus(sessionId: string, metadata?: SessionMetadata) {
    if (VOICE_CONFIG.DISABLE_SESSION_FOCUS) return;
    useVoiceTargetStore.getState().setLastFocusedSessionId(sessionId);

    // This is used as an activity signal; it does not override the active target.
    if (resolvePolicy(sessionId).level === 'none') return;
    reportSession(sessionId);
    reportContextualUpdate(sessionId, formatSessionFocus(sessionId, metadata));
  },

  onPermissionRequested(sessionId: string, requestId: string, toolName: string, toolArgs: any) {
    if (VOICE_CONFIG.DISABLE_PERMISSION_REQUESTS) return;
    if (storage.getState().settings?.voice?.privacy?.sharePermissionRequests === false) return;

    reportSession(sessionId);
    reportTextUpdate(sessionId, formatPermissionRequest(sessionId, requestId, toolName, toolArgs, getVoiceContextPrefs(sessionId)));
  },

  onMessages(sessionId: string, messages: Message[]) {
    if (VOICE_CONFIG.DISABLE_MESSAGES) return;
    const policy = resolvePolicy(sessionId);
    const level = policy.level;
    if (level === 'none') return;

    // "shareRecentMessages" gates transcript/snippet sharing; activity updates remain allowed.
    const shareRecentMessages = storage.getState().settings?.voice?.privacy?.shareRecentMessages !== false;

    if (level === 'activity') {
      reportContextualUpdate(sessionId, formatNewMessagesActivity(sessionId, messages));
      return;
    }

    reportSession(sessionId);
    if (level === 'summaries') {
      reportContextualUpdate(sessionId, formatNewMessagesActivity(sessionId, messages));
      return;
    }

    if (!shareRecentMessages) {
      reportContextualUpdate(sessionId, formatNewMessagesActivity(sessionId, messages));
      return;
    }

    const filtered = (Array.isArray(messages) ? messages : [])
      .filter((m) => m && typeof m === 'object')
      .filter((m) => policy.includeUserMessagesInSnippets || m.kind !== 'user-text')
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(-policy.snippetsMaxMessages);

    if (filtered.length === 0) {
      reportContextualUpdate(sessionId, formatNewMessagesActivity(sessionId, messages));
      return;
    }

    reportContextualUpdate(sessionId, formatNewMessages(sessionId, filtered, getVoiceContextPrefs(sessionId)));
  },

  onVoiceStarted(sessionId: string): string {
    if (VOICE_CONFIG.ENABLE_DEBUG_LOGGING) {
      // eslint-disable-next-line no-console
      console.log('🎤 Voice session started for:', sessionId);
    }
    useVoiceContextSeenStore.getState().clearShownSessions();
    const state: any = storage.getState();
    const normalized = String(sessionId ?? '').trim();

    if (!normalized) {
      return (
        'VOICE SESSION STARTED\n\n' +
        '<session_context>none</session_context>\n' +
        'No session is currently tracked. Use tools to discover sessions and request the sessionId explicitly before acting.'
      );
    }

    const session = state.sessions?.[normalized] ?? null;
    if (!session) {
      return (
        'VOICE SESSION STARTED\n\n' +
        `<session_id>${normalized}</session_id>\n` +
        '<session_not_found>true</session_not_found>\n' +
        'Use tools to list sessions and select a valid sessionId.'
      );
    }

    const prompt =
      'THIS IS AN ACTIVE SESSION: \n\n' +
      formatSessionFull(session, state.sessionMessages?.[normalized]?.messages ?? [], getVoiceContextPrefs(normalized));
    useVoiceContextSeenStore.getState().markSessionShown(normalized);
    return prompt;
  },

  onReady(sessionId: string) {
    if (VOICE_CONFIG.DISABLE_READY_EVENTS) return;

    reportSession(sessionId);
    reportTextUpdate(sessionId, formatReadyEvent(sessionId));
  },

  onVoiceStopped() {
    if (VOICE_CONFIG.ENABLE_DEBUG_LOGGING) {
      // eslint-disable-next-line no-console
      console.log('🎤 Voice session stopped');
    }
    useVoiceContextSeenStore.getState().clearShownSessions();
  },
};
