import * as React from 'react';
import { usePathname, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useUnistyles } from 'react-native-unistyles';

import { getProfileDisplayName } from '@/components/profiles/profileDisplay';
import { useProfilesListModel } from '@/components/profiles/useProfilesListModel';
import { ProfileCompatibilityIcon } from '@/components/sessions/new/components/ProfileCompatibilityIcon';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { Icon } from '@/components/ui/icons/Icon';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Item } from '@/components/ui/lists/Item';
import type { AIBackendProfile } from '@/sync/domains/profiles/profileCompatibility';
import { t } from '@/text';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { fireAndForget } from '@/utils/system/fireAndForget';

import {
    DEFAULT_ENVIRONMENT_ROUTE,
    newProfileRoute,
    profileRoute,
    recordProfileCollectionVisit,
    resolveProfileCollectionSelection,
} from './profileCollectionRoutes';
import { useProfilesCollection } from './useProfilesCollection';
import { profileRailContext, profileRailStatus } from './profileColumnAdapter';
import { CollectionStatusGlyph } from '@/components/ui/lists/collection/CollectionStatusGlyph';
import { CollectionDraftRow, CollectionList, CollectionListGroupLabel, collectionListStyles } from '@/components/ui/lists/collection/CollectionList';
import { HappierCollectionListMark } from '@happier-dev/plugin-ui/presentation';
import { useCollectionDraftTitle } from '@/components/ui/lists/collection/CollectionDraftTitle';

/** The collection offers a search field only once it no longer fits at a glance. */
const SEARCH_THRESHOLD = 8;

export function openProfileCollectionHref(router: ReturnType<typeof useRouter>, href: string, replace: boolean, tag: string) {
    const result = runGuardedNavigation(() => (replace ? router.replace(href as never) : router.push(href as never)));
    if (result !== true) fireAndForget(result, { tag });
}

function matchesQuery(profile: AIBackendProfile, query: string): boolean {
    const needle = query.trim().toLowerCase();
    return !needle || getProfileDisplayName(profile).toLowerCase().includes(needle);
}

/**
 * The rail beside a profile's detail: favorites, your profiles, the ones shared with you and the built-in ones, with the draft
 * of a new profile on top while it is open. Selection comes from the route; switching profiles
 * replaces the shown detail (its unsaved-changes guard runs first).
 */
