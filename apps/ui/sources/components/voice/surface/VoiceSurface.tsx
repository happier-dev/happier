import * as React from 'react';
import { Platform, Pressable, ScrollView, View } from 'react-native';
import { usePathname } from 'expo-router';

import { useNavigateToSession } from '@/hooks/session/useNavigateToSession';

import { Image } from 'expo-image';
import { Typography } from '@/constants/Typography';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { StatusDot } from '@/components/ui/status/StatusDot';
import { VoiceBars } from '@/components/ui/status/VoiceBars';
import { PrimaryCircleIconButton } from '@/components/ui/buttons/PrimaryCircleIconButton';
import { useSetting } from '@/sync/domains/state/storage';
import { readVoicePrivacySettings } from '@/sync/domains/settings/readVoicePrivacySettings';
import { useAllSessions, useSessionMetadata } from '@/sync/store/hooks';
import { t } from '@/text';
import { useVoiceActivityStore } from '@/voice/activity/voiceActivityStore';
import { voiceActivityController } from '@/voice/activity/voiceActivityController';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import { toggleLocalVoiceTurn } from '@/voice/local/localVoiceEngine';
import { useVoiceTargetStore } from '@/voice/runtime/voiceTargetStore';
import { useVoiceSessionSnapshot, voiceSessionManager } from '@/voice/session/voiceSession';
import { hydrateVoiceAgentActivityFromCarrierSession } from '@/voice/persistence/hydrateVoiceAgentActivityFromCarrierSession';
import { teleportVoiceAgentToSessionRoot } from '@/voice/agent/teleportVoiceAgentToSessionRoot';
import { formatVoiceActivityEvent, sortVoiceActivityEventsByTsThenId } from '@/voice/activity/formatVoiceActivityEvent';
import { getSessionName } from '@/utils/sessions/sessionUtils';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { Text } from '@/components/ui/text/Text';
import { voiceSessionBindingStore } from '@/voice/sessionBinding/voiceSessionBindingStore';
import { resolveLatestVoiceSessionBinding, resolveVoiceSessionBindingByControlSessionId } from '@/voice/sessionBinding/resolveVoiceSessionBinding';
import { voiceSessionBindingManager } from '@/voice/sessionBinding/voiceSessionBindingRuntime';
import { resolveVoiceSessionLabel } from '@/voice/context/resolveVoiceSessionLabel';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { isHiddenSystemSession } from '@happier-dev/protocol';
import { getVoiceAgentSessionTeleportAvailability } from '@/voice/agent/getVoiceAgentSessionTeleportAvailability';
import { normalizeNonEmptyString } from '@/voice/shared/normalizeNonEmptyString';
import { Icon } from '@/components/ui/icons/Icon';


export type VoiceSurfaceVariant = 'sidebar' | 'session';

const EMPTY_EVENTS: ReadonlyArray<any> = [];

