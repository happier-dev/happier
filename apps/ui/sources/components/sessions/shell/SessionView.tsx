import { AgentContentView } from '@/components/sessions/transcript/AgentContentView';
import { AgentInput } from '@/components/sessions/agentInput';
import { getSuggestions } from '@/components/autocomplete/suggestions';
import { ChatHeaderView } from '@/components/sessions/transcript/ChatHeaderView';
import { ChatList } from '@/components/sessions/transcript/ChatList';
import { Deferred } from '@/components/ui/forms/Deferred';
import { EmptyMessages } from '@/components/ui/empty/EmptyMessages';
import { VoiceAssistantStatusBar } from '@/components/voice/shell/VoiceAssistantStatusBar';
import { useDraft } from '@/hooks/session/useDraft';
import { Modal } from '@/modal';
import { voiceHooks } from '@/realtime/hooks/voiceHooks';
import { startRealtimeSession, stopRealtimeSession } from '@/realtime/RealtimeSession';
import {
    commitLocalVoiceMediator,
    getLocalVoiceState,
    isLocalVoiceMediatorActive,
    toggleLocalVoiceTurn,
    useLocalVoiceStatus,
} from '@/voice/local/localVoiceEngine';
import { toggleLocalVoiceTurnWithTracking } from '@/voice/local/localVoiceTelemetry';
import { runVoiceMediatorCommitFlow } from '@/voice/mediator/commitFlow';
import { getVoiceMediatorExtraActionChips } from '@/voice/mediator/extraActionChips';
import { scmStatusSync } from '@/scm/scmStatusSync';
import { sessionAbort, resumeSession } from '@/sync/ops';
import { storage, useIsDataReady, useLocalSetting, useMachine, useRealtimeStatus, useSessionMessages, useSessionPendingMessages, useSessionUsage, useSetting, useSettings } from '@/sync/domains/state/storage';
import { canResumeSessionWithOptions, getAgentVendorResumeId } from '@/agents/runtime/resumeCapabilities';
import { DEFAULT_AGENT_ID, getAgentCore, resolveAgentIdFromFlavor, buildResumeSessionExtrasFromUiState, getAgentResumeExperimentsFromSettings, getResumePreflightIssues, getResumePreflightPrefetchPlan } from '@/agents/catalog/catalog';
import { useResumeCapabilityOptions } from '@/agents/hooks/useResumeCapabilityOptions';
import { useSession } from '@/sync/domains/state/storage';
import { Session } from '@/sync/domains/state/storageTypes';
import { sync } from '@/sync/sync';
import { applyPermissionModeSelection } from '@/sync/domains/permissions/permissionModeApply';
import { supportsAcpAgentModeOverrides } from '@/sync/acp/sessionModeControl';
import { t } from '@/text';
import { tracking, trackMessageSent } from '@/track';
import { isRunningOnMac } from '@/utils/platform/platform';
import { useDeviceType, useHeaderHeight, useIsLandscape, useIsTablet } from '@/utils/platform/responsive';
import { formatPathRelativeToHome, getSessionAvatarId, getSessionName, shouldShowAbortButtonForSessionState, useSessionStatus } from '@/utils/sessions/sessionUtils';
import { isVersionSupported, MINIMUM_CLI_VERSION } from '@/utils/system/versionUtils';
import { getMachineCapabilitiesSnapshot, prefetchMachineCapabilities, useMachineCapabilitiesCache } from '@/hooks/server/useMachineCapabilitiesCache';
import { describeAcpLoadSessionSupport } from '@/agents/runtime/acpRuntimeResume';
import type { ModelMode, PermissionMode } from '@/sync/domains/permissions/permissionTypes';
import { getPendingQueueWakeResumeOptions } from '@/sync/domains/pending/pendingQueueWake';
import { getPermissionModeOverrideForSpawn } from '@/sync/domains/permissions/permissionModeOverride';
import { getModelOverrideForSpawn } from '@/sync/domains/models/modelOverride';
import { nowServerMs } from '@/sync/runtime/time';
import { buildResumeSessionBaseOptionsFromSession } from '@/sync/domains/session/resume/resumeSessionBase';
import { chooseSubmitMode } from '@/sync/domains/session/control/submitMode';
import { isModelSelectableForSession } from '@/sync/domains/models/modelOptions';
import { isMachineOnline } from '@/utils/sessions/machineUtils';
import { getInactiveSessionUiState } from '@/components/sessions/model/inactiveSessionUi';
import { resolveSessionMachineReachability } from '@/components/sessions/model/resolveSessionMachineReachability';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { useRouter } from 'expo-router';
import * as React from 'react';
import { useMemo } from 'react';
import { ActivityIndicator, Platform, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useUnistyles } from 'react-native-unistyles';
import { sessionSwitch } from '@/sync/ops';
import { shouldRenderChatTimelineForSession, shouldRequestRemoteControlAfterPendingEnqueue } from '@/sync/domains/session/control/localControlSwitch';

