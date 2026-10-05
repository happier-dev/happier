import * as React from 'react';
import { View } from 'react-native';
import { useNavigation, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useUnistyles } from 'react-native-unistyles';

import {
    applyAcpBackendDeleteV1,
    applyAcpBackendUpsertV1,
    normalizeAcpCatalogSettingsV1,
    suggestAcpBackendIdV1,
    type AcpBackendDefinitionV1,
    type AcpBackendUpsertResultV1,
    type AcpCatalogAuthSupportV1,
    type AcpCatalogSupportHintV1,
} from '@happier-dev/protocol';

import { createCustomAcpAgentSettingsRoute } from '@/agents/catalog/agentSettingsRoutes';
import { useSavedSecretsMutable } from '@/components/secrets/useSavedSecretsMutable';
import { useAgentAuthoringEntry } from '@/components/settings/agents/authoring/useAgentAuthoringEntry';
import { publishCustomAcpDraftTitle } from '@/components/settings/agents/collection/customAcpDraftTitle';
import {
    useAgentsAdministrationTargetSelection,
    useAgentsMachineScope,
} from '@/components/settings/agents/collection/useAgentAdministrationCatalog';
import { PageHeaderMarkSlot } from '@/components/ui/layout/PageHeaderMarkSlot';
import { PageHeaderMenu, type PageHeaderMenuAction } from '@/components/ui/layout/PageHeaderEntityParts';
import { McpValueRefMapEditor } from '@/components/settings/mcpServers/McpValueRefMapEditor';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { StringListField } from '@/components/ui/forms/StringListField';
import { Icon } from '@/components/ui/icons/Icon';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { Text } from '@/components/ui/text/Text';
import { Modal } from '@/modal';
import { useSettingMutable, useSettingsVersion } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { useUnsavedDraftNavigationGuard } from '@/utils/navigation/useUnsavedDraftNavigationGuard';

import { createDraftAcpBackend } from './createDraftAcpBackend';
import { useHappierCollectionLayout } from '@happier-dev/plugin-ui/presentation';

const TEST_ID = 'settings.acpCatalog.backendEditor';
const AGENTS_ROUTE = '/(app)/settings/agents';

type Draft = AcpBackendDefinitionV1;
/** An authored field a refusal can point at. `other` collects fields without a row of their own. */
type FieldKey = 'title' | 'id' | 'name' | 'command' | 'docsUrl' | 'env' | 'other';
type FieldErrors = Partial<Record<FieldKey, string>>;

type EditorState = Readonly<{
    /** What is stored (or the blank draft): the draft is dirty when it differs from this. */
    baseline: Draft;
    draft: Draft;
    /** A new agent's ID and short name follow its name until the author edits them. */
    identifiersEdited: boolean;
    errors: FieldErrors;
}>;

function comparable(draft: Draft): string {
    const { createdAt: _createdAt, updatedAt: _updatedAt, ...rest } = draft;
    return JSON.stringify(rest);
}

function trimList(values: readonly string[] | undefined): string[] {
    return (values ?? []).map((value) => value.trim()).filter(Boolean);
}

/** The writer's typed refusal, placed beside the field it names. */
function describeRefusal(
    result: Exclude<AcpBackendUpsertResultV1, { ok: true }>,
    draft: Draft,
    identifiersFollowName: boolean,
): FieldErrors {
    if (result.code === 'acp_backend_id_conflict') return { id: t('settingsAgents.customAcp.errors.idTaken') };
    if (result.code === 'acp_backend_name_conflict') {
        return identifiersFollowName
            ? { id: t('settingsAgents.customAcp.errors.idTaken') }
            : { name: t('settingsAgents.customAcp.errors.shortNameTaken') };
    }
    const errors: FieldErrors = {};
    const titleMissing = draft.title.trim().length === 0;
    for (const field of result.fields) {
        switch (field) {
            case 'title':
                errors.title = t('settingsAgents.customAcp.errors.nameRequired');
                break;
            case 'id':
            case 'name': {
                // A derived ID is missing only because the name is: the name's error says it.
                if (identifiersFollowName && titleMissing) break;
                const key = identifiersFollowName ? 'id' : field;
                const value = field === 'id' ? draft.id : draft.name;
                errors[key] = value.trim().length === 0
                    ? t('settingsAgents.customAcp.errors.idRequired')
                    : field === 'id'
                        ? t('settingsAgents.customAcp.errors.idInvalid')
                        : t('settingsAgents.customAcp.errors.shortNameInvalid');
                break;
            }
            case 'command':
                errors.command = draft.command.trim().length === 0
                    ? t('settingsAgents.customAcp.errors.commandRequired')
                    : t('settingsAgents.customAcp.errors.fieldInvalid');
                break;
            case 'auth.docsUrl':
                errors.docsUrl = t('settingsAgents.customAcp.errors.urlInvalid');
                break;
            case 'env':
                errors.env = t('settingsAgents.customAcp.errors.envInvalid');
                break;
            default:
                errors.other = `${t('settingsAgents.customAcp.errors.fieldInvalid')} (${field})`;
        }
    }
    return errors;
}

