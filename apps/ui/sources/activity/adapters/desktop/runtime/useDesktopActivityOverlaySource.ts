import * as React from 'react';

import { useActivityAttentionSource } from '@/activity/source/useActivityAttentionSource';
import type { ActivityAttentionSource } from '@/activity/source/activityAttentionSourceTypes';
import { useConnectedServiceQuotaSummaries, type ConnectedServiceQuotaSummary } from '@/hooks/server/connectedServices/useConnectedServiceQuotaSummaries';

export type DesktopActivityOverlaySource = ActivityAttentionSource & Readonly<{
    quotaSummaries: ReadonlyArray<ConnectedServiceQuotaSummary>;
}>;

export function useDesktopActivityOverlaySource(): DesktopActivityOverlaySource {
    const { summaries } = useConnectedServiceQuotaSummaries();
    const source = useActivityAttentionSource();

    return React.useMemo(() => ({
        ...source,
        quotaSummaries: summaries,
    }), [source, summaries]);
}
