import * as React from 'react';

import { isTeamLegacyCredentialRefusalV1 } from '@happier-dev/protocol/teams';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { presentTeamSignInOutdated, presentTeamSignInRequired } from '@/components/teams/entry/teamSignInRequirement';
import type { AttentionBannerAction } from '@/components/ui/lists/AttentionBanner';
import type { HomeDomainFailure } from '@/sync/api/home/homeServerActionTransport';
import type { ScopedSnapshotError } from '@/sync/domains/scope/scopedSnapshotFacts';
import type { TeamAddress } from '@/sync/domains/teams/teamAddress';

import { teamReadFailureAction, type TeamReadFailureRetry } from './teamMutationPresentation';

/** Sign-in recovery appears on reads and writes only for the refusal that requires it. */
export function teamSignInFailureAction(
    failure: HomeDomainFailure<string> | ScopedSnapshotError,
    address: TeamAddress | undefined,
    navigate: (href: string) => void,
    testIDPrefix?: string,
): AttentionBannerAction | undefined {
    const testID = testIDPrefix ? `${testIDPrefix}-sign-in` : undefined;
    if (failure.code === 'team_authentication_required' && address) {
        const { action } = presentTeamSignInRequired({
            code: failure.code, teamId: address.teamId, serverId: address.serverId, accepted: [], navigate,
        });
        return { ...action, testID };
    }
    if (failure.code && isTeamLegacyCredentialRefusalV1(failure.code, failure.details)) {
        const { action } = presentTeamSignInOutdated({ code: failure.code, navigate });
        return { ...action, testID };
    }
    return undefined;
}

/** `teamReadFailureAction` bound to the page's own router, which a Team page already navigates with. */
export function useTeamReadFailureAction(address?: TeamAddress): (
    failure: HomeDomainFailure<string> | ScopedSnapshotError,
    retry: TeamReadFailureRetry,
) => AttentionBannerAction | undefined {
    const router = useRouter();
    const serverId = address?.serverId;
    const teamId = address?.teamId;
    return React.useCallback(
        (failure, retry) => {
            const action = teamSignInFailureAction(
                failure, teamId && serverId ? { teamId, serverId } : undefined, (href) => router.push(href), retry.testIDPrefix,
            );
            return action ?? teamReadFailureAction(failure, retry, () => router.push('/settings/actions'));
        },
        [router, serverId, teamId],
    );
}
