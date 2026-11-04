import { TokenStorage, type AuthCredentials } from '@/auth/storage/tokenStorage';
import { decodeBase64 } from '@/encryption/base64';
import { parseToken } from '@/utils/auth/parseToken';
import { resolveAuthCredentialsScopeKey } from '@/auth/storage/resolveAuthCredentialsScopeKey';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { resolvePortableServerIdentityForRoutingId } from '@/sync/domains/server/resolvePortableServerIdentityForRoutingId';
import { backoff, backoffForever } from '@/utils/timing/time';
import type { ApiChangeEntry } from '@/sync/api/types/apiTypes';
import { createServerFetchForActiveServer, serverFetch, type ServerFetch, type ServerFetchOptions } from '@/sync/http/client';
import { sync } from '@/sync/sync';
import { readAccountEncryptionObservationBinding, type AccountEncryptionObservationBinding } from '@/sync/http/accountEncryptionObservationBinding';
import { createScopedResolutionSingleFlight } from '@/sync/runtime/orchestration/serverScopedRpc/scopedResolutionSingleFlight';
import { createAccountEncryptionCurrentnessObservation, projectAccountEncryptionIdentity, type AccountEncryptionIdentity } from '@happier-dev/sync-client';
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
type AccountEncryptionInvalidation = Readonly<{ reason?: 'scope-reset' | 'transport-withdrawal'; serverId?: string | null }>;
type AccountEncryptionHomeBinding = Readonly<{ profileId: string; portableIdentity: string | null }>;
type AccountEncryptionInvalidationEvent = AccountEncryptionInvalidation & Readonly<{
    home: AccountEncryptionHomeBinding | null;
    source?: object;
}>;
const accountEncryptionModeCacheInvalidationListeners = new Set<(invalidation: AccountEncryptionInvalidationEvent) => void>();
let accountEncryptionModeCacheRevision = 0;

function readAccountEncryptionHomeBinding(serverId?: string | null): AccountEncryptionHomeBinding | null {
    const profile = getServerProfileById(serverId ?? '');
    if (!profile) return null;
    return { profileId: profile.id, portableIdentity: resolvePortableServerIdentityForRoutingId(serverId) };
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

function publishAccountEncryptionInvalidation(options: AccountEncryptionInvalidation, source?: object): void {
    accountEncryptionModeReads.reset();
    accountEncryptionModeCacheRevision += 1;
    const event: AccountEncryptionInvalidationEvent = { ...options, home: readAccountEncryptionHomeBinding(options.serverId), source };
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
    const unavailable = () => new HappyError('Account encryption observation unavailable', false, {
        kind: 'config', code: 'account-encryption-currentness-unavailable',
    });
    const observation = createAccountEncryptionCurrentnessObservation({
        accountId: parseToken(options.credentials.token),
        readFresh: signal => readAccountEncryptionCurrentness(options.credentials, { request: options.request, signal }),
        unavailable,
    });
    const home = readAccountEncryptionHomeBinding(options.serverId);
    const invalidate = (event: AccountEncryptionInvalidationEvent) => {
        if (event.source === observation || event.reason === 'scope-reset') return;
        if (home && event.home && home.profileId !== event.home.profileId
            && (!home.portableIdentity || !event.home.portableIdentity || home.portableIdentity !== event.home.portableIdentity)) return;
        observation.invalidate();
    };
    accountEncryptionModeCacheInvalidationListeners.add(invalidate);
    const notify = (reason?: AccountEncryptionInvalidation['reason']) =>
        publishAccountEncryptionInvalidation({ serverId: options.serverId, reason }, observation);
    const binding: AccountEncryptionObservationBinding = {
        credentials: options.credentials,
        credentialScopeKey: resolveAuthCredentialsScopeKey(options.credentials),
        serverId: options.serverId ?? '',
        endpointUrl: options.endpointUrl,
        runtimeOrigin: options.runtimeOrigin,
        homeCarrierEndpointId: options.homeCarrierEndpointId,
        isCurrent: options.isCurrent,
        read: async signal => {
            if (!options.isCurrent()) throw unavailable();
            const identity = await observation.read(signal);
            if (!options.isCurrent()) throw unavailable();
            return identity;
        },
        peek: () => options.isCurrent() ? observation.peek() : null,
    };
    return {
        binding,
        connected: () => { if (options.isCurrent()) { observation.connected(); notify('transport-withdrawal'); } },
        disconnected: () => { observation.disconnected(); notify('transport-withdrawal'); },
        update: (raw: unknown) => {
            if (options.isCurrent() && observation.update(raw)) notify();
        },
        dispose: (reason?: AccountEncryptionInvalidation['reason']) => {
            accountEncryptionModeCacheInvalidationListeners.delete(invalidate);
            observation.dispose();
            notify(reason);
        },
    };
}

/** Account settings and Connected Service notifications do not change persisted Account mode. */
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
            || key === 'settingsVersion' && typeof value === 'number'
                && Number.isSafeInteger(value) && value >= 0
        ));
    });
    if (requiresModeRead) invalidateAccountEncryptionModeCache(target);
}

