/**
 * Page-side driver for the A7.3 loaded browser Home vertical proof
 * (`runBrowserIrohSharedEndpointProof.mjs --production-page-seam`).
 *
 * Unlike the A7.2 page, this one owns no transport at all. It imports the
 * PRODUCTION owners — `browserIrohHomeCarrierOwner` (the production entry to
 * `createBrowserIrohHomeCarrierOwner`), `createServerFetchAtEndpoint`,
 * `createHappierSocket`, and `acquireBrowserMachineCarrierStreamLease` —
 * and only sequences them, because A7.3's completion evidence is a real
 * Chromium journey through those owners, not through a proof's
 * re-implementation of them. That is also why this page is built by Metro
 * (`buildProductionProofPageBundle.mjs`): the production carrier reaches
 * `react-native` and `@/...`, which the A7.2 esbuild page cannot.
 *
 * Two harness stages drive this one page. `runProductionCarrierPageSeam.mjs` is
 * the LOADED SEAM: it proves the page is built from the production owners and
 * runs in Chromium, and exercises the one call that needs no network.
 * `runRealHomeVerticalJourney.mjs` is the A7.3 journey: it supplies the stock
 * local relay and the real Home acceptor from the `packages/iroh-native`
 * test-addon fixture and drives the carrier, HTTP, and socket commands below
 * against them.
 *
 * Every Home addressed through this page is ingress-less by construction: the
 * caller supplies a canonical URL that resolves nowhere, so any byte observed
 * through it could only have come over the Iroh carrier.
 *
 * Playwright can only pass plain data across `evaluate`, so every command
 * resolves to a JSON-safe record.
 */

import { TokenStorage } from '@/auth/storage/tokenStorage';
import {
    adoptHomeProfile,
    captureActiveServerRuntimeTarget,
    publishActiveServerRuntimeOrigin,
} from '@/sync/domains/server/serverProfiles';
import { setActiveServer } from '@/sync/domains/server/serverRuntime';
import { getReadyServerFeatures } from '@/sync/api/capabilities/getReadyServerFeatures';
import { resolveTargetServer } from '@/sync/domains/machines/peer/mediation/stream/productionRouteHttp';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { storage } from '@/sync/domains/state/storage';
import { isBrowserIrohHost } from '@/sync/runtime/browserIroh/hostEligibility';
import { acquireBrowserMachineCarrierStreamLease } from '@/sync/domains/transfers/runtime/transferRuntime/plumbing/machineCarrierBrowserStream';
import {
    resolveMachineCarrierRoute,
    type MachineCarrierHttpLease,
    type MachineCarrierRoute,
} from '@/sync/domains/transfers/runtime/transferRuntime/plumbing/machineCarrierHttpLease';
import { createHappierSocket } from '@happier-dev/sync-client';
import {
    CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
    buildAccountStoredContentCompatibilitySocketAuthV1,
} from '@happier-dev/protocol/clientCompatibility/accountStoredContentCompatibilityV1';
import { apiSocket } from '@/sync/api/session/apiSocket';
import { createServerFetchAtEndpoint } from '@/sync/http/client';
import type { BrowserIrohHomeCarrier } from '@/sync/runtime/browserIroh/homeCarrier/browserHomeCarrier';
import { browserIrohHomeCarrierOwner } from '@/sync/runtime/browserIroh/homeCarrier/browserHomeCarrierRuntime';
import { createBufferedTransferDestination } from '@/sync/domains/transfers/runtime/transferRuntime/carriers/createBufferedTransferDestination';
import { downloadBulkPayloadViaDirectExportToDestination } from '@/sync/domains/transfers/runtime/transferRuntime/plumbing/directTransferExportDownload';
import { uploadBulkPayloadFromFileViaMachineCarrier } from '@/sync/domains/transfers/runtime/transferRuntime/plumbing/uploadBulkPayloadFromFileViaMachineCarrier';
import { uploadSessionAttachmentFromReaderViaMachineCarrier } from '@/sync/domains/transfers/runtime/transferRuntime/families/uploadSessionAttachmentFromReaderViaMachineCarrier';
import type { MachineDaemonTransferState } from '@/sync/domains/transfers/runtime/transferRuntime/availability/machineDaemonTransferState';

type JsonRecord = Record<string, unknown>;

