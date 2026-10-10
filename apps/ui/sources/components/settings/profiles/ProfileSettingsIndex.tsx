import * as React from 'react';
import { Redirect, useRouter } from '@/components/appShell/workspace/destinationRoute';

import { ProfilesList } from '@/components/profiles/ProfilesList';
import { useProfilesListModel } from '@/components/profiles/useProfilesListModel';
import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { MachineAdministrationTargetSelector } from '@/components/settings/machines/MachineAdministrationTargetSelector';
import { Switch } from '@/components/ui/forms/Switch';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { t } from '@/text';

import { openProfileCollectionHref } from './ProfileCollectionList';
import { DEFAULT_ENVIRONMENT_ROUTE, newProfileRoute, profileRoute, readLastVisitedProfileId } from './profileCollectionRoutes';
import { useProfilesCollection, type ProfilesCollection } from './useProfilesCollection';
import { resolveHappierCollectionInitialKey, useHappierCollectionIndexView } from '@happier-dev/plugin-ui/presentation';

/**
 * `/settings/profiles`. With profiles off, the page is the one switch that turns them on. Beside the
 * rail a profile is always selected, so the index lands on one. Where no rail shows, the index is the
 * profile list and each profile pushes its detail.
 */
export const ProfileSettingsIndex = React.memo(function ProfileSettingsIndex() {
    const view = useHappierCollectionIndexView();
    const collection = useProfilesCollection();
    if (!collection.useProfiles) return <ProfilesOffPage collection={collection} />;
    if (view === 'pending') return null;
    if (view === 'land') return <ProfileCollectionLanding collection={collection} />;
    return <ProfileCollectionPage collection={collection} />;
});

const ProfilesOffPage = React.memo(function ProfilesOffPage(props: Readonly<{ collection: ProfilesCollection }>) {
    const { useProfiles, setUseProfiles } = props.collection;
    return (
        <ItemList style={{ paddingTop: 0 }}>
            <SettingsPageHeader description={t('settingsProfilesPage.pageDescription')} />
            <ItemGroup
                title={t('settingsProfilesPage.useProfilesSection')}
                description={t('settingsProfilesPage.useProfilesSectionDescription')}
            >
                <Item
                    testID="settings.profiles.useProfiles"
                    title={t('settingsProfilesPage.useProfiles')}
                    subtitle={t('settingsProfilesPage.useProfilesOffDescription')}
                    onPress={() => setUseProfiles(true)}
                    rightElement={<Switch value={useProfiles} onValueChange={setUseProfiles} />}
                    showChevron={false}
                />
            </ItemGroup>
        </ItemList>
    );
});

const ProfileCollectionLanding = React.memo(function ProfileCollectionLanding(props: Readonly<{ collection: ProfilesCollection }>) {
    const { collection } = props;
    const model = useProfilesListModel({
        customProfiles: collection.profiles,
        favoriteProfileIds: collection.favoriteProfileIds,
        profileEnabledById: collection.profileEnabledById,
        includeDisabledProfiles: true,
        machineId: null,
    });
    const landingId = resolveHappierCollectionInitialKey({
        keys: [
            ...model.groups.favoriteProfiles,
            ...model.groups.customProfiles,
            ...model.groups.sharedProfiles,
            ...model.groups.builtInProfiles,
        ].map((profile) => profile.id),
        lastVisited: readLastVisitedProfileId(),
    });
    // With no profile to show, the no-profile choice (always present) is the selection.
    return <Redirect href={(landingId ? profileRoute(landingId) : DEFAULT_ENVIRONMENT_ROUTE) as never} />;
});

const ProfileCollectionPage = React.memo(function ProfileCollectionPage(props: Readonly<{ collection: ProfilesCollection }>) {
    const router = useRouter();
    const { collection } = props;
    const open = (href: string, tag: string) => openProfileCollectionHref(router, href, false, tag);
    return (
        <ProfilesList
            presentation="page"
            groupDescriptions={{
                favorites: t('settingsProfilesPage.favoritesDescription'),
                custom: t('settingsProfilesPage.customDescription'),
                builtIn: t('settingsProfilesPage.builtInDescription'),
            }}
            customProfiles={collection.profiles}
            favoriteProfileIds={collection.favoriteProfileIds}
            onFavoriteProfileIdsChange={collection.setFavoriteProfileIds}
            profileEnabledById={collection.profileEnabledById}
            includeDisabledProfiles
            selectedProfileId={null}
            onPressProfile={(profile) => open(profileRoute(profile.id), 'ProfileCollectionPage.open')}
            machineId={collection.executionTarget?.machine.id ?? null}
            serverId={collection.executionTarget?.serverId ?? null}
            header={(
                <SettingsPageHeader
                    description={t('settingsProfilesPage.pageDescription')}
                    actions={(
                        <MachineAdministrationTargetSelector
                            presentation="chip"
                            selection={collection.administrationTargetSelection}
                            testIDPrefix="settings.profiles.administration.target"
                        />
                    )}
                />
            )}
            includeDefaultEnvironmentRow
            onPressDefaultEnvironment={() => open(DEFAULT_ENVIRONMENT_ROUTE, 'ProfileCollectionPage.defaultEnvironment')}
            includeAddProfileRow
            onAddProfilePress={() => open(newProfileRoute(), 'ProfileCollectionPage.add')}
            onEditProfile={(profile) => open(profileRoute(profile.id), 'ProfileCollectionPage.edit')}
            onDuplicateProfile={(profile) => open(newProfileRoute(profile.id), 'ProfileCollectionPage.duplicate')}
            onDeleteProfile={(profile) => { void collection.requestDelete(profile); }}
            getProfileSubtitleExtra={collection.describeStatus}
            onSecretBadgePress={collection.chooseDefaultSecret}
            getSecretOverrideReady={collection.isSecretOverrideReady}
        />
    );
});
