import * as React from 'react';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { RoleArtifactV1Schema, renderSessionRoleBlockV1 } from '@happier-dev/protocol';
import type {
    ExecutionRunIntent,
    ResolvedRoleV1,
    RoleArtifactV1,
    RoleEngineV1,
    RoleInstructionsOverrideV1,
    RoleRunsAsV1,
} from '@happier-dev/protocol';

import { invalidateRoleCatalog, useRoleCatalog } from '@/components/roles/catalog/useRoleCatalog';
import { useRoleEnginePresentation } from '@/components/roles/catalog/useRoleEnginePresentation';
import { showDocumentShareSheet } from '@/components/sharing/documents/showDocumentShareSheet';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { Switch } from '@/components/ui/forms/Switch';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { PageHeader, type PageHeaderMetaFact } from '@/components/ui/layout/PageHeader';
import { PageHeaderMarkSlot } from '@/components/ui/layout/PageHeaderMarkSlot';
import { PageHeaderMenu, type PageHeaderMenuAction } from '@/components/ui/layout/PageHeaderEntityParts';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Modal } from '@/modal';
import type { RoleCatalogEntry } from '@/sync/domains/roles/roleCatalog';
import { documentFileName, saveWorkflowDocument } from '@/sync/domains/workflows/workflowDocumentFile';
import { useSetting } from '@/sync/domains/state/storage';
import { useAiLaunchProfilesForLegacyUi } from '@/sync/store/useAiLaunchProfiles';
import { roleActions } from '@/sync/ops/roles/roleActions';
import { t } from '@/text';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { RoleEngineField } from '@/components/roles/engine/RoleEngineField';
import { ROLES_COLLECTION_ROOT, recordRoleCollectionVisit, roleDraftTitle, roleRoute } from './roleCollectionRoutes';

export type RoleDetailTarget = Readonly<{ kind: 'role'; roleId: string }> | Readonly<{ kind: 'draft' }>;

/** A user role's fields a page edits, or the override fields of a built-in, plugin or shared role. */
type RolePatch = Partial<Pick<RoleArtifactV1, 'name' | 'instructions' | 'engine' | 'runsAs' | 'profileId' | 'workspaceWrites' | 'secondOpinion' | 'enabled'>>;

const DEFAULT_BACKGROUND_INTENT: ExecutionRunIntent = 'task';

function leave(router: ReturnType<typeof useRouter>, href: string, tag: string) {
    const result = runGuardedNavigation(() => router.replace(href as never));
    if (result !== true) fireAndForget(result, { tag });
}

/**
 * "Send a copy instead": the role as its portable `role.v1` document — the same body its Artifact
 * holds — handed to the platform's file save or share sheet. No grant is made.
 */
async function sendRoleCopy(role: ResolvedRoleV1): Promise<void> {
    const { roleId: _roleId, changedAt: _changedAt, profileUnavailable: _profileUnavailable, ...artifact } = role;
    try {
        const document = RoleArtifactV1Schema.parse(artifact);
        await saveWorkflowDocument({ fileName: documentFileName(document.name, 'role'), json: JSON.stringify(document, null, 2) });
    } catch {
        Modal.alert(t('roles.settings.sendCopyFailed'));
    }
}

async function reportFailure(result: Readonly<{ ok: boolean; error?: string }>): Promise<boolean> {
    if (result.ok) {
        invalidateRoleCatalog();
        return true;
    }
    await Modal.alertAsync(t('roles.settings.saveFailed'), result.error ?? '');
    return false;
}

/**
 * One role in Settings › Roles: its identity, its instructions, how it runs and its Launch profile.
 * Built-in, plugin and shared roles save the reader's changes as a `rolesV1` override (Reset removes
 * it); the reader's own roles save to their Artifact under its revision.
 */
