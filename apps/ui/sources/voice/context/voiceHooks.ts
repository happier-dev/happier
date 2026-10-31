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
import type { Message } from "@happier-dev/session-core/messages";
import { readStoredSessionMessagesForAddress } from '@/sync/domains/messages/readStoredSessionMessagesForAddress';
import { storage } from '@/sync/domains/state/storage';
import { readVoicePrivacySettings } from '@/sync/domains/settings/readVoicePrivacySettings';
import { VOICE_CONFIG } from '@/voice/runtime/voiceConfig';
import { getVoiceContextSinkForSession } from '@/voice/context/getVoiceContextSinkForSession';
import type { VoiceContextSink } from '@/voice/context/VoiceContextSink';
import { resolveEffectiveVoiceTargetState } from '@/voice/context/resolveEffectiveVoiceTargetState';
import { getVoiceContextFormatterPrefs } from '@/voice/context/voiceContextPrefs';
import { useVoiceTargetStore } from '@/voice/runtime/voiceTargetStore';
import { readSessionIncludedInVoiceFromState, resolveVoiceSessionUpdatePolicy, type VoiceSessionUpdatePolicy } from '@/voice/runtime/voiceUpdatePolicy';
import type { AgentRequestKind } from '@happier-dev/protocol';
import { resolveVoiceContextSessionFromState } from '@/voice/context/resolveVoiceContextSession';
import type { CurrentUiContextSnapshotV1 } from '@happier-dev/protocol/plugins/ui';
import type { HostAuthoredContextClass, VoiceHostAuthoredContextScope } from '@/voice/session/types';
import { resolveVoiceInitialContext } from '@/voice/context/buildVoiceInitialContext';
import { areSessionAddressesEqual, normalizeSessionAddress, sessionAddressKey, type SessionAddress } from '@/sync/domains/session/sessionAddress';
import { buildVoiceBrief, type VoiceBriefSource } from './buildVoiceBrief';
import { getVoiceSessionLifecycleController } from '@/voice/session/voiceSessionLifecycleControllerStore';
import { getVoiceSessionSnapshot } from '@/voice/session/voiceSessionStore';

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
const voiceAttemptShownSessionAddresses = new Set<string>();

type VoiceDebugEvent =
  | 'voice_contextual_update'
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

function normalizeLifecycleAddress(address: SessionAddress): SessionAddress | null {
  return normalizeSessionAddress(address?.serverId, address?.sessionId);
}

