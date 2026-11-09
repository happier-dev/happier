import { rm, stat } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { IrohError } from '@happier-dev/iroh-native/node';
import { parseIrohEndpointDescriptorV1, type IrohEndpointDescriptorV1 } from '@happier-dev/protocol/connectivity/iroh/endpointDescriptorV1';
import { resolveHomeIrohEndpointKeyPath } from '@happier-dev/cli-common/firstPartyRuntime/server';
import { resolveBoundServerListener } from '@/app/runtime/startupReceipt';
import { resolveConfiguredCanonicalServerUrl } from '@/app/serverUrls/effectiveServerUrls';
import { log } from '@/utils/logging/log';
import { readHomeIrohEndpointConfigFromEnv, type HomeIrohEndpointEnvConfig } from './homeIrohEndpointConfig';
import { readHomeIrohTopologyFailure, type HomeIrohTopologyFailure } from './topology';
import {
    createHomeConnectionDescriptorContinuityStoreForServer,
    homeConnectionDescriptorContentKeyCarriesIroh,
    type HomeConnectionDescriptorContinuityStore,
} from '@/app/features/homeConnectionDescriptorContinuity';
import {
    loadHomeIrohNativeLifecycle,
    type HomeIrohNativeLifecycle,
} from './homeIrohNativeLifecycle';

/**
 * Canonical server-side owner of a Home's Iroh endpoint. startServer composes
 * it once after the API has listened, for either flavor with role `all`/`api`:
 *
 *   existing startApi listener -> one persistent Iroh endpoint (keyed by the
 *   canonical runtime layout key) -> one Home acceptor fixed to
 *   127.0.0.1:<actual Fastify port> -> published descriptor snapshot.
 *
 * Fail-closed contract: invalid explicit Iroh config, missing canonical auth
 * audience, continuity/key loss, endpoint identity drift, native config
 * conflicts, or a descriptor that does not parse through the protocol-owned
 * parser fail the Iroh composition closed and never publish a descriptor.
 * Native addon unavailability is a target-specific carrier failure: the Home
 * process stays runnable with an honest unavailable status. Relay policy and
 * URL configuration select Iroh behavior when the carrier exists; they do
 * not make the otherwise optional carrier a server-startup requirement.
 *
 * All tunnel payload bytes move in the native core; this owner manages
 * lifecycle only and exposes a small carrier-neutral seam
 * (`getHomeIrohEndpointState`) for descriptor consumers.
 */

const HOME_IROH_ACCEPTOR_TARGET_HOST = '127.0.0.1';

export type HomeIrohEndpointLifecycleStatus =
    | 'not-composed'
    | 'starting'
    | 'active'
    | 'stopping'
    | 'unavailable'
    | 'failed'
    | 'retired';

export type HomeIrohEndpointFailureReason =
    | HomeIrohTopologyFailure
    | 'invalid_iroh_config'
    | 'canonical_server_url_missing'
    | 'api_listen_port_unavailable'
    | 'continuity_metadata_unavailable'
    | 'continuity_metadata_unreadable'
    | 'exposure_proof_missing'
    | 'endpoint_key_lost'
    | 'endpoint_key_unavailable'
    | 'endpoint_config_conflict'
    | 'endpoint_identity_drift'
    | 'endpoint_not_active'
    | 'acceptor_not_running'
    | 'descriptor_invalid'
    | 'endpoint_cleanup_pending'
    | 'native_error';

export type HomeIrohEndpointSnapshot = Readonly<{
    endpoint: IrohEndpointDescriptorV1;
}>;

export type HomeIrohEndpointState = Readonly<{
    status: HomeIrohEndpointLifecycleStatus;
    snapshot: HomeIrohEndpointSnapshot | null;
    failureReason: HomeIrohEndpointFailureReason | null;
}>;

const NOT_COMPOSED_STATE: HomeIrohEndpointState = { status: 'not-composed', snapshot: null, failureReason: null };
const STARTING_STATE: HomeIrohEndpointState = { status: 'starting', snapshot: null, failureReason: null };
const STOPPING_STATE: HomeIrohEndpointState = { status: 'stopping', snapshot: null, failureReason: null };
const UNAVAILABLE_STATE: HomeIrohEndpointState = { status: 'unavailable', snapshot: null, failureReason: null };
const RETIRED_STATE: HomeIrohEndpointState = { status: 'retired', snapshot: null, failureReason: null };

