import * as React from 'react';
import { View } from 'react-native';
import { useNavigation, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { StyleSheet } from 'react-native-unistyles';
import {
    ActionApprovalRequestCreatedResultSchema,
    LaunchProfileArtifactReferenceV1Schema,
    isLaunchProfileV2,
    readLaunchProfileArtifactV1,
    type AiLaunchProfile,
} from '@happier-dev/protocol';

import { LaunchProfileEditForm } from '@/components/profiles/edit';
import { isBuiltInLaunchProfile } from '@/components/profiles/edit/launchProfileSave';
import { promptLaunchProfileUnsavedChanges, useSaveLaunchProfile } from '@/components/profiles/edit/useSaveLaunchProfile';
import { LegacyProfileMigrationConflictFlow } from '@/components/profiles/migration/LegacyProfileMigrationConflictFlow';
import { LegacyProfileMigrationFlow } from '@/components/profiles/migration/LegacyProfileMigrationFlow';
import { resolveProfileMigrationConflict } from '@/components/profiles/migration/status';
import { getProfileDisplayName } from '@/components/profiles/profileDisplay';
import { useProfilesListModel } from '@/components/profiles/useProfilesListModel';
import { ProfileCompatibilityIcon } from '@/components/sessions/new/components/ProfileCompatibilityIcon';
import { MachineAdministrationTargetSelector } from '@/components/settings/machines/MachineAdministrationTargetSelector';
import { showDocumentShareSheet } from '@/components/sharing/documents/showDocumentShareSheet';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { PageHeader, type PageHeaderMetaFact } from '@/components/ui/layout/PageHeader';
import { PageHeaderMarkSlot } from '@/components/ui/layout/PageHeaderMarkSlot';
import { PageHeaderMenu, PageHeaderStateSwitch, type PageHeaderMenuAction } from '@/components/ui/layout/PageHeaderEntityParts';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Modal } from '@/modal';
import type { AIBackendProfile } from '@/sync/domains/profiles/profileCompatibility';
import { createEmptyCustomProfile, duplicateProfileForEdit } from '@/sync/domains/profiles/profileMutations';
import { hasRequiredSecret } from '@/sync/domains/profiles/profileSecrets';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
// The same store the profile readers hydrate published documents from.
import { getStorage } from '@/sync/domains/state/storageStore';
import { documentFileName, saveWorkflowDocument } from '@/sync/domains/workflows/workflowDocumentFile';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { t } from '@/text';
import { useUnsavedChangesBeforeRemoveGuard } from '@/utils/navigation/useUnsavedChangesBeforeRemoveGuard';

import { openProfileCollectionHref } from './ProfileCollectionList';
import { newProfileRoute, PROFILES_COLLECTION_ROOT, profileRoute, publishProfileDraftTitle } from './profileCollectionRoutes';
import { useProfilesCollection, type ProfilesCollection } from './useProfilesCollection';
import { createHappierCollectionDraftTitleStore, type HappierCollectionDraftTitleStore } from '@happier-dev/plugin-ui/presentation';

export type ProfileDetailTarget =
    | Readonly<{ kind: 'profile'; profileId: string }>
    | Readonly<{ kind: 'draft'; cloneFrom: string | null }>;

type MigrationView = 'review' | 'conflict' | null;

let executeAction: ReturnType<typeof createFrontDoorActionExecute> | null = null;

/**
 * A saved inline profile becomes shareable by moving it, value-free, into its own Artifact
 * (`launch_profiles.publish`, a person's Action on this exact Home). Returns the Artifact id, or null
 * when publishing was refused (a secret value says how to fix it) or waits for an approval.
 */
