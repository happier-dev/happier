import * as React from 'react';
import { Platform, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useRouter } from 'expo-router';

import type {
    PluginProjectionEditableSettingField,
    PluginProjectionEditableSettingsGroup,
    PluginProjectionEntry,
} from '@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Switch } from '@/components/ui/forms/Switch';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Text, TextInput } from '@/components/ui/text/Text';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import {
    machinePluginSettingsGet,
    machinePluginSettingsSet,
    type MachinePluginSettingsResult,
} from '@/sync/ops/machineContributionRegistryProjection';
import {
    evaluatePluginUiPolicy,
    type PluginUiPolicyEvaluationContext,
} from '@/sync/domains/plugins/ui/policy/evaluate';
import { emitPluginSettingChangedEvent } from '@/track/settingsAnalytics/emitPluginSettingChangedEvent';
import {
    PluginSettingSelectField,
    PluginSettingSwitchField,
} from './PluginSettingChoiceFields';

const stylesheet = StyleSheet.create((theme) => ({
    fieldContainer: {
        paddingHorizontal: 16,
        paddingVertical: 12,
    },
    fieldLabel: {
        ...Typography.default('semiBold'),
        color: theme.colors.text.primary,
        fontSize: 14,
        marginBottom: 4,
    },
    fieldHint: {
        ...Typography.default(),
        color: theme.colors.text.secondary,
        fontSize: 13,
        lineHeight: 18,
        marginBottom: 8,
    },
    textInput: {
        ...Typography.default(),
        minHeight: 44,
        borderRadius: 10,
        borderCurve: 'continuous',
        borderWidth: 1,
        paddingHorizontal: 12,
        paddingVertical: 10,
        fontSize: 14,
    },
    textAreaInput: {
        minHeight: 88,
        textAlignVertical: 'top',
    },
    fieldActions: {
        alignItems: 'flex-end',
        marginTop: 8,
    },
    saveButton: {
        minWidth: 96,
    },
}));

type SettingsValues = Readonly<Record<string, unknown>>;
type TextDraft = Readonly<{
    value: string;
    revision: number;
    dirty: boolean;
}>;
type TextDrafts = Readonly<Record<string, TextDraft>>;
type FieldCommit =
    | Readonly<{ kind: 'text'; draft: TextDraft }>
    | Readonly<{ kind: 'switch' }>
    | Readonly<{ kind: 'direct' }>;
type InFlightFieldOperation = Readonly<{
    id: number;
    declarationEpoch: number;
}>;
type PersistenceScope = Readonly<{
    machineId: string;
    serverId: string | null;
    pluginId: string;
}>;

const EMPTY_EDITABLE_SETTINGS_GROUPS: readonly PluginProjectionEditableSettingsGroup[] = Object.freeze([]);

function compareSettingsFields(
    left: PluginProjectionEditableSettingField,
    right: PluginProjectionEditableSettingField,
): number {
    const leftOrder = typeof left.order === 'number' ? left.order : Number.POSITIVE_INFINITY;
    const rightOrder = typeof right.order === 'number' ? right.order : Number.POSITIVE_INFINITY;
    if (leftOrder !== rightOrder) return leftOrder - rightOrder;
    const titleDelta = left.title.localeCompare(right.title);
    return titleDelta !== 0 ? titleDelta : left.key.localeCompare(right.key);
}

function compareSettingsGroups(
    left: PluginProjectionEditableSettingsGroup,
    right: PluginProjectionEditableSettingsGroup,
): number {
    return left.id.localeCompare(right.id);
}

function isRedactedField(field: PluginProjectionEditableSettingField): boolean {
    return field.control === 'password' || (field.redaction ?? 'none') !== 'none';
}

function sanitizeSnapshotValues(
    groups: readonly PluginProjectionEditableSettingsGroup[],
    result: Extract<MachinePluginSettingsResult, { supported: true }>,
): SettingsValues {
    const redactedKeys = new Set(result.snapshot.redactedKeys);
    const redactedByMetadata = new Set(
        groups.flatMap((group) => group.fields.filter(isRedactedField).map((field) => field.key)),
    );
    const values: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(result.snapshot.values)) {
        if (redactedKeys.has(key) || redactedByMetadata.has(key)) {
            continue;
        }
        values[key] = value;
    }
    return values;
}

function readBoundSettingValue(
    values: SettingsValues,
    field: PluginProjectionEditableSettingField,
    serverId: string | null,
): unknown {
    const binding = field.presentation?.binding;
    if (binding?.kind === 'direct' && binding.settingId) {
        return values[binding.settingId];
    }
    if (binding?.kind === 'perActiveServer') {
        const byServer = values[binding.byServerIdSettingId];
        if (
            serverId
            && byServer
            && typeof byServer === 'object'
            && !Array.isArray(byServer)
            && Object.prototype.hasOwnProperty.call(byServer, serverId)
        ) {
            return Reflect.get(byServer, serverId);
        }
        return values[binding.fallbackSettingId];
    }
    return values[field.key];
}

