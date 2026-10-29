import * as React from 'react';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import type { AttentionBannerAction } from '@/components/ui/lists/AttentionBanner';
import type { HomeDomainFailure } from '@/sync/api/home/homeServerActionTransport';
import type { ScopedSnapshotError } from '@/sync/domains/scope/scopedSnapshotFacts';

import { teamReadFailureAction, type TeamReadFailureRetry } from './teamMutationPresentation';

/** `teamReadFailureAction` bound to the page's own router, which a Team page already navigates with. */
export function useTeamReadFailureAction(): (
    failure: HomeDomainFailure<string> | ScopedSnapshotError,
    retry: TeamReadFailureRetry,
) => AttentionBannerAction | undefined {
    const router = useRouter();
    return React.useCallback(
        (failure, retry) => teamReadFailureAction(failure, retry, () => router.push('/settings/actions')),
        [router],
    );
}
