import * as React from 'react';

import { ItemLoadStateRows } from '@/components/ui/lists/ItemLoadStateRows';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import type { HomeActionFailure } from '@/sync/ops/home/homeActionOutcome';
import { t } from '@/text';

import { homePagedReadFailureLabel } from './homeGovernanceLabels';

export function HomePagedReadFailure(props: Readonly<{
    failure: HomeActionFailure;
    reload: () => void;
    retry?: () => void;
    fallback: string;
    serverId: string;
    testID: string;
}>) {
    const { failure, reload, retry = reload, fallback, serverId, testID } = props;
    const reason = homePagedReadFailureLabel(failure, fallback);
    if (failure.code === 'invalid_home_cursor') {
        return (
            <SurfaceStateCard
                testID={testID}
                kind="error"
                size="line"
                title={reason}
                accessibilitySemantics="alert"
                action={{ label: t('common.refresh'), onPress: reload, testID: `${testID}-reload` }}
            />
        );
    }
    return (
        <ItemLoadStateRows
            testID={testID}
            state={{
                kind: 'failed',
                reason,
                onRetry: failure.retryable ? retry : undefined,
                homeServerIds: failure.kind === 'unreachable' ? [serverId] : undefined,
            }}
        />
    );
}
