/**
 * Tunnel frame layer.
 *
 * This barrel preserves the module specifier `./frames` that `registerRoutes.ts`, `relay.ts` and
 * the directory barrel already import, so the 2026-08-23 split of the former 1,498-line
 * `frames.ts` changed no consumer and no behaviour.
 */
// Shared binary implementation. The only legacy JSON/base64 compatibility
// surface is the stream/codec adapter below.
export {
    createPeerTcpTunnelApplicationSubstreamSession,
    createPeerTcpTunnelSubstreamMuxSession,
    createPeerTcpTunnelFrameAccounting,
    isSchedulableTimeoutMs,
    substreamAbortFrame,
} from '@happier-dev/peer-transport';
export type {
    PeerTcpTunnelApplicationSubstreamSessionResult,
    PeerTcpTunnelSubstreamMuxSessionResult,
    PeerTcpTunnelStreamConnection,
    PeerTcpTunnelStreamSessionResult,
} from '@happier-dev/peer-transport';

export {
    createPeerTcpTunnelStreamSession,
    decodePeerTcpTunnelBinaryFrameForSession,
    encodePeerTcpTunnelBinaryFrameForSession,
} from './legacyJsonAdapter';