async function publishLaunchProfileForShare(
    profileId: string,
    serverId: string | null,
    openApproval: (artifactId: string) => void,
): Promise<string | null> {
    executeAction ??= createFrontDoorActionExecute();
    const result = await executeAction('launch_profiles.publish', { profileId }, {
        surface: 'ui',
        authority: 'present_user',
        ...(serverId ? { serverId } : {}),
    });
    if (!result.ok) {
        const secretValues = result.errorCode === 'profile_contains_secret_values' || result.error === 'profile_contains_secret_values';
        if (secretValues) Modal.alert(t('roles.profiles.shareFailedTitle'), t('roles.profiles.shareNeedsSavedSecrets'));
        else Modal.alert(t('roles.profiles.shareFailedTitle'));
        return null;
    }
    // An Action setting can ask for approval first: the profile is published once it is approved,
    // and Share… then opens the sheet directly.
    const approval = ActionApprovalRequestCreatedResultSchema.safeParse(result.result);
    if (approval.success) {
        Modal.alert(t('approvals.title'), t('roles.profiles.shareAwaitingApproval'), [
            { text: t('approvals.details'), onPress: () => openApproval(approval.data.artifactId) },
            { text: t('common.ok') },
        ]);
        return null;
    }
    const published = LaunchProfileArtifactReferenceV1Schema.safeParse(result.result);
    if (!published.success) {
        Modal.alert(t('roles.profiles.shareFailedTitle'));
        return null;
    }
    return published.data.artifactId;
}

/**
 * "Send a copy instead": the profile's value-free `launch-profile.v1` document, exactly as its
 * Artifact holds it (read through the canonical reader), handed to the platform's file save or share
 * sheet. No grant is made and no secret value is in it.
 */
async function sendLaunchProfileCopy(artifactId: string): Promise<void> {
    const artifact = getStorage().getState().artifacts[artifactId];
    const content = artifact?.isDecrypted && artifact.header && typeof artifact.body === 'string'
        ? readLaunchProfileArtifactV1({ artifactId, header: artifact.header, body: artifact.body })
        : null;
    try {
        if (!content) throw new Error('launch_profile_document_unavailable');
        await saveWorkflowDocument({
            fileName: documentFileName(content.profile.name, 'launch-profile'),
            json: JSON.stringify(content, null, 2),
        });
    } catch {
        Modal.alert(t('roles.settings.sendCopyFailed'));
    }
}

/**
 * One profile in the Settings › Profiles collection, or the draft of a new one: its entity header
 * (mark, name, what it runs, whether pickers offer it, Save, `⋯`) above the same editor for creating
 * and editing. Leaving with unsaved changes goes through the shared unsaved-changes guard.
 */
export const ProfileDetailScreen = React.memo(function ProfileDetailScreen(props: Readonly<{ target: ProfileDetailTarget }>) {
    const collection = useProfilesCollection();
    const { target } = props;
    // A draft is created once for this route; a saved profile follows the store.
    const [draft] = React.useState<AiLaunchProfile | null>(() => {
        if (target.kind !== 'draft') return null;
        const source = target.cloneFrom ? collection.resolveProfile(target.cloneFrom) : null;
        return source ? duplicateProfileForEdit(source, { copySuffix: t('profiles.copySuffix') }) : createEmptyCustomProfile();
    });
    const saved = target.kind === 'profile' ? collection.resolveProfile(target.profileId) : null;
    const profile = draft ?? saved;

    if (!profile) {
        return <ProfileNotFound />;
    }
    return <ProfileDetail key={profile.id} profile={profile} isDraft={draft !== null} collection={collection} />;
});

const ProfileNotFound = React.memo(function ProfileNotFound() {
    const router = useRouter();
    return (
        <ItemList>
            <SurfaceStateCard
                testID="settings.profiles.detail.notFound"
                kind="unavailable"
                title={t('profilesPage.notFoundTitle')}
                reason={t('profilesPage.notFoundDescription')}
                action={{
                    label: t('profilesPage.backToProfiles'),
                    onPress: () => openProfileCollectionHref(router, PROFILES_COLLECTION_ROOT, true, 'ProfileNotFound.back'),
                }}
            />
        </ItemList>
    );
});

