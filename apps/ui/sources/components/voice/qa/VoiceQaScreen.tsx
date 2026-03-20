import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useRouter } from 'expo-router';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { Text, TextInput } from '@/components/ui/text/Text';
import { t } from '@/text';
import { storage } from '@/sync/domains/state/storage';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import { useVoiceActivityStore } from '@/voice/activity/voiceActivityStore';
import { formatVoiceActivityEvent } from '@/voice/activity/formatVoiceActivityEvent';
import { createVoiceQaFormatterPrefs, formatVoiceQaSessionLabel } from '@/voice/qa/formatVoiceQaSessionLabel';
import { useVoiceQaStore } from '@/voice/qa/voiceQaStore';
import { voiceQaController } from '@/voice/qa/voiceQaController';
import { useVoiceTargetStore } from '@/voice/runtime/voiceTargetStore';
import { useVoiceSessionStore } from '@/voice/session/voiceSessionStore';
import { resolveVoiceSessionBindingByControlSessionId } from '@/voice/sessionBinding/resolveVoiceSessionBinding';
import { voiceSessionBindingStore } from '@/voice/sessionBinding/voiceSessionBindingStore';

function getConfiguredProviderLabel(providerId: string): string {
  switch (providerId) {
    case 'local_conversation':
      return t('settingsVoice.mode.local');
    case 'realtime_elevenlabs':
      return t('settingsVoice.mode.byo');
    case 'off':
      return t('settingsVoice.mode.off');
    default:
      return providerId;
  }
}

function VoiceQaField(props: Readonly<{ label: string; value: string; onChangeText: (value: string) => void; placeholder: string; multiline?: boolean; testID?: string }>) {
  const { theme } = useUnistyles();

  return (
    <View style={styles.fieldBlock}>
      <Text style={[styles.fieldLabel, { color: theme.colors.textSecondary }]}>{props.label}</Text>
      <TextInput
        testID={props.testID}
        style={[
          styles.input,
          {
            color: theme.colors.text,
            backgroundColor: theme.colors.surfaceHigh,
            borderColor: theme.colors.divider,
            minHeight: props.multiline ? 88 : 44,
          },
        ]}
        value={props.value}
        onChangeText={props.onChangeText}
        placeholder={props.placeholder}
        placeholderTextColor={theme.colors.input.placeholder}
        multiline={props.multiline === true}
        textAlignVertical={props.multiline ? 'top' : 'center'}
        autoCapitalize="none"
        autoCorrect={false}
      />
    </View>
  );
}

type ZustandStore<TState> = Readonly<{
  getState: () => TState;
  subscribe: (listener: (state: TState, prevState: TState) => void) => () => void;
}>;

function useStoreSnapshot<TState>(store: ZustandStore<TState>): TState {
  const [snapshot, setSnapshot] = React.useState(() => store.getState());

  React.useEffect(() => {
    return store.subscribe((nextState) => {
      setSnapshot(nextState);
    });
  }, [store]);

  return snapshot;
}

