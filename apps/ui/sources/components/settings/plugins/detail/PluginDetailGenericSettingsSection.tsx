import * as React from 'react';
import { Platform, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useRouter } from 'expo-router';

import { createPluginAgentSettingsRoute } from '@/agents/catalog/agentSettingsRoutes';
import { readManagedServiceEndpointUrl } from '@happier-dev/protocol';
import type { PluginPortableReleaseManifestV1 } from '@happier-dev/protocol/plugins/availability';

import type {
    PluginProjectionEditableSettingField,
    PluginProjectionEditableSettingsGroup,
    PluginProjectionEntry,
} from '@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { SavedSecretPickerModal } from '@/components/ui/forms/valueRefs/SavedSecretPickerModal';
import { Switch } from '@/components/ui/forms/Switch';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Text, TextInput } from '@/components/ui/text/Text';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { t } from '@/text';
import { projectAccountDeclaredPluginSettingsGroups } from '@/sync/domains/plugins/settings/accountDeclaredPluginSettings';
import {
    resolveScopedPluginSettingsTarget,
    type ScopedPluginSettingsAccountTarget,
    type ScopedPluginSettingsDaemonTarget,
    type ScopedPluginSettingsMutation,
    type ScopedPluginSettingsScope,
    type ScopedPluginSettingsTarget,
} from '@/sync/domains/plugins/settings/scopedPluginSettingsAdapter';
import {
    createScopedPluginSettingsSetMutation,
    projectScopedPluginSettingsField,
    projectScopedPluginSettingsFields,
    readScopedPluginSettingsDeclaredFieldValue,
    resolveScopedPluginSettingsDeclaredFieldMutation,
    scopedPluginSettingsFieldDeclarationIdentity,
    type ScopedPluginSettingsFieldModel,
    useScopedPluginSettingsProjection,
} from '@/sync/domains/plugins/settings/scopedPluginSettingsProjection';
import {
    scopedPluginAccountSecretSettingsAdapter,
    scopedPluginSettingsAdapter,
} from '@/sync/domains/plugins/settings/scopedPluginSettingsRuntime';
import {
    captureActiveServerAccountScopeLifetime,
    type ActiveServerAccountScopeLifetime,
} from '@/sync/domains/scope/activeServerAccountScope';
import {
    evaluatePluginUiPolicy,
    type PluginUiPolicyEvaluationContext,
} from '@/sync/domains/plugins/ui/policy/evaluate';
import { emitPluginSettingChangedEvent } from '@/track/settingsAnalytics/emitPluginSettingChangedEvent';
import { Icon } from '@/components/ui/icons/Icon';
import {
    PluginSettingMultiSelectField,
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
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 8,
        justifyContent: 'flex-end',
        marginTop: 8,
    },
    secretStatus: {
        ...Typography.default(),
        color: theme.colors.text.secondary,
        fontSize: 13,
        marginTop: 8,
    },
    fieldError: {
        ...Typography.default(),
        color: theme.colors.state.danger.foreground,
        fontSize: 13,
        marginTop: 8,
    },
    saveButton: {
        minWidth: 96,
    },
}));

const ACCOUNT_PLUGIN_SETTINGS_SCOPE: ScopedPluginSettingsScope = Object.freeze({ kind: 'account' });
const DAEMON_PLUGIN_SETTINGS_SCOPE: ScopedPluginSettingsScope = Object.freeze({ kind: 'daemon' });

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

function isAccountSavedSecretField(field: PluginProjectionEditableSettingField): boolean {
    return field.secretCustody === 'account';
}

function isDaemonCustodiedSecretField(field: PluginProjectionEditableSettingField): boolean {
    return field.secretCustody === 'daemon';
}

/**
 * A raw secret draft belongs to one current daemon generation or one current
 * Account-release declaration. A legacy projection without an immutable
 * generation still retains its declared numeric/label generation when one is
 * available; field-declaration identity supplies the remaining local fence.
 */
function settingsSourceLifetimeIdentity(params: Readonly<{
    projection: PluginProjectionEntry | null;
    accountSettingsDeclaration: PluginPortableReleaseManifestV1 | null | undefined;
}>): string {
    const projection = params.projection;
    if (projection) {
        if (typeof projection.immutableGenerationId === 'string') {
            return `daemon-generation:${projection.immutableGenerationId}`;
        }
        if (typeof projection.generation === 'number') {
            return `daemon-generation:${projection.generation}`;
        }
        if (projection.generationLabel !== null) {
            return `daemon-generation-label:${projection.generationLabel}`;
        }
        return 'daemon-generation:unavailable';
    }
    const declaration = params.accountSettingsDeclaration;
    return declaration
        ? `account-declaration:${declaration.id}@${declaration.version}`
        : 'account-declaration:unavailable';
}

function localizedPresentationText(
    value: string | Readonly<{ fallback: string }> | undefined,
): string {
    return typeof value === 'string' ? value : value?.fallback ?? '';
}

