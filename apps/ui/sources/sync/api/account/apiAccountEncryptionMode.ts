import { readAccountE2eeCustody, TokenStorage, type AuthCredentials } from '@/auth/storage/tokenStorage';
import { decodeBase64 } from '@/encryption/base64';
import { parseToken } from '@/utils/auth/parseToken';
import { resolveAuthCredentialsScopeKey } from '@/auth/storage/resolveAuthCredentialsScopeKey';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { resolvePortableServerIdentityForRoutingId } from '@/sync/domains/server/resolvePortableServerIdentityForRoutingId';
import { backoff, backoffForever } from '@/utils/timing/time';
import type { ApiChangeEntry } from '@/sync/api/types/apiTypes';
import { createServerFetchForActiveServer, serverFetch, type ServerFetch, type ServerFetchOptions } from '@/sync/http/client';
import { sync } from '@/sync/sync';
import { readAccountEncryptionObservationBinding, recordAccountEncryptionCurrentnessRefusal, recordAccountEncryptionCurrentnessObservation, type AccountEncryptionObservationBinding } from '@/sync/http/accountEncryptionObservationBinding';
import { createScopedResolutionSingleFlight } from '@/sync/runtime/orchestration/serverScopedRpc/scopedResolutionSingleFlight';
import { admitReportedAccountMode, createAccountEncryptionCurrentnessObservation, projectAccountEncryptionIdentity, type AccountEncryptionIdentity } from '@happier-dev/sync-client';
import {
    getActiveServerSnapshot,
    getActiveServerHomeCarrier,
    type ActiveServerSnapshot,
} from '@/sync/domains/server/serverRuntime';
import { HappyError } from '@/utils/errors/errors';
import { throwIfAborted } from '@/utils/runtime/abortSignals';
import {
    AccountEncryptionModeResponseSchema,
    AccountEncryptionCurrentnessResponseSchema,
    AccountEncryptionCurrentnessErrorResponseSchema,
    type AccountEncryptionCurrentnessErrorResponse,
    type AccountEncryptionCurrentnessResponse,
    type AccountEncryptionModeResponse,
} from '@happier-dev/protocol/account/encryptionMode';

type AccountEncryptionMode = AccountEncryptionModeResponse['mode'];
type AccountEncryptionModeResult = Readonly<{ mode: AccountEncryptionMode; updatedAt: number }>;

export type AccountEncryptionReadUsage = 'identity' | 'fresh-authority';

/** Readiness on a rejected currentness read is not authority to migrate Account data. */
export class AccountEncryptionCurrentnessReadinessError extends HappyError {
    readonly recipientEnvelopeReadiness: AccountEncryptionCurrentnessErrorResponse['recipientEnvelopeReadiness'];

    constructor(readiness: AccountEncryptionCurrentnessErrorResponse['recipientEnvelopeReadiness']) {
        super('Account encryption currentness requires recovery', false, {
            status: 400,
            kind: 'config',
            code: 'account-encryption-currentness-unavailable',
        });
        Object.setPrototypeOf(this, AccountEncryptionCurrentnessReadinessError.prototype);
        this.recipientEnvelopeReadiness = readiness;
    }
}

const accountEncryptionModeReads = createScopedResolutionSingleFlight<AccountEncryptionModeResult>();
// Failure presentation belongs to the same pending read, including late
// borrowers. Entries disappear at settlement and retain no Account mode.
const accountEncryptionModeReadFailures = new Map<string, {
    state?: AccountEncryptionModeReadinessUnavailable;
    listeners: Set<(state: AccountEncryptionModeReadinessUnavailable) => void>;
}>();
const accountEncryptionIdentityReads = createScopedResolutionSingleFlight<AccountEncryptionIdentity>();
type AccountEncryptionInvalidation = Readonly<{ reason?: 'scope-reset' | 'transport-withdrawal'; serverId?: string | null }>;
type AccountEncryptionHomeBinding = Readonly<{ profileId: string; portableIdentity: string | null }>;
type AccountEncryptionInvalidationEvent = AccountEncryptionInvalidation & Readonly<{
    home: AccountEncryptionHomeBinding | null;
    source?: object;
    observation?: AccountEncryptionObservationBinding;
}>;
const accountEncryptionModeCacheInvalidationListeners = new Set<(invalidation: AccountEncryptionInvalidationEvent) => void>();
let accountEncryptionModeCacheRevision = 0;
// Only revision projections for observed Homes: no mode, credential or authority
// is retained here. Publication scopes these alongside the existing listeners.
const accountEncryptionModeHomeRevisions = new Map<string, {
    home: AccountEncryptionHomeBinding;
    revision: number;
}>();

