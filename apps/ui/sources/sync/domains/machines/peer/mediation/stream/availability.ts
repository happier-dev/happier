import {
    resolveLiveStreamRouteDecision,
    type PeerDirectPreference,
    type PeerDirectRouteGrantStatus,
    type PeerRouteViabilityRecord,
} from '@happier-dev/peer-mediation';
import type { FeaturesResponse, MachineLiveStreamRelayCaps } from '@happier-dev/protocol';

export type MachineLiveStreamAvailability =
    | Readonly<{
        status: 'available';
        routeKind: 'loopback_direct' | 'server_relay';
        disabledReasons: readonly string[];
    }>
    | Readonly<{
        status: 'disabled';
        reasonCode: string;
        disabledReasons: readonly string[];
    }>
    | Readonly<{ status: 'refreshing' }>;

export function resolveMachineLiveStreamAvailability(_input: Readonly<{
    serverFeatures: FeaturesResponse | null;
    localCaptureAvailable: boolean;
    remoteDisplayAvailable: boolean;
    loopbackRoute: PeerRouteViabilityRecord;
    relayCaps: MachineLiveStreamRelayCaps | null;
    preferredRouteKinds?: readonly ('loopback_direct' | 'server_relay')[];
    directGrant: Readonly<{ status: PeerDirectRouteGrantStatus }>;
    daemonPolicy: boolean | null;
    accountMachinePreference: PeerDirectPreference;
    accountDefaultPreference: PeerDirectPreference;
    productDefaultPreference: Exclude<PeerDirectPreference, 'inherit'>;
}>): MachineLiveStreamAvailability {
    const input = _input;
    const decision = resolveLiveStreamRouteDecision({
        serverFeatures: input.serverFeatures,
        preferredRouteKinds: input.preferredRouteKinds,
        directRouteKind: 'loopback_direct',
        directRouteViability: input.loopbackRoute,
        directGrant: input.directGrant,
        daemonPolicy: input.daemonPolicy,
        accountMachinePreference: input.accountMachinePreference,
        accountDefaultPreference: input.accountDefaultPreference,
        productDefaultPreference: input.productDefaultPreference,
        localCaptureAvailable: input.localCaptureAvailable,
        remoteDisplayAvailable: input.remoteDisplayAvailable,
        relayCaps: input.relayCaps,
    });

    if (decision.kind === 'selected') {
        return {
            status: 'available',
            routeKind: decision.routeKind,
            disabledReasons: decision.disabledReasons,
        };
    }

    return {
        status: 'disabled',
        reasonCode: decision.reasonCode,
        disabledReasons: decision.disabledReasons,
    };
}
