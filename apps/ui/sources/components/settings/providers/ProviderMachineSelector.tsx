import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { SafeIonicons } from '@/components/ui/icons/SafeIonicons';
import { t } from '@/text';
import { Icon } from '@/components/ui/icons/Icon';

type ProviderMachineOption = Readonly<{
    id: string;
    active?: boolean | null;
    metadata?: Readonly<{ displayName?: string; host?: string }> | null;
}>;

export const ProviderMachineSelector = React.memo(function ProviderMachineSelector(props: Readonly<{
    machines: readonly ProviderMachineOption[];
    selectedId: string | null;
    onSelect: (machineId: string) => void;
}>) {
    const { theme } = useUnistyles();
    const [open, setOpen] = React.useState(false);
    const items = React.useMemo<readonly DropdownMenuItem[]>(() => props.machines.map((machine) => ({
        id: machine.id,
        title: machine.metadata?.displayName || machine.metadata?.host || machine.id,
        subtitle: machine.active ? t('settingsProviders.detail.machineOnline') : t('settingsProviders.detail.machineOffline'),
    })), [props.machines]);
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
                icon: <Icon name="desktop" size={29} color={theme.colors.text.secondary} />,
                showSelectedDetail: false,
                showSelectedSubtitle: false,
            }}
            items={items}
            onSelect={props.onSelect}
        />
    );
});