export const RoleDetailScreen = React.memo(function RoleDetailScreen(props: Readonly<{ target: RoleDetailTarget }>) {
    const catalog = useRoleCatalog();
    if (props.target.kind === 'draft') return <RoleDraft />;
    const roleId = props.target.roleId;
    const entry = catalog.entries.find((candidate) => candidate.roleId === roleId) ?? null;
    if (!entry) {
        return (
            <ItemList>
                <SurfaceStateCard
                    testID="settings.roles.detail.unavailable"
                    kind={catalog.status === 'failed' ? 'error' : catalog.status === 'loading' ? 'loading' : 'unavailable'}
                    title={catalog.status === 'failed' ? t('roles.settings.loadFailed') : t('roles.settings.emptyDetailTitle')}
                    reason={catalog.status === 'failed' ? undefined : t('roles.settings.emptyDetailBody')}
                    action={catalog.status === 'failed' ? { label: t('common.retry'), onPress: catalog.refresh } : undefined}
                />
            </ItemList>
        );
    }
    return <RoleDetail key={entry.roleId} entry={entry} catalog={catalog.entries} />;
});

const RoleDetail = React.memo(function RoleDetail(props: Readonly<{ entry: RoleCatalogEntry; catalog: ReadonlyArray<RoleCatalogEntry> }>) {
    const { entry } = props;
    const { role } = entry;
    const router = useRouter();
    const presentEngine = useRoleEnginePresentation();
    const engine = presentEngine(role.engine);
    const headerEngine = presentEngine(role.engine, 28);
    // Your own roles and roles shared with you to edit save to their Artifact; everything else is an override.
    const ownRole = (entry.source === 'user' || entry.source === 'shared') && !entry.viewOnly && entry.revision !== undefined;

    React.useEffect(() => { recordRoleCollectionVisit(entry.roleId); }, [entry.roleId]);

    const commit = React.useCallback(async (patch: RolePatch) => {
        if (ownRole && entry.revision) {
            const { roleId: _roleId, changedAt: _changedAt, profileUnavailable: _profileUnavailable, ...base } = role;
            return reportFailure(await roleActions.update(entry.roleId, { ...base, ...patch }, entry.revision));
        }
        const { instructions, name: _name, enabled: _enabled, ...fields } = patch;
        const next: RoleInstructionsOverrideV1 = {
            ...(entry.override ?? { roleId: entry.roleId }),
            ...fields,
            ...(instructions !== undefined ? { instructionsOverride: instructions } : {}),
            roleId: entry.roleId,
        };
        return reportFailure(await roleActions.setOverride(next));
    }, [entry.override, entry.revision, entry.roleId, ownRole, role]);

    const menuActions = React.useMemo((): readonly PageHeaderMenuAction[] => [
        ...(entry.override ? [{
            id: 'reset',
            title: t('roles.settings.resetToDefault'),
            testID: 'settings.roles.detail.reset',
            onSelect: async () => { await reportFailure(await roleActions.resetOverride(entry.roleId)); },
        }] : []),
        // A user/shared role's id is its Artifact id; the sheet owns grant permissions.
        ...((entry.source === 'user' || entry.source === 'shared') && entry.roleId ? [{
            id: 'share',
            title: t('roles.settings.share'),
            testID: 'settings.roles.detail.share',
            onSelect: () => showDocumentShareSheet({
                kind: 'role.v1',
                artifactId: entry.roleId,
                name: role.name,
                subtitle: `${engine.label} · ${t(role.runsAs.kind === 'session' ? 'roles.settings.runsAsSession' : 'roles.settings.runsAsBackgroundRun')}`,
                linkPath: roleRoute(entry.roleId),
                onSendCopy: () => { void sendRoleCopy(role); },
            }),
        }] : []),
        ...(ownRole && entry.source === 'user' && entry.revision ? [{
            id: 'delete',
            title: t('roles.settings.deleteRole'),
            destructive: true,
            testID: 'settings.roles.detail.delete',
            onSelect: async () => {
                const confirmed = await Modal.confirm(
                    t('roles.settings.deleteConfirmTitle'),
                    t('roles.settings.deleteConfirmBody', { name: role.name }),
                    { confirmText: t('common.delete'), destructive: true },
                );
                if (!confirmed || !entry.revision) return;
                if (await reportFailure(await roleActions.remove(entry.roleId, entry.revision))) {
                    leave(router, ROLES_COLLECTION_ROOT, 'RoleDetail.deleted');
                }
            },
        }] : []),
    ], [engine.label, entry.override, entry.revision, entry.roleId, entry.source, ownRole, role, router]);

    const meta: PageHeaderMetaFact[] = [
        { key: 'source', text: describeSource(entry) },
        ...(entry.override ? [{ key: 'edited', text: t('roles.settings.edited') }] : []),
        ...(entry.migratedFromV0_2 ? [{ key: 'migrated', text: t('roles.settings.migrated') }] : []),
    ];

    return (
        <ItemList testID={`settings.roles.detail.${entry.roleId}`}>
            <PageHeader
                title={role.name}
                meta={meta}
                leading={headerEngine.icon ? <PageHeaderMarkSlot>{headerEngine.icon}</PageHeaderMarkSlot> : undefined}
                actions={menuActions.length > 0 ? <PageHeaderMenu actions={menuActions} testID="settings.roles.detail.menu" /> : undefined}
                alwaysShowTitle
            />
            {ownRole ? (
                <ItemGroup title={t('roles.settings.nameTitle')}>
                    <SectionContentRow>
                        <CommitOnBlurField
                            testID="settings.roles.detail.name"
                            value={role.name}
                            accessibilityLabel={t('roles.settings.nameTitle')}
                            onCommit={(name) => { if (name.trim()) void commit({ name: name.trim() }); }}
                        />
                    </SectionContentRow>
                </ItemGroup>
            ) : null}
            <ItemGroup
                title={t('roles.settings.instructionsTitle')}
                description={entry.viewOnly ? t('roles.settings.readOnlyNote') : t('roles.settings.instructionsDescription')}
            >
                <SectionContentRow>
                    <CommitOnBlurField
                        testID="settings.roles.detail.instructions"
                        value={role.instructions}
                        multiline
                        minLines={6}
                        editable={!entry.viewOnly}
                        accessibilityLabel={t('roles.settings.instructionsTitle')}
                        onCommit={(instructions) => { void commit({ instructions }); }}
                    />
                </SectionContentRow>
            </ItemGroup>
            <ItemGroup title={t('roles.settings.howItRunsTitle')}>
                <Item
                    testID="settings.roles.detail.engine"
                    title={t('roles.settings.engineTitle')}
                    subtitle={engine.unavailable && role.engine
                        ? t('roles.settings.engineUnavailable')
                        : role.engine ? t('roles.settings.engineDescription') : t('roles.settings.engineFollowsDefault')}
                    accessoryLayout="adaptive"
                    showChevron={false}
                    rightElement={(
                        <RoleEngineField
                            testID="settings.roles.detail.engine.field"
                            engine={role.engine}
                            label={engine.label}
                            leading={engine.icon}
                            onChange={(next: RoleEngineV1) => { void commit({ engine: next }); }}
                        />
                    )}
                />
                <SegmentedChoiceItem<'session' | 'background_run'>
                    testIDPrefix="settings.roles.detail.runsAs"
                    title={t('roles.settings.runsAsTitle')}
                    value={role.runsAs.kind}
                    options={[
                        { id: 'session', label: t('roles.settings.runsAsSession'), description: t('roles.settings.runsAsSessionDescription') },
                        { id: 'background_run', label: t('roles.settings.runsAsBackgroundRun'), description: t('roles.settings.runsAsBackgroundDescription') },
                    ]}
                    onChange={(kind) => {
                        const runsAs: RoleRunsAsV1 = kind === 'session'
                            ? { kind: 'session' }
                            : { kind: 'background_run', intent: DEFAULT_BACKGROUND_INTENT };
                        void commit({ runsAs });
                    }}
                />
                <Item
                    testID="settings.roles.detail.handsOff"
                    title={t('roles.settings.handsOffTitle')}
                    subtitle={t('roles.settings.handsOffDescription')}
                    showChevron={false}
                    rightElement={(
                        <Switch
                            value={role.workspaceWrites === 'deny'}
                            onValueChange={(on) => { void commit({ workspaceWrites: on ? 'deny' : 'allow' }); }}
                        />
                    )}
                />
                <SegmentedChoiceItem<'off' | 'encouraged'>
                    testIDPrefix="settings.roles.detail.secondOpinion"
                    title={t('roles.settings.secondOpinionTitle')}
                    subtitle={t('roles.settings.secondOpinionDescription')}
                    value={role.secondOpinion}
                    options={[
                        { id: 'off', label: t('roles.settings.secondOpinionOff') },
                        { id: 'encouraged', label: t('roles.settings.secondOpinionEncouraged') },
                    ]}
                    onChange={(secondOpinion) => { void commit({ secondOpinion }); }}
                />
                {ownRole ? (
                    <Item
                        testID="settings.roles.detail.enabled"
                        title={t('roles.settings.enabledTitle')}
                        subtitle={t('roles.settings.enabledDescription')}
                        showChevron={false}
                        rightElement={<Switch value={role.enabled} onValueChange={(enabled) => { void commit({ enabled }); }} />}
                    />
                ) : null}
            </ItemGroup>
            <RolePreview entry={entry} catalog={props.catalog} />
            <ItemGroup title={t('roles.settings.advancedTitle')}>
                <RoleLaunchProfileRow
                    profileId={role.profileId ?? null}
                    unavailable={role.profileUnavailable === true}
                    onChange={(profileId) => { void commit({ profileId: profileId ?? undefined }); }}
                />
            </ItemGroup>
        </ItemList>
    );
});

