import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type {
    PluginConfigurationSettingFieldV2,
    PluginJsonValueV2,
} from '@happier-dev/protocol';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Switch } from '@/components/ui/forms/Switch';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Text, TextInput } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import {
    buildConnectedAccountConfigurationSubmission,
    createConnectedAccountConfigurationDraft,
    listConnectedAccountConfigurationOptions,
    resolveConnectedAccountConfigurationControl,
    type ConnectedAccountConfigurationDraft,
} from './connectedAccountConfigurationDraft';

const stylesheet = StyleSheet.create((theme) => ({
    field: {
        paddingHorizontal: 16,
        paddingVertical: 12,
    },
    label: {
        ...Typography.default('semiBold'),
        color: theme.colors.text.primary,
        fontSize: 14,
        marginBottom: 4,
    },
    description: {
        ...Typography.default(),
        color: theme.colors.text.secondary,
        fontSize: 13,
        lineHeight: 18,
        marginBottom: 8,
    },
    input: {
        ...Typography.default(),
        minHeight: 44,
        borderRadius: 10,
        borderCurve: 'continuous',
        borderWidth: 1,
        paddingHorizontal: 12,
        paddingVertical: 10,
        fontSize: 14,
    },
    multilineInput: {
        minHeight: 88,
        textAlignVertical: 'top',
    },
    actions: {
        alignItems: 'flex-end',
        paddingHorizontal: 16,
        paddingVertical: 12,
    },
}));

function localizedText(
    value: string | Readonly<{ fallback: string }> | undefined,
): string {
    return typeof value === 'string' ? value : value?.fallback ?? '';
}

function compareFields(
    left: PluginConfigurationSettingFieldV2,
    right: PluginConfigurationSettingFieldV2,
): number {
    const leftOrder = left.presentation?.order ?? Number.POSITIVE_INFINITY;
    const rightOrder = right.presentation?.order ?? Number.POSITIVE_INFINITY;
    if (leftOrder !== rightOrder) return leftOrder - rightOrder;
    return left.id.localeCompare(right.id);
}

function ConfigurationSelectField(props: Readonly<{
    field: PluginConfigurationSettingFieldV2;
    value: unknown;
    disabled: boolean;
    onChange: (value: PluginJsonValueV2) => void;
}>) {
    const [open, setOpen] = React.useState(false);
    const options = listConnectedAccountConfigurationOptions(props.field);
    const items = React.useMemo<DropdownMenuItem[]>(() => options.map((option) => ({
        id: JSON.stringify(option.value),
        title: localizedText(option.title),
        subtitle: localizedText(option.description) || undefined,
    })), [options]);
    const selectedId = props.value === undefined ? null : JSON.stringify(props.value);
    return (
        <DropdownMenu
            testID={`connected-account-configuration:${props.field.id}`}
            open={open}
            onOpenChange={setOpen}
            selectedId={selectedId}
            variant="selectable"
            search={false}
            showCategoryTitles={false}
            matchTriggerWidth
            connectToTrigger
            itemTrigger={{
                title: localizedText(props.field.title),
                subtitle: localizedText(props.field.description) || undefined,
            }}
            items={items}
            onSelect={(itemId) => {
                const option = options.find((candidate) => JSON.stringify(candidate.value) === itemId);
                if (!option || props.disabled) return;
                props.onChange(option.value);
                setOpen(false);
            }}
        />
    );
}