type SocketSession = Readonly<{
    destroy: () => Promise<void>;
    read: () => JsonRecord;
    emit: (event: string) => void;
    reconnect: () => void;
}>;

/**
 * What one HTTP request through the carrier has done SO FAR. The record is kept
 * after the request settles so the journey can come back later — once the Home
 * has released a response it was withholding — and see whether an aborted
 * request completed late. `settledAtMs` is recorded once and never rewritten, so
 * a late settlement would be visible as a changed record rather than hidden by
 * one.
 */
type HttpOutcomeRecord = {
    settled: 'pending' | 'resolved' | 'rejected';
    startedAtMs: number;
    settledAtMs: number | null;
    status?: number;
    bodyText?: string;
    /** Machine transfers move bytes, so their body is recorded byte-exactly. */
    bodyBase64?: string;
    error?: JsonRecord;
};

/** One carrier per adopted Home, exactly as the production owner scopes it. */
const carriers = new Map<string, BrowserIrohHomeCarrier>();
const httpOutcomes = new Map<string, HttpOutcomeRecord>();
let httpSequence = 0;
let socketSession: SocketSession | null = null;

/** The current daemon declaration for the loopback direct-transfer owner this journey starts. */
const currentMachineTransferState = {
    supported: { import: true, export: true },
    listenerClasses: {
        loopback_http: { enabled: true, configured: true, active: true },
        tailscale_serve_https: { enabled: false, configured: false, active: false, available: false },
    },
    lifecycle: { mode: 'lazy_idle_shutdown', version: 1 },
} satisfies MachineDaemonTransferState;

/**
 * A7.4 machine-carrier leases, keyed by the journey's own label so one page can
 * hold the admitted transfer and a deliberately mis-bound attempt at once. The
 * lease is the PRODUCTION `MachineCarrierHttpLease`; this page never unwraps it
 * into a private transport.
 */
const machineLeases = new Map<string, MachineCarrierHttpLease>();

function describeError(error: unknown): JsonRecord {
    if (error instanceof Error) {
        const code = (error as Error & { code?: unknown }).code;
        return {
            name: error.name,
            message: error.message,
            ...(typeof code === 'string' ? { code } : {}),
        };
    }
    return { name: 'unknown', message: String(error) };
}

async function settle<T extends JsonRecord>(run: () => Promise<T>): Promise<JsonRecord> {
    try {
        return { ok: true, ...(await run()) };
    } catch (error) {
        return { ok: false, error: describeError(error) };
    }
}

function requireCarrier(homeServerIdentityId: string): BrowserIrohHomeCarrier {
    const carrier = carriers.get(homeServerIdentityId);
    if (!carrier) throw new Error(`no carrier acquired for ${homeServerIdentityId}`);
    return carrier;
}

async function acquireCarrier(input: Readonly<{
    homeServerIdentityId: string;
    endpointId: string;
    relayUrls: readonly string[];
    canonicalServerUrl: string;
    token: string;
}>): Promise<JsonRecord> {
    // The production singleton owner: one SharedWorker endpoint for the whole
    // browser profile, one lease per Home. Nothing is injected — host
    // eligibility is decided by the real host-identity owner in this Chromium.
    const carrier = await browserIrohHomeCarrierOwner().acquire({
        homeServerIdentityId: input.homeServerIdentityId,
        endpoint: { endpointId: input.endpointId, relayUrls: [...input.relayUrls] },
        canonicalServerUrl: input.canonicalServerUrl,
        credentials: { token: input.token },
    });
    carriers.set(input.homeServerIdentityId, carrier);
    return {
        leaseId: carrier.leaseId,
        endpointId: carrier.endpointId,
        appliedRelayUrls: [...carrier.appliedRelayUrls],
        observedPath: carrier.readObservedPath(),
    };
}

