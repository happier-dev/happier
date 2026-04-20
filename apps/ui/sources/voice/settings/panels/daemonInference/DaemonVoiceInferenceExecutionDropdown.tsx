import * as React from 'react';

import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { t } from '@/text';
import type { LocalNeuralExecution } from '@happier-dev/protocol';

function resolveExecutionTitle(execution: LocalNeuralExecution): string {
    switch (execution) {
        case 'device':
            return t('settingsVoice.local.daemonInference.execution.options.device');
        case 'daemon':
            return t('settingsVoice.local.daemonInference.execution.options.daemon');
        default:
            return t('settingsVoice.local.daemonInference.execution.options.auto');
    }
}

function normalizeExecution(execution: LocalNeuralExecution | null | undefined, allowDeviceSelection: boolean): LocalNeuralExecution {
    const normalizedExecution = execution ?? 'auto';
    if (!allowDeviceSelection && normalizedExecution === 'device') {
        return 'daemon';
    }
    return normalizedExecution;
}

export function DaemonVoiceInferenceExecutionDropdown(props: Readonly<{
    execution: LocalNeuralExecution | null | undefined;
    setExecution: (execution: LocalNeuralExecution) => void;
    popoverBoundaryRef?: React.RefObject<any> | null;
    allowDeviceSelection?: boolean;
}>): React.ReactElement {
    const [open, setOpen] = React.useState(false);
    const allowDeviceSelection = props.allowDeviceSelection ?? true;
    const execution = normalizeExecution(props.execution, allowDeviceSelection);
    const items = [
        {
            id: 'auto',
            title: t('settingsVoice.local.daemonInference.execution.options.auto'),
            subtitle: t('settingsVoice.local.daemonInference.execution.optionSubtitles.auto'),
        },
        {
            id: 'daemon',
            title: t('settingsVoice.local.daemonInference.execution.options.daemon'),
            subtitle: t('settingsVoice.local.daemonInference.execution.optionSubtitles.daemon'),
        },
    ];

    if (allowDeviceSelection) {
        items.splice(1, 0, {
            id: 'device',
            title: t('settingsVoice.local.daemonInference.execution.options.device'),
            subtitle: t('settingsVoice.local.daemonInference.execution.optionSubtitles.device'),
        });
    }

    return (
        <DropdownMenu
            open={open}
            onOpenChange={setOpen}
            variant="selectable"
            search={false}
            selectedId={execution}
            showCategoryTitles={false}
            matchTriggerWidth={true}
            connectToTrigger={true}
            rowKind="item"
            popoverBoundaryRef={props.popoverBoundaryRef}
            itemTrigger={{
                title: t('settingsVoice.local.daemonInference.execution.title'),
                subtitle: t('settingsVoice.local.daemonInference.execution.subtitle'),
                showSelectedSubtitle: false,
                detailFormatter: () => resolveExecutionTitle(execution),
            }}
            items={items}
            onSelect={(nextExecution) => {
                let normalizedExecution: LocalNeuralExecution = nextExecution === 'device' || nextExecution === 'daemon' ? nextExecution : 'auto';
                if (!allowDeviceSelection && normalizedExecution === 'device') {
                    normalizedExecution = 'daemon';
                }
                props.setExecution(normalizedExecution);
                setOpen(false);
            }}
        />
    );
}
