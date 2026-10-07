import {
    HomeApplicationOriginV1Schema,
    HomeConnectionDescriptorV1Schema,
    type HomeConnectionDescriptorV1,
    type HomeCredentialDestinationSelectionV1,
} from '@happier-dev/protocol/auth/accountDirectory';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { createServerFetchAtEndpoint, type ServerFetch } from '@/sync/http/client';
import type { HomeCarrier } from '@/sync/runtime/homeCarrier';
import { acquireEligibleHomeCarrier, readHomeApplicationCarrierEligibility } from '@/sync/runtime/homeCarrierPolicy';
import type { IrohHomeTunnelVerification } from '@/sync/runtime/nativeIrohTunnels/types';

export type HomeEnrollmentTransportFailureReason =
    | 'no_approved_application_origin'
    | 'iroh_transport_unavailable'
    | 'iroh_transport_failed_closed';

export type HomeEnrollmentTransport = Readonly<{
    descriptor: HomeConnectionDescriptorV1;
    canonicalServerUrl: string;
    homeServerIdentityId: string;
    endpointUrl: string;
    /** URL-addressable transport origin; null when a semantic carrier owns bytes. */
    runtimeOrigin: string | null;
    carrier: 'https' | 'iroh';
    /** Exact descriptor destination authenticated by the selected carrier, when this resolver owns that proof. */
    authenticatedCredentialDestination: HomeCredentialDestinationSelectionV1 | null;
    /** Semantic carrier for browser Iroh, where no loopback runtime origin exists. */
    homeCarrier?: HomeCarrier | null;
    createRequest: (options?: Readonly<{
        serverId?: string | null;
        credentials?: AuthCredentials | null;
    }>) => ServerFetch;
    /** Release the selected carrier. Idempotent; HTTPS owns no runtime resource. */
    close: () => Promise<void>;
}>;

export type HomeEnrollmentTransportResolution =
    | Readonly<{ ok: true; transport: HomeEnrollmentTransport }>
    | Readonly<{
        ok: false;
        homeServerIdentityId: string;
        reason: HomeEnrollmentTransportFailureReason;
    }>;

/**
 * Transport-only descriptor for a Home this device has already established by URL and
 * pinned identity, used when the Home itself publishes no outer connection descriptor.
 *
 * A Home reachable only over loopback HTTP publishes none: the server emits an application
 * endpoint only for an explicitly configured HTTPS ingress
 * (`apps/server/sources/app/features/homeConnectionDescriptorPublication.ts`), while the CLI
 * still issues identity-bearing URL-only pairing links for exactly those Homes. Without this,
 * such a link can never be approved even by the browser that is signed into that Home.
 *
 * These are this device's own connection facts, never a shareable claim — the result is used
 * for one request and must never be persisted onto a profile or advertised to another device,
 * which is why the profile owner still refuses to synthesize a descriptor of its own. The
 * revision is the local floor rather than a published one, and an origin the Home application
 * policy does not approve yields null instead of a forged endpoint.
 */
export function buildEstablishedHomeTransportDescriptor(params: Readonly<{
    canonicalServerUrl: string;
    homeServerIdentityId: string;
}>): HomeConnectionDescriptorV1 | null {
    const canonicalServerUrl = String(params.canonicalServerUrl ?? '').trim().replace(/\/+$/, '');
    if (!canonicalServerUrl) return null;
    const parsed = HomeConnectionDescriptorV1Schema.safeParse({
        v: 1,
        homeServerIdentityId: params.homeServerIdentityId,
        canonicalServerUrl,
        revision: 1,
        endpoints: [{ kind: 'https', url: canonicalServerUrl }],
    });
    return parsed.success ? parsed.data : null;
}

function approvedApplicationOrigin(rawUrl: string): string | null {
    const parsed = HomeApplicationOriginV1Schema.safeParse(rawUrl);
    return parsed.success
        ? new URL(parsed.data).toString().replace(/\/+$/, '')
        : null;
}

/**
 * Canonical application transport for one immutable Home descriptor. It selects an approved
 * descriptor endpoint or acquires Lane06's verified lifecycle-neutral Iroh origin, while the
 * stable canonical URL remains the request identity/audience in either case.
 */