function formatResumeSupportDetailCode(code: 'cliNotDetected' | 'capabilityProbeFailed' | 'acpProbeFailed' | 'loadSessionFalse'): string {
    switch (code) {
        case 'cliNotDetected':
            return t('session.resumeSupportDetails.cliNotDetected');
        case 'capabilityProbeFailed':
            return t('session.resumeSupportDetails.capabilityProbeFailed');
        case 'acpProbeFailed':
            return t('session.resumeSupportDetails.acpProbeFailed');
        case 'loadSessionFalse':
            return t('session.resumeSupportDetails.loadSessionFalse');
    }
}

export const SessionView = React.memo((props: { id: string }) => {
    const sessionId = props.id;
    const router = useRouter();
    const session = useSession(sessionId);
    const isDataReady = useIsDataReady();
    const { theme } = useUnistyles();
    const safeArea = useSafeAreaInsets();
    const isLandscape = useIsLandscape();
    const deviceType = useDeviceType();
    const headerHeight = useHeaderHeight();
    const realtimeStatus = useRealtimeStatus();
    const isTablet = useIsTablet();

    // Compute header props based on session state
    const headerProps = useMemo(() => {
        if (!isDataReady) {
            // Loading state - show empty header
            return {
                title: '',
                subtitle: undefined,
                avatarId: undefined,
                onAvatarPress: undefined,
                isConnected: false,
                flavor: null
            };
        }

        if (!session) {
            // Deleted state - show deleted message in header
            return {
                title: t('errors.sessionDeleted'),
                subtitle: undefined,
                avatarId: undefined,
                onAvatarPress: undefined,
                isConnected: false,
                flavor: null
            };
        }

        // Normal state - show session info
        const isConnected = session.presence === 'online';
        return {
            title: getSessionName(session),
            subtitle: session.metadata?.path ? formatPathRelativeToHome(session.metadata.path, session.metadata?.homeDir) : undefined,
            avatarId: getSessionAvatarId(session),
            onAvatarPress: () => router.push(`/session/${sessionId}/info`),
            isConnected: isConnected,
            flavor: session.metadata?.flavor || null,
            tintColor: isConnected ? '#000' : '#8E8E93'
        };
    }, [session, isDataReady, sessionId, router]);

    return (
        <>
            {/* Status bar shadow for landscape mode */}
            {isLandscape && deviceType === 'phone' && (
                <View style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    right: 0,
                    height: safeArea.top,
                    backgroundColor: theme.colors.surface,
                    zIndex: 1000,
                    shadowColor: theme.colors.shadow.color,
                    shadowOffset: {
                        width: 0,
                        height: 2,
                    },
                    shadowOpacity: theme.colors.shadow.opacity,
                    shadowRadius: 3,
                    elevation: 5,
                }} />
            )}

            {/* Header - always shown on desktop/Mac, hidden in landscape mode only on actual phones */}
            {!(isLandscape && deviceType === 'phone' && Platform.OS !== 'web') && (
                <View style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    right: 0,
                    zIndex: 1000
                }}>
                    <ChatHeaderView
                        {...headerProps}
                        onBackPress={() => router.back()}
                    />
                    {/* Voice status bar below header - not on tablet (shown in sidebar) */}
                    {!isTablet && realtimeStatus !== 'disconnected' && (
                        <VoiceAssistantStatusBar variant="full" />
                    )}
                </View>
            )}

            {/* Content based on state */}
            <View style={{ flex: 1, paddingTop: !(isLandscape && deviceType === 'phone' && Platform.OS !== 'web') ? safeArea.top + headerHeight + (!isTablet && realtimeStatus !== 'disconnected' ? 48 : 0) : 0 }}>
                {!isDataReady ? (
                    // Loading state
                    <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
                        <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                    </View>
                ) : !session ? (
                    // Deleted state
                    <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
                        <Ionicons name="trash-outline" size={48} color={theme.colors.textSecondary} />
                        <Text style={{ color: theme.colors.text, fontSize: 20, marginTop: 16, fontWeight: '600' }}>{t('errors.sessionDeleted')}</Text>
                        <Text style={{ color: theme.colors.textSecondary, fontSize: 15, marginTop: 8, textAlign: 'center', paddingHorizontal: 32 }}>{t('errors.sessionDeletedDescription')}</Text>
                    </View>
                ) : (
                    // Normal session view
                    <SessionViewLoaded key={sessionId} sessionId={sessionId} session={session} />
                )}
            </View>
        </>
    );
});


