import * as React from 'react';

import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { SafeIonicons } from '@/components/ui/icons/SafeIonicons';
import { t } from '@/text';
import { resolveMachineDisplayNames } from '@/utils/sessions/machineDisplayNames';
import { useMachinePresenceSummaries } from '@/sync/domains/machines/reachability/useMachinePresenceSummary';

type ProviderMachineOption = Readonly<{
    id: string;
    metadata?: Readonly<{ displayName?: string; host?: string }> | null;
}>;

export const ProviderMachineSelector = React.memo(function ProviderMachineSelector(props: Readonly<{
    serverId: string | null;
    machines: readonly ProviderMachineOption[];
    selectedId: string | null;
    onSelect: (machineId: string) => void;
}>) {
    const [open, setOpen] = React.useState(false);
    const presence = useMachinePresenceSummaries(props.serverId, props.machines.map(machine => machine.id));
    const items = React.useMemo<readonly DropdownMenuItem[]>(() => {
        const names = resolveMachineDisplayNames(props.machines);
        return props.machines.map((machine, index) => ({
        id: machine.id,
        title: names.get(machine.id) ?? machine.id,
        subtitle: presence[index]?.reachability === 'reachable' ? t('settingsProviders.detail.machineOnline')
            : presence[index]?.reachability === 'unreachable' ? t('settingsProviders.detail.machineOffline') : t('common.unknown'),
        }));
    }, [props.machines, presence]);
    if (items.length <= 1) return null;
    return (
        <DropdownMenu
            open={open}
            onOpenChange={setOpen}
            variant="selectable"
            search={items.length >= 10}
            selectedId={props.selectedId}
            showCategoryTitles={false}
            rowKind="item"
            itemTrigger={{
                title: t('settingsProviders.detail.targetMachine'),
                subtitle: items.find((item) => item.id === props.selectedId)?.title,
                showSelectedDetail: false,
                showSelectedSubtitle: false,
            }}
            items={items}
            onSelect={props.onSelect}
        />
    );
});
