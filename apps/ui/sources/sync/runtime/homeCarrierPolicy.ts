import {
    acquireHomeCarrierByPolicy,
    createOwnedHomeCarrierRelease,
    drainRetainedHomeCarrierReleases,
    resolveHomeCarrierPreferredTransport,
    type HomeApplicationCarrierEligibility,
} from '@happier-dev/cli-common/homeEnrollment';
import { classifyIrohHomeCarrierFailure, IrohError, IROH_HOME_TUNNEL_PROBE_FAILED_ERROR } from '@happier-dev/iroh-native';
import type { HomeConnectionDescriptorV1 } from '@happier-dev/protocol/auth/accountDirectory';
import { readRegisteredStorageState } from '@/sync/domains/state/storageStateReaderBridge';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { getSavedHomeConnectionSnapshot } from '@/sync/domains/server/serverProfiles';
import {
    acquireBrowserIrohHomeCarrier,
    resolveBrowserIrohHomeCarrierEligibility,
    type BrowserIrohHomeCarrier,
    type BrowserIrohHomeCarrierRequest,
} from '@/sync/runtime/browserIroh/homeCarrier/browserHomeCarrier';
import { resolveBrowserIrohHostDecision } from '@/sync/runtime/browserIroh/hostEligibility';
import { acquireIrohHomeRuntimeOrigin } from '@/sync/runtime/nativeIrohTunnels/runtime';
import { probeIrohHomeTunnelOrigin } from '@/sync/runtime/nativeIrohTunnels/probe';
import type {
    IrohHomeRuntimeOriginLease,
    IrohHomeTunnelAcquireInput,
    IrohHomeTunnelVerification,
} from '@/sync/runtime/nativeIrohTunnels/types';

export { createOwnedHomeCarrierRelease, drainRetainedHomeCarrierReleases };

export type AcquiredHomeCarrier =
    | Readonly<{ kind: 'browser_iroh'; carrier: BrowserIrohHomeCarrier; release: () => Promise<void> }>
    | Readonly<{ kind: 'native_iroh'; lease: IrohHomeRuntimeOriginLease; release: () => Promise<void> }>
    | Readonly<{ kind: 'https'; runtimeOrigin: string }>
    | Readonly<{ kind: 'unavailable'; error: unknown }>
    | Readonly<{ kind: 'fail_closed'; error: unknown; fallbackAllowed: boolean }>;

export type HomeCarrierAcquisitionInput = Readonly<{
    applicationCarrierEligibility?: HomeApplicationCarrierEligibility;
    descriptor: HomeConnectionDescriptorV1;
    verification: IrohHomeTunnelVerification;
    credentials?: AuthCredentials;
    acquireNative?: (input: IrohHomeTunnelAcquireInput) => Promise<IrohHomeRuntimeOriginLease>;
}>;

/** The device-local setting is authoritative even for callers that request automatic selection. */
export function readHomeApplicationCarrierEligibility(): HomeApplicationCarrierEligibility {
    return readRegisteredStorageState()?.localSettings?.homeApplicationCarrierEligibility ?? 'automatic';
}

type UiIrohCarrierValue =
    | Readonly<{ kind: 'browser'; carrier: BrowserIrohHomeCarrier }>
    | Readonly<{ kind: 'native'; lease: IrohHomeRuntimeOriginLease }>;

function browserRequestFor(input: HomeCarrierAcquisitionInput): BrowserIrohHomeCarrierRequest {
    const endpoint = input.descriptor.endpoints.find((candidate) => candidate.kind === 'iroh');
    if (!endpoint) throw new IrohError('unavailable', 'Home descriptor declares no Iroh endpoint');
    return input.verification.kind === 'enrollment'
        ? {
            purpose: 'enrollment', homeServerIdentityId: input.descriptor.homeServerIdentityId,
            endpoint, canonicalServerUrl: input.descriptor.canonicalServerUrl,
        }
        : {
            purpose: 'authenticated_home', credentials: input.credentials ?? { token: input.verification.token },
            homeServerIdentityId: input.descriptor.homeServerIdentityId,
            endpoint, canonicalServerUrl: input.descriptor.canonicalServerUrl,
        };
}

