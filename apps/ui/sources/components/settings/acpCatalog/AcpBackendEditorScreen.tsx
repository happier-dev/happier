import * as React from 'react';
import { View } from 'react-native';
import { useNavigation, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useUnistyles } from 'react-native-unistyles';

import { AgentsAcpBackendsDeleteOutputV1Schema, AgentsAcpBackendsUpsertOutputV1Schema, applyAcpBackendUpsertV1, suggestAcpBackendIdV1, type AcpBackendUpsertResultV1 } from '@happier-dev/protocol/acp/catalog/catalogMutationsV1';
import type { AcpCatalogSnapshotV1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import type { AcpBackendDefinitionV1, AcpCatalogAuthSupportV1, AcpCatalogSupportHintV1 } from '@happier-dev/protocol/acp/catalog/settingsV1';

import { createCustomAcpAgentSettingsRoute } from '@/agents/catalog/agentSettingsRoutes';
import { useSavedSecretCatalog } from '@/components/secrets/useSavedSecretCatalog';
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
import { useAcpCatalog } from '@/sync/store/useAcpCatalog';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { areAccountSettingsScopesEqual } from '@/sync/domains/settings/scope/accountSettingsScope';
import { getStorage } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { useUnsavedDraftNavigationGuard } from '@/utils/navigation/useUnsavedDraftNavigationGuard';

import { createDraftAcpBackend } from './createDraftAcpBackend';
import { useAcpCatalogActionExecution } from './useAcpCatalogActionExecution';
import { useHappierCollectionLayout } from '@happier-dev/plugin-ui/presentation';

const TEST_ID = 'settings.acpCatalog.backendEditor';
const AGENTS_ROUTE = '/(app)/settings/agents';
const NO_PERSONAL_SECRETS = Object.freeze([]);

type Draft = AcpBackendDefinitionV1;
/** An authored field a refusal can point at. `other` collects fields without a row of their own. */
type FieldKey = 'title' | 'id' | 'name' | 'command' | 'docsUrl' | 'env' | 'other';
type FieldErrors = Partial<Record<FieldKey, string>>;
type DraftAuthority = Readonly<{ expectedRevision: number }> | Readonly<{ expectedRevision: 'absent'; sourceSettingsVersion: number }>;

function captureDraftAuthority(catalog: AcpCatalogSnapshotV1 | undefined): DraftAuthority | null {
    if (catalog?.status !== 'ready') return null;
    return catalog.revision === 'absent'
        ? { expectedRevision: 'absent', sourceSettingsVersion: catalog.sourceSettingsVersion }
        : { expectedRevision: catalog.revision };
}

type EditorState = Readonly<{
    /** What is stored (or the blank draft): the draft is dirty when it differs from this. */
    baseline: Draft;
    draft: Draft;
    /** A new agent's ID and short name follow its name until the author edits them. */
    identifiersEdited: boolean;
    errors: FieldErrors;
    authority: DraftAuthority | null;
}>;

function comparable(draft: Draft): string {
    const { createdAt: _createdAt, updatedAt: _updatedAt, ...rest } = draft;
    return JSON.stringify(rest);
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

function createInitialState(existing: Draft | null, authority: DraftAuthority | null): EditorState {
    const baseline = existing ?? createDraftAcpBackend();
    return { baseline, draft: baseline, identifiersEdited: existing !== null, errors: {}, authority };
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
    const activeScope = useAccountSettingsScope();
    const [capturedScope, setCapturedScope] = React.useState(activeScope);
    React.useEffect(() => { if (!capturedScope && activeScope) setCapturedScope(activeScope); }, [activeScope, capturedScope]);
    const { snapshot } = useAcpCatalog(capturedScope);
    const action = useAcpCatalogActionExecution(capturedScope);
    const isEditorCurrent = React.useCallback(() => Boolean(capturedScope && action.isCurrent()
        && areAccountSettingsScopesEqual(getStorage().getState().settingsScope, capturedScope)), [action.isCurrent, capturedScope]);
    const settingsLoaded = areAccountSettingsScopesEqual(activeScope, capturedScope)
        && snapshot?.catalog.status === 'ready' && !snapshot.stale && isEditorCurrent();
    const currentAuthority = React.useMemo(() => snapshot && !snapshot.stale
        ? captureDraftAuthority(snapshot.catalog) : null, [snapshot]);
    const executeAction = action.execute;
    const secretCatalog = useSavedSecretCatalog({ scope: capturedScope, personalSecrets: NO_PERSONAL_SECRETS });
    const secrets = React.useMemo(() => [...secretCatalog.materializedSecrets], [secretCatalog.materializedSecrets]);
    const settings = React.useMemo(() => ({ v: 2 as const, backends: snapshot?.data?.definitions ?? [] }), [snapshot?.data]);
    const [state, setState] = React.useState<EditorState>(() => createInitialState(
        props.backendId ? settings.backends.find((entry) => entry.id === props.backendId) ?? null : null,
        currentAuthority,
    ));
    // A create's acknowledged baseline supplies identity while newer unsaved edits stay mounted.
    const backendId = props.backendId ?? (state.baseline.id || null);
    const isNew = backendId === null;
    const { draft, baseline, identifiersEdited, errors, authority } = state;
    const existing = React.useMemo(() => {
        const stored = backendId ? settings.backends.find((entry) => entry.id === backendId) ?? null : null;
        if (stored || props.backendId !== null || baseline.id !== backendId || typeof authority?.expectedRevision !== 'number') return stored;
        // Refresh can fail after the durable create ACK. Keep its editor visible until the
        // catalog observes that revision; readiness still comes solely from the catalog.
        const catalog = snapshot?.catalog;
        return catalog?.status !== 'ready' || catalog.revision === 'absent' || catalog.revision < authority.expectedRevision
            ? baseline : null;
    }, [authority, backendId, baseline, props.backendId, settings.backends, snapshot?.catalog]);
    const dirty = comparable(draft) !== comparable(baseline);
    // A synced change to the stored agent replaces an untouched editor; it never overwrites edits.
    React.useEffect(() => {
        if (!currentAuthority) return;
        setState((current) => {
            if (comparable(current.draft) !== comparable(current.baseline)) {
                return current.authority ? current : { ...current, authority: currentAuthority };
            }
            const baseline = existing ?? current.baseline;
            return baseline === current.baseline && JSON.stringify(current.authority) === JSON.stringify(currentAuthority)
                ? current : { ...current, baseline, draft: baseline, authority: currentAuthority };
        });
    }, [currentAuthority, dirty, existing]);

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
        // The saved route remounts this editor: wait until newer edits are saved or discarded.
        if (pendingHref !== AGENTS_ROUTE && dirty) return;
        setPendingHref(null);
        if (pendingHref === AGENTS_ROUTE && layoutMode === 'stacked' && router.canGoBack?.()) {
            router.back();
            return;
        }
        router.replace(pendingHref as never);
    }, [dirty, layoutMode, pendingHref, router]);

    const save = React.useCallback(async (): Promise<boolean> => {
        if (!settingsLoaded || !authority || !capturedScope || !isEditorCurrent()) return false;
        const candidate: Draft = {
            ...effectiveDraft,
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
        let saved: Draft;
        let acknowledgedAuthority: DraftAuthority;
        try {
            const execution = await executeAction('agents.acp.backends.upsert', { backend: candidate, ...authority });
            if (!execution.ok) throw new Error(execution.errorCode);
            const receipt = AgentsAcpBackendsUpsertOutputV1Schema.parse(execution.result);
            saved = receipt.backend;
            acknowledgedAuthority = { expectedRevision: receipt.revision };
        }
        catch {
            if (isEditorCurrent()) setState((current) => ({ ...current, errors: { ...current.errors, other: t('common.unavailable') } }));
            return false;
        }
        if (!isEditorCurrent()) return false;
        setState((current) => ({ ...current, baseline: saved,
            draft: comparable(current.draft) !== comparable(draft)
                ? { ...current.draft, id: saved.id, ...(!current.identifiersEdited ? { name: saved.name } : {}) }
                : saved,
            identifiersEdited: true, errors: {}, authority: acknowledgedAuthority }));
        if (isNew) setPendingHref(createCustomAcpAgentSettingsRoute(saved.id));
        return true;
    }, [authority, capturedScope, draft, effectiveDraft, executeAction, identifiersFollowName, isEditorCurrent, isNew, settings, settingsLoaded]);

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
        if (!existing || !authority || !capturedScope || !settingsLoaded || !isEditorCurrent()) return;
        const confirmed = await Modal.confirm(
            t('settingsAgents.customAcp.deleteTitle'),
            t('settingsAgents.customAcp.deleteConfirm', { name: existing.title || existing.name }),
            { destructive: true, cancelText: t('common.cancel'), confirmText: t('common.delete') },
        );
        if (!confirmed || !isEditorCurrent()) return;
        try {
            const execution = await executeAction('agents.acp.backends.delete', { backendId: existing.id, ...authority });
            if (!execution.ok) throw new Error(execution.errorCode);
            AgentsAcpBackendsDeleteOutputV1Schema.parse(execution.result);
        }
        catch { if (isEditorCurrent()) Modal.alert(t('common.error'), t('common.unavailable')); return; }
        if (!isEditorCurrent()) return;
        deletedRef.current = true;
        setState((current) => ({ ...current, draft: current.baseline, errors: {} }));
        leave();
    }, [authority, capturedScope, executeAction, existing, isEditorCurrent, leave, settingsLoaded]);
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
                primaryAction={{
                    testID: `${TEST_ID}.save`,
                    title: t('common.save'),
                    disabled: !settingsLoaded || (!dirty && !isNew),
                    onPress: save,
                }}
                actions={(
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
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
                    // The generated ID and Edit action recompose together, just like the editable field.
                    accessoryLayout={isNew ? 'adaptive' : 'inline'}
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
                scope={capturedScope}
                title={t('settingsAgents.customAcp.environmentSection')}
                description={t('settingsAgents.customAcp.environmentSectionDescription')}
                iconName="flask"
                entries={draft.env}
                secrets={secrets}
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