export function PluginSettingTextField(props: Readonly<{
    pluginId: string;
    group: PluginProjectionEditableSettingsGroup;
    field: PluginProjectionEditableSettingField;
    value: string;
    dirty: boolean;
    saving: boolean;
    saveFailed: boolean;
    persistenceDisabled: boolean;
    /**
     * A queued text event may safely update a presentation-local draft after
     * Save has disabled the visible control. Unavailable/loading controls
     * remain fully inert.
     */
    acceptDraftInputWhileBusy?: boolean;
    /** Another mutation is authoritative; preserve the editable local draft but block its submit. */
    commitDisabled?: boolean;
    onChangeText: (value: string) => void;
    onCommit: () => void;
    /** Account SavedSecret deletion is always an explicit user action. */
    onDelete?: () => void;
    /** Binds a host-private existing SavedSecret without projecting its id. */
    onBindExisting?: () => void;
    /** Removes only the current binding; it preserves the SavedSecret record. */
    onUnbind?: () => void;
    /** Safe presence state only; the SavedSecret value never reaches the control. */
    status?: string | null;
    /** A safe field-local mutation status; never interpolate raw draft bytes. */
    errorMessage?: string | null;
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
                accessibilityHint={props.status ?? undefined}
                value={props.value}
                onChangeText={(value) => {
                    // Native controls ignore input while non-editable, but
                    // keep the same invariant at this presentation boundary
                    // for programmatic and web event paths as well.
                    if (!props.persistenceDisabled || props.acceptDraftInputWhileBusy) {
                        props.onChangeText(value);
                    }
                }}
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
            {props.status ? (
                <Text
                    testID={`settings.plugins.detail.${props.pluginId}.settings.${props.group.id}.${props.field.key}.status`}
                    style={styles.secretStatus}
                >
                    {props.status}
                </Text>
            ) : null}
            {props.errorMessage ? (
                <Text
                    testID={`settings.plugins.detail.${props.pluginId}.settings.${props.group.id}.${props.field.key}.error`}
                    style={styles.fieldError}
                >
                    {props.errorMessage}
                </Text>
            ) : null}
            <View style={styles.fieldActions}>
                {props.onDelete ? (
                    <RoundButton
                        testID={`settings.plugins.detail.${props.pluginId}.settings.${props.group.id}.${props.field.key}.delete`}
                        size="normal"
                        display="inverted"
                        title={t('common.delete')}
                        accessibilityLabel={`${t('common.delete')}: ${props.field.title}`}
                        textStyle={{ color: theme.colors.state.danger.foreground }}
                        disabled={props.saving || props.persistenceDisabled}
                        onPress={props.onDelete}
                    />
                ) : null}
                {props.onUnbind ? (
                    <RoundButton
                        testID={`settings.plugins.detail.${props.pluginId}.settings.${props.group.id}.${props.field.key}.unbind`}
                        size="normal"
                        display="inverted"
                        title={t('common.remove')}
                        accessibilityLabel={`${t('common.remove')}: ${props.field.title}`}
                        disabled={props.saving || props.persistenceDisabled}
                        onPress={props.onUnbind}
                    />
                ) : null}
                {props.onBindExisting ? (
                    <RoundButton
                        testID={`settings.plugins.detail.${props.pluginId}.settings.${props.group.id}.${props.field.key}.bind`}
                        size="normal"
                        display="inverted"
                        title={t('settings.mcpServersImportMappingSavedSecret')}
                        accessibilityLabel={`${t('settings.mcpServersImportMappingSavedSecret')}: ${props.field.title}`}
                        disabled={props.saving || props.persistenceDisabled}
                        onPress={props.onBindExisting}
                    />
                ) : null}
                <RoundButton
                    testID={`settings.plugins.detail.${props.pluginId}.settings.${props.group.id}.${props.field.key}.save`}
                    size="normal"
                    title={saveLabel}
                    accessibilityLabel={`${saveLabel}: ${props.field.title}`}
                    style={styles.saveButton}
                    disabled={!props.dirty || props.saving || props.persistenceDisabled || props.commitDisabled}
                    loading={props.saving}
                    onPress={props.onCommit}
                />
            </View>
        </View>
    );
}

/**
 * Account-redacted declarative Settings have a different persistence owner
 * than ordinary Account plugin-record fields. This control is deliberately
 * presentation-only: its adapter projects configured/missing state, never a
 * raw SavedSecret value, and owns the Account Settings CAS mutation beneath it.
 */
