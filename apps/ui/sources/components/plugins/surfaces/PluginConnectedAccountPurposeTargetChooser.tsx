import * as React from 'react';
import type { ConnectedAccountPurposeTargetChooserProps } from '@happier-dev/plugin-ui/components';

import { ConnectedAccountPurposeTargetChooser } from '@/components/settings/connectedServices/account/ConnectedAccountPurposeTargetChooser';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useHomeTeamCredentialModelCatalog } from '@/hooks/teams/useHomeTeamCredentialModelCatalog';

function TeamPurposeTargetChooser({
    teamCredentialScope,
    ...props
}: Omit<ConnectedAccountPurposeTargetChooserProps, 'teamCredentialScope' | 'unavailableLabel'> & Readonly<{
    teamCredentialScope: NonNullable<ConnectedAccountPurposeTargetChooserProps['teamCredentialScope']>;
}>) {
    const teamResourcesEnabled = useFeatureEnabled('teams.credentialResources', {
        scopeKind: 'spawn', serverId: teamCredentialScope.serverId,
    });
    const catalog = useHomeTeamCredentialModelCatalog({
        serverId: teamCredentialScope.serverId,
        machineId: teamCredentialScope.machineId,
        enabled: teamResourcesEnabled,
    });
    const reload = React.useCallback(async () => {
        await Promise.all([props.onReload?.(), catalog.reload()]);
    }, [props.onReload, catalog.reload]);
    return <ConnectedAccountPurposeTargetChooser {...props}
        teamCredentialCatalog={catalog} onReload={reload} />;
}

/** The native catalog owner discovers Team targets only for an explicitly supplied execution scope. */
export function PluginConnectedAccountPurposeTargetChooser({ unavailableLabel: _unavailable,
    teamCredentialScope, ...props }: ConnectedAccountPurposeTargetChooserProps) {
    return teamCredentialScope ? <TeamPurposeTargetChooser {...props} teamCredentialScope={teamCredentialScope} />
        : <ConnectedAccountPurposeTargetChooser {...props} />;
}
