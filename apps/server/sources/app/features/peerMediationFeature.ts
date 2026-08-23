import type {
    PeerFlowKindV1,
    PeerMediationObservabilityEventKindV1,
} from '@happier-dev/protocol';

import { readPeerMediationFeatureEnv } from './catalog/readFeatureEnv';
import type { FeaturesPayloadDelta } from './types';

/**
 * Peer mediation server feature resolver.
 *
 * `machines.peerMediation` and `machines.peerMediation.observability` are declared in the protocol
 * feature catalog and read by the server socket routes
 * (`socket/peer/mediation/observability/routes.ts`), the daemon runtime-action executor and the UI
 * subscription — but no resolver ever wrote either bit, so the schema default (`false`) was final
 * and no configuration could enable them. This resolver is that writer.
 *
 * Fail-closed per `docs/feature-gating.md`: an absent or malformed variable resolves to disabled,
 * and every consumer gates on `readServerEnabledBit(...) === true`. The parent bit is derived from
 * grant signing rather than from a second switch, because grant signing is what actually makes the
 * substrate function; dependency closure (`applyFeatureDependencies`) then forces observability off
 * whenever the parent is off, so the child cannot be enabled on a server that cannot mint grants.
 */

/**
 * Event kinds a production emitter can actually produce today. The seven omitted kinds
 * (`tunnel.bytes`, `tunnel.substream.opened|closed|aborted`, `stream.frame`, `stream.backpressure`,
 * `http.request.headers`) are declared in the protocol enum but have zero production emitters, so
 * advertising them as supported would misreport the capability. Add a kind here in the same change
 * that gives it an emitter.
 */
const EMITTED_OBSERVABILITY_EVENT_KINDS: readonly PeerMediationObservabilityEventKindV1[] = [
    'flow.started',
    'flow.ready',
    'flow.denied',
    'flow.closed',
    'flow.aborted',
    'flow.errored',
    'http.request.started',
    'http.request.finished',
    'http.request.aborted',
    'websocket.opened',
    'websocket.closed',
    'websocket.aborted',
    'websocket.errored',
    'cap.exceeded',
    'policy.denied',
];

/** Flow kinds the relay collectors observe. `voice_media` rides the tunnel gate and is not observed. */
const OBSERVED_FLOW_KINDS: readonly PeerFlowKindV1[] = ['tcp_tunnel', 'live_stream'];

export function resolvePeerMediationFeature(env: NodeJS.ProcessEnv): FeaturesPayloadDelta {
    const featureConfig = readPeerMediationFeatureEnv(env);
    const observabilityEnabled = featureConfig.substrateEnabled && featureConfig.observabilityEnabled;

    const disabledReasons: string[] = [];
    if (!featureConfig.substrateEnabled) disabledReasons.push('peer_mediation_grant_signing_unavailable');
    if (!featureConfig.observabilityEnabled) disabledReasons.push('observability_disabled_by_server_policy');

    return {
        features: {
            machines: {
                enabled: true,
                peerMediation: {
                    enabled: featureConfig.substrateEnabled,
                    observability: { enabled: observabilityEnabled },
                },
            },
        },
        capabilities: {
            machines: {
                peerMediation: {
                    ...(featureConfig.grantSigningKeys.length > 0
                        ? {
                            grantSigningKeys: featureConfig.grantSigningKeys,
                            directRouteGrantProofMintVersions: [2],
                            tcpTunnelRelayAuthorizationMintVersions: [2],
                        }
                        : {}),
                    observability: {
                        enabled: observabilityEnabled,
                        available: observabilityEnabled,
                        supportedFlowKinds: observabilityEnabled ? OBSERVED_FLOW_KINDS : [],
                        supportedEventKinds: observabilityEnabled ? EMITTED_OBSERVABILITY_EVENT_KINDS : [],
                        bodyCapture: 'unavailable',
                        payloadCapture: 'unavailable',
                        disabledReasons,
                        publicPreviewScopedSummaries: false,
                    },
                },
            },
        },
    };
}