function readTextValue(
    values: SettingsValues,
    field: PluginProjectionEditableSettingField,
    serverId: string | null = null,
): string {
    const boundValue = readBoundSettingValue(values, field, serverId);
    const value = boundValue !== undefined
        ? boundValue
        : field.defaultValue;
    if (typeof value === 'string') return value;
    if (typeof value === 'number') return String(value);
    if (value === undefined) return '';
    try {
        return JSON.stringify(value, null, 2);
    } catch {
        return '';
    }
}

function resolveBoundSettingMutation(params: Readonly<{
    values: SettingsValues;
    field: PluginProjectionEditableSettingField;
    serverId: string | null;
    value: unknown;
}>): Readonly<{ fieldId: string; value: unknown }> {
    const binding = params.field.presentation?.binding;
    if (binding?.kind === 'direct' && binding.settingId) {
        return { fieldId: binding.settingId, value: params.value };
    }
    if (binding?.kind !== 'perActiveServer' || !params.serverId) {
        return {
            fieldId: binding?.kind === 'perActiveServer'
                ? binding.fallbackSettingId
                : params.field.key,
            value: params.value,
        };
    }
    const rawByServer = params.values[binding.byServerIdSettingId];
    const byServer = rawByServer && typeof rawByServer === 'object' && !Array.isArray(rawByServer)
        ? { ...(rawByServer as Readonly<Record<string, unknown>>) }
        : {};
    if (typeof params.value === 'string' && params.value.trim() === '') {
        delete byServer[params.serverId];
    } else {
        byServer[params.serverId] = params.value;
    }
    return { fieldId: binding.byServerIdSettingId, value: byServer };
}

function readSwitchValue(values: SettingsValues, field: PluginProjectionEditableSettingField): boolean {
    const value = values[field.key];
    if (typeof value === 'boolean') return value;
    return field.defaultBooleanValue === true;
}

function parseTextDraft(
    field: PluginProjectionEditableSettingField,
    draft: string,
): Readonly<{ ok: true; value: unknown }> | Readonly<{ ok: false }> {
    if (field.control === 'number' || field.valueType === 'number' || field.valueType === 'integer') {
        if (draft.trim() === '' && settingSchemaAcceptsNull(field.valueSchema)) {
            return { ok: true, value: null };
        }
        const value = Number(draft);
        if (!Number.isFinite(value) || (field.valueType === 'integer' && !Number.isInteger(value))) {
            return { ok: false };
        }
        return { ok: true, value };
    }
    if (field.control === 'json' || ['object', 'array', 'null'].includes(field.valueType)) {
        try {
            return { ok: true, value: JSON.parse(draft) };
        } catch {
            return { ok: false };
        }
    }
    return { ok: true, value: draft };
}

function settingSchemaAcceptsNull(schema: PluginProjectionEditableSettingField['valueSchema']): boolean {
    if (schema.type === 'null') return true;
    return [...(schema.anyOf ?? []), ...(schema.oneOf ?? [])].some(settingSchemaAcceptsNull);
}

function localizedPresentationText(
    value: string | Readonly<{ fallback: string }> | undefined,
): string {
    return typeof value === 'string' ? value : value?.fallback ?? '';
}

function createTextDrafts(
    groups: readonly PluginProjectionEditableSettingsGroup[],
    values: SettingsValues,
    serverId: string | null = null,
): TextDrafts {
    const drafts: Record<string, TextDraft> = {};
    for (const group of groups) {
        for (const field of group.fields) {
            if (['switch', 'select', 'multiSelect'].includes(field.control)) continue;
            drafts[field.key] = {
                value: isRedactedField(field) ? '' : readTextValue(values, field, serverId),
                revision: 0,
                dirty: false,
            };
        }
    }
    return drafts;
}

function resolvePersistenceScope(props: Readonly<{
    machineId: string | null;
    serverId: string | null;
    pluginId: string;
}>): PersistenceScope | null {
    if (!props.machineId) return null;
    return {
        machineId: props.machineId,
        serverId: props.serverId,
        pluginId: props.pluginId,
    };
}

function isSamePersistenceScope(
    left: PersistenceScope | null,
    right: PersistenceScope | null,
): boolean {
    return left !== null
        && right !== null
        && left.machineId === right.machineId
        && left.serverId === right.serverId
        && left.pluginId === right.pluginId;
}

function findEditableField(
    groups: readonly PluginProjectionEditableSettingsGroup[],
    fieldKey: string,
): PluginProjectionEditableSettingField | null {
    for (const group of groups) {
        const field = group.fields.find((candidate) => candidate.key === fieldKey);
        if (field) return field;
    }
    return null;
}

function isSameFieldDeclaration(
    previous: PluginProjectionEditableSettingField,
    current: PluginProjectionEditableSettingField,
): boolean {
    if (
        previous.valueType !== current.valueType
        || previous.clearWhenEmpty !== current.clearWhenEmpty
        || isRedactedField(previous) !== isRedactedField(current)
    ) {
        return false;
    }
    return previous.control === current.control;
}

