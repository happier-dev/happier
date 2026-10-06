import {
    HomeConnectionDescriptorV1Schema,
    HomeConnectionEndpointV1Schema,
    isLoopbackHostname,
    type HomeConnectionDescriptorV1,
    type HomeConnectionEndpointV1,
    type IrohEndpointDescriptorV1,
} from "@happier-dev/protocol";
import {
    getHomeIrohEndpointState,
    type HomeIrohEndpointState,
} from "@/app/iroh/homeIrohEndpoint";
import {
    getOrCreateServerIdentityId,
    readCachedServerIdentityIdForHotPath,
} from "@/app/serverIdentity/serverIdentity";
import {
    resolveConfiguredCanonicalServerUrl,
    resolveConfiguredPublicServerUrl,
} from "@/app/serverUrls/effectiveServerUrls";
import { log } from "@/utils/logging/log";
import type { Tx } from "@/storage/inTx";
import {
    createHomeConnectionDescriptorContentKey,
    homeConnectionDescriptorContentKeyCarriesIroh,
    HomeConnectionDescriptorContinuityMalformedError,
    type HomeConnectionDescriptorContinuity,
    type HomeConnectionDescriptorContinuityStore,
} from './homeConnectionDescriptorContinuity';

/**
 * Canonical owner of the current Home transport descriptor composition.
 *
 * It consumes only explicit transport facts and never infers them:
 * - the stable canonical authentication origin (`resolveConfiguredCanonicalServerUrl`),
 * - the explicitly configured public server URL (`resolveConfiguredPublicServerUrl`)
 *   — an HTTPS endpoint is published only when this explicit ingress fact
 *   exists and is HTTPS or loopback HTTP, never merely because the canonical
 *   auth origin is an eligible URL,
 * - the current Iroh endpoint lifecycle (`getHomeIrohEndpointState`), included
 *   only while that owner reports active endpoint facts,
 * - the durable outer-descriptor continuity fact owned by this module. It
 *   covers the complete endpoint set, including HTTPS-only retirement, and
 *   retains the last published native/service EndpointId for key-loss/drift
 *   detection. No carrier owns or supplies an outer descriptor revision.
 *
 * Public and authenticated feature projections are derived from this one
 * composition. The public projection redacts direct-address hints; an
 * authenticated Home client may receive the full current descriptor. Home
 * login redemption does not carry a descriptor.
 */

export type HomeDescriptorPublicationFacts = Readonly<{
    homeServerIdentityId: string | null;
    canonicalServerUrl: string | undefined;
    /** Explicitly configured public server URL (actual ingress fact); null means none. */
    publicServerUrl: string | null;
    /** Explicit outer-revision floor published by the connectivity owner, when present. */
    minimumOuterRevisionExclusive: number | null;
    persistedOuterRevisionOwner: HomeConnectionDescriptorContinuity | null;
    iroh: HomeIrohEndpointState;
}>;

type RevisionOwnerState = Readonly<{
    revision: number;
    contentKey: string;
    irohEndpointId?: string;
}>;

let revisionOwner: RevisionOwnerState | null = null;
/** Last full descriptor committed by this process; public reads may only project this fact. */
let committedDescriptor: HomeConnectionDescriptorV1 | null = null;

/**
 * Durable continuity, read once per process. `unreadable` is a fail-closed
 * terminal state: a corrupt durable record must never be replaced by a fresh first
 * revision, which would silently regress every already-adopted descriptor.
 */
type ContinuityPrime =
    | Readonly<{ status: "ready"; persisted: HomeConnectionDescriptorContinuity | null }>
    | Readonly<{ status: "unreadable" }>
    | Readonly<{ status: "transient" }>;

let continuityPrime: ContinuityPrime | null = null;
let continuityPrimeInFlight: Promise<ContinuityPrime> | null = null;
let supersededLocalCandidate: Readonly<{
    contentKey: string;
    winner: HomeConnectionDescriptorContinuity;
}> | null = null;

/**
 * Non-poisoning serialization chain for the complete publication transaction:
 * endpoint observation, composition, revision allocation, durable commit,
 * in-memory commit, and projection. Serializing only file writes would let a
 * later observation allocate first and an older observation subsequently move
 * memory and disk to a higher revision carrying stale facts.
 */
let publicationTransactionChain: Promise<void> = Promise.resolve();

