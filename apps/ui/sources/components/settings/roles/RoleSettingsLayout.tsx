import * as React from 'react';

import { SettingsCollectionLayout } from '@/components/settings/shell/SettingsCollectionLayout';
import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { t } from '@/text';

import { RoleCollectionRail } from './RoleCollectionRail';
import { ROLES_COLLECTION_ROOT, resolveRolesChildRoute } from './roleCollectionRoutes';

/** Rail width at normal text scale: an engine mark, a role name and its engine · runs-as line. */
const ROLE_RAIL_WIDTH_PX = 320;
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
            railWidthPx={ROLE_RAIL_WIDTH_PX}
            detailMinWidthPx={ROLE_DETAIL_MIN_WIDTH_PX}
            testID="settings-roles"
            collectionHeader={<SettingsPageHeader title={t('roles.rail.label')} description={t('roles.settings.description')} />}
        />
    );
});