function withoutError(errors: FieldErrors, field: FieldKey): FieldErrors {
    if (!(field in errors)) return errors;
    const { [field]: _removed, ...rest } = errors;
    return rest;
}

function createInitialState(existing: Draft | null): EditorState {
    const baseline = existing ?? createDraftAcpBackend();
    return { baseline, draft: baseline, identifiersEdited: existing !== null, errors: {} };
}

/**
 * The one editor of a custom ACP agent, new or saved, shown as the Agents collection's detail. It
 * writes through the protocol's ACP catalog writer (the same one `agents.acp.backends.*` uses) and
 * shows that writer's typed refusals beside their fields. Leaving with unsaved changes goes through
 * the shared unsaved-changes guard; a new draft that was never changed simply disappears.
 */
export const AcpBackendEditorScreen = React.memo(function AcpBackendEditorScreen(props: Readonly<{
    backendId: string | null;
}>) {
    const { theme } = useUnistyles();
    const router = useRouter();
    const navigation = useNavigation();
    const layoutMode = useHappierCollectionLayout()?.mode ?? null;
    const [settingsRaw, setSettings] = useSettingMutable('acpCatalogSettingsV1');
    // Null until the Account settings have loaded: until then a missing agent may still arrive.
    const settingsLoaded = useSettingsVersion() !== null;
    const [secrets, setSecrets] = useSavedSecretsMutable();
    const settings = React.useMemo(() => normalizeAcpCatalogSettingsV1(settingsRaw), [settingsRaw]);
    const isNew = props.backendId === null;
    const existing = React.useMemo(
        () => (props.backendId ? settings.backends.find((entry) => entry.id === props.backendId) ?? null : null),
        [props.backendId, settings.backends],
    );

    const [state, setState] = React.useState<EditorState>(() => createInitialState(existing));
    const { draft, baseline, identifiersEdited, errors } = state;
    const dirty = comparable(draft) !== comparable(baseline);
    // A synced change to the stored agent replaces an untouched editor; it never overwrites edits.
    React.useEffect(() => {
        if (!existing) return;
        setState((current) => (comparable(current.draft) === comparable(current.baseline)
            ? { ...current, baseline: existing, draft: existing }
            : current));
    }, [existing]);

    const identifiersFollowName = isNew && !identifiersEdited;
    const derivedId = React.useMemo(
        () => (identifiersFollowName ? suggestAcpBackendIdV1({ title: draft.title, settings }) : null),
        [draft.title, identifiersFollowName, settings],
    );
    const effectiveDraft = React.useMemo<Draft>(() => (derivedId === null
        ? draft
        : { ...draft, id: derivedId, name: derivedId }), [derivedId, draft]);

    // The collection's draft row shows the name as it is typed.
    React.useEffect(() => {
        if (isNew) publishCustomAcpDraftTitle(draft.title);
    }, [draft.title, isNew]);
    React.useEffect(() => (isNew ? () => publishCustomAcpDraftTitle('') : undefined), [isNew]);

    const update = React.useCallback((field: FieldKey | null, updater: (current: Draft) => Draft) => {
        setState((current) => {
            const errors = field ? withoutError(current.errors, field) : current.errors;
            return {
                ...current,
                draft: updater(current.draft),
                // A derived ID changes with the name, so the name's edit also answers an ID refusal.
                errors: field === 'title' && !current.identifiersEdited ? withoutError(errors, 'id') : errors,
            };
        });
    }, []);

    // Navigation waits for the render that marks the draft clean, so the guard lets it through.
    const [pendingHref, setPendingHref] = React.useState<string | null>(null);
    React.useEffect(() => {
        if (pendingHref === null) return;
        setPendingHref(null);
        if (pendingHref === AGENTS_ROUTE && layoutMode === 'stacked' && router.canGoBack?.()) {
            router.back();
            return;
        }
        router.replace(pendingHref as never);
    }, [layoutMode, pendingHref, router]);

    const save = React.useCallback((): boolean => {
        const candidate: Draft = {
            ...effectiveDraft,
            args: trimList(effectiveDraft.args),
            auth: effectiveDraft.auth?.loginCommand
                ? {
                    ...effectiveDraft.auth,
                    loginCommand: { ...effectiveDraft.auth.loginCommand, args: trimList(effectiveDraft.auth.loginCommand.args) },
                }
                : effectiveDraft.auth,
            updatedAt: Date.now(),
        };
        const result = applyAcpBackendUpsertV1({
            settings,
            backend: candidate,
            nowMs: candidate.updatedAt,
            mode: isNew ? 'create' : 'upsert',
        });
        if (!result.ok) {
            const nextErrors = describeRefusal(result, candidate, identifiersFollowName);
            const identifiersAtFault = nextErrors.id !== undefined || nextErrors.name !== undefined;
            setState((current) => ({
                ...current,
                errors: nextErrors,
                // Never hide an error behind "Edit": show the identifier fields, holding the derived values.
                ...(identifiersAtFault && !current.identifiersEdited
                    ? { identifiersEdited: true, draft: { ...current.draft, id: candidate.id, name: candidate.name } }
                    : null),
            }));
            return false;
        }
        setSettings(result.settings);
        setState({ baseline: result.backend, draft: result.backend, identifiersEdited: true, errors: {} });
        if (isNew) setPendingHref(createCustomAcpAgentSettingsRoute(result.backend.id));
        return true;
    }, [effectiveDraft, identifiersFollowName, isNew, setSettings, settings]);

    const leave = React.useCallback(() => setPendingHref(AGENTS_ROUTE), []);
    // Set by delete: the page is leaving, so its agent disappearing is not "not found".
    const deletedRef = React.useRef(false);
    const discard = React.useCallback(() => {
        setState((current) => ({ ...current, draft: current.baseline, errors: {} }));
    }, []);
    useUnsavedDraftNavigationGuard({
        navigation,
        isDirty: dirty,
        onDiscard: discard,
        onSave: save,
        onLeave: leave,
        tag: 'AcpBackendEditorScreen.leave',
    });

    const remove = React.useCallback(async () => {
        if (!existing) return;
        const confirmed = await Modal.confirm(
            t('settingsAgents.customAcp.deleteTitle'),
            t('settingsAgents.customAcp.deleteConfirm', { name: existing.title || existing.name }),
            { destructive: true, cancelText: t('common.cancel'), confirmText: t('common.delete') },
        );
        if (!confirmed) return;
        const result = applyAcpBackendDeleteV1({ settings, backendId: existing.id });
        deletedRef.current = true;
        if (result.ok) setSettings(result.settings);
        setState((current) => ({ ...current, draft: current.baseline, errors: {} }));
        leave();
    }, [existing, leave, setSettings, settings]);
    const discardDraft = React.useCallback(() => {
        discard();
        leave();
    }, [discard, leave]);

    const menuActions = React.useMemo((): readonly PageHeaderMenuAction[] => (isNew
        ? [{ id: 'discard', title: t('settingsAgents.customAcp.discard'), onSelect: discardDraft }]
        : [{ id: 'delete', title: t('common.delete'), onSelect: remove }]), [discardDraft, isNew, remove]);

    if (!isNew && !existing) {
        if (deletedRef.current || !settingsLoaded) return null;
        return (
            <ItemList>
                <PageHeader
                    testID={`${TEST_ID}.header`}
                    alwaysShowTitle
                    title={props.backendId ?? ''}
                    description={t('settingsAgents.customAcp.notFound')}
                />
            </ItemList>
        );
    }

    const auth = draft.auth ?? { support: 'unsupported' as const };
    const updateAuth = (field: FieldKey | null, patch: Partial<NonNullable<Draft['auth']>>) => update(field, (current) => ({
        ...current,
        auth: { ...(current.auth ?? { support: 'unsupported' }), ...patch },
    }));

    return (
        <ItemList keyboardShouldPersistTaps="handled">
            <PageHeader
                testID={`${TEST_ID}.header`}
                alwaysShowTitle
                title={draft.title.trim() || (isNew ? t('settingsAgents.customAcp.newTitle') : existing?.name ?? '')}
                description={t('settingsAgents.customAcp.description')}
                details={errors.other || errors.env ? (
                    <Text
                        testID={`${TEST_ID}.error`}
                        accessibilityRole="alert"
                        accessibilityLiveRegion="polite"
                        style={{ color: theme.colors.state.danger.foreground, fontSize: 13, lineHeight: 18 }}
                    >
                        {errors.env ?? errors.other}
                    </Text>
                ) : undefined}
                leading={(
                    <PageHeaderMarkSlot>
                        <CustomAcpMarkIcon />
                    </PageHeaderMarkSlot>
                )}
                actions={(
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                        <RoundButton
                            testID={`${TEST_ID}.save`}
                            size="small"
                            title={t('common.save')}
                            disabled={!dirty && !isNew}
                            onPress={() => { save(); }}
                        />
                        <PageHeaderMenu testID={`${TEST_ID}.menu`} actions={menuActions} />
                    </View>
                )}
            />

            <ItemGroup
                title={t('settingsAgents.customAcp.agentSection')}
                description={t('settingsAgents.customAcp.agentSectionDescription')}
                action={isNew ? <AcpAgentAuthoringAction /> : undefined}
            >
                <Item
                    title={t('settingsAgents.customAcp.nameTitle')}
                    accessoryLayout="adaptive"
                    showChevron={false}
                    rightElement={(
                        <FieldTextInput
                            testID={`${TEST_ID}.title`}
                            value={draft.title}
                            onChangeText={(text) => update('title', (current) => ({ ...current, title: text }))}
                            accessibilityLabel={t('settingsAgents.customAcp.nameTitle')}
                            placeholder={t('settingsAgents.customAcp.namePlaceholder')}
                            autoCapitalize="words"
                            autoFocus={isNew}
                            error={errors.title}
                        />
                    )}
                />
                <Item
                    title={t('settingsAgents.customAcp.idTitle')}
                    subtitle={isNew
                        ? t('settingsAgents.customAcp.idDerivedDescription')
                        : t('settingsAgents.customAcp.idFixedDescription')}
                    subtitleLines={0}
                    detail={identifiersFollowName || !isNew ? (effectiveDraft.id || t('settingsAgents.customAcp.idPending')) : undefined}
                    // The field moves under the label when narrow; the short value and Edit stay beside it.
                    accessoryLayout={isNew && identifiersEdited ? 'adaptive' : 'inline'}
                    showChevron={false}
                    rightElement={isNew && identifiersEdited ? (
                        <FieldTextInput
                            testID={`${TEST_ID}.id`}
                            value={draft.id}
                            onChangeText={(text) => update('id', (current) => ({
                                ...current,
                                id: text,
                                // The short name follows the ID until the author sets it apart.
                                name: current.name === current.id ? text : current.name,
                            }))}
                            accessibilityLabel={t('settingsAgents.customAcp.idTitle')}
                            monospace
                            error={errors.id}
                        />
                    ) : identifiersEdited ? undefined : (
                        <RoundButton
                            testID={`${TEST_ID}.editId`}
                            size="small"
                            display="inverted"
                            title={t('common.edit')}
                            onPress={() => setState((current) => ({
                                ...current,
                                identifiersEdited: true,
                                draft: { ...current.draft, id: derivedId ?? current.draft.id, name: derivedId ?? current.draft.name },
                            }))}
                        />
                    )}
                />
                {identifiersEdited ? (
                    <Item
                        title={t('settingsAgents.customAcp.shortNameTitle')}
                        subtitle={t('settingsAgents.customAcp.shortNameDescription')}
                        subtitleLines={0}
                        accessoryLayout="adaptive"
                        showChevron={false}
                        rightElement={(
                            <FieldTextInput
                                testID={`${TEST_ID}.name`}
                                value={draft.name}
                                onChangeText={(text) => update('name', (current) => ({ ...current, name: text }))}
                                accessibilityLabel={t('settingsAgents.customAcp.shortNameTitle')}
                                monospace
                                error={errors.name}
                            />
                        )}
                    />
                ) : null}
                <Item
                    title={t('settingsAgents.customAcp.descriptionTitle')}
                    accessoryLayout="stacked"
                    showChevron={false}
                    rightElement={(
                        <FieldTextInput
                            testID={`${TEST_ID}.description`}
                            value={draft.description ?? ''}
                            onChangeText={(text) => update(null, (current) => ({ ...current, description: text || undefined }))}
                            accessibilityLabel={t('settingsAgents.customAcp.descriptionTitle')}
                            placeholder={t('settingsAgents.customAcp.optionalPlaceholder')}
                            autoCapitalize="sentences"
                            multiline
                        />
                    )}
                />
            </ItemGroup>

            <ItemGroup
                title={t('settingsAgents.customAcp.launchSection')}
                description={t('settingsAgents.customAcp.launchSectionDescription')}
            >
                <Item
                    title={t('settingsAgents.customAcp.commandTitle')}
                    accessoryLayout="adaptive"
                    showChevron={false}
                    rightElement={(
                        <FieldTextInput
                            testID={`${TEST_ID}.command`}
                            value={draft.command}
                            onChangeText={(text) => update('command', (current) => ({ ...current, command: text }))}
                            accessibilityLabel={t('settingsAgents.customAcp.commandTitle')}
                            placeholder="kiro-cli"
                            monospace
                            error={errors.command}
                        />
                    )}
                />
                <Item
                    title={t('settingsAgents.customAcp.argsTitle')}
                    subtitle={t('settingsAgents.customAcp.argsDescription')}
                    accessoryLayout="stacked"
                    showChevron={false}
                    rightElement={(
                        <StringListField
                            testID={`${TEST_ID}.args`}
                            values={draft.args}
                            onChange={(args) => update(null, (current) => ({ ...current, args }))}
                            itemLabel={(position) => t('settingsAgents.customAcp.argumentLabel', { position })}
                            removeLabel={(position) => t('settingsAgents.customAcp.removeArgument', { position })}
                            addLabel={t('settingsAgents.customAcp.addArgument')}
                            itemPlaceholder={t('settingsAgents.customAcp.argumentPlaceholder')}
                            monospace
                        />
                    )}
                />
                <OptionalTextRow
                    testID={`${TEST_ID}.defaultMode`}
                    title={t('settingsAgents.customAcp.defaultModeTitle')}
                    value={draft.defaultMode}
                    onChange={(value) => update(null, (current) => ({ ...current, defaultMode: value }))}
                />
                <OptionalTextRow
                    testID={`${TEST_ID}.defaultModel`}
                    title={t('settingsAgents.customAcp.defaultModelTitle')}
                    value={draft.defaultModel}
                    onChange={(value) => update(null, (current) => ({ ...current, defaultModel: value }))}
                />
            </ItemGroup>

            <McpValueRefMapEditor
                kind="env"
                title={t('settingsAgents.customAcp.environmentSection')}
                description={t('settingsAgents.customAcp.environmentSectionDescription')}
                iconName="flask"
                entries={draft.env}
                secrets={Array.isArray(secrets) ? secrets : []}
                onChangeSecrets={setSecrets as (next: any[]) => void}
                onChangeEntries={(next) => update('env', (current) => ({ ...current, env: next }))}
                addRowTitle={t('settingsAgents.customAcp.addVariable')}
                emptyTitle={t('settingsAgents.customAcp.noVariablesTitle')}
                emptySubtitle={t('settingsAgents.customAcp.noVariablesDescription')}
                testIdPrefix="settings.acpCatalog.backend.env"
            />

            <ItemGroup
                title={t('settingsAgents.customAcp.signInSection')}
                description={t('settingsAgents.customAcp.signInSectionDescription')}
            >
                <SignInMethodRow
                    value={auth.support}
                    onChange={(support) => updateAuth(null, { support })}
                />
                <Item
                    title={t('settingsAgents.customAcp.loginCommandTitle')}
                    accessoryLayout="adaptive"
                    showChevron={false}
                    rightElement={(
                        <FieldTextInput
                            testID={`${TEST_ID}.loginCommand`}
                            value={auth.loginCommand?.command ?? ''}
                            onChangeText={(text) => updateAuth(null, {
                                loginCommand: { command: text, args: auth.loginCommand?.args ?? [] },
                            })}
                            accessibilityLabel={t('settingsAgents.customAcp.loginCommandTitle')}
                            monospace
                        />
                    )}
                />
                <Item
                    title={t('settingsAgents.customAcp.loginArgsTitle')}
                    accessoryLayout="stacked"
                    showChevron={false}
                    rightElement={(
                        <StringListField
                            testID={`${TEST_ID}.loginArgs`}
                            values={auth.loginCommand?.args ?? []}
                            onChange={(args) => updateAuth(null, {
                                loginCommand: { command: auth.loginCommand?.command ?? '', args },
                            })}
                            itemLabel={(position) => t('settingsAgents.customAcp.argumentLabel', { position })}
                            removeLabel={(position) => t('settingsAgents.customAcp.removeArgument', { position })}
                            addLabel={t('settingsAgents.customAcp.addArgument')}
                            itemPlaceholder={t('settingsAgents.customAcp.argumentPlaceholder')}
                            monospace
                        />
                    )}
                />
                <Item
                    title={t('settingsAgents.customAcp.docsUrlTitle')}
                    subtitle={t('settingsAgents.customAcp.docsUrlDescription')}
                    accessoryLayout="adaptive"
                    showChevron={false}
                    rightElement={(
                        <FieldTextInput
                            testID={`${TEST_ID}.docsUrl`}
                            value={auth.docsUrl ?? ''}
                            onChangeText={(text) => updateAuth('docsUrl', { docsUrl: text || undefined })}
                            accessibilityLabel={t('settingsAgents.customAcp.docsUrlTitle')}
                            placeholder="https://"
                            keyboardType="url"
                            error={errors.docsUrl}
                        />
                    )}
                />
                <Item
                    title={t('settingsAgents.customAcp.machineLoginKeyTitle')}
                    subtitle={t('settingsAgents.customAcp.machineLoginKeyDescription')}
                    accessoryLayout="adaptive"
                    showChevron={false}
                    rightElement={(
                        <FieldTextInput
                            testID={`${TEST_ID}.machineLoginKey`}
                            value={auth.machineLoginKey ?? ''}
                            onChangeText={(text) => updateAuth(null, { machineLoginKey: text || undefined })}
                            accessibilityLabel={t('settingsAgents.customAcp.machineLoginKeyTitle')}
                            placeholder={t('settingsAgents.customAcp.optionalPlaceholder')}
                            monospace
                        />
                    )}
                />
            </ItemGroup>

            <ItemGroup
                title={t('settingsAgents.customAcp.capabilitiesSection')}
                description={t('settingsAgents.customAcp.capabilitiesSectionDescription')}
            >
                {CAPABILITY_ROWS.map((row) => (
                    <SegmentedChoiceItem<AcpCatalogSupportHintV1>
                        key={row.field}
                        testID={`${TEST_ID}.${row.field}`}
                        testIDPrefix={`${TEST_ID}.${row.field}`}
                        title={t(row.titleKey)}
                        value={draft.capabilities[row.field]}
                        options={SUPPORT_HINT_OPTIONS.map((option) => ({ id: option.value, label: t(option.labelKey) }))}
                        onChange={(value) => update(null, (current) => ({
                            ...current,
                            capabilities: { ...current.capabilities, [row.field]: value },
                        }))}
                    />
                ))}
            </ItemGroup>
        </ItemList>
    );
});