/**
 * Derives the Iroh acceptor target port from the actual bound Fastify
 * listener. The target host is always the fixed 127.0.0.1 loopback, never the
 * listen host; a missing/unusable port fails the composition closed.
 */
export function resolveHomeIrohAcceptorPort(
    api: { server: { address(): AddressInfo | string | null } },
): number | null {
    return resolveBoundServerListener(api)?.port ?? null;
}

type ActiveHomeIrohEndpoint = Readonly<{
    state: HomeIrohEndpointState;
    configKey: string;
}>;

/**
 * The one native resource this owner holds. It is registered as soon as the
 * native endpoint exists and cleared only after every owned step has been
 * released, so a rejected teardown or startup cleanup stays owned here and is
 * retried by the next disposal instead of leaking or creating a second owner.
 */
type OwnedHomeIrohNativeEndpoint = {
    readonly native: HomeIrohNativeLifecycle;
    readonly endpointHandle: string;
    endpointShutdown: boolean;
};

let activeState: ActiveHomeIrohEndpoint | null = null;
let ownedEndpoint: OwnedHomeIrohNativeEndpoint | null = null;
let cleanupInFlight: Promise<void> | null = null;
let ensureInFlight: Promise<HomeIrohEndpointState> | null = null;
let stopInFlight: Promise<void> | null = null;
let lifecycleEpoch = 0;
let lifecycleState: HomeIrohEndpointState = NOT_COMPOSED_STATE;
/** Where this server composes Iroh, registered once by `startServer` (plan §3.2, AM-2). */
let composition: HomeIrohComposition | null = null;

/**
 * Test-only state reset for this module's process singleton. Owner tests use
 * this narrow seam instead of reloading the full server module graph between
 * cases. Production lifecycle callers must use `stopHomeIrohEndpoint`.
 */
export async function resetHomeIrohEndpointStateForTests(): Promise<void> {
    lifecycleEpoch += 1;
    const admittedEnsure = ensureInFlight;
    const admittedStop = stopInFlight;
    await admittedEnsure?.catch(() => undefined);
    await admittedStop?.catch(() => undefined);
    await releaseOwnedEndpoint().catch(() => undefined);
    activeState = null;
    ownedEndpoint = null;
    cleanupInFlight = null;
    ensureInFlight = null;
    stopInFlight = null;
    lifecycleEpoch = 0;
    lifecycleState = NOT_COMPOSED_STATE;
    composition = null;
}

/**
 * True while native resources are still owned outside a published composition:
 * a disposal is in flight, or a previous cleanup rejected and left the endpoint
 * owned. New composition work is refused until that custody is released.
 */
function isCleanupPending(): boolean {
    return activeState === null && (cleanupInFlight !== null || ownedEndpoint !== null);
}

/**
 * Attempts every owned cleanup step exactly once per disposal, keeps the
 * endpoint owned when any step rejects, and never caches a rejected attempt:
 * concurrent callers share the one in-flight cleanup, and the next caller
 * retries only the steps that have not settled.
 */
function releaseOwnedEndpoint(): Promise<void> {
    const owned = ownedEndpoint;
    if (!owned) return Promise.resolve();
    cleanupInFlight ??= runRelease(owned).then(
        () => {
            ownedEndpoint = null;
            cleanupInFlight = null;
        },
        (error: unknown) => {
            cleanupInFlight = null;
            throw error;
        },
    );
    return cleanupInFlight;
}

async function runRelease(owned: OwnedHomeIrohNativeEndpoint): Promise<void> {
    let firstFailure: unknown = null;
    if (!owned.endpointShutdown) {
        try {
            await owned.native.shutdownEndpoint({ endpointHandle: owned.endpointHandle });
            owned.endpointShutdown = true;
        } catch (error) {
            firstFailure ??= error;
            log({ module: 'iroh', level: 'warn', detail: error instanceof Error ? error.message : String(error) }, 'Home Iroh endpoint shutdown failed; the endpoint stays owned for a later disposal');
        }
    }
    if (firstFailure) throw firstFailure;
}

export type EnsureHomeIrohEndpointParams = Readonly<{
    env: NodeJS.ProcessEnv;
    /** Actual bound Fastify port (`resolveHomeIrohAcceptorPort`), or null when unavailable. */
    apiPort: number | null;
    /** Canonical outer descriptor continuity selected by the server lifecycle. */
    continuityStore?: HomeConnectionDescriptorContinuityStore;
    /**
     * Narrow injected native lifecycle boundary for owner-level tests.
     * Production composition resolves the exact @happier-dev/iroh-native
     * binding and never passes this parameter.
     */
    native?: HomeIrohNativeLifecycle | null;
}>;

