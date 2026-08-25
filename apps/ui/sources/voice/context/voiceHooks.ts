import {
  formatNewMessages,
  formatUserActionRequest,
  formatPermissionRequest,
  formatReadyEvent,
  formatSessionFull,
  formatSessionOffline,
  formatSessionOnline,
  summarizeMessagesForVoiceHuman,
  summarizeAgentRequestForVoiceHuman,
} from './contextFormatters';
import type { Message } from '@/sync/domains/messages/messageTypes';
import { readStoredSessionMessages } from '@/sync/domains/messages/readStoredSessionMessages';
import { storage } from '@/sync/domains/state/storage';
import { readVoicePrivacySettings } from '@/sync/domains/settings/readVoicePrivacySettings';
import { VOICE_CONFIG } from '@/voice/runtime/voiceConfig';
import { getVoiceContextSinkForSession } from '@/voice/context/getVoiceContextSinkForSession';
import type { VoiceContextSink } from '@/voice/context/VoiceContextSink';
import { resolveEffectiveVoiceTargetState } from '@/voice/context/resolveEffectiveVoiceTargetState';
import { getVoiceContextFormatterPrefs } from '@/voice/context/voiceContextPrefs';
import { useVoiceTargetStore } from '@/voice/runtime/voiceTargetStore';
import { resolveVoiceSessionUpdatePolicy, type VoiceSessionUpdatePolicy } from '@/voice/runtime/voiceUpdatePolicy';
import type { AgentRequestKind } from '@/utils/sessions/permissions/permissionPromptPolicy';
import { resolveVoiceContextSessionFromState } from '@/voice/context/resolveVoiceContextSession';
import type { CurrentUiContextSnapshotV1 } from '@happier-dev/protocol/plugins/ui';
import type { HostAuthoredContextClass, VoiceHostAuthoredContextScope } from '@/voice/session/types';

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

/** Full session context already disclosed during the current Voice attempt. */
const voiceAttemptShownSessionIds = new Set<string>();

type VoiceDebugEvent =
  | 'voice_contextual_update'
  | 'voice_text_update'
  | 'voice_session_started'
  | 'voice_session_stopped';

function emitVoiceDebugDiagnostic(
  event: VoiceDebugEvent,
  params: Readonly<{
    sessionId?: string | null;
    payload?: string | null | undefined;
  }>,
) {
  if (!VOICE_CONFIG.ENABLE_DEBUG_LOGGING) return;

  const payload = typeof params.payload === 'string' ? params.payload : '';
  const normalizedSessionId = String(params.sessionId ?? '').trim();

  // Keep diagnostics content-safe so broad console shipping cannot exfiltrate raw voice context.
  // eslint-disable-next-line no-console
  console.debug('[VoiceDebug]', {
    channel: 'voice',
    event,
    sessionId: normalizedSessionId.length > 0 ? normalizedSessionId : null,
    payloadChars: payload.length,
    payloadLines: payload.length > 0 ? payload.split('\n').length : 0,
    hasPayload: payload.length > 0,
  });
}

function resolvePolicy(sessionId: string): VoiceSessionUpdatePolicy {
  // NOTE: we deliberately avoid a session-scoped API here; global voice uses explicit target.
  const targetState = resolveEffectiveVoiceTargetState(sessionId);

  return resolveVoiceSessionUpdatePolicy({
    sessionId,
    settings: storage.getState().settings,
    trackedSessionIds: targetState.trackedSessionIds,
  });
}

/**
 * The single authority over ambient disclosure caused by observing this
 * device's UI. The current-UI subscription is the only automatic disclosure
 * path: `off` and `on_demand` withhold it, while `automatic` admits only its
 * bounded navigation projection.
 */
function isAmbientCurrentUiDisclosureEnabled(): boolean {
  return readVoicePrivacySettings(storage.getState().settings).currentUiContextMode === 'automatic';
}

function getVoiceContextPrefs(sessionId: string) {
  const settings = storage.getState().settings;
  const targetState = resolveEffectiveVoiceTargetState(sessionId);
  return getVoiceContextFormatterPrefs({
    sessionId,
    settings,
    trackedSessionIds: targetState.trackedSessionIds,
  });
}

/**
 * The single host-authored context disclosure decision. A `current_ui_only`
 * sink attaches to an Agent runtime that already owns the conversation's
 * prompt and content, so stored-session context never reaches it through any
 * transport the sink happens to offer.
 */
function sinkAcceptsHostAuthoredContext(
  sink: VoiceContextSink,
  contextClass: HostAuthoredContextClass,
): boolean {
  return !(contextClass === 'session_context' && sink.hostAuthoredContext === 'current_ui_only');
}