async function httpRequest(input: Readonly<{
    homeServerIdentityId: string;
    canonicalServerUrl: string;
    token: string;
    path: string;
    /** Aborts the request after this delay, for the cancellation contract. */
    abortAfterMs?: number;
    /** Bounds a request that must never complete, so the page cannot hang. */
    giveUpAfterMs?: number;
}>): Promise<JsonRecord> {
    const carrier = requireCarrier(input.homeServerIdentityId);
    const request = createServerFetchAtEndpoint({
        endpointUrl: input.canonicalServerUrl,
        homeCarrier: carrier,
        credentials: { token: input.token },
        serverId: input.homeServerIdentityId,
    });

    httpSequence += 1;
    const requestId = `http-${httpSequence}`;
    const record: HttpOutcomeRecord = {
        settled: 'pending',
        startedAtMs: performance.now(),
        settledAtMs: null,
    };
    httpOutcomes.set(requestId, record);

    const controller = new AbortController();
    const abortTimer = typeof input.abortAfterMs === 'number'
        ? setTimeout(() => { controller.abort(); }, input.abortAfterMs)
        : null;

    // The record is written by the request's own settlement, not by the awaiting
    // caller, so a completion that arrives after the caller has moved on is
    // still recorded — which is exactly what "cannot complete late" needs.
    const settlement = request(input.path, { signal: controller.signal }, { retry: 'none' }).then(
        async (response) => {
            const bodyText = await response.text();
            if (record.settled !== 'pending') return;
            record.settled = 'resolved';
            record.settledAtMs = performance.now();
            record.status = response.status;
            record.bodyText = bodyText;
        },
        (error: unknown) => {
            if (record.settled !== 'pending') return;
            record.settled = 'rejected';
            record.settledAtMs = performance.now();
            record.error = describeError(error);
        },
    );

    const giveUpAfterMs = input.giveUpAfterMs;
    try {
        if (typeof giveUpAfterMs === 'number') {
            await Promise.race([
                settlement,
                new Promise<void>((resolve) => { setTimeout(resolve, giveUpAfterMs); }),
            ]);
        } else {
            await settlement;
        }
    } finally {
        if (abortTimer !== null) clearTimeout(abortTimer);
    }

    return {
        requestId,
        ...readHttpOutcome(requestId),
        observedPath: carrier.readObservedPath(),
    };
}

/**
 * Reads one request's record. The journey calls this again after the Home has
 * released a response it was withholding: an aborted request that stayed
 * `rejected`, with no body and its original settlement time, never completed
 * late.
 */
function readHttpOutcome(requestId: string): JsonRecord {
    const record = httpOutcomes.get(requestId);
    if (!record) throw new Error(`no HTTP request recorded for ${requestId}`);
    return {
        settled: record.settled,
        elapsedMs: (record.settledAtMs ?? performance.now()) - record.startedAtMs,
        settledAtMs: record.settledAtMs,
        ...(record.status === undefined ? {} : { status: record.status }),
        ...(record.bodyText === undefined ? {} : { bodyText: record.bodyText }),
        ...(record.bodyBase64 === undefined ? {} : { bodyBase64: record.bodyBase64 }),
        ...(record.error === undefined ? {} : { error: record.error }),
    };
}

/**
 * A plain browser `fetch` at the Home's canonical URL, with no carrier at all.
 *
 * This is the control that makes "ingress-less" an observation rather than an
 * assertion: the same origin every carried byte was addressed to must be
 * unreachable to the browser's own HTTP stack.
 */
async function probeCanonicalOrigin(url: string): Promise<JsonRecord> {
    try {
        const response = await fetch(url, { method: 'GET', mode: 'no-cors' });
        return { reachable: true, status: response.status };
    } catch (error) {
        return { reachable: false, error: describeError(error) };
    }
}

function openSocket(input: Readonly<{
    homeServerIdentityId: string;
    canonicalServerUrl: string;
    token: string;
}>): JsonRecord {
    const carrier = requireCarrier(input.homeServerIdentityId);
    const requestedUris: string[] = [];
    const updates: unknown[] = [];
    const connects: number[] = [];
    const disconnects: string[] = [];

    const { socket, transport } = createHappierSocket({
        clientType: 'user-scoped',
        clientPurpose: 'sync',
        authExtras: buildAccountStoredContentCompatibilitySocketAuthV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION),
        endpoint: input.canonicalServerUrl,
        token: input.token,
        websocketFactory: (uri, protocols, options) => {
            requestedUris.push(uri);
            return carrier.createWebSocket(uri, protocols, options);
        },
    });
    socket.on('update', (payload: unknown) => { updates.push(payload); });
    transport.onConnected(() => { connects.push(connects.length + 1); });
    transport.onDisconnected((event) => { disconnects.push(String(event.reason)); });

    socketSession = {
        destroy: async () => { await transport.destroy(); },
        emit: (event) => { socket.emit(event, {}); },
        // Reconnection is the connection supervisor's decision, and
        // `transport.connect()` is the entry point it calls. The journey plays
        // that role rather than adding a second reconnect policy here: the
        // socket, its authentication, and its stream come from the same
        // production owner as the first connection.
        reconnect: () => { void transport.connect(); },
        read: () => ({
            connected: transport.isConnected(),
            requestedUris: [...requestedUris],
            updates: [...updates],
            connectCount: connects.length,
            disconnects: [...disconnects],
        }),
    };
    void transport.connect();
    return { opened: true };
}