function PluginSettingAccountSecretField(props: Readonly<{
    pluginId: string;
    group: PluginProjectionEditableSettingsGroup;
    field: PluginProjectionEditableSettingField;
    target: ScopedPluginSettingsAccountTarget | null;
    accountLifetime: ActiveServerAccountScopeLifetime | null;
    enabled: boolean;
    /** Current generation/declaration boundary for presentation-local bytes. */
    lifetimeIdentity: string;
}>) {
    const secretField = React.useMemo(() => projectScopedPluginSettingsField(props.field), [props.field]);
    const secretFields = React.useMemo(() => [secretField], [secretField]);
    const secretSettings = useScopedPluginSettingsProjection({
        pluginId: props.pluginId,
        scope: ACCOUNT_PLUGIN_SETTINGS_SCOPE,
        target: props.target,
        accountLifetime: props.accountLifetime,
        fields: secretFields,
        sourceLifetimeIdentity: props.lifetimeIdentity,
        perActiveServerIdentityId: null,
        enabled: props.enabled,
        adapter: scopedPluginAccountSecretSettingsAdapter,
    });
    const revision = secretSettings.state.revision?.kind === 'account-secret'
        ? secretSettings.state.revision
        : null;
    const loading = secretSettings.state.loading;
    // Raw Account-secret input is presentation-local and disappears with this
    // host control. The shared record owns only safe status/revision/mutation.
    const [draft, setDraft] = React.useState('');
    const [saving, setSaving] = React.useState(false);
    const [saveFailed, setSaveFailed] = React.useState(false);
    const [saveOutcomeUnknown, setSaveOutcomeUnknown] = React.useState(false);
    const [dirty, setDirty] = React.useState(false);
    const writePending = secretSettings.state.writePending;
    const mountedRef = React.useRef(true);
    const operationIdRef = React.useRef(0);
    const draftVersionRef = React.useRef(0);
    const lifetimeIdentityRef = React.useRef(props.lifetimeIdentity);
    const targetIdentity = props.target?.serverIdentityId ?? '';
    const accountScopeIsCurrent = React.useCallback((): boolean => {
        const lifetime = props.accountLifetime;
        if (!lifetime) return false;
        try {
            return lifetime.isCurrent();
        } catch {
            return false;
        }
    }, [props.accountLifetime]);
    const configured = accountScopeIsCurrent()
        && secretSettings.state.secretStates[props.field.key] === 'configured';

    React.useLayoutEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
            operationIdRef.current += 1;
        };
    }, []);

    React.useLayoutEffect(() => {
        const lifetime = props.accountLifetime;
        if (!lifetime) return;
        const retirement = lifetime.onRetire(() => {
            // The shared Account record retires its read/watch/write state.
            // This presentation owner also holds raw draft/error bytes, so
            // clear them synchronously and fence its pending continuation.
            operationIdRef.current += 1;
            draftVersionRef.current += 1;
            setDraft('');
            setDirty(false);
            setSaving(false);
            setSaveFailed(false);
            setSaveOutcomeUnknown(false);
        });
        return () => retirement.dispose();
    }, [props.accountLifetime]);

    React.useLayoutEffect(() => {
        lifetimeIdentityRef.current = props.lifetimeIdentity;
        const operationId = operationIdRef.current + 1;
        operationIdRef.current = operationId;
        draftVersionRef.current += 1;
        setDraft('');
        setDirty(false);
        setSaving(false);
        setSaveFailed(false);
        setSaveOutcomeUnknown(false);
    }, [props.accountLifetime, props.field.key, props.lifetimeIdentity, props.pluginId, targetIdentity]);

    const commit = React.useCallback((mutation: ScopedPluginSettingsMutation) => {
        const operationLifetimeIdentity = props.lifetimeIdentity;
        if (
            !mountedRef.current
            || lifetimeIdentityRef.current !== operationLifetimeIdentity
            || !revision
            || loading
            || saving
            || writePending
            || !props.enabled
            || !accountScopeIsCurrent()
        ) return;
        const operationId = operationIdRef.current + 1;
        operationIdRef.current = operationId;
        const draftVersion = draftVersionRef.current;
        setSaving(true);
        setSaveFailed(false);
        setSaveOutcomeUnknown(false);
        void secretSettings.commit({
            fieldId: props.field.key,
            mutation,
        }).then((result) => {
            if (
                !mountedRef.current
                || lifetimeIdentityRef.current !== operationLifetimeIdentity
                || operationIdRef.current !== operationId
                || !accountScopeIsCurrent()
            ) return;
            if (result?.status === 'conflict' && result.snapshot.revision.kind === 'account-secret') {
                // A one-shot SavedSecret mutation was rejected. Its safe
                // snapshot is new authority for retry, but the draft remains
                // local until the user explicitly chooses to submit again.
                setSaving(false);
                setSaveFailed(true);
                return;
            }
            if (result?.status === 'outcomeUnknown') {
                // A safe snapshot may refresh presentation, but it cannot
                // establish that this SavedSecret mutation authored it.
                setSaving(false);
                setSaveFailed(true);
                setSaveOutcomeUnknown(true);
                return;
            }
            if (result?.status !== 'ready' || result.snapshot.revision.kind !== 'account-secret') {
                setSaving(false);
                setSaveFailed(result !== null);
                return;
            }
            if (draftVersionRef.current === draftVersion) {
                setDraft('');
                setDirty(false);
            }
            setSaving(false);
            setSaveFailed(false);
            setSaveOutcomeUnknown(false);
        }).catch(() => {
            if (
                !mountedRef.current
                || lifetimeIdentityRef.current !== operationLifetimeIdentity
                || operationIdRef.current !== operationId
                || !accountScopeIsCurrent()
            ) return;
            setSaving(false);
            setSaveFailed(true);
            setSaveOutcomeUnknown(false);
        });
    }, [accountScopeIsCurrent, loading, props.enabled, props.field.key, props.lifetimeIdentity, revision, saving, secretSettings, writePending]);

    const save = React.useCallback(() => {
        const mutation = createScopedPluginSettingsSetMutation(draft);
        if (mutation) commit(mutation);
    }, [commit, draft]);

    const deleteSecret = React.useCallback(() => {
        commit({ kind: 'delete' });
    }, [commit]);

    const unbindSecret = React.useCallback(() => {
        commit({ kind: 'unbind' });
    }, [commit]);

    const bindExistingSecret = React.useCallback(() => {
        if (!revision || loading || saving || writePending || !props.enabled || !accountScopeIsCurrent()) return;
        Modal.show({
            component: SavedSecretPickerModal,
            props: {
                // A binding identity is never projected back into the control,
                // so this picker is deliberately not told which secret is
                // currently configured.
                selectedId: null,
                includeNoneRow: false,
                allowAdd: false,
                allowEdit: false,
                onSelectId: (savedSecretId) => {
                    if (!savedSecretId) return;
                    commit({ kind: 'bind', savedSecretId });
                },
            },
            chrome: {
                kind: 'card',
                title: t('settings.mcpServersPickSecretTitle'),
                dimensions: { size: 'lg' },
            },
            closeOnBackdrop: true,
        });
    }, [accountScopeIsCurrent, commit, loading, props.enabled, revision, saving, writePending]);

    return (
        <PluginSettingTextField
            pluginId={props.pluginId}
            group={props.group}
            field={props.field}
            value={draft}
            dirty={dirty}
            saving={saving}
            saveFailed={saveFailed}
            persistenceDisabled={!props.enabled || !accountScopeIsCurrent() || loading || writePending || revision === null}
            acceptDraftInputWhileBusy={props.enabled && accountScopeIsCurrent() && !loading && revision !== null}
            onChangeText={(value) => {
                if (!accountScopeIsCurrent()) return;
                draftVersionRef.current += 1;
                setDraft(value);
                setDirty(true);
                setSaveFailed(false);
                setSaveOutcomeUnknown(false);
            }}
            onCommit={save}
            onDelete={configured ? deleteSecret : undefined}
            onBindExisting={bindExistingSecret}
            onUnbind={configured ? unbindSecret : undefined}
            status={configured ? t('memorySearchSettings.embeddings.secretSet') : null}
            errorMessage={saveOutcomeUnknown
                ? t('settingsProviders.errors.mutationOutcomeUnknownDescription')
                : saveFailed ? t('settingsPlugins.genericSettingsSaveError') : null}
        />
    );
}

/**
 * Read the user-selected endpoint through the existing Account field binding,
 * then use the shared URL policy to derive its credential identity. This is
 * presentation metadata only: the URL is never copied beside secret custody.
 */