/** Returns whether an active context sink actually received the update. */
function reportContextualUpdate(
  sessionId: string,
  update: string | null | undefined,
  contextClass: HostAuthoredContextClass,
): boolean {
  emitVoiceDebugDiagnostic('voice_contextual_update', { sessionId, payload: update });
  if (!update) return false;
  const sink = getVoiceContextSinkForSession(sessionId);
  if (!sink) return false;
  if (!sinkAcceptsHostAuthoredContext(sink, contextClass)) return false;
  sink.sendContextualUpdate(sessionId, update, contextClass);
  return true;
}

/**
 * Automatic UI updates intentionally contain only the provider-composed
 * navigation projection. Mounted entity/detail records and opaque command
 * descriptors remain on-demand tool data, never ambient voice context.
 */
function formatCurrentUiNavigationUpdate(snapshot: CurrentUiContextSnapshotV1): string {
  const navigation = snapshot.navigation;
  // Session titles can contain session summaries or path-derived fallback
  // text, and machine titles are device identity. They remain available to an
  // explicit current-UI read, but are never ambient automatic metadata.
  const hasAutomaticSafeTitle = navigation.title !== undefined
    && navigation.area !== 'plugin'
    && navigation.screen !== 'settings.plugin_page'
    && navigation.area !== 'session'
    && navigation.area !== 'machine';
  return `CURRENT UI CONTEXT\n\n${JSON.stringify({ navigation: {
    area: navigation.area,
    screen: navigation.screen,
    ...(navigation.presentation === undefined ? {} : { presentation: navigation.presentation }),
    // Plugin page labels are useful in an explicit current-UI read, but are
    // plugin-provided text and must not cross the automatic provider channel.
    // The composer preserves external plugin Settings title provenance through
    // this host-owned semantic screen without exposing page identity or text.
    ...(hasAutomaticSafeTitle ? { title: navigation.title } : {}),
  } })}`;
}

/**
 * An automatic-update projector is deliberately created by the exact Voice
 * attempt owner. It remembers only that attempt's last delivered metadata
 * projection: no module-global registry can make a later attempt inherit a
 * prior attempt's context, and retirement is an ordinary one-shot transition.
 */
export type CurrentUiContextAutomaticUpdateProjector = Readonly<{
  project: (snapshot: CurrentUiContextSnapshotV1 | null) => string | null;
  markDelivered: (update: string) => void;
}>;

export function createCurrentUiContextAutomaticUpdateProjector(): CurrentUiContextAutomaticUpdateProjector {
  const unavailableUpdate = 'CURRENT UI CONTEXT\n\n{"navigation":{"state":"unavailable"}}';
  let lastDeliveredProjection: string | null = null;
  return Object.freeze({
    project(snapshot) {
      const nextProjection = snapshot === null
        ? (lastDeliveredProjection === null ? null : unavailableUpdate)
        : formatCurrentUiNavigationUpdate(snapshot);
      return nextProjection === lastDeliveredProjection ? null : nextProjection;
    },
    markDelivered(update) {
      lastDeliveredProjection = update;
    },
  });
}

function reportTextUpdate(sessionId: string, update: string | null | undefined) {
  emitVoiceDebugDiagnostic('voice_text_update', { sessionId, payload: update });
  if (!update) return;
  const sink = getVoiceContextSinkForSession(sessionId);
  if (!sink) return;
  sink.sendTextMessage(sessionId, update);
}

function reportAnnouncedSessionUpdate(sessionId: string, update: string | null | undefined) {
  if (!update) return;
  const sink = getVoiceContextSinkForSession(sessionId);
  if (!sink) return;
  // An announcement carries stored-session text, so the text-turn transport
  // below is bound by the same disclosure decision as the context channel.
  if (!sinkAcceptsHostAuthoredContext(sink, 'session_context')) return;

  if (sink.announceAssistantText) {
    reportContextualUpdate(sessionId, update, 'session_context');
    return;
  }

  sink.sendTextMessage(sessionId, update);
}

function announceAssistantText(sessionId: string, update: string | null | undefined) {
  if (!update) return;
  const sink = getVoiceContextSinkForSession(sessionId);
  if (!sink || !sinkAcceptsHostAuthoredContext(sink, 'session_context')) return;
  sink.announceAssistantText?.(sessionId, update);
}

