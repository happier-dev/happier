import type { WebDomScrollObservation } from '@/components/sessions/transcript/viewport/driver/webDomObservation';
import type { WebTranscriptScrollMetrics } from '@/components/sessions/transcript/webTranscriptScrollMetrics';

import { applySidechainWebPrependGrowthRestore } from './sidechainWebPrependGrowthRestore';

export type SidechainOlderPageLoadResult = Readonly<{
    loaded: number;
    hasMore: boolean;
    status: 'loaded' | 'no_more' | 'not_ready' | 'in_flight';
}>;

export type SidechainOlderPageLoadFn = () => Promise<SidechainOlderPageLoadResult>;

export type SidechainPaginationOlderPageLoadFn = (options: Readonly<{
    webPrependAnchor?: WebTranscriptScrollMetrics | null;
}>) => Promise<SidechainOlderPageLoadResult | null>;

export async function applySidechainOlderPageLoad(params: Readonly<{
    hasMoreOlder: boolean;
    isLoadingOlder: boolean;
    loadOlder: SidechainOlderPageLoadFn | null | undefined;
    setHasMoreOlder: (hasMore: boolean) => void;
    setLoadingOlder: (loading: boolean) => void;
    waitForVisualUpdate: () => Promise<void>;
    webDomObservation: WebDomScrollObservation;
    webPrependAnchor?: WebTranscriptScrollMetrics | null;
}>): Promise<SidechainOlderPageLoadResult | null> {
    if (!params.loadOlder) return null;
    if (params.isLoadingOlder) return null;
    if (params.hasMoreOlder === false) return null;

    params.setLoadingOlder(true);
    try {
        const result = await params.loadOlder();
        if (params.webPrependAnchor && result.loaded > 0) {
            await params.waitForVisualUpdate();
            applySidechainWebPrependGrowthRestore({
                capturedMetrics: params.webPrependAnchor,
                webDomObservation: params.webDomObservation,
            });
        }
        if (result.status === 'no_more' || result.hasMore === false) {
            params.setHasMoreOlder(false);
        }
        return result;
    } finally {
        params.setLoadingOlder(false);
    }
}

export async function applySidechainPaginationOlderPageLoad(params: Readonly<{
    hasMoreOlder: boolean;
    listLayoutHeightPx: number;
    loadOlder: SidechainPaginationOlderPageLoadFn;
    resolveViewportGuardThresholdPx: (viewportPx: number) => number;
    resolveWebPrependAnchor: (pinThresholdPx: number) => WebTranscriptScrollMetrics | null;
}>): Promise<SidechainOlderPageLoadResult | null> {
    if (params.hasMoreOlder === false) {
        return {
            loaded: 0,
            hasMore: false,
            status: 'no_more',
        };
    }

    const viewportGuardThresholdPx = params.resolveViewportGuardThresholdPx(params.listLayoutHeightPx);
    return await params.loadOlder({
        webPrependAnchor: params.resolveWebPrependAnchor(viewportGuardThresholdPx),
    });
}