const CAPABILITY_ROWS = [
    { field: 'supportsModes', titleKey: 'settingsAgents.customAcp.supportsModes' },
    { field: 'supportsModels', titleKey: 'settingsAgents.customAcp.supportsModels' },
    { field: 'supportsConfigOptions', titleKey: 'settingsAgents.customAcp.supportsConfigOptions' },
    { field: 'promptImageSupport', titleKey: 'settingsAgents.customAcp.promptImages' },
] as const;

const SUPPORT_HINT_OPTIONS = [
    { value: 'unknown', labelKey: 'settingsAgents.customAcp.hintUnknown' },
    { value: 'yes', labelKey: 'settingsAgents.customAcp.hintYes' },
    { value: 'no', labelKey: 'settingsAgents.customAcp.hintNo' },
] as const;

const SIGN_IN_METHODS = [
    { id: 'login_terminal', labelKey: 'settingsAgents.customAcp.authLoginTerminal' },
    { id: 'status_only', labelKey: 'settingsAgents.customAcp.authStatusOnly' },
    { id: 'manual_only', labelKey: 'settingsAgents.customAcp.authManualOnly' },
    { id: 'unsupported', labelKey: 'settingsAgents.customAcp.authUnsupported' },
] as const satisfies ReadonlyArray<Readonly<{ id: AcpCatalogAuthSupportV1; labelKey: string }>>;