export async function resolveHomeEnrollmentTransport(
    descriptor: HomeConnectionDescriptorV1,
    options: Readonly<{
        runtimeOrigin?: string | null;
        runtimeCarrier?: 'https' | 'iroh';
        /** Already verified by the caller's exact Home connection; its owner retains the lease. */
        homeCarrier?: HomeCarrier | null;
        verification?: IrohHomeTunnelVerification;
    }> = {},
): Promise<HomeEnrollmentTransportResolution> {
    const canonicalEndpointUrl = approvedApplicationOrigin(descriptor.canonicalServerUrl);
    const resolvedRuntimeOrigin = options.runtimeOrigin
        ? approvedApplicationOrigin(options.runtimeOrigin)
        : null;
    const irohEndpoint = descriptor.endpoints.find((endpoint) => endpoint.kind === 'iroh') ?? null;
    if ((resolvedRuntimeOrigin || options.homeCarrier)
        && readHomeApplicationCarrierEligibility() === 'standard_only'
        && (options.homeCarrier || (options.runtimeCarrier ?? (irohEndpoint ? 'iroh' : 'https')) === 'iroh')) {
        return { ok: false, homeServerIdentityId: descriptor.homeServerIdentityId, reason: 'iroh_transport_unavailable' };
    }

    let endpointUrl: string | null = null;
    let runtimeOrigin: string | null = null;
    let carrier: 'https' | 'iroh' = 'https';
    let authenticatedCredentialDestination: HomeCredentialDestinationSelectionV1 | null = null;
    let homeCarrier: HomeCarrier | null = null;
    let close = async (): Promise<void> => {};

    if (options.homeCarrier) {
        endpointUrl = canonicalEndpointUrl;
        homeCarrier = options.homeCarrier;
        carrier = 'iroh';
        authenticatedCredentialDestination = { kind: 'iroh', endpointId: homeCarrier.endpointId };
    } else if (resolvedRuntimeOrigin) {
        endpointUrl = canonicalEndpointUrl;
        runtimeOrigin = resolvedRuntimeOrigin;
        carrier = options.runtimeCarrier ?? (irohEndpoint ? 'iroh' : 'https');
        if (carrier === 'https') {
            authenticatedCredentialDestination = { kind: 'https', applicationUrl: resolvedRuntimeOrigin };
        }
    } else if (canonicalEndpointUrl) {
        const acquired = await acquireEligibleHomeCarrier({
            mode: 'initial_selection',
            descriptor,
            verification: options.verification ?? { kind: 'enrollment' },
        });
        if (acquired.kind === 'fail_closed' || acquired.kind === 'unavailable') {
            return {
                ok: false,
                homeServerIdentityId: descriptor.homeServerIdentityId,
                reason: acquired.kind === 'unavailable' || acquired.fallbackAllowed
                    ? 'iroh_transport_unavailable'
                    : 'iroh_transport_failed_closed',
            };
        }
        endpointUrl = canonicalEndpointUrl;
        if (acquired.kind === 'https') {
            runtimeOrigin = acquired.runtimeOrigin;
            authenticatedCredentialDestination = {
                kind: 'https',
                applicationUrl: acquired.runtimeOrigin,
            };
        } else if (acquired.kind === 'browser_iroh') {
            homeCarrier = acquired.carrier;
            carrier = 'iroh';
            close = acquired.release;
            authenticatedCredentialDestination = {
                kind: 'iroh',
                endpointId: acquired.carrier.endpointId,
            };
        } else {
            runtimeOrigin = approvedApplicationOrigin(acquired.lease.runtimeOrigin);
            carrier = 'iroh';
            close = acquired.release;
            if (!runtimeOrigin) {
                await close().catch(() => {});
                return {
                    ok: false,
                    homeServerIdentityId: descriptor.homeServerIdentityId,
                    reason: 'iroh_transport_failed_closed',
                };
            }
            authenticatedCredentialDestination = {
                kind: 'iroh',
                endpointId: acquired.lease.endpointId,
            };
        }
    }

    if (!endpointUrl || (!runtimeOrigin && !homeCarrier)) {
        return {
            ok: false,
            homeServerIdentityId: descriptor.homeServerIdentityId,
            reason: irohEndpoint
                ? 'iroh_transport_unavailable'
                : 'no_approved_application_origin',
        };
    }

    const transport: HomeEnrollmentTransport = {
        descriptor,
        canonicalServerUrl: descriptor.canonicalServerUrl,
        homeServerIdentityId: descriptor.homeServerIdentityId,
        endpointUrl,
        runtimeOrigin,
        carrier,
        authenticatedCredentialDestination,
        homeCarrier,
        createRequest: (requestOptions = {}) => {
            const serverId = requestOptions.serverId === undefined
                ? descriptor.homeServerIdentityId
                : requestOptions.serverId;
            return createServerFetchAtEndpoint({
                endpointUrl,
                ...(runtimeOrigin ? { runtimeOrigin } : {}),
                ...(homeCarrier ? { homeCarrier } : {}),
                ...(serverId ? { serverId } : {}),
                ...('credentials' in requestOptions ? { credentials: requestOptions.credentials } : {}),
            });
        },
        close,
    };
    return { ok: true, transport };
}
