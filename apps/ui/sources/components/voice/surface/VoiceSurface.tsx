import * as React from 'react';
import { Platform, Pressable, ScrollView, View } from 'react-native';

import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { Typography } from '@/constants/Typography';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { StatusDot } from '@/components/ui/status/StatusDot';
import { VoiceBars } from '@/components/ui/status/VoiceBars';
import { PrimaryCircleIconButton } from '@/components/ui/buttons/PrimaryCircleIconButton';
import { useSetting } from '@/sync/domains/state/storage';
import { useAllSessions } from '@/sync/store/hooks';
import { t } from '@/text';
import { useVoiceActivityStore } from '@/voice/activity/voiceActivityStore';
import { voiceActivityController } from '@/voice/activity/voiceActivityController';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import { useVoiceTargetStore } from '@/voice/runtime/voiceTargetStore';
import { useVoiceSessionSnapshot, voiceSessionManager } from '@/voice/session/voiceSession';
import { hydrateVoiceAgentActivityFromCarrierSession } from '@/voice/persistence/hydrateVoiceAgentActivityFromCarrierSession';
import { teleportVoiceAgentToSessionRoot } from '@/voice/agent/teleportVoiceAgentToSessionRoot';
import { getSessionName } from '@/utils/sessions/sessionUtils';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { Text } from '@/components/ui/text/Text';


export type VoiceSurfaceVariant = 'sidebar' | 'session';

const EMPTY_EVENTS: ReadonlyArray<any> = [];