export type MaterializeHomeIrohEndpointDescriptorParams = Readonly<{
    env: NodeJS.ProcessEnv;
    /** Canonical outer descriptor continuity selected by the maintenance lifecycle. */
    continuityStore?: HomeConnectionDescriptorContinuityStore;
    /** Test-only native lifecycle boundary; production resolves the packaged binding. */
    native?: HomeIrohNativeLifecycle | null;
}>;

export type HomeIrohEndpointMaterializationResult =
    | Readonly<{
        status: 'ready';
        endpoint: IrohEndpointDescriptorV1;
    }>
    | Readonly<{
        status: 'unavailable' | 'failed';
        failureReason: HomeIrohEndpointFailureReason | null;
    }>;

/**
 * Idempotently composes the Home Iroh endpoint. Repeated compatible
 * calls reuse the one active endpoint handle and acceptor; incompatible
 * configuration fails with a typed `endpoint_config_conflict` IrohError.
 */
export async function ensureHomeIrohEndpoint(params: EnsureHomeIrohEndpointParams): Promise<HomeIrohEndpointState> {
    if (stopInFlight) return failed('endpoint_cleanup_pending');
    if (ensureInFlight) return await ensureInFlight;
    const admittedEpoch = lifecycleEpoch;
    ensureInFlight = runEnsure(params, admittedEpoch)
        .then((state) => {
            lifecycleState = state;
            return state;
        })
        .finally(() => {
            ensureInFlight = null;
        });
    return await ensureInFlight;
}

/** Marks the pre-listen Personal Home interval as transitional, never retirement. */
export function beginHomeIrohEndpointStartup(): void {
    if (!activeState && !stopInFlight) lifecycleState = STARTING_STATE;
}

/** Completes a pre-listen attempt refused by topology or exposure admission. */
export function markHomeIrohEndpointStartupUnavailable(failureReason: HomeIrohEndpointFailureReason): void {
    if (!activeState && !stopInFlight && lifecycleState.status !== 'retired') {
        lifecycleState = { ...UNAVAILABLE_STATE, failureReason };
        log({ module: 'iroh', level: 'warn', failureReason },
            'Home Iroh startup unavailable; ordinary HTTP remains available');
    }
}

/**
 * The composition this server runs direct connections with: the listening API port and the outer
 * descriptor continuity chosen at startup. Registered only where Iroh is composed (a light Personal
 * Home whose exposure proof holds), so its presence is what "direct connections are available on
 * this Home" means to the owner console.
 */
export type HomeIrohComposition = Readonly<{
    env: NodeJS.ProcessEnv;
    apiPort: number | null;
    continuityStore: HomeConnectionDescriptorContinuityStore;
    /** Test-only native lifecycle boundary; production resolves the packaged binding. */
    native?: HomeIrohNativeLifecycle | null;
}>;

export function registerHomeIrohComposition(params: HomeIrohComposition): void {
    composition = params;
}

export function readHomeIrohComposition(): HomeIrohComposition | null {
    return composition;
}

/** Records at startup that the owner keeps direct connections off: nothing is composed or published. */
export function markHomeIrohEndpointRetired(): void {
    if (!activeState) lifecycleState = RETIRED_STATE;
}

/**
 * Owner-initiated retirement (plan §3.2, AM-2): stops the endpoint, deletes its identity key so the
 * identity can never come back, and reports `retired`, the one state the descriptor publisher
 * treats as an explicit removal of the Iroh endpoint. The caller publishes afterwards.
 */
export async function retireHomeIrohEndpoint(): Promise<HomeIrohEndpointState> {
    const current = composition;
    if (!current) return lifecycleState;
    await stopHomeIrohEndpoint();
    const keyPath = resolveHomeIrohEndpointKeyPath({ env: current.env });
    await rm(keyPath, { force: true });
    lifecycleState = RETIRED_STATE;
    return lifecycleState;
}

/**
 * Turns direct connections back on after an owner retirement. The retired key is gone, so the
 * endpoint starts with a new identity through the ordinary composition path.
 */