/** Test-only reset of the in-process monotonic revision owner. */
export function resetHomeConnectionDescriptorRevisionOwnerForTests(): void {
    revisionOwner = null;
    committedDescriptor = null;
    continuityPrime = null;
    continuityPrimeInFlight = null;
    supersededLocalCandidate = null;
    publicationTransactionChain = Promise.resolve();
}

/**
 * This module is the only producer and only reader of the persisted content
 * key, so it may inspect its own encoding to tell an endpoint-set change from
 * an unchanged republication.
 */
function contentKeyCarriesIrohEndpoint(contentKey: string | undefined): boolean {
    return homeConnectionDescriptorContentKeyCarriesIroh(contentKey);
}

/**
 * Monotonic outer revision calculation. Production primes the in-process
 * state from the durable outer continuity fact before composing a descriptor.
 * Effective endpoint-set changes publish a strictly greater revision. Only
 * the explicit relocation floor may raise the canonical outer frontier.
 */
function nextMonotonicOuterRevision(params: Readonly<{
    contentKey: string;
    minimumOuterRevisionExclusive: number | null;
}>): number | null {
    const lastRevision = revisionOwner?.revision ?? 0;
    const contentChanged = revisionOwner?.contentKey !== params.contentKey;
    let revision = revisionOwner === null || contentChanged
        ? lastRevision + 1
        : lastRevision;
    const floor = params.minimumOuterRevisionExclusive ?? 0;
    if (revision <= floor) revision = floor + 1;
    if (contentChanged && revision <= lastRevision) revision = lastRevision + 1;
    return Number.isSafeInteger(revision) && revision > 0 ? revision : null;
}

function httpsEndpointFromIngress(publicServerUrl: string | null): HomeConnectionEndpointV1 | null {
    if (!publicServerUrl) return null;
    try {
        const ingress = new URL(publicServerUrl);
        if (ingress.protocol !== "https:"
            && !(ingress.protocol === "http:" && isLoopbackHostname(ingress.hostname))) return null;
    } catch {
        return null;
    }
    // An ingress URL is a full application-origin candidate; the strict
    // endpoint schema (bounded, HTTPS-or-loopback-HTTP, no query/credentials)
    // is the only admittance path.
    const parsed = HomeConnectionEndpointV1Schema.safeParse({ kind: "https", url: publicServerUrl });
    return parsed.success ? parsed.data : null;
}

/**
 * Composes the full-fidelity current descriptor from explicit facts, or
 * undefined when the Home can present no strict endpoint set.
 */
export function composeHomeConnectionDescriptor(
    facts: HomeDescriptorPublicationFacts,
): HomeConnectionDescriptorV1 | undefined {
    if (revisionOwner === null && facts.persistedOuterRevisionOwner) {
        revisionOwner = facts.persistedOuterRevisionOwner;
    }
    const iroh = facts.iroh.status === "active" && facts.iroh.snapshot ? facts.iroh.snapshot : null;
    const priorEndpointId = revisionOwner?.irohEndpointId;
    // Starting, stopping, unavailable, failure, and an initial uncomposed
    // observation say nothing about explicit operator retirement. If the last
    // published set carried Iroh, publish nothing and preserve client state.
    // Only the explicit `retired` lifecycle state may remove it.
    if (!iroh
        && facts.iroh.status !== "retired"
        && contentKeyCarriesIrohEndpoint(revisionOwner?.contentKey)) {
        return undefined;
    }
    if (iroh && priorEndpointId && priorEndpointId !== iroh.endpoint.endpointId) {
        return undefined;
    }
    const homeServerIdentityId = facts.homeServerIdentityId;
    if (!homeServerIdentityId) return undefined;
    const canonicalServerUrl = facts.canonicalServerUrl;
    if (!canonicalServerUrl) return undefined;

    const endpoints: HomeConnectionEndpointV1[] = [];
    const httpsEndpoint = httpsEndpointFromIngress(facts.publicServerUrl);
    if (httpsEndpoint) endpoints.push(httpsEndpoint);
    if (iroh) {
        endpoints.push({
            kind: "iroh",
            endpointId: iroh.endpoint.endpointId,
            ...(iroh.endpoint.relayUrls ? { relayUrls: iroh.endpoint.relayUrls } : {}),
            ...(iroh.endpoint.directAddresses ? { directAddresses: iroh.endpoint.directAddresses } : {}),
        });
    }
    if (endpoints.length === 0) return undefined;

    const contentKey = createHomeConnectionDescriptorContentKey({
        homeServerIdentityId,
        canonicalServerUrl,
        endpoints,
    });
    const revision = nextMonotonicOuterRevision({
        contentKey,
        minimumOuterRevisionExclusive: facts.minimumOuterRevisionExclusive,
    });
    if (revision === null) return undefined;
    const parsed = HomeConnectionDescriptorV1Schema.safeParse({
        v: 1,
        homeServerIdentityId,
        canonicalServerUrl,
        revision,
        endpoints,
    });
    if (!parsed.success) return undefined;
    // An explicit retirement retires the identity with the endpoint: it is never published again,
    // so the pinned EndpointId (kept for key-loss and drift detection) is dropped with it and a
    // later composition may present a new identity (plan 2026-09-26-home-owner-console §3.2, AM-2).
    revisionOwner = {
        revision,
        contentKey,
        ...(iroh
            ? { irohEndpointId: iroh.endpoint.endpointId }
            : priorEndpointId && facts.iroh.status !== "retired"
                ? { irohEndpointId: priorEndpointId }
                : {}),
    };
    return parsed.data;
}

