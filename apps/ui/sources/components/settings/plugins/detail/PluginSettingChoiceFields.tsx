import * as React from 'react';

import { useUnistyles } from 'react-native-unistyles';

import type {
    PluginProjectionEditableSettingField,
    PluginProjectionEditableSettingsGroup,
} from '@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters';
import { Switch } from '@/components/ui/forms/Switch';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Item } from '@/components/ui/lists/Item';
import { Icon } from '@/components/ui/icons/Icon';

function localizedPresentationText(
    value: string | Readonly<{ fallback: string }> | undefined,
): string {
    return typeof value === 'string' ? value : value?.fallback ?? '';
}

export function PluginSettingSwitchField(props: Readonly<{
    pluginId: string;
    group: PluginProjectionEditableSettingsGroup;
    field: PluginProjectionEditableSettingField;
    value: boolean;
    disabled: boolean;
    onChangeValue: (field: PluginProjectionEditableSettingField, value: boolean) => void;
}>) {
    const { theme } = useUnistyles();
    const testID = `settings.plugins.detail.${props.pluginId}.settings.${props.group.id}.${props.field.key}`;

    return (
        <Item
            testID={testID}
            title={props.field.title}
            subtitle={props.field.subtitle ?? undefined}
            icon={<Icon name="sliders-horizontal" size={29} color={theme.colors.text.secondary} />}
            rightElement={(
                <Switch
                    value={props.value}
                    disabled={props.disabled}
                    accessibilityLabel={props.field.title}
                    onValueChange={(nextValue) => props.onChangeValue(props.field, nextValue)}
                />
            )}
            rightElementOutsidePressable
            showChevron={false}
            disabled={props.disabled}
            onPress={() => props.onChangeValue(props.field, !props.value)}
        />
    );
}

export function PluginSettingSelectField(props: Readonly<{
    pluginId: string;
    group: PluginProjectionEditableSettingsGroup;
    field: PluginProjectionEditableSettingField;
    value: unknown;
    disabled: boolean;
    popoverBoundaryRef?: React.RefObject<any> | null;
    onChangeValue: (value: unknown) => void;
}>) {
    const { theme } = useUnistyles();
    const [open, setOpen] = React.useState(false);
    const options = props.field.presentation?.options ?? [];
    const items = React.useMemo((): DropdownMenuItem[] => options.map((option) => ({
        id: JSON.stringify(option.value),
        title: localizedPresentationText(option.title),
    })), [options]);
    const selectedId = JSON.stringify(props.value ?? props.field.defaultValue);

    React.useLayoutEffect(() => {
        if (props.disabled && open) {
            setOpen(false);
        }
    }, [open, props.disabled]);

    return (
        <DropdownMenu
            open={open}
            onOpenChange={(nextOpen) => {
                if (nextOpen && props.disabled) return;
                setOpen(nextOpen);
            }}
            selectedId={selectedId}
            variant="selectable"
            rowKind="item"
            search={false}
            showCategoryTitles={false}
            matchTriggerWidth
            connectToTrigger
            popoverBoundaryRef={props.popoverBoundaryRef}
            itemTrigger={{
                title: props.field.title,
                subtitle: items.find((item) => item.id === selectedId)?.title ?? props.field.subtitle ?? undefined,
                icon: <Icon name="sliders-horizontal" size={29} color={theme.colors.text.secondary} />,
                itemProps: { disabled: props.disabled },
            }}
            items={items}
            onSelect={(itemId) => {
                const option = options.find((candidate) => JSON.stringify(candidate.value) === itemId);
                if (!option || props.disabled) return;
                props.onChangeValue(option.value);
                setOpen(false);
            }}
        />
    );
}
