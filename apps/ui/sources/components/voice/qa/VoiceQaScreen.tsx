import * as React from 'react';
import { Platform, ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { readServerEnabledBit } from '@happier-dev/protocol';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { Text, TextInput } from '@/components/ui/text/Text';
import { t, tLoose } from '@/text';
import { storage } from '@/sync/domains/state/storage';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import { voiceConversationBindingResolver } from '@/voice/binding/VoiceConversationBindingResolver';
import { voiceSessionBindingStore } from '@/voice/binding/voiceConversationBindingStore';
import { createVoiceQaFormatterPrefs, formatVoiceQaSessionLabel } from '@/voice/qa/formatVoiceQaSessionLabel';
import { voiceQaRecordedAudioController } from '@/voice/qa/voiceQaRecordedAudioController';
import { useVoiceQaStore } from '@/voice/qa/voiceQaStore';
import { voiceQaController } from '@/voice/qa/voiceQaController';
import { voiceQaOutputFixturePlayback } from '@/voice/qa/voiceQaOutputFixturePlayback';
import {
  getVoiceQaOutputTapSnapshot,
  setVoiceQaOutputTapEnabled,
  subscribeToVoiceQaOutputTap,
} from '@/voice/qa/voiceQaOutputTap';
import { getVoiceConversationRuntimeSnapshot } from '@/voice/runtime/machine/voiceConversationRuntimeStore';
import { daemonSpeechStreamDiagnostics } from '@/voice/runtime/daemonInference/daemonSpeechStreamDiagnostics';
import { useVoiceTargetStore } from '@/voice/runtime/voiceTargetStore';
import { useVoiceSessionStore } from '@/voice/session/voiceSessionStore';
import { selectVoiceTranscriptEntriesForConversationSession } from '@/voice/transcript/voiceTranscriptSelectors';
import {
  readLocalConversationVoiceSettings,
  readLocalDirectVoiceSettings,
  voiceSettingsParse,
} from '@/sync/domains/settings/voiceSettings';
import { createDefaultVoiceProviderRegistry } from '@/voice/registry/defaultRegistry';
import { resolveSelectedVoiceProviderTitleKey } from '@/voice/registry/providerSelection';
import { resolveVoiceExecutionMachineIdFromState } from '@/voice/settings/executionMachine';
import { getMachineRpcPeerMediationReceiptsSnapshot } from '@/sync/domains/machines/peer/mediation/rpc/receiptLog';
import { getCachedReadyServerFeatures } from '@/sync/api/capabilities/getReadyServerFeatures';
import { apiSocket } from '@/sync/api/session/apiSocket';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { readEndpointFromMachineState } from '@/sync/domains/machines/peer/mediation/stream/productionRouteHttp';
import { readVoiceDaemonHttpPortFromState } from '@/voice/settings/voiceProviderLocalAvailability';
import { resolveVoiceQaTransportReadiness } from './voiceQaTransportReadiness';

function VoiceQaField(props: Readonly<{ label: string; value: string; onChangeText: (value: string) => void; placeholder: string; multiline?: boolean; testID?: string }>) {
  const { theme } = useUnistyles();

  return (
    <View style={styles.fieldBlock}>
      <Text style={[styles.fieldLabel, { color: theme.colors.text.secondary }]}>{props.label}</Text>
      <TextInput
        testID={props.testID}
        style={[
          styles.input,
          {
            color: theme.colors.text.primary,
            backgroundColor: theme.colors.surface.inset,
            borderColor: theme.colors.border.default,
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

type RecordedAudioQaStatus =
  | 'idle'
  | 'ready'
  | 'running'
  | 'success'
  | 'empty'
  | 'error'
  | 'missing_input';

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

function normalizeVoiceQaRouteParam(value: unknown): string {
  if (Array.isArray(value)) {
    return normalizeVoiceQaRouteParam(value[0]);
  }
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
}

export function VoiceQaScreen() {
  const { theme } = useUnistyles();
  const router = useRouter();
  const routeParams = useLocalSearchParams<{
    voiceQaSessionId?: string | string[];
    voiceQaMode?: string | string[];
    voiceQaOutputCapture?: string | string[];
    voiceQaOutputFixtureUrl?: string | string[];
    voiceQaOutputCancelMs?: string | string[];
    voiceQaRecordedAudioDaemonSttPackId?: string | string[];
    voiceQaRecordedAudioDaemonMachineId?: string | string[];
    voiceQaRecordedAudioDaemonBasePath?: string | string[];
  }>();
  const appState = useStoreSnapshot(storage);
  const voiceSessionState = useStoreSnapshot(useVoiceSessionStore);
  const targetState = useStoreSnapshot(useVoiceTargetStore);
  const qaState = useStoreSnapshot(useVoiceQaStore);
  const bindingState = useStoreSnapshot(voiceSessionBindingStore);
  const [sessionId, setSessionId] = React.useState('');
  const [initialContext, setInitialContext] = React.useState('');
  const [prompt, setPrompt] = React.useState('');
  const [contextUpdate, setContextUpdate] = React.useState('');
  const [busyAction, setBusyAction] = React.useState<string | null>(null);
  const [recordedAudioUri, setRecordedAudioUri] = React.useState('');
  const [recordedAudioSelectedFileName, setRecordedAudioSelectedFileName] = React.useState<string | null>(null);
  const [recordedAudioDaemonSttPackId, setRecordedAudioDaemonSttPackId] = React.useState('');
  const [recordedAudioDaemonMachineId, setRecordedAudioDaemonMachineId] = React.useState('');
  const [recordedAudioDaemonBasePath, setRecordedAudioDaemonBasePath] = React.useState('');
  const [recordedAudioQaStatus, setRecordedAudioQaStatus] = React.useState<RecordedAudioQaStatus>('idle');
  const [recordedAudioResult, setRecordedAudioResult] = React.useState<string | null>(null);
  const sessionIdRef = React.useRef(sessionId);
  const initialContextRef = React.useRef(initialContext);
  const promptRef = React.useRef(prompt);
  const contextUpdateRef = React.useRef(contextUpdate);
  const recordedAudioObjectUrlRef = React.useRef<string | null>(null);
  const recordedAudioWebFileRef = React.useRef<File | null>(null);
  const recordedAudioFileInputRef = React.useRef<HTMLInputElement | null>(null);
  const recordedAudioAbortControllersRef = React.useRef(new Set<AbortController>());
  const recordedAudioSettingsScopeOwnerId = React.useId();
  const routeSessionId = normalizeVoiceQaRouteParam(routeParams.voiceQaSessionId);
  const routeQaMode = normalizeVoiceQaRouteParam(routeParams.voiceQaMode) === 'media' ? 'media' : 'text';
  const routeOutputCaptureEnabled = normalizeVoiceQaRouteParam(routeParams.voiceQaOutputCapture) === '1';
  const routeOutputFixtureUrl = normalizeVoiceQaRouteParam(routeParams.voiceQaOutputFixtureUrl);
  const routeOutputCancelMs = React.useMemo(() => {
    const value = Number(normalizeVoiceQaRouteParam(routeParams.voiceQaOutputCancelMs));
    return Number.isInteger(value) && value > 0 && value <= 60_000 ? value : null;
  }, [routeParams.voiceQaOutputCancelMs]);
  const routeRecordedAudioDaemonSttPackId = normalizeVoiceQaRouteParam(routeParams.voiceQaRecordedAudioDaemonSttPackId);
  const routeRecordedAudioDaemonMachineId = normalizeVoiceQaRouteParam(routeParams.voiceQaRecordedAudioDaemonMachineId);
  const routeRecordedAudioDaemonBasePath = normalizeVoiceQaRouteParam(routeParams.voiceQaRecordedAudioDaemonBasePath);

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
  React.useEffect(() => {
    if (!sessionIdRef.current && routeSessionId) {
      sessionIdRef.current = routeSessionId;
      setSessionId(routeSessionId);
    }
  }, [routeSessionId]);
  React.useEffect(() => {
    if (!recordedAudioDaemonSttPackId && routeRecordedAudioDaemonSttPackId) {
      setRecordedAudioDaemonSttPackId(routeRecordedAudioDaemonSttPackId);
    }
  }, [recordedAudioDaemonSttPackId, routeRecordedAudioDaemonSttPackId]);
  React.useEffect(() => {
    if (!recordedAudioDaemonMachineId && routeRecordedAudioDaemonMachineId) {
      setRecordedAudioDaemonMachineId(routeRecordedAudioDaemonMachineId);
    }
  }, [recordedAudioDaemonMachineId, routeRecordedAudioDaemonMachineId]);
  React.useEffect(() => {
    if (!recordedAudioDaemonBasePath && routeRecordedAudioDaemonBasePath) {
      setRecordedAudioDaemonBasePath(routeRecordedAudioDaemonBasePath);
    }
  }, [recordedAudioDaemonBasePath, routeRecordedAudioDaemonBasePath]);
  const releaseRecordedAudioObjectUrl = React.useCallback(() => {
    const currentObjectUrl = recordedAudioObjectUrlRef.current;
    if (!currentObjectUrl) return;
    if (typeof URL.revokeObjectURL === 'function') {
      URL.revokeObjectURL(currentObjectUrl);
    }
    recordedAudioObjectUrlRef.current = null;
  }, []);
  const setRecordedAudioUriWithState = React.useCallback((value: string) => {
    if (recordedAudioObjectUrlRef.current && recordedAudioObjectUrlRef.current !== value) {
      releaseRecordedAudioObjectUrl();
    }
    setRecordedAudioUri(value);
  }, [releaseRecordedAudioObjectUrl]);

  const voice: any = appState.settings?.voice;
  const effectiveActivitySessionId = qaState.runtimeSessionId ?? qaState.sessionId ?? targetState.primaryActionSessionId ?? targetState.lastFocusedSessionId ?? '';

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
  const openRecordedAudioFilePicker = React.useCallback(() => {
    recordedAudioFileInputRef.current?.click();
  }, []);
  const handleRecordedAudioUriChange = React.useCallback((value: string) => {
    recordedAudioWebFileRef.current = null;
    setRecordedAudioSelectedFileName(null);
    setRecordedAudioResult(null);
    const trimmed = value.trim();
    setRecordedAudioQaStatus(trimmed ? 'ready' : 'idle');
    setRecordedAudioUriWithState(value);
  }, [setRecordedAudioUriWithState]);
  const handleRecordedAudioFileChange = React.useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = event.target.files?.[0] ?? null;
    if (!selectedFile || typeof URL.createObjectURL !== 'function') {
      return;
    }

    releaseRecordedAudioObjectUrl();
    const objectUrl = URL.createObjectURL(selectedFile);
    recordedAudioObjectUrlRef.current = objectUrl;
    recordedAudioWebFileRef.current = selectedFile;
    setRecordedAudioSelectedFileName(selectedFile.name);
    setRecordedAudioResult(null);
    setRecordedAudioQaStatus('ready');
    setRecordedAudioUriWithState(objectUrl);
    event.target.value = '';
  }, [releaseRecordedAudioObjectUrl, setRecordedAudioUriWithState]);
  const runRecordedAudioTranscription = React.useCallback(async () => {
    const trimmedUri = recordedAudioUri.trim();
    if (!trimmedUri) {
      setRecordedAudioResult(null);
      setRecordedAudioQaStatus('missing_input');
      return;
    }

    setRecordedAudioQaStatus('running');
    setRecordedAudioResult(null);
    const abortController = new AbortController();
    recordedAudioAbortControllersRef.current.add(abortController);
    try {
      const transcription = await voiceQaRecordedAudioController.transcribe({
        sessionId: sessionIdRef.current,
        uri: trimmedUri,
        packId: recordedAudioDaemonSttPackId.trim(),
        machineId: recordedAudioDaemonMachineId.trim(),
        basePath: recordedAudioDaemonBasePath.trim(),
        webFile: recordedAudioWebFileRef.current,
        settingsScopeOwnerId: recordedAudioSettingsScopeOwnerId,
        signal: abortController.signal,
      });
      if (abortController.signal.aborted) return;
      if (transcription) {
        setRecordedAudioResult(transcription);
        setRecordedAudioQaStatus('success');
        return;
      }
      setRecordedAudioQaStatus('empty');
    } catch (error) {
      if (abortController.signal.aborted) return;
      setRecordedAudioResult(error instanceof Error ? error.message : 'recorded_audio_transcription_failed');
      setRecordedAudioQaStatus('error');
    } finally {
      recordedAudioAbortControllersRef.current.delete(abortController);
    }
  }, [
    recordedAudioDaemonBasePath,
    recordedAudioDaemonMachineId,
    recordedAudioDaemonSttPackId,
    recordedAudioSettingsScopeOwnerId,
    recordedAudioUri,
  ]);
  React.useEffect(() => () => {
    for (const abortController of recordedAudioAbortControllersRef.current) {
      abortController.abort();
    }
    recordedAudioAbortControllersRef.current.clear();
    voiceQaRecordedAudioController.releaseTemporarySettingsForOwner(recordedAudioSettingsScopeOwnerId);
    releaseRecordedAudioObjectUrl();
  }, [recordedAudioSettingsScopeOwnerId, releaseRecordedAudioObjectUrl]);

  const configuredVoiceSettings = voiceSettingsParse(voice);
  const configuredProviderId = configuredVoiceSettings.providerId;
  const configuredProviderRegistry = React.useMemo(() => createDefaultVoiceProviderRegistry(), []);
  const configuredProviderTitleKey = resolveSelectedVoiceProviderTitleKey(
    configuredVoiceSettings,
    configuredProviderRegistry,
  );
  const configuredProviderLabel = configuredProviderTitleKey
    ? tLoose(configuredProviderTitleKey)
    : configuredProviderId ?? t('settingsVoice.mode.off');
  const configuredLocalSettings = configuredProviderId === 'local_direct'
    ? readLocalDirectVoiceSettings(configuredVoiceSettings)
    : configuredProviderId === 'local_conversation'
      ? readLocalConversationVoiceSettings(configuredVoiceSettings)
      : null;
  const configuredLocalSttProvider = configuredLocalSettings?.stt.provider ?? null;
  const configuredLocalSttModelPackId = configuredLocalSettings?.stt.localNeural.assetId?.trim() || null;
  const configuredLocalSttBaseUrl = configuredLocalSettings?.stt.openaiCompat.baseUrl?.trim() ?? '';
  const executionMachineId = resolveVoiceExecutionMachineIdFromState(appState);
  const formatterPrefs = React.useMemo(
    () => createVoiceQaFormatterPrefs(appState.settings),
    [appState.settings],
  );
  const boundConversationSessionId = React.useMemo(() => {
    if (qaState.runtimeSessionId) return qaState.runtimeSessionId;
    const controlSessionId = qaState.sessionId ?? voiceSessionState.sessionId ?? null;
    if (!controlSessionId) return null;
    return voiceConversationBindingResolver.resolveByControlSessionId({ controlSessionId })?.conversationSessionId ?? null;
  }, [bindingState, qaState.runtimeSessionId, qaState.sessionId, voiceSessionState.sessionId]);
  const boundVoiceBinding = React.useMemo(() => {
    const controlSessionId = qaState.sessionId ?? voiceSessionState.sessionId ?? null;
    if (!controlSessionId) return null;
    return voiceConversationBindingResolver.resolveByControlSessionId({ controlSessionId }) ?? null;
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
        fallbackLabel: t('devVoiceQa.targetSession'),
      }),
    [appState, formatterPrefs, helperSessionId],
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
        fallbackLabel: t('devVoiceQa.runtimeSession'),
      }),
    [appState, formatterPrefs, runtimeSessionId],
  );
  const projectedConversationSessionId = React.useMemo(
    () => normalizeSessionId(boundConversationSessionId) ?? normalizeSessionId(effectiveActivitySessionId),
    [boundConversationSessionId, effectiveActivitySessionId],
  );
  const projectedConversationEntries = React.useMemo(
    () =>
      selectVoiceTranscriptEntriesForConversationSession(
        appState,
        projectedConversationSessionId,
      ),
    [appState, projectedConversationSessionId],
  );
  const outputTapSnapshot = React.useSyncExternalStore(
    subscribeToVoiceQaOutputTap,
    getVoiceQaOutputTapSnapshot,
    getVoiceQaOutputTapSnapshot,
  );
  const daemonSpeechTransportSnapshot = React.useSyncExternalStore(
    daemonSpeechStreamDiagnostics.subscribe,
    daemonSpeechStreamDiagnostics.snapshot,
    daemonSpeechStreamDiagnostics.snapshot,
  );
  const playOutputFixture = React.useCallback(async () => {
    if (!routeOutputCaptureEnabled || !routeOutputFixtureUrl) return;
    try {
      await voiceQaOutputFixturePlayback.play(routeOutputFixtureUrl);
    } catch (error) {
      useVoiceQaStore
        .getState()
        .appendError(error instanceof Error ? error.message : 'voice_qa_output_fixture_failed');
      throw error;
    }
  }, [routeOutputCaptureEnabled, routeOutputFixtureUrl]);
  React.useEffect(() => {
    setVoiceQaOutputTapEnabled(routeOutputCaptureEnabled);
    return () => {
      voiceQaOutputFixturePlayback.stop();
      setVoiceQaOutputTapEnabled(false);
    };
  }, [routeOutputCaptureEnabled, routeOutputFixtureUrl]);
  React.useEffect(() => {
    if (
      routeOutputCancelMs === null
      || outputTapSnapshot.artifact?.lifecycle !== 'playing'
    ) {
      return;
    }
    const cancelTimer = setTimeout(() => {
      voiceQaOutputFixturePlayback.stop();
    }, routeOutputCancelMs);
    return () => {
      clearTimeout(cancelTimer);
    };
  }, [
    outputTapSnapshot.artifact?.id,
    outputTapSnapshot.artifact?.lifecycle,
    routeOutputCancelMs,
  ]);
  const runtimeSnapshot = getVoiceConversationRuntimeSnapshot();
  const activeServerSnapshot = getActiveServerSnapshot();
  const cachedServerFeatures = getCachedReadyServerFeatures({
    serverId: activeServerSnapshot.serverId,
  });
  const daemonHttpPort = activeServerSnapshot.serverId && executionMachineId
    ? readVoiceDaemonHttpPortFromState({
        state: appState,
        serverId: activeServerSnapshot.serverId,
        machineId: executionMachineId,
      })
    : null;
  const directEndpoint = activeServerSnapshot.serverId && executionMachineId
    ? readEndpointFromMachineState({
        serverId: activeServerSnapshot.serverId,
        machineId: executionMachineId,
      })
    : null;
  const transportReadiness = resolveVoiceQaTransportReadiness({
    serverFeatures: cachedServerFeatures,
    serverId: activeServerSnapshot.serverId,
    machineId: executionMachineId,
    daemonHttpPort,
    directEndpoint,
    accountProfileId: appState.profile?.id,
    socketStatus: appState.socketStatus,
    activeSocketId: apiSocket.getSocketId(),
  });
  const machineRpcReceipts = getMachineRpcPeerMediationReceiptsSnapshot()
    .filter((receipt) => String(receipt.method ?? '').startsWith('daemon.voice'))
    .slice(-8);
  const mediaSnapshotJson = JSON.stringify({
    status: voiceSessionState.status,
    mode: voiceSessionState.mode,
    runtimeSessionId,
    canStop: voiceSessionState.canStop,
    micMuted: voiceSessionState.micMuted === true,
    errorCode: voiceSessionState.errorCode ?? null,
    configuredProviderId,
    executionMachineId,
    localSttProvider: configuredLocalSttProvider,
    localSttModelPackId: configuredLocalSttModelPackId,
    localSttBaseUrlConfigured: configuredLocalSttBaseUrl.length > 0,
    ...transportReadiness,
    runtimeState: runtimeSnapshot.state,
    runtimeError: runtimeSnapshot.error
      ? {
          kind: runtimeSnapshot.error.kind,
          reason: runtimeSnapshot.error.reason,
          phase: runtimeSnapshot.error.phase,
          retryPolicy: runtimeSnapshot.error.retryPolicy,
          recoveryAction: runtimeSnapshot.error.recoveryAction,
          presentation: runtimeSnapshot.error.presentation,
        }
      : null,
    serverRoute: {
      activeServerId: activeServerSnapshot.serverId,
      activeServerUrl: activeServerSnapshot.serverUrl,
      rpcDirectPeerEnabled: cachedServerFeatures
        ? readServerEnabledBit(cachedServerFeatures, 'machines.rpc.directPeer') === true
        : null,
    },
    machineRpcReceipts,
  });
  const outputArtifactJson = outputTapSnapshot.artifact
    ? JSON.stringify({
        id: outputTapSnapshot.artifact.id,
        format: outputTapSnapshot.artifact.format,
        originalByteLength: outputTapSnapshot.artifact.originalByteLength,
        capturedByteLength: outputTapSnapshot.artifact.capturedByteLength,
        truncated: outputTapSnapshot.artifact.truncated,
        lifecycle: outputTapSnapshot.artifact.lifecycle,
        errorCode: outputTapSnapshot.artifact.errorCode,
      })
    : 'null';

  return (
    <ScrollView style={[styles.container, { backgroundColor: theme.colors.background.canvas }]} contentContainerStyle={styles.content}>
      <View style={styles.header}>
        <Text style={[styles.title, { color: theme.colors.text.primary }]}>{t('devVoiceQa.title')}</Text>
        <Text style={[styles.subtitle, { color: theme.colors.text.secondary }]}>{t('devVoiceQa.subtitle')}</Text>
        <Text style={[styles.instructions, { color: theme.colors.text.secondary }]}>{t('devVoiceQa.instructions')}</Text>
      </View>

      <ItemList>
        <ItemGroup title={t('devVoiceQa.configurationTitle')}>
          <Item title={t('devVoiceQa.configuredProvider')} detail={configuredProviderLabel} showChevron={false} />
          <Item title={t('devVoiceQa.qaProvider')} detail={qaState.provider ?? t('common.none')} showChevron={false} />
          <Item title={t('devVoiceQa.qaStatus')} detail={qaState.status} showChevron={false} />
          <Item title={t('devVoiceQa.targetSession')} detail={helperSessionText} showChevron={false} />
          <Item title={t('devVoiceQa.runtimeSession')} detail={runtimeSessionText} showChevron={false} />
          <Text testID="voiceQa.media.snapshot" accessible={false} style={styles.qaEvidenceText}>
            {mediaSnapshotJson}
          </Text>
          <Text testID="voiceQa.daemonSpeechTransport.snapshot" accessible={false} style={styles.qaEvidenceText}>
            {JSON.stringify(daemonSpeechTransportSnapshot)}
          </Text>
          <Text
            testID="voiceQa.output.artifact"
            accessible={false}
            style={styles.qaEvidenceText}
          >
            {outputArtifactJson}
          </Text>
          <Text
            testID="voiceQa.output.artifactBytes"
            accessible={false}
            style={styles.qaEvidenceText}
          >
            {outputTapSnapshot.artifact?.bytesBase64 ?? ''}
          </Text>
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
                      ...(routeQaMode === 'media' ? { mode: 'media' as const } : {}),
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
              {routeOutputCaptureEnabled && routeOutputFixtureUrl ? (
                <RoundButton
                  testID="voiceQa.output.playFixture"
                  title={t('common.start')}
                  size="normal"
                  display="inverted"
                  loading={busyAction === 'outputFixture'}
                  onPress={() => void runAction('outputFixture', playOutputFixture)}
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
            <Text style={[styles.noteText, { color: theme.colors.text.secondary }]}>{t('devVoiceQa.usesCurrentProvider')}</Text>
            <Text style={[styles.noteText, { color: theme.colors.text.secondary }]}>{t('devVoiceQa.localModeHint')}</Text>
            <Text style={[styles.noteText, { color: theme.colors.text.secondary }]}>{t('devVoiceQa.elevenLabsHint')}</Text>
          </View>
        </ItemGroup>

        <ItemGroup title={t('devVoiceQa.recordedAudio.title')}>
          <View style={styles.groupContent}>
            <VoiceQaField
              label={t('devVoiceQa.recordedAudio.uriLabel')}
              value={recordedAudioUri}
              onChangeText={handleRecordedAudioUriChange}
              placeholder={t('devVoiceQa.recordedAudio.uriPlaceholder')}
              testID="voiceQa.recordedAudio.uriInput"
            />
            <VoiceQaField
              label={t('devVoiceQa.recordedAudio.daemonPackIdLabel')}
              value={recordedAudioDaemonSttPackId}
              onChangeText={setRecordedAudioDaemonSttPackId}
              placeholder={t('devVoiceQa.recordedAudio.daemonPackIdPlaceholder')}
              testID="voiceQa.recordedAudio.daemonPackIdInput"
            />
            <VoiceQaField
              label={t('devVoiceQa.recordedAudio.daemonMachineIdLabel')}
              value={recordedAudioDaemonMachineId}
              onChangeText={setRecordedAudioDaemonMachineId}
              placeholder={t('devVoiceQa.recordedAudio.daemonMachineIdPlaceholder')}
              testID="voiceQa.recordedAudio.daemonMachineIdInput"
            />
            <VoiceQaField
              label={t('devVoiceQa.recordedAudio.daemonBasePathLabel')}
              value={recordedAudioDaemonBasePath}
              onChangeText={setRecordedAudioDaemonBasePath}
              placeholder={t('devVoiceQa.recordedAudio.daemonBasePathPlaceholder')}
              testID="voiceQa.recordedAudio.daemonBasePathInput"
            />
            {Platform.OS === 'web' ? (
              <>
                <input
                  ref={recordedAudioFileInputRef}
                  data-testid="voiceQa.recordedAudio.fileInput"
                  type="file"
                  accept="audio/*"
                  style={{ display: 'none' }}
                  onChange={handleRecordedAudioFileChange}
                />
                <View style={styles.buttonRow}>
                  <RoundButton
                    testID="voiceQa.recordedAudio.pickFile"
                    title={t('devVoiceQa.recordedAudio.chooseFile')}
                    size="normal"
                    display="inverted"
                    onPress={openRecordedAudioFilePicker}
                  />
                </View>
              </>
            ) : null}
            <Text testID="voiceQa.recordedAudio.selectedFile" style={[styles.noteText, { color: theme.colors.text.secondary }]}>
              {recordedAudioSelectedFileName ?? t('devVoiceQa.recordedAudio.noFileSelected')}
            </Text>
            <View style={styles.buttonRow}>
              <RoundButton
                testID="voiceQa.recordedAudio.transcribe"
                title={t('devVoiceQa.recordedAudio.transcribe')}
                size="normal"
                loading={busyAction === 'recordedAudioTranscription'}
                onPress={() =>
                  void runAction('recordedAudioTranscription', async () => {
                    await runRecordedAudioTranscription();
                  })
                }
              />
            </View>
            <Text testID="voiceQa.recordedAudio.status" style={[styles.noteText, { color: theme.colors.text.secondary }]}>
              {t('devVoiceQa.recordedAudio.statusLabel')}: {recordedAudioQaStatus}
            </Text>
            <Text testID="voiceQa.recordedAudio.result" style={[styles.noteText, { color: theme.colors.text.primary }]}>
              {recordedAudioResult ?? t('devVoiceQa.recordedAudio.noResult')}
            </Text>
          </View>
        </ItemGroup>

        <ItemGroup title={t('devVoiceQa.transcriptTitle')}>
          <View style={styles.groupContent}>
            {qaState.entries.length === 0 ? (
              <Text style={[styles.emptyText, { color: theme.colors.text.secondary }]}>{t('devVoiceQa.transcriptEmpty')}</Text>
            ) : (
              qaState.entries.map((entry) => (
                <View
                  key={entry.id}
                  style={[
                    styles.logEntry,
                    {
                      backgroundColor: theme.colors.surface.inset,
                      borderColor: theme.colors.border.default,
                    },
                  ]}
                >
                  <Text style={[styles.entryKind, { color: theme.colors.text.secondary }]}>{entry.kind}</Text>
                  <Text style={[styles.entryText, { color: theme.colors.text.primary }]} selectable>
                    {entry.text}
                  </Text>
                </View>
              ))
            )}
          </View>
        </ItemGroup>

        <ItemGroup title={t('devVoiceQa.activityTitle')}>
          <View style={styles.groupContent}>
            {projectedConversationEntries.length === 0 ? (
              <Text style={[styles.emptyText, { color: theme.colors.text.secondary }]}>{t('devVoiceQa.activityEmpty')}</Text>
            ) : (
              projectedConversationEntries.map((entry) => (
                <Text key={entry.id} style={[styles.activityText, { color: theme.colors.text.primary }]} selectable>
                  {entry.text}
                </Text>
              ))
            )}
          </View>
        </ItemGroup>
      </ItemList>
    </ScrollView>
  );
}

const styles = StyleSheet.create(() => ({
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
  activityText: {
    fontSize: 14,
    lineHeight: 20,
  },
  qaEvidenceText: {
    display: 'none',
  },
}));

export default VoiceQaScreen;
