export type SidechainOlderPageLoadResult = Readonly<{
    loaded: number;
    hasMore: boolean;
    status: 'loaded' | 'no_more' | 'not_ready' | 'in_flight';
}>;

export type SidechainOlderPageLoadFn = () => Promise<SidechainOlderPageLoadResult>;

export type SidechainPaginationOlderPageLoadFn = () => Promise<SidechainOlderPageLoadResult | null>;

export async function applySidechainOlderPageLoad(params: Readonly<{
    hasMoreOlder: boolean;
    isLoadingOlder: boolean;
    loadOlder: SidechainOlderPageLoadFn | null | undefined;
    setHasMoreOlder: (hasMore: boolean) => void;
    setLoadingOlder: (loading: boolean) => void;
    isOperationCurrent?: () => boolean;
}>): Promise<SidechainOlderPageLoadResult | null> {
    if (!params.loadOlder) return null;
    if (params.isLoadingOlder) return null;
    if (params.hasMoreOlder === false) return null;

    const isOperationCurrent = params.isOperationCurrent ?? (() => true);
    params.setLoadingOlder(true);
    try {
        const result = await params.loadOlder();
        if (!isOperationCurrent()) return null;
        if (result.status === 'no_more' || result.hasMore === false) {
            params.setHasMoreOlder(false);
        }
        return result;
    } finally {
        if (isOperationCurrent()) {
            params.setLoadingOlder(false);
        }
    }
}

export async function applySidechainPaginationOlderPageLoad(params: Readonly<{
    hasMoreOlder: boolean;
    loadOlder: SidechainPaginationOlderPageLoadFn;
}>): Promise<SidechainOlderPageLoadResult | null> {
    if (params.hasMoreOlder === false) {
        return {
            loaded: 0,
            hasMore: false,
            status: 'no_more',
        };
    }

    return await params.loadOlder();
}