/**
 * Projects one composed descriptor for a visibility. The public projection
 * redacts direct-address hints; both require the descriptor to be bound to the
 * stable Home identity this server process advertises.
 */
function projectComposedHomeConnectionDescriptor(
    composed: HomeConnectionDescriptorV1 | undefined,
    facts: HomeDescriptorPublicationFacts,
    visibility: HomeConnectionDescriptorVisibility,
): HomeConnectionDescriptorV1 | undefined {
    if (!composed || composed.homeServerIdentityId !== facts.homeServerIdentityId) return undefined;
    if (visibility === "authenticated") return composed;
    return {
        ...composed,
        endpoints: composed.endpoints.map((endpoint) => endpoint.kind === "iroh"
            ? ({
                kind: "iroh",
                endpointId: endpoint.endpointId,
                ...(endpoint.relayUrls ? { relayUrls: endpoint.relayUrls } : {}),
            } satisfies HomeConnectionEndpointV1)
            : endpoint),
    };
}

export type HomeConnectionDescriptorVisibility = "public" | "authenticated";

export class HomeConnectionDescriptorPublicationUnavailableError extends Error {
    readonly code = "home_connection_descriptor_publication_unavailable" as const;

    constructor() {
        super("Home connection descriptor publication is unavailable");
        this.name = "HomeConnectionDescriptorPublicationUnavailableError";
    }
}

/** Public projection of the composed descriptor: direct-address hints are redacted. */
export function resolvePublishedHomeConnectionDescriptor(
    facts: HomeDescriptorPublicationFacts,
): HomeConnectionDescriptorV1 | undefined {
    return projectComposedHomeConnectionDescriptor(composeHomeConnectionDescriptor(facts), facts, "public");
}

/**
 * Authenticated current-Home projection. It preserves every canonical endpoint
 * fact, but only when the descriptor is bound to the same stable Home identity
 * advertised by this server process.
 */
export function resolveAuthenticatedHomeConnectionDescriptor(
    facts: HomeDescriptorPublicationFacts,
): HomeConnectionDescriptorV1 | undefined {
    return projectComposedHomeConnectionDescriptor(composeHomeConnectionDescriptor(facts), facts, "authenticated");
}

async function primeDescriptorContinuity(
    store: HomeConnectionDescriptorContinuityStore,
    tx?: Tx,
): Promise<ContinuityPrime> {
    if (continuityPrime) return continuityPrime;
    continuityPrimeInFlight ??= store.read(tx)
        .then((persisted): ContinuityPrime => ({ status: "ready", persisted }))
        .catch((error): ContinuityPrime => {
            log(
                { module: "iroh", level: "warn", detail: error instanceof Error ? error.message : undefined },
                error instanceof HomeConnectionDescriptorContinuityMalformedError
                    ? "Home connection descriptor continuity is malformed; publishing no descriptor"
                    : "Home connection descriptor continuity is temporarily unavailable; publishing no descriptor",
            );
            return error instanceof HomeConnectionDescriptorContinuityMalformedError
                ? { status: "unreadable" }
                : { status: "transient" };
        })
        .then((prime) => {
            continuityPrimeInFlight = null;
            if (prime.status !== "transient") continuityPrime = prime;
            return prime;
        });
    return await continuityPrimeInFlight;
}