function reconcileTextDrafts(
    groups: readonly PluginProjectionEditableSettingsGroup[],
    values: SettingsValues,
    current: TextDrafts,
    previousGroups: readonly PluginProjectionEditableSettingsGroup[],
    protectedFieldKeys: ReadonlySet<string>,
    serverId: string | null,
): TextDrafts {
    const next = { ...createTextDrafts(groups, values, serverId) };
    for (const group of groups) {
        for (const field of group.fields) {
            if (['switch', 'select', 'multiSelect'].includes(field.control)) continue;
            const activeDraft = current[field.key];
            const previousField = findEditableField(previousGroups, field.key);
            if (
                activeDraft
                && previousField
                && !['switch', 'select', 'multiSelect'].includes(previousField.control)
                && isSameFieldDeclaration(previousField, field)
                && (activeDraft.dirty || protectedFieldKeys.has(field.key))
            ) {
                next[field.key] = activeDraft;
            }
        }
    }
    return next;
}

function replaceSnapshotPreservingFields(
    current: SettingsValues,
    snapshotValues: SettingsValues,
    protectedFieldKeys: ReadonlySet<string>,
): SettingsValues {
    if (protectedFieldKeys.size === 0) return snapshotValues;
    const next: Record<string, unknown> = { ...snapshotValues };
    for (const fieldKey of protectedFieldKeys) {
        if (Object.prototype.hasOwnProperty.call(current, fieldKey)) {
            next[fieldKey] = current[fieldKey];
        } else {
            delete next[fieldKey];
        }
    }
    return next;
}

function withoutRecordKey<T>(
    record: Readonly<Record<string, T>>,
    key: string,
): Readonly<Record<string, T>> {
    if (!Object.prototype.hasOwnProperty.call(record, key)) return record;
    const next = { ...record };
    delete next[key];
    return next;
}

function withoutRecordKeys<T>(
    record: Readonly<Record<string, T>>,
    keys: ReadonlySet<string>,
): Readonly<Record<string, T>> {
    if (keys.size === 0) return record;
    let next: Record<string, T> | null = null;
    for (const key of keys) {
        if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
        next ??= { ...record };
        delete next[key];
    }
    return next ?? record;
}

function applyFieldSnapshot(
    values: SettingsValues,
    snapshotValues: SettingsValues,
    fieldKey: string,
): SettingsValues {
    if (Object.prototype.hasOwnProperty.call(snapshotValues, fieldKey)) {
        return { ...values, [fieldKey]: snapshotValues[fieldKey] };
    }
    if (!Object.prototype.hasOwnProperty.call(values, fieldKey)) return values;
    const next = { ...values };
    delete next[fieldKey];
    return next;
}

function PluginSettingTextField(props: Readonly<{
    pluginId: string;
    group: PluginProjectionEditableSettingsGroup;
    field: PluginProjectionEditableSettingField;
    value: string;
    dirty: boolean;
    saving: boolean;
    saveFailed: boolean;
    persistenceDisabled: boolean;
    onChangeText: (value: string) => void;
    onCommit: () => void;
}>) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const isSecret = isRedactedField(props.field);
    const multiline = props.field.control === 'textarea';
    const minimumInteractiveTargetSize = resolveMinimumInteractiveTargetSize(Platform.OS);
    const testID = `settings.plugins.detail.${props.pluginId}.settings.${props.group.id}.${props.field.key}.input`;
    const saveLabel = t(props.saveFailed ? 'common.retry' : 'common.save');

    return (
        <View testID={`${testID}.row`} style={styles.fieldContainer}>
            <Text style={styles.fieldLabel}>{props.field.title}</Text>
            {props.field.subtitle ? <Text style={styles.fieldHint}>{props.field.subtitle}</Text> : null}
            <TextInput
                testID={testID}
                accessibilityLabel={props.field.title}
                value={props.value}
                onChangeText={props.onChangeText}
                editable={!props.persistenceDisabled}
                secureTextEntry={isSecret}
                multiline={multiline}
                autoCapitalize="none"
                autoCorrect={false}
                placeholderTextColor={theme.colors.input.placeholder}
                style={[
                    styles.textInput,
                    multiline ? styles.textAreaInput : undefined,
                    { minHeight: minimumInteractiveTargetSize },
                    {
                        color: theme.colors.input.text,
                        backgroundColor: theme.colors.input.background,
                        borderColor: theme.colors.border.default,
                    },
                ]}
            />
            <View style={styles.fieldActions}>
                <RoundButton
                    testID={`settings.plugins.detail.${props.pluginId}.settings.${props.group.id}.${props.field.key}.save`}
                    size="normal"
                    title={saveLabel}
                    accessibilityLabel={`${saveLabel}: ${props.field.title}`}
                    style={styles.saveButton}
                    disabled={!props.dirty || props.saving || props.persistenceDisabled}
                    loading={props.saving}
                    onPress={props.onCommit}
                />
            </View>
        </View>
    );
}

