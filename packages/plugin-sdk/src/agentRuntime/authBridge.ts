export type DaemonAuthBridgeRefreshRequestV1 = Readonly<{
    sessionId: string;
    selection: unknown;
    forceRefresh: boolean;
}> & Readonly<Record<string, unknown>>;

export type DaemonAuthBridgeRefreshResultV1 = unknown;

export type RegisterDaemonAuthBridgeV1 = Readonly<{
    serviceId: string;
    refresh: (
        request: DaemonAuthBridgeRefreshRequestV1,
    ) => Promise<DaemonAuthBridgeRefreshResultV1>;
}>;