function requireSocket(): SocketSession {
    if (!socketSession) throw new Error('no socket session is open');
    return socketSession;
}

/**
 * The A7.4 loaded-page seam: the PRODUCTION browser machine-carrier lease,
 * imported and invoked here rather than re-implemented.
 *
 * Against a browser with no adopted server, credential, or target machine
 * descriptor this returns the production owner's own typed precondition
 * failure. That failure IS the evidence for what a completed A7.4 gate still
 * needs from a server fixture — a signed V2 direct-route grant and the daemon's
 * admission owner — and it proves the seam loads and runs in the Metro-built
 * page. It never fabricates a grant or an admission decision.
 */
async function probeMachineCarrierSeam(input: Readonly<{
    operationId: string;
    machineId: string;
    maxBytes: number;
}>): Promise<JsonRecord> {
    const lease = await acquireBrowserMachineCarrierStreamLease({
        operationId: input.operationId,
        machineId: input.machineId,
        acquireEndpointLease: async () => {
            throw new Error('unreachable: the grant is minted before any endpoint lease');
        },
        openMachineCarrierStream: async () => {
            throw new Error('unreachable: no stream may open without an admitted grant');
        },
    });
    return { remoteEndpointId: lease.remoteEndpointId, observedPath: lease.observedPath };
}

/**
 * Seeds this browser profile with one adopted Home and one target Machine —
 * through the PRODUCTION adoption, credential and machine-state owners, not a
 * private store.
 *
 * A7.4's production call graph starts at `resolveMachineCarrierRoute`, which
 * reads the focused Home profile, its stored credential, and the target
 * machine's published Iroh endpoint. Those are the facts a signed-in browser
 * already has; supplying them through `adoptHomeProfile`, `TokenStorage` and
 * `applyMachines` is what makes the rest of the journey the real path. Nothing
 * about transport, grant minting or admission is decided here.
 */
