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
import { resolveProjectedLocalizedText } from '@/components/plugins/surfaces/resolvePluginDisplayString';
import {
    connectedAccountFieldErrorId,
    useConnectedAccountInvalidFieldFocus,
} from './useConnectedAccountInvalidFieldFocus';
import { useConnectedAccountDraftNavigationGuard } from './useConnectedAccountDraftNavigationGuard';

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
    invalid: boolean;
    errorId: string;
    localize?: (value: Parameters<typeof resolveProjectedLocalizedText>[0]) => string;
    registerTarget: (fieldId: string) => (target: React.ComponentRef<typeof View> | null) => void;
    onChange: (value: PluginJsonValueV2) => void;
}>) {
    const [open, setOpen] = React.useState(false);
    const options = listConnectedAccountConfigurationOptions(props.field);
    const items = React.useMemo<DropdownMenuItem[]>(() => options.map((option) => ({
        id: JSON.stringify(option.value),
        title: resolveProjectedLocalizedText(option.title, props.localize),
        subtitle: resolveProjectedLocalizedText(option.description, props.localize) || undefined,
    })), [options, props.localize]);
    const selectedId = props.value === undefined ? null : JSON.stringify(props.value);
    const title = resolveProjectedLocalizedText(props.field.title, props.localize);
    return (
        <View ref={props.registerTarget(props.field.id)}>
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
                    title,
                    subtitle: resolveProjectedLocalizedText(props.field.description, props.localize) || undefined,
                    itemProps: {
                        accessibilityLabel: props.invalid
                            ? `${title}: ${t('connectedServices.account.configurationInvalid')}`
                            : title,
                    },
                }}
                items={items}
                onSelect={(itemId) => {
                    const option = options.find((candidate) => JSON.stringify(candidate.value) === itemId);
                    if (!option || props.disabled) return;
                    props.onChange(option.value);
                    setOpen(false);
                }}
            />
            {props.invalid ? (
                <Text
                    testID={props.errorId}
                    nativeID={props.errorId}
                    accessibilityRole="alert"
                    accessibilityLiveRegion="assertive"
                >
                    {t('connectedServices.account.configurationInvalid')}
                </Text>
            ) : null}
        </View>
    );
}

type ConnectedAccountConfigurationFormProps = Readonly<{
    title: string;
    localize?: (value: Parameters<typeof resolveProjectedLocalizedText>[0]) => string;
    fields: readonly PluginConfigurationSettingFieldV2[];
    values: Readonly<Record<string, PluginJsonValueV2>>;
    configuredSecretFieldIds: readonly string[];
    saving: boolean;
    navigation?: unknown;
    onSubmit(input: Readonly<{
        values: Readonly<Record<string, PluginJsonValueV2>>;
        secretValues: Readonly<Record<string, string>>;
    }>): Promise<boolean | void> | boolean | void;
}>;