/** The block an agent receives as session instructions, from the one role renderer — the preview is the prompt. */
function RolePreview(props: Readonly<{ entry: RoleCatalogEntry; catalog: ReadonlyArray<RoleCatalogEntry> }>) {
    const block = React.useMemo(() => renderSessionRoleBlockV1({
        role: props.entry.role,
        source: 'dispatch',
        availableRoles: props.catalog.map((entry) => entry.role),
    }), [props.catalog, props.entry.role]);
    return (
        <ItemGroup title={t('roles.settings.previewTitle')} description={t('roles.settings.previewDescription')}>
            <SectionContentRow testID="settings.roles.detail.preview">
                <FieldTextInput
                    testID="settings.roles.detail.preview.block"
                    value={block}
                    onChangeText={() => {}}
                    accessibilityLabel={t('roles.settings.previewTitle')}
                    editable={false}
                    multiline
                    monospace
                    minLines={6}
                />
            </SectionContentRow>
        </ItemGroup>
    );
}

function describeSource(entry: RoleCatalogEntry): string {
    switch (entry.source) {
        case 'built_in': return t('roles.settings.sourceBuiltIn');
        case 'user': return t('roles.settings.sourceYours');
        case 'shared': return t('roles.settings.sourceShared');
        case 'plugin': return t('roles.settings.sourcePlugin', { plugin: entry.pluginId ?? '' });
    }
}

