import * as React from 'react';
import { AppState, Platform, View } from 'react-native';
import { VoiceConversationActionOutputSchemas, VoiceSetupMicrophonePermissionActionResultSchema } from '@happier-dev/protocol/actions/voiceConversationActionFamily';
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
import { registerVoiceSetupPresentation } from '@/components/voice/presence/voiceCompanionSectionReveal';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useKeyboardShortcutLabel } from '@/keyboard/shortcutLabels';
import { useIsTablet } from '@/utils/platform/responsive';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { t } from '@/text';
import {
    checkMicrophonePermission,
    readMicrophonePermissionState,
    type MicrophonePermissionState,
} from '@/utils/platform/microphonePermissions';
import { useVoiceHomeConversationAddress } from '@/voice/persistence/useVoiceHomeConversationAddress';
import { useVoiceConversationsReadinessModel } from '@/voice/settings/panels/VoiceProviderSection';
import { resolveVoiceProviderReadinessPresentation, translateVoiceReadiness } from '@/voice/settings/panels/voiceProviderReadinessPresentation';
import { useVoiceSettingsReadinessInputs } from '@/voice/settings/useVoiceSettingsReadinessInputs';
import { useVoiceSettingsMutable } from '@/voice/settings/useVoiceSettingsMutable';
import { resolveVoiceSettingsRecoveryTarget } from '@/voice/settings/voiceSettingsRouteFocus';
import { recoverVoiceSettingsReadiness } from '@/voice/settings/voiceSettingsRecovery';

import { useVoiceSetupItem, VOICE_SETUP_STEP_ID } from './useVoiceSetupItem';
import { VoiceSetupPanel, type VoiceSetupPanelActions, type VoiceSetupPanelModel } from './VoiceSetupPanel';
import type { VoiceSetupFacts } from './voiceSetupFacts';
import { isVoiceSetupFailed, readVoiceSetupLight, readVoiceSetupNextStep } from './voiceSetupPresentation';

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
    const accountScope = useActiveServerAccountScope();
    const { executeValue } = useMountedActionExecution(accountScope);
    const [panelOpen, setPanelOpen] = React.useState(false);
    const [voiceSettings, setVoiceSettings] = useVoiceSettingsMutable();
    const inputs = useVoiceSettingsReadinessInputs(voiceSettings, { purpose: 'conversation', probeMachine: panelOpen });
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
    const microphone = useObservedMicrophonePermission(executeValue);
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
    const firstSuccess = voice.firstSuccessEvent ?? null;
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
    const closePanel = React.useCallback(() => {
        fireAndForget(executeValue('ui.voice_global.setup.close', {}), { tag: 'VoiceSetup.close' });
    }, [executeValue]);
    const actions = React.useMemo((): VoiceSetupPanelActions => ({
        onSelectService: readinessModel.selectService,
        onRecover: () => recoverVoiceSettingsReadiness(recoveryAction, (action) => {
            const target = resolveVoiceSettingsRecoveryTarget(action);
            if (target) router.push(target);
        }),
        onAllowMicrophone: allow,
        onOpenSystemSettings: Platform.OS === 'web' ? null : () => {
            fireAndForget(executeValue('ui.voice_global.setup.system_settings.open', {}), { tag: 'VoiceSetup.systemSettings' });
        },
        onTry: tryIt,
        onDone: () => {
            fireAndForget((async () => {
                const result = VoiceConversationActionOutputSchemas['ui.voice_global.setup.close'].parse(
                    await executeValue('ui.voice_global.setup.close', {}));
                if (result.status === 'completed') await dismiss();
            })(), { tag: 'VoiceSetup.done' });
        },
        onClose: closePanel,
        onOpenSettings: () => router.push(SETTINGS_ROUTES.voice as never),
    }), [allow, closePanel, dismiss, executeValue, readinessModel.selectService, recoveryAction, router, tryIt]);

    const model = React.useMemo((): VoiceSetupPanelModel => ({
        facts: setup.facts,
        serviceTitle,
        serviceTiles: readinessModel.serviceTiles,
        readiness: readinessText,
        tryLive: voice.live,
        firstSuccess,
        // The chord is shown where there is a keyboard to press it.
        shortcutLabel: phone ? null : shortcutLabel,
    }), [firstSuccess, phone, readinessModel.serviceTiles, readinessText, serviceTitle, setup.facts, shortcutLabel, voice.live]);

    if (!voiceEnabled || setup.hidden || (setup.facts.complete && !panelOpen)) return null;
    return {
        id: VOICE_SETUP_STEP_ID,
        span: input.span,
        requestClose: closePanel,
        registerPresentation: ({ open, close }) => registerVoiceSetupPresentation((expanded) => {
            if (!(expanded ? open() : close())) return false;
            setPanelOpen(expanded);
            return true;
        }),
        renderTile: () => (
            <VoiceSetupTile
                layout={input.layout}
                facts={setup.facts}
                onOpen={() => {
                    fireAndForget(executeValue('ui.voice_global.setup.open', {}), { tag: 'VoiceSetup.open' });
                }}
                onDismiss={dismiss}
            />
        ),
        renderPanel: () => (
            <VoiceSetupPanel
                testID="hub-setup.voice:setup"
                model={model}
                actions={actions}
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
function useObservedMicrophonePermission(executeValue: ReturnType<typeof useMountedActionExecution>['executeValue']): Readonly<{ permission: MicrophonePermissionState; allow: () => void }> {
    const [permission, setPermission] = React.useState<MicrophonePermissionState>('unknown');
    const read = React.useCallback(() => {
        void checkMicrophonePermission().then((result) => {
            // A passive read cannot see a missing device; keep the answer the last press observed.
            setPermission((current) => {
                const next = readMicrophonePermissionState(result);
                return next === 'unknown' && current === 'unavailable' ? current : next;
            });
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
        fireAndForget((async () => {
            const result = VoiceSetupMicrophonePermissionActionResultSchema.parse(
                await executeValue('ui.voice_global.setup.microphone.permission.request', {}));
            setPermission(result.permission);
        })(), { tag: 'VoiceSetup.microphone' });
    }, [executeValue]);
    return { permission, allow };
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