/** Owner-local revision for consumers that must withdraw stale disclosures. */
export function getAccountEncryptionModeCacheRevision(): number {
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
        if (home && event.home && home.profileId !== event.home.profileId) {
            if (home.portableIdentity && event.home.portableIdentity) {
                if (home.portableIdentity !== event.home.portableIdentity) return;
            } else if (!home.portableIdentity && !event.home.portableIdentity) {
                // The canonical routing scope owner uses established profile
                // ids for legacy Homes without a portable identity.
                return;
            }
        }
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
    listener: () => void,
): () => void {
    accountEncryptionModeCacheInvalidationListeners.add(listener);
    return () => {
        accountEncryptionModeCacheInvalidationListeners.delete(listener);
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
    options: AccountEncryptionCurrentnessReadOptions & Readonly<{ usage: AccountEncryptionReadUsage }>,
): Promise<AccountEncryptionIdentity> {
    throwIfAborted(options.signal);
    const binding = options.usage === 'identity' ? options.request
        ? readAccountEncryptionObservationBinding(options.request, credentials)
        : sync?.getAccountEncryptionObservationBinding(credentials) ?? null : null;
    if (binding) return await binding.read(options.signal);
    return projectAccountEncryptionIdentity(await fetchAccountEncryptionCurrentness(credentials, options));
}

async function readAccountEncryptionCurrentness(
    credentials: AuthCredentials,
    options: AccountEncryptionCurrentnessReadOptions,
): Promise<AccountEncryptionCurrentnessResponse> {
    const request: NonNullable<AccountEncryptionCurrentnessReadOptions['request']> = options.request ?? ((path: string, init?: RequestInit) =>
        serverFetch(path, init, { includeAuth: false }));
    const readCurrentness = async () => await request('/v1/account/encryption/currentness', {
        method: 'GET',
        headers: {
            Authorization: `Bearer ${credentials.token}`,
            'Content-Type': 'application/json',
        },
        signal: options.signal,
    }, { includeAuth: false, retry: 'none' });
    let response = await readCurrentness();
    if (!response.ok) {
        if (response.status === 408 || response.status === 429 || response.status >= 500) {
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
                    if (repaired.success) return repaired.data;
                }
                throw new AccountEncryptionCurrentnessReadinessError(recovery.data.recipientEnvelopeReadiness);
            }
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
        return !opts.request && !opts.signal && opts.retry !== 'none'
            ? await readSharedAccountEncryptionMode(credentials, read)
            : await read();
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
            throw new Error(`Failed to load account encryption mode: ${response.status}`);
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

    if (opts.request && opts.usage === 'identity') {
        const scopeKey = `${resolveAuthCredentialsScopeKey(credentials)}\u0000${accountEncryptionModeCacheRevision}`;
        // Unbranded ordinary reads retain their exact callable lifetime at S2's
        // pending owner. Final authority and cursor witnesses never join them.
        return await accountEncryptionModeReads.run(scopeKey, run, { scope: opts.request });
    }
    if (opts.retry === 'none' || opts.request || opts.signal || opts.usage === 'fresh-authority') {
        return await run();
    }

    return await readSharedAccountEncryptionMode(credentials, run);
}

/** Preserve the incumbent mounted-readiness retry owner for fresh and observed reads alike. */
async function readSharedAccountEncryptionMode(
    credentials: AuthCredentials,
    run: () => Promise<AccountEncryptionModeResult>,
): Promise<AccountEncryptionModeResult> {
    const cacheKey = getAccountEncryptionModeScopeKey(credentials);
    const revision = accountEncryptionModeCacheRevision;
    // A shared mode read is readiness, not a finite user operation. Transient
    // outages must recover without another mount/event; retirement stops retry
    // before it can send captured credentials to a successor Home or Account.
    const assertCurrent = (): void => {
        if (revision !== accountEncryptionModeCacheRevision
            || cacheKey !== getAccountEncryptionModeScopeKey(credentials)) {
            throw new HappyError('Account encryption mode read retired', false, {
                kind: 'config', code: 'account-encryption-mode-read-retired',
            });
        }
    };

    return await accountEncryptionModeReads.run(cacheKey, async () => {
        const value = await backoffForever(async () => {
            assertCurrent();
            try {
                return await run();
            } catch (error) {
                // HTTP may settle retirement before another retry enters this
                // owner. Keep the Account-mode retirement contract in either case.
                assertCurrent();
                throw error;
            }
        });
        assertCurrent();
        return value;
    });
}

/**
 * The live admitted Account socket's identity, without issuing a request.
 */
export function getCachedAccountEncryptionMode(credentials: AuthCredentials): AccountEncryptionMode | null {
    return sync?.getAccountEncryptionObservationBinding(credentials)?.peek()?.mode ?? null;
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