function ConnectedAccountConfigurationFormBody(props: ConnectedAccountConfigurationFormProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const initialDraft = React.useMemo(() => (
        createConnectedAccountConfigurationDraft({ fields: props.fields, values: props.values })
    ), [props.fields, props.values]);
    const [draft, setDraft] = React.useState<ConnectedAccountConfigurationDraft>(() => (
        initialDraft
    ));
    const [invalidFieldIds, setInvalidFieldIds] = React.useState<readonly string[]>([]);

    const fields = React.useMemo(
        () => [...props.fields]
            .filter((field) => field.presentation?.hidden !== true)
            .sort(compareFields),
        [props.fields],
    );
    const updateDraft = React.useCallback((fieldId: string, value: unknown) => {
        setDraft((current) => ({ ...current, [fieldId]: value }));
        setInvalidFieldIds((current) => current.filter((id) => id !== fieldId));
    }, []);
    const submit = React.useCallback(async () => {
        const submission = buildConnectedAccountConfigurationSubmission({
            fields: props.fields,
            draft,
            configuredSecretFieldIds: props.configuredSecretFieldIds,
        });
        if (!submission.ok) {
            const invalidIds = new Set([
                ...submission.missingFieldIds,
                ...submission.invalidFieldIds,
            ]);
            setInvalidFieldIds(fields
                .filter((field) => invalidIds.has(field.id))
                .map((field) => field.id));
            return false;
        }
        const saved = await props.onSubmit({
            values: submission.values,
            secretValues: submission.secretValues,
        });
        return saved !== false;
    }, [draft, fields, props]);
    const discardDraft = React.useCallback(() => {
        setDraft(initialDraft);
        setInvalidFieldIds([]);
    }, [initialDraft]);
    const isDirty = React.useMemo(() => props.fields.some((field) => (
        JSON.stringify(draft[field.id]) !== JSON.stringify(initialDraft[field.id])
    )), [draft, initialDraft, props.fields]);
    useConnectedAccountDraftNavigationGuard({
        navigation: props.navigation,
        isDirty,
        onDiscard: discardDraft,
        onSave: submit,
        tag: 'ConnectedAccountConfigurationForm',
    });
    const registerInvalidFieldTarget = useConnectedAccountInvalidFieldFocus({
        invalidFieldIds,
        announcement: t('connectedServices.account.configurationInvalid'),
    });

    return (
        <ItemGroup
            title={props.title}
            footer={invalidFieldIds.length > 0
                ? t('connectedServices.account.configurationInvalid')
                : undefined}
        >
            {fields.map((field) => {
                const control = resolveConnectedAccountConfigurationControl(field);
                const title = resolveProjectedLocalizedText(field.title, props.localize);
                const description = resolveProjectedLocalizedText(field.description, props.localize);
                const disabled = props.saving;
                const invalid = invalidFieldIds.includes(field.id);
                const errorId = connectedAccountFieldErrorId(
                    'connected-account-configuration',
                    field.id,
                );
                if (control === 'switch') {
                    const value = draft[field.id] === true;
                    return (
                        <View
                            key={field.id}
                            ref={registerInvalidFieldTarget(field.id)}
                        >
                            <Item
                                title={title}
                                subtitle={description || undefined}
                                rightElement={(
                                    <Switch
                                        testID={`connected-account-configuration:${field.id}`}
                                        nativeID={`connected-account-configuration:${field.id}`}
                                        value={value}
                                        disabled={disabled}
                                        accessibilityLabel={invalid
                                            ? `${title}: ${t('connectedServices.account.configurationInvalid')}`
                                            : title}
                                        accessibilityHint={invalid
                                            ? t('connectedServices.account.configurationInvalid')
                                            : description || undefined}
                                        onValueChange={(next) => updateDraft(field.id, next)}
                                    />
                                )}
                                rightElementOutsidePressable
                                showChevron={false}
                                disabled={disabled}
                                onPress={() => updateDraft(field.id, !value)}
                            />
                            {invalid ? (
                                <Text
                                    testID={errorId}
                                    nativeID={errorId}
                                    accessibilityRole="alert"
                                    accessibilityLiveRegion="assertive"
                                    style={styles.description}
                                >
                                    {t('connectedServices.account.configurationInvalid')}
                                </Text>
                            ) : null}
                        </View>
                    );
                }
                if (control === 'select') {
                    return (
                        <ConfigurationSelectField
                            key={field.id}
                            field={field}
                            localize={props.localize}
                            value={draft[field.id]}
                            disabled={disabled}
                            invalid={invalid}
                            errorId={errorId}
                            registerTarget={registerInvalidFieldTarget}
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
                    return (
                        <View
                            key={field.id}
                            ref={registerInvalidFieldTarget(field.id)}
                        >
                            {options.map((option) => {
                                const optionId = JSON.stringify(option.value);
                                const selected = selectedIds.has(optionId);
                                const optionTitle = resolveProjectedLocalizedText(option.title, props.localize);
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
                                        subtitle={resolveProjectedLocalizedText(option.description, props.localize) || undefined}
                                        rightElement={(
                                            <Switch
                                                testID={`connected-account-configuration:${field.id}:${optionId}`}
                                                value={selected}
                                                disabled={disabled}
                                                accessibilityLabel={invalid
                                                    ? `${optionTitle}: ${t('connectedServices.account.configurationInvalid')}`
                                                    : optionTitle}
                                                accessibilityHint={invalid
                                                    ? t('connectedServices.account.configurationInvalid')
                                                    : undefined}
                                                onValueChange={toggle}
                                            />
                                        )}
                                        rightElementOutsidePressable
                                        showChevron={false}
                                        disabled={disabled}
                                        onPress={toggle}
                                    />
                                );
                            })}
                            {invalid ? (
                                <Text
                                    testID={errorId}
                                    nativeID={errorId}
                                    accessibilityRole="alert"
                                    accessibilityLiveRegion="assertive"
                                    style={styles.description}
                                >
                                    {t('connectedServices.account.configurationInvalid')}
                                </Text>
                            ) : null}
                        </View>
                    );
                }
                const multiline = control === 'textarea' || control === 'json';
                const fieldDraft = draft[field.id];
                return (
                    <View key={field.id} style={styles.field}>
                        <Text style={styles.label}>{title}</Text>
                        {description ? <Text style={styles.description}>{description}</Text> : null}
                        <TextInput
                            testID={`connected-account-configuration:${field.id}`}
                            ref={registerInvalidFieldTarget(field.id)}
                            nativeID={`connected-account-configuration:${field.id}`}
                            accessibilityLabel={invalid
                                ? `${title}: ${t('connectedServices.account.configurationInvalid')}`
                                : title}
                            accessibilityHint={invalid
                                ? t('connectedServices.account.configurationInvalid')
                                : description || undefined}
                            value={typeof fieldDraft === 'string' ? fieldDraft : ''}
                            onChangeText={(value) => updateDraft(field.id, value)}
                            editable={!disabled}
                            secureTextEntry={field.secret === true}
                            multiline={multiline}
                            autoCapitalize="none"
                            autoCorrect={false}
                            placeholder={resolveProjectedLocalizedText(field.presentation?.placeholder, props.localize)}
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
                        {invalid ? (
                            <Text
                                testID={errorId}
                                nativeID={errorId}
                                accessibilityRole="alert"
                                accessibilityLiveRegion="assertive"
                                style={styles.description}
                            >
                                {t('connectedServices.account.configurationInvalid')}
                            </Text>
                        ) : null}
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
}

/**
 * Descriptor fields, read values, and configured-secret facts form one draft
 * contract. Any change starts a fresh form lifetime even while this route and
 * Account controller remain mounted.
 */
export const ConnectedAccountConfigurationForm = React.memo(function ConnectedAccountConfigurationForm(
    props: ConnectedAccountConfigurationFormProps,
) {
    const draftKey = React.useMemo(() => JSON.stringify([
        props.fields,
        props.values,
        props.configuredSecretFieldIds,
    ]), [props.configuredSecretFieldIds, props.fields, props.values]);
    return <ConnectedAccountConfigurationFormBody key={draftKey} {...props} />;
});
