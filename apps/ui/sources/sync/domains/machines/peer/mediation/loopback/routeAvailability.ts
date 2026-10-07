import { PEER_MEDIATION_RECEIPTS } from '@happier-dev/protocol/machines/peer/mediation/receipts';
import type { PeerFlowKindV1 } from '@happier-dev/protocol/machines/peer/mediation/flowKind';

export type PeerLoopbackRouteAvailabilityResult =
    | Readonly<{
        kind: 'selected';
        receipt: typeof PEER_MEDIATION_RECEIPTS.routeSelected;
        routeKind: 'loopback_direct';
        flowKind: PeerFlowKindV1;
        endpointFingerprint: string;
    }>
    | Readonly<{
        kind: 'fallback';
        receipt: typeof PEER_MEDIATION_RECEIPTS.routeFallback;
        reasonCode: string;
    }>;
