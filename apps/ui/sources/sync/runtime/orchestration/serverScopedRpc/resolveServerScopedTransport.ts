import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import {
    canonicalizeServerUrl,
} from '@/sync/domains/server/url/serverUrlCanonical';
import type { HomeCarrier } from '@/sync/runtime/homeCarrier';
import { ServerScopedTransportUnavailableError } from '@/sync/runtime/homeCarrier';
import {
    acquireEligibleHomeCarrier,
} from '@/sync/runtime/homeCarrierPolicy';
import type { HomeConnectionDescriptorV1 } from '@happier-dev/protocol/auth/accountDirectory';
import { getSavedHomeConnectionSnapshot } from '@/sync/domains/server/serverProfiles';

export { ServerScopedTransportUnavailableError } from '@/sync/runtime/homeCarrier';

type ServerTransportProfile = Readonly<{
    serverUrl: string;
    canonicalServerUrl?: string | null;
    homeConnectionDescriptor?: HomeConnectionDescriptorV1;
    serverIdentityId?: string | null;
}>;

export type ResolvedServerScopedTransport = Readonly<{
    canonicalServerUrl: string;
    /**
     * Where a URL-addressed carrier sends bytes: an independent HTTPS origin, or
     * the loopback origin a native Iroh lease binds. A semantic carrier has no
     * origin at all, so this stays the canonical Home URL rather than a
     * fabricated loopback one, and {@link homeCarrier} moves the bytes instead.
     */
    runtimeOrigin: string;
    carrier: 'https' | 'iroh';
    /** Lifecycle identity, present only for an acquired Iroh carrier. */
    leaseId?: string;
    /** Present only for a semantic carrier that owns its own bytes (browser Iroh). */
    homeCarrier?: HomeCarrier;
    release: () => Promise<void>;
}>;

/**
 * Makes a release coalesce concurrent callers into one in-flight underlying
 * release, propagate its first rejection, retry the underlying release exactly
 * once per later explicit call, and become idempotent after the first success.
 * Rejection custody stays with the caller: nothing retries, times, or swallows
 * automatically, so a caller that still owns the transport must call release
 * again after observing a rejection.
 */
export function onceAsync(release: () => Promise<void>): () => Promise<void> {
    let released = false;
    let inFlight: Promise<void> | null = null;
    return async () => {
        if (released) return;
        inFlight ??= release().then(
            () => {
                released = true;
                inFlight = null;
            },
            (error: unknown) => {
                // Clear in-flight custody so the next explicit call retries the
                // underlying release; the original rejection still propagates.
                inFlight = null;
                throw error;
            },
        );
        await inFlight;
    };
}

/**
 * Resolves one Home's stable identity/audience and acquired request carrier.
 * Canonical identity remains the reachability key; the verified runtime origin
 * is mutable transport metadata and is never persisted as the Home URL.
 */
export async function resolveServerScopedTransport(params: Readonly<{
    profile: ServerTransportProfile;
    credentials: AuthCredentials;
}>): Promise<ResolvedServerScopedTransport> {
    const canonicalServerUrl = canonicalizeServerUrl(
        String(params.profile.canonicalServerUrl ?? params.profile.serverUrl),
    );
    if (!canonicalServerUrl) throw new ServerScopedTransportUnavailableError();

    let runtimeOrigin = canonicalServerUrl;
    let carrier: 'https' | 'iroh' = 'https';
    let leaseId: string | undefined;
    let homeCarrier: HomeCarrier | undefined;
    let releaseCarrier = async (): Promise<void> => {};
    const saved = getSavedHomeConnectionSnapshot({ canonicalServerUrl, serverIdentityId: params.profile.serverIdentityId });
    const descriptor = params.profile.homeConnectionDescriptor ?? saved?.homeConnectionDescriptor;

    if (descriptor) {
        const acquired = await acquireEligibleHomeCarrier({
            descriptor,
            verification: { kind: 'authenticated', token: params.credentials.token },
            credentials: params.credentials,
        });
        if (acquired.kind === 'fail_closed' || acquired.kind === 'unavailable') {
            if (acquired.kind === 'unavailable') throw new ServerScopedTransportUnavailableError();
            if (acquired.fallbackAllowed) throw new ServerScopedTransportUnavailableError();
            throw acquired.error;
        }
        if (acquired.kind === 'https') {
            runtimeOrigin = acquired.runtimeOrigin;
        } else if (acquired.kind === 'browser_iroh') {
            carrier = 'iroh';
            leaseId = acquired.carrier.leaseId;
            homeCarrier = acquired.carrier;
            releaseCarrier = acquired.release;
        } else {
            runtimeOrigin = acquired.lease.runtimeOrigin;
            carrier = 'iroh';
            leaseId = acquired.lease.leaseId;
            releaseCarrier = acquired.release;
        }
    } else {
        runtimeOrigin = saved?.runtimeOrigin ?? canonicalServerUrl;
    }

    return {
        canonicalServerUrl,
        runtimeOrigin,
        carrier,
        ...(leaseId ? { leaseId } : {}),
        ...(homeCarrier ? { homeCarrier } : {}),
        release: releaseCarrier,
    };
}