function readAccountEncryptionHomeBinding(serverId?: string | null): AccountEncryptionHomeBinding | null {
    const profile = getServerProfileById(serverId ?? '');
    if (!profile) return null;
    return { profileId: profile.id, portableIdentity: resolvePortableServerIdentityForRoutingId(serverId) };
}

function accountEncryptionInvalidationAffectsHome(
    home: AccountEncryptionHomeBinding | null,
    eventHome: AccountEncryptionHomeBinding | null,
): boolean {
    if (!home || !eventHome || home.profileId === eventHome.profileId) return true;
    if (home.portableIdentity && eventHome.portableIdentity) return home.portableIdentity === eventHome.portableIdentity;
    // Established legacy profile ids distinguish Homes without portable ids;
    // a partially learned identity remains incomparable and fails closed.
    return Boolean(home.portableIdentity || eventHome.portableIdentity);
}

function normalizeAccountEncryptionMode(raw: unknown): AccountEncryptionMode {
    const value = String(raw ?? '').trim();
    // Fail closed to E2EE for unknown/legacy values.
    if (value === 'plain') return 'plain';
    if (value === 'e2ee') return 'e2ee';
    return 'e2ee';
}

function normalizeUpdatedAt(raw: unknown): number {
    return typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
}

/** The canonical server-and-credential identity for this Account mode read. */
export function getAccountEncryptionModeScopeKey(
    credentials: AuthCredentials,
    snapshot: Pick<
        ActiveServerSnapshot,
        'serverId' | 'serverUrl' | 'generation'
    > = getActiveServerSnapshot(),
): string {
    return [
        snapshot.serverId,
        snapshot.serverUrl,
        String(snapshot.generation),
        resolveAuthCredentialsScopeKey(credentials),
    ].join('\u0000');
}

export function invalidateAccountEncryptionModeCache(options: AccountEncryptionInvalidation = {}): void {
    publishAccountEncryptionInvalidation(options);
}

function publishAccountEncryptionInvalidation(options: AccountEncryptionInvalidation, source?: object,
    observation?: AccountEncryptionObservationBinding): void {
    accountEncryptionModeCacheRevision += 1;
    const event: AccountEncryptionInvalidationEvent = { ...options, home: readAccountEncryptionHomeBinding(options.serverId), source,
        ...(observation ? { observation } : {}) };
    if (event.home) accountEncryptionModeReads.invalidate(event.home.profileId);
    else accountEncryptionModeReads.reset();
    for (const projection of accountEncryptionModeHomeRevisions.values()) {
        if (accountEncryptionInvalidationAffectsHome(projection.home, event.home)) {
            projection.revision = accountEncryptionModeCacheRevision;
        }
    }
    if (!event.home) {
        // An unscoped reset already withdraws every projection; discard retired
        // profile ids along with it rather than retaining their history.
        accountEncryptionModeHomeRevisions.clear();
    }
    for (const listener of [...accountEncryptionModeCacheInvalidationListeners]) {
        try {
            listener(event);
        } catch {
            // One observer cannot block the incumbent cache owner from
            // withdrawing a stale Account disclosure for every other mount.
        }
    }
}

