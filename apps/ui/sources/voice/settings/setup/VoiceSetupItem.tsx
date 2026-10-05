import * as React from 'react';
import { AppState, Linking, Platform, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { planetLightForProgress } from '@happier-dev/brand/planet';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import type { SetupBlockItem } from '@/components/ui/setupBlocks/SetupBlockGrid';
import { SetupBlockTile } from '@/components/ui/setupBlocks/SetupBlockTile';
import {
    useVoiceAttemptControl,
    VOICE_ATTEMPT_IDLE_TARGET_GLOBAL,
    type VoiceAttemptControlProjection,
} from '@/components/voice/attempt/useVoiceAttemptControl';
import { VoiceCompactTranscript } from '@/components/voice/presence/VoiceCompactTranscript';
import { VoiceMarkArt } from '@/components/voice/presence/VoiceMark';
import { VoiceStatusLine } from '@/components/voice/presence/VoiceStatusLine';
import { VoiceTransport } from '@/components/voice/presence/VoiceTransport';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useKeyboardShortcutLabel } from '@/keyboard/shortcutLabels';
import { useIsTablet } from '@/utils/platform/responsive';
import { normalizeSessionAddress } from '@/sync/domains/session/sessionAddress';
import { storage } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { checkMicrophonePermission, requestMicrophonePermission } from '@/utils/platform/microphonePermissions';
import { findVoiceConversationSessionId } from '@/voice/persistence/voiceConversationSystemSessionLookup';
import { useVoiceConversationsReadinessModel } from '@/voice/settings/panels/VoiceProviderSection';
import { resolveVoiceProviderReadinessPresentation, translateVoiceReadiness } from '@/voice/settings/panels/voiceProviderReadinessPresentation';
import { useVoiceConversationsReadinessInputs } from '@/voice/settings/useVoiceConversationsReadinessInputs';
import { useVoiceSettingsMutable } from '@/voice/settings/useVoiceSettingsMutable';
import { resolveVoiceSettingsRecoveryFocus } from '@/voice/settings/voiceSettingsRouteFocus';

import { useVoiceSetupItem, VOICE_SETUP_STEP_ID } from './useVoiceSetupItem';
import { VoiceSetupPanel, type VoiceSetupPanelActions, type VoiceSetupPanelModel } from './VoiceSetupPanel';
import type { VoiceSetupFacts } from './voiceSetupFacts';
import { isVoiceSetupFailed, readVoiceSetupLight, readVoiceSetupNextStep } from './voiceSetupPresentation';

type MicrophonePermission = 'granted' | 'denied' | 'unknown';

/**
 * "Set up voice" as a Get set up block (lab `voice-moments` SA–SV): one item, two hosts — Home's Get
 * set up and the top of Settings → Voice. Facts and dismissal are m-core's `useVoiceSetupItem`;
 * readiness is the Conversations readiness owner the service gallery uses, so the two cannot
 * disagree. The tile reads passively (no machine is asked because a page opened); the open panel
 * may refresh the selected service's machine facts. Null once Voice is set up (unless its panel is
 * open, so the person sees the done state) or when the person hid it.
 */
