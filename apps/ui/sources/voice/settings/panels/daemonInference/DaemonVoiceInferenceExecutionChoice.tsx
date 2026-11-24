import * as React from 'react';

import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { t } from '@/text';
import { useVoiceExecutionMachinePresentation } from '@/voice/credentials/useExecutionMachinePresentation';
import type { LocalNeuralExecution } from '@happier-dev/protocol/daemon/voiceInference';

function normalizeExecution(execution: LocalNeuralExecution | null | undefined, allowDeviceSelection: boolean): LocalNeuralExecution {
    const normalizedExecution = execution ?? 'auto';
    if (!allowDeviceSelection && normalizedExecution === 'device') {
        return 'daemon';
    }
    return normalizedExecution;
}

/**
 * Where local neural voice runs: two or three short places, so a segmented choice with every option
 * visible. The machine option is named by the Voice machine it runs on when one is chosen.
 */
export function DaemonVoiceInferenceExecutionChoice(props: Readonly<{
    execution: LocalNeuralExecution | null | undefined;
    setExecution: (execution: LocalNeuralExecution) => void;
    allowDeviceSelection?: boolean;
}>): React.ReactElement {
    const allowDeviceSelection = props.allowDeviceSelection ?? true;
    const execution = normalizeExecution(props.execution, allowDeviceSelection);
    const machineLabel = useVoiceExecutionMachinePresentation().machineLabel;
    const options = [
        { id: 'auto' as const, label: t('settingsVoice.local.daemonInference.execution.options.auto') },
        ...(allowDeviceSelection ? [{ id: 'device' as const, label: t('settingsVoice.local.daemonInference.execution.options.device') }] : []),
        { id: 'daemon' as const, label: machineLabel ?? t('settingsVoice.local.daemonInference.execution.options.daemon') },
    ];

    return (
        <SegmentedChoiceItem<LocalNeuralExecution>
            title={t('settingsVoice.local.daemonInference.execution.title')}
            subtitle={t(`settingsVoice.local.daemonInference.execution.optionSubtitles.${execution}`)}
            testIDPrefix="settings.voice.localNeural.execution"
            options={options}
            value={execution}
            onChange={(next) => props.setExecution(!allowDeviceSelection && next === 'device' ? 'daemon' : next)}
        />
    );
}