function reportSession(sessionId: string) {
  const normalizedSessionId = String(sessionId ?? '').trim();
  if (normalizedSessionId.length > 0 && voiceAttemptShownSessionIds.has(normalizedSessionId)) return;
  const level = resolvePolicy(sessionId).level;
  if (level !== 'summaries' && level !== 'snippets') return;
  const session = resolveVoiceContextSessionFromState(sessionId, storage.getState());
  if (!session) return;
  const messages = readStoredSessionMessages(storage.getState(), sessionId);
  const contextUpdate = formatSessionFull(session, messages, getVoiceContextPrefs(sessionId));
  reportContextualUpdate(sessionId, contextUpdate, 'session_context');
  // Mark as shown only once we've actually emitted the full context.
  if (normalizedSessionId.length > 0) voiceAttemptShownSessionIds.add(normalizedSessionId);
}

function formatNewMessagesActivity(sessionId: string, messages: Message[]): string {
  const count = Array.isArray(messages) ? messages.length : 0;
  const plural = count === 1 ? '' : 's';
  return `New messages in session: ${sessionId}\n\n(${count} new message${plural})`;
}

function isPrimaryActionSession(sessionId: string): boolean {
  return resolveEffectiveVoiceTargetState(sessionId).primaryActionSessionId === sessionId;
}

function filterMessagesForVoiceUpdate(messages: Message[], policy: VoiceSessionUpdatePolicy): Message[] {
  return (Array.isArray(messages) ? messages : [])
    .filter((m) => m && typeof m === 'object')
    .filter((m) => policy.includeUserMessagesInSnippets || m.kind !== 'user-text')
    .sort((a, b) => a.createdAt - b.createdAt)
    .slice(-policy.snippetsMaxMessages);
}

function shouldInterruptForAssistantReply(
  sessionId: string,
  messages: Message[],
  policy: VoiceSessionUpdatePolicy,
  shareRecentMessages: boolean,
): boolean {
  if (!shareRecentMessages) return false;
  if (!isPrimaryActionSession(sessionId)) return false;
  if (policy.level !== 'summaries' && policy.level !== 'snippets') return false;
  return summarizeMessagesForVoiceHuman(Array.isArray(messages) ? messages : [], getVoiceContextPrefs(sessionId)) !== null;
}

