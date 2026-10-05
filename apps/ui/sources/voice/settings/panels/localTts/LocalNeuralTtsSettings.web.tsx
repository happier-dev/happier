import * as React from 'react';

import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import type { VoiceLocalTtsSettings } from '@/sync/domains/settings/voiceLocalTtsSettings';
import { t } from '@/text';
import { resolveKokoroDaemonTtsPackId } from '@/voice/kokoro/assets/resolveKokoroDaemonTtsPackId';
import { resolveLocalNeuralExecutionPolicy } from '@/voice/runtime/daemonInference/daemonVoiceInferencePolicy';
import { DaemonVoiceInferenceExecutionDropdown } from '@/voice/settings/panels/daemonInference/DaemonVoiceInferenceExecutionDropdown';
import { SelectedDaemonModelPackRow } from '@/voice/settings/panels/modelCatalog/DaemonModelPackRow';
import type { VoiceDaemonRouteDiagnosticReason } from '@/voice/settings/voiceProviderLocalAvailability';
import { useDaemonVoiceModelCatalogController } from '@/voice/settings/panels/modelCatalog/DaemonVoiceModelCatalogContext';
import { resolveDaemonTtsVoiceSelection } from './resolveDaemonTtsVoiceSelection';
import { SettingAnchor } from '@/components/settings/shell/SettingRow';
import { VOICE_CONVERSATIONS_SETTINGS } from '@/voice/settings/voiceSettingsDeclarations';
import { LocalNeuralTtsSpeedItem } from './LocalNeuralTtsSpeedItem';

export function LocalNeuralTtsSettings(props: {
    cfgKokoro: VoiceLocalTtsSettings['localNeural'];
    setKokoro: (next: VoiceLocalTtsSettings['localNeural']) => void;
    networkTimeoutMs: number;
    popoverBoundaryRef?: React.RefObject<any> | null;
    daemonRouteDiagnosticReason?: VoiceDaemonRouteDiagnosticReason | null;
}) {
    const [openMenu, setOpenMenu] = React.useState<null | 'voiceId' | 'speed'>(null);

    const executionPolicy = React.useMemo(() => resolveLocalNeuralExecutionPolicy({
        requestedExecution: props.cfgKokoro.execution,
        platformOs: 'web',
    }), [props.cfgKokoro.execution]);
    const execution = executionPolicy.selectableExecution as 'auto' | 'daemon';
    const effectiveSpeed = props.cfgKokoro.speed ?? 1;
    const daemonPackId = React.useMemo(
        () => resolveKokoroDaemonTtsPackId(props.cfgKokoro.assetId),
        [props.cfgKokoro.assetId],
    );
    const daemonCatalog = useDaemonVoiceModelCatalogController();
    const voiceSelection = React.useMemo(() => resolveDaemonTtsVoiceSelection({
        packId: daemonPackId,
        configuredVoiceId: props.cfgKokoro.voiceId,
        statuses: daemonCatalog?.state.statuses ?? [],
    }), [daemonCatalog?.state.statuses, daemonPackId, props.cfgKokoro.voiceId]);
    const voices = voiceSelection.voices;
    const effectiveVoiceId = voiceSelection.selectedVoiceId;
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
            <SettingAnchor setting={VOICE_CONVERSATIONS_SETTINGS.settings.ttsExecution}>
            <DaemonVoiceInferenceExecutionDropdown
                execution={execution}
                setExecution={(nextExecution) => applyKokoroUpdate({ execution: nextExecution })}
                popoverBoundaryRef={props.popoverBoundaryRef}
                allowDeviceSelection={executionPolicy.allowDeviceSelection}
            />
            </SettingAnchor>

            <SelectedDaemonModelPackRow
                packId={daemonPackId}
                kind="tts_sherpa"
                setting={VOICE_CONVERSATIONS_SETTINGS.settings.ttsAssetId}
            />

            <SettingAnchor setting={VOICE_CONVERSATIONS_SETTINGS.settings.ttsVoiceId}>
            <DropdownMenu
                open={openMenu === 'voiceId'}
                onOpenChange={(next) => setOpenMenu(next ? 'voiceId' : null)}
                variant="selectable"
                search={true}
                searchPlaceholder={t('settingsVoice.local.kokoro.voice.searchPlaceholder')}
                selectedId={effectiveVoiceId ?? ''}
                showCategoryTitles={false}
                matchTriggerWidth={true}
                connectToTrigger={true}
                rowKind="item"
                popoverBoundaryRef={props.popoverBoundaryRef}
                itemTrigger={{
                    title: t('settingsVoice.local.kokoro.voice.titleWeb'),
                    subtitle: t('settingsVoice.local.kokoro.voice.subtitleWeb'),
                    showSelectedSubtitle: false,
                    detailFormatter: () => selectedVoice?.title ?? t('common.unavailable'),
                }}
                items={voices.map((voice) => ({
                    id: voice.id,
                    title: voice.title,
                    subtitle: voice.subtitle,
                }))}
                onSelect={(id) => {
                    applyKokoroUpdate({ voiceId: id || null });
                    setOpenMenu(null);
                }}
            />
            </SettingAnchor>

            <LocalNeuralTtsSpeedItem
                open={openMenu === 'speed'}
                onOpenChange={(next) => setOpenMenu(next ? 'speed' : null)}
                speed={effectiveSpeed}
                popoverBoundaryRef={props.popoverBoundaryRef}
                onSelect={(speed) => applyKokoroUpdate({ speed })}
            />
        </>
    );
}