function readManagedServiceSecretCanonicalOrigin(params: Readonly<{
    group: PluginProjectionEditableSettingsGroup;
    field: PluginProjectionEditableSettingField;
    values: Readonly<Record<string, unknown>>;
    perActiveServerIdentityId: string | null;
}>): string | null {
    const endpointSettingId = params.field.managedServiceOrigin?.endpointSettingId;
    if (!endpointSettingId) return null;
    const endpointField = params.group.fields.find((field) => field.key === endpointSettingId);
    if (!endpointField) return null;
    const endpoint = readManagedServiceEndpointUrl(readScopedPluginSettingsDeclaredFieldValue({
        values: params.values,
        field: endpointField,
        serverIdentityId: params.perActiveServerIdentityId,
    }), {
        hostPolicy: 'userDeclaredAttach',
        allowSearch: true,
        allowHash: true,
    });
    if (!endpoint.ok) return null;
    return new URL(endpoint.endpoint.baseUrl).origin;
}

type ManagedServiceSecretPresentationState =
    | Readonly<{ kind: 'loading' }>
    | Readonly<{
        kind: 'ready';
        state: 'configured' | 'missing' | 'denied' | 'unavailable';
        revision: string;
    }>
    | Readonly<{ kind: 'unavailable' }>;

/**
 * Origin-bound daemon custody has no daemon Settings record. The Account
 * field remains the UI-only endpoint relation; status/set/delete travel to
 * the one declaration-aware daemon secret owner with that exact origin.
 */