function resolveSessionIdFromPathname(pathname: string | null | undefined): string | null {
  const normalized = String(pathname ?? '').trim();
  const match = normalized.match(/^\/session\/([^/?#]+)/);
  const sessionId = typeof match?.[1] === 'string' ? decodeURIComponent(match[1]).trim() : '';
  return sessionId.length > 0 ? sessionId : null;
}

export function VoiceSurface(props: Readonly<{ variant: VoiceSurfaceVariant; sessionId?: string | null; style?: any }>) {
  const navigateToSession = useNavigateToSession();
  const pathname = usePathname();
  const { theme } = useUnistyles();
  const styles = stylesheet;
  const snap = useVoiceSessionSnapshot();
  const voice: any = useSetting('voice');
  const voicePrivacy = readVoicePrivacySettings({ voice });
  const providerId = voice?.providerId ?? 'off';
  const ui = voice?.ui ?? {};
  const scopeDefault = ui.scopeDefault === 'session' ? 'session' : 'global';
  const surfaceLocation = ui.surfaceLocation === 'sidebar' || ui.surfaceLocation === 'session' ? ui.surfaceLocation : 'auto';
  const activityFeedEnabled = voice?.ui?.activityFeedEnabled === true;
  const activityFeedAutoExpandOnStart = voice?.ui?.activityFeedAutoExpandOnStart === true;

  const sessionSurfaceSessionId = typeof props.sessionId === 'string' ? props.sessionId.trim() : '';
  // Subscription width: the surface only reads metadata (hidden-system check below and the
  // target label). Subscribing to the whole session re-rendered it on every turn-lifecycle
  // field a send touches.
  const currentSessionMetadata = useSessionMetadata(sessionSurfaceSessionId);

  const feedSessionId = props.variant === 'session' && typeof props.sessionId === 'string' ? props.sessionId : null;
  const lastFocusedSessionId = useVoiceTargetStore((s) => s.lastFocusedSessionId);
  const primaryActionSessionId = useVoiceTargetStore((s) => s.primaryActionSessionId);
  const primaryActionSessionKey = typeof primaryActionSessionId === 'string' ? primaryActionSessionId.trim() : '';
  const primaryActionSessionMetadata = useSessionMetadata(primaryActionSessionKey);
  const voiceScope = useVoiceTargetStore((s) => s.scope);
  const routeSessionId = props.variant === 'sidebar' ? resolveSessionIdFromPathname(pathname) : null;
  const startSessionId =
    props.variant === 'session'
      ? (typeof props.sessionId === 'string' ? props.sessionId : null)
      : (routeSessionId ?? (typeof lastFocusedSessionId === 'string' ? lastFocusedSessionId : null));

  const localConversationMode =
    providerId === 'local_conversation' ? (voice?.adapters?.local_conversation?.conversationMode ?? 'direct_session') : null;
  const voiceAgentEnabled = useFeatureEnabled('voice.agent');
  const allowsGlobalStart =
    providerId === 'realtime_elevenlabs' || (providerId === 'local_conversation' && localConversationMode === 'agent');

  const localAgentCfg = providerId === 'local_conversation' ? voice?.adapters?.local_conversation?.agent ?? null : null;
  const daemonLocalVoiceUnavailable =
    providerId === 'local_conversation' &&
    localConversationMode === 'agent' &&
    localAgentCfg?.backend === 'daemon' &&
    voiceAgentEnabled !== true;
  const canTeleportToSessionRoot =
    props.variant === 'session'
    && getVoiceAgentSessionTeleportAvailability({ voice, sessionId: props.sessionId ?? null }).ok;

  const voiceAgentTranscriptCfg = voice?.adapters?.local_conversation?.agent?.transcript ?? null;
  const voiceAgentTranscriptPersistenceMode =
    voiceAgentTranscriptCfg && (voiceAgentTranscriptCfg as any).persistenceMode === 'persistent' ? 'persistent' : 'ephemeral';
  const voiceAgentTranscriptEpochRaw = voiceAgentTranscriptCfg ? Number((voiceAgentTranscriptCfg as any).epoch ?? 0) : 0;
  const voiceAgentTranscriptEpoch =
    Number.isFinite(voiceAgentTranscriptEpochRaw) && voiceAgentTranscriptEpochRaw >= 0 ? Math.floor(voiceAgentTranscriptEpochRaw) : 0;

  // Avoid selectors that allocate new arrays on every getSnapshot call (can infinite-loop in React 18).
  const eventsBySessionId = useVoiceActivityStore((s) => s.eventsBySessionId);
  const events = React.useMemo(() => {
    if (props.variant === 'session') {
      return feedSessionId ? (eventsBySessionId[feedSessionId] ?? EMPTY_EVENTS) : EMPTY_EVENTS;
    }

    const all: any[] = [];
    for (const v of Object.values(eventsBySessionId ?? {})) {
      if (Array.isArray(v)) all.push(...v);
    }
    return all.length === 0 ? EMPTY_EVENTS : all;
  }, [eventsBySessionId, feedSessionId, props.variant]);

  const [expanded, setExpanded] = React.useState(false);

  React.useEffect(() => {
    // Keep store scope in sync with the user's default voice scope.
    useVoiceTargetStore.getState().setScope(scopeDefault);
  }, [scopeDefault]);

  const hydratedVoiceAgentEpochRef = React.useRef<number | null>(null);
  React.useEffect(() => {
    const shouldHydrateVoiceAgentTranscript =
      props.variant === 'sidebar' &&
      activityFeedEnabled &&
      providerId === 'local_conversation' &&
      localConversationMode === 'agent' &&
      voiceAgentTranscriptPersistenceMode === 'persistent';

    if (!shouldHydrateVoiceAgentTranscript) {
      hydratedVoiceAgentEpochRef.current = null;
      return;
    }
      if (hydratedVoiceAgentEpochRef.current === voiceAgentTranscriptEpoch) return;

      hydratedVoiceAgentEpochRef.current = voiceAgentTranscriptEpoch;
      fireAndForget(hydrateVoiceAgentActivityFromCarrierSession(), { tag: 'VoiceSurface.hydrateVoiceAgentActivityFromCarrierSession' });
    }, [activityFeedEnabled, localConversationMode, voiceAgentTranscriptEpoch, voiceAgentTranscriptPersistenceMode, props.variant, providerId]);

  const lastStatusRef = React.useRef(snap.status);
  React.useEffect(() => {
    const prev = lastStatusRef.current;
    lastStatusRef.current = snap.status;
    if (!activityFeedEnabled) return;
    if (!activityFeedAutoExpandOnStart) return;
    if (expanded) return;
    if (prev === 'disconnected' && snap.status !== 'disconnected') {
      setExpanded(true);
    }
  }, [activityFeedAutoExpandOnStart, activityFeedEnabled, expanded, snap.status]);

  const visibleEvents = React.useMemo(() => {
    if (!Array.isArray(events) || events.length === 0) return EMPTY_EVENTS;
    const base = props.variant === 'sidebar' ? [...events].sort(sortVoiceActivityEventsByTsThenId) : events;
    const tail = base.length > 50 ? base.slice(base.length - 50) : base;
    return [...tail].reverse();
  }, [events, props.variant]);
  const bindingsByConversationSessionId = React.useSyncExternalStore(
    voiceSessionBindingStore.subscribe,
    () => voiceSessionBindingStore.getState().bindingsByConversationSessionId,
    () => voiceSessionBindingStore.getState().bindingsByConversationSessionId,
  );
  const voiceBindings = React.useMemo(
    () => Object.values(bindingsByConversationSessionId),
    [bindingsByConversationSessionId],
  );
  const controlSessionCandidates = React.useMemo(() => ([
    typeof snap.sessionId === 'string' ? snap.sessionId.trim() : '',
    providerId === 'realtime_elevenlabs' || (providerId === 'local_conversation' && localConversationMode === 'agent')
      ? VOICE_AGENT_GLOBAL_SESSION_ID
      : '',
    typeof props.sessionId === 'string' ? props.sessionId.trim() : '',
  ].filter(Boolean)), [localConversationMode, props.sessionId, providerId, snap.sessionId]);
  const openConversationSessionId = React.useMemo(() => {
    for (const controlSessionId of controlSessionCandidates) {
      const binding = resolveVoiceSessionBindingByControlSessionId({ controlSessionId, adapterId: providerId });
      if (binding) {
        return binding.conversationSessionId;
      }
    }

    return resolveLatestVoiceSessionBinding({
      adapterId: providerId,
      controlSessionIds: controlSessionCandidates,
    })?.conversationSessionId ?? null;
  }, [bindingsByConversationSessionId, controlSessionCandidates, providerId]);
  const fallbackOpenConversationControlSessionId = React.useMemo(() => {
    return controlSessionCandidates[0] ?? null;
  }, [controlSessionCandidates]);
  const locationAllowsVariant = (() => {
    if (surfaceLocation === 'sidebar') return props.variant === 'sidebar';
    if (surfaceLocation === 'session') return props.variant === 'session';
    // auto
    return scopeDefault === 'global' ? props.variant === 'sidebar' : props.variant === 'session';
  })();

  const showSurface =
    providerId !== 'off' &&
    locationAllowsVariant &&
    !(props.variant === 'session' && isHiddenSystemSession({ metadata: currentSessionMetadata }));
  if (!showSurface) return null;

  const statusInfo = (() => {
    switch (snap.status) {
      case 'connecting':
        return { dot: theme.colors.status.connecting, label: t('voiceAssistant.connecting') };
      case 'connected':
        return { dot: theme.colors.status.connected, label: t('voiceAssistant.active') };
      case 'error':
        return { dot: theme.colors.status.error, label: t('voiceAssistant.connectionError') };
      case 'disconnected':
      default:
        return { dot: theme.colors.status.default, label: t('voiceAssistant.label') };
    }
  })();

  const canStart = !daemonLocalVoiceUnavailable && (allowsGlobalStart ? true : Boolean(startSessionId));
  const isConnected = snap.status === 'connected';
  const isSpeaking = isConnected && snap.mode === 'speaking';
  const canStop = snap.canStop && snap.status !== 'disconnected';
  const showConnectingSpinner = snap.status === 'connecting' && !canStop;
  const toggleDisabledReason = !canStop && !canStart
    ? (daemonLocalVoiceUnavailable
      ? t('settingsVoice.local.conversation.resumability.disabledVoiceAgent')
      : t('voiceSurface.selectSessionToStart'))
    : null;
  const bargeInEnabled =
    providerId === 'local_conversation' ? voice?.adapters?.local_conversation?.tts?.bargeInEnabled !== false : false;
  const canBargeIn =
    providerId === 'local_conversation' &&
    isSpeaking &&
    bargeInEnabled &&
    typeof snap.sessionId === 'string' &&
    snap.sessionId.trim().length > 0;
  const canCancelTurn =
    isConnected &&
    typeof snap.sessionId === 'string' &&
    snap.sessionId.trim().length > 0 &&
    (snap.mode === 'thinking' || snap.mode === 'speaking');
  const targetLabel =
    props.variant === 'sidebar' && voiceScope === 'global' && primaryActionSessionId
      ? (
        (primaryActionSessionMetadata
          ? getSessionName({ id: primaryActionSessionKey, metadata: primaryActionSessionMetadata })
          : null)
        ?? resolveVoiceSessionLabel(primaryActionSessionId, {
          voiceShareSessionSummary: voicePrivacy.shareSessionSummary,
          voiceShareFilePaths: voicePrivacy.shareFilePaths,
        })
      )
      : null;

  const onTogglePress = () => {
    if (canStop) {
      fireAndForget(voiceSessionManager.stop(''), { tag: 'VoiceSurface.stop' });
      return;
    }
    const resolvedStartSessionId = allowsGlobalStart ? (startSessionId ?? '') : startSessionId;
    if (!resolvedStartSessionId && !allowsGlobalStart) return;
    fireAndForget(voiceSessionManager.toggle(resolvedStartSessionId ?? ''), { tag: 'VoiceSurface.toggle' });
  };

  const onClearPress = () => {
    if (props.variant === 'session' && feedSessionId) {
      voiceActivityController.clearSession(feedSessionId);
      return;
    }
    const state = useVoiceActivityStore.getState();
    for (const sid of Object.keys(state.eventsBySessionId ?? {})) {
      voiceActivityController.clearSession(sid);
    }
  };

  const containerStyle = [
    styles.container,
    {
      // Match other sidebar items: white surface without an outer border.
      backgroundColor: theme.colors.surface.base,
    },
    props.style,
  ];

  return (
    <View style={containerStyle}>
      <View style={styles.headerRow}>
        <View style={styles.statusLeft}>
          {canBargeIn ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('voiceSurface.a11y.bargeIn')}
              onPress={() => {
                if (typeof snap.sessionId !== 'string') return;
                const sid = snap.sessionId.trim();
                if (!sid) return;
                fireAndForget(toggleLocalVoiceTurn(sid), { tag: 'VoiceSurface.bargeIn' });
              }}
              style={({ pressed }) => [
                styles.micBadge,
                { backgroundColor: theme.colors.surface.inset, borderColor: theme.colors.border.default, opacity: pressed ? 0.72 : 1 },
              ]}
            >
              <StatusDot color={statusInfo.dot} isPulsing={snap.status === 'connecting'} size={7} style={styles.dot as any} />
              <Icon name="microphone-slash" size={14} color={theme.colors.text.primary} style={styles.micIcon as any} />
            </Pressable>
          ) : (
            <View style={[styles.micBadge, { backgroundColor: theme.colors.surface.inset, borderColor: theme.colors.border.default }]}>
              <StatusDot color={statusInfo.dot} isPulsing={snap.status === 'connecting'} size={7} style={styles.dot as any} />
              <Icon name={snap.mode === 'listening' ? 'microphone' : 'microphone-slash'} size={14} color={theme.colors.text.primary} style={styles.micIcon as any} />
            </View>
          )}
          <View style={styles.statusTextCol}>
            <Text style={[styles.statusText, { color: theme.colors.text.primary }]} numberOfLines={1}>
              {statusInfo.label}
            </Text>
            {targetLabel ? (
              <Text style={[styles.targetText, { color: theme.colors.text.secondary }]} numberOfLines={1}>
                {t('voiceSurface.targetSession')}: {targetLabel}
              </Text>
            ) : toggleDisabledReason ? (
              <Text style={[styles.targetText, { color: theme.colors.text.secondary }]} numberOfLines={1}>
                {toggleDisabledReason}
              </Text>
            ) : null}
          </View>
        </View>

        <View style={styles.statusRight}>
          {isSpeaking ? <VoiceBars isActive color={theme.colors.text.secondary} size="small" /> : null}

          {canCancelTurn ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('voiceSurface.a11y.cancelTurn')}
              onPress={() => {
                if (typeof snap.sessionId !== 'string') return;
                const sid = snap.sessionId.trim();
                if (!sid) return;
                fireAndForget(voiceSessionManager.interrupt(sid), { tag: 'VoiceSurface.cancelTurn' });
              }}
              style={({ pressed }) => [{ opacity: pressed ? 0.72 : 1 }, styles.iconAction as any]}
            >
              <Icon name="x-circle" size={16} color={theme.colors.text.secondary} />
            </Pressable>
          ) : null}

          {openConversationSessionId ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('common.open')}
              onPress={() => {
                fireAndForget((async () => {
                  let nextSessionId = openConversationSessionId;
                  const requestedTargetSessionId =
                    normalizeNonEmptyString(
                      props.variant === 'session' ? (props.sessionId ?? null) : (routeSessionId ?? null),
                    );
                  const existingBinding = voiceBindings.find(
                    (binding) => binding.conversationSessionId === openConversationSessionId && binding.adapterId === providerId,
                  );
                  const shouldRebindOpenConversation =
                    !existingBinding
                    || normalizeNonEmptyString(existingBinding.targetSessionId) !== requestedTargetSessionId;
                  if (shouldRebindOpenConversation && fallbackOpenConversationControlSessionId) {
                    const rebound = await voiceSessionBindingManager.ensureBound({
                      adapterId: providerId,
                      controlSessionId: fallbackOpenConversationControlSessionId,
                      requestedTargetSessionId,
                    }).catch(() => null);
                    if (rebound?.conversationSessionId) {
                      nextSessionId = rebound.conversationSessionId;
                    }
                  }
                  await navigateToSession(nextSessionId);
                })(), { tag: 'VoiceSurface.openConversation' });
              }}
              style={({ pressed }) => [{ opacity: pressed ? 0.72 : 1 }, styles.iconAction as any]}
            >
              <Icon name="chat-circle-dots" size={16} color={theme.colors.text.secondary} />
            </Pressable>
          ) : null}

            {canTeleportToSessionRoot ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t('voiceSurface.a11y.teleport')}
                onPress={() => {
                  const sid = String(props.sessionId ?? '').trim();
                  if (!sid) return;
                  fireAndForget(teleportVoiceAgentToSessionRoot({ sessionId: sid }), { tag: 'VoiceSurface.teleport' });
              }}
              style={({ pressed }) => [{ opacity: pressed ? 0.72 : 1 }, styles.iconAction as any]}
            >
              <Icon name="navigation-arrow" size={16} color={theme.colors.text.secondary} />
            </Pressable>
          ) : null}

          <PrimaryCircleIconButton
            onPress={onTogglePress}
            disabled={!canStop && !canStart}
            loading={showConnectingSpinner}
            active={snap.status !== 'disconnected' || providerId !== 'off'}
            accessibilityLabel={canStop ? t('voiceAssistant.tapToEnd') : t('voiceAssistant.label')}
          >
            {canStop ? (
              <Icon name="stop-circle" size={20} color={theme.colors.button?.primary?.tint ?? theme.colors.text.primary} />
            ) : (
              <Image
                source={require('@/assets/images/icon-voice-white.png')}
                style={{ width: 22, height: 22 }}
                tintColor={theme.colors.button?.primary?.tint ?? theme.colors.text.primary}
              />
            )}
          </PrimaryCircleIconButton>
        </View>
      </View>

      {activityFeedEnabled ? (
        <View style={styles.feedContainer}>
          <View style={styles.feedHeader}>
              <Pressable
                onPress={() => setExpanded((v) => !v)}
                accessibilityRole="button"
                accessibilityLabel={t('voiceSurface.a11y.toggleActivity')}
                style={({ pressed }) => [{ opacity: pressed ? 0.72 : 1 }, styles.feedHeaderLeft as any]}
              >
              <Icon name={expanded ? 'caret-down' : 'caret-right'} size={14} color={theme.colors.text.secondary} />
              <Text style={[styles.feedTitle, { color: theme.colors.text.secondary }]}>
                {t('voiceActivity.title')}
              </Text>
              <Text style={[styles.feedCount, { color: theme.colors.text.secondary }]}>
                {`${events.length}`}
              </Text>
            </Pressable>

              <Pressable
                onPress={onClearPress}
                disabled={events.length === 0 || (props.variant === 'session' && !feedSessionId)}
                accessibilityRole="button"
                accessibilityLabel={t('voiceSurface.a11y.clearActivity')}
                style={({ pressed }) => [
                  styles.clearButton,
                {
                  opacity: pressed ? 0.72 : 1,
                  backgroundColor: events.length === 0 ? 'transparent' : theme.colors.surface.inset,
                  borderColor: theme.colors.border.default,
                },
              ]}
            >
              <Text style={[styles.clearText, { color: theme.colors.text.secondary }]}>{t('voiceActivity.clear')}</Text>
            </Pressable>
          </View>

          {expanded ? (
            <VoiceSurfaceActivityEventsList events={events} visibleEvents={visibleEvents} />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function VoiceSurfaceActivityEventsList(props: Readonly<{
  events: ReadonlyArray<any>;
  visibleEvents: ReadonlyArray<any>;
}>): React.ReactElement {
  const { theme } = useUnistyles();
  const styles = stylesheet;
  const allSessions = useAllSessions();
  const sessionLabelById = React.useMemo(() => {
    const map = new Map<string, string>();
    for (const session of allSessions as any[]) {
      if (!session || typeof session.id !== 'string') continue;
      map.set(session.id, getSessionName(session));
    }
    return map;
  }, [allSessions]);

  return (
    <ScrollView style={styles.feedScroll} contentContainerStyle={styles.feedScrollContent as any}>
      {props.events.length === 0 ? (
        <Text style={[styles.emptyText, { color: theme.colors.text.secondary }]}>{t('voiceActivity.empty')}</Text>
      ) : (
        props.visibleEvents.map((event) => (
          <Text key={event.id} style={[styles.eventText, { color: theme.colors.text.primary }]} numberOfLines={3}>
            {formatVoiceActivityEvent(event, sessionLabelById)}
          </Text>
        ))
      )}
    </ScrollView>
  );
}

const stylesheet = StyleSheet.create((theme, runtime) => ({
  container: {
    alignSelf: 'stretch',
    // Match session list grouping density in the sidebar.
    marginHorizontal: 16,
    marginTop: 10,
    marginBottom: 8,
    borderRadius: 12,
    // Prevent any bleed past sidebar width on web.
    overflow: 'hidden',
  },
  headerRow: {
    paddingHorizontal: 12,
    paddingVertical: Platform.select({ ios: 10, default: 12 }),
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  statusLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flexShrink: 1,
    paddingRight: 10,
  },
  micBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    height: 28,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
  },
  dot: {
    marginRight: 6,
  },
  micIcon: {
    marginRight: 2,
  },
  statusTextCol: {
    flexShrink: 1,
    marginLeft: 10,
  },
  statusText: {
    fontSize: 14,
    lineHeight: 16,
    flexShrink: 1,
  },
  targetText: {
    ...Typography.default(),
    fontSize: 12,
    lineHeight: 14,
    marginTop: 2,
  },
  statusRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  iconAction: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
  },
  feedContainer: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border.default,
  },
  feedHeader: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  feedHeaderLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  feedTitle: {
    ...Typography.default('semiBold'),
    fontSize: 11,
    lineHeight: 14,
    textTransform: 'uppercase',
    letterSpacing: Platform.select({ ios: 0.2, default: 0.8 }) as any,
  },
  feedCount: {
    ...Typography.default('semiBold'),
    fontSize: 11,
    lineHeight: 14,
    opacity: 0.9,
  },
  clearButton: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
  },
  clearText: {
    ...Typography.default('semiBold'),
    fontSize: 11,
    lineHeight: 14,
  },
  feedScroll: {
    maxHeight: 190,
  },
  feedScrollContent: {
    paddingHorizontal: 12,
    paddingBottom: 12,
    paddingTop: 2,
    gap: 8,
  },
  emptyText: {
    ...Typography.default(),
    fontSize: 12,
    lineHeight: 16,
  },
  eventText: {
    ...Typography.default(),
    fontSize: 12,
    lineHeight: 16,
    flexShrink: 1,
  },
}));