/** Thin transport adapter; the shared observation is the sole settled identity owner. */
export function createSocketAccountEncryptionObservation(options: Readonly<{
    credentials: AuthCredentials;
    serverId?: string | null;
    endpointUrl: string;
    runtimeOrigin: string;
    homeCarrierEndpointId: string | null;
    request: ServerFetch;
    isCurrent: () => boolean;
}>) {
    const unavailable = (step: 'socket_observation' | 'socket_binding_before_read' | 'socket_binding_after_read' = 'socket_observation') => {
        recordAccountEncryptionCurrentnessObservation({ event: 'observation_refused', ...observation.getDiagnosticState() });
        recordAccountEncryptionCurrentnessRefusal(step);
        return new HappyError('Account encryption observation unavailable', false, {
            kind: 'config', code: 'account-encryption-currentness-unavailable',
        });
    };
    const observation = createAccountEncryptionCurrentnessObservation({
        accountId: parseToken(options.credentials.token),
        accountE2eeCustody: () => readAccountE2eeCustody(options.credentials),
        readFresh: signal => readAccountEncryptionCurrentness(options.credentials, { request: options.request, signal }),
        unavailable,
    });
    const home = readAccountEncryptionHomeBinding(options.serverId);
    const invalidate = (event: AccountEncryptionInvalidationEvent) => {
        if (event.source === observation || event.reason === 'scope-reset') return;
        if (!accountEncryptionInvalidationAffectsHome(home, event.home)) return;
        observation.invalidate();
    };
    accountEncryptionModeCacheInvalidationListeners.add(invalidate);
    const notify = (reason?: AccountEncryptionInvalidation['reason']) =>
        publishAccountEncryptionInvalidation({ serverId: options.serverId, reason }, observation, binding);
    const binding: AccountEncryptionObservationBinding = {
        credentials: options.credentials,
        credentialScopeKey: resolveAuthCredentialsScopeKey(options.credentials),
        serverId: options.serverId ?? '',
        endpointUrl: options.endpointUrl,
        runtimeOrigin: options.runtimeOrigin,
        homeCarrierEndpointId: options.homeCarrierEndpointId,
        isCurrent: options.isCurrent,
        read: async signal => {
            if (!options.isCurrent()) throw unavailable('socket_binding_before_read');
            const identity = await observation.read(signal);
            if (!options.isCurrent()) throw unavailable('socket_binding_after_read');
            return identity;
        },
        readWitness: async signal => {
            if (!options.isCurrent()) throw unavailable('socket_binding_before_read');
            const witness = await observation.readWitness(signal);
            if (!options.isCurrent()) throw unavailable('socket_binding_after_read');
            return witness;
        },
        peek: () => options.isCurrent() ? observation.peek() : null,
    };
    return {
        binding,
        connected: () => { if (options.isCurrent()) { observation.connected(); notify('transport-withdrawal'); } },
        disconnected: () => { observation.disconnected(); notify('transport-withdrawal'); },
        update: (raw: unknown) => {
            if (options.isCurrent() && observation.update(raw)) {
                recordAccountEncryptionCurrentnessObservation({ event: 'observation_changed', ...observation.getDiagnosticState() });
                notify();
            }
        },
        /** `retainAdmitted`: an intentional visibility pause keeps the admitted mode for the next transport to revalidate. */
        dispose: (reason?: AccountEncryptionInvalidation['reason'], options?: Readonly<{ retainAdmitted?: boolean }>) => {
            accountEncryptionModeCacheInvalidationListeners.delete(invalidate);
            observation.dispose();
            if (!options?.retainAdmitted) notify(reason);
        },
    };
}

/** Presentation, settings and linked-service writes do not change persisted Account mode. */
export function invalidateAccountEncryptionModeCacheForChanges(
    changes: readonly Pick<ApiChangeEntry, 'kind' | 'entityId' | 'hint'>[],
    target?: Readonly<{ serverId?: string | null }>,
): void {
    const requiresModeRead = changes.some(change => {
        if (change.kind !== 'account' || change.entityId !== 'self') return false;
        const hint = change.hint;
        if (!hint || typeof hint !== 'object' || Array.isArray(hint)) return true;
        const entries: [string, unknown][] = Object.entries(hint);
        // Unknown/combined hints (including encryption transitions) still
        // withdraw disclosure. Only these exact known unrelated writes retain it.
        return entries.length === 0 || !entries.every(([key, value]) => (
            key === 'connectedServices' && value === true
            || key === 'linkedProviders' && value === true
            || key === 'name' && value === true
            || key === 'username' && (typeof value === 'string' || value === null)
            || key === 'settingsVersion' && typeof value === 'number'
                && Number.isSafeInteger(value) && value >= 0
        ));
    });
    if (requiresModeRead) invalidateAccountEncryptionModeCache(target);
}

/** Exact-Home disclosures observe only their own withdrawals; omitted scope observes all Homes. */
export function getAccountEncryptionModeCacheRevision(serverId?: string | null): number {
    if (serverId == null) return accountEncryptionModeCacheRevision;
    const home = readAccountEncryptionHomeBinding(serverId);
    if (!home) return accountEncryptionModeCacheRevision;
    const previous = accountEncryptionModeHomeRevisions.get(home.profileId);
    if (previous && previous.home.portableIdentity === home.portableIdentity) return previous.revision;
    // A first reader or a learned/replaced Home identity starts at the current
    // producer revision. Subsequent equal reads are constant-time and stable.
    accountEncryptionModeHomeRevisions.set(home.profileId, { home, revision: accountEncryptionModeCacheRevision });
    return accountEncryptionModeCacheRevision;
}

