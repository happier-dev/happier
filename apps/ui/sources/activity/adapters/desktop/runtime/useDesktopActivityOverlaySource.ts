import * as React from 'react';

import { useActivityAttentionSource } from '@/activity/source/useActivityAttentionSource';
import type { ActivityAttentionSource } from '@/activity/source/activityAttentionSourceTypes';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import type { ConnectedServiceQuotaSummary } from '@/hooks/server/connectedServices/useConnectedServiceQuotaSummaries';

export type DesktopActivityOverlaySource = ActivityAttentionSource & Readonly<{
    quotaSummaries: ReadonlyArray<ConnectedServiceQuotaSummary>;
}>;

const EMPTY_QUOTA_SUMMARIES: readonly ConnectedServiceQuotaSummary[] = [];

export function useDesktopActivityOverlaySource(options?: Readonly<{
    detailDemanded?: boolean;
    detailAddresses?: readonly SessionAddress[];
    quotaSummaries?: readonly ConnectedServiceQuotaSummary[];
}>): DesktopActivityOverlaySource {
    const source = useActivityAttentionSource({
        includeSessionMessages: options?.detailDemanded === true,
        detailAddresses: options?.detailAddresses,
    });
    const summaries = options?.detailDemanded ? options.quotaSummaries ?? EMPTY_QUOTA_SUMMARIES : EMPTY_QUOTA_SUMMARIES;

    return React.useMemo(() => ({
        ...source,
        quotaSummaries: summaries,
    }), [source, summaries]);
}
