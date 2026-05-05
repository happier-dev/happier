import {
    createPeerRouteViabilityCache as createTransferRouteViabilityCache,
    type CreatePeerRouteViabilityCacheOptions,
    type PeerRouteViabilityRecord,
    type TransferRouteKind,
} from '@happier-dev/peer-mediation';

export { createTransferRouteViabilityCache };
export type { TransferRouteKind };

export type TransferRouteViabilityCacheKey = Readonly<{
    serverId: string;
    targetMachineId: string;
    routeKind: TransferRouteKind;
    endpointFingerprint?: string;
}>;

export type TransferRouteViabilityRecord = PeerRouteViabilityRecord;
export type CreateTransferRouteViabilityCacheOptions = CreatePeerRouteViabilityCacheOptions;

export type TransferRouteViabilityCache = Readonly<{
    read: (key: TransferRouteViabilityCacheKey) => TransferRouteViabilityRecord;
    recordViable: (key: TransferRouteViabilityCacheKey) => void;
    recordUnavailable: (key: TransferRouteViabilityCacheKey, failureReason: string) => void;
    invalidate: (key: Readonly<{
        serverId: string;
        targetMachineId: string;
        routeKind?: TransferRouteKind;
        endpointFingerprint?: string;
    }>) => void;
}>;