export const ConnectedAccountConfigurationForm = React.memo(function ConnectedAccountConfigurationForm(props: Readonly<{
    title: string;
    fields: readonly PluginConfigurationSettingFieldV2[];
    values: Readonly<Record<string, PluginJsonValueV2>>;
    configuredSecretFieldIds: readonly string[];
    saving: boolean;
    onSubmit(input: Readonly<{
        values: Readonly<Record<string, PluginJsonValueV2>>;
        secretValues: Readonly<Record<string, string>>;
    }>): Promise<void> | void;
}>) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const [draft, setDraft] = React.useState<ConnectedAccountConfigurationDraft>(() => (
        createConnectedAccountConfigurationDraft({ fields: props.fields, values: props.values })
    ));
    const [validationFailed, setValidationFailed] = React.useState(false);

    const fields = React.useMemo(
        () => [...props.fields]
            .filter((field) => field.presentation?.hidden !== true)
            .sort(compareFields),
        [props.fields],
    );
    const updateDraft = React.useCallback((fieldId: string, value: unknown) => {
        setDraft((current) => ({ ...current, [fieldId]: value }));
        setValidationFailed(false);
    }, []);
    const submit = React.useCallback(async () => {
        const submission = buildConnectedAccountConfigurationSubmission({
            fields: props.fields,
            draft,
            configuredSecretFieldIds: props.configuredSecretFieldIds,
        });
        if (!submission.ok) {
            setValidationFailed(true);
            return;
        }
        await props.onSubmit({
            values: submission.values,
            secretValues: submission.secretValues,
        });
    }, [draft, props]);

    return (
        <ItemGroup
            title={props.title}
            footer={validationFailed ? t('common.error') : undefined}
        >
            {fields.map((field) => {
                const control = resolveConnectedAccountConfigurationControl(field);
                const title = localizedText(field.title);
                const description = localizedText(field.description);
                const disabled = props.saving;
                if (control === 'switch') {
                    const value = draft[field.id] === true;
                    return (
                        <Item
                            key={field.id}
                            title={title}
                            subtitle={description || undefined}
                            rightElement={(
                                <Switch
                                    testID={`connected-account-configuration:${field.id}`}
                                    value={value}
                                    disabled={disabled}
                                    accessibilityLabel={title}
                                    onValueChange={(next) => updateDraft(field.id, next)}
                                />
                            )}
                            rightElementOutsidePressable
                            showChevron={false}
                            disabled={disabled}
                            onPress={() => updateDraft(field.id, !value)}
                        />
                    );
                }
                if (control === 'select') {
                    return (
                        <ConfigurationSelectField
                            key={field.id}
                            field={field}
                            value={draft[field.id]}
                            disabled={disabled}
                            onChange={(value) => updateDraft(field.id, value)}
                        />
                    );
                }
                if (control === 'multiSelect') {
                    const options = listConnectedAccountConfigurationOptions(field);
                    const rawSelectedValues = draft[field.id];
                    const selectedValues: readonly PluginJsonValueV2[] = Array.isArray(rawSelectedValues)
                        ? rawSelectedValues as PluginJsonValueV2[]
                        : [];
                    const selectedIds = new Set(selectedValues.map((value) => JSON.stringify(value)));
                    return options.map((option) => {
                        const optionId = JSON.stringify(option.value);
                        const selected = selectedIds.has(optionId);
                        const optionTitle = localizedText(option.title);
                        const toggle = () => updateDraft(
                            field.id,
                            selected
                                ? selectedValues.filter((value) => JSON.stringify(value) !== optionId)
                                : [...selectedValues, option.value],
                        );
                        return (
                            <Item
                                key={`${field.id}:${optionId}`}
                                title={optionTitle}
                                subtitle={localizedText(option.description) || undefined}
                                rightElement={(
                                    <Switch
                                        testID={`connected-account-configuration:${field.id}:${optionId}`}
                                        value={selected}
                                        disabled={disabled}
                                        accessibilityLabel={optionTitle}
                                        onValueChange={toggle}
                                    />
                                )}
                                rightElementOutsidePressable
                                showChevron={false}
                                disabled={disabled}
                                onPress={toggle}
                            />
                        );
                    });
                }
                const multiline = control === 'textarea' || control === 'json';
                const fieldDraft = draft[field.id];
                return (
                    <View key={field.id} style={styles.field}>
                        <Text style={styles.label}>{title}</Text>
                        {description ? <Text style={styles.description}>{description}</Text> : null}
                        <TextInput
                            testID={`connected-account-configuration:${field.id}`}
                            accessibilityLabel={title}
                            value={typeof fieldDraft === 'string' ? fieldDraft : ''}
                            onChangeText={(value) => updateDraft(field.id, value)}
                            editable={!disabled}
                            secureTextEntry={field.secret === true}
                            multiline={multiline}
                            autoCapitalize="none"
                            autoCorrect={false}
                            placeholder={localizedText(field.presentation?.placeholder)}
                            placeholderTextColor={theme.colors.input.placeholder}
                            style={[
                                styles.input,
                                multiline ? styles.multilineInput : undefined,
                                {
                                    color: theme.colors.input.text,
                                    backgroundColor: theme.colors.input.background,
                                    borderColor: theme.colors.border.default,
                                },
                            ]}
                        />
                    </View>
                );
            })}
            <View style={styles.actions}>
                <RoundButton
                    testID="connected-account-configuration:save"
                    size="normal"
                    title={t('common.save')}
                    disabled={props.saving}
                    loading={props.saving}
                    onPress={() => void submit()}
                />
            </View>
        </ItemGroup>
    );
});