export const ProfileCollectionRail = React.memo(function ProfileCollectionRail() {
    const router = useRouter();
    const pathname = usePathname().replace(/\/+$/, '');
    const selection = resolveProfileCollectionSelection(pathname);
    const collection = useProfilesCollection();
    const model = useProfilesListModel({
        customProfiles: collection.profiles,
        favoriteProfileIds: collection.favoriteProfileIds,
        profileEnabledById: collection.profileEnabledById,
        includeDisabledProfiles: true,
        machineId: collection.executionTarget?.machine.id ?? null,
        serverId: collection.executionTarget?.serverId ?? null,
    });
    const [query, setQuery] = React.useState('');

    const selectedProfileId = selection.kind === 'profile' ? selection.profileId : null;
    React.useEffect(() => {
        if (selectedProfileId) recordProfileCollectionVisit(selectedProfileId);
    }, [selectedProfileId]);

    const total = model.groups.favoriteProfiles.length + model.groups.customProfiles.length + model.groups.sharedProfiles.length + model.groups.builtInProfiles.length;
    const searchable = total > SEARCH_THRESHOLD;
    // The no-profile choice sits where the pickers show it: among favorites, or with the built-in ones.
    const defaultEnvironmentFavorite = model.groups.favoriteIds.has('');
    const defaultEnvironmentMatches = !searchable || !query.trim()
        || t('profiles.noProfile').toLowerCase().includes(query.trim().toLowerCase());
    const sections = [
        { id: 'favorites', title: t('profiles.groups.favorites'), profiles: model.groups.favoriteProfiles, defaultEnvironment: defaultEnvironmentFavorite },
        { id: 'custom', title: t('profiles.groups.custom'), profiles: model.groups.customProfiles, defaultEnvironment: false },
        { id: 'shared', title: t('roles.profiles.sharedWithYouTitle'), profiles: model.groups.sharedProfiles, defaultEnvironment: false },
        { id: 'builtIn', title: t('profiles.groups.builtIn'), profiles: model.groups.builtInProfiles, defaultEnvironment: !defaultEnvironmentFavorite },
    ].map((section) => ({
        ...section,
        profiles: searchable ? section.profiles.filter((profile) => matchesQuery(profile, query)) : section.profiles,
        defaultEnvironment: section.defaultEnvironment && defaultEnvironmentMatches,
    })).filter((section) => section.profiles.length > 0 || section.defaultEnvironment);

    return (
        <CollectionList
            testID="settings.profiles.rail"
            title={t('settingsFeatures.profiles')}
            // The machine environment and an open draft are collection choices too.
            // Unknown is not zero: a failed first read leaves the count open.
            count={collection.isInitialLoading || collection.isReadFailed ? undefined : total + 1 + (selection.kind === 'draft' ? 1 : 0)}
            headerAction={(
                <IconButton
                    testID="settings.profiles.rail.add"
                    iconName="plus"
                    accessibilityLabel={t('profiles.addProfile')}
                    tooltip={t('profiles.addProfile')}
                    variant="plain"
                    onPress={() => openProfileCollectionHref(router, newProfileRoute(), selection.kind !== 'none', 'ProfileCollectionRail.add')}
                />
            )}
            search={searchable ? {
                value: query,
                onChangeText: setQuery,
                placeholder: t('profilesPage.searchPlaceholder'),
                testID: 'settings.profiles.rail.search',
            } : null}
        >
            {selection.kind === 'draft' ? <ProfileDraftRow /> : null}
            {/* Saved profiles that never loaded are named once, above the built-in choices that still work. An open
                profile's own page already explains the same failure and offers Retry, so the rail stays quiet then. */}
            {collection.isReadFailed ? (
                <SurfaceStateCard
                    testID="settings.profiles.rail.readFailed"
                    size="line"
                    kind="unavailable"
                    title={t('profilesPage.listReadFailedTitle')}
                    action={selection.kind !== 'profile' && collection.retryRead ? {
                        label: t('common.retry'),
                        onPress: collection.retryRead,
                        testID: 'settings.profiles.rail.readFailed.retry',
                    } : undefined}
                />
            ) : null}
            {/* Loading and empty are the rail's one quiet line, so the list never shifts when the answer arrives. */}
            {collection.isInitialLoading || sections.length === 0 ? (
                <EmptyState
                    testID={collection.isInitialLoading ? 'settings.profiles.rail.loading' : 'settings.profiles.rail.empty'}
                    layout="line"
                    lineLoading={collection.isInitialLoading}
                    title={collection.isInitialLoading ? t('common.loading')
                        : searchable && query.trim() ? t('common.noMatches') : t('profilesPage.emptyTitle')}
                />
            ) : sections.map((section, index) => (
                <React.Fragment key={section.id}>
                    <CollectionListGroupLabel
                        title={section.title}
                        count={section.profiles.length + (section.defaultEnvironment ? 1 : 0)}
                        first={index === 0 && selection.kind !== 'draft'}
                    />
                    {section.defaultEnvironment ? (
                        <DefaultEnvironmentRow
                            selected={selection.kind === 'defaultEnvironment'}
                            onPress={() => openProfileCollectionHref(
                                router,
                                DEFAULT_ENVIRONMENT_ROUTE,
                                selection.kind !== 'none',
                                'ProfileCollectionRail.defaultEnvironment',
                            )}
                        />
                    ) : null}
                    {section.profiles.map((profile) => {
                        const enabled = collection.isEnabled(profile);
                        const state = profileRailStatus({ enabled, migration: collection.migrationStatusOf(profile.id) });
                        const context = profileRailContext(model.describeProfile(profile), model.strings.anyAgentLabel);
                        return (
                            <Item
                                rowRole="catalogRow"
                                key={`${section.id}:${profile.id}`}
                                testID={`settings.profiles.row.${profile.id}`}
                                title={getProfileDisplayName(profile)}
                                dimmed={!enabled}
                                subtitle={context}
                                rightElement={state ? <CollectionStatusGlyph status={state.status} label={state.label} /> : undefined}
                                icon={(
                                    <HappierCollectionListMark rowRole="catalogRow" dimmed={!enabled}>
                                        <ProfileCompatibilityIcon profile={profile} backendEntries={model.resolvedBackendEntries} size={24} />
                                    </HappierCollectionListMark>
                                )}
                                selected={selectedProfileId === profile.id}
                                density="compact"
                                showChevron={false}
                                pressableStyle={collectionListStyles.row}
                                onPress={() => openProfileCollectionHref(
                                    router,
                                    profileRoute(profile.id),
                                    selection.kind !== 'none',
                                    'ProfileCollectionRail.open',
                                )}
                            />
                        );
                    })}
                </React.Fragment>
            ))}
        </CollectionList>
    );
});

/** The profile being added, at the top of the rail while its editor is open. */
const ProfileDraftRow = React.memo(function ProfileDraftRow() {
    const titles = useCollectionDraftTitle();
    const { theme } = useUnistyles();
    return (
        <CollectionDraftRow
            rowRole="item"
            testID="settings.profiles.rail.draft"
            titles={titles}
            placeholder={t('profilesPage.newProfileTitle')}
            mark={(
                <HappierCollectionListMark>
                    <Icon name="user-circle" size={20} color={theme.colors.text.secondary} />
                </HappierCollectionListMark>
            )}
        />
    );
});

/** The no-profile choice: new sessions use the machine's environment. */
const DefaultEnvironmentRow = React.memo(function DefaultEnvironmentRow(props: Readonly<{
    selected: boolean;
    onPress: () => void;
}>) {
    const { theme } = useUnistyles();
    return (
        <Item
            rowRole="catalogRow"
            testID="settings.profiles.row.defaultEnvironment"
            title={t('profiles.noProfile')}
            subtitle={t('profiles.noProfileDescription')}
            icon={(
                <HappierCollectionListMark rowRole="catalogRow">
                    <Icon name="house" size={20} color={theme.colors.text.secondary} />
                </HappierCollectionListMark>
            )}
            selected={props.selected}
            density="compact"
            showChevron={false}
            pressableStyle={collectionListStyles.row}
            onPress={props.onPress}
        />
    );
});