const NO_PROFILE_ID = '__none__';

/** Advanced › Launch profile: a field select over the reader's profiles; a missing one says so. */
function RoleLaunchProfileRow(props: Readonly<{
    profileId: string | null;
    unavailable: boolean;
    onChange: (profileId: string | null) => void;
}>) {
    const profiles = useAiLaunchProfilesForLegacyUi(useSetting('profiles'));
    const [open, setOpen] = React.useState(false);
    const items = React.useMemo(() => [
        { id: NO_PROFILE_ID, title: t('roles.settings.launchProfileNone') },
        ...profiles.map((profile) => ({ id: profile.id, title: profile.name })),
    ], [profiles]);
    const known = props.profileId !== null && profiles.some((profile) => profile.id === props.profileId);
    return (
        <DropdownMenu
            open={open}
            onOpenChange={setOpen}
            items={items}
            selectedId={props.profileId === null ? NO_PROFILE_ID : known ? props.profileId : null}
            onSelect={(id) => props.onChange(id === NO_PROFILE_ID ? null : id)}
            itemTrigger={{
                title: t('roles.settings.launchProfileTitle'),
                subtitle: props.profileId !== null && (props.unavailable || !known)
                    ? t('roles.settings.profileUnavailable')
                    : t('roles.settings.launchProfileDescription'),
            }}
        />
    );
}