export function useVoiceSetupBlock(input: Readonly<{ layout: 'card' | 'row'; span?: SetupBlockItem['span'] }>): SetupBlockItem | null {
    const router = useRouter();
    const voiceEnabled = useFeatureEnabled('voice');
    const [panelOpen, setPanelOpen] = React.useState(false);
    const [voiceSettings, setVoiceSettings] = useVoiceSettingsMutable();
    const inputs = useVoiceConversationsReadinessInputs(voiceSettings, { probeMachine: panelOpen });
    const readinessModel = useVoiceConversationsReadinessModel({
        voice: voiceSettings,
        setVoice: setVoiceSettings,
        happierVoiceSupported: inputs.happierVoiceSupported,
        localAvailability: inputs.localAvailability,
        executionMachineId: inputs.executionMachine.machineId,
        executionMachineSelectedId: inputs.executionMachine.selectedMachineId,
        executionMachineSelectionKind: inputs.executionMachine.selectionKind,
    });
    const readiness = readinessModel.selectedProviderReadiness ?? null;
    const microphone = useObservedMicrophonePermission();
    const conversationSessionAddress = useVoiceHomeConversationAddress();
    const voice = useVoiceAttemptControl(VOICE_ATTEMPT_IDLE_TARGET_GLOBAL);
    const shortcutLabel = useKeyboardShortcutLabel('voice.toggle') ?? null;
    const phone = !useIsTablet();
    // m-core's owner: the facts and the dismissal. The block is built here from its facts.
    const setup = useVoiceSetupItem({
        providerId: voiceSettings.providerId ?? null,
        readiness,
        microphonePermission: microphone.permission,
        conversationSessionAddress,
    });
    const serviceTitle = readinessModel.serviceTiles.find((tile) => tile.selected)?.title ?? null;
    const readinessText = React.useMemo(() => {
        if (!readiness) return null;
        const presented = resolveVoiceProviderReadinessPresentation(readiness, translateVoiceReadiness, serviceTitle ?? undefined);
        return { reason: presented.reason, action: presented.action };
    }, [readiness, serviceTitle]);

    const recoveryAction = readiness?.recoveryAction ?? 'open_provider_settings';
    const { dismiss } = setup;
    const { allow } = microphone;
    // Try only ever starts: a conversation already running (anywhere) is never ended from setup.
    const { onToggle, live, canStart } = voice;
    const tryIt = React.useCallback(() => {
        if (!live && canStart) onToggle();
    }, [canStart, live, onToggle]);
    const actions = React.useMemo((): Omit<VoiceSetupPanelActions, 'onClose'> => ({
        onSelectService: readinessModel.selectService,
        onRecover: () => {
            const focus = resolveVoiceSettingsRecoveryFocus(recoveryAction) ?? 'provider';
            router.push({ pathname: SETTINGS_ROUTES.voiceConversations, params: { focus } } as never);
        },
        onAllowMicrophone: allow,
        onOpenSystemSettings: Platform.OS === 'web' ? null : () => { void Linking.openSettings().catch(() => {}); },
        onTry: tryIt,
        onDone: dismiss,
        onOpenSettings: () => router.push(SETTINGS_ROUTES.voice as never),
    }), [allow, dismiss, readinessModel.selectService, recoveryAction, router, tryIt]);

    const model = React.useMemo((): VoiceSetupPanelModel => ({
        facts: setup.facts,
        serviceTitle,
        serviceTiles: readinessModel.serviceTiles,
        readiness: readinessText,
        tryLive: voice.live,
        // The chord is shown where there is a keyboard to press it.
        shortcutLabel: phone ? null : shortcutLabel,
    }), [phone, readinessModel.serviceTiles, readinessText, serviceTitle, setup.facts, shortcutLabel, voice.live]);

    if (!voiceEnabled || setup.hidden || (setup.facts.complete && !panelOpen)) return null;
    return {
        id: VOICE_SETUP_STEP_ID,
        span: input.span,
        renderTile: ({ open }) => (
            <VoiceSetupTile
                layout={input.layout}
                facts={setup.facts}
                onOpen={() => {
                    setPanelOpen(true);
                    open();
                }}
                onDismiss={dismiss}
            />
        ),
        renderPanel: ({ close }) => (
            <VoiceSetupPanel
                testID="hub-setup.voice:setup"
                model={model}
                actions={{
                    ...actions,
                    onDone: () => {
                        actions.onDone();
                        setPanelOpen(false);
                        close();
                    },
                    onClose: () => {
                        setPanelOpen(false);
                        close();
                    },
                }}
                renderTry={<VoiceSetupTryReadout voice={voice} />}
            />
        ),
    };
}

