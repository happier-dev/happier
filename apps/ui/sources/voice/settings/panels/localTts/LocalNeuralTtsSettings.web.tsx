import * as React from 'react';

import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import type { VoiceLocalTtsSettings } from '@/sync/domains/settings/voiceLocalTtsSettings';
import { t } from '@/text';
import { resolveKokoroDaemonTtsPackId } from '@/voice/kokoro/assets/resolveKokoroDaemonTtsPackId';
import { getKokoroSherpaVoiceCatalogForSpeakerCount } from '@/voice/kokoro/voices/kokoroSherpaVoiceMapping';
import { resolveLocalNeuralExecutionPolicy } from '@/voice/runtime/daemonInference/daemonVoiceInferencePolicy';
import { DaemonVoiceInferenceExecutionDropdown } from '@/voice/settings/panels/daemonInference/DaemonVoiceInferenceExecutionDropdown';
import { SelectedDaemonModelPackRow } from '@/voice/settings/panels/modelCatalog/DaemonModelPackRow';
import type { VoiceDaemonRouteDiagnosticReason } from '@/voice/settings/voiceProviderLocalAvailability';
import { Icon } from '@/components/ui/icons/Icon';

type KokoroVoiceSummary = Readonly<{
    id: string;
    title: string;
    subtitle?: string;
}>;

function getWebKokoroVoiceCatalog(): KokoroVoiceSummary[] {
    return (getKokoroSherpaVoiceCatalogForSpeakerCount(53) ?? []).map((voice) => ({
        id: voice.id,
        title: voice.title,
        subtitle: voice.subtitle,
    }));
}

export function LocalNeuralTtsSettings(props: {
    cfgKokoro: VoiceLocalTtsSettings['localNeural'];
    setKokoro: (next: VoiceLocalTtsSettings['localNeural']) => void;
    networkTimeoutMs: number;
    popoverBoundaryRef?: React.RefObject<any> | null;
    daemonRouteDiagnosticReason?: VoiceDaemonRouteDiagnosticReason | null;
}) {
    const { theme } = useUnistyles();
    const [openMenu, setOpenMenu] = React.useState<null | 'voiceId' | 'speed'>(null);

    const executionPolicy = React.useMemo(() => resolveLocalNeuralExecutionPolicy({
        requestedExecution: props.cfgKokoro.execution,
        platformOs: 'web',
    }), [props.cfgKokoro.execution]);
    const execution = executionPolicy.selectableExecution as 'auto' | 'daemon';
    const effectiveVoiceId = props.cfgKokoro.voiceId ?? 'af_heart';
    const effectiveSpeed = props.cfgKokoro.speed ?? 1;
    const daemonPackId = React.useMemo(
        () => resolveKokoroDaemonTtsPackId(props.cfgKokoro.assetId),
        [props.cfgKokoro.assetId],
    );
    const voices = React.useMemo(() => getWebKokoroVoiceCatalog(), []);
    const selectedVoice = React.useMemo(
        () => voices.find((voice) => voice.id === effectiveVoiceId) ?? null,
        [effectiveVoiceId, voices],
    );

    const applyKokoroUpdate = React.useCallback((next: Partial<VoiceLocalTtsSettings['localNeural']>) => {
        const nextExecutionPolicy = resolveLocalNeuralExecutionPolicy({
            requestedExecution: next.execution ?? executionPolicy.selectableExecution,
            platformOs: 'web',
        });
        props.setKokoro({
            ...props.cfgKokoro,
            ...next,
            execution: nextExecutionPolicy.selectableExecution,
        });
    }, [executionPolicy.selectableExecution, props]);

    return (
        <>
            <DaemonVoiceInferenceExecutionDropdown
                execution={execution}
                setExecution={(nextExecution) => applyKokoroUpdate({ execution: nextExecution })}
                popoverBoundaryRef={props.popoverBoundaryRef}
                allowDeviceSelection={executionPolicy.allowDeviceSelection}
            />

            <SelectedDaemonModelPackRow
                packId={daemonPackId}
                kind="tts_sherpa"
            />

            <DropdownMenu
                open={openMenu === 'voiceId'}
                onOpenChange={(next) => setOpenMenu(next ? 'voiceId' : null)}
                variant="selectable"
                search={true}
                searchPlaceholder={t('settingsVoice.local.kokoro.voice.searchPlaceholder')}
                selectedId={effectiveVoiceId}
                showCategoryTitles={false}
                matchTriggerWidth={true}
                connectToTrigger={true}
                rowKind="item"
                popoverBoundaryRef={props.popoverBoundaryRef}
                itemTrigger={{
                    title: t('settingsVoice.local.kokoro.voice.titleWeb'),
                    subtitle: t('settingsVoice.local.kokoro.voice.subtitleWeb'),
                    showSelectedSubtitle: false,
                    detailFormatter: () => selectedVoice?.title ?? effectiveVoiceId,
                }}
                items={(voices.length > 0
                    ? voices
                    : [{ id: effectiveVoiceId, title: effectiveVoiceId, subtitle: undefined }]).map((voice) => ({
                    id: voice.id,
                    title: voice.title,
                    subtitle: voice.subtitle,
                }))}
                onSelect={(id) => {
                    applyKokoroUpdate({ voiceId: id || null });
                    setOpenMenu(null);
                }}
            />

            <DropdownMenu
                open={openMenu === 'speed'}
                onOpenChange={(next) => setOpenMenu(next ? 'speed' : null)}
                variant="selectable"
                search={false}
                selectedId={String(effectiveSpeed)}
                showCategoryTitles={false}
                matchTriggerWidth={true}
                connectToTrigger={true}
                rowKind="item"
                popoverBoundaryRef={props.popoverBoundaryRef}
                itemTrigger={{
                    title: t('settingsVoice.local.kokoro.speed.title'),
                    subtitle: t('settingsVoice.local.kokoro.speed.subtitle'),
                    showSelectedSubtitle: false,
                }}
                items={[0.7, 0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.4, 1.5, 1.7, 2].map((speed) => ({
                    id: String(speed),
                    title: String(speed),
                    icon: (
                        <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                            <Icon name="speedometer" size={20} color={theme.colors.text.secondary} />
                        </View>
                    ),
                }))}
                onSelect={(id) => {
                    const parsed = Number(id);
                    applyKokoroUpdate({ speed: Number.isFinite(parsed) ? parsed : null });
                    setOpenMenu(null);
                }}
            />
        </>
    );
}