function SessionViewLoaded({ sessionId, session }: { sessionId: string, session: Session }) {
    const { theme } = useUnistyles();
    const router = useRouter();
    const safeArea = useSafeAreaInsets();
    const isLandscape = useIsLandscape();
    const deviceType = useDeviceType();
    const [message, setMessage] = React.useState('');
    const realtimeStatus = useRealtimeStatus();
    const { messages, isLoaded } = useSessionMessages(sessionId);
    const acknowledgedCliVersions = useLocalSetting('acknowledgedCliVersions');

    // Check if CLI version is outdated and not already acknowledged
    const cliVersion = session.metadata?.version;
    const machineId = session.metadata?.machineId;
    const isCliOutdated = cliVersion && !isVersionSupported(cliVersion, MINIMUM_CLI_VERSION);
    const isAcknowledged = machineId && acknowledgedCliVersions[machineId] === cliVersion;
    const shouldShowCliWarning = isCliOutdated && !isAcknowledged;
    // Get permission mode from session object, default to 'default'
    const permissionMode = session.permissionMode || 'default';
    // Get model mode from session object - default is agent-specific (Gemini needs an explicit default)
    const agentId = resolveAgentIdFromFlavor(session.metadata?.flavor) ?? DEFAULT_AGENT_ID;
    const modelMode = session.modelMode || getAgentCore(agentId).model.defaultMode;
    const sessionStatus = useSessionStatus(session);
    const sessionUsage = useSessionUsage(sessionId);
    const alwaysShowContextSize = useSetting('alwaysShowContextSize');
    const voiceProviderId = useSetting('voiceProviderId');
    const localVoiceStatus = useLocalVoiceStatus();
    const { messages: pendingMessages } = useSessionPendingMessages(sessionId);
    const settings = useSettings();

    const handleVoiceMediatorCommit = React.useCallback(async () => {
        await runVoiceMediatorCommitFlow({
            isActive: () => isLocalVoiceMediatorActive(sessionId),
            commit: async () => commitLocalVoiceMediator(sessionId),
            confirmSend: async (previewText) =>
                Modal.confirm(
                    t('voiceMediator.commitTitle'),
                    previewText,
                    { cancelText: t('voiceMediator.commitEdit'), confirmText: t('voiceMediator.commitSend') },
                ),
            applyToComposer: (text) => setMessage(text),
            sendToSession: async (text) => {
                await sync.submitMessage(sessionId, text);
            },
            alert: async (_title, message) => Modal.alert(t('common.error'), message),
            notActiveTitle: t('common.error'),
            notActiveMessage: t('errors.voiceMediatorNotActive'),
        });
    }, [sessionId]);

    const voiceExtraActionChips = React.useMemo(() => getVoiceMediatorExtraActionChips({
        voiceProviderId,
        voiceLocalConversationMode: settings.voiceLocalConversationMode,
        onCommitPress: handleVoiceMediatorCommit,
        label: t('voiceMediator.commitChip'),
        accessibilityLabel: t('voiceMediator.commitTitle'),
    }), [handleVoiceMediatorCommit, settings.voiceLocalConversationMode, voiceProviderId]);

    // Inactive session resume state
    const isSessionActive = session.presence === 'online';
    const supportsLocalControl = getAgentCore(agentId).localControl?.supported === true;
    const { resumeCapabilityOptions } = useResumeCapabilityOptions({
        agentId,
        machineId: typeof machineId === 'string' ? machineId : null,
        settings,
        enabled: !isSessionActive || supportsLocalControl,
    });

    const { state: machineCapabilitiesState } = useMachineCapabilitiesCache({
        machineId: typeof machineId === 'string' ? machineId : null,
        enabled: false,
        request: { requests: [] },
    });
    const machineCapabilitiesResults = React.useMemo(() => {
        if (machineCapabilitiesState.status !== 'loaded' && machineCapabilitiesState.status !== 'loading') return undefined;
        return machineCapabilitiesState.snapshot?.response.results as any;
    }, [machineCapabilitiesState]);

    const vendorResumeId = React.useMemo(() => {
        const field = getAgentCore(agentId).resume.vendorResumeIdField;
        if (!field) return '';
        const raw = (session.metadata as any)?.[field];
        return typeof raw === 'string' ? raw.trim() : '';
    }, [agentId, session.metadata]);

    const acpLoadSessionSupport = React.useMemo(() => {
        if (!vendorResumeId) return null;
        if (getAgentCore(agentId).resume.runtimeGate !== 'acpLoadSession') return null;
        return describeAcpLoadSessionSupport(agentId, machineCapabilitiesResults);
    }, [agentId, machineCapabilitiesResults, vendorResumeId]);

    const isResumable = canResumeSessionWithOptions(session.metadata, resumeCapabilityOptions);
    const [isResuming, setIsResuming] = React.useState(false);

    const machine = useMachine(typeof machineId === 'string' ? machineId : '');
    const isMachineReachable = resolveSessionMachineReachability({
        machineIsKnown: Boolean(machine),
        machineIsOnline: machine ? isMachineOnline(machine) : false,
    });

    const inactiveUi = React.useMemo(() => {
        return getInactiveSessionUiState({
            isSessionActive,
            isResumable,
            isMachineOnline: isMachineReachable,
        });
    }, [isMachineReachable, isResumable, isSessionActive]);

    // Use draft hook for auto-saving message drafts
    const { clearDraft } = useDraft(sessionId, message, setMessage);

    const isFocusedRef = React.useRef(false);
    const markViewedTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    // Unread is driven by committed transcript `session.seq` only (pending queue does not affect unread).
    const lastMarkedRef = React.useRef<{ sessionSeq: number } | null>(null);

    const markSessionViewed = React.useCallback(() => {
        void sync.markSessionViewed(sessionId).catch(() => { });
    }, [sessionId]);

    useFocusEffect(React.useCallback(() => {
        isFocusedRef.current = true;
        {
            const current = storage.getState().sessions[sessionId];
            lastMarkedRef.current = {
                sessionSeq: current?.seq ?? 0,
            };
        }
        markSessionViewed();
        return () => {
            isFocusedRef.current = false;
            if (markViewedTimeoutRef.current) {
                clearTimeout(markViewedTimeoutRef.current);
                markViewedTimeoutRef.current = null;
            }
            markSessionViewed();
        };
    }, [markSessionViewed, sessionId]));

    React.useEffect(() => {
        if (!isFocusedRef.current) return;

        const sessionSeq = session.seq ?? 0;
        const last = lastMarkedRef.current;
        if (last && last.sessionSeq >= sessionSeq) return;

        lastMarkedRef.current = { sessionSeq };
        if (markViewedTimeoutRef.current) clearTimeout(markViewedTimeoutRef.current);
        markViewedTimeoutRef.current = setTimeout(() => {
            markViewedTimeoutRef.current = null;
            markSessionViewed();
        }, 250);
        return () => {
            if (markViewedTimeoutRef.current) {
                clearTimeout(markViewedTimeoutRef.current);
                markViewedTimeoutRef.current = null;
            }
        };
    }, [markSessionViewed, session.seq]);

    React.useEffect(() => {
        void sync.fetchPendingMessages(sessionId).catch(() => { });
    }, [sessionId, session.pendingVersion]);

    // Handle dismissing CLI version warning
    const handleDismissCliWarning = React.useCallback(() => {
        if (machineId && cliVersion) {
            storage.getState().applyLocalSettings({
                acknowledgedCliVersions: {
                    ...acknowledgedCliVersions,
                    [machineId]: cliVersion
                }
            });
        }
    }, [machineId, cliVersion, acknowledgedCliVersions]);

    // Function to update permission mode
    const updatePermissionMode = React.useCallback((mode: PermissionMode) => {
        void applyPermissionModeSelection({
            sessionId,
            mode,
            applyTiming: settings.sessionPermissionModeApplyTiming === 'next_prompt' ? 'next_prompt' : 'immediate',
            updateSessionPermissionMode: (sid, nextMode) => storage.getState().updateSessionPermissionMode(sid, nextMode),
            getSessionPermissionModeUpdatedAt: (sid) => storage.getState().sessions[sid]?.permissionModeUpdatedAt ?? null,
            publishSessionPermissionModeToMetadata: (payload) => sync.publishSessionPermissionModeToMetadata(payload),
        }).catch(() => { });
    }, [sessionId, settings.sessionPermissionModeApplyTiming]);

    const updateAcpSessionModeOverride = React.useCallback((modeId: string) => {
        void sync.publishSessionAcpSessionModeOverrideToMetadata({
            sessionId,
            modeId,
            updatedAt: nowServerMs(),
        }).catch(() => { });
    }, [sessionId]);

    const updateAcpConfigOptionOverride = React.useCallback((configId: string, valueId: string) => {
        void sync.publishSessionAcpConfigOptionOverrideToMetadata({
            sessionId,
            configId,
            value: valueId,
            updatedAt: nowServerMs(),
        }).catch(() => { });
    }, [sessionId]);

    // Function to update model mode (only for agents that expose model selection in the UI)
    const updateModelMode = React.useCallback((mode: ModelMode) => {
        if (!isModelSelectableForSession(agentId, session.metadata ?? null, mode)) return;
        storage.getState().updateSessionModelMode(sessionId, mode);
        void sync.publishSessionModelOverrideToMetadata({
            sessionId,
            modelId: mode,
            updatedAt: nowServerMs(),
        }).catch(() => { });
    }, [agentId, sessionId, session.metadata]);

    // Handle resuming an inactive session
    const handleResumeSession = React.useCallback(async (): Promise<boolean> => {
        if (!session.metadata?.machineId || !session.metadata?.path || !session.metadata?.flavor) {
            Modal.alert(t('common.error'), t('session.resumeFailed'));
            return false;
        }
        if (!canResumeSessionWithOptions(session.metadata, resumeCapabilityOptions)) {
            if (acpLoadSessionSupport?.kind === 'error' || acpLoadSessionSupport?.kind === 'unknown') {
                const detailLines: string[] = [];
                if (acpLoadSessionSupport?.code) {
                    detailLines.push(formatResumeSupportDetailCode(acpLoadSessionSupport.code));
                }
                if (acpLoadSessionSupport?.rawMessage) {
                    detailLines.push(acpLoadSessionSupport.rawMessage);
                }
                const detail = detailLines.length > 0 ? `\n\n${t('common.details')}: ${detailLines.join('\n')}` : '';
                Modal.alert(t('common.error'), `${t('session.resumeFailed')}${detail}`);
            } else {
                Modal.alert(t('common.error'), t('session.resumeFailed'));
            }
            return false;
        }
        if (!isMachineReachable) {
            Modal.alert(t('common.error'), t('session.machineOfflineCannotResume'));
            return false;
        }

        const sessionEncryptionKeyBase64 = sync.getSessionEncryptionKeyBase64ForResume(sessionId);
        if (!sessionEncryptionKeyBase64) {
            Modal.alert(t('common.error'), t('session.resumeFailed'));
            return false;
        }

        setIsResuming(true);
        try {
            const permissionOverride = getPermissionModeOverrideForSpawn(session);
            const modelOverride = getModelOverrideForSpawn(session);
            const base = buildResumeSessionBaseOptionsFromSession({
                sessionId,
                session,
                resumeCapabilityOptions,
                permissionOverride,
                modelOverride,
            });
            if (!base) {
                Modal.alert(t('common.error'), t('session.resumeFailed'));
                return false;
            }

            const snapshotBefore = getMachineCapabilitiesSnapshot(base.machineId);
            const resultsBefore = snapshotBefore?.response.results as any;
            const preflightPlan = getResumePreflightPrefetchPlan({ agentId, settings, results: resultsBefore });
            if (preflightPlan) {
                try {
                    await prefetchMachineCapabilities({
                        machineId: base.machineId,
                        request: preflightPlan.request,
                        timeoutMs: preflightPlan.timeoutMs,
                    });
                } catch {
                    // Non-blocking; fall back to attempting resume (pending queue preserves user message).
                }
            }

            const snapshot = getMachineCapabilitiesSnapshot(base.machineId);
            const results = snapshot?.response.results as any;
            const issues = getResumePreflightIssues({
                agentId,
                experiments: getAgentResumeExperimentsFromSettings(agentId, settings),
                results,
            });

            const blockingIssue = issues[0] ?? null;
            if (blockingIssue) {
                const openMachine = await Modal.confirm(
                    t(blockingIssue.titleKey),
                    t(blockingIssue.messageKey),
                    { confirmText: t(blockingIssue.confirmTextKey) }
                );
                if (openMachine && blockingIssue.action === 'openMachine') {
                    router.push(`/machine/${base.machineId}` as any);
                }
                return false;
            }

            const result = await resumeSession({
                ...base,
                sessionEncryptionKeyBase64,
                sessionEncryptionVariant: 'dataKey',
                ...buildResumeSessionExtrasFromUiState({
                    agentId,
                    settings,
                }),
            });

            if (result.type === 'error') {
                Modal.alert(t('common.error'), result.errorMessage);
                return false;
            }
            // On success, the session will become active and UI will update automatically
            return true;
        } catch (error) {
            Modal.alert(t('common.error'), t('session.resumeFailed'));
            return false;
        } finally {
            setIsResuming(false);
        }
    }, [agentId, resumeCapabilityOptions, router, session, sessionId, settings]);

    // Memoize header-dependent styles to prevent re-renders
    const headerDependentStyles = React.useMemo(() => ({
        contentContainer: {
            flex: 1
        },
        flatListStyle: {
            marginTop: 0 // No marginTop needed since header is handled by parent
        },
    }), []);


    // Handle microphone button press - memoized to prevent button flashing
    const handleMicrophonePress = React.useCallback(async () => {
        if (voiceProviderId === 'off') {
            return;
        }
        if (voiceProviderId === 'local_openai_stt_tts') {
            try {
                await toggleLocalVoiceTurnWithTracking({
                    sessionId,
                    toggleLocalVoiceTurn,
                    getStatus: () => getLocalVoiceState().status,
                    tracking,
                });
            } catch (error) {
                Modal.alert(t('common.error'), t('errors.voiceSessionFailed'));
                tracking?.capture('voice_local_turn_error', {
                    sessionId,
                    error: error instanceof Error ? error.message : 'Unknown error',
                });
            }
            return;
        }
        if (realtimeStatus === 'connecting') {
            return; // Prevent actions during transitions
        }
        if (realtimeStatus === 'disconnected' || realtimeStatus === 'error') {
            try {
                const initialPrompt = voiceHooks.onVoiceStarted(sessionId);
                await startRealtimeSession(sessionId, initialPrompt);
                tracking?.capture('voice_session_started', { sessionId });
            } catch (error) {
                Modal.alert(t('common.error'), t('errors.voiceSessionFailed'));
                tracking?.capture('voice_session_error', {
                    sessionId,
                    error: error instanceof Error ? error.message : 'Unknown error',
                });
            }
        } else if (realtimeStatus === 'connected') {
            await stopRealtimeSession();
            tracking?.capture('voice_session_stopped');

            // Notify voice assistant about voice session stop
            voiceHooks.onVoiceStopped();
        }
    }, [localVoiceStatus, realtimeStatus, sessionId, voiceProviderId]);

    // Memoize mic button state to prevent flashing during chat transitions
    const micButtonState = useMemo(
        () => ({
            onMicPress: voiceProviderId === 'off' ? undefined : handleMicrophonePress,
            isMicActive:
                voiceProviderId === 'local_openai_stt_tts'
                    ? localVoiceStatus !== 'idle'
                    : voiceProviderId !== 'off' && (realtimeStatus === 'connected' || realtimeStatus === 'connecting'),
        }),
        [handleMicrophonePress, localVoiceStatus, realtimeStatus, voiceProviderId],
    );

    // Trigger session visibility and initialize git status sync
    React.useLayoutEffect(() => {

        // Trigger session sync
        sync.onSessionVisible(sessionId);


        // Initialize git status sync for this session
        scmStatusSync.getSync(sessionId);
    }, [sessionId, realtimeStatus]);

    const showInactiveNotResumableNotice = inactiveUi.noticeKind === 'not-resumable';
    const showMachineOfflineNotice = inactiveUi.noticeKind === 'machine-offline';
    const providerName = getAgentCore(agentId).connectedService?.name ?? t('status.unknown');
    const machineName = machine?.metadata?.displayName ?? machine?.metadata?.host ?? t('status.unknown');

    const bottomNotice = React.useMemo(() => {
        if (showInactiveNotResumableNotice) {
            const extra = (() => {
                if (!acpLoadSessionSupport) return '';
                if (acpLoadSessionSupport.kind === 'supported') return '';
                const note = acpLoadSessionSupport.kind === 'unknown'
                    ? `\n\n${t('session.resumeSupportNoteChecking')}`
                    : `\n\n${t('session.resumeSupportNoteUnverified')}`;

                const detailLines: string[] = [];
                if (acpLoadSessionSupport.code) {
                    detailLines.push(formatResumeSupportDetailCode(acpLoadSessionSupport.code));
                }
                if (acpLoadSessionSupport.rawMessage) {
                    detailLines.push(acpLoadSessionSupport.rawMessage);
                }
                const detail = detailLines.length > 0 ? `\n\n${t('common.details')}: ${detailLines.join('\n')}` : '';
                return `${note}${detail}`;
            })();
            return {
                title: t('session.inactiveNotResumableNoticeTitle'),
                body: `${t('session.inactiveNotResumableNoticeBody', { provider: providerName })}${extra}`,
            };
        }
        if (showMachineOfflineNotice) {
            return {
                title: t('session.machineOfflineNoticeTitle'),
                body: t('session.machineOfflineNoticeBody', { machine: machineName }),
            };
        }
        return null;
    }, [acpLoadSessionSupport, machineName, providerName, showInactiveNotResumableNotice, showMachineOfflineNotice]);

    const hasWriteAccess = !session.accessLevel || session.accessLevel === 'edit' || session.accessLevel === 'admin';
    const isReadOnly = session.accessLevel === 'view';

    const handleRequestSwitchToRemote = React.useCallback(() => {
        if (!hasWriteAccess) {
            Modal.alert(t('common.error'), t('session.sharing.noEditPermission'));
            return;
        }
        void (async () => {
            try {
                const ok = await sessionSwitch(sessionId, 'remote');
                if (ok !== true) {
                    Modal.alert(t('common.error'), t('errors.failedToSwitchControl'));
                }
            } catch {
                Modal.alert(t('common.error'), t('errors.failedToSwitchControl'));
            }
        })();
    }, [hasWriteAccess, sessionId]);

    const shouldRenderChatTimeline = React.useMemo(() => shouldRenderChatTimelineForSession({
        committedMessagesCount: messages.length,
        pendingMessagesCount: pendingMessages.length,
        controlledByUser: Boolean(session.agentState?.controlledByUser),
    }), [messages.length, pendingMessages.length, session.agentState?.controlledByUser]);

    let content = (
        <>
            <Deferred>
                {shouldRenderChatTimeline && (
                    <ChatList
                        session={session}
                        bottomNotice={bottomNotice}
                        onRequestSwitchToRemote={handleRequestSwitchToRemote}
                    />
                )}
            </Deferred>
        </>
    );
    const placeholder = !shouldRenderChatTimeline ? (
        <>
            {isLoaded ? (
                <EmptyMessages session={session} />
            ) : (
                <ActivityIndicator size="small" color={theme.colors.textSecondary} />
            )}
        </>
    ) : null;

    // Determine the status text to show for inactive sessions
    const inactiveStatusText = inactiveUi.inactiveStatusTextKey ? t(inactiveUi.inactiveStatusTextKey) : null;

    const shouldShowInput = inactiveUi.shouldShowInput;

    const input = shouldShowInput ? (
        <View>
            <AgentInput
                placeholder={isReadOnly ? t('session.sharing.viewOnlyMode') : t('session.inputPlaceholder')}
                value={message}
                onChangeText={setMessage}
                sessionId={sessionId}
                permissionMode={permissionMode}
                onPermissionModeChange={updatePermissionMode}
                onAcpSessionModeChange={supportsAcpAgentModeOverrides(agentId) ? updateAcpSessionModeOverride : undefined}
                onAcpConfigOptionChange={updateAcpConfigOptionOverride}
                modelMode={modelMode}
                onModelModeChange={updateModelMode}
                metadata={session.metadata}
                    profileId={session.metadata?.profileId ?? undefined}
                    onProfileClick={session.metadata?.profileId !== undefined ? () => {
                        const profileId = session.metadata?.profileId;
                        const profileInfo = (profileId === null || (typeof profileId === 'string' && profileId.trim() === ''))
                            ? t('profiles.noProfile')
                            : (typeof profileId === 'string' ? profileId : t('status.unknown'));
                        Modal.alert(
                            t('profiles.title'),
                            `${t('profiles.sessionUses', { profile: profileInfo })}\n\n${t('profiles.profilesFixedPerSession')}`,
                        );
                    } : undefined}
                connectionStatus={{
                    text: isResuming ? t('session.resuming') : (inactiveStatusText || sessionStatus.statusText),
                    color: sessionStatus.statusColor,
                    dotColor: sessionStatus.statusDotColor,
                    isPulsing: isResuming || sessionStatus.isPulsing
                }}
                onSend={() => {
                    if (!hasWriteAccess) {
                        Modal.alert(t('common.error'), t('session.sharing.noEditPermission'));
                        return;
                    }
                    const text = message.trim();
                    if (!text) return;
                    setMessage('');
                    clearDraft();
                    trackMessageSent();

                    const configuredMode = storage.getState().settings.sessionMessageSendMode;
                    const busySteerSendPolicy = storage.getState().settings.sessionBusySteerSendPolicy;
                    const submitMode = chooseSubmitMode({ configuredMode, busySteerSendPolicy, session });

                    if (submitMode === 'server_pending') {
                        void (async () => {
                            try {
                                await sync.enqueuePendingMessage(sessionId, text);
                            } catch (e) {
                                setMessage(text);
                                Modal.alert(t('common.error'), e instanceof Error ? e.message : t('errors.failedToSendMessage'));
                                return;
                            }

                            const wakeOpts = getPendingQueueWakeResumeOptions({
                                sessionId,
                                session,
                                resumeCapabilityOptions,
                                permissionOverride: getPermissionModeOverrideForSpawn(session),
                                // Only attempt machine RPC wakeups when we can encrypt them.
                                // Collaborators won't have machine encryption, but can still enqueue pending messages.
                                canWakeMachineId: (machineId) => Boolean(sync.encryption.getMachineEncryption(machineId)),
                            });
                            if (!wakeOpts) return;

                            try {
                                const sessionEncryptionKeyBase64 = sync.getSessionEncryptionKeyBase64ForResume(sessionId);
                                if (!sessionEncryptionKeyBase64) {
                                    Modal.alert(t('common.error'), t('session.resumeFailed'));
                                    return;
                                }

                                const result = await resumeSession({
                                    ...wakeOpts,
                                    sessionEncryptionKeyBase64,
                                    sessionEncryptionVariant: 'dataKey',
                                });
                                if (result.type === 'error') {
                                    Modal.alert(t('common.error'), result.errorMessage);
                                }
                            } catch {
                                Modal.alert(t('common.error'), t('session.resumeFailed'));
                            }

                            if (shouldRequestRemoteControlAfterPendingEnqueue(session)) {
                                try {
                                    await sessionSwitch(sessionId, 'remote');
                                } catch {
                                    // Non-fatal: the message is already persisted in the pending queue.
                                }
                            }
                        })();
                        return;
                    }

                    // If session is inactive but resumable, resume it and send the message through the agent.
                    if (!isSessionActive && isResumable) {
                        void (async () => {
                            try {
                                // Prefer server-side pending queue when supported so the message is preserved
                                // even if spawning/resume fails.
                                const supportsPendingQueueV2 = typeof session.pendingVersion === 'number';
                                if (supportsPendingQueueV2) {
                                    await sync.enqueuePendingMessage(sessionId, text);
                                    await handleResumeSession();
                                    return;
                                }

                                // Fallback for older servers: resume first, then submit directly.
                                const resumed = await handleResumeSession();
                                if (!resumed) {
                                    setMessage(text);
                                    return;
                                }
                                await sync.submitMessage(sessionId, text);
                            } catch (e) {
                                setMessage(text);
                                Modal.alert(t('common.error'), e instanceof Error ? e.message : t('errors.failedToResumeSession'));
                            }
                        })();
                        return;
                    }

                    void (async () => {
                        try {
                            await sync.submitMessage(sessionId, text);
                        } catch (e) {
                            setMessage(text);
                            Modal.alert(t('common.error'), e instanceof Error ? e.message : t('errors.failedToSendMessage'));
                        }
                    })();
                }}
                isSendDisabled={!shouldShowInput || isResuming || isReadOnly}
                onMicPress={micButtonState.onMicPress}
                isMicActive={micButtonState.isMicActive}
                extraActionChips={voiceExtraActionChips}
                onAbort={() => sessionAbort(sessionId)}
                showAbortButton={shouldShowAbortButtonForSessionState(sessionStatus.state)}
                onFileViewerPress={() => router.push(`/session/${sessionId}/files`)}
                // Autocomplete configuration
                autocompletePrefixes={['@', '/']}
                autocompleteSuggestions={(query) => getSuggestions(sessionId, query)}
                disabled={isReadOnly}
                usageData={sessionUsage ? {
                    inputTokens: sessionUsage.inputTokens,
                    outputTokens: sessionUsage.outputTokens,
                    cacheCreation: sessionUsage.cacheCreation,
                    cacheRead: sessionUsage.cacheRead,
                    contextSize: sessionUsage.contextSize
                } : session.latestUsage ? {
                    inputTokens: session.latestUsage.inputTokens,
                    outputTokens: session.latestUsage.outputTokens,
                    cacheCreation: session.latestUsage.cacheCreation,
                    cacheRead: session.latestUsage.cacheRead,
                    contextSize: session.latestUsage.contextSize
                } : undefined}
                alwaysShowContextSize={alwaysShowContextSize}
            />
        </View>
    ) : null;


    return (
        <>
            {/* CLI Version Warning Overlay - Subtle centered pill */}
            {shouldShowCliWarning && !(isLandscape && deviceType === 'phone') && (
                <Pressable
                    onPress={handleDismissCliWarning}
                    style={{
                        position: 'absolute',
                        top: 8, // Position at top of content area (padding handled by parent)
                        alignSelf: 'center',
                        backgroundColor: '#FFF3CD',
                        borderRadius: 100, // Fully rounded pill
                        paddingHorizontal: 14,
                        paddingVertical: 7,
                        flexDirection: 'row',
                        alignItems: 'center',
                        zIndex: 998, // Below voice bar but above content
                        shadowColor: '#000',
                        shadowOffset: { width: 0, height: 2 },
                        shadowOpacity: 0.15,
                        shadowRadius: 4,
                        elevation: 4,
                    }}
                >
                    <Ionicons name="warning-outline" size={14} color="#FF9500" style={{ marginRight: 6 }} />
                    <Text style={{
                        fontSize: 12,
                        color: '#856404',
                        fontWeight: '600'
                    }}>
                        {t('sessionInfo.cliVersionOutdated')}
                    </Text>
                    <Ionicons name="close" size={14} color="#856404" style={{ marginLeft: 8 }} />
                </Pressable>
            )}

            {/* Main content area - no padding since header is overlay */}
            <View style={{ flexBasis: 0, flexGrow: 1, paddingBottom: safeArea.bottom + ((isRunningOnMac() || Platform.OS === 'web') ? 32 : 0) }}>
                <AgentContentView
                    content={content}
                    input={input}
                    placeholder={placeholder}
                />
            </View >

            {/* Back button for landscape phone mode when header is hidden */}
            {
                isLandscape && deviceType === 'phone' && (
                    <Pressable
                        onPress={() => router.back()}
                        style={{
                            position: 'absolute',
                            top: safeArea.top + 8,
                            left: 16,
                            width: 44,
                            height: 44,
                            borderRadius: 22,
                            backgroundColor: `rgba(${theme.dark ? '28, 23, 28' : '255, 255, 255'}, 0.9)`,
                            alignItems: 'center',
                            justifyContent: 'center',
                            ...Platform.select({
                                ios: {
                                    shadowColor: '#000',
                                    shadowOffset: { width: 0, height: 2 },
                                    shadowOpacity: 0.1,
                                    shadowRadius: 4,
                                },
                                android: {
                                    elevation: 2,
                                }
                            }),
                        }}
                        hitSlop={15}
                    >
                        <Ionicons
                            name={Platform.OS === 'ios' ? 'chevron-back' : 'arrow-back'}
                            size={Platform.select({ ios: 28, default: 24 })}
                            color="#000"
                        />
                    </Pressable>
                )
            }
        </>
    )
}