export function VoiceSurface(props: Readonly<{ variant: VoiceSurfaceVariant; sessionId?: string | null; style?: any }>) {
  const { theme } = useUnistyles();
  const styles = stylesheet;
  const snap = useVoiceSessionSnapshot();
  const voice: any = useSetting('voice');
  const providerId = voice?.providerId ?? 'off';
  const ui = voice?.ui ?? {};
  const scopeDefault = ui.scopeDefault === 'session' ? 'session' : 'global';
  const surfaceLocation = ui.surfaceLocation === 'sidebar' || ui.surfaceLocation === 'session' ? ui.surfaceLocation : 'auto';
  const activityFeedEnabled = voice?.ui?.activityFeedEnabled === true;
  const activityFeedAutoExpandOnStart = voice?.ui?.activityFeedAutoExpandOnStart === true;

  const allSessions = useAllSessions();
  const sessionLabelById = React.useMemo(() => {
    const map = new Map<string, string>();
    for (const s of allSessions as any[]) {
      if (!s || typeof s.id !== 'string') continue;
      map.set(s.id, getSessionName(s));
    }
    return map;
  }, [allSessions]);

  const feedSessionId = props.variant === 'session' && typeof props.sessionId === 'string' ? props.sessionId : null;
  const lastFocusedSessionId = useVoiceTargetStore((s) => s.lastFocusedSessionId);
  const primaryActionSessionId = useVoiceTargetStore((s) => s.primaryActionSessionId);
  const voiceScope = useVoiceTargetStore((s) => s.scope);
  const startSessionId =
    props.variant === 'session'
      ? (typeof props.sessionId === 'string' ? props.sessionId : null)
      : (typeof lastFocusedSessionId === 'string' ? lastFocusedSessionId : null);

  const localConversationMode =
    providerId === 'local_conversation' ? (voice?.adapters?.local_conversation?.conversationMode ?? 'direct_session') : null;
  const allowsGlobalStart =
    providerId === 'realtime_elevenlabs' || (providerId === 'local_conversation' && localConversationMode === 'agent');

  const localAgentCfg = providerId === 'local_conversation' ? voice?.adapters?.local_conversation?.agent ?? null : null;
  const canTeleportToSessionRoot =
    props.variant === 'session'
    && providerId === 'local_conversation'
    && localConversationMode === 'agent'
    && localAgentCfg?.backend === 'daemon'
    && localAgentCfg?.teleportEnabled !== false
    && localAgentCfg?.stayInVoiceHome !== true
    && typeof props.sessionId === 'string'
    && props.sessionId.trim().length > 0;

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

  const locationAllowsVariant = (() => {
    if (surfaceLocation === 'sidebar') return props.variant === 'sidebar';
    if (surfaceLocation === 'session') return props.variant === 'session';
    // auto
    return scopeDefault === 'global' ? props.variant === 'sidebar' : props.variant === 'session';
  })();

  const visibleEvents = React.useMemo(() => {
    if (!Array.isArray(events) || events.length === 0) return EMPTY_EVENTS;
    const base = props.variant === 'sidebar' ? [...events].sort(sortEventByTsThenId) : events;
    const tail = base.length > 50 ? base.slice(base.length - 50) : base;
    return [...tail].reverse();
  }, [events, props.variant]);

  const showSurface =
    providerId !== 'off' &&
    locationAllowsVariant &&
    true;
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

  const canStart = allowsGlobalStart ? true : Boolean(startSessionId);
  const isSpeaking = snap.mode === 'speaking';
  const canStop = snap.canStop && snap.status !== 'disconnected';
  const toggleDisabledReason = !canStop && !canStart ? t('voiceSurface.selectSessionToStart') : null;
  const targetLabel =
    props.variant === 'sidebar' && voiceScope === 'global' && primaryActionSessionId
      ? (sessionLabelById.get(primaryActionSessionId) ?? primaryActionSessionId)
      : null;

	  const onTogglePress = () => {
	    if (canStop) {
	      fireAndForget(voiceSessionManager.stop(''), { tag: 'VoiceSurface.stop' });
	      return;
	    }
	    const resolvedStartSessionId =
	      providerId === 'local_conversation' && localConversationMode === 'agent' && props.variant === 'sidebar'
	        ? ''
	        : (allowsGlobalStart ? (startSessionId ?? '') : startSessionId);
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
      backgroundColor: theme.colors.surface,
    },
    props.style,
  ];

  return (
    <View style={containerStyle}>
      <View style={styles.headerRow}>
        <View style={styles.statusLeft}>
          <View style={[styles.micBadge, { backgroundColor: theme.colors.surfaceHigh, borderColor: theme.colors.divider }]}>
            <StatusDot color={statusInfo.dot} isPulsing={snap.status === 'connecting'} size={7} style={styles.dot as any} />
            <Ionicons name="mic" size={13} color={theme.colors.text} style={styles.micIcon as any} />
          </View>
          <View style={styles.statusTextCol}>
            <Text style={[styles.statusText, { color: theme.colors.text }]} numberOfLines={1}>
              {statusInfo.label}
            </Text>
            {targetLabel ? (
              <Text style={[styles.targetText, { color: theme.colors.textSecondary }]} numberOfLines={1}>
                {t('voiceSurface.targetSession')}: {targetLabel}
              </Text>
            ) : toggleDisabledReason ? (
              <Text style={[styles.targetText, { color: theme.colors.textSecondary }]} numberOfLines={1}>
                {toggleDisabledReason}
              </Text>
            ) : null}
          </View>
        </View>

        <View style={styles.statusRight}>
          {isSpeaking ? <VoiceBars isActive color={theme.colors.textSecondary} size="small" /> : null}

          {canTeleportToSessionRoot ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="teleport_voice_agent"
              onPress={() => {
                const sid = String(props.sessionId ?? '').trim();
                if (!sid) return;
                fireAndForget(teleportVoiceAgentToSessionRoot({ sessionId: sid }), { tag: 'VoiceSurface.teleport' });
              }}
              style={({ pressed }) => [{ opacity: pressed ? 0.72 : 1 }, styles.iconAction as any]}
            >
              <Ionicons name="navigate-outline" size={18} color={theme.colors.textSecondary} />
            </Pressable>
          ) : null}

          <PrimaryCircleIconButton
            onPress={onTogglePress}
            disabled={snap.status === 'connecting' || (!canStop && !canStart)}
            loading={snap.status === 'connecting'}
            active={snap.status !== 'disconnected' || providerId !== 'off'}
            accessibilityLabel={canStop ? t('voiceAssistant.tapToEnd') : t('voiceAssistant.label')}
          >
            {canStop ? (
              <Ionicons name="stop-circle" size={22} color={theme.colors.button?.primary?.tint ?? theme.colors.text} />
            ) : (
              <Image
                source={require('@/assets/images/icon-voice-white.png')}
                style={{ width: 22, height: 22 }}
                tintColor={theme.colors.button?.primary?.tint ?? theme.colors.text}
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
              accessibilityLabel="toggle_voice_activity"
              style={({ pressed }) => [{ opacity: pressed ? 0.72 : 1 }, styles.feedHeaderLeft as any]}
            >
              <Ionicons name={expanded ? 'chevron-down' : 'chevron-forward'} size={14} color={theme.colors.textSecondary} />
              <Text style={[styles.feedTitle, { color: theme.colors.textSecondary }]}>
                {t('voiceActivity.title')}
              </Text>
              <Text style={[styles.feedCount, { color: theme.colors.textSecondary }]}>
                {`${events.length}`}
              </Text>
            </Pressable>

            <Pressable
              onPress={onClearPress}
              disabled={events.length === 0 || (props.variant === 'session' && !feedSessionId)}
              accessibilityRole="button"
              accessibilityLabel="clear_voice_activity"
              style={({ pressed }) => [
                styles.clearButton,
                {
                  opacity: pressed ? 0.72 : 1,
                  backgroundColor: events.length === 0 ? 'transparent' : theme.colors.surfaceHigh,
                  borderColor: theme.colors.divider,
                },
              ]}
            >
              <Text style={[styles.clearText, { color: theme.colors.textSecondary }]}>{t('voiceActivity.clear')}</Text>
            </Pressable>
          </View>

          {expanded ? (
            <ScrollView style={styles.feedScroll} contentContainerStyle={styles.feedScrollContent as any}>
              {events.length === 0 ? (
                <Text style={[styles.emptyText, { color: theme.colors.textSecondary }]}>{t('voiceActivity.empty')}</Text>
              ) : (
                visibleEvents.map((e) => (
                  <Text key={e.id} style={[styles.eventText, { color: theme.colors.text }]} numberOfLines={3}>
                    {formatEvent(e, sessionLabelById)}
                  </Text>
                ))
              )}
            </ScrollView>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function formatEvent(event: any, sessionLabelById: Map<string, string>): string {
  const prefix = (() => {
    const sid = typeof event?.sessionId === 'string' ? event.sessionId : '';
    if (!sid) return '';
    const label = sid === VOICE_AGENT_GLOBAL_SESSION_ID ? 'Voice agent' : (sessionLabelById.get(sid) ?? sid);
    return `[${label}] `;
  })();
  switch (event.kind) {
    case 'user.text':
      return `${prefix}You: ${event.text}`;
    case 'assistant.text':
      return `${prefix}Assistant: ${event.text}`;
    case 'assistant.delta':
      return `${prefix}Assistant… ${event.textDelta}`;
    case 'action.executed':
      return `${prefix}Action: ${event.summary}`;
    case 'error':
      return `${prefix}Error: ${String(event.errorMessage ?? event.errorCode ?? 'error').split(VOICE_AGENT_GLOBAL_SESSION_ID).join('Voice agent')}`;
    case 'status':
      return `${prefix}Status: ${event.status} (${event.mode})`;
    case 'lifecycle.start':
      return `${prefix}Started`;
    case 'lifecycle.stop':
      return `${prefix}Stopped`;
    default:
      return `${prefix}${String(event.kind ?? 'event')}`;
  }
}

function sortEventByTsThenId(a: any, b: any): number {
  const ta = typeof a?.ts === 'number' ? a.ts : 0;
  const tb = typeof b?.ts === 'number' ? b.ts : 0;
  if (ta !== tb) return ta - tb;
  const ia = typeof a?.id === 'string' ? a.id : '';
  const ib = typeof b?.id === 'string' ? b.id : '';
  return ia.localeCompare(ib);
}

const stylesheet = StyleSheet.create((theme, runtime) => ({
  container: {
    alignSelf: 'stretch',
    // Match session list grouping density in the sidebar.
    marginHorizontal: 16,
    marginTop: 10,
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
    borderTopColor: theme.colors.divider,
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
