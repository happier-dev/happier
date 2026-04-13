import * as React from 'react';

import { buildNewSessionProfileSelectionPopover } from '@/components/sessions/new/components/buildNewSessionProfileSelectionPopover';

type BuildProfileSelectionPopoverParams = Parameters<typeof buildNewSessionProfileSelectionPopover>[0];
type ProfilePopover = ReturnType<typeof buildNewSessionProfileSelectionPopover>['profilePopover'];

export function useNewSessionProfilePopover(params: Readonly<{
    useProfiles: BuildProfileSelectionPopoverParams['useProfiles'];
    profilesProps: BuildProfileSelectionPopoverParams['profilesProps'];
    serverId: BuildProfileSelectionPopoverParams['serverId'];
    machineName: BuildProfileSelectionPopoverParams['machineName'];
    popoverBoundaryRef: BuildProfileSelectionPopoverParams['popoverBoundaryRef'];
}>): Readonly<{
    profilePopover: ProfilePopover;
}> {
    const { profilePopover } = React.useMemo(() => {
        return buildNewSessionProfileSelectionPopover({
            useProfiles: params.useProfiles,
            profilesProps: params.profilesProps,
            serverId: params.serverId,
            machineName: params.machineName,
            popoverBoundaryRef: params.popoverBoundaryRef,
        });
    }, [
        params.machineName,
        params.popoverBoundaryRef,
        params.profilesProps,
        params.serverId,
        params.useProfiles,
    ]);

    return { profilePopover };
}