function normalizeSessionId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function VoiceQaScreen() {
  const { theme } = useUnistyles();
  const router = useRouter();
  const appState = useStoreSnapshot(storage);
  const voiceSessionState = useStoreSnapshot(useVoiceSessionStore);
  const targetState = useStoreSnapshot(useVoiceTargetStore);
  const qaState = useStoreSnapshot(useVoiceQaStore);
  const activityState = useStoreSnapshot(useVoiceActivityStore);
  const bindingState = useStoreSnapshot(voiceSessionBindingStore);
  const [sessionId, setSessionId] = React.useState('');
  const [initialContext, setInitialContext] = React.useState('');
  const [prompt, setPrompt] = React.useState('');
  const [contextUpdate, setContextUpdate] = React.useState('');
  const [busyAction, setBusyAction] = React.useState<string | null>(null);
  const sessionIdRef = React.useRef(sessionId);
  const initialContextRef = React.useRef(initialContext);
  const promptRef = React.useRef(prompt);
  const contextUpdateRef = React.useRef(contextUpdate);

  const setSessionIdWithRef = React.useCallback((value: string) => {
    sessionIdRef.current = value;
    setSessionId(value);
  }, []);
  const setInitialContextWithRef = React.useCallback((value: string) => {
    initialContextRef.current = value;
    setInitialContext(value);
  }, []);
  const setPromptWithRef = React.useCallback((value: string) => {
    promptRef.current = value;
    setPrompt(value);
  }, []);
  const setContextUpdateWithRef = React.useCallback((value: string) => {
    contextUpdateRef.current = value;
    setContextUpdate(value);
  }, []);

  const voice: any = appState.settings?.voice;
  const effectiveActivitySessionId = qaState.runtimeSessionId ?? qaState.sessionId ?? targetState.primaryActionSessionId ?? targetState.lastFocusedSessionId ?? '';
  const activityEvents = React.useMemo(
    () => (effectiveActivitySessionId ? (activityState.eventsBySessionId[effectiveActivitySessionId] ?? []) : []),
    [effectiveActivitySessionId, activityState.eventsBySessionId],
  );

  const runAction = React.useCallback(async (name: string, action: () => Promise<void>) => {
    setBusyAction(name);
    try {
      await action();
    } catch {
      // controller/store already captures the failure details for QA purposes
    } finally {
      setBusyAction((current) => (current === name ? null : current));
    }
  }, []);

  const configuredProviderId = String(voice?.providerId ?? 'off');
  const configuredProviderLabel = getConfiguredProviderLabel(configuredProviderId);
  const formatterPrefs = React.useMemo(
    () => createVoiceQaFormatterPrefs(appState.settings),
    [appState.settings],
  );
  const boundConversationSessionId = React.useMemo(() => {
    if (qaState.runtimeSessionId) return qaState.runtimeSessionId;
    const controlSessionId = qaState.sessionId ?? voiceSessionState.sessionId ?? null;
    if (!controlSessionId) return null;
    return resolveVoiceSessionBindingByControlSessionId({ controlSessionId })?.conversationSessionId ?? null;
  }, [bindingState, qaState.runtimeSessionId, qaState.sessionId, voiceSessionState.sessionId]);
  const boundVoiceBinding = React.useMemo(() => {
    const controlSessionId = qaState.sessionId ?? voiceSessionState.sessionId ?? null;
    if (!controlSessionId) return null;
    return resolveVoiceSessionBindingByControlSessionId({ controlSessionId }) ?? null;
  }, [bindingState, qaState.sessionId, voiceSessionState.sessionId]);
  const helperSessionId = React.useMemo(() => {
    const qaTargetSessionId = normalizeSessionId(qaState.targetSessionId);
    if (qaTargetSessionId && qaTargetSessionId !== VOICE_AGENT_GLOBAL_SESSION_ID) {
      return qaTargetSessionId;
    }
    return (
      normalizeSessionId(boundVoiceBinding?.targetSessionId)
      ?? normalizeSessionId(targetState.primaryActionSessionId)
      ?? normalizeSessionId(targetState.lastFocusedSessionId)
      ?? qaTargetSessionId
      ?? null
    );
  }, [
    boundVoiceBinding?.targetSessionId,
    qaState.targetSessionId,
    targetState.lastFocusedSessionId,
    targetState.primaryActionSessionId,
  ]);
  const helperSessionText = React.useMemo(
    () =>
      formatVoiceQaSessionLabel(helperSessionId, formatterPrefs, {
        emptyLabel: t('voiceSurface.noTarget'),
        globalLabel: t('voiceActivity.format.voiceAgent'),
        fallbackLabel: 'Selected session',
      }),
    [formatterPrefs, helperSessionId],
  );
  const runtimeSessionId =
    normalizeSessionId(qaState.runtimeSessionId)
    ?? normalizeSessionId(boundVoiceBinding?.conversationSessionId)
    ?? normalizeSessionId(voiceSessionState.sessionId)
    ?? null;
  const runtimeSessionText = React.useMemo(
    () =>
      formatVoiceQaSessionLabel(runtimeSessionId, formatterPrefs, {
        emptyLabel: t('common.none'),
        globalLabel: t('voiceActivity.format.voiceAgent'),
        fallbackLabel: 'Voice conversation',
      }),
    [formatterPrefs, runtimeSessionId],
  );

  return (
    <ScrollView style={[styles.container, { backgroundColor: theme.colors.groupped.background }]} contentContainerStyle={styles.content}>
      <View style={styles.header}>
        <Text style={[styles.title, { color: theme.colors.text }]}>{t('devVoiceQa.title')}</Text>
        <Text style={[styles.subtitle, { color: theme.colors.textSecondary }]}>{t('devVoiceQa.subtitle')}</Text>
        <Text style={[styles.instructions, { color: theme.colors.textSecondary }]}>{t('devVoiceQa.instructions')}</Text>
      </View>

      <ItemList>
        <ItemGroup title={t('devVoiceQa.configurationTitle')}>
          <Item title={t('devVoiceQa.configuredProvider')} detail={configuredProviderLabel} showChevron={false} />
          <Item title={t('devVoiceQa.qaProvider')} detail={qaState.provider ?? t('common.none')} showChevron={false} />
          <Item title={t('devVoiceQa.qaStatus')} detail={qaState.status} showChevron={false} />
          <Item title={t('devVoiceQa.targetSession')} detail={helperSessionText} showChevron={false} />
          <Item title={t('devVoiceQa.runtimeSession')} detail={runtimeSessionText} showChevron={false} />
        </ItemGroup>

        <ItemGroup title={t('devVoiceQa.inputsTitle')}>
          <View style={styles.groupContent}>
            <VoiceQaField
              label={t('devVoiceQa.sessionIdLabel')}
              value={sessionId}
              onChangeText={setSessionIdWithRef}
              placeholder={t('devVoiceQa.sessionIdPlaceholder')}
              testID="voiceQa.sessionIdInput"
            />
            <VoiceQaField
              label={t('devVoiceQa.initialContextLabel')}
              value={initialContext}
              onChangeText={setInitialContextWithRef}
              placeholder={t('devVoiceQa.initialContextPlaceholder')}
              multiline
              testID="voiceQa.initialContextInput"
            />
            <VoiceQaField
              label={t('devVoiceQa.promptLabel')}
              value={prompt}
              onChangeText={setPromptWithRef}
              placeholder={t('devVoiceQa.promptPlaceholder')}
              multiline
              testID="voiceQa.promptInput"
            />
            <VoiceQaField
              label={t('devVoiceQa.contextUpdateLabel')}
              value={contextUpdate}
              onChangeText={setContextUpdateWithRef}
              placeholder={t('devVoiceQa.contextUpdatePlaceholder')}
              multiline
              testID="voiceQa.contextUpdateInput"
            />
          </View>
        </ItemGroup>

        <ItemGroup title={t('devVoiceQa.actionsTitle')}>
          <View style={styles.groupContent}>
            <View style={styles.buttonRow}>
              <RoundButton
                testID="voiceQa.start"
                title={t('common.start')}
                size="normal"
                loading={busyAction === 'start'}
                onPress={() =>
                  void runAction('start', async () => {
                    await voiceQaController.start({
                      sessionId: sessionIdRef.current,
                      initialContext: initialContextRef.current,
                    });
                  })
                }
              />
              <RoundButton
                testID="voiceQa.stop"
                title={t('voiceSurface.stop')}
                size="normal"
                display="inverted"
                loading={busyAction === 'stop'}
                onPress={() =>
                  void runAction('stop', async () => {
                    await voiceQaController.stop({ sessionId: sessionIdRef.current });
                  })
                }
              />
              <RoundButton
                testID="voiceQa.clear"
                title={t('voiceActivity.clear')}
                size="normal"
                display="inverted"
                onPress={() => voiceQaController.clear()}
              />
              {boundConversationSessionId ? (
                <RoundButton
                  testID="voiceQa.openConversation"
                  title={t('common.open')}
                  size="normal"
                  display="inverted"
                  onPress={() => router.push(`/session/${boundConversationSessionId}` as any)}
                />
              ) : null}
            </View>
            <View style={styles.buttonRow}>
              <RoundButton
                testID="voiceQa.send"
                title={t('common.send')}
                size="normal"
                loading={busyAction === 'send'}
                onPress={() =>
                  void runAction('send', async () => {
                    await voiceQaController.sendPrompt({
                      sessionId: sessionIdRef.current,
                      prompt: promptRef.current,
                    });
                  })
                }
              />
              <RoundButton
                testID="voiceQa.sendContext"
                title={t('devVoiceQa.sendContext')}
                size="normal"
                display="inverted"
                loading={busyAction === 'context'}
                onPress={() =>
                  void runAction('context', async () => {
                    await voiceQaController.sendContextUpdate({
                      sessionId: sessionIdRef.current,
                      update: contextUpdateRef.current,
                    });
                  })
                }
              />
            </View>
            <Text style={[styles.noteText, { color: theme.colors.textSecondary }]}>{t('devVoiceQa.usesCurrentProvider')}</Text>
            <Text style={[styles.noteText, { color: theme.colors.textSecondary }]}>{t('devVoiceQa.localModeHint')}</Text>
            <Text style={[styles.noteText, { color: theme.colors.textSecondary }]}>{t('devVoiceQa.elevenLabsHint')}</Text>
          </View>
        </ItemGroup>

        <ItemGroup title={t('devVoiceQa.transcriptTitle')}>
          <View style={styles.groupContent}>
            {qaState.entries.length === 0 ? (
              <Text style={[styles.emptyText, { color: theme.colors.textSecondary }]}>{t('devVoiceQa.transcriptEmpty')}</Text>
            ) : (
              qaState.entries.map((entry) => (
                <View
                  key={entry.id}
                  style={[
                    styles.logEntry,
                    {
                      backgroundColor: theme.colors.surfaceHigh,
                      borderColor: theme.colors.divider,
                    },
                  ]}
                >
                  <Text style={[styles.entryKind, { color: theme.colors.textSecondary }]}>{entry.kind}</Text>
                  <Text style={[styles.entryText, { color: theme.colors.text }]} selectable>
                    {entry.text}
                  </Text>
                  {entry.raw ? (
                    <Text style={[styles.entryRaw, { color: theme.colors.textSecondary }]} selectable>
                      {entry.raw}
                    </Text>
                  ) : null}
                </View>
              ))
            )}
          </View>
        </ItemGroup>

        <ItemGroup title={t('devVoiceQa.activityTitle')}>
          <View style={styles.groupContent}>
            {activityEvents.length === 0 ? (
              <Text style={[styles.emptyText, { color: theme.colors.textSecondary }]}>{t('devVoiceQa.activityEmpty')}</Text>
            ) : (
              activityEvents.map((event) => (
                <Text key={event.id} style={[styles.activityText, { color: theme.colors.text }]} selectable>
                  {formatVoiceActivityEvent(event)}
                </Text>
              ))
            )}
          </View>
        </ItemGroup>
      </ItemList>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    paddingBottom: 48,
  },
  header: {
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 12,
    gap: 8,
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
  },
  subtitle: {
    fontSize: 15,
  },
  instructions: {
    fontSize: 14,
    lineHeight: 20,
  },
  groupContent: {
    padding: 16,
    gap: 12,
  },
  fieldBlock: {
    gap: 6,
  },
  fieldLabel: {
    fontSize: 13,
    fontWeight: '600',
  },
  input: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
  },
  buttonRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  noteText: {
    fontSize: 13,
    lineHeight: 18,
  },
  emptyText: {
    fontSize: 14,
  },
  logEntry: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    gap: 6,
  },
  entryKind: {
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  entryText: {
    fontSize: 14,
    lineHeight: 20,
  },
  entryRaw: {
    fontSize: 12,
    lineHeight: 18,
  },
  activityText: {
    fontSize: 14,
    lineHeight: 20,
  },
});

export default VoiceQaScreen;