function sameContinuity(
    a: HomeConnectionDescriptorContinuity,
    b: HomeConnectionDescriptorContinuity,
): boolean {
    return a.revision === b.revision
        && a.contentKey === b.contentKey
        && a.irohEndpointId === b.irohEndpointId;
}

/**
 * The one production read path for the Home connection descriptor. It resolves
 * the current endpoint facts, primes the durable outer revision once per
 * process, and persists a changed revision before the descriptor is published.
 * Persisting first matters: handing out a revision that a restart cannot
 * reproduce would leave clients rejecting the Home's real descriptor as stale.
 */
export async function readHomeConnectionDescriptor(params: Readonly<{
    env?: NodeJS.ProcessEnv;
    continuityStore: HomeConnectionDescriptorContinuityStore;
    visibility: HomeConnectionDescriptorVisibility;
    tx?: Tx;
    /** Narrow injected Iroh lifecycle boundary; production reads the live owner. */
    resolveIrohEndpointState?: () => HomeIrohEndpointState | Promise<HomeIrohEndpointState>;
}>): Promise<HomeConnectionDescriptorV1 | undefined> {
    const turn = publicationTransactionChain.then(async () => {
        return await readHomeConnectionDescriptorTransaction(params, false);
    });
    publicationTransactionChain = turn.then(() => undefined, () => undefined);
    const descriptor = await turn;
    if (descriptor && params.visibility === "authenticated") committedDescriptor = descriptor;
    return descriptor;
}

/**
 * Read-only public projection. A public feature probe must never allocate a
 * revision or write continuity. It can project the last descriptor committed
 * in this process; after restart it reconstructs only when the current facts
 * exactly match the durable generation, otherwise it fails closed.
 */
export async function readCommittedHomeConnectionDescriptor(params: Readonly<{
    env?: NodeJS.ProcessEnv;
    continuityStore: HomeConnectionDescriptorContinuityStore;
    resolveIrohEndpointState?: () => HomeIrohEndpointState | Promise<HomeIrohEndpointState>;
}>): Promise<HomeConnectionDescriptorV1 | undefined> {
    let continuity: HomeConnectionDescriptorContinuity | null;
    try {
        continuity = await params.continuityStore.read();
    } catch {
        return undefined;
    }
    if (!continuity) return undefined;
    const env = params.env ?? process.env;
    const identity = readCachedServerIdentityIdForHotPath(env);
    const canonicalServerUrl = resolveConfiguredCanonicalServerUrl(env);
    if (!identity || !canonicalServerUrl) return undefined;
    if (committedDescriptor
        && committedDescriptor.revision === continuity.revision
        && createHomeConnectionDescriptorContentKey({
            homeServerIdentityId: committedDescriptor.homeServerIdentityId,
            canonicalServerUrl: committedDescriptor.canonicalServerUrl,
            endpoints: committedDescriptor.endpoints,
        }) === continuity.contentKey
        && committedDescriptor.homeServerIdentityId === identity) {
        return projectComposedHomeConnectionDescriptor(committedDescriptor, {
            homeServerIdentityId: identity,
            canonicalServerUrl,
            publicServerUrl: null,
            minimumOuterRevisionExclusive: null,
            persistedOuterRevisionOwner: continuity,
            iroh: { status: "unavailable", snapshot: null, failureReason: null },
        }, "public");
    }
    const iroh = await (params.resolveIrohEndpointState ? params.resolveIrohEndpointState() : getHomeIrohEndpointState());
    const activeIroh = iroh.status === "active" && iroh.snapshot ? iroh.snapshot : null;
    const endpoints: HomeConnectionEndpointV1[] = [];
    const https = httpsEndpointFromIngress(resolveConfiguredPublicServerUrl(env) ?? null);
    if (https) endpoints.push(https);
    if (activeIroh) endpoints.push({ kind: "iroh", ...activeIroh.endpoint });
    if (endpoints.length === 0) return undefined;
    const contentKey = createHomeConnectionDescriptorContentKey({
        homeServerIdentityId: identity,
        canonicalServerUrl,
        endpoints,
    });
    if (contentKey !== continuity.contentKey) return undefined;
    const parsed = HomeConnectionDescriptorV1Schema.safeParse({
        v: 1,
        homeServerIdentityId: identity,
        canonicalServerUrl,
        revision: continuity.revision,
        endpoints,
    });
    return parsed.success
        ? projectComposedHomeConnectionDescriptor(parsed.data, {
            homeServerIdentityId: identity,
            canonicalServerUrl,
            publicServerUrl: null,
            minimumOuterRevisionExclusive: null,
            persistedOuterRevisionOwner: continuity,
            iroh,
        }, "public")
        : undefined;
}