export async function resumeHomeIrohEndpoint(): Promise<HomeIrohEndpointState> {
    const current = composition;
    if (!current) return lifecycleState;
    if (lifecycleState.status === 'retired') lifecycleState = NOT_COMPOSED_STATE;
    return await ensureHomeIrohEndpoint({
        env: current.env,
        apiPort: current.apiPort,
        continuityStore: current.continuityStore,
        ...(current.native !== undefined ? { native: current.native } : {}),
    });
}

/**
 * Materializes the destination's fresh persistent endpoint identity and public
 * endpoint subdescriptor without starting a Home acceptor. Relocation calls
 * this only while the destination service is stopped and quarantined. This
 * owner neither consumes nor publishes an outer descriptor revision; the
 * canonical descriptor publisher applies the source revision floor.
 */
export async function materializeHomeIrohEndpointDescriptor(
    params: MaterializeHomeIrohEndpointDescriptorParams,
): Promise<HomeIrohEndpointMaterializationResult> {
    const topologyFailure = readHomeIrohTopologyFailure(params.env);
    if (topologyFailure) return { status: 'failed', failureReason: topologyFailure };
    if (activeState) {
        return { status: 'failed', failureReason: 'endpoint_config_conflict' };
    }
    if (isCleanupPending()) {
        return { status: 'failed', failureReason: 'endpoint_cleanup_pending' };
    }

    const native = params.native !== undefined ? params.native : loadHomeIrohNativeLifecycle();
    let config: HomeIrohEndpointEnvConfig;
    try {
        config = readHomeIrohEndpointConfigFromEnv(params.env);
    } catch (error) {
        const state = failed('invalid_iroh_config', error);
        return { status: 'failed', failureReason: state.failureReason };
    }
    const canonicalServerUrl = resolveConfiguredCanonicalServerUrl(params.env);
    if (!canonicalServerUrl) {
        const state = failed('canonical_server_url_missing');
        return { status: 'failed', failureReason: state.failureReason };
    }
    const keyPath = resolveHomeIrohEndpointKeyPath({ env: params.env });
    const provisioned = await provisionHomeIrohEndpoint({
        env: params.env,
        native,
        config,
        canonicalServerUrl,
        keyPath,
        continuityStore: params.continuityStore,
    });
    if (provisioned.kind === 'terminal') {
        return {
            status: provisioned.state.status === 'unavailable' ? 'unavailable' : 'failed',
            failureReason: provisioned.state.failureReason,
        };
    }

    try {
        // Materialization owns no ingress; releasing through the same custody
        // keeps a rejected disposal owned and retryable.
        await releaseOwnedEndpoint();
    } catch (error) {
        const state = failed('native_error', error);
        return { status: 'failed', failureReason: state.failureReason };
    }
    return {
        status: 'ready',
        endpoint: provisioned.endpoint,
    };
}

/**
 * Current carrier-neutral endpoint state for descriptor consumers. A request-time
 * read refreshes the native endpoint status through this Home endpoint owner so
 * authenticated descriptor publication can observe current direct-address hints
 * without adding polling, a watcher, or a second endpoint state machine.
 */
export async function getHomeIrohEndpointState(): Promise<HomeIrohEndpointState> {
    return await refreshActiveHomeIrohEndpointState();
}

/** Current lifecycle authority after preparation; never performs native IO. */
export function readHomeIrohEndpointLifecycleState(): HomeIrohEndpointState {
    return lifecycleState;
}

/**
 * Stops the Home Iroh ingress: clears the published in-memory snapshot first,
 * then delegates acceptor and endpoint cleanup to aggregate native shutdown.
 * Idempotent. New
 * composition work is refused from the moment the shutdown starts; a rejected
 * cleanup keeps the native endpoint owned and rejects here so the caller (the
 * canonical shutdown owner) can retry the same disposal.
 */
export async function stopHomeIrohEndpoint(): Promise<void> {
    if (stopInFlight) return await stopInFlight;
    lifecycleEpoch += 1;
    const admittedEnsure = ensureInFlight;
    activeState = null;
    lifecycleState = STOPPING_STATE;
    stopInFlight = (async () => {
        await admittedEnsure?.catch(() => undefined);
        activeState = null;
        lifecycleState = STOPPING_STATE;
        await releaseOwnedEndpoint();
    })().finally(() => {
        stopInFlight = null;
    });
    return await stopInFlight;
}