export const voiceHooks = {
  onCurrentUiContextChanged(
    sessionId: string,
    snapshot: CurrentUiContextSnapshotV1 | null,
    automaticUpdateProjector: CurrentUiContextAutomaticUpdateProjector,
  ) {
    if (!isAmbientCurrentUiDisclosureEnabled()) return;
    const update = automaticUpdateProjector.project(snapshot);
    if (!update) return;
    // Remember it only once a sink took it, so an update composed while no
    // context channel is attached does not suppress the next real transition.
    if (!reportContextualUpdate(sessionId, update, 'current_ui')) return;
    automaticUpdateProjector.markDelivered(update);
  },

  onSessionOnline(sessionId: string, metadata?: SessionMetadata) {
    if (VOICE_CONFIG.DISABLE_SESSION_STATUS) return;
    if (resolvePolicy(sessionId).level === 'none') return;

    reportSession(sessionId);
    const contextUpdate = formatSessionOnline(sessionId, metadata, getVoiceContextPrefs(sessionId));
    reportContextualUpdate(sessionId, contextUpdate, 'session_context');
  },

  onSessionOffline(sessionId: string, metadata?: SessionMetadata) {
    if (VOICE_CONFIG.DISABLE_SESSION_STATUS) return;
    if (resolvePolicy(sessionId).level === 'none') return;

    reportSession(sessionId);
    const contextUpdate = formatSessionOffline(sessionId, metadata, getVoiceContextPrefs(sessionId));
    reportContextualUpdate(sessionId, contextUpdate, 'session_context');
  },

  onSessionFocus(sessionId: string, _metadata?: SessionMetadata) {
    // Focus is a local target signal first: it selects this device's voice
    // target and does not override an explicit active target. That selection
    // never leaves the device, so no disclosure setting governs it.
    useVoiceTargetStore.getState().setLastFocusedSessionId(sessionId);

    // The CurrentUiContextProvider observes the same foreground transition
    // and is the sole automatic delivery owner. Do not turn a focus callback
    // into a second path that serializes session summaries, transcripts, paths,
    // or machine identity to a provider.
  },

  onAgentRequest(sessionId: string, requestId: string, requestKind: AgentRequestKind, toolName: string, toolArgs: any) {
    if (VOICE_CONFIG.DISABLE_PERMISSION_REQUESTS) return;
    if (!readVoicePrivacySettings(storage.getState().settings).sharePermissionRequests) return;

    reportSession(sessionId);
    announceAssistantText(
      sessionId,
      summarizeAgentRequestForVoiceHuman(requestKind, requestId, toolName, toolArgs, getVoiceContextPrefs(sessionId)),
    );
    reportAnnouncedSessionUpdate(
      sessionId,
      requestKind === 'user_action'
        ? formatUserActionRequest(sessionId, requestId, toolName, toolArgs, getVoiceContextPrefs(sessionId))
        : formatPermissionRequest(sessionId, requestId, toolName, toolArgs, getVoiceContextPrefs(sessionId)),
    );
  },

  onMessages(sessionId: string, messages: Message[]) {
    if (VOICE_CONFIG.DISABLE_MESSAGES) return;
    const policy = resolvePolicy(sessionId);
    const level = policy.level;
    if (level === 'none') return;

    // "shareRecentMessages" gates transcript/snippet sharing; activity updates remain allowed.
    const shareRecentMessages = readVoicePrivacySettings(storage.getState().settings).shareRecentMessages;

    if (level === 'activity') {
      reportContextualUpdate(sessionId, formatNewMessagesActivity(sessionId, messages), 'session_context');
      return;
    }

    reportSession(sessionId);
    if (shouldInterruptForAssistantReply(sessionId, messages, policy, shareRecentMessages)) {
      const filtered = filterMessagesForVoiceUpdate(messages, policy);
      if (filtered.length > 0) {
        announceAssistantText(sessionId, summarizeMessagesForVoiceHuman(filtered, getVoiceContextPrefs(sessionId)));
        reportAnnouncedSessionUpdate(sessionId, formatNewMessages(sessionId, filtered, getVoiceContextPrefs(sessionId)));
        return;
      }
    }

    if (level === 'summaries') {
      reportContextualUpdate(sessionId, formatNewMessagesActivity(sessionId, messages), 'session_context');
      return;
    }

    if (!shareRecentMessages) {
      reportContextualUpdate(sessionId, formatNewMessagesActivity(sessionId, messages), 'session_context');
      return;
    }

    const filtered = filterMessagesForVoiceUpdate(messages, policy);

    if (filtered.length === 0) {
      reportContextualUpdate(sessionId, formatNewMessagesActivity(sessionId, messages), 'session_context');
      return;
    }

    reportContextualUpdate(sessionId, formatNewMessages(sessionId, filtered, getVoiceContextPrefs(sessionId)), 'session_context');
  },

  /**
   * Composes the host-authored startup context for a beginning Voice attempt.
   * A `current_ui_only` provider attaches to an Agent session whose runtime
   * already owns the authoritative startup prompt, so this contributes no
   * bootstrap item there; the attempt-scoped seen state is still reset because
   * that is ordinary attempt lifecycle, not context disclosure.
   */
  onVoiceStarted(sessionId: string, scope: VoiceHostAuthoredContextScope): string {
    emitVoiceDebugDiagnostic('voice_session_started', { sessionId });
    voiceAttemptShownSessionIds.clear();
    if (scope === 'current_ui_only') return '';
    const state: any = storage.getState();
    const normalized = String(sessionId ?? '').trim();

    if (!normalized) {
      return (
        'VOICE SESSION STARTED\n\n' +
        '<session_context>none</session_context>\n' +
        'No session is currently tracked. Use tools to discover sessions and request the sessionId explicitly before acting.'
      );
    }

    const session = resolveVoiceContextSessionFromState(normalized, state);
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
      formatSessionFull(session, readStoredSessionMessages(state, normalized), getVoiceContextPrefs(normalized));
    voiceAttemptShownSessionIds.add(normalized);
    return prompt;
  },

  onReady(sessionId: string, messages?: Message[]) {
    if (VOICE_CONFIG.DISABLE_READY_EVENTS) return;

    reportSession(sessionId);
    const recentMessages = Array.isArray(messages) && messages.length > 0
      ? messages
      : readStoredSessionMessages(storage.getState(), sessionId);
    const formatterPrefs = getVoiceContextPrefs(sessionId);
    const privacy = readVoicePrivacySettings(storage.getState().settings);
    reportAnnouncedSessionUpdate(sessionId, formatReadyEvent(sessionId, recentMessages, {
      ...formatterPrefs,
      // Ready announcements are not snippet serialization. Preserve the raw
      // provider-bound privacy decision instead of the update-level projection.
      voiceShareRecentMessages: privacy.shareRecentMessages,
    }));
  },

  onVoiceStopped() {
    emitVoiceDebugDiagnostic('voice_session_stopped', {});
    voiceAttemptShownSessionIds.clear();
  },
};
