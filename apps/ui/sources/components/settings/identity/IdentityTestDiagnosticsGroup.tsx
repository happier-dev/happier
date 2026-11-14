import * as React from 'react';
import type { IdentityConnectionTestDiagnosticsV1 } from '@happier-dev/protocol/identity/testDiagnostics';

import { useTeamGroupNameProjectionDisplayNames } from '@/hooks/teams/useTeamGroupDisplayNames';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { t } from '@/text';

import { identityTestDiagnosticsRows } from './identityTestDiagnosticsPresentation';

/**
 * One calm Settings group for the sanitized result of a non-mutating sign-in test.
 * Home provider detail and Team connection detail share it so the two surfaces
 * cannot drift into different diagnostic vocabularies.
 */
export const IdentityTestDiagnosticsGroup = React.memo(function IdentityTestDiagnosticsGroup(props: Readonly<{
    diagnostics: IdentityConnectionTestDiagnosticsV1;
    /** Only a Team connection carries external Group mappings a test can evaluate. */
    groupMappings?: boolean;
    scope?: ServerAccountScope | null;
}>) {
    const groups = React.useMemo(
        () => props.groupMappings ? props.diagnostics.mappedGroups : [],
        [props.diagnostics.mappedGroups, props.groupMappings],
    );
    const openedGroupDisplayNames = useTeamGroupNameProjectionDisplayNames({
        scope: props.scope ?? null,
        groups,
    });
    const rows = React.useMemo(
        () => identityTestDiagnosticsRows(props.diagnostics, {
            groupMappings: props.groupMappings,
            openedGroupDisplayNames,
        }),
        [openedGroupDisplayNames, props.diagnostics, props.groupMappings],
    );
    return (
        <ItemGroup
            title={t('identityAdministration.diagnosticsTitle')}
            description={t('identityAdministration.diagnosticsFooter')}
        >
            {rows.map((row) => (
                <Item
                    key={row.key}
                    testID={`identity-test-diagnostics:${row.key}`}
                    title={row.title}
                    detail={row.detail}
                    showChevron={false}
                />
            ))}
        </ItemGroup>
    );
});
