import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import type { PluginSettingFieldV2 } from '@happier-dev/protocol/plugins/contributions/settings';
import { compilePluginJsonSchema, isValidPluginJsonSchemaValue } from '@happier-dev/protocol/plugins/actions/json-schema-validation';
import type { SharedSavedSecretReferenceSelectionV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';

import { ConnectedServiceSetupFlowActions } from '../setup/ConnectedServiceSetupFlowBody';
import { ConnectedAccountAdvancedFields } from './ConnectedAccountAdvancedFields';
import { ConnectedAccountConfigurationSecretField } from './ConnectedAccountConfigurationSecretField';
import { ConnectedAccountFormSection } from './ConnectedAccountFormSection';
import { ConnectedAccountGuide, type ConnectedAccountGuideContent } from './ConnectedAccountGuide';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { SchemaFieldControl } from '@/components/settings/schemaFields/SchemaFieldControl';
import { buildActionRowAccessibilityLabel } from '@/components/ui/lists/actionRowAccessibility';
import { Item } from '@/components/ui/lists/Item';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { t } from '@/text';
import { stableJsonStringify } from '@/utils/json/stableJsonStringify';
import { resolveProjectedLocalizedText } from '@/components/plugins/surfaces/resolvePluginDisplayString';

import { useConnectedAccountInvalidFieldFocus } from './useConnectedAccountInvalidFieldFocus';
import { useConnectedAccountDraftNavigationGuard } from './useConnectedAccountDraftNavigationGuard';
import { createConnectedAccountConfigurationDraft } from './connectedAccountConfigurationDraft';
import {
    useConnectedAccountConfigurationFields,
    type ConnectedAccountConfigurationFieldsProps,
    type ConnectedAccountConfigurationSubmission,
} from './ConnectedAccountConfigurationForm';

const EMPTY_CONFIGURATION = { fields: [], values: {}, configuredSecretFieldIds: [] } as const;

const stylesheet = StyleSheet.create((theme) => ({
    field: { width: '100%', gap: theme.space.s4 },
    billing: { paddingHorizontal: theme.space.s16, paddingTop: theme.space.s8 },
    accessories: { flexDirection: 'row', alignItems: 'center' },
    note: {  ...Typography.variant('meta'),  color: theme.colors.text.secondary },
    // The content row already spaces the footer from the rows above it.
    panelActions: {},
    actions: {
        alignItems: 'flex-end',
        paddingHorizontal: theme.space.s16,
        paddingVertical: theme.space.s12,
    },
}));

type ManualAuthenticationField =
    & Omit<PluginSettingFieldV2, 'secret'>
    & Readonly<{ secret?: boolean }>;

function compareFields(left: ManualAuthenticationField, right: ManualAuthenticationField): number {
    const leftOrder = left.presentation?.order ?? Number.POSITIVE_INFINITY;
    const rightOrder = right.presentation?.order ?? Number.POSITIVE_INFINITY;
    if (leftOrder !== rightOrder) return leftOrder - rightOrder;
    return left.id.localeCompare(right.id);
}

type ConnectedAccountManualFormProps = Readonly<{
    title: string;
    /** Inside the new-account draft, whose row already names the sign-in method. */
    embedded?: boolean;
    localize?: (value: Parameters<typeof resolveProjectedLocalizedText>[0]) => string;
    fields: readonly ManualAuthenticationField[];
    accountLifetime?: ActiveServerAccountScopeLifetime;
    configuration?: Omit<ConnectedAccountConfigurationFieldsProps, 'saving' | 'embedded' | 'localize'>;
    /**
     * The manual mode's `setup` guide to creating the credential, presentation only: the
     * daemon descriptor still owns validation. `steps` lead the form, the console link closes them.
     */
    guided?: ConnectedAccountGuideContent & Readonly<{
        billingNote?: string;
        shapeHint?: string;
    }>;
    submitting: boolean;
    navigation?: unknown;
    /** In a setup panel: a compact footer with Cancel (local) beside Continue. */
    onCancel?: () => void;
    onSubmit(input: Readonly<{
        fields: Readonly<Record<string, string>>;
        selectedSecrets?: Readonly<Record<string, SharedSavedSecretReferenceSelectionV1>>;
        displayName?: string;
        configuration?: ConnectedAccountConfigurationSubmission;
    }>): Promise<boolean | void> | boolean | void;
}>;

function ManualChoiceField(props: Readonly<{
    field: ManualAuthenticationField;
    value: string;
    disabled: boolean;
    error: string | null;
    localize: ConnectedAccountManualFormProps['localize'];
    focusTarget: React.ComponentProps<typeof Item>['pressableRef'];
    onChange(value: string): void;
}>) {
    const [open, setOpen] = React.useState(false);
    const title = resolveProjectedLocalizedText(props.field.title, props.localize);
    const description = resolveProjectedLocalizedText(props.field.description, props.localize);
    const items = (props.field.presentation?.options ?? []).flatMap(option => {
        if (typeof option.value !== 'string') return [];
        const optionTitle = resolveProjectedLocalizedText(option.title, props.localize);
        const subtitle = resolveProjectedLocalizedText(option.description, props.localize);
        return [{ id: option.value, title: optionTitle, subtitle: subtitle || undefined,
            accessibilityLabel: buildActionRowAccessibilityLabel([optionTitle, subtitle]) ?? optionTitle }];
    });
    const selected = items.find(item => item.id === props.value);
    React.useEffect(() => { if (props.disabled) setOpen(false); }, [props.disabled]);
    return <SchemaFieldControl control="select" inputProps={{
        testID: `connected-account-manual:${props.field.id}`,
        open,
        onOpenChange: next => { if (!props.disabled) setOpen(next); },
        selectedId: props.value,
        items,
        variant: 'selectable',
        search: false,
        itemTrigger: {
            title,
            subtitle: [selected?.title, description, props.error].filter(Boolean).join('\n') || undefined,
            showSelectedSubtitle: false,
            itemProps: {
                disabled: props.disabled,
                subtitleLines: 0,
                pressableRef: props.focusTarget,
                accessibilityLabel: buildActionRowAccessibilityLabel([title, selected?.title, description, props.error]) ?? title,
                accessibilityHint: props.error ?? undefined,
            },
        },
        onSelect: id => {
            if (props.disabled || !items.some(item => item.id === id)) return;
            props.onChange(id);
            setOpen(false);
        },
    }} />;
}

function ConnectedAccountManualFormBody(props: ConnectedAccountManualFormProps) {
    const styles = stylesheet;
    const configuration = useConnectedAccountConfigurationFields({
        ...(props.configuration ?? EMPTY_CONFIGURATION),
        embedded: props.embedded,
        localize: props.localize,
        saving: props.submitting,
    });
    const initialDraft = React.useMemo(() => {
        const choiceDefaults = createConnectedAccountConfigurationDraft({
            fields: props.fields.flatMap(field => field.secret !== true && field.presentation?.control === 'select'
                ? [{ ...field, secret: false as const }]
                : []),
            values: {},
        });
        return Object.fromEntries(props.fields.map(field => {
            const value = choiceDefaults[field.id];
            return [field.id, typeof value === 'string' ? value : ''] as const;
        }));
    }, [props.fields]);
    const [draft, setDraft] = React.useState<Readonly<Record<string, string>>>(() => (
        initialDraft
    ));
    const [invalidFieldIds, setInvalidFieldIds] = React.useState<readonly string[]>([]);
    const [selectedSecrets, setSelectedSecrets] = React.useState<Readonly<Record<string, SharedSavedSecretReferenceSelectionV1>>>({});
    const [displayName, setDisplayName] = React.useState('');
    const [revealed, setRevealed] = React.useState(false);

    const fields = React.useMemo(
        () => [...props.fields]
            .filter((field) => field.presentation?.hidden !== true)
            .sort(compareFields),
        [props.fields],
    );
    const validators = React.useMemo(() => new Map(fields.map((field) => {
        try {
            return [field.id, compilePluginJsonSchema(field.schema)] as const;
        } catch {
            return [field.id, () => false] as const;
        }
    })), [fields]);
    const submit = React.useCallback(async () => {
        const values = Object.fromEntries(
            props.fields.filter(field => !selectedSecrets[field.id]).map((field) => [field.id, draft[field.id] ?? '']),
        );
        const invalid = fields
            .filter((field) => !selectedSecrets[field.id] && !isValidPluginJsonSchemaValue(validators.get(field.id)!, values[field.id] ?? ''))
            .map((field) => field.id);
        if (invalid.length > 0) {
            setInvalidFieldIds(invalid);
            return false;
        }
        const configurationSubmission = props.configuration ? configuration.validate() : undefined;
        if (configurationSubmission === null) return false;
        const accepted = await props.onSubmit({ fields: values,
            ...(Object.keys(selectedSecrets).length > 0 ? { selectedSecrets } : {}),
            ...(props.guided && displayName.trim() ? { displayName: displayName.trim() } : {}),
            ...(configurationSubmission ? { configuration: configurationSubmission } : {}),
        });
        return accepted !== false;
    }, [configuration, displayName, draft, fields, props, selectedSecrets, validators]);
    const discardDraft = React.useCallback(() => {
        setDraft(initialDraft);
        setSelectedSecrets({});
        setInvalidFieldIds([]);
        setDisplayName('');
        setRevealed(false);
        configuration.discardDraft();
    }, [configuration, initialDraft]);
    const isDirty = configuration.isDirty || displayName.length > 0 || Object.keys(selectedSecrets).length > 0 || props.fields.some((field) => (
        (draft[field.id] ?? '') !== (initialDraft[field.id] ?? '')
    ));
    useConnectedAccountDraftNavigationGuard({
        navigation: props.navigation,
        isDirty,
        onDiscard: discardDraft,
        onSave: submit,
        tag: 'ConnectedAccountManualForm',
    });
    const registerInvalidFieldTarget = useConnectedAccountInvalidFieldFocus({
        invalidFieldIds,
        announcement: t('common.error'),
    });

    const fieldControl = (field: ManualAuthenticationField) => {
        const title = resolveProjectedLocalizedText(field.title, props.localize);
        const invalid = invalidFieldIds.includes(field.id);
        const error = invalid ? (draft[field.id]
            ? t('connectedServicesSettings.manualFieldInvalid', { field: title })
            : t('common.error')) : null;
        if (field.presentation?.control === 'select') {
            return <ManualChoiceField field={field} value={draft[field.id] ?? ''} disabled={props.submitting}
                error={error} localize={props.localize} focusTarget={registerInvalidFieldTarget(field.id)}
                onChange={value => {
                    setDraft(current => ({ ...current, [field.id]: value }));
                    setInvalidFieldIds(current => current.filter(id => id !== field.id));
                }} />;
        }
        return <FieldTextInput
            testID={`connected-account-manual:${field.id}`}
            ref={registerInvalidFieldTarget(field.id)}
            accessibilityLabel={error ? `${title}: ${error}` : title}
            error={error}
            value={draft[field.id] ?? ''}
            onChangeText={(value) => {
                setDraft((current) => ({ ...current, [field.id]: value }));
                setInvalidFieldIds((current) => current.filter((id) => id !== field.id));
            }}
            editable={!props.submitting}
            secureTextEntry={field.secret === true && !revealed}
            multiline={field.presentation?.control === 'textarea'}
            placeholder={resolveProjectedLocalizedText(field.presentation?.placeholder, props.localize)}
            style={props.guided ? styles.field : undefined}
            trailing={props.guided && field.secret ? <View style={styles.accessories}>
                <IconButton testID={`connected-account-manual:${field.id}.reveal`} iconName={revealed ? 'eye-slash' : 'eye'} variant="plain" size={18}
                    accessibilityLabel={t(revealed ? 'connectedServicesSettings.keyHide' : 'connectedServicesSettings.keyReveal')} disabled={props.submitting} onPress={() => setRevealed((value) => !value)} />
                <IconButton testID={`connected-account-manual:${field.id}.clear`} iconName="x" variant="plain" size={18}
                    accessibilityLabel={t('connectedServicesSettings.keyClear')} disabled={props.submitting || !draft[field.id]} onPress={() => setDraft((value) => ({ ...value, [field.id]: '' }))} />
            </View> : undefined}
        />;
    };
    const guided = props.guided;
    // The primary waits for every field that must be filled; a filled value that misses its shape says so on press.
    const missingRequired = fields.some((field) => !selectedSecrets[field.id] && !(draft[field.id] ?? '')
        && !isValidPluginJsonSchemaValue(validators.get(field.id)!, ''));
    const basicFields = fields.filter((field) => field.presentation?.advanced !== true);
    const advancedFields = fields.filter((field) => field.presentation?.advanced === true);
    const renderFieldRow = (field: ManualAuthenticationField) => {
        if (field.presentation?.control === 'select' && field.secret !== true) {
            return <React.Fragment key={field.id}>{fieldControl(field)}</React.Fragment>;
        }
        const title = resolveProjectedLocalizedText(field.title, props.localize);
        const description = resolveProjectedLocalizedText(field.description, props.localize);
        const multiline = field.presentation?.control === 'textarea';
        const guidedKey = guided && field.secret === true;
        const selection = selectedSecrets[field.id];
        return (
            <React.Fragment key={field.id}>
                {!selection ? <Item
                    title={title}
                    subtitle={description || undefined}
                    subtitleLines={0}
                    mode="info"
                    showChevron={false}
                    // Label and helper on the left, the field on the right; a narrow row stacks it (owner 2026-11-11).
                    accessoryLayout={multiline ? 'stacked' : 'adaptive'}
                    rightElement={guidedKey ? (
                        <View style={styles.field}>
                            {fieldControl(field)}
                            {guided.shapeHint ? <Text style={styles.note}>{guided.shapeHint}</Text> : null}
                        </View>
                    ) : fieldControl(field)}
                /> : null}
                {field.secret === true && props.accountLifetime ? (
                    <ConnectedAccountConfigurationSecretField
                        fieldId={field.id}
                        testIDPrefix="connected-account-manual"
                        title={selection ? title : t('connectedServicesSettings.manualUseSavedSecret')}
                        description={selection ? description : ''}
                        secretRef={selection?.ref ?? null}
                        selection={selection}
                        accountLifetime={props.accountLifetime}
                        disabled={props.submitting}
                        invalid={false}
                        errorId={`connected-account-manual:${field.id}:error`}
                        onChange={next => {
                            setSelectedSecrets(current => {
                                const result = { ...current };
                                if (next) result[field.id] = next;
                                else delete result[field.id];
                                return result;
                            });
                            setDraft(current => current[field.id] ? { ...current, [field.id]: '' } : current);
                            setInvalidFieldIds(current => current.filter(id => id !== field.id));
                        }}
                    />
                ) : null}
            </React.Fragment>
        );
    };
    return (
        <ConnectedAccountFormSection
            embedded={props.embedded}
            title={props.embedded ? undefined : props.title}
        >
            {/* A guided key opens with how to create it (lab crGuide A): the declared steps, then its console. Then
                one card of field rows (lab `s2svc:key`), an optional name and the billing fact; no stepper. */}
            {guided ? <SectionContentRow showDivider={false}><ConnectedAccountGuide guide={guided} /></SectionContentRow> : null}
            {/* One order on every key sheet: the secret, the settings it needs, the optional name, then what is folded. */}
            {basicFields.map(renderFieldRow)}
            {props.configuration ? configuration.basicContent : null}
            {guided ? (
                <Item
                    title={t('connectedServicesSettings.keyName')}
                    subtitle={t('connectedServicesSettings.keyNameOptional')}
                    subtitleLines={0}
                    mode="info"
                    showChevron={false}
                    accessoryLayout="adaptive"
                    showDivider={false}
                    rightElement={<FieldTextInput testID="connected-account-manual:name"
                        value={displayName} onChangeText={setDisplayName} accessibilityLabel={t('connectedServicesSettings.keyName')}
                        editable={!props.submitting} style={styles.field} />}
                />
            ) : null}
            {props.configuration ? configuration.advancedContent : null}
            {advancedFields.length > 0 ? (
                <ConnectedAccountAdvancedFields
                    count={advancedFields.length}
                    hasValue={advancedFields.some((field) => Boolean(initialDraft[field.id]))}
                    required={advancedFields.some((field) => !isValidPluginJsonSchemaValue(validators.get(field.id)!, ''))}
                    invalid={advancedFields.some((field) => invalidFieldIds.includes(field.id))}
                >
                    {advancedFields.map(renderFieldRow)}
                </ConnectedAccountAdvancedFields>
            ) : null}
            {guided?.billingNote ? <Text style={[styles.note, styles.billing]}>{guided.billingNote}</Text> : null}
            {props.onCancel ? (
                <SectionContentRow showDivider={false}><View style={styles.panelActions}>
                    <ConnectedServiceSetupFlowActions
                        onCancel={props.onCancel}
                        primary={{
                            testID: 'connected-account-manual:submit',
                            label: t('connectedServicesSettings.connect'),
                            disabled: props.submitting || missingRequired,
                            loading: props.submitting,
                            onPress: () => void submit(),
                        }}
                    />
                </View></SectionContentRow>
            ) : (
                <View style={styles.actions}>
                    <RoundButton
                        testID="connected-account-manual:submit"
                        title={t('connectedServicesSettings.connect')}
                        size={guided ? 'small' : undefined}
                        disabled={props.submitting || missingRequired}
                        loading={props.submitting}
                        onPress={submit}
                    />
                </View>
            )}
        </ConnectedAccountFormSection>
    );
}

/**
 * Manual credential fields can change while the route stays mounted (for
 * example after a daemon descriptor refresh). A semantic descriptor key gives
 * the form a fresh local lifetime, so no secret draft survives into a new mode.
 */
export const ConnectedAccountManualForm = React.memo(function ConnectedAccountManualForm(
    props: ConnectedAccountManualFormProps,
) {
    const draftKey = React.useMemo(() => stableJsonStringify(props.fields), [props.fields]);
    return <ConnectedAccountManualFormBody key={draftKey} {...props} />;
});