const ProfileDetail = React.memo(function ProfileDetail(props: Readonly<{
    profile: AiLaunchProfile;
    isDraft: boolean;
    collection: ProfilesCollection;
}>) {
    const { profile, isDraft, collection } = props;
    const router = useRouter();
    const navigation = useNavigation();
    const accountScope = useActiveServerAccountScope();
    const saveLaunchProfile = useSaveLaunchProfile();
    const [isDirty, setIsDirty] = React.useState(false);
    const isDirtyRef = React.useRef(false);
    const ignoreGuardRef = React.useRef(false);
    const saveRef = React.useRef<(() => boolean) | null>(null);
    // A save made on the way out (the unsaved-changes prompt) only saves; the exit continues.
    const savingForExitRef = React.useRef(false);
    // A saved edit remounts the editor on the saved profile, so its unsaved-changes baseline is fresh.
    const [saveGeneration, setSaveGeneration] = React.useState(0);
    const [migrationView, setMigrationView] = React.useState<MigrationView>(null);
    const [nameStore] = React.useState<HappierCollectionDraftTitleStore>(() => createHappierCollectionDraftTitleStore());

    React.useEffect(() => {
        isDirtyRef.current = isDirty;
    }, [isDirty]);

    const onNameChange = React.useCallback((name: string) => {
        nameStore.publish(name);
        if (isDraft) publishProfileDraftTitle(name);
    }, [isDraft, nameStore]);
    React.useEffect(() => () => {
        if (isDraft) publishProfileDraftTitle('');
    }, [isDraft]);

    /** Leaves the detail on purpose (after a save, delete or discard), past the unsaved-changes guard. */
    const leaveTo = React.useCallback((href: string, tag: string) => {
        ignoreGuardRef.current = true;
        isDirtyRef.current = false;
        setIsDirty(false);
        openProfileCollectionHref(router, href, true, tag);
    }, [router]);

    const handleSave = React.useCallback((next: AiLaunchProfile, secretBindings?: Readonly<Record<string, string>>): boolean => {
        const result = saveLaunchProfile(next, secretBindings);
        if (!result) return false;
        isDirtyRef.current = false;
        setIsDirty(false);
        if (savingForExitRef.current) return true;
        if (result.created) {
            // A new profile, or a built-in saved as a copy: the collection selects what was saved.
            leaveTo(profileRoute(result.profile.id), 'ProfileDetail.saved');
        } else {
            setSaveGeneration((generation) => generation + 1);
        }
        return true;
    }, [leaveTo, saveLaunchProfile]);

    const requestDecision = React.useCallback(() => promptLaunchProfileUnsavedChanges(profile), [profile]);
    const saveEditor = React.useCallback(() => saveRef.current?.() ?? false, []);
    const saveEditorForExit = React.useCallback(() => {
        savingForExitRef.current = true;
        try {
            return saveEditor();
        } finally {
            savingForExitRef.current = false;
        }
    }, [saveEditor]);
    useUnsavedChangesBeforeRemoveGuard({
        isDirty,
        isDirtyRef,
        ignoreRef: ignoreGuardRef,
        requestDecision,
        onSave: saveEditorForExit,
        onContinue: (action) => {
            if (action) (navigation as { dispatch?: (value: unknown) => void } | null)?.dispatch?.(action);
        },
        tag: 'ProfileDetail.beforeRemove',
    });

    const cancel = React.useCallback(() => {
        openProfileCollectionHref(router, PROFILES_COLLECTION_ROOT, true, 'ProfileDetail.cancel');
    }, [router]);

    /**
     * Share…: the one document share sheet on this profile's Artifact. A saved inline profile is
     * published first; publishing reads the saved profile, so unsaved edits are settled through the
     * same unsaved-changes prompt as leaving the page. Who may manage grants is the sheet's answer.
     */
    const share = React.useCallback(async () => {
        if (isDirtyRef.current) {
            const decision = await promptLaunchProfileUnsavedChanges(profile);
            if (decision === 'keepEditing') return;
            if (decision === 'save' && !saveEditor()) return;
            if (decision === 'discard') {
                isDirtyRef.current = false;
                setIsDirty(false);
                setSaveGeneration((generation) => generation + 1);
            }
        }
        const artifactId = profile.artifactId ?? await publishLaunchProfileForShare(
            profile.id,
            accountScope?.serverId ?? null,
            (approvalId) => router.push(`/inbox/approvals/${encodeURIComponent(approvalId)}${accountScope ? `?serverId=${encodeURIComponent(accountScope.serverId)}` : ''}` as never),
        );
        if (!artifactId) return;
        showDocumentShareSheet({
            kind: 'launch-profile.v1',
            artifactId,
            name: profile.name,
            subtitle: `${t('roles.settings.launchProfileTitle')} · ${t(isBuiltInLaunchProfile(profile) ? 'profiles.builtIn' : 'profiles.custom')}`,
            linkPath: profileRoute(profile.id),
            onSendCopy: () => { void sendLaunchProfileCopy(artifactId); },
        });
    }, [accountScope, profile, router, saveEditor]);

    const legacy = isLaunchProfileV2(profile) ? null : profile as AIBackendProfile;
    const migrationStatus = isDraft ? null : collection.migrationStatusOf(profile.id);
    const builtIn = isBuiltInLaunchProfile(profile);

    const menuActions = React.useMemo((): readonly PageHeaderMenuAction[] => {
        if (isDraft) {
            return [{
                id: 'discard',
                title: t('profilesPage.discardDraft'),
                testID: 'settings.profiles.detail.discard',
                onSelect: () => leaveTo(PROFILES_COLLECTION_ROOT, 'ProfileDetail.discard'),
            }];
        }
        const favorite = collection.isFavorite(profile.id);
        return [
            {
                id: 'favorite',
                title: favorite ? t('profiles.actions.removeFromFavorites') : t('profiles.actions.addToFavorites'),
                testID: 'settings.profiles.detail.favorite',
                onSelect: () => collection.toggleFavorite(profile.id),
            },
            {
                id: 'duplicate',
                title: t('profiles.actions.duplicateProfile'),
                testID: 'settings.profiles.detail.duplicate',
                onSelect: () => openProfileCollectionHref(router, newProfileRoute(profile.id), true, 'ProfileDetail.duplicate'),
            },
            ...(legacy && hasRequiredSecret(legacy) ? [{
                id: 'defaultSecret',
                title: t('secrets.defineDefaultForProfileTitle'),
                testID: 'settings.profiles.detail.defaultSecret',
                onSelect: () => collection.chooseDefaultSecret(legacy),
            }] : []),
            ...(legacy && migrationStatus === 'review' ? [{
                id: 'reviewProviderMigration',
                title: t('settingsProviders.migration.reviewAction'),
                testID: 'settings.profiles.detail.reviewMigration',
                onSelect: () => setMigrationView('review'),
            }] : []),
            ...(legacy && migrationStatus === 'conflict' ? [{
                id: 'reviewProviderMigrationConflict',
                title: t('settingsProviders.migration.conflictReviewAction'),
                testID: 'settings.profiles.detail.reviewMigrationConflict',
                onSelect: () => setMigrationView('conflict'),
            }] : []),
            ...(builtIn ? [] : [{
                id: 'share',
                title: t('roles.profiles.share'),
                testID: 'settings.profiles.detail.share',
                onSelect: share,
            }, {
                id: 'delete',
                title: t('profiles.actions.deleteProfile'),
                testID: 'settings.profiles.detail.delete',
                onSelect: async () => {
                    if (await collection.requestDelete(profile)) leaveTo(PROFILES_COLLECTION_ROOT, 'ProfileDetail.deleted');
                },
            }]),
        ];
    }, [builtIn, collection, isDraft, leaveTo, legacy, migrationStatus, profile, router, share]);

    if (migrationView && legacy) {
        const conflict = migrationView === 'conflict'
            ? resolveProfileMigrationConflict({ profileId: legacy.id, providerSettings: collection.providerSettingsV1 })
            : null;
        return (
            <View style={styles.migration}>
                {migrationView === 'review' ? (
                    <LegacyProfileMigrationFlow
                        profile={legacy}
                        secretBindings={collection.secretBindingsByProfileId[legacy.id] ?? {}}
                        onClose={() => setMigrationView(null)}
                    />
                ) : conflict ? (
                    <LegacyProfileMigrationConflictFlow
                        profileName={legacy.name}
                        conflict={conflict}
                        onClose={() => setMigrationView(null)}
                    />
                ) : null}
            </View>
        );
    }

    // Machine-scoped reads (agents, models, environment checks) use only the exact managed machine.
    const scopedToMachine = isLaunchProfileV2(profile);
    const header = (
        <ProfileDetailHeader
            profile={profile}
            isDraft={isDraft}
            builtIn={builtIn}
            nameStore={nameStore}
            collection={collection}
            dirty={isDirty}
            onSave={saveEditor}
            menuActions={menuActions}
            showMachineChip={scopedToMachine}
        />
    );
    return (
        <LaunchProfileEditForm
            key={saveGeneration}
            profile={profile}
            machineId={scopedToMachine ? collection.executionTarget?.machine.id ?? null : null}
            serverId={scopedToMachine ? collection.executionTarget?.serverId ?? null : null}
            onSave={handleSave}
            onCancel={cancel}
            onDirtyChange={setIsDirty}
            saveRef={saveRef}
            header={header}
            onNameChange={onNameChange}
        />
    );
});

