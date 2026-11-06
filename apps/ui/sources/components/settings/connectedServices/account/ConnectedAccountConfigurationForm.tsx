import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import type {
    PluginConfigurationSettingFieldV2,
} from '@happier-dev/protocol/plugins/contributions/settings';
import type {
    PluginJsonValueV2,
} from '@happier-dev/protocol/plugins/contributions/jsonSchema';
import type { JsonValue } from '@happier-dev/protocol/json/strictJsonValue';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import type { DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Item } from '@/components/ui/lists/Item';
import { SchemaFieldControl } from '@/components/settings/schemaFields/SchemaFieldControl';
import { ConnectedServiceSetupFlowActions } from '../setup/ConnectedServiceSetupFlowBody';
import { ConnectedAccountAdvancedFields } from './ConnectedAccountAdvancedFields';
import { ConnectedAccountGuide, type ConnectedAccountGuideContent } from './ConnectedAccountGuide';
import { ConnectedAccountFormSection } from './ConnectedAccountFormSection';
import { Text } from '@/components/ui/text/Text';
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
    description: {
        color: theme.colors.text.secondary,
        ...Typography.variant('body'),
        marginBottom: theme.space.s8,
    },
    panelActions: {
        paddingTop: theme.space.s16,
    },
    actions: {
        alignItems: 'flex-end',
        paddingHorizontal: theme.space.s16,
        paddingVertical: theme.space.s12,
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
            <SchemaFieldControl
                control="select"
                inputProps={{
                    testID: `connected-account-configuration:${props.field.id}`,
                    open,
                    onOpenChange: setOpen,
                    selectedId,
                    variant: 'selectable',
                    search: false,
                    showCategoryTitles: false,
                    matchTriggerWidth: true,
                    connectToTrigger: true,
                    itemTrigger: {
                        title,
                        subtitle: resolveProjectedLocalizedText(props.field.description, props.localize) || undefined,
                        itemProps: {
                            subtitleLines: 0,
                            accessibilityLabel: props.invalid
                                ? `${title}: ${t('connectedServices.account.configurationInvalid')}`
                                : title,
                        },
                    },
                    items,
                    onSelect: (itemId) => {
                        const option = options.find((candidate) => JSON.stringify(candidate.value) === itemId);
                        if (!option || props.disabled) return;
                        props.onChange(option.value);
                        setOpen(false);
                    },
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

export type ConnectedAccountConfigurationFormProps = Readonly<{
    title: string;
    /** Inside the new-account draft, whose row already names the sign-in method. */
    embedded?: boolean;
    localize?: (value: Parameters<typeof resolveProjectedLocalizedText>[0]) => string;
    fields: readonly PluginConfigurationSettingFieldV2[];
    values: Readonly<Record<string, JsonValue>>;
    configuredSecretFieldIds: readonly string[];
    saving: boolean;
    navigation?: unknown;
    /** In a setup panel: Cancel (local) in the flow's footer. */
    onCancel?: () => void;
    /** How to get the values of the fields it explains (an own OAuth client); shown just before `guideFieldId`. */
    guide?: ConnectedAccountGuideContent;
    guideFieldId?: string;
    onSubmit(input: Readonly<{
        values: Readonly<Record<string, PluginJsonValueV2>>;
        secretValues: Readonly<Record<string, string>>;
    }>): Promise<boolean | void> | boolean | void;
}>;

export type ConnectedAccountConfigurationSubmission = Parameters<ConnectedAccountConfigurationFormProps['onSubmit']>[0];
export type ConnectedAccountConfigurationFieldsProps = Pick<ConnectedAccountConfigurationFormProps,
    'embedded' | 'localize' | 'fields' | 'values' | 'configuredSecretFieldIds' | 'saving'
    | 'guide' | 'guideFieldId'>;

/** Shared controls and parsing for a standalone settings draft or one manual sign-in draft. */
export function useConnectedAccountConfigurationFields(
    props: ConnectedAccountConfigurationFieldsProps,
) {
    const styles = stylesheet;
    const [initialDraft] = React.useState<ConnectedAccountConfigurationDraft>(() => (
        createConnectedAccountConfigurationDraft({ fields: props.fields, values: props.values })
    ));
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
    const validate = React.useCallback((): ConnectedAccountConfigurationSubmission | null => {
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
            return null;
        }
        return {
            values: submission.values,
            secretValues: submission.secretValues,
        };
    }, [draft, fields, props]);
    const discardDraft = React.useCallback(() => {
        setDraft(initialDraft);
        setInvalidFieldIds([]);
    }, [initialDraft]);
    const isDirty = React.useMemo(() => props.fields.some((field) => (
        JSON.stringify(draft[field.id]) !== JSON.stringify(initialDraft[field.id])
    )), [draft, initialDraft, props.fields]);
    const registerInvalidFieldTarget = useConnectedAccountInvalidFieldFocus({
        invalidFieldIds,
        announcement: t('connectedServices.account.configurationInvalid'),
    });

    const basicFields = fields.filter((field) => field.presentation?.advanced !== true);
    const advancedFields = fields.filter((field) => field.presentation?.advanced === true);
    // The guide travels with the field it explains: in the open, or inside Advanced when that field is folded.
    const renderFieldRow = (field: PluginConfigurationSettingFieldV2) => props.guide && field.id === props.guideFieldId
        ? <React.Fragment key={field.id}><ConnectedAccountGuide guide={props.guide} />{renderFieldControl(field)}</React.Fragment>
        : renderFieldControl(field);
    const renderFieldControl = (field: PluginConfigurationSettingFieldV2) => {
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
                            <SchemaFieldControl
                                control="switch"
                                inputProps={{
                                    testID: `connected-account-configuration:${field.id}`,
                                    nativeID: `connected-account-configuration:${field.id}`,
                                    value,
                                    disabled,
                                    accessibilityLabel: invalid
                                        ? `${title}: ${t('connectedServices.account.configurationInvalid')}`
                                        : title,
                                    accessibilityHint: invalid
                                        ? t('connectedServices.account.configurationInvalid')
                                        : description || undefined,
                                    onValueChange: (next) => updateDraft(field.id, next),
                                }}
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
                    <SchemaFieldControl
                        control="multiSelect"
                        options={options.map(option => {
                            const id = JSON.stringify(option.value);
                            const optionTitle = resolveProjectedLocalizedText(option.title, props.localize);
                            return {
                                id,
                                title: optionTitle,
                                subtitle: resolveProjectedLocalizedText(option.description, props.localize) || undefined,
                                testID: `connected-account-configuration:${field.id}:${id}`,
                                accessibilityLabel: invalid
                                    ? `${optionTitle}: ${t('connectedServices.account.configurationInvalid')}`
                                    : optionTitle,
                                accessibilityHint: invalid ? t('connectedServices.account.configurationInvalid') : undefined,
                            };
                        })}
                        selectedIds={selectedIds}
                        disabled={disabled}
                        onToggle={optionId => {
                            const option = options.find(candidate => JSON.stringify(candidate.value) === optionId)!;
                            updateDraft(field.id, selectedIds.has(optionId)
                                ? selectedValues.filter(value => JSON.stringify(value) !== optionId)
                                : [...selectedValues, option.value]);
                        }}
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
        const multiline = control === 'textarea' || control === 'json';
        const fieldDraft = draft[field.id];
        return (
            <Item
                key={field.id}
                title={title}
                subtitle={description || undefined}
                subtitleLines={0}
                mode="info"
                showChevron={false}
                accessoryLayout={multiline || props.embedded ? 'stacked' : 'adaptive'}
                rightElement={(
                    <SchemaFieldControl
                        control="text"
                        inputProps={{
                            testID: `connected-account-configuration:${field.id}`,
                            ref: registerInvalidFieldTarget(field.id),
                            accessibilityLabel: invalid
                                ? `${title}: ${t('connectedServices.account.configurationInvalid')}`
                                : title,
                            error: invalid ? t('connectedServices.account.configurationInvalid') : null,
                            value: typeof fieldDraft === 'string' ? fieldDraft : '',
                            onChangeText: (value) => updateDraft(field.id, value),
                            editable: !disabled,
                            secureTextEntry: field.secret === true,
                            multiline,
                            monospace: control === 'json',
                            placeholder: resolveProjectedLocalizedText(field.presentation?.placeholder, props.localize),
                        }}
                    />
                )}
            />
        );
    };
    return {
        validate,
        discardDraft,
        isDirty,
        hasInvalidFields: invalidFieldIds.length > 0,
        basicContent: basicFields.map(renderFieldRow),
        advancedContent: advancedFields.length > 0 ? (
            <ConnectedAccountAdvancedFields
                key="advanced"
                count={advancedFields.length}
                hasValue={advancedFields.some((field) => initialDraft[field.id] !== undefined && initialDraft[field.id] !== '')}
                required={advancedFields.some((field) => field.required === true)}
                invalid={advancedFields.some((field) => invalidFieldIds.includes(field.id))}
            >
                {advancedFields.map(renderFieldRow)}
            </ConnectedAccountAdvancedFields>
        ) : null,
    };
}

/** The controller's target/revision key owns retirement; refreshes keep this draft. */
export const ConnectedAccountConfigurationForm = React.memo(function ConnectedAccountConfigurationForm(
    props: ConnectedAccountConfigurationFormProps,
) {
    const styles = stylesheet;
    const configuration = useConnectedAccountConfigurationFields(props);
    const submit = async () => {
        const submission = configuration.validate();
        return submission !== null && await props.onSubmit(submission) !== false;
    };
    useConnectedAccountDraftNavigationGuard({
        navigation: props.navigation,
        isDirty: configuration.isDirty,
        onDiscard: configuration.discardDraft,
        onSave: submit,
        tag: 'ConnectedAccountConfigurationForm',
    });
    return (
        <ConnectedAccountFormSection
            embedded={props.embedded}
            title={props.embedded ? undefined : props.title}
            description={configuration.hasInvalidFields ? t('connectedServices.account.configurationInvalid') : undefined}
        >
            {configuration.basicContent}
            {configuration.advancedContent}
            {props.embedded ? (
                // Inside a sign-in this step leads on to the next one, with the flow's own footer.
                <View style={styles.panelActions}>
                    <ConnectedServiceSetupFlowActions
                        onCancel={props.onCancel}
                        primary={{
                            testID: 'connected-account-configuration:save',
                            label: t('common.continue'),
                            disabled: props.saving,
                            loading: props.saving,
                            onPress: () => void submit(),
                        }}
                    />
                </View>
            ) : (
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
            )}
        </ConnectedAccountFormSection>
    );
});
