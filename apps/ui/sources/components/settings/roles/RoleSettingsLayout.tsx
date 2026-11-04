import * as React from 'react';

import { SettingsCollectionLayout } from '@/components/settings/shell/SettingsCollectionLayout';

import { RoleCollectionRail } from './RoleCollectionRail';
import { ROLES_COLLECTION_ROOT, resolveRolesChildRoute } from './roleCollectionRoutes';

/** The narrowest detail that keeps the engine field beside its label. */
const ROLE_DETAIL_MIN_WIDTH_PX = 480;

/** Roles as a collection beside the selected role's detail; narrow screens push each role. */
export const RoleSettingsLayout = React.memo(function RoleSettingsLayout() {
    return (
        <SettingsCollectionLayout
            navigator="roles"
            rootPathname={ROLES_COLLECTION_ROOT}
            resolveChildRoute={resolveRolesChildRoute}
            rail={<RoleCollectionRail />}
            railWidth="detailed"
            detailMinWidthPx={ROLE_DETAIL_MIN_WIDTH_PX}
            testID="settings-roles"
        />
    );
});
