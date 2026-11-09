/**
 * The browser Home carrier seam (Lane 06 amendment A7.3).
 *
 * This module is deliberately cheap: it decides eligibility from host
 * capability plus the exact Home descriptor, and only then dynamically loads
 * the carrier runtime. A7.5 requires that HTTPS-only public use never pays for
 * the wasm/worker path, so nothing here may statically import the endpoint
 * client, the asset loader, or the tunnel codecs.
 *
 * Selection is automatic and narrow. A browser Home is carried over Iroh only
 * when the canonical descriptor names an exact EndpointId and at least one
 * explicitly configured relay, the host is a plain browser (never Tauri or
 * Electron, which keep the native direct-or-relay carrier), and a Home-scoped
 * credential exists. Relay URLs are reachability inputs only: the carrier is
 * accepted solely because Iroh cryptographically proves the selected
 * EndpointId, which the stream owner enforces before any application byte.
 * Ordinary Home use additionally requires a Home credential; only the explicit
 * enrollment purpose may acquire the same carrier before credentials exist.
 */

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import type { HomeCarrier } from '@/sync/runtime/homeCarrier';
import { IrohError, type IrohErrorCode } from '@happier-dev/iroh-native';
import type { IrohEndpointDescriptorV1 } from '@happier-dev/protocol/connectivity/iroh/endpointDescriptorV1';

import { resolveBrowserIrohHostDecision, type BrowserIrohHostDecision } from '../hostEligibility';

export type BrowserIrohHomeCarrierRequestCommon = Readonly<{
    /** The Home's stable identity; the carrier is scoped to it, never to a tab. */
    homeServerIdentityId: string;
    endpoint: IrohEndpointDescriptorV1;
    /** Retained for identity/audience only; the carrier never rewrites it. */
    canonicalServerUrl: string;
}>;

export type BrowserIrohHomeCarrierRequest = BrowserIrohHomeCarrierRequestCommon & (
    | Readonly<{
        /** Ordinary Home operation; the carrier is unavailable without Home credentials. */
        purpose?: 'authenticated_home';
        /** Proof that a Home-scoped credential exists. Requests attach their own. */
        credentials: AuthCredentials;
    }>
    | Readonly<{
        /** Narrow credentialless scope used only to obtain or redeem Home credentials. */
        purpose: 'enrollment';
        credentials?: never;
    }>
);

export type BrowserIrohHomeCarrierIneligibility =
    | 'host_ineligible'
    | 'identity_missing'
    | 'credential_missing'
    | 'endpoint_missing'
    | 'relays_missing';

export type BrowserIrohHomeCarrierEligibility =
    | Readonly<{ eligible: true; endpointId: string; relayUrls: readonly string[] }>
    | Readonly<{ eligible: false; reason: BrowserIrohHomeCarrierIneligibility }>;

export type BrowserIrohHomeCarrier = HomeCarrier & Readonly<{
    leaseId: string;
    homeServerIdentityId: string;
    appliedRelayUrls: readonly string[];
    /** Idempotent and retryable; releases this Home's lease and nothing else. */
    release: () => Promise<void>;
}>;

function normalizeRelayUrls(endpoint: IrohEndpointDescriptorV1): readonly string[] {
    return (endpoint.relayUrls ?? [])
        .map((relayUrl) => String(relayUrl ?? '').trim())
        .filter((relayUrl) => relayUrl.length > 0);
}

/**
 * `hostDecision` is injected so a test can describe a host without pretending to
 * be one; production reads the single host-identity owner.
 */
export function resolveBrowserIrohHomeCarrierEligibility(
    input: BrowserIrohHomeCarrierRequest,
    hostDecision: BrowserIrohHostDecision = resolveBrowserIrohHostDecision(),
): BrowserIrohHomeCarrierEligibility {
    if (!hostDecision.eligible) return { eligible: false, reason: 'host_ineligible' };
    if (!String(input.homeServerIdentityId ?? '').trim()) {
        return { eligible: false, reason: 'identity_missing' };
    }
    if (input.purpose !== 'enrollment' && !String(input.credentials?.token ?? '').trim()) {
        return { eligible: false, reason: 'credential_missing' };
    }
    const endpointId = String(input.endpoint?.endpointId ?? '').trim();
    if (!endpointId) return { eligible: false, reason: 'endpoint_missing' };
    const relayUrls = normalizeRelayUrls(input.endpoint);
    // Direct-address hints are unusable from a browser: it has no UDP/QUIC
    // transport, so an endpoint published without relays is not reachable here.
    if (relayUrls.length === 0) return { eligible: false, reason: 'relays_missing' };
    return { eligible: true, endpointId, relayUrls };
}

type BrowserIrohHomeCarrierOwner = Readonly<{
    acquire: (input: BrowserIrohHomeCarrierRequest) => Promise<BrowserIrohHomeCarrier>;
}>;

/**
 * The one loaded-runtime handle for this tab. Holding it here — rather than
 * re-importing per call — is what keeps release a no-op on a browser that never
 * became eligible: an HTTPS-only session never loads the wasm/worker path.
 */
let loadedOwner: Promise<BrowserIrohHomeCarrierOwner> | null = null;

/**
 * The worker/endpoint failure vocabulary projected onto the one canonical Iroh
 * Home carrier failure contract, so `classifyIrohHomeCarrierFailure` remains the
 * single fallback decision table for native and browser alike. Availability and
 * bounded transport loss may fall back to an independently trusted HTTPS
 * origin; configuration, protocol, resource, and cancellation failures do not.
 */
const BROWSER_IROH_FAILURE_CODES: Readonly<Record<string, IrohErrorCode>> = {
    endpoint_unavailable: 'unavailable',
    unknown_lease: 'transport',
    unknown_stream: 'transport',
    relay_required: 'endpoint_config_conflict',
    resource_limit: 'resource_limit',
    cancelled: 'cancelled',
    protocol_violation: 'invalid_preamble',
};

function normalizeBrowserIrohHomeCarrierFailure(error: unknown): unknown {
    if (error instanceof IrohError) return error;
    const candidate = error as Readonly<{ name?: unknown; code?: unknown }> | null;
    if (
        typeof candidate !== 'object'
        || candidate === null
        || candidate.name !== 'BrowserIrohClientError'
        || typeof candidate.code !== 'string'
    ) {
        return error;
    }
    const code = BROWSER_IROH_FAILURE_CODES[candidate.code];
    if (code === undefined) return error;
    return new IrohError(
        code,
        error instanceof Error ? error.message : 'Browser Iroh Home carrier failed',
        { cause: error },
    );
}

/**
 * Loads the carrier runtime on first use and acquires this Home's carrier.
 * The dynamic import is the packaging boundary: it must not become static.
 */
export async function acquireBrowserIrohHomeCarrier(
    input: BrowserIrohHomeCarrierRequest,
): Promise<BrowserIrohHomeCarrier> {
    const pending = loadedOwner ??= import('./browserHomeCarrierRuntime')
        .then((module) => module.browserIrohHomeCarrierOwner());
    let owner: BrowserIrohHomeCarrierOwner;
    try {
        owner = await pending;
    } catch (error) {
        // A build packaged without the browser Iroh assets must not cache its
        // failed load as this tab's owner; the next eligible caller retries.
        if (loadedOwner === pending) loadedOwner = null;
        throw normalizeBrowserIrohHomeCarrierFailure(error);
    }
    try {
        return await owner.acquire(input);
    } catch (error) {
        throw normalizeBrowserIrohHomeCarrierFailure(error);
    }
}
