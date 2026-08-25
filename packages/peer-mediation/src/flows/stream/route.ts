import {
    readMachineLiveStreamRelayCaps,
    readServerEnabledBit,
    type FeaturesResponse,
    type MachineLiveStreamRelayCaps,
} from '@happier-dev/protocol';

import {
    mapPeerDirectPolicyDenyReasonToLiveStreamDisabledReason,
    type MachineLiveStreamDisabledReasonCode,
} from './disabledReasons.js';
import {
    resolveEffectivePeerDirectRoutePolicy,
    type PeerDirectPreference,
    type PeerDirectRouteGrantStatus,
} from '../../policy/effectiveDirectRoutePolicy.js';
import type { PeerRouteViabilityRecord } from '../../route/types.js';

export type LiveStreamRouteDecision =
    | Readonly<{
        kind: 'selected';
        flowKind: 'live_stream';
        routeKind: 'loopback_direct' | 'server_relay';
        relayCaps?: MachineLiveStreamRelayCaps;
        disabledReasons: readonly MachineLiveStreamDisabledReasonCode[];
    }>
    | Readonly<{
        kind: 'unavailable';
        reasonCode: MachineLiveStreamDisabledReasonCode;
        disabledReasons: readonly MachineLiveStreamDisabledReasonCode[];
    }>;

export type ResolveLiveStreamRouteDecisionInput = Readonly<{
    serverFeatures?: FeaturesResponse | null;
    preferredRouteKinds?: readonly ('loopback_direct' | 'server_relay')[];
    directRouteKind: 'loopback_direct';
    directRouteViability: PeerRouteViabilityRecord;
    directGrant: Readonly<{ status: PeerDirectRouteGrantStatus }>;
    daemonPolicy: boolean | null;
    accountMachinePreference: PeerDirectPreference;
    accountDefaultPreference: PeerDirectPreference;
    productDefaultPreference: Exclude<PeerDirectPreference, 'inherit'>;
    localCaptureAvailable: boolean;
    remoteDisplayAvailable: boolean;
    relayCaps?: MachineLiveStreamRelayCaps | null;
}>;

function unavailable(
    reasonCode: MachineLiveStreamDisabledReasonCode,
    disabledReasons: readonly MachineLiveStreamDisabledReasonCode[] = [reasonCode],
): LiveStreamRouteDecision {
    return {
        kind: 'unavailable',
        reasonCode,
        disabledReasons,
    };
}

function appendReason(
    reasons: MachineLiveStreamDisabledReasonCode[],
    reason: MachineLiveStreamDisabledReasonCode,
): void {
    if (!reasons.includes(reason)) reasons.push(reason);
}

function routeUnavailableReason(viability: PeerRouteViabilityRecord): MachineLiveStreamDisabledReasonCode {
    if (viability.status === 'unavailable') return 'endpoint_unavailable';
    return 'topology_unavailable';
}

export function resolveLiveStreamRouteDecision(input: ResolveLiveStreamRouteDecisionInput): LiveStreamRouteDecision {
    const serverFeatures = input.serverFeatures ?? null;
    if (!serverFeatures) return unavailable('server_features_unavailable');

    if (readServerEnabledBit(serverFeatures, 'machines.liveStream') !== true) {
        return unavailable('stream_unsupported');
    }
    if (!input.localCaptureAvailable) return unavailable('local_capture_unavailable');
    if (!input.remoteDisplayAvailable) return unavailable('remote_display_unavailable');

    const preferredRouteKinds = input.preferredRouteKinds ?? ['loopback_direct', 'server_relay'];
    const disabledReasons: MachineLiveStreamDisabledReasonCode[] = [];

    if (preferredRouteKinds.includes('loopback_direct')) {
        const directPeerEnabled = readServerEnabledBit(serverFeatures, 'machines.liveStream.directPeer') === true;
        if (!directPeerEnabled) {
            appendReason(disabledReasons, 'server_direct_disabled');
        } else if (input.directRouteViability.status !== 'viable') {
            appendReason(disabledReasons, routeUnavailableReason(input.directRouteViability));
        } else {
            const directPolicy = resolveEffectivePeerDirectRoutePolicy({
                flowKind: 'live_stream',
                routeKind: input.directRouteKind,
                serverGateEnabled: directPeerEnabled,
                daemonPolicy: input.daemonPolicy,
                accountMachinePreference: input.accountMachinePreference,
                accountDefaultPreference: input.accountDefaultPreference,
                productDefaultPreference: input.productDefaultPreference,
                grant: input.directGrant,
            });
            if (directPolicy.allowed) {
                return {
                    kind: 'selected',
                    flowKind: 'live_stream',
                    routeKind: 'loopback_direct',
                    disabledReasons: [],
                };
            }
            appendReason(
                disabledReasons,
                mapPeerDirectPolicyDenyReasonToLiveStreamDisabledReason(directPolicy.reasonCode),
            );
        }
    }

    if (preferredRouteKinds.includes('server_relay')) {
        const serverRoutedEnabled = readServerEnabledBit(serverFeatures, 'machines.liveStream.serverRouted') === true;
        if (!serverRoutedEnabled) {
            appendReason(disabledReasons, 'server_relay_disabled');
        } else {
            const relayCaps = input.relayCaps ?? readMachineLiveStreamRelayCaps(serverFeatures);
            if (!relayCaps) {
                appendReason(disabledReasons, 'relay_cap_missing');
            } else {
                return {
                    kind: 'selected',
                    flowKind: 'live_stream',
                    routeKind: 'server_relay',
                    relayCaps,
                    disabledReasons,
                };
            }
        }
    }

    const primaryReason = disabledReasons.includes('relay_cap_missing')
        ? 'relay_cap_missing'
        : disabledReasons[0] ?? 'stream_unsupported';
    return unavailable(primaryReason, disabledReasons);
}
