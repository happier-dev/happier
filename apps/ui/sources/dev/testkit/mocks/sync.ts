type SyncPublicApi = typeof import('@/sync/sync')['sync'];

export type AcceptedExternalSessionTailCursorSyncBoundary = Pick<
    SyncPublicApi,
    'getAcceptedExternalSessionTailCursor' | 'subscribeAcceptedExternalSessionTailCursor'
>;

export function createAcceptedExternalSessionTailCursorSyncBoundary(
    overrides: Partial<AcceptedExternalSessionTailCursorSyncBoundary> = {},
): AcceptedExternalSessionTailCursorSyncBoundary {
    return {
        getAcceptedExternalSessionTailCursor: () => null,
        subscribeAcceptedExternalSessionTailCursor: () => () => {},
        ...overrides,
    };
}