/** A finite observation belongs to its captured Home, not the ambient focus. */
export function captureAccountEncryptionCurrentness(serverId?: string | null, onTransportWithdrawal?: () => void): Readonly<{
    isCurrent: () => boolean;
    dispose: () => void;
}> {
    const home = readAccountEncryptionHomeBinding(serverId);
    let current = true;
    const invalidate = (event: AccountEncryptionInvalidationEvent): void => {
        if (!accountEncryptionInvalidationAffectsHome(home, event.home)) return;
        if (event.reason === 'transport-withdrawal') {
            onTransportWithdrawal?.();
            return;
        }
        // Unknown or incomparable bindings remain conservative, including a
        // legacy Home learning its portable identity during this operation.
        current = false;
        accountEncryptionModeCacheInvalidationListeners.delete(invalidate);
    };
    accountEncryptionModeCacheInvalidationListeners.add(invalidate);
    return {
        isCurrent: () => current,
        dispose: () => {
            current = false;
            accountEncryptionModeCacheInvalidationListeners.delete(invalidate);
        },
    };
}

/**
 * Observe disclosure withdrawal. Callers re-read through the canonical identity
 * owner instead of retaining another settled value channel.
 */
export function subscribeAccountEncryptionModeCacheInvalidation(
    listener: (invalidation: AccountEncryptionInvalidationEvent) => void,
    serverId?: string | null,
): () => void {
    const scopedListener = serverId == null ? listener : (event: AccountEncryptionInvalidationEvent) => {
        if (accountEncryptionInvalidationAffectsHome(readAccountEncryptionHomeBinding(serverId), event.home)) listener(event);
    };
    accountEncryptionModeCacheInvalidationListeners.add(scopedListener);
    return () => {
        accountEncryptionModeCacheInvalidationListeners.delete(scopedListener);
    };
}

type AccountEncryptionCurrentnessReadOptions = Readonly<{
    request?: (path: string, init: RequestInit, options?: ServerFetchOptions) => Promise<Response>;
    signal?: AbortSignal;
}>;

export async function fetchAccountEncryptionCurrentness(
    credentials: AuthCredentials,
    options: AccountEncryptionCurrentnessReadOptions = {},
): Promise<AccountEncryptionCurrentnessResponse> {
    throwIfAborted(options.signal);
    // Exact witnesses have a fresh server observation point per invocation.
    // They cannot join an identity bootstrap begun before a committed change.
    return await readAccountEncryptionCurrentness(credentials, options);
}

export async function fetchAccountEncryptionIdentity(
    credentials: AuthCredentials,
    options: AccountEncryptionCurrentnessReadOptions & Readonly<{
        usage: AccountEncryptionReadUsage;
        /** The containing finite operation already owns this identity admission. */
        readIdentity?: () => Promise<AccountEncryptionIdentity>;
    }>,
): Promise<AccountEncryptionIdentity> {
    throwIfAborted(options.signal);
    if (options.usage === 'identity' && options.readIdentity) return await options.readIdentity();
    const binding = options.usage === 'identity' ? options.request
        ? readAccountEncryptionObservationBinding(options.request, credentials)
        : sync?.getAccountEncryptionObservationBinding(credentials) ?? null : null;
    if (binding) return await binding.read(options.signal);
    if (options.usage === 'identity' && options.request) {
        const request = options.request;
        return await accountEncryptionIdentityReads.run(
            `${resolveAuthCredentialsScopeKey(credentials)}\u0000${accountEncryptionModeCacheRevision}`,
            async signal => projectAccountEncryptionIdentity(await fetchAccountEncryptionCurrentness(credentials, { request, signal })),
            { scope: request, signal: options.signal },
        );
    }
    return projectAccountEncryptionIdentity(await fetchAccountEncryptionCurrentness(credentials, options));
}

/**
 * A finite Session read borrows the settled socket identity. The Home reports both
 * facts and enforces persisted mode on each read and write CAS, so a fresh GET adds
 * no boundary here; the local downgrade admission stays. An unsettled observation
 * shares its one pending read, so a reconnect costs one read however many operations
 * arrive during it. A withdrawn observation or a failed read re-admits over the
 * operation's own HTTP request and credential.
 */
