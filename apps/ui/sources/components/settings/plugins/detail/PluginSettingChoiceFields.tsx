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
import { buildActionRowAccessibilityLabel } from '@/components/ui/lists/actionRowAccessibility';

function localizedPresentationText(
    value: string | Readonly<{ fallback: string }> | undefined,
): string {
    return typeof value === 'string' ? value : value?.fallback ?? '';
}

type PluginSettingChoiceOption = NonNullable<
    NonNullable<PluginProjectionEditableSettingField['presentation']>['options']
>[number];

/**
 * The one place a declared choice option becomes presentation.
 *
 * A description is part of what the option means, so it belongs in the
 * accessible name on every platform — not only on web, where `Item` happens to
 * synthesize a row label from the rendered subtitle. Select and multi-select
 * both consume this so a screen reader hears the same choice either way.
 */
export function resolvePluginSettingChoiceOptionSemantics(
    option: PluginSettingChoiceOption,
): Readonly<{ id: string; title: string; description: string; accessibilityLabel: string }> {
    const title = localizedPresentationText(option.title);
    const description = localizedPresentationText(option.description);
    return Object.freeze({
        id: JSON.stringify(option.value),
        title,
        description,
        accessibilityLabel: buildActionRowAccessibilityLabel([title, description]) ?? title,
    });
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
    const items = React.useMemo((): DropdownMenuItem[] => options.map((option) => {
        const semantics = resolvePluginSettingChoiceOptionSemantics(option);
        return {
            id: semantics.id,
            title: semantics.title,
            ...(semantics.description ? { subtitle: semantics.description } : {}),
            accessibilityLabel: semantics.accessibilityLabel,
        };
    }), [options]);
    // Only an absent value takes the declared default. The projection owner
    // already resolved `undefined` -> default and returns a persisted `null`
    // verbatim, so `??` here would silently re-apply a default the user
    // explicitly cleared.
    const selectedId = JSON.stringify(props.value === undefined ? props.field.defaultValue : props.value);

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
                // The trigger names the SELECTED OPTION, not its description:
                // options now carry their description as a row subtitle, and the
                // default trigger behavior would otherwise surface that
                // description in place of the choice the user made.
                showSelectedSubtitle: false,
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

/**
 * The multi-select choice field: one Switch per declared option.
 *
 * It shares `resolvePluginSettingChoiceOptionSemantics` with the select field so
 * an option's description reaches the accessible name identically on web, iOS
 * and Android instead of only being visible.
 */
export function PluginSettingMultiSelectField(props: Readonly<{
    pluginId: string;
    group: PluginProjectionEditableSettingsGroup;
    field: PluginProjectionEditableSettingField;
    value: unknown;
    disabled: boolean;
    onChangeValue: (value: readonly unknown[]) => void;
}>) {
    const { theme } = useUnistyles();
    const selectedValues = Array.isArray(props.value) ? props.value : [];
    const selectedIds = new Set(selectedValues.map((value) => JSON.stringify(value)));
    return (
        <>
            {(props.field.presentation?.options ?? []).map((option) => {
                const semantics = resolvePluginSettingChoiceOptionSemantics(option);
                const optionId = semantics.id;
                const selected = selectedIds.has(optionId);
                const toggle = () => {
                    props.onChangeValue(selected
                        ? selectedValues.filter((value) => JSON.stringify(value) !== optionId)
                        : [...selectedValues, option.value]);
                };
                return (
                    <Item
                        key={optionId}
                        title={semantics.title}
                        subtitle={semantics.description || undefined}
                        accessibilityLabel={semantics.accessibilityLabel}
                        icon={<Icon name="sliders-horizontal" size={29} color={theme.colors.text.secondary} />}
                        rightElement={(
                            <Switch
                                value={selected}
                                disabled={props.disabled}
                                accessibilityLabel={semantics.accessibilityLabel}
                                onValueChange={toggle}
                            />
                        )}
                        rightElementOutsidePressable
                        showChevron={false}
                        disabled={props.disabled}
                        onPress={toggle}
                    />
                );
            })}
        </>
    );
}