/** A page text field whose draft commits when focus leaves it. */
function CommitOnBlurField(props: Readonly<{
    value: string;
    onCommit: (value: string) => void;
    accessibilityLabel: string;
    multiline?: boolean;
    minLines?: number;
    editable?: boolean;
    placeholder?: string;
    testID?: string;
    onDraftChange?: (value: string) => void;
}>) {
    const [draft, setDraft] = React.useState(props.value);
    const lastValueRef = React.useRef(props.value);
    if (lastValueRef.current !== props.value) {
        lastValueRef.current = props.value;
        setDraft(props.value);
    }
    return (
        <FieldTextInput
            testID={props.testID}
            value={draft}
            onChangeText={(next) => { setDraft(next); props.onDraftChange?.(next); }}
            onBlur={() => { if (draft !== props.value) props.onCommit(draft); }}
            accessibilityLabel={props.accessibilityLabel}
            multiline={props.multiline}
            minLines={props.minLines}
            editable={props.editable}
            placeholder={props.placeholder}
        />
    );
}

/** A new role: its name and instructions, created as your own role. */
const RoleDraft = React.memo(function RoleDraft() {
    const router = useRouter();
    const [name, setName] = React.useState('');
    const [instructions, setInstructions] = React.useState('');
    const [saving, setSaving] = React.useState(false);
    React.useEffect(() => () => { roleDraftTitle.publish(''); }, []);
    const create = async () => {
        setSaving(true);
        const result = await roleActions.create({
            name: name.trim() || t('roles.settings.newRoleName'),
            instructions,
            runsAs: { kind: 'session' },
            workspaceWrites: 'allow',
            secondOpinion: 'off',
            enabled: true,
        });
        setSaving(false);
        if (await reportFailure(result)) leave(router, ROLES_COLLECTION_ROOT, 'RoleDraft.created');
    };
    return (
        <ItemList testID="settings.roles.draft">
            <PageHeader
                title={name.trim() || t('roles.settings.newRoleName')}
                alwaysShowTitle
                primaryAction={{ title: t('roles.settings.newRole'), onPress: create, loading: saving, testID: 'settings.roles.draft.create' }}
                cancelAction={{ title: t('common.cancel'), onPress: () => leave(router, ROLES_COLLECTION_ROOT, 'RoleDraft.cancel') }}
            />
            <ItemGroup title={t('roles.settings.nameTitle')}>
                <SectionContentRow>
                    <FieldTextInput
                        testID="settings.roles.draft.name"
                        value={name}
                        onChangeText={(next) => { setName(next); roleDraftTitle.publish(next); }}
                        accessibilityLabel={t('roles.settings.nameTitle')}
                        placeholder={t('roles.settings.newRoleName')}
                        autoFocus
                    />
                </SectionContentRow>
            </ItemGroup>
            <ItemGroup title={t('roles.settings.instructionsTitle')} description={t('roles.settings.instructionsDescription')}>
                <SectionContentRow>
                    <FieldTextInput
                        testID="settings.roles.draft.instructions"
                        value={instructions}
                        onChangeText={setInstructions}
                        accessibilityLabel={t('roles.settings.instructionsTitle')}
                        multiline
                        minLines={6}
                    />
                </SectionContentRow>
            </ItemGroup>
        </ItemList>
    );
});
