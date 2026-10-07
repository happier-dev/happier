import * as React from 'react';
import { SettingsCollectionLayout } from '@/components/settings/shell/SettingsCollectionLayout';
import { useSetting } from '@/sync/domains/state/storage';

import { ProfileCollectionRail } from './ProfileCollectionList';
import { PROFILES_COLLECTION_ROOT, resolveProfilesChildRoute } from './profileCollectionRoutes';

/** Rail width at normal text scale: a compatibility mark, a profile name and one summary line. */
const PROFILE_RAIL_WIDTH_PX = 272;
/** The narrowest detail that still fits an environment variable row beside its label. */
const PROFILE_DETAIL_MIN_WIDTH_PX = 480;

/**
 * Profiles as a collection beside the selected profile's editor. Narrow: the list page pushes each
 * profile. With profiles turned off the page is only the switch that turns them on, so no rail shows.
 */
export const ProfileSettingsLayout = React.memo(function ProfileSettingsLayout() {
    const useProfiles = useSetting('useProfiles');
    return (
        <SettingsCollectionLayout
            navigator="profiles"
            rootPathname={PROFILES_COLLECTION_ROOT}
            resolveChildRoute={resolveProfilesChildRoute}
            rail={useProfiles ? <ProfileCollectionRail /> : null}
            railWidthPx={PROFILE_RAIL_WIDTH_PX}
            detailMinWidthPx={PROFILE_DETAIL_MIN_WIDTH_PX}
            testID="settings-profiles"
        />
    );
});