function PluginSettingDaemonSecretField(props: Readonly<{
    pluginId: string;
    group: PluginProjectionEditableSettingsGroup;
    field: PluginProjectionEditableSettingField;
    values?: Readonly<Record<string, unknown>>;
    perActiveServerIdentityId?: string | null;
    target: ScopedPluginSettingsDaemonTarget | null;
    enabled: boolean;
    /** The Account endpoint owner is refreshing; retained values are inert. */
    endpointSettingsLoading?: boolean;
    /** Owns currentness for the Account endpoint relation behind this secret. */
    accountLifetime: ActiveServerAccountScopeLifetime | null;
    isDaemonTargetCurrent?: (target: ScopedPluginSettingsDaemonTarget) => boolean;
    /** Current generation/declaration boundary for presentation-local bytes. */
    lifetimeIdentity: string;
}>) {
    const hasManagedServiceOrigin = Boolean(props.field.managedServiceOrigin);
    const canonicalOrigin = React.useMemo(() => hasManagedServiceOrigin
        ? readManagedServiceSecretCanonicalOrigin({
            group: props.group,
            field: props.field,
            values: props.values ?? {},
            perActiveServerIdentityId: props.perActiveServerIdentityId ?? null,
        })
        : null, [hasManagedServiceOrigin, props.field, props.group, props.perActiveServerIdentityId, props.values]);
    const originIsReady = !hasManagedServiceOrigin || canonicalOrigin !== null;
    const endpointSettingsLoading = hasManagedServiceOrigin && props.endpointSettingsLoading === true;
    const targetKey = props.target
        ? `${props.target.serverIdentityId}:${props.target.machineId}:${props.target.serverId}`
        : '';
    const requestIdentity = `${targetKey}:${hasManagedServiceOrigin ? canonicalOrigin ?? 'invalid-origin' : 'unscoped-secret'}`;
    const [status, setStatus] = React.useState<ManagedServiceSecretPresentationState>({ kind: 'unavailable' });
    const [draft, setDraft] = React.useState('');
    const [dirty, setDirty] = React.useState(false);
    const [saving, setSaving] = React.useState(false);
    const [saveFailed, setSaveFailed] = React.useState(false);
    const [saveOutcomeUnknown, setSaveOutcomeUnknown] = React.useState(false);
    const mountedRef = React.useRef(true);
    const operationIdRef = React.useRef(0);
    const draftVersionRef = React.useRef(0);
    const lifetimeIdentityRef = React.useRef(props.lifetimeIdentity);
    const writeAbortRef = React.useRef<AbortController | null>(null);
    const daemonSecretAdapter = scopedPluginSettingsAdapter.daemonSecret;

    const targetIsCurrent = React.useCallback((target: ScopedPluginSettingsDaemonTarget | null): boolean => {
        if (!target) return false;
        try {
            return props.isDaemonTargetCurrent?.(target) !== false;
        } catch {
            return false;
        }
    }, [props.isDaemonTargetCurrent]);
    const accountScopeIsCurrent = React.useCallback((): boolean => {
        const lifetime = props.accountLifetime;
        if (!lifetime) return false;
        try {
            return lifetime.isCurrent();
        } catch {
            return false;
        }
    }, [props.accountLifetime]);

    React.useLayoutEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
            operationIdRef.current += 1;
            writeAbortRef.current?.abort();
            writeAbortRef.current = null;
        };
    }, []);

    React.useLayoutEffect(() => {
        const lifetime = props.accountLifetime;
        if (!lifetime) return;
        const retirement = lifetime.onRetire(() => {
            // Account lifetime owns every mounted plugin Settings control,
            // including an exact daemon target. Retire local secret bytes and
            // requests before the next Account can mount the same target.
            operationIdRef.current += 1;
            writeAbortRef.current?.abort();
            writeAbortRef.current = null;
            draftVersionRef.current += 1;
            setDraft('');
            setDirty(false);
            setSaving(false);
            setSaveFailed(false);
            setSaveOutcomeUnknown(false);
            setStatus({ kind: 'unavailable' });
        });
        return () => retirement.dispose();
    }, [props.accountLifetime]);

    React.useLayoutEffect(() => {
        lifetimeIdentityRef.current = props.lifetimeIdentity;
        operationIdRef.current += 1;
        writeAbortRef.current?.abort();
        writeAbortRef.current = null;
        draftVersionRef.current += 1;
        setDraft('');
        setDirty(false);
        setSaving(false);
        setSaveFailed(false);
        setSaveOutcomeUnknown(false);
        setStatus({ kind: 'unavailable' });
    }, [props.accountLifetime, props.field.key, props.lifetimeIdentity, props.pluginId, requestIdentity]);

    React.useEffect(() => {
        const target = props.target;
        if (
            !props.enabled
            || endpointSettingsLoading
            || !originIsReady
            || !target
            || !daemonSecretAdapter
            || !accountScopeIsCurrent()
            || !targetIsCurrent(target)
        ) {
            return;
        }
        const controller = new AbortController();
        let active = true;
        setStatus({ kind: 'loading' });
        void daemonSecretAdapter.read({
            pluginId: props.pluginId,
            target,
            secretId: props.field.key,
            ...(canonicalOrigin ? { canonicalOrigin } : {}),
            signal: controller.signal,
        }).then((result) => {
            if (
                !active
                || !mountedRef.current
                || lifetimeIdentityRef.current !== props.lifetimeIdentity
                || !accountScopeIsCurrent()
                || !targetIsCurrent(target)
            ) return;
            if (result.status !== 'ready') {
                setStatus({ kind: 'unavailable' });
                return;
            }
            setStatus({
                kind: 'ready',
                state: result.snapshot.state,
                revision: result.snapshot.revision,
            });
        });
        return () => {
            active = false;
            controller.abort();
        };
    }, [accountScopeIsCurrent, canonicalOrigin, daemonSecretAdapter, endpointSettingsLoading, originIsReady, props.enabled, props.field.key, props.lifetimeIdentity, props.pluginId, props.target, requestIdentity, targetIsCurrent]);

    const commit = React.useCallback((kind: 'set' | 'delete') => {
        const target = props.target;
        const operationLifetimeIdentity = props.lifetimeIdentity;
        const readyStatus = status.kind === 'ready' ? status : null;
        const acceptedState = readyStatus?.state === 'configured' || readyStatus?.state === 'missing';
        if (
            !mountedRef.current
            || !props.enabled
            || endpointSettingsLoading
            || !originIsReady
            || !target
            || !daemonSecretAdapter
            || !accountScopeIsCurrent()
            || !targetIsCurrent(target)
            || !readyStatus
            || !acceptedState
            || saving
        ) return;
        const operationId = operationIdRef.current + 1;
        operationIdRef.current = operationId;
        const draftVersion = draftVersionRef.current;
        const controller = new AbortController();
        writeAbortRef.current?.abort();
        writeAbortRef.current = controller;
        setSaving(true);
        setSaveFailed(false);
        setSaveOutcomeUnknown(false);
        const input = {
            target,
            pluginId: props.pluginId,
            secretId: props.field.key,
            ...(canonicalOrigin ? { canonicalOrigin } : {}),
            expectedRevision: readyStatus.revision,
            signal: controller.signal,
        };
        const mutation = daemonSecretAdapter.write({
            ...input,
            mutation: kind === 'set'
                ? { kind: 'set', value: draft }
                : { kind: 'delete' },
        });
        void mutation.then((result) => {
            if (
                !mountedRef.current
                || lifetimeIdentityRef.current !== operationLifetimeIdentity
                || operationIdRef.current !== operationId
                || !accountScopeIsCurrent()
                || !targetIsCurrent(target)
            ) return;
            if (writeAbortRef.current === controller) writeAbortRef.current = null;
            const draftIsCurrent = draftVersionRef.current === draftVersion;
            if (result.status === 'outcomeUnknown') {
                // The adapter already performed one safe status readback for
                // this exact target/origin. Keep the draft and preserve the
                // ambiguity rather than replaying a possible mutation.
                setSaving(false);
                if (!draftIsCurrent) return;
                if (result.snapshot) {
                    setStatus({
                        kind: 'ready',
                        state: result.snapshot.state,
                        revision: result.snapshot.revision,
                    });
                }
                setSaveFailed(true);
                setSaveOutcomeUnknown(true);
                return;
            }
            if (result.status !== 'ready') {
                setSaving(false);
                if (!draftIsCurrent) return;
                setSaveFailed(true);
                return;
            }
            setSaving(false);
            if (!draftIsCurrent) return;
            setStatus({
                kind: 'ready',
                state: result.snapshot.state,
                revision: result.snapshot.revision,
            });
            if (kind === 'set') {
                setDraft('');
                setDirty(false);
            } else if (kind === 'delete') {
                setDraft('');
                setDirty(false);
            }
            setSaveFailed(false);
            setSaveOutcomeUnknown(false);
        }).catch(() => {
            if (
                !mountedRef.current
                || lifetimeIdentityRef.current !== operationLifetimeIdentity
                || operationIdRef.current !== operationId
                || !accountScopeIsCurrent()
                || !targetIsCurrent(target)
            ) return;
            if (writeAbortRef.current === controller) writeAbortRef.current = null;
            setSaving(false);
            if (draftVersionRef.current !== draftVersion) return;
            setSaveFailed(true);
            setSaveOutcomeUnknown(false);
        });
    }, [accountScopeIsCurrent, canonicalOrigin, daemonSecretAdapter, draft, endpointSettingsLoading, originIsReady, props.enabled, props.field.key, props.lifetimeIdentity, props.pluginId, props.target, saving, status, targetIsCurrent]);

    const ready = status.kind === 'ready';
    const secretConfigured = !endpointSettingsLoading && ready && status.state === 'configured';
    const secretUsable = !endpointSettingsLoading && ready && (status.state === 'configured' || status.state === 'missing');
    const persistenceDisabled = !props.enabled
        || endpointSettingsLoading
        || !originIsReady
        || !props.target
        || !daemonSecretAdapter
        || !accountScopeIsCurrent()
        || !targetIsCurrent(props.target)
        || !secretUsable;

    return (
        <PluginSettingTextField
            pluginId={props.pluginId}
            group={props.group}
            field={props.field}
            value={draft}
            dirty={dirty}
            saving={saving}
            saveFailed={saveFailed}
            persistenceDisabled={persistenceDisabled}
            acceptDraftInputWhileBusy={!persistenceDisabled && !saving}
            status={secretConfigured ? t('memorySearchSettings.embeddings.secretSet') : null}
            errorMessage={saveOutcomeUnknown
                ? t('settingsProviders.errors.mutationOutcomeUnknownDescription')
                : saveFailed
                    ? t('settingsPlugins.genericSettingsSaveError')
                : hasManagedServiceOrigin && !canonicalOrigin && !endpointSettingsLoading
                    ? t('settingsPlugins.genericSettingsUnavailable')
                    : null}
            onChangeText={(value) => {
                draftVersionRef.current += 1;
                setDraft(value);
                setDirty(true);
                setSaveFailed(false);
                setSaveOutcomeUnknown(false);
            }}
            onCommit={() => commit('set')}
            onDelete={secretConfigured ? () => commit('delete') : undefined}
        />
    );
}