/** UI platform adapter for the one owner-neutral carrier selection/recovery policy. */
export async function acquireEligibleHomeCarrier(input: HomeCarrierAcquisitionInput): Promise<AcquiredHomeCarrier> {
    const selected = getSavedHomeConnectionSnapshot({ serverIdentityId: input.descriptor.homeServerIdentityId,
        canonicalServerUrl: input.descriptor.canonicalServerUrl });
    if (selected?.runtimeOrigin) return { kind: 'https', runtimeOrigin: selected.runtimeOrigin };
    const browserHost = resolveBrowserIrohHostDecision();
    const browser = browserHost.eligible || browserHost.reason === 'shared_worker_unsupported';
    const preferredTransport = resolveHomeCarrierPreferredTransport(input.descriptor);
    let verifiedApplicationOrigin: string | null = null;
    const verifyApplicationOrigin = async (runtimeOrigin: string): Promise<void> => {
        const result = await probeIrohHomeTunnelOrigin(runtimeOrigin, {
            remoteHostId: input.descriptor.homeServerIdentityId,
            homeServerIdentityId: input.descriptor.homeServerIdentityId,
            canonicalServerUrl: input.descriptor.canonicalServerUrl,
            verification: input.verification,
        });
        if (!result.ok) throw new Error(`${IROH_HOME_TUNNEL_PROBE_FAILED_ERROR}:${result.reason}`);
        verifiedApplicationOrigin = runtimeOrigin;
    };
    const result = await acquireHomeCarrierByPolicy<UiIrohCarrierValue>({
        applicationCarrierEligibility: readHomeApplicationCarrierEligibility() === 'standard_only'
            ? 'standard_only'
            : input.applicationCarrierEligibility ?? 'automatic',
        descriptor: input.descriptor,
        preferredTransport,
        classifyFailure: classifyIrohHomeCarrierFailure,
        ...(browser ? { probeApplicationOrigin: verifyApplicationOrigin } : {}),
        acquireIroh: async ({ endpoint }) => {
            if (browserHost.eligible) {
                const request = browserRequestFor(input);
                const eligibility = resolveBrowserIrohHomeCarrierEligibility(request, browserHost);
                if (!eligibility.eligible) {
                    throw new IrohError(
                        eligibility.reason === 'relays_missing' ? 'unavailable' : 'invalid_descriptor',
                        `Browser Iroh Home carrier ineligible: ${eligibility.reason}`,
                    );
                }
                const carrier = await acquireBrowserIrohHomeCarrier(request);
                return {
                    homeServerIdentityId: carrier.homeServerIdentityId,
                    endpointId: carrier.endpointId,
                    status: 'ready', release: carrier.release,
                    value: { kind: 'browser', carrier },
                };
            }
            if (browserHost.reason !== 'not_web' && browserHost.reason !== 'desktop_host') {
                throw new IrohError('unavailable', `Browser Iroh Home carrier unavailable: ${browserHost.reason}`);
            }
            const lease = await (input.acquireNative ?? acquireIrohHomeRuntimeOrigin)({
                homeServerIdentityId: input.descriptor.homeServerIdentityId,
                endpoint,
                canonicalServerUrl: input.descriptor.canonicalServerUrl,
                verification: input.verification,
            });
            return {
                homeServerIdentityId: lease.homeServerIdentityId,
                endpointId: lease.endpointId,
                status: lease.status === 'ready' ? 'ready' : 'degraded', release: lease.release,
                value: { kind: 'native', lease },
            };
        },
    });

    // HTTPS is the same Home only once this origin proves it. A Home with no Iroh
    // endpoint is an ordinary Standard Home and has no pinned identity to preserve.
    if (result.kind === 'https' && preferredTransport === 'iroh' && result.runtimeOrigin !== verifiedApplicationOrigin) {
        try {
            await verifyApplicationOrigin(result.runtimeOrigin);
        } catch (error) {
            return classifyIrohHomeCarrierFailure(error).fallbackAllowed
                ? { kind: 'unavailable', error }
                : { kind: 'fail_closed', error, fallbackAllowed: false };
        }
    }
    if (result.kind !== 'iroh') return result;
    if (result.carrier.value.kind === 'browser') {
        const carrier = { ...result.carrier.value.carrier, release: result.release };
        return { kind: 'browser_iroh', carrier, release: result.release };
    }
    const lease = { ...result.carrier.value.lease, release: result.release };
    return { kind: 'native_iroh', lease, release: result.release };
}