export async function fetchOperationAccountEncryptionIdentity(
    credentials: AuthCredentials,
    options: AccountEncryptionCurrentnessReadOptions,
): Promise<AccountEncryptionIdentity> {
    throwIfAborted(options.signal);
    const binding = options.request ? readAccountEncryptionObservationBinding(options.request, credentials) : null;
    const settled = binding && (binding.peek() ?? await binding.read(options.signal).catch(() => {
        throwIfAborted(options.signal);
        return null;
    }));
    if (!settled) return projectAccountEncryptionIdentity(await fetchAccountEncryptionCurrentness(credentials, options));
    admitReportedAccountMode({ reported: settled.mode, custody: readAccountE2eeCustody(credentials) });
    return settled;
}

/**
 * A read projection (opening already-stored content for display) borrows the
 * held Account observation's retained witness: mode and key changes arrive by
 * push and the Home refuses mismatched writes. Without a held observation, or
 * when it cannot settle, the operation reads once over its own request.
 */
export async function fetchBorrowedAccountEncryptionCurrentness(
    credentials: AuthCredentials,
    options: AccountEncryptionCurrentnessReadOptions = {},
): Promise<AccountEncryptionCurrentnessResponse> {
    throwIfAborted(options.signal);
    const binding = options.request ? readAccountEncryptionObservationBinding(options.request, credentials)
        : sync?.getAccountEncryptionObservationBinding(credentials) ?? null;
    const held = binding && await binding.readWitness(options.signal).catch(() => {
        throwIfAborted(options.signal);
        return null;
    });
    if (!held) return await fetchAccountEncryptionCurrentness(credentials, options);
    admitReportedAccountMode({ reported: held.mode, custody: readAccountE2eeCustody(credentials) });
    return held;
}

async function readAccountEncryptionCurrentness(
    credentials: AuthCredentials,
    options: AccountEncryptionCurrentnessReadOptions,
): Promise<AccountEncryptionCurrentnessResponse> {
    const currentness = await readReportedAccountEncryptionCurrentness(credentials, options);
    admitReportedAccountMode({ reported: currentness.mode, custody: readAccountE2eeCustody(credentials) });
    return currentness;
}