/** The tile at rest: the planet at its current light, what is done, and what comes next. */
export const VoiceSetupTile = React.memo(function VoiceSetupTile(props: Readonly<{
    layout: 'card' | 'row';
    facts: VoiceSetupFacts;
    onOpen: () => void;
    onDismiss: () => void;
}>) {
    const { facts } = props;
    const started = facts.doneCount > 0;
    const lightProgress = readVoiceSetupLight(facts);
    const light = React.useMemo(() => planetLightForProgress(lightProgress), [lightProgress]);
    const next = readVoiceSetupNextStep(facts);
    const title = t('voiceMoments.setupTitle');
    return (
        <SetupBlockTile
            testID="hub-setup.voice"
            layout={props.layout}
            glyph={<VoiceMarkArt pose={isVoiceSetupFailed(facts) ? 'shade' : 'ready'} light={light} still size={24} />}
            title={title}
            subtitle={started
                ? t('voiceMoments.setupTileProgress', {
                    done: facts.doneCount,
                    total: facts.total,
                    next: next?.state === 'working' ? t('voiceMoments.setupNextInstalling') : nextLabel(next?.id ?? null),
                })
                : t('voiceMoments.setupTileSubtitle')}
            action={{
                label: started ? t('voiceMoments.setupContinue') : t('voiceMoments.setupStart'),
                testID: 'hub-setup.voice.action',
                onPress: props.onOpen,
            }}
            dismiss={{
                label: t('homeSetup.dismiss', { title }),
                tooltip: t('homeSetup.dismissTooltip'),
                onPress: props.onDismiss,
            }}
        />
    );
});

function nextLabel(next: VoiceSetupFacts['steps'][number]['id'] | null): string {
    switch (next) {
        case 'service': return t('voiceMoments.setupNextService');
        case 'readiness': return t('voiceMoments.setupNextReadiness');
        case 'microphone': return t('voiceMoments.setupNextMicrophone');
        default: return t('voiceMoments.setupNextTry');
    }
}

/** The first try, live: the shared status line, the last heard line and the transport (End stays one press away). */
const VoiceSetupTryReadout = React.memo(function VoiceSetupTryReadout(props: Readonly<{ voice: VoiceAttemptControlProjection }>) {
    return (
        <View style={styles.readout}>
            <View style={styles.readoutRow}>
                <VoiceStatusLine voice={props.voice} size="island" />
                <VoiceTransport voice={props.voice} size="island" />
            </View>
            <VoiceCompactTranscript voice={props.voice} />
        </View>
    );
});

/**
 * The microphone permission as the platform reports it, without prompting: read once when the block
 * mounts and again when the app comes back to the foreground (the person may have just allowed it in
 * system settings). `allow` is the only path that prompts, and only on a press.
 */
function useObservedMicrophonePermission(): Readonly<{ permission: MicrophonePermission; allow: () => void }> {
    const [permission, setPermission] = React.useState<MicrophonePermission>('unknown');
    const read = React.useCallback(() => {
        void checkMicrophonePermission().then((result) => {
            setPermission(result.granted ? 'granted' : result.canAskAgain === false ? 'denied' : 'unknown');
        });
    }, []);
    React.useEffect(() => {
        read();
        const subscription = AppState.addEventListener('change', (state) => {
            if (state === 'active') read();
        });
        return () => subscription.remove();
    }, [read]);
    const allow = React.useCallback(() => {
        void requestMicrophonePermission().then((result) => {
            setPermission(result.granted ? 'granted' : result.canAskAgain === false ? 'denied' : 'unknown');
        });
    }, []);
    return { permission, allow };
}

/** The Account's existing global Voice conversation, read passively (never created by a hub). */
function useVoiceHomeConversationAddress() {
    const serverId = useActiveServerSnapshot().serverId;
    const sessionId = storage((state) => findVoiceConversationSessionId(state));
    return React.useMemo(
        () => (sessionId ? normalizeSessionAddress(serverId, sessionId) : null),
        [serverId, sessionId],
    );
}

const styles = StyleSheet.create(() => ({
    readout: {
        alignSelf: 'stretch',
        gap: 4,
    },
    readoutRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
    },
}));