function failed(failureReason: HomeIrohEndpointFailureReason, error?: unknown): HomeIrohEndpointState {
    log(
        {
            module: 'iroh',
            level: 'warn',
            reason: failureReason,
            detail: error instanceof Error ? error.message : undefined,
        },
        `Home Iroh endpoint failed closed: ${failureReason}`,
    );
    return { status: 'failed', snapshot: null, failureReason };
}

function classifyNativeError(error: unknown): HomeIrohEndpointFailureReason {
    // Native errors can cross ESM/module-reset or addon boundaries where
    // `instanceof` identity is not stable. The public error code is the
    // contract; retain the class check only as an additional local signal.
    const structuralCode = typeof error === 'object' && error !== null && 'code' in error
        && typeof error.code === 'string'
        ? error.code
        : null;
    if ((error instanceof IrohError || structuralCode !== null)
        && structuralCode === 'endpoint_config_conflict') {
        return 'endpoint_config_conflict';
    }
    if ((error instanceof IrohError || structuralCode !== null)
        && structuralCode === 'endpoint_key_unavailable') {
        return 'endpoint_key_unavailable';
    }
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('endpoint_key_unavailable')) return 'endpoint_key_unavailable';
    if (message.includes('endpoint_config_conflict')) return 'endpoint_config_conflict';
    return 'native_error';
}

/**
 * Cleanup for a composition that never published. A rejected cleanup does not
 * change the reported failure, but the endpoint stays owned so the next
 * disposal retries it.
 */
async function cleanupNeverPublishedComposition(): Promise<void> {
    await releaseOwnedEndpoint().catch(() => undefined);
}

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
    return a.length === b.length && a.every((entry, index) => entry === b[index]);
}