async function readReportedAccountEncryptionCurrentness(
    credentials: AuthCredentials,
    options: AccountEncryptionCurrentnessReadOptions,
): Promise<AccountEncryptionCurrentnessResponse> {
    const request: NonNullable<AccountEncryptionCurrentnessReadOptions['request']> = options.request ?? ((path: string, init?: RequestInit) =>
        serverFetch(path, init, { includeAuth: false }));
    const readCurrentness = async () => {
        let response: Response;
        try {
            response = await request('/v1/account/encryption/currentness', {
                method: 'GET',
                headers: {
                    Authorization: `Bearer ${credentials.token}`,
                    'Content-Type': 'application/json',
                },
                signal: options.signal,
            }, { includeAuth: false, retry: 'none' });
        } catch (error) {
            const name = error && typeof error === 'object' && 'name' in error ? error.name : null;
            recordAccountEncryptionCurrentnessObservation({ event: 'http_rejected',
                errorClass: name === 'Error' || name === 'TypeError' || name === 'AbortError' ? name : 'unknown' });
            throw error;
        }
        if (!response.ok) recordAccountEncryptionCurrentnessObservation({ event: 'http_response', status: response.status });
        return response;
    };
    let response = await readCurrentness();
    if (!response.ok) {
        if (response.status === 408 || response.status === 429 || response.status >= 500) {
            recordAccountEncryptionCurrentnessRefusal('http_response');
            throw new HappyError('Account encryption currentness is temporarily unavailable', true, {
                status: response.status, kind: 'server', code: 'account-encryption-currentness-unavailable',
            });
        }
        if (response.status === 400) {
            const recovery = AccountEncryptionCurrentnessErrorResponseSchema.safeParse(
                await response.json().catch(() => null),
            );
            if (recovery.success) {
                if (
                    recovery.data.recipientEnvelopeReadiness.reason === 'encryption_setup_required'
                    && 'secret' in credentials
                    // A captured request cannot authorize recovery through the
                    // independently selected Home and its stored credentials.
                    && !options.request
                ) {
                    const target = getActiveServerSnapshot();
                    const stored = target.serverUrl
                        ? await TokenStorage.getCredentialsForServerUrl(target.serverUrl, { serverId: target.serverId }).catch(() => null)
                        : null;
                    let secret: Uint8Array | null = null;
                    let expectedAccountId: string | null = null;
                    try {
                        secret = stored?.token === credentials.token && 'secret' in stored && stored.secret === credentials.secret
                            ? decodeBase64(credentials.secret)
                            : null;
                        expectedAccountId = parseToken(credentials.token);
                    } catch {
                        // Malformed retained material never becomes a recovery proof.
                    }
                    if (secret?.length === 32 && expectedAccountId && target.serverUrl) {
                        try {
                            const { authGetTokenAtEndpoint } = await import('@/auth/flows/getToken');
                            const homeCarrier = getActiveServerHomeCarrier();
                            // The missing-binding repair uses requireExistingAccount;
                            // compare the issued Account with the stored bearer below.
                            const repaired = await authGetTokenAtEndpoint({
                                endpointUrl: target.serverUrl,
                                ...(target.runtimeOrigin ? { runtimeOrigin: target.runtimeOrigin } : {}),
                                ...(homeCarrier ? { homeCarrier } : {}),
                                serverId: target.serverId,
                                addressAnchorUrl: target.serverUrl,
                                secret,
                                requireExistingAccount: true,
                                requireKeyChallengeV2: true,
                                ...(options.signal ? { signal: options.signal } : {}),
                            });
                            const current = getActiveServerSnapshot();
                            if (
                                parseToken(repaired.token) === expectedAccountId
                                && current.serverId === target.serverId
                                && current.serverUrl === target.serverUrl
                                && current.generation === target.generation
                            ) {
                                response = await readCurrentness();
                            }
                        } catch {
                            throwIfAborted(options.signal);
                            // Keep the original typed recovery result when proof fails.
                        } finally {
                            secret.fill(0);
                        }
                    }
                }
                if (response.ok) {
                    const repaired = AccountEncryptionCurrentnessResponseSchema.safeParse(
                        await response.json().catch(() => null),
                    );
                    if (repaired.success) {
                        return repaired.data;
                    }
                }
                recordAccountEncryptionCurrentnessObservation({ event: 'http_readiness', code: recovery.data.recipientEnvelopeReadiness.reason });
                recordAccountEncryptionCurrentnessRefusal('readiness_response');
                throw new AccountEncryptionCurrentnessReadinessError(recovery.data.recipientEnvelopeReadiness);
            }
        }
        recordAccountEncryptionCurrentnessRefusal('http_response');
        // An authentication refusal keeps its typed cause, as the mode route does.
        if (response.status === 401 || response.status === 403) {
            throw new HappyError('Failed to load encryption setting', false, {
                status: response.status, kind: 'server', code: response.status === 401 ? 'unauthorized' : 'forbidden',
            });
        }
        throw new HappyError(
            'This server must be upgraded before changing account encryption',
            false,
            {
                status: response.status,
                kind: 'config',
                code: 'account-encryption-currentness-unavailable',
            },
        );
    }
    const parsed =
        AccountEncryptionCurrentnessResponseSchema.safeParse(
            await response.json().catch(() => null),
        );
    if (!parsed.success) {
        recordAccountEncryptionCurrentnessObservation({ event: 'http_response', status: response.status });
        recordAccountEncryptionCurrentnessRefusal('invalid_response');
        throw new HappyError(
            'This server returned incomplete account encryption currentness',
            false,
            {
                status: response.status,
                kind: 'server',
                code: 'account-encryption-currentness-unavailable',
            },
        );
    }
    return parsed.data;
}