function PluginSettingMultiSelectField(props: Readonly<{
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
                const optionId = JSON.stringify(option.value);
                const selected = selectedIds.has(optionId);
                return (
                    <Item
                        key={optionId}
                        title={localizedPresentationText(option.title)}
                        subtitle={localizedPresentationText(option.description) || undefined}
                        icon={<Ionicons name="options-outline" size={29} color={theme.colors.text.secondary} />}
                        rightElement={(
                            <Switch
                                value={selected}
                                disabled={props.disabled}
                                accessibilityLabel={localizedPresentationText(option.title)}
                                onValueChange={() => {
                                    const next = selected
                                        ? selectedValues.filter((value) => JSON.stringify(value) !== optionId)
                                        : [...selectedValues, option.value];
                                    props.onChangeValue(next);
                                }}
                            />
                        )}
                        rightElementOutsidePressable
                        showChevron={false}
                        disabled={props.disabled}
                        onPress={() => {
                            const next = selected
                                ? selectedValues.filter((value) => JSON.stringify(value) !== optionId)
                                : [...selectedValues, option.value];
                            props.onChangeValue(next);
                        }}
                    />
                );
            })}
        </>
    );
}

export function PluginDetailGenericSettingsSection(props: Readonly<{
    pluginId: string;
    projection: PluginProjectionEntry | null;
    machineId: string | null;
    serverId: string | null;
    daemonOperationsAvailable: boolean;
    policyContext?: PluginUiPolicyEvaluationContext;
}>) {
    const { theme } = useUnistyles();
    const router = useRouter();
    const groups = props.projection?.editableSettingsGroups ?? EMPTY_EDITABLE_SETTINGS_GROUPS;
    const sortedGroups = React.useMemo(() => [...groups].sort(compareSettingsGroups), [groups]);
    const persistenceScope = React.useMemo(() => resolvePersistenceScope(props), [
        props.machineId,
        props.pluginId,
        props.serverId,
    ]);
    const [loading, setLoading] = React.useState(false);
    const [loadError, setLoadError] = React.useState<string | null>(null);
    const [hydratedPersistenceScope, setHydratedPersistenceScope] = React.useState<PersistenceScope | null>(null);
    const [values, setValues] = React.useState<SettingsValues>({});
    const [settingsRevision, setSettingsRevision] = React.useState<string | null>(null);
    const [textDraftByKey, setTextDraftByKey] = React.useState<TextDrafts>({});
    const [switchDraftByKey, setSwitchDraftByKey] = React.useState<Readonly<Record<string, boolean>>>({});
    const [savingByKey, setSavingByKey] = React.useState<Readonly<Record<string, boolean>>>({});
    const [saveErrorByKey, setSaveErrorByKey] = React.useState<Readonly<Record<string, boolean>>>({});
    const visibleGroups = React.useMemo(() => sortedGroups.flatMap((group) => {
        const visibleFields = group.fields.filter((field) => (
            field.presentation?.hidden !== true
            && evaluatePluginUiPolicy(
                { availability: field.availability },
                { ...props.policyContext, data: values },
            ).visible
        ));
        if (group.presentation.sections.length === 0) {
            return [{ ...group, fields: visibleFields }];
        }
        const fieldById = new Map(visibleFields.map((field) => [field.key, field] as const));
        return group.presentation.sections.map((section) => ({
            ...group,
            id: `${group.id}/${section.id}`,
            title: localizedPresentationText(section.title),
            description: localizedPresentationText(section.description) || null,
            fields: section.fields.flatMap((fieldId) => {
                const field = fieldById.get(fieldId);
                return field ? [field] : [];
            }),
        }));
    }), [props.policyContext, sortedGroups, values]);
    const loadGenerationRef = React.useRef(0);
    const activeLoadGenerationRef = React.useRef<number | null>(null);
    const nextOperationIdRef = React.useRef(0);
    const nextDeclarationEpochRef = React.useRef(0);
    const declarationEpochByKeyRef = React.useRef(new Map<string, number>());
    const inFlightOperationByKeyRef = React.useRef(new Map<string, InFlightFieldOperation>());
    const mountedRef = React.useRef(true);
    const currentPersistenceScopeRef = React.useRef<PersistenceScope | null>(persistenceScope);
    const currentGroupsRef = React.useRef<readonly PluginProjectionEditableSettingsGroup[]>(sortedGroups);
    const currentTextDraftByKeyRef = React.useRef<TextDrafts>(textDraftByKey);
    const currentValuesRef = React.useRef<SettingsValues>(values);
    const settingsRevisionRef = React.useRef<string | null>(settingsRevision);
    const daemonOperationsAvailableRef = React.useRef(props.daemonOperationsAvailable);
    const effectPersistenceScopeRef = React.useRef<PersistenceScope | null>(null);
    const effectGroupsRef = React.useRef<readonly PluginProjectionEditableSettingsGroup[]>(
        EMPTY_EDITABLE_SETTINGS_GROUPS,
    );
    currentPersistenceScopeRef.current = persistenceScope;
    currentGroupsRef.current = sortedGroups;
    currentTextDraftByKeyRef.current = textDraftByKey;
    currentValuesRef.current = values;
    settingsRevisionRef.current = settingsRevision;
    daemonOperationsAvailableRef.current = props.daemonOperationsAvailable;

    React.useLayoutEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
            currentPersistenceScopeRef.current = null;
            activeLoadGenerationRef.current = null;
            declarationEpochByKeyRef.current.clear();
            inFlightOperationByKeyRef.current.clear();
        };
    }, []);

    React.useLayoutEffect(() => {
        const previousPersistenceScope = effectPersistenceScopeRef.current;
        const samePersistenceScope = isSamePersistenceScope(previousPersistenceScope, persistenceScope);
        const previousGroups = effectGroupsRef.current;
        effectPersistenceScopeRef.current = persistenceScope;
        effectGroupsRef.current = sortedGroups;

        const invalidatedFieldKeys = new Set<string>();
        if (!samePersistenceScope) {
            declarationEpochByKeyRef.current.clear();
            for (const group of sortedGroups) {
                for (const field of group.fields) {
                    const nextEpoch = nextDeclarationEpochRef.current + 1;
                    nextDeclarationEpochRef.current = nextEpoch;
                    declarationEpochByKeyRef.current.set(field.key, nextEpoch);
                }
            }
        } else {
            const fieldKeys = new Set<string>();
            for (const group of previousGroups) {
                for (const field of group.fields) fieldKeys.add(field.key);
            }
            for (const group of sortedGroups) {
                for (const field of group.fields) fieldKeys.add(field.key);
            }
            for (const fieldKey of fieldKeys) {
                const previousField = findEditableField(previousGroups, fieldKey);
                const currentField = findEditableField(sortedGroups, fieldKey);
                const existingEpoch = declarationEpochByKeyRef.current.get(fieldKey);
                if (
                    previousField
                    && currentField
                    && existingEpoch !== undefined
                    && isSameFieldDeclaration(previousField, currentField)
                ) {
                    continue;
                }
                if (previousField || existingEpoch !== undefined) {
                    invalidatedFieldKeys.add(fieldKey);
                }
                if (currentField) {
                    const nextEpoch = nextDeclarationEpochRef.current + 1;
                    nextDeclarationEpochRef.current = nextEpoch;
                    declarationEpochByKeyRef.current.set(fieldKey, nextEpoch);
                } else {
                    declarationEpochByKeyRef.current.delete(fieldKey);
                }
            }
        }

        const loadGeneration = loadGenerationRef.current + 1;
        loadGenerationRef.current = loadGeneration;
        if (!samePersistenceScope) {
            inFlightOperationByKeyRef.current.clear();
            setHydratedPersistenceScope(null);
            setValues({});
            setSettingsRevision(null);
            setTextDraftByKey({});
            setSwitchDraftByKey({});
            setSavingByKey({});
            setSaveErrorByKey({});
        } else if (invalidatedFieldKeys.size > 0) {
            for (const fieldKey of invalidatedFieldKeys) {
                inFlightOperationByKeyRef.current.delete(fieldKey);
            }
            setValues((current) => withoutRecordKeys(current, invalidatedFieldKeys));
            setTextDraftByKey((current) => withoutRecordKeys(current, invalidatedFieldKeys));
            setSwitchDraftByKey((current) => withoutRecordKeys(current, invalidatedFieldKeys));
            setSavingByKey((current) => withoutRecordKeys(current, invalidatedFieldKeys));
            setSaveErrorByKey((current) => withoutRecordKeys(current, invalidatedFieldKeys));
        }
        setLoadError(null);
        if (!persistenceScope || sortedGroups.length === 0 || !props.daemonOperationsAvailable) {
            if (!props.daemonOperationsAvailable) {
                inFlightOperationByKeyRef.current.clear();
                setSwitchDraftByKey({});
                setSavingByKey({});
            }
            activeLoadGenerationRef.current = null;
            if (sortedGroups.length === 0) setHydratedPersistenceScope(null);
            setLoading(false);
            return () => {
                if (loadGenerationRef.current === loadGeneration) {
                    loadGenerationRef.current += 1;
                }
            };
        }

        const protectedFieldKeys = samePersistenceScope
            ? new Set(inFlightOperationByKeyRef.current.keys())
            : new Set<string>();
        let active = true;
        activeLoadGenerationRef.current = loadGeneration;
        setLoading(true);
        void (async () => {
            const result = await machinePluginSettingsGet(persistenceScope.machineId, {
                serverId: persistenceScope.serverId,
                pluginId: persistenceScope.pluginId,
            });
            if (!active || loadGenerationRef.current !== loadGeneration) return;
            activeLoadGenerationRef.current = null;
            if (result.supported) {
                const snapshotValues = sanitizeSnapshotValues(sortedGroups, result);
                setValues((current) => samePersistenceScope
                    ? replaceSnapshotPreservingFields(current, snapshotValues, protectedFieldKeys)
                    : snapshotValues);
                setTextDraftByKey((current) => samePersistenceScope
                    ? reconcileTextDrafts(
                        sortedGroups,
                        snapshotValues,
                        current,
                        previousGroups,
                        protectedFieldKeys,
                        props.serverId,
                    )
                    : createTextDrafts(sortedGroups, snapshotValues, props.serverId));
                setHydratedPersistenceScope(persistenceScope);
                setSettingsRevision(result.snapshot.revision);
                setLoadError(null);
            } else {
                setLoadError(t('settingsPlugins.genericSettingsLoadError'));
            }
            setLoading(false);
        })();
        return () => {
            active = false;
            if (activeLoadGenerationRef.current === loadGeneration) {
                activeLoadGenerationRef.current = null;
            }
            if (loadGenerationRef.current === loadGeneration) {
                loadGenerationRef.current += 1;
            }
        };
    }, [persistenceScope, props.daemonOperationsAvailable, props.projection, sortedGroups]);

    const commitSetting = React.useCallback((
        field: PluginProjectionEditableSettingField,
        value: unknown,
        commit: FieldCommit,
        declarationEpoch: number | null,
    ) => {
        const requestScope = persistenceScope;
        if (
            !requestScope
            || !daemonOperationsAvailableRef.current
            || declarationEpoch === null
            || activeLoadGenerationRef.current !== null
            || declarationEpochByKeyRef.current.get(field.key) !== declarationEpoch
            || inFlightOperationByKeyRef.current.has(field.key)
        ) {
            return;
        }

        const operationId = nextOperationIdRef.current + 1;
        nextOperationIdRef.current = operationId;
        const operation: InFlightFieldOperation = { id: operationId, declarationEpoch };
        inFlightOperationByKeyRef.current.set(field.key, operation);
        setSavingByKey((current) => ({ ...current, [field.key]: true }));
        setSaveErrorByKey((current) => withoutRecordKey(current, field.key));

        void (async () => {
            const previousValue = readBoundSettingValue(
                currentValuesRef.current,
                field,
                requestScope.serverId,
            );
            const mutation = resolveBoundSettingMutation({
                values: currentValuesRef.current,
                field,
                serverId: requestScope.serverId,
                value,
            });
            const result = await machinePluginSettingsSet(requestScope.machineId, {
                serverId: requestScope.serverId,
                pluginId: requestScope.pluginId,
                fieldId: mutation.fieldId,
                value: mutation.value,
                ...(settingsRevisionRef.current ? { expectedRevision: settingsRevisionRef.current } : {}),
            });
            const activeOperation = inFlightOperationByKeyRef.current.get(field.key);
            if (
                !mountedRef.current
                || !isSamePersistenceScope(currentPersistenceScopeRef.current, requestScope)
                || declarationEpochByKeyRef.current.get(field.key) !== declarationEpoch
                || activeOperation?.id !== operationId
                || activeOperation?.declarationEpoch !== declarationEpoch
            ) {
                return;
            }

            inFlightOperationByKeyRef.current.delete(field.key);
            setSavingByKey((current) => withoutRecordKey(current, field.key));
            const currentField = findEditableField(currentGroupsRef.current, field.key);
            const fieldStillMatchesCommit = currentField !== null && (
                commit.kind === 'switch'
                    ? currentField.control === 'switch'
                    : commit.kind === 'direct'
                        ? currentField.control === 'select' || currentField.control === 'multiSelect'
                        : !['switch', 'select', 'multiSelect'].includes(currentField.control)
            );
            if (!currentField || !fieldStillMatchesCommit) {
                setSwitchDraftByKey((current) => withoutRecordKey(current, field.key));
                setSaveErrorByKey((current) => withoutRecordKey(current, field.key));
                return;
            }
            if (!result.supported) {
                let belongsToCurrentDraft = true;
                if (commit.kind === 'switch') {
                    setSwitchDraftByKey((current) => withoutRecordKey(current, field.key));
                } else if (commit.kind === 'text') {
                    const activeDraft = currentTextDraftByKeyRef.current[field.key];
                    if (
                        !activeDraft
                        || activeDraft.revision !== commit.draft.revision
                        || activeDraft.value !== commit.draft.value
                    ) {
                        belongsToCurrentDraft = false;
                    }
                }
                if (belongsToCurrentDraft) {
                    setSaveErrorByKey((current) => ({ ...current, [field.key]: true }));
                }
                const refreshed = await machinePluginSettingsGet(requestScope.machineId, {
                    serverId: requestScope.serverId,
                    pluginId: requestScope.pluginId,
                });
                if (
                    refreshed.supported
                    && mountedRef.current
                    && isSamePersistenceScope(currentPersistenceScopeRef.current, requestScope)
                    && declarationEpochByKeyRef.current.get(field.key) === declarationEpoch
                ) {
                    const refreshedValues = sanitizeSnapshotValues(currentGroupsRef.current, refreshed);
                    setValues(refreshedValues);
                    setSettingsRevision(refreshed.snapshot.revision);
                }
                return;
            }

            const snapshotValues = sanitizeSnapshotValues(currentGroupsRef.current, result);
            emitPluginSettingChangedEvent({
                previousValue,
                nextValue: readBoundSettingValue(snapshotValues, currentField, requestScope.serverId),
                field: currentField,
            });
            setSettingsRevision(result.snapshot.revision);
            setValues((current) => applyFieldSnapshot(current, snapshotValues, mutation.fieldId));
            setSaveErrorByKey((current) => withoutRecordKey(current, field.key));
            if (commit.kind === 'switch') {
                setSwitchDraftByKey((current) => withoutRecordKey(current, field.key));
                return;
            }
            if (commit.kind === 'direct') return;

            setTextDraftByKey((current) => {
                const activeDraft = current[field.key];
                if (
                    !activeDraft
                    || activeDraft.revision !== commit.draft.revision
                    || activeDraft.value !== commit.draft.value
                ) {
                    return current;
                }
                return {
                    ...current,
                    [field.key]: {
                        value: isRedactedField(currentField)
                            ? ''
                            : readTextValue(snapshotValues, currentField, props.serverId),
                        revision: activeDraft.revision,
                        dirty: false,
                    },
                };
            });
        })();
    }, [persistenceScope]);

    const handleTextChange = React.useCallback((field: PluginProjectionEditableSettingField, value: string) => {
        if (!daemonOperationsAvailableRef.current) return;
        const activeDraft = currentTextDraftByKeyRef.current[field.key] ?? {
            value: '',
            revision: 0,
            dirty: false,
        };
        const nextDraft: TextDraft = {
            value,
            revision: activeDraft.revision + 1,
            dirty: true,
        };
        currentTextDraftByKeyRef.current = {
            ...currentTextDraftByKeyRef.current,
            [field.key]: nextDraft,
        };
        setTextDraftByKey((current) => {
            return {
                ...current,
                [field.key]: nextDraft,
            };
        });
        setSaveErrorByKey((current) => withoutRecordKey(current, field.key));
    }, []);

    const handleSwitchChange = React.useCallback((
        field: PluginProjectionEditableSettingField,
        value: boolean,
        declarationEpoch: number | null,
    ) => {
        if (
            !daemonOperationsAvailableRef.current
            ||
            declarationEpoch === null
            || activeLoadGenerationRef.current !== null
            || declarationEpochByKeyRef.current.get(field.key) !== declarationEpoch
            || inFlightOperationByKeyRef.current.has(field.key)
        ) {
            return;
        }
        setSwitchDraftByKey((current) => ({ ...current, [field.key]: value }));
        commitSetting(field, value, { kind: 'switch' }, declarationEpoch);
    }, [commitSetting]);

    const hasHydratedCurrentScope = isSamePersistenceScope(hydratedPersistenceScope, persistenceScope);

    if (sortedGroups.length === 0) {
        return null;
    }

    if (!props.machineId) {
        return (
            <ItemGroup title={t('settingsPlugins.genericSettingsTitle')}>
                <Item
                    testID={`settings.plugins.detail.${props.pluginId}.settings.unavailable`}
                    title={t('settingsPlugins.genericSettingsUnavailable')}
                    icon={<Ionicons name="cloud-offline-outline" size={29} color={theme.colors.text.secondary} />}
                    showChevron={false}
                    mode="info"
                />
            </ItemGroup>
        );
    }

    if (loading && !hasHydratedCurrentScope) {
        return (
            <ItemGroup title={t('settingsPlugins.genericSettingsTitle')}>
                <Item
                    testID={`settings.plugins.detail.${props.pluginId}.settings.loading`}
                    title={t('settingsPlugins.genericSettingsLoading')}
                    icon={<Ionicons name="sync-outline" size={29} color={theme.colors.text.secondary} />}
                    showChevron={false}
                    mode="info"
                />
            </ItemGroup>
        );
    }

    if (loadError && !hasHydratedCurrentScope) {
        return (
            <ItemGroup title={t('settingsPlugins.genericSettingsTitle')}>
                <Item
                    testID={`settings.plugins.detail.${props.pluginId}.settings.error`}
                    title={loadError}
                    icon={<Ionicons name="alert-circle-outline" size={29} color={theme.colors.state.danger.foreground} />}
                    showChevron={false}
                    mode="info"
                />
            </ItemGroup>
        );
    }

    return (
        <>
            {visibleGroups.map((group, groupIndex) => {
                const fields = [...group.fields].sort(compareSettingsFields);
                const groupHasSaveError = fields.some((field) => saveErrorByKey[field.key] === true);
                return (
                    <ItemGroup
                        key={group.id}
                        title={group.title}
                        footer={groupHasSaveError
                            ? t('settingsPlugins.genericSettingsSaveError')
                            : group.description ?? t('settingsPlugins.genericSettingsFooter')}
                    >
                        {groupIndex === 0 && loadError ? (
                            <Item
                                testID={`settings.plugins.detail.${props.pluginId}.settings.error`}
                                title={loadError}
                                icon={<Ionicons name="alert-circle-outline" size={29} color={theme.colors.state.danger.foreground} />}
                                showChevron={false}
                                mode="info"
                            />
                        ) : null}
                        {fields.length === 0 ? (
                            <Item
                                testID={`settings.plugins.detail.${props.pluginId}.settings.${group.id}.empty`}
                                title={t('settingsPlugins.genericSettingsEmpty')}
                                icon={<Ionicons name="options-outline" size={29} color={theme.colors.text.secondary} />}
                                showChevron={false}
                                mode="info"
                            />
                        ) : fields.map((field) => {
                            const policy = evaluatePluginUiPolicy(
                                { availability: field.availability },
                                { ...props.policyContext, data: values },
                            );
                            if (field.control === 'switch') {
                                const hasSwitchDraft = Object.prototype.hasOwnProperty.call(switchDraftByKey, field.key);
                                const declarationEpoch = declarationEpochByKeyRef.current.get(field.key) ?? null;
                                return (
                                    <PluginSettingSwitchField
                                        key={field.key}
                                        pluginId={props.pluginId}
                                        group={group}
                                        field={field}
                                        value={hasSwitchDraft ? switchDraftByKey[field.key]! : readSwitchValue(values, field)}
                                        disabled={!policy.enabled || !props.daemonOperationsAvailable || loading || savingByKey[field.key] === true}
                                        onChangeValue={(changedField, value) => {
                                            handleSwitchChange(changedField, value, declarationEpoch);
                                        }}
                                    />
                                );
                            }
                            if (field.control === 'select' || field.control === 'multiSelect') {
                                const declarationEpoch = declarationEpochByKeyRef.current.get(field.key) ?? null;
                                const value = Object.prototype.hasOwnProperty.call(values, field.key)
                                    ? values[field.key]
                                    : field.defaultValue;
                                const disabled = !props.daemonOperationsAvailable
                                    || !policy.enabled
                                    || loading
                                    || savingByKey[field.key] === true;
                                return field.control === 'select' ? (
                                    <PluginSettingSelectField
                                        key={field.key}
                                        pluginId={props.pluginId}
                                        group={group}
                                        field={field}
                                        value={value}
                                        disabled={disabled}
                                        onChangeValue={(nextValue) => commitSetting(
                                            field,
                                            nextValue,
                                            { kind: 'direct' },
                                            declarationEpoch,
                                        )}
                                    />
                                ) : (
                                    <PluginSettingMultiSelectField
                                        key={field.key}
                                        pluginId={props.pluginId}
                                        group={group}
                                        field={field}
                                        value={value}
                                        disabled={disabled}
                                        onChangeValue={(nextValue) => commitSetting(
                                            field,
                                            nextValue,
                                            { kind: 'direct' },
                                            declarationEpoch,
                                        )}
                                    />
                                );
                            }
                            const draft = textDraftByKey[field.key] ?? {
                                value: isRedactedField(field) ? '' : readTextValue(values, field, props.serverId),
                                revision: 0,
                                dirty: false,
                            };
                            const declarationEpoch = declarationEpochByKeyRef.current.get(field.key) ?? null;
                            return (
                                <PluginSettingTextField
                                    key={field.key}
                                    pluginId={props.pluginId}
                                    group={group}
                                    field={field}
                                    value={draft.value}
                                    dirty={draft.dirty}
                                    saving={savingByKey[field.key] === true}
                                    saveFailed={saveErrorByKey[field.key] === true}
                                    persistenceDisabled={!policy.enabled || !props.daemonOperationsAvailable || loading}
                                    onChangeText={(value) => handleTextChange(field, value)}
                                    onCommit={() => {
                                        const parsed = parseTextDraft(field, draft.value);
                                        if (!parsed.ok) {
                                            setSaveErrorByKey((current) => ({ ...current, [field.key]: true }));
                                            return;
                                        }
                                        commitSetting(
                                            field,
                                            parsed.value,
                                            { kind: 'text', draft },
                                            declarationEpoch,
                                        );
                                    }}
                                />
                            );
                        })}
                    </ItemGroup>
                );
            })}
            {sortedGroups.flatMap((group) => group.presentation.subagentSections.map((section) => (
                <ItemGroup
                    key={`${group.id}/subagents/${section.id}`}
                    title={localizedPresentationText(section.title)}
                    footer={localizedPresentationText(section.description) || undefined}
                >
                    {section.items.map((item) => (
                        <Item
                            key={item.id}
                            title={localizedPresentationText(item.title)}
                            subtitle={localizedPresentationText(item.description) || undefined}
                            icon={(
                                <Ionicons
                                    name={(item.iconIonName ?? 'git-branch-outline') as never}
                                    size={29}
                                    color={theme.colors.text.secondary}
                                />
                            )}
                            onPress={() => router.push(item.route as never)}
                        />
                    ))}
                </ItemGroup>
            )))}
        </>
    );
}