async function seedMachineTransferHome(input: Readonly<{
    homeServerIdentityId: string;
    canonicalServerUrl: string;
    homeEndpointId: string;
    homeRelayUrls: readonly string[];
    token: string;
    accountId: string;
    machineId: string;
    machineEndpointId: string;
    machineRelayUrls: readonly string[];
}>): Promise<JsonRecord> {
    const profile = await adoptHomeProfile({
        descriptor: {
            v: 1,
            homeServerIdentityId: input.homeServerIdentityId,
            canonicalServerUrl: input.canonicalServerUrl,
            revision: 1,
            endpoints: [{
                kind: 'iroh',
                endpointId: input.homeEndpointId,
                relayUrls: [...input.homeRelayUrls],
            }],
        },
        source: 'manual',
    });
    setActiveServer({ serverId: profile.id });
    const storedCredentials = await TokenStorage.setCredentialsForServerUrl(
        profile.serverUrl,
        { serverId: profile.id },
        { token: input.token },
    );

    // Production Sync activates the authenticated Home/account projection
    // before publishing Machine state. The loaded journey must cross that same
    // store owner so plaintext Machine RPC and active Machine projections are
    // evaluated in the signed-in account scope.
    storage.getState().activateProfileScope({
        serverId: profile.id,
        accountId: input.accountId,
    });

    // The focused Home's connection lease, exactly as the production connection
    // owner establishes it: one browser Iroh Home carrier published through the
    // canonical runtime-origin owner. Everything the machine route then needs
    // from the Home — server features and the signed grant — travels over this
    // carrier, because an ingress-less Home has no URL a browser can reach.
    const carrier = await browserIrohHomeCarrierOwner().acquire({
        homeServerIdentityId: input.homeServerIdentityId,
        endpoint: { endpointId: input.homeEndpointId, relayUrls: [...input.homeRelayUrls] },
        canonicalServerUrl: input.canonicalServerUrl,
        credentials: { token: input.token },
    });
    carriers.set(input.homeServerIdentityId, carrier);
    const publishedHomeCarrier = publishActiveServerRuntimeOrigin({
        target: captureActiveServerRuntimeTarget(),
        leaseId: carrier.leaseId,
        homeCarrier: carrier,
        carrier: 'iroh',
    });

    publishMachineDescriptor({
        serverId: profile.id,
        machineId: input.machineId,
        machineEndpointId: input.machineEndpointId,
        machineRelayUrls: input.machineRelayUrls,
    });

    // Production Sync initializes this account's canonical user-scoped socket
    // after the focused Home transport is published. Direct-transfer control
    // RPCs must cross that real socket owner; the journey only supplies the
    // Home server on the other side.
    apiSocket.initialize(
        { endpoint: profile.serverUrl, token: input.token },
        null,
    );
    const syncSocketConnected = await new Promise<boolean>((resolve) => {
        let unsubscribe: (() => void) | null = null;
        let finishedBeforeSubscriptionReturned = false;
        const finish = (connected: boolean) => {
            clearTimeout(timer);
            if (unsubscribe) unsubscribe();
            else finishedBeforeSubscriptionReturned = true;
            resolve(connected);
        };
        const timer = setTimeout(() => finish(false), 20_000);
        unsubscribe = apiSocket.onStatusChange((status) => {
            if (status === 'connected') finish(true);
        });
        if (finishedBeforeSubscriptionReturned) unsubscribe();
    });
    if (!syncSocketConnected) {
        throw new Error('the production user-scoped Sync socket did not connect through the Home carrier');
    }

    const activeServerAfterMachinePublish = getActiveServerSnapshot();
    const activeMachineAfterPublish = storage.getState().machines[input.machineId] ?? null;

    return {
        serverId: profile.id,
        serverUrl: profile.serverUrl,
        serverIdentityId: profile.serverIdentityId ?? null,
        storedCredentials,
        publishedHomeCarrier,
        homeCarrierEndpointId: carrier.endpointId,
        homeCarrierObservedPath: carrier.readObservedPath(),
        machineId: input.machineId,
        activeServerIdAfterMachinePublish: activeServerAfterMachinePublish.serverId,
        activeMachineStorageMode: activeMachineAfterPublish?.storageMode ?? null,
        syncSocketConnected,
    };
}

/**
 * Publishes one target Machine's Iroh endpoint into the production machine
 * state, through the same applier the sync engine uses.
 *
 * It is separate from Home seeding on purpose: the journey publishes several
 * machines against ONE adopted Home and one Home carrier, so re-seeding the
 * Home for each of them would churn adoption and the runtime-origin lease for
 * no reason.
 */
function publishMachineDescriptor(input: Readonly<{
    serverId: string;
    machineId: string;
    machineEndpointId: string;
    machineRelayUrls: readonly string[];
}>): JsonRecord {
    const now = Date.now();
    storage.getState().applyMachines([{
        id: input.machineId,
        seq: 1,
        createdAt: now,
        updatedAt: now,
        active: true,
        activeAt: now,
        storageMode: 'plain',
        metadata: null,
        metadataVersion: 1,
        operationProtocolCapabilities: {
            finiteTransferRpc: { protocolVersions: [1] },
            irohMachineEndpoint: {
                protocolVersions: [1],
                endpointId: input.machineEndpointId,
                relayUrls: [...input.machineRelayUrls],
            },
        },
        operationProtocolCapabilitiesRevision: 1,
        daemonState: {
            peerMediation: {
                iroh: {
                    endpoint: {
                        endpointId: input.machineEndpointId,
                        relayUrls: [...input.machineRelayUrls],
                    },
                },
            },
            transfer: currentMachineTransferState,
        },
        daemonStateVersion: 1,
    }], false, { sourceServerId: input.serverId });

    return { publishedMachineId: input.machineId, endpointId: input.machineEndpointId };
}

/**
 * The production route decision, unmodified, reported alongside the production
 * facts it is made from.
 *
 * `carrierKind` is what decides whether this browser is on the relay-only
 * machine/1 stream at all, and `standard` here would mean Iroh was never
 * selected. The inputs are reported by their own production readers so a
 * `standard` verdict names which fact was missing instead of leaving the gate
 * to guess.
 */