type PluginDetailGenericSettingsSectionProps = Readonly<{
    pluginId: string;
    projection: PluginProjectionEntry | null;
    /** Current Account-release declaration used only while daemon projection is absent. */
    accountSettingsDeclaration?: PluginPortableReleaseManifestV1 | null;
    machineId: string | null;
    serverId: string | null;
    /** Exact Account identity selected by the authenticated server owner. */
    accountServerIdentityId?: string | null;
    /** Exact daemon identity selected by the administration target owner. */
    daemonServerIdentityId?: string | null;
    /** Portable selected-server identity retained while its daemon is offline. */
    perActiveServerIdentityId?: string | null;
    daemonOperationsAvailable: boolean;
    /**
     * Optional owner-local freshness fence for a daemon target. Callers that
     * own a mutable execution selection supply this immediately before write.
     */
    isDaemonTargetCurrent?: (target: Extract<ScopedPluginSettingsTarget, { kind: 'daemon' }>) => boolean;
    policyContext?: PluginUiPolicyEvaluationContext;
}>;

export function PluginDetailGenericSettingsSection(props: PluginDetailGenericSettingsSectionProps) {
    const groups = React.useMemo(() => (
        props.projection?.editableSettingsGroups
        ?? projectAccountDeclaredPluginSettingsGroups({
            pluginId: props.pluginId,
            declaration: props.accountSettingsDeclaration,
        })
    ), [props.accountSettingsDeclaration, props.pluginId, props.projection]);
    const sourceLifetimeIdentity = settingsSourceLifetimeIdentity({
        projection: props.projection,
        accountSettingsDeclaration: props.accountSettingsDeclaration,
    });
    const { accountGroups, daemonGroups } = React.useMemo(() => ({
        accountGroups: groups
            .filter((group) => group.scope.kind === 'account'),
        daemonGroups: groups.filter((group) => group.scope.kind === 'daemon'),
    }), [groups]);
    // Daemon storage authority stays exact-machine, but its mounted record,
    // LKG, and parked watch are UI Account-lifetime state. Capture the one
    // incumbent lifetime for either Settings scope so Account A cannot leak
    // into Account B when the daemon target remains unchanged.
    const requiresAccountLifetime = groups.length > 0;
    const accountLifetime = requiresAccountLifetime
        ? captureActiveServerAccountScopeLifetime()
        : null;
    const accountTarget = React.useMemo(() => resolveScopedPluginSettingsTarget({
        scope: ACCOUNT_PLUGIN_SETTINGS_SCOPE,
        serverIdentityId: props.accountServerIdentityId,
    }), [props.accountServerIdentityId]);
    const daemonTarget = React.useMemo(() => resolveScopedPluginSettingsTarget({
        scope: DAEMON_PLUGIN_SETTINGS_SCOPE,
        machineId: props.machineId,
        serverId: props.serverId,
        serverIdentityId: props.daemonServerIdentityId,
    }), [props.daemonServerIdentityId, props.machineId, props.serverId]);
    const accountSecretTarget = accountTarget?.kind === 'account' ? accountTarget : null;
    const daemonSecretTarget = daemonTarget?.kind === 'daemon' ? daemonTarget : null;

    if (accountGroups.length === 0 && daemonGroups.length === 0) return null;
    return (
        <>
            {accountGroups.length > 0 ? (
                <PluginDetailScopedSettingsSection
                    {...props}
                    groups={accountGroups}
                    scope={ACCOUNT_PLUGIN_SETTINGS_SCOPE}
                    target={accountTarget}
                    accountSecretTarget={accountSecretTarget}
                    daemonSecretTarget={daemonSecretTarget}
                    accountLifetime={accountLifetime}
                    sourceLifetimeIdentity={sourceLifetimeIdentity}
                />
            ) : null}
            {daemonGroups.length > 0 ? (
                <PluginDetailScopedSettingsSection
                    {...props}
                    groups={daemonGroups}
                    scope={DAEMON_PLUGIN_SETTINGS_SCOPE}
                    target={daemonTarget}
                    accountSecretTarget={accountSecretTarget}
                    daemonSecretTarget={daemonSecretTarget}
                    accountLifetime={accountLifetime}
                    sourceLifetimeIdentity={sourceLifetimeIdentity}
                />
            ) : null}
        </>
    );
}