export async function fetchAccountEncryptionMode(
    credentials: AuthCredentials,
    opts: Readonly<{
        retry?: 'default' | 'none';
        onUnavailable?: (state: AccountEncryptionModeReadinessUnavailable) => void;
        /** Preserve the captured request's observation binding while cancelling this reader. */
        signal?: AbortSignal;
        /**
         * Explicit Home-targeted request transport. Reads never consult ambient
         * focus; identity usage may borrow only this request's admitted socket
         * observation, while authority usage makes one direct fresh attempt.
         */
        request?: (path: string, init?: RequestInit) => Promise<Response>;
        /** Final disclosure/sealing checks retain a fresh HTTP authority point. */
        usage?: AccountEncryptionReadUsage;
    }> = {},
): Promise<AccountEncryptionModeResult> {
    throwIfAborted(opts.signal);
    const binding = opts.usage !== 'fresh-authority' && (opts.usage === 'identity' || (!opts.request && opts.retry !== 'none'))
        ? opts.request ? readAccountEncryptionObservationBinding(opts.request, credentials)
            : sync?.getAccountEncryptionObservationBinding(credentials) ?? null
        : null;
    if (binding) {
        const read = async () => {
            const identity = await binding.read(opts.signal);
            return { mode: identity.mode, updatedAt: identity.updatedAt };
        };
        try {
            return !opts.request && !opts.signal && opts.retry !== 'none'
                ? await readSharedAccountEncryptionMode(credentials, read, opts.onUnavailable)
                : await read();
        } catch (error) {
            throwIfAborted(opts.signal);
            // 0.2 has the mode endpoint but no currentness push/read contract.
            // Preserve its direct mode admission; never downgrade an actual
            // unavailable, denied or malformed currentness observation.
            if (!(error instanceof HappyError && error.status === 404
                && error.code === 'account-encryption-currentness-unavailable')) throw error;
        }
    }
    const request = opts.request ?? (() => {
        const focusedRequest = createServerFetchForActiveServer();
        return (path: string, init?: RequestInit) => focusedRequest(path, init, { includeAuth: false });
    })();
    const run = async (): Promise<AccountEncryptionModeResponse> => {
        const response = await request(
            '/v1/account/encryption',
            {
                method: 'GET',
                signal: opts.signal,
                headers: {
                    Authorization: `Bearer ${credentials.token}`,
                    'Content-Type': 'application/json',
                },
            },
        );
        // Back-compat: older servers may not implement this endpoint. Fail closed to E2EE.
        if (response.status === 404) {
            return { mode: 'e2ee', updatedAt: 0 };
        }

        if (!response.ok) {
            const errorBody: unknown = await response.json().catch(() => null);
            if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
                throw new HappyError('Failed to load encryption setting', false, {
                    status: response.status,
                    kind: 'server',
                    code: response.status === 401 ? 'unauthorized' : response.status === 403 ? 'forbidden' : response.status === 400
                        && typeof errorBody === 'object'
                        && errorBody !== null
                        && 'error' in errorBody
                        && errorBody.error === 'account-encryption-recovery-required'
                        ? 'account-encryption-recovery-required'
                        : undefined,
                });
            }
            throw new HappyError(`Failed to load account encryption mode: ${response.status}`, true, {
                status: response.status, kind: 'server', code: 'account-encryption-mode-unavailable',
            });
        }

        const data: unknown = await response.json().catch(() => null);
        const parsed = AccountEncryptionModeResponseSchema.safeParse(data);
        if (!parsed.success) {
            throw new HappyError('Failed to parse account encryption mode response', false, {
                status: response.status, kind: 'server', code: 'account-encryption-mode-unavailable',
            });
        }
        return {
            mode: admitReportedAccountMode({
                reported: normalizeAccountEncryptionMode(parsed.data.mode),
                custody: readAccountE2eeCustody(credentials),
            }),
            updatedAt: normalizeUpdatedAt(parsed.data.updatedAt),
        };
    };

    if (opts.request && opts.usage === 'identity') {
        const scopeKey = `${resolveAuthCredentialsScopeKey(credentials)}\u0000${accountEncryptionModeCacheRevision}`;
        // Unbranded ordinary reads retain their exact callable lifetime at S2's
        // pending owner. Final authority and cursor witnesses never join them.
        return await accountEncryptionModeReads.run(scopeKey, run, { scope: opts.request });
    }
    if (opts.retry === 'none' || opts.request || opts.signal || opts.usage === 'fresh-authority') {
        return await run();
    }

    return await readSharedAccountEncryptionMode(credentials, run, opts.onUnavailable);
}

export type AccountEncryptionModeReadinessUnavailable = Readonly<{
    status: 'unavailable';
    reason: unknown;
    retrying: true;
}>;