async function resolveMachineRoute(input: Readonly<{
    machineId: string;
    serverId: string;
}>): Promise<JsonRecord> {
    const route = await resolveMachineCarrierRoute(input.machineId, input.serverId);
    const activeServer = getActiveServerSnapshot();
    const machineList = storage.getState().machineListByServerId[input.serverId] ?? null;
    const published = machineList?.find((machine) => machine.id === input.machineId) ?? null;
    let serverFeatures: unknown = null;
    let serverFeaturesError: JsonRecord | null = null;
    try {
        serverFeatures = await getReadyServerFeatures({ serverId: input.serverId });
    } catch (error) {
        serverFeaturesError = describeError(error);
    }
    return {
        kind: route.kind,
        ...(route.kind === 'iroh_peer' ? { carrierKind: route.carrierKind } : {}),
        inputs: {
            browserIrohHost: isBrowserIrohHost(),
            activeServerId: activeServer.serverId,
            requestedServerId: input.serverId,
            resolvedTargetServer: resolveTargetServer(input.serverId),
            publishedMachineEndpoint: published?.operationProtocolCapabilities?.irohMachineEndpoint ?? null,
            machineListLength: machineList?.length ?? null,
            serverFeatures,
            serverFeaturesError,
        },
    };
}

/**
 * Acquires one machine carrier through the production route: the signed V2
 * grant is minted by the canonical mint owner over the Home carrier, and the
 * relay-only `happier/machine/1` stream is dialed and admitted beneath it.
 *
 * A rejected admission surfaces here as the production owner's typed failure —
 * the journey's evidence that nothing falls back after selection.
 */
async function acquireMachineCarrier(input: Readonly<{
    leaseKey: string;
    machineId: string;
    serverId: string;
    operationId: string;
}>): Promise<JsonRecord> {
    const route: MachineCarrierRoute = await resolveMachineCarrierRoute(input.machineId, input.serverId);
    if (route.kind !== 'iroh_peer') {
        throw new Error(`the production route did not select Iroh: ${route.kind}`);
    }
    const lease = await route.acquire({
        operationId: input.operationId,
    });
    machineLeases.set(input.leaseKey, lease);
    return { leaseKey: input.leaseKey, carrierKind: route.carrierKind, leaseKind: lease.kind };
}

function requireMachineLease(
    leaseKey: string,
): Extract<MachineCarrierHttpLease, { kind: 'browser_stream' }> {
    const lease = machineLeases.get(leaseKey);
    if (!lease) throw new Error(`no machine carrier lease acquired for ${leaseKey}`);
    if (lease.kind !== 'browser_stream') {
        throw new Error(`a browser must never acquire a ${lease.kind} machine carrier lease`);
    }
    return lease;
}

function encodeBase64(bytes: Uint8Array): string {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
}

/** Returns the request body buffer itself, which is what `BodyInit` accepts. */
function decodeBase64(value: string): ArrayBuffer {
    const binary = atob(value);
    const buffer = new ArrayBuffer(binary.length);
    const bytes = new Uint8Array(buffer);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return buffer;
}

/**
 * One application request over an admitted machine carrier. Bytes go in and out
 * base64-encoded so integrity is compared exactly rather than through text
 * coercion, and the settlement is recorded by the request itself — so a
 * completion arriving after an abort is visible instead of hidden.
 */