/**
 * Required authenticated read for security-sensitive issuance/bootstrap paths.
 * An authoritative absence still returns undefined (the runtime is not acting
 * as a Home); continuity or publication failures throw a typed retryable error.
 */
export async function readRequiredAuthenticatedHomeConnectionDescriptor(params: Readonly<{
    env?: NodeJS.ProcessEnv;
    continuityStore: HomeConnectionDescriptorContinuityStore;
    tx?: Tx;
    resolveIrohEndpointState?: () => HomeIrohEndpointState | Promise<HomeIrohEndpointState>;
}>): Promise<HomeConnectionDescriptorV1 | undefined> {
    const turn = publicationTransactionChain.then(async () => {
        return await readHomeConnectionDescriptorTransaction({
            ...params,
            visibility: "authenticated",
        }, true);
    });
    publicationTransactionChain = turn.then(() => undefined, () => undefined);
    return await turn;
}

/**
 * Commits a relocation destination's exact outer descriptor before the
 * stopped destination reports materialization success. The endpoint owner
 * supplies only facts; this publisher alone applies the source revision floor
 * and persists the resulting descriptor generation.
 */
export async function reserveRelocatedHomeConnectionDescriptor(params: Readonly<{
    env: NodeJS.ProcessEnv;
    continuityStore: HomeConnectionDescriptorContinuityStore;
    minimumOuterRevisionExclusive: number;
    irohEndpoint: IrohEndpointDescriptorV1 | null;
}>): Promise<HomeConnectionDescriptorV1> {
    const canonicalServerUrl = resolveConfiguredCanonicalServerUrl(params.env);
    if (!canonicalServerUrl) throw new HomeConnectionDescriptorPublicationUnavailableError();
    let homeServerIdentityId: string;
    try {
        homeServerIdentityId = await getOrCreateServerIdentityId(params.env);
    } catch {
        throw new HomeConnectionDescriptorPublicationUnavailableError();
    }
    // This explicit stopped relocation selects the destination's carrier set.
    // A null endpoint allows only configured HTTPS ingress; ordinary lifecycle
    // unavailability still cannot retire an incumbent Iroh publication.
    const iroh: HomeIrohEndpointState = params.irohEndpoint ? {
        status: "active",
        snapshot: { endpoint: params.irohEndpoint },
        failureReason: null,
    } : { status: "retired", snapshot: null, failureReason: null };
    const turn = publicationTransactionChain.then(async () => await readHomeConnectionDescriptorTransaction({
        env: params.env,
        continuityStore: params.continuityStore,
        visibility: "authenticated",
        resolveIrohEndpointState: () => iroh,
        publicationIdentity: { homeServerIdentityId, canonicalServerUrl },
        minimumOuterRevisionExclusive: params.minimumOuterRevisionExclusive,
    }, true));
    publicationTransactionChain = turn.then(() => undefined, () => undefined);
    const descriptor = await turn;
    if (!descriptor) throw new HomeConnectionDescriptorPublicationUnavailableError();
    return descriptor;
}