const ProfileDetailHeader = React.memo(function ProfileDetailHeader(props: Readonly<{
    profile: AiLaunchProfile;
    isDraft: boolean;
    builtIn: boolean;
    nameStore: HappierCollectionDraftTitleStore;
    collection: ProfilesCollection;
    dirty: boolean;
    onSave: () => void;
    menuActions: readonly PageHeaderMenuAction[];
    showMachineChip: boolean;
}>) {
    const { profile, collection } = props;
    const typedName = props.nameStore.useTitle().trim();
    const legacy = profile as AIBackendProfile;
    const model = useProfilesListModel({
        customProfiles: collection.profiles,
        favoriteProfileIds: collection.favoriteProfileIds,
        profileEnabledById: collection.profileEnabledById,
        includeDisabledProfiles: true,
        machineId: collection.executionTarget?.machine.id ?? null,
        serverId: collection.executionTarget?.serverId ?? null,
    });
    const title = typedName
        || (props.isDraft ? t('profilesPage.newProfileTitle') : getProfileDisplayName(legacy));
    const status = props.isDraft ? null : collection.describeStatus(legacy);
    const meta: PageHeaderMetaFact[] = [
        { key: 'summary', text: model.describeProfile(legacy), testID: 'settings.profiles.detail.summary' },
        ...(status ? [{ key: 'status', text: status }] : []),
    ];
    const enabled = props.isDraft ? null : collection.isEnabled(legacy);
    return (
        <PageHeader
            testID="settings.profiles.detail.header"
            alwaysShowTitle
            title={title}
            description={props.builtIn ? t('profilesPage.builtInDetailDescription') : t('profilesPage.detailDescription')}
            meta={props.isDraft ? undefined : meta}
            leading={(
                <PageHeaderMarkSlot>
                    <ProfileCompatibilityIcon profile={legacy} backendEntries={model.resolvedBackendEntries} size={28} />
                </PageHeaderMarkSlot>
            )}
            actions={(
                <View style={styles.actions}>
                    {props.showMachineChip ? (
                        <MachineAdministrationTargetSelector
                            presentation="chip"
                            selection={collection.administrationTargetSelection}
                            testIDPrefix="settings.profiles.administration.target"
                        />
                    ) : null}
                    {enabled !== null ? (
                        <PageHeaderStateSwitch
                            testID="settings.profiles.detail.enabled"
                            label={t('common.enabled')}
                            value={enabled}
                            onValueChange={(next) => collection.setEnabled(legacy, next)}
                            accessibilityHint={t('profilesPage.enabledHint')}
                        />
                    ) : null}
                    <RoundButton
                        testID="settings.profiles.detail.save"
                        size="small"
                        title={props.builtIn ? t('common.saveAs') : t('common.save')}
                        disabled={!props.dirty && !props.isDraft}
                        onPress={props.onSave}
                    />
                    <PageHeaderMenu testID="settings.profiles.detail.menu" actions={props.menuActions} />
                </View>
            )}
        />
    );
});

const styles = StyleSheet.create((theme) => ({
    migration: {
        flex: 1,
        minHeight: 0,
        backgroundColor: theme.colors.surface.base,
    },
    actions: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        justifyContent: 'flex-end',
        gap: 12,
    },
}));