async function machineRequest(input: Readonly<{
    leaseKey: string;
    method: string;
    path: string;
    bodyBase64?: string;
    abortAfterMs?: number;
    giveUpAfterMs?: number;
}>): Promise<JsonRecord> {
    const lease = requireMachineLease(input.leaseKey);

    httpSequence += 1;
    const requestId = `machine-${httpSequence}`;
    const record: HttpOutcomeRecord = {
        settled: 'pending',
        startedAtMs: performance.now(),
        settledAtMs: null,
    };
    httpOutcomes.set(requestId, record);

    const controller = new AbortController();
    const abortTimer = typeof input.abortAfterMs === 'number'
        ? setTimeout(() => { controller.abort(); }, input.abortAfterMs)
        : null;

    const settlement = lease.request(`https://machine.invalid${input.path}`, {
        method: input.method,
        signal: controller.signal,
        ...(input.bodyBase64 === undefined ? {} : { body: decodeBase64(input.bodyBase64) }),
    }).then(
        async (response) => {
            const bytes = new Uint8Array(await response.arrayBuffer());
            if (record.settled !== 'pending') return;
            record.settled = 'resolved';
            record.settledAtMs = performance.now();
            record.status = response.status;
            record.bodyBase64 = encodeBase64(bytes);
        },
        (error: unknown) => {
            if (record.settled !== 'pending') return;
            record.settled = 'rejected';
            record.settledAtMs = performance.now();
            record.error = describeError(error);
        },
    );

    const giveUpAfterMs = input.giveUpAfterMs;
    try {
        if (typeof giveUpAfterMs === 'number') {
            await Promise.race([
                settlement,
                new Promise<void>((resolve) => { setTimeout(resolve, giveUpAfterMs); }),
            ]);
        } else {
            await settlement;
        }
    } finally {
        if (abortTimer !== null) clearTimeout(abortTimer);
    }

    return { requestId, ...readHttpOutcome(requestId) };
}

async function productionDirectImport(input: Readonly<{
    machineId: string;
    serverId: string;
    workingDirectory: string;
    path?: string;
    messageLocalId?: string;
    fileName?: string;
    uploadLocation?: 'workspace' | 'os_temp';
    workspaceRootPath?: string;
    workspaceRelativeDir?: string;
    vcsIgnoreStrategy?: 'git_info_exclude' | 'gitignore' | 'none';
    vcsIgnoreWritesEnabled?: boolean;
    payloadBase64: string;
    declaredSizeBytes?: number;
    cancelAfterReadCalls?: number;
}> & (
    | Readonly<{ transferKind: 'attachment'; sessionId: string }>
    | Readonly<{ transferKind?: 'file' }>
)): Promise<JsonRecord> {
    const payload = new Uint8Array(decodeBase64(input.payloadBase64));
    const controller = new AbortController();
    let readCalls = 0;
    const fileReader = {
        sizeBytes: payload.byteLength,
        readBytes: async (offset: number, length: number) => {
            readCalls += 1;
            if (typeof input.cancelAfterReadCalls === 'number' && readCalls > input.cancelAfterReadCalls) {
                controller.abort(new Error('cancelled by Chromium finite-transfer journey'));
            }
            return payload.subarray(offset, offset + length);
        },
        close: async () => undefined,
    };
    const result = input.transferKind === 'attachment'
        ? await uploadSessionAttachmentFromReaderViaMachineCarrier({
            machineId: input.machineId,
            serverId: input.serverId,
            fileReader,
            request: {
                t: 'session_attachment_upload_v1',
                sessionId: input.sessionId,
                workingDirectory: input.workingDirectory,
                messageLocalId: input.messageLocalId ?? 'browser-attachment',
                fileName: input.fileName ?? 'attachment.bin',
                sizeBytes: input.declaredSizeBytes ?? payload.byteLength,
                uploadLocation: input.uploadLocation ?? 'workspace',
                workspaceRootPath: input.workspaceRootPath,
                workspaceRelativeDir: input.workspaceRelativeDir ?? '.happier/uploads',
                vcsIgnoreStrategy: input.vcsIgnoreStrategy ?? 'none',
                vcsIgnoreWritesEnabled: input.vcsIgnoreWritesEnabled ?? false,
            },
            signal: controller.signal,
        })
        : await uploadBulkPayloadFromFileViaMachineCarrier({
            machineId: input.machineId,
            serverId: input.serverId,
            fileReader,
            directImportRequest: {
                t: 'session_file_upload_v1',
                workingDirectory: input.workingDirectory,
                path: input.path ?? 'payload.bin',
                sizeBytes: input.declaredSizeBytes ?? payload.byteLength,
                overwrite: true,
            },
            signal: controller.signal,
        });
    return { result, readCalls };
}