async function readHomeConnectionDescriptorTransaction(params: Readonly<{
    env?: NodeJS.ProcessEnv;
    continuityStore: HomeConnectionDescriptorContinuityStore;
    visibility: HomeConnectionDescriptorVisibility;
    tx?: Tx;
    resolveIrohEndpointState?: () => HomeIrohEndpointState | Promise<HomeIrohEndpointState>;
    publicationIdentity?: Readonly<{ homeServerIdentityId: string; canonicalServerUrl: string }>;
    minimumOuterRevisionExclusive?: number;
}>, required: boolean): Promise<HomeConnectionDescriptorV1 | undefined> {
    const env = params.env ?? process.env;
    const [iroh, prime] = await Promise.all([
        params.resolveIrohEndpointState ? params.resolveIrohEndpointState() : getHomeIrohEndpointState(),
        primeDescriptorContinuity(params.continuityStore, params.tx),
    ]);
    if (prime.status !== "ready") {
        if (required) throw new HomeConnectionDescriptorPublicationUnavailableError();
        return undefined;
    }

    const facts: HomeDescriptorPublicationFacts = {
        homeServerIdentityId: params.publicationIdentity?.homeServerIdentityId
            ?? readCachedServerIdentityIdForHotPath(env),
        canonicalServerUrl: params.publicationIdentity?.canonicalServerUrl
            ?? resolveConfiguredCanonicalServerUrl(env),
        publicServerUrl: resolveConfiguredPublicServerUrl(env) ?? null,
        // An explicit floor belongs only to the relocation owner, not to an
        // ordinary publication read.
        minimumOuterRevisionExclusive: params.minimumOuterRevisionExclusive ?? null,
        persistedOuterRevisionOwner: prime.persisted,
        iroh,
    };
    // The first transaction after restart has the same committed predecessor
    // in durable continuity even though the process-local frontier is empty.
    // Required readers must not classify its unavailable Iroh endpoint as an
    // authoritative absence of Home service.
    const previouslyCommittedOwner = revisionOwner ?? prime.persisted;
    const composed = composeHomeConnectionDescriptor(facts);
    if (
        required
        && !composed
        && iroh.status !== "retired"
        && contentKeyCarriesIrohEndpoint(previouslyCommittedOwner?.contentKey)
    ) {
        throw new HomeConnectionDescriptorPublicationUnavailableError();
    }
    const candidateOwner = composed ? revisionOwner : previouslyCommittedOwner;
    // Composition calculates against the committed frontier, but the new
    // in-memory frontier becomes visible only after its durable write lands.
    revisionOwner = previouslyCommittedOwner;
    if (composed && candidateOwner) {
        try {
            if (supersededLocalCandidate?.contentKey === candidateOwner.contentKey) {
                const current = await params.continuityStore.read(params.tx);
                if (!current) {
                    if (required) throw new HomeConnectionDescriptorPublicationUnavailableError();
                    return undefined;
                }
                continuityPrime = { status: "ready", persisted: current };
                revisionOwner = current;
                if (current.contentKey !== candidateOwner.contentKey) {
                    if (!sameContinuity(current, supersededLocalCandidate.winner)) {
                        supersededLocalCandidate = {
                            contentKey: candidateOwner.contentKey,
                            winner: current,
                        };
                    }
                    if (required) throw new HomeConnectionDescriptorPublicationUnavailableError();
                    return undefined;
                }
                supersededLocalCandidate = null;
                const externallyCommittedDescriptor = current.revision === composed.revision
                    ? composed
                    : { ...composed, revision: current.revision };
                return projectComposedHomeConnectionDescriptor(
                    externallyCommittedDescriptor,
                    facts,
                    params.visibility,
                );
            }
            const result = await params.continuityStore.write(candidateOwner, params.tx);
            continuityPrime = { status: "ready", persisted: result.continuity };
            if (result.status === "superseded" && result.continuity.contentKey !== candidateOwner.contentKey) {
                revisionOwner = result.continuity;
                supersededLocalCandidate = {
                    contentKey: candidateOwner.contentKey,
                    winner: result.continuity,
                };
                if (required) throw new HomeConnectionDescriptorPublicationUnavailableError();
                return undefined;
            }
            revisionOwner = result.continuity;
            supersededLocalCandidate = null;
            const committedDescriptor = result.continuity.revision === composed.revision
                ? composed
                : { ...composed, revision: result.continuity.revision };
            return projectComposedHomeConnectionDescriptor(committedDescriptor, facts, params.visibility);
        } catch (error) {
            if (error instanceof HomeConnectionDescriptorContinuityMalformedError) {
                continuityPrime = { status: "unreadable" };
            }
            log(
                { module: "iroh", level: "warn", detail: error instanceof Error ? error.message : undefined },
                "Home connection descriptor continuity commit failed; publishing no descriptor",
            );
            if (required) throw new HomeConnectionDescriptorPublicationUnavailableError();
            return undefined;
        }
    }
    revisionOwner = candidateOwner;
    return projectComposedHomeConnectionDescriptor(composed, facts, params.visibility);
}
