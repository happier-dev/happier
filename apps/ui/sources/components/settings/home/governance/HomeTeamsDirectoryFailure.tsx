import * as React from 'react';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import {
    teamsDirectoryHomeAction,
    teamsUnavailableHomeReason,
    teamsUnavailableHomeStateKind,
    type TeamsDirectoryUnavailableHome,
} from '@/components/settings/teams/teamsDirectoryViewState';
import { ItemLoadStateRows } from '@/components/ui/lists/ItemLoadStateRows';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';

export function HomeTeamsDirectoryFailure(props: Readonly<{
    testID: string;
    home: TeamsDirectoryUnavailableHome | undefined;
    serverIds: readonly string[];
    refresh: () => void;
    openFeatures?: () => void;
}>) {
    const router = useRouter();
    const { testID, home, serverIds, refresh, openFeatures } = props;
    if (!home || home.reason === 'offline' || home.reason === 'error') {
        return (
            <ItemLoadStateRows
                testID={testID}
                state={{
                    kind: 'failed',
                    reason: t('homeGovernance.invite.teamsFailed'),
                    onRetry: home?.retryable ? refresh : undefined,
                    homeServerIds: serverIds,
                }}
            />
        );
    }
    const action = home.reason === 'disabled' && openFeatures
        ? { label: t('homeGovernance.teamsDisabledAction'), onPress: openFeatures, testID: `${testID}-features` }
        : teamsDirectoryHomeAction(home, refresh, (href) => router.push(href), {
            retry: `${testID}-retry`,
            reload: `${testID}-reload`,
        });
    return (
        <SurfaceStateCard
            testID={testID}
            kind={teamsUnavailableHomeStateKind(home)}
            size="line"
            title={teamsUnavailableHomeReason(home)}
            action={action}
            accessibilitySemantics="alert"
        />
    );
}