function PluginDetailScopedSettingsSection(props: PluginDetailGenericSettingsSectionProps & Readonly<{
    groups: readonly PluginProjectionEditableSettingsGroup[];
    scope: ScopedPluginSettingsScope;
    target: ScopedPluginSettingsTarget | null;
    accountSecretTarget: ScopedPluginSettingsAccountTarget | null;
    daemonSecretTarget: ScopedPluginSettingsDaemonTarget | null;
    accountLifetime: ActiveServerAccountScopeLifetime | null;
    /** Current source generation/declaration inherited by secret controls. */
    sourceLifetimeIdentity: string;
}>) {
    const { theme } = useUnistyles();
    const router = useRouter();
    const groups = props.groups;
    const sortedGroups = React.useMemo(() => [...groups].sort(compareSettingsGroups), [groups]);
    // Secret raw bytes remain inside their dedicated presentation controls.
    // Every other declared field enters the one canonical scoped projection.
    const ordinaryFields = React.useMemo(() => sortedGroups.flatMap((group) => group.fields.filter((field) => (
        !isAccountSavedSecretField(field)
        && !isDaemonCustodiedSecretField(field)
        && !isRedactedField(field)
    ))), [sortedGroups]);
    const adapterFields = React.useMemo(
        () => projectScopedPluginSettingsFields(ordinaryFields),
        [ordinaryFields],
    );
    const hasAccountSavedSecretFields = sortedGroups
        .some((group) => group.fields.some(isAccountSavedSecretField));
    const accountScopeCurrent = React.useMemo(() => {
        if (props.scope.kind !== 'account') return true;
        if (!props.target || !props.accountLifetime) return false;
        try {
            return props.accountLifetime.isCurrent();
        } catch {
            return false;
        }
    }, [props.accountLifetime, props.scope.kind, props.target]);
    const scopedOperationsAvailable = props.scope.kind === 'account'
        ? accountScopeCurrent
        : props.daemonOperationsAvailable;
    const scopedSettings = useScopedPluginSettingsProjection({
        pluginId: props.pluginId,
        scope: props.scope,
        target: props.target,
        accountLifetime: props.accountLifetime,
        fields: adapterFields,
        declaredFields: ordinaryFields,
        sourceLifetimeIdentity: props.sourceLifetimeIdentity,
        perActiveServerIdentityId: props.perActiveServerIdentityId ?? null,
        enabled: scopedOperationsAvailable,
        adapter: scopedPluginSettingsAdapter,
    });
    const loading = scopedSettings.state.loading;
    // The record's typed mutation result remains available to its field
    // model. Only an unavailable snapshot is a section-level load failure;
    // rendering a rejected save as a load error would misstate recovery and
    // let one field's old result leak into its siblings.
    const loadError = scopedSettings.state.error === 'unavailable'
        ? t('settingsPlugins.genericSettingsLoadError')
        : null;
    const values = scopedSettings.state.values;
    const fieldModelByKey = React.useMemo(
        () => new Map(scopedSettings.fieldModels.map((model) => [model.field.key, model] as const)),
        [scopedSettings.fieldModels],
    );
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
    const commitOrdinaryField = React.useCallback((params: Readonly<{
        field: PluginProjectionEditableSettingField;
        model: ScopedPluginSettingsFieldModel;
        hasDraft: boolean;
        draft?: unknown;
    }>) => {
        const daemonTarget = props.target?.kind === 'daemon' ? props.target : null;
        const isCurrent = daemonTarget && props.isDaemonTargetCurrent
            ? () => props.isDaemonTargetCurrent!(daemonTarget)
            : undefined;
        const previousValue = params.model.value;
        void params.model.commit({
            ...(params.hasDraft ? { draft: params.draft } : {}),
            ...(isCurrent ? { isCurrent } : {}),
        }).then((result) => {
            if (result?.status !== 'ready') return;
            emitPluginSettingChangedEvent({
                pluginId: props.pluginId,
                scope: props.scope.kind,
                previousValue,
                nextValue: readScopedPluginSettingsDeclaredFieldValue({
                    values: result.snapshot.values,
                    field: params.field,
                    serverIdentityId: props.daemonServerIdentityId ?? null,
                }),
                field: params.field,
            });
        });
    }, [
        props.daemonServerIdentityId,
        props.isDaemonTargetCurrent,
        props.pluginId,
        props.scope.kind,
        props.target,
    ]);
    const hasHydratedCurrentScope = scopedOperationsAvailable && props.target !== null && (
        adapterFields.length === 0 || scopedSettings.state.ready
    );

    if (sortedGroups.length === 0) {
        return null;
    }

    if (
        (!props.target || (props.scope.kind === 'account' && !scopedOperationsAvailable))
        && !hasAccountSavedSecretFields
    ) {
        return (
            <ItemGroup title={t('settingsPlugins.genericSettingsTitle')}>
                <Item
                    testID={`settings.plugins.detail.${props.pluginId}.settings.unavailable`}
                    title={t('settingsPlugins.genericSettingsUnavailable')}
                    icon={<Icon name="cloud-slash" size={29} color={theme.colors.text.secondary} />}
                    showChevron={false}
                    mode="info"
                />
            </ItemGroup>
        );
    }

    if (loading && !hasHydratedCurrentScope && !hasAccountSavedSecretFields) {
        return (
            <ItemGroup title={t('settingsPlugins.genericSettingsTitle')}>
                <Item
                    testID={`settings.plugins.detail.${props.pluginId}.settings.loading`}
                    title={t('settingsPlugins.genericSettingsLoading')}
                    icon={<Icon name="arrows-clockwise" size={29} color={theme.colors.text.secondary} />}
                    showChevron={false}
                    mode="info"
                />
            </ItemGroup>
        );
    }

    if (loadError && !hasHydratedCurrentScope && !hasAccountSavedSecretFields) {
        return (
            <ItemGroup title={t('settingsPlugins.genericSettingsTitle')}>
                <Item
                    testID={`settings.plugins.detail.${props.pluginId}.settings.error`}
                    title={loadError}
                    icon={<Icon name="warning-circle" size={29} color={theme.colors.state.danger.foreground} />}
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
                const groupOutcomeUnknown = fields.some(
                    (field) => fieldModelByKey.get(field.key)?.error === 'outcomeUnknown',
                );
                const groupHasSaveError = fields.some((field) => {
                    const error = fieldModelByKey.get(field.key)?.error;
                    return error === 'failed' || error === 'outcomeUnknown';
                });
                return (
                    <ItemGroup
                        key={group.id}
                        title={group.title}
                        footer={groupOutcomeUnknown
                            ? t('settingsProviders.errors.mutationOutcomeUnknownDescription')
                            : groupHasSaveError
                                ? t('settingsPlugins.genericSettingsSaveError')
                            : group.description ?? t('settingsPlugins.genericSettingsFooter')}
                    >
                        {groupIndex === 0 && loadError ? (
                            <Item
                                testID={`settings.plugins.detail.${props.pluginId}.settings.error`}
                                title={loadError}
                                icon={<Icon name="warning-circle" size={29} color={theme.colors.state.danger.foreground} />}
                                showChevron={false}
                                mode="info"
                            />
                        ) : null}
                        {fields.length === 0 ? (
                            <Item
                                testID={`settings.plugins.detail.${props.pluginId}.settings.${group.id}.empty`}
                                title={t('settingsPlugins.genericSettingsEmpty')}
                                icon={<Icon name="sliders-horizontal" size={29} color={theme.colors.text.secondary} />}
                                showChevron={false}
                                mode="info"
                            />
                        ) : fields.map((field) => {
                            const policy = evaluatePluginUiPolicy(
                                { availability: field.availability },
                                { ...props.policyContext, data: values },
                            );
                            const secretLifetimeIdentity = `${props.sourceLifetimeIdentity}:${scopedPluginSettingsFieldDeclarationIdentity(field)}`;
                            if (isAccountSavedSecretField(field)) {
                                return (
                                    <PluginSettingAccountSecretField
                                        key={`${field.key}:${secretLifetimeIdentity}`}
                                        pluginId={props.pluginId}
                                        group={group}
                                        field={field}
                                        target={props.accountSecretTarget}
                                        accountLifetime={props.accountLifetime}
                                        enabled={policy.enabled}
                                        lifetimeIdentity={secretLifetimeIdentity}
                                    />
                                );
                            }
                            if (isDaemonCustodiedSecretField(field)) {
                                if (field.managedServiceOrigin) {
                                    return (
                                        <PluginSettingDaemonSecretField
                                            key={`${field.key}:${secretLifetimeIdentity}`}
                                            pluginId={props.pluginId}
                                            group={group}
                                            field={field}
                                            values={values}
                                            perActiveServerIdentityId={props.perActiveServerIdentityId ?? null}
                                            target={props.daemonSecretTarget}
                                            enabled={policy.enabled && props.daemonOperationsAvailable}
                                            endpointSettingsLoading={loading}
                                            accountLifetime={props.accountLifetime}
                                            isDaemonTargetCurrent={props.isDaemonTargetCurrent}
                                            lifetimeIdentity={secretLifetimeIdentity}
                                        />
                                    );
                                }
                                return (
                                    <PluginSettingDaemonSecretField
                                        key={`${field.key}:${secretLifetimeIdentity}`}
                                        pluginId={props.pluginId}
                                        group={group}
                                        field={field}
                                        target={props.daemonSecretTarget}
                                        accountLifetime={props.accountLifetime}
                                        enabled={policy.enabled && props.daemonOperationsAvailable}
                                        isDaemonTargetCurrent={props.isDaemonTargetCurrent}
                                        lifetimeIdentity={secretLifetimeIdentity}
                                    />
                                );
                            }
                            const model = fieldModelByKey.get(field.key);
                            // A malformed/unsupported declaration never falls
                            // back to a renderer-local storage path.
                            if (!model) return null;
                            const disabled = !policy.enabled
                                || !scopedOperationsAvailable
                                || loading
                                || model.pending;
                            if (field.control === 'switch') {
                                return (
                                    <PluginSettingSwitchField
                                        key={field.key}
                                        pluginId={props.pluginId}
                                        group={group}
                                        field={field}
                                        value={model.draft === true}
                                        disabled={disabled}
                                        onChangeValue={(_changedField, value) => {
                                            commitOrdinaryField({ field, model, hasDraft: true, draft: value });
                                        }}
                                    />
                                );
                            }
                            if (field.control === 'select' || field.control === 'multiSelect') {
                                return field.control === 'select' ? (
                                    <PluginSettingSelectField
                                        key={field.key}
                                        pluginId={props.pluginId}
                                        group={group}
                                        field={field}
                                        value={model.draft}
                                        disabled={disabled}
                                        onChangeValue={(nextValue) => {
                                            commitOrdinaryField({ field, model, hasDraft: true, draft: nextValue });
                                        }}
                                    />
                                ) : (
                                    <PluginSettingMultiSelectField
                                        key={field.key}
                                        pluginId={props.pluginId}
                                        group={group}
                                        field={field}
                                        value={model.draft}
                                        disabled={disabled}
                                        onChangeValue={(nextValue) => {
                                            commitOrdinaryField({ field, model, hasDraft: true, draft: nextValue });
                                        }}
                                    />
                                );
                            }
                            return (
                                <PluginSettingTextField
                                    key={field.key}
                                    pluginId={props.pluginId}
                                    group={group}
                                    field={field}
                                    value={typeof model.draft === 'string' ? model.draft : ''}
                                    dirty={model.dirty}
                                    saving={model.pending}
                                    saveFailed={model.error !== null}
                                    persistenceDisabled={!policy.enabled || !scopedOperationsAvailable || loading}
                                    commitDisabled={model.pending}
                                    onChangeText={model.setDraft}
                                    onCommit={() => commitOrdinaryField({ field, model, hasDraft: false })}
                                />
                            );
                        })}
                    </ItemGroup>
                );
            })}
            {/*
              * A subagent item's destination is the declaring contribution's own
              * agent settings screen, resolved by the host route owner. A
              * plugin-target group has no such screen, so its items have no
              * destination and are not presented.
              */}
            {sortedGroups.flatMap((group) => {
                if (group.target.kind !== 'agent') return [];
                const agentSettingsRoute = createPluginAgentSettingsRoute(group.target.agent);
                return group.presentation.subagentSections.map((section) => (
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
                                    <Icon
                                        name={(item.iconIonName ?? 'git-branch') as never}
                                        size={29}
                                        color={theme.colors.text.secondary}
                                    />
                                )}
                                onPress={() => router.push(agentSettingsRoute as never)}
                            />
                        ))}
                    </ItemGroup>
                ));
            })}
        </>
    );
}