function CustomAcpMarkIcon() {
    const { theme } = useUnistyles();
    return <Icon name="hard-drives" size={22} color={theme.colors.text.secondary} />;
}

/** An optional single-line value: empty means the agent's own default. */
function OptionalTextRow(props: Readonly<{
    testID: string;
    title: string;
    value: string | undefined;
    onChange: (value: string | undefined) => void;
}>) {
    return (
        <Item
            title={props.title}
            accessoryLayout="adaptive"
            showChevron={false}
            rightElement={(
                <FieldTextInput
                    testID={props.testID}
                    value={props.value ?? ''}
                    onChangeText={(text) => props.onChange(text || undefined)}
                    accessibilityLabel={props.title}
                    placeholder={t('settingsAgents.customAcp.agentDefaultPlaceholder')}
                />
            )}
        />
    );
}

function SignInMethodRow(props: Readonly<{
    value: AcpCatalogAuthSupportV1;
    onChange: (value: AcpCatalogAuthSupportV1) => void;
}>) {
    const [open, setOpen] = React.useState(false);
    const items = React.useMemo((): DropdownMenuItem[] => SIGN_IN_METHODS.map((method) => ({
        id: method.id,
        title: t(method.labelKey),
    })), []);
    return (
        <DropdownMenu
            testID={`${TEST_ID}.authSupport`}
            open={open}
            onOpenChange={setOpen}
            variant="selectable"
            search={false}
            selectedId={props.value}
            showCategoryTitles={false}
            matchTriggerWidth={true}
            connectToTrigger={true}
            rowKind="item"
            itemTrigger={{ title: t('settingsAgents.customAcp.signInMethodTitle') }}
            items={items}
            onSelect={(id) => props.onChange(id as AcpCatalogAuthSupportV1)}
        />
    );
}

/**
 * "Use an agent to configure": a New Session asks what to run and saves it through
 * `agents.acp.backends.upsert`. Without a machine to run that session, it opens machine setup.
 */
function AcpAgentAuthoringAction() {
    const { theme } = useUnistyles();
    const targetSelection = useAgentsAdministrationTargetSelection();
    const { executionTarget } = useAgentsMachineScope(targetSelection);
    const authoring = useAgentAuthoringEntry({ targetSelection, executionTarget });
    return (
        <RoundButton
            testID={`${TEST_ID}.useAgent`}
            size="small"
            display="inverted"
            title={t('settingsAgents.authoring.useAgentToConfigure')}
            accessibilityHint={authoring.available
                ? t('settingsAgents.authoring.useAgentToConfigureDescription')
                : t('settingsAgents.authoring.needsMachine')}
            leading={<Icon name="sparkle" size={14} color={theme.colors.text.secondary} />}
            onPress={() => authoring.open('configureAcpBackend')}
        />
    );
}