/** One readiness retry owner for focused and exact-Home mounted Account reads. */
export async function readAccountEncryptionModeReadiness<T extends AccountEncryptionMode | AccountEncryptionModeResult>(
    run: () => Promise<T>,
    isCurrent: () => boolean,
    onUnavailable?: (state: AccountEncryptionModeReadinessUnavailable) => void,
): Promise<T> {
    const assertCurrent = () => {
        if (!isCurrent()) {
            throw new HappyError('Account encryption mode read retired', false, {
                kind: 'config', code: 'account-encryption-mode-read-retired',
            });
        }
    };
    let failureReported = false;
    const value = await backoffForever(async () => {
        assertCurrent();
        try {
            return await run();
        } catch (error) {
            assertCurrent();
            // A retry is ongoing work, not an unanswered initial read. Publish
            // the first failure once; retries keep that settled presentation.
            if (!failureReported) {
                failureReported = true;
                onUnavailable?.({ status: 'unavailable', reason: error, retrying: true });
            }
            throw error;
        }
    });
    assertCurrent();
    return value;
}

/** Preserve the incumbent mounted-readiness retry owner for fresh and observed reads alike. */
async function readSharedAccountEncryptionMode(
    credentials: AuthCredentials,
    run: () => Promise<AccountEncryptionModeResult>,
    onUnavailable?: (state: AccountEncryptionModeReadinessUnavailable) => void,
): Promise<AccountEncryptionModeResult> {
    const target = getActiveServerSnapshot();
    const cacheKey = getAccountEncryptionModeScopeKey(credentials, target);
    const revision = getAccountEncryptionModeCacheRevision(target.serverId);
    const home = readAccountEncryptionHomeBinding(target.serverId);
    // A shared mode read is readiness, not a finite user operation. Transient
    // outages must recover without another mount/event; retirement stops retry
    // before it can send captured credentials to a successor Home or Account.
    const isCurrent = () => revision === getAccountEncryptionModeCacheRevision(target.serverId)
        && cacheKey === getAccountEncryptionModeScopeKey(credentials);
    const key = `${cacheKey}\u0000${revision}`;
    let failures = accountEncryptionModeReadFailures.get(key);
    if (!failures) {
        failures = { listeners: new Set() };
        accountEncryptionModeReadFailures.set(key, failures);
    }
    const publication = failures;
    if (onUnavailable) {
        publication.listeners.add(onUnavailable);
        if (publication.state) onUnavailable(publication.state);
    }
    try {
        return await accountEncryptionModeReads.run(key,
            () => readAccountEncryptionModeReadiness(run, isCurrent, state => {
                publication.state = state;
                for (const listener of publication.listeners) listener(state);
            }),
            { scope: home?.profileId ?? target.serverId });
    } finally {
        if (onUnavailable) publication.listeners.delete(onUnavailable);
        if (accountEncryptionModeReadFailures.get(key) === publication) accountEncryptionModeReadFailures.delete(key);
    }
}

/**
 * The live admitted Account socket's identity, without issuing a request.
 */
export function getCachedAccountEncryptionMode(credentials: AuthCredentials, serverId?: string): AccountEncryptionMode | null {
    return sync?.getAccountEncryptionObservationBinding(credentials, serverId)?.peek()?.mode ?? null;
}

export async function updateAccountEncryptionMode(
    credentials: AuthCredentials,
    mode: AccountEncryptionMode,
    opts: Readonly<{ retry?: 'default' | 'none' }> = {},
): Promise<AccountEncryptionModeResult> {
    const target = getActiveServerSnapshot();
    const request = createServerFetchForActiveServer();
    const run = async (): Promise<AccountEncryptionModeResponse> => {
        const response = await request(
            '/v1/account/encryption',
            {
                method: 'PATCH',
                headers: {
                    Authorization: `Bearer ${credentials.token}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ mode }),
            },
            { includeAuth: false },
        );

        if (!response.ok) {
            if (response.status === 404) {
                throw new HappyError('Encryption opt-out is not enabled on this server', false, { status: response.status, kind: 'config' });
            }
            if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
                throw new HappyError('Failed to update encryption setting', false, { status: response.status, kind: 'server' });
            }
            throw new Error(`Failed to update account encryption mode: ${response.status}`);
        }

        const data: unknown = await response.json();
        const parsed = AccountEncryptionModeResponseSchema.safeParse(data);
        if (!parsed.success) {
            throw new Error('Failed to parse account encryption mode response');
        }
        return {
            mode: normalizeAccountEncryptionMode(parsed.data.mode),
            updatedAt: normalizeUpdatedAt(parsed.data.updatedAt),
        };
    };

    if (opts.retry === 'none') {
        const result = await run();
        invalidateAccountEncryptionModeCache({ serverId: target.serverId });
        return result;
    }

    const result = await backoff(run);
    invalidateAccountEncryptionModeCache({ serverId: target.serverId });
    return result;
}