function resolvePolicy(address: SessionAddress): VoiceSessionUpdatePolicy {
  // NOTE: we deliberately avoid a session-scoped API here; global voice uses explicit target.
  const targetState = resolveEffectiveVoiceTargetState(address);
  const state = storage.getState();

  return resolveVoiceSessionUpdatePolicy({
    sessionId: address.sessionId,
    sessionAddress: address,
    settings: state.settings,
    includeInVoice: readSessionIncludedInVoiceFromState(state, address),
    isCurrentAttemptTarget: areSessionAddressesEqual(targetState.primaryActionSessionAddress, address),
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

function getVoiceContextPrefs(address: SessionAddress) {
  const settings = storage.getState().settings;
  const targetState = resolveEffectiveVoiceTargetState(address);
  return getVoiceContextFormatterPrefs({
    sessionId: address.sessionId,
    sessionAddress: address,
    settings,
    includeInVoice: readSessionIncludedInVoiceFromState(storage.getState(), address),
    isCurrentAttemptTarget: areSessionAddressesEqual(targetState.primaryActionSessionAddress, address),
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

/** Delivery consumes the sink admitted by the event's context disclosure decision. */
function reportContextualUpdate(
  sink: VoiceContextSink,
  sessionId: string,
  update: string | null | undefined,
  contextClass: HostAuthoredContextClass,
): boolean {
  emitVoiceDebugDiagnostic('voice_contextual_update', { sessionId, payload: update });
  if (!update) return false;
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

function reportAnnouncedSessionUpdate(sink: VoiceContextSink, sessionId: string, update: string | null | undefined) {
  if (!update) return;

  if (sink.announceAssistantText) {
    reportContextualUpdate(sink, sessionId, update, 'session_context');
    return;
  }

  sink.sendTextMessage(sessionId, update);
}

function announceAssistantText(sink: VoiceContextSink, sessionId: string, update: string | null | undefined) {
  if (!update) return;
  sink.announceAssistantText?.(sessionId, update);
}

function reportSession(sink: VoiceContextSink, address: SessionAddress) {
  const key = sessionAddressKey(address);
  if (voiceAttemptShownSessionAddresses.has(key)) return;
  const level = resolvePolicy(address).level;
  if (level !== 'summaries' && level !== 'snippets') return;
  const session = resolveVoiceContextSessionFromState(address, storage.getState());
  if (!session) return;
  const messages = readStoredSessionMessagesForAddress(storage.getState(), address, {
    activeServerId: address.serverId,
  });
  const contextUpdate = formatSessionFull(session, messages, getVoiceContextPrefs(address), address);
  if (reportContextualUpdate(sink, address.sessionId, contextUpdate, 'session_context')) {
    voiceAttemptShownSessionAddresses.add(key);
  }
}

function formatNewMessagesActivity(address: SessionAddress, messages: Message[]): string {
  const count = Array.isArray(messages) ? messages.length : 0;
  const plural = count === 1 ? '' : 's';
  return `New messages in session: ${address.sessionId}\n\n(${count} new message${plural})`;
}

function isPrimaryActionSession(address: SessionAddress): boolean {
  return areSessionAddressesEqual(
    resolveEffectiveVoiceTargetState(address).primaryActionSessionAddress,
    address,
  );
}

function filterMessagesForVoiceUpdate(messages: Message[], policy: VoiceSessionUpdatePolicy): Message[] {
  return (Array.isArray(messages) ? messages : [])
    .filter((m) => m && typeof m === 'object')
    .filter((m) => policy.includeUserMessagesInSnippets || m.kind !== 'user-text')
    .sort((a, b) => a.createdAt - b.createdAt)
    .slice(-policy.snippetsMaxMessages);
}

function shouldInterruptForAssistantReply(
  address: SessionAddress,
  messages: Message[],
  policy: VoiceSessionUpdatePolicy,
  shareRecentMessages: boolean,
): boolean {
  if (!shareRecentMessages) return false;
  if (!isPrimaryActionSession(address)) return false;
  if (policy.level !== 'summaries' && policy.level !== 'snippets') return false;
  return summarizeMessagesForVoiceHuman(Array.isArray(messages) ? messages : [], getVoiceContextPrefs(address)) !== null;
}

export const voiceHooks = {
  onCurrentUiContextChanged(
    sessionId: string,
    snapshot: CurrentUiContextSnapshotV1 | null,
    automaticUpdateProjector: CurrentUiContextAutomaticUpdateProjector,
  ) {
    if (!isAmbientCurrentUiDisclosureEnabled()) return;
    const sink = getVoiceContextSinkForSession(sessionId);
    if (!sink) return;
    const update = automaticUpdateProjector.project(snapshot);
    if (!update) return;
    // Remember it only once a sink took it, so an update composed while no
    // context channel is attached does not suppress the next real transition.
    if (!reportContextualUpdate(sink, sessionId, update, 'current_ui')) return;
    automaticUpdateProjector.markDelivered(update);
  },

  onSessionOnline(addressInput: SessionAddress, metadata?: SessionMetadata) {
    const address = normalizeLifecycleAddress(addressInput);
    if (!address) return;
    if (VOICE_CONFIG.DISABLE_SESSION_STATUS) return;
    const sink = getVoiceContextSinkForSession(address.sessionId);
    if (!sink || !sinkAcceptsHostAuthoredContext(sink, 'session_context')) return;
    if (resolvePolicy(address).level === 'none') return;

    reportSession(sink, address);
    const contextUpdate = formatSessionOnline(address, metadata, getVoiceContextPrefs(address));
    reportContextualUpdate(sink, address.sessionId, contextUpdate, 'session_context');
  },

  onSessionOffline(addressInput: SessionAddress, metadata?: SessionMetadata) {
    const address = normalizeLifecycleAddress(addressInput);
    if (!address) return;
    if (VOICE_CONFIG.DISABLE_SESSION_STATUS) return;
    const sink = getVoiceContextSinkForSession(address.sessionId);
    if (!sink || !sinkAcceptsHostAuthoredContext(sink, 'session_context')) return;
    if (resolvePolicy(address).level === 'none') return;

    reportSession(sink, address);
    const contextUpdate = formatSessionOffline(address, metadata, getVoiceContextPrefs(address));
    reportContextualUpdate(sink, address.sessionId, contextUpdate, 'session_context');
  },

  onSessionFocus(addressInput: SessionAddress, _metadata?: SessionMetadata) {
    const address = normalizeLifecycleAddress(addressInput);
    if (!address) return;
    // Focus is a local target signal first: it selects this device's voice
    // target and does not override an explicit active target. That selection
    // never leaves the device, so no disclosure setting governs it.
    useVoiceTargetStore.getState().setLastFocusedSessionAddress(address);

    // The CurrentUiContextProvider observes the same foreground transition
    // and is the sole automatic delivery owner. Do not turn a focus callback
    // into a second path that serializes session summaries, transcripts, paths,
    // or machine identity to a provider.
  },

  onAgentRequest(addressInput: SessionAddress, requestId: string, requestKind: AgentRequestKind, toolName: string, toolArgs: any) {
    const address = normalizeLifecycleAddress(addressInput);
    if (!address) return;
    if (VOICE_CONFIG.DISABLE_PERMISSION_REQUESTS) return;
    const sessionId = address.sessionId;
    const sink = getVoiceContextSinkForSession(sessionId);
    if (!sink || !sinkAcceptsHostAuthoredContext(sink, 'session_context')) return;
    if (!readVoicePrivacySettings(storage.getState().settings).sharePermissionRequests) return;

    if (resolvePolicy(address).level === 'none') return;
    reportSession(sink, address);
    announceAssistantText(
      sink,
      sessionId,
      summarizeAgentRequestForVoiceHuman(requestKind, requestId, toolName, toolArgs, getVoiceContextPrefs(address)),
    );
    reportAnnouncedSessionUpdate(
      sink,
      sessionId,
      requestKind === 'user_action'
        ? formatUserActionRequest(address, requestId, toolName, toolArgs, getVoiceContextPrefs(address))
        : formatPermissionRequest(address, requestId, toolName, toolArgs, getVoiceContextPrefs(address)),
    );
  },

  /** Explicit Brief gesture; only the established context channel may disclose its projection. */
  onBriefRequested(controlSessionId: string, inbox: VoiceBriefSource): boolean {
    const snapshot = getVoiceSessionSnapshot();
    if (snapshot.status !== 'connected' || snapshot.sessionId !== controlSessionId) return false;
    const sink = getVoiceContextSinkForSession(controlSessionId);
    if (!sink || !sinkAcceptsHostAuthoredContext(sink, 'session_context')) return false;
    // Re-project at the explicit gesture, so a privacy change since rendering
    // cannot disclose a stale, previously authorized Brief context.
    const brief = buildVoiceBrief({ inbox, settings: storage.getState().settings,
      currentTarget: useVoiceTargetStore.getState().primaryActionSessionAddress });
    // This is one explicit user request, not an ambient Session/Follow update.
    // Local Agent channels deliberately discard ambient session_context, so
    // keep the privacy-projected facts with the request that consumes them.
    sink.sendTextMessage(controlSessionId, `INBOX BRIEF\n\n${brief.context}\n\nBrief me on this known Inbox work: needs-you, failures, then ready work. Say when information is incomplete. Follow the approval guidance in this Brief.`);
    return true;
  },

  onMessages(addressInput: SessionAddress, messages: Message[]) {
    const address = normalizeLifecycleAddress(addressInput);
    if (!address) return;
    // This is the incumbent newly-applied sync channel, not a transcript scan.
    // Local microphone retirement is lifecycle, independent of provider disclosure toggles.
    getVoiceSessionLifecycleController()?.observeSyncedConversationMessages(address, messages);
    const sessionId = address.sessionId;
    if (VOICE_CONFIG.DISABLE_MESSAGES) return;
    const sink = getVoiceContextSinkForSession(sessionId);
    if (!sink || !sinkAcceptsHostAuthoredContext(sink, 'session_context')) return;
    const policy = resolvePolicy(address);
    const level = policy.level;
    if (level === 'none') return;

    // "shareRecentMessages" gates transcript/snippet sharing; activity updates remain allowed.
    const shareRecentMessages = readVoicePrivacySettings(storage.getState().settings).shareRecentMessages;

    if (level === 'activity') {
      reportContextualUpdate(sink, sessionId, formatNewMessagesActivity(address, messages), 'session_context');
      return;
    }

    reportSession(sink, address);
    if (shouldInterruptForAssistantReply(address, messages, policy, shareRecentMessages)) {
      const filtered = filterMessagesForVoiceUpdate(messages, policy);
      if (filtered.length > 0) {
        announceAssistantText(sink, sessionId, summarizeMessagesForVoiceHuman(filtered, getVoiceContextPrefs(address)));
        reportAnnouncedSessionUpdate(sink, sessionId, formatNewMessages(address, filtered, getVoiceContextPrefs(address)));
        return;
      }
    }

    if (level === 'summaries') {
      reportContextualUpdate(sink, sessionId, formatNewMessagesActivity(address, messages), 'session_context');
      return;
    }

    if (!shareRecentMessages) {
      reportContextualUpdate(sink, sessionId, formatNewMessagesActivity(address, messages), 'session_context');
      return;
    }

    const filtered = filterMessagesForVoiceUpdate(messages, policy);

    if (filtered.length === 0) {
      reportContextualUpdate(sink, sessionId, formatNewMessagesActivity(address, messages), 'session_context');
      return;
    }

    reportContextualUpdate(sink, sessionId, formatNewMessages(address, filtered, getVoiceContextPrefs(address)), 'session_context');
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
    voiceAttemptShownSessionAddresses.clear();
    const resolution = resolveVoiceInitialContext(sessionId, { scope });
    if (resolution.kind === 'session') {
      voiceAttemptShownSessionAddresses.add(sessionAddressKey(resolution.sessionAddress));
    }
    return resolution.initialContext;
  },

  onReady(addressInput: SessionAddress, messages?: Message[]) {
    const address = normalizeLifecycleAddress(addressInput);
    if (!address) return;
    const sessionId = address.sessionId;
    if (VOICE_CONFIG.DISABLE_READY_EVENTS) return;
    const sink = getVoiceContextSinkForSession(sessionId);
    if (!sink || !sinkAcceptsHostAuthoredContext(sink, 'session_context')) return;

    reportSession(sink, address);
    const recentMessages = Array.isArray(messages) && messages.length > 0
      ? messages
      : readStoredSessionMessagesForAddress(storage.getState(), address, {
        activeServerId: address.serverId,
      });
    const formatterPrefs = getVoiceContextPrefs(address);
    const privacy = readVoicePrivacySettings(storage.getState().settings);
    reportAnnouncedSessionUpdate(sink, sessionId, formatReadyEvent(address, recentMessages, {
      ...formatterPrefs,
      // Ready announcements are not snippet serialization. Preserve the raw
      // provider-bound privacy decision instead of the update-level projection.
      voiceShareRecentMessages: privacy.shareRecentMessages,
    }));
  },

  onVoiceStopped() {
    emitVoiceDebugDiagnostic('voice_session_stopped', {});
    voiceAttemptShownSessionAddresses.clear();
    useVoiceTargetStore.getState().setVoiceLiveContextSessionAddresses([]);
  },
};