async function productionDirectExport(input: Readonly<{
    machineId: string;
    serverId: string;
    workingDirectory: string;
    path: string;
    maxBytes: number;
    cancelAfterWrite?: boolean;
    failDestinationWrite?: boolean;
}>): Promise<JsonRecord> {
    const buffered = createBufferedTransferDestination(input.maxBytes);
    const controller = new AbortController();
    let cleanupCalls = 0;
    let writeCalls = 0;
    const destination = {
        writeBytes: async (bytes: Uint8Array) => {
            writeCalls += 1;
            if (input.failDestinationWrite) throw new Error('destination write failed by journey');
            await buffered.destination.writeBytes(bytes);
            if (input.cancelAfterWrite) controller.abort(new Error('cancelled by Chromium finite-transfer journey'));
        },
        close: buffered.destination.close,
        cleanup: async () => {
            cleanupCalls += 1;
            await buffered.destination.cleanup();
        },
    };
    const machineRouteState: { selected: MachineCarrierRoute | null } = { selected: null };
    const result = await downloadBulkPayloadViaDirectExportToDestination({
        machineId: input.machineId,
        serverId: input.serverId,
        request: {
            t: 'workspace_file_download_v1',
            workingDirectory: input.workingDirectory,
            path: input.path,
            asZip: false,
        },
        destination,
        signal: controller.signal,
        acquirePreparedCarrier: async ({ operationId }) => {
            const route = machineRouteState.selected
                ?? await resolveMachineCarrierRoute(input.machineId, input.serverId);
            machineRouteState.selected = route;
            return route.kind === 'iroh_peer'
                ? await route.acquire({
                    operationId,
                    signal: controller.signal,
                })
                : null;
        },
    });
    return {
        result,
        destinationBase64: buffered.toBase64(),
        cleanupCalls,
        writeCalls,
        selectedRoute: machineRouteState.selected?.kind ?? null,
    };
}

const commands = {
    acquireCarrier: (input: Parameters<typeof acquireCarrier>[0]) => settle(async () => await acquireCarrier(input)),
    httpRequest: (input: Parameters<typeof httpRequest>[0]) => settle(async () => await httpRequest(input)),
    readHttpOutcome: (requestId: string) => settle(async () => readHttpOutcome(requestId)),
    probeCanonicalOrigin: (url: string) => settle(async () => await probeCanonicalOrigin(url)),
    openSocket: (input: Parameters<typeof openSocket>[0]) => settle(async () => openSocket(input)),
    readSocket: () => settle(async () => requireSocket().read()),
    emitSocket: (event: string) => settle(async () => { requireSocket().emit(event); return { emitted: event }; }),
    reconnectSocket: () => settle(async () => { requireSocket().reconnect(); return { reconnecting: true }; }),
    destroySocket: () => settle(async () => {
        await requireSocket().destroy();
        socketSession = null;
        return { destroyed: true };
    }),
    releaseCarrier: (homeServerIdentityId: string) => settle(async () => {
        await requireCarrier(homeServerIdentityId).release();
        carriers.delete(homeServerIdentityId);
        return { released: homeServerIdentityId };
    }),
    probeMachineCarrierSeam: (input: Parameters<typeof probeMachineCarrierSeam>[0]) =>
        settle(async () => await probeMachineCarrierSeam(input)),
    seedMachineTransferHome: (input: Parameters<typeof seedMachineTransferHome>[0]) =>
        settle(async () => await seedMachineTransferHome(input)),
    resolveMachineRoute: (input: Parameters<typeof resolveMachineRoute>[0]) =>
        settle(async () => await resolveMachineRoute(input)),
    acquireMachineCarrier: (input: Parameters<typeof acquireMachineCarrier>[0]) =>
        settle(async () => await acquireMachineCarrier(input)),
    machineRequest: (input: Parameters<typeof machineRequest>[0]) =>
        settle(async () => await machineRequest(input)),
    productionDirectImport: (input: Parameters<typeof productionDirectImport>[0]) =>
        settle(async () => await productionDirectImport(input)),
    productionDirectExport: (input: Parameters<typeof productionDirectExport>[0]) =>
        settle(async () => await productionDirectExport(input)),
    publishMachineDescriptor: (input: Parameters<typeof publishMachineDescriptor>[0]) =>
        settle(async () => publishMachineDescriptor(input)),
    // The released lease deliberately stays reachable: a later request on it
    // must be refused by the PRODUCTION closed-connection owner, not by this
    // page having forgotten it.
    releaseMachineCarrier: (leaseKey: string) => settle(async () => {
        await requireMachineLease(leaseKey).release();
        return { released: leaseKey };
    }),
} as const;

declare global {
    interface Window {
        __happierProductionCarrierSeam: typeof commands;
    }
}

window.__happierProductionCarrierSeam = commands;