function normalizeDirectAddresses(entries: readonly string[]): string[] {
    return [...new Set(entries.map((entry) => entry.trim()).filter((entry) => entry.length > 0))]
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Retires the published composition after a refresh observed something the
 * already-published descriptor contradicts.
 */
function failRefreshClosed(
    failureReason: HomeIrohEndpointFailureReason,
    error?: unknown,
): HomeIrohEndpointState {
    const state = failed(failureReason, error);
    lifecycleState = state;
    activeState = null;
    return state;
}

/**
 * A rejected native status read is an environment transient, not evidence
 * against the published descriptor. Retain the current endpoint facts and let
 * the next request
 * retry, rather than latching this owner into a terminal failure that would
 * stop the Home from publishing any descriptor for the rest of the process.
 */
function retainPublicationAfterRefreshTransient(step: string, error: unknown): HomeIrohEndpointState {
    log(
        { module: 'iroh', level: 'warn', detail: error instanceof Error ? error.message : String(error) },
        `Home Iroh descriptor refresh ${step} failed; keeping the published descriptor and retrying on the next request`,
    );
    return lifecycleState;
}

async function refreshActiveHomeIrohEndpointState(): Promise<HomeIrohEndpointState> {
    const active = activeState;
    const owned = ownedEndpoint;
    if (!active || !owned || lifecycleState.status !== 'active' || !active.state.snapshot) return lifecycleState;

    let endpointStatus: Awaited<ReturnType<HomeIrohNativeLifecycle['getEndpointStatus']>>;
    try {
        endpointStatus = await owned.native.getEndpointStatus({ endpointHandle: owned.endpointHandle });
    } catch (error) {
        return retainPublicationAfterRefreshTransient('endpoint status read', error);
    }
    // The native status read crosses an async lifecycle boundary. A stop or a
    // newer composition may have replaced this exact published/native owner
    // while it was pending; stale facts must never retire or revive that owner.
    if (activeState !== active || ownedEndpoint !== owned || lifecycleState !== active.state) {
        return lifecycleState;
    }
    if (!endpointStatus || !endpointStatus.active || endpointStatus.endpointId !== active.state.snapshot.endpoint.endpointId) {
        return failRefreshClosed('endpoint_not_active');
    }

    const directAddresses = normalizeDirectAddresses(endpointStatus.directAddresses);
    const relayUrls = active.state.snapshot.endpoint.relayUrls ?? [];
    if (sameStrings(active.state.snapshot.endpoint.directAddresses ?? [], directAddresses)) {
        return lifecycleState;
    }

    let endpoint: IrohEndpointDescriptorV1;
    try {
        endpoint = parseIrohEndpointDescriptorV1({
            endpointId: active.state.snapshot.endpoint.endpointId,
            ...(relayUrls.length > 0 ? { relayUrls } : {}),
            ...(directAddresses.length > 0 ? { directAddresses } : {}),
        });
    } catch (error) {
        return failRefreshClosed('descriptor_invalid', error);
    }

    const state: HomeIrohEndpointState = {
        status: 'active',
        snapshot: {
            endpoint,
        },
        failureReason: null,
    };
    lifecycleState = state;
    activeState = { ...active, state };
    return state;
}

type ProvisionedHomeIrohEndpoint = Readonly<{
    kind: 'ready';
    native: HomeIrohNativeLifecycle;
    endpointHandle: string;
    endpoint: IrohEndpointDescriptorV1;
}>;

type ProvisionHomeIrohEndpointResult =
    | ProvisionedHomeIrohEndpoint
    | Readonly<{ kind: 'terminal'; state: HomeIrohEndpointState }>;

async function provisionHomeIrohEndpoint(params: Readonly<{
    env: NodeJS.ProcessEnv;
    native: HomeIrohNativeLifecycle | null;
    config: HomeIrohEndpointEnvConfig;
    canonicalServerUrl: string;
    keyPath: string;
    continuityStore?: HomeConnectionDescriptorContinuityStore;
}>): Promise<ProvisionHomeIrohEndpointResult> {
    const continuityStore = params.continuityStore
        ?? createHomeConnectionDescriptorContinuityStoreForServer(params.env);
    if (!continuityStore) {
        return { kind: 'terminal', state: failed('continuity_metadata_unreadable') };
    }
    let continuity: Awaited<ReturnType<HomeConnectionDescriptorContinuityStore['read']>>;
    try {
        continuity = await continuityStore.read();
    } catch (error) {
        return { kind: 'terminal', state: failed('continuity_metadata_unreadable', error) };
    }

    const keyExists = await stat(params.keyPath)
        .then(
            () => true,
            (error: unknown) => {
                if ((error as { code?: unknown })?.code === 'ENOENT') return false;
                throw error;
            },
        )
        .catch(() => null);
    if (keyExists === null) {
        return { kind: 'terminal', state: failed('endpoint_key_unavailable') };
    }
    const previouslyPublishedIroh = continuity?.irohEndpointId !== undefined
        || homeConnectionDescriptorContentKeyCarriesIroh(continuity?.contentKey);
    if (previouslyPublishedIroh && !keyExists) {
        return { kind: 'terminal', state: failed('endpoint_key_lost') };
    }

    if (!params.native) {
        log(
            { module: 'iroh', level: 'warn' },
            'Native Iroh transport is unavailable on this target; the Home remains reachable on its ordinary HTTPS listener.',
        );
        return {
            kind: 'terminal',
            state: { status: 'unavailable', snapshot: null, failureReason: null },
        };
    }

    let created: { endpointHandle: string; endpointId: string };
    try {
        const endpointHandle = await params.native.createEndpoint({
            keyPath: params.keyPath,
            relayPolicy: params.config.relayPolicy,
            relayUrls: params.config.relayUrls,
            capProfile: 'homeInteractive',
        });
        created = { endpointHandle: endpointHandle.endpointHandle, endpointId: endpointHandle.endpointId };
    } catch (error) {
        return { kind: 'terminal', state: failed(classifyNativeError(error), error) };
    }
    // Custody is taken as soon as the native endpoint exists, before any status
    // read, descriptor projection, continuity write, or acceptor start, so every
    // later failure disposes through the one owner and a rejected disposal keeps
    // the endpoint owned for a retry.
    ownedEndpoint = {
        native: params.native,
        endpointHandle: created.endpointHandle,
        endpointShutdown: false,
    };

    const endpointStatus = await params.native.getEndpointStatus({ endpointHandle: created.endpointHandle }).catch(() => null);
    if (!endpointStatus || !endpointStatus.active || endpointStatus.endpointId !== created.endpointId) {
        await cleanupNeverPublishedComposition();
        return { kind: 'terminal', state: failed('endpoint_not_active') };
    }
    if (continuity?.irohEndpointId && continuity.irohEndpointId !== created.endpointId) {
        await cleanupNeverPublishedComposition();
        return { kind: 'terminal', state: failed('endpoint_identity_drift') };
    }

    const directAddresses = normalizeDirectAddresses(endpointStatus.directAddresses);
    const relayUrls = [...params.config.relayUrls];
    let endpoint: IrohEndpointDescriptorV1;
    try {
        endpoint = parseIrohEndpointDescriptorV1({
            endpointId: created.endpointId,
            ...(relayUrls.length > 0 ? { relayUrls } : {}),
            ...(directAddresses.length > 0 ? { directAddresses } : {}),
        });
    } catch (error) {
        await cleanupNeverPublishedComposition();
        return { kind: 'terminal', state: failed('descriptor_invalid', error) };
    }

    return {
        kind: 'ready',
        native: params.native,
        endpointHandle: created.endpointHandle,
        endpoint,
    };
}

async function runEnsure(params: EnsureHomeIrohEndpointParams, admittedEpoch: number): Promise<HomeIrohEndpointState> {
    const env = params.env;
    const topologyFailure = readHomeIrohTopologyFailure(env);
    if (topologyFailure) return { ...UNAVAILABLE_STATE, failureReason: topologyFailure };
    const native = params.native !== undefined ? params.native : loadHomeIrohNativeLifecycle();

    // (1) Strict operator relay configuration. Invalid explicit Iroh config
    // fails the Iroh composition closed without touching native transport.
    let config: HomeIrohEndpointEnvConfig;
    try {
        config = readHomeIrohEndpointConfigFromEnv(env);
    } catch (error) {
        return failed('invalid_iroh_config', error);
    }

    // (2) The stable canonical Home auth audience. This is configured through
    // HAPPIER_CANONICAL_SERVER_URL, with a bounded explicit legacy public-URL
    // fallback — never PUBLIC_URL, the loopback listener, or a client runtime origin.
    const canonicalServerUrl = resolveConfiguredCanonicalServerUrl(env);
    if (!canonicalServerUrl) {
        return failed('canonical_server_url_missing');
    }

    // (3) The actual bound API port; the acceptor target host is fixed loopback.
    const apiPort = params.apiPort;
    if (apiPort === null || !Number.isInteger(apiPort) || apiPort < 1 || apiPort > 65535) {
        return failed('api_listen_port_unavailable');
    }

    // (4) Repeated compatible ensure reuses the one active lifecycle.
    const keyPath = resolveHomeIrohEndpointKeyPath({ env });
    const configKey = JSON.stringify([canonicalServerUrl, config.relayPolicy, [...config.relayUrls], keyPath, apiPort]);
    if (activeState) {
        if (activeState.configKey !== configKey) {
            throw new IrohError('endpoint_config_conflict', 'Home Iroh endpoint is already active with an incompatible configuration');
        }
        return activeState.state;
    }
    // (5) A shutdown in flight, or a previous cleanup that rejected and still
    // owns the native endpoint, refuses new composition work rather than
    // creating a second owner for the same endpoint.
    if (isCleanupPending()) {
        return failed('endpoint_cleanup_pending');
    }

    lifecycleState = STARTING_STATE;

    const provisioned = await provisionHomeIrohEndpoint({
        env,
        native,
        config,
        canonicalServerUrl,
        keyPath,
        continuityStore: params.continuityStore,
    });
    if (provisioned.kind === 'terminal') return provisioned.state;

    // (12) One acceptor, fixed to the loopback target and the bound API port.
    const acceptor = await provisioned.native.startHomeAcceptor({
        endpointHandle: provisioned.endpointHandle,
        targetHost: HOME_IROH_ACCEPTOR_TARGET_HOST,
        targetPort: apiPort,
    }).catch(() => null);
    if (
        !acceptor
        || acceptor.endpointHandle !== provisioned.endpointHandle
        || !acceptor.status.running
    ) {
        await cleanupNeverPublishedComposition();
        return failed('acceptor_not_running');
    }

    // A stop admitted while native composition was in flight owns the late
    // handle. Never publish it, and finish its cleanup before stop resolves.
    if (admittedEpoch !== lifecycleEpoch) {
        await cleanupNeverPublishedComposition();
        return STOPPING_STATE;
    }

    // (15) Publish readiness only after the endpoint is active and the fixed
    // acceptor started.
    const state: HomeIrohEndpointState = {
        status: 'active',
        snapshot: {
            endpoint: provisioned.endpoint,
        },
        failureReason: null,
    };
    activeState = { state, configKey };
    log(
        {
            module: 'iroh',
            endpointId: provisioned.endpoint.endpointId,
        },
        `Home Iroh endpoint active; acceptor targeting ${HOME_IROH_ACCEPTOR_TARGET_HOST}:${apiPort}`,
    );
    return state;
}
