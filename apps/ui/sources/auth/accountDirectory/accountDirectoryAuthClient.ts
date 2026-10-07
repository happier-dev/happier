import {
    normalizeAccountDirectoryEndpoint,
    isTokenOnlyAuthCredentials,
    isLegacyAuthCredentials,
    TokenStorage,
    parseAccountContinuationIntent,
    type TokenOnlyAuthCredentials,
    type PendingAccountDirectoryAuth,
} from '@/auth/storage/tokenStorage';
import { getAuthProvider } from '@/auth/providers/registry';
import { createServerFetchAtEndpoint } from '@/sync/http/client';
import { getRandomBytesAsync } from '@/platform/cryptoRandom';
import { digest } from '@/platform/digest';
import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import { encodeHex } from '@/encryption/hex';
import { authChallenge, deriveAccountSigningPublicKey } from '@/auth/flows/challenge';
import { createAccountServiceReturn } from './accountDirectoryNavigation';
import { normalizeInternalReturnPath } from '@/utils/path/routeUtils';
import { HappyError } from '@/utils/errors/errors';
import { isExplicitlyRetryableError } from '@/sync/runtime/connectivity/transientConnectivityErrors';
import { AccountDirectoryRequestError, isAccountDirectoryRelinkConflict } from '@/sync/api/accountDirectory/accountDirectoryClient';
import { AccountDirectoryRouteErrorResponseV1Schema } from '@happier-dev/protocol';
import { authGetTokenAtEndpoint } from '@/auth/flows/getToken';
import { loginEmailPassword } from '@/auth/password/loginEmailPassword';
import { isServerFeaturesProbeRetryable, probeServerFeaturesAtUrl, type ServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { AccountDirectoryCapabilitiesSchema, type AccountDirectoryCapabilities } from '@happier-dev/protocol';
import {
    type ProjectedAuthenticationAction,
    type ProjectedAuthenticationCatalog,
    type ProjectedAuthenticationMethod,
} from '@happier-dev/cli-common/authentication/authMethodCatalog';
import { fetchHomeAuthEntry } from '@/auth/entry/authEntryClient';
import {
    projectAuthEntryMethodCapabilities,
    projectAuthenticationMethodCapabilities,
    type HomeAuthenticationAction,
} from '@/auth/capabilities/authMethodCapabilities';
import type { HomeCarrier } from '@/sync/runtime/homeCarrier';
import { buildHomeConnectionDescriptorForProfile, resolveServerProfileForPortableIdentity } from '@/sync/domains/server/serverProfiles';
import { resolveHomeEnrollmentTransport } from '@/auth/enrollment/homeEnrollmentTransport';
import {
    selectAccountServiceAuthenticationMethod,
    type AccountServiceRequestedAuthenticationMethod,
    type AccountContinuationIntent,
} from '@happier-dev/cli-common/accountService';

export type AccountDirectoryOAuthStartInput = Readonly<{
    endpointUrl: string;
    endpointServerIdentityId: string;
    canonicalServerUrl: string;
    providerId: string;
    mode: 'keyed' | 'keyless';
    entryIntent: AccountContinuationIntent;
    returnTo: string;
    accountEntryReturnTo?: string;
    /**
     * Optional stable identity of the currently authenticated Home, captured at login action
     * time. Only the identity is persisted on the continuation — never credentials or a
     * descriptor. Absent for fresh-device logins.
     */
    linkHomeServerIdentityId?: string;
    explicitHomeServerIdentityId?: string;
    transport?: AccountDirectoryAuthTransport;
    signal?: AbortSignal;
}>;

export type AccountDirectoryOAuthStartResult = Readonly<{
    url: string;
    /** Exact persisted custody created by this start, used for compare-and-remove cleanup. */
    pending: PendingAccountDirectoryAuth;
}>;

export type AccountDirectoryKeyLoginInput = Readonly<{
    endpointUrl: string;
    endpointServerIdentityId: string;
    canonicalServerUrl: string;
    secret: Uint8Array;
    signal?: AbortSignal;
    verifiedServerFeaturesSnapshot: ServerFeaturesSnapshot & { status: 'ready' };
}> & AccountDirectoryAuthTransport;

export type AccountDirectoryRequestedAuthMethod = AccountServiceRequestedAuthenticationMethod;

export type AccountDirectoryOAuthExchangeInput = Readonly<{
    providerId: string;
    purpose: string | null;
    credentialTarget: string | null;
    endpointUrl: string | null;
    serverIdentityId: string | null;
    canonicalServerUrl: string | null;
    pendingKey: string;
    mode: string | null;
    pending: PendingAccountDirectoryAuth | null;
    /** Non-secret presentation boundary: cancellation is no longer clean once credential persistence starts. */
    onCredentialCommitStarted?: () => void;
    signal?: AbortSignal;
    transport?: AccountDirectoryAuthTransport;
}>;

export type AccountDirectoryOAuthExchangeResult =
    | Readonly<{ kind: 'authenticated'; destination: NonNullable<ReturnType<typeof createAccountServiceReturn>> }>
    | Readonly<{ kind: 'cancelled'; accountCredentialCommitted: boolean }>
    | Readonly<{ kind: 'relink_required'; error: AccountDirectoryRequestError }>
    | Readonly<{
        kind: 'failed';
        code: string;
        retryable: boolean;
        accountCredentialCommitted: boolean;
        error?: unknown;
    }>;

export type AccountDirectoryAuthMethodDiscovery = Readonly<{
    endpointUrl: string;
    serverIdentityId: string;
    canonicalServerUrl: string;
    capability: AccountDirectoryCapabilities;
    keyLoginAvailable: boolean;
    oauthProviderIds: readonly string[];
    preferredProvisionProviderId: string | null;
    authenticationCatalog: ProjectedAuthenticationCatalog;
    authenticationActions: readonly AccountDirectoryAuthenticationAction[];
    accountServiceDisplayName: string | null;
    /** Exact endpoint observation reused by key authentication to avoid a second discovery probe. */
    snapshot: ServerFeaturesSnapshot & { status: 'ready' };
}>;

export type AccountDirectoryAuthenticationAction = Readonly<{
    method: ProjectedAuthenticationMethod;
    action: ProjectedAuthenticationAction;
    execution:
        | Readonly<{ kind: 'generated_key' }>
        | Readonly<{ kind: 'key_entry' }>
        | AccountServiceEmailPasswordExecution
        | Readonly<{ kind: 'oauth'; providerId: string; mode: 'keyed' | 'keyless' }>;
}>;

/**
 * Email and password on an account service. `login` signs an existing Account in (Plain by
 * password, E2EE by unlocking its key from the password envelope); `provision` creates one after
 * the mailbox is proven. `connect` attaches the method to an Account that already exists and
 * lives in Account Security, so the account service never offers it.
 */
export type AccountServiceEmailPasswordExecution = Readonly<{
    kind: 'email_password';
    action: 'login' | 'provision';
    mode: 'keyed' | 'keyless' | 'either';
    recommendedProvisionMode?: 'plain' | 'e2ee';
    /** Present only when the service says it can mail a password-reset link. */
    passwordReset?: 'email';
}>;

/**
 * The account-service subset of a service's advertised Home methods, in the service's order.
 * One rule for both acquisition boundaries (auth entry and the feature catalog).
 */
function selectAccountServiceAuthenticationActions(
    actions: readonly HomeAuthenticationAction[],
    snapshot: ServerFeaturesSnapshot & { status: 'ready' },
): readonly AccountDirectoryAuthenticationAction[] {
    return actions.flatMap(({ method, action, execution }): AccountDirectoryAuthenticationAction[] => {
        if (execution.kind === 'generated_key' || execution.kind === 'key_entry') {
            return snapshot.features.capabilities.auth.keyChallenge.v2 === true
                ? [{ method, action, execution }]
                : [];
        }
        if (execution.kind === 'email_password') {
            if (execution.action === 'connect') return [];
            return [{ method, action, execution: { ...execution, action: execution.action } }];
        }
        if (execution.kind !== 'oauth') return [];
        return [{ method, action, execution }];
    });
}

export type VerifiedAccountServiceAuthority = Pick<
    AccountDirectoryAuthMethodDiscovery,
    'endpointUrl' | 'serverIdentityId' | 'canonicalServerUrl' | 'capability' | 'snapshot'
>;

export type AccountDirectoryAuthTransport = Readonly<{
    runtimeOrigin?: string | null;
    homeCarrier?: HomeCarrier;
}>;

export function createVerifiedAccountServiceAuthority(
    discovery: AccountDirectoryAuthMethodDiscovery,
): VerifiedAccountServiceAuthority {
    return Object.freeze({
        endpointUrl: discovery.endpointUrl,
        serverIdentityId: discovery.serverIdentityId,
        canonicalServerUrl: discovery.canonicalServerUrl,
        capability: discovery.capability,
        snapshot: discovery.snapshot,
    });
}

export type AccountDirectoryAuthMethodDiscoveryResult =
    | Readonly<{
        kind: 'endpoint_unavailable';
        endpointUrl: string;
        reason: 'invalid_endpoint';
        snapshot?: never;
    }>
    | Readonly<{
        kind: 'endpoint_unavailable';
        endpointUrl: string;
        reason: 'probe_failed';
        snapshot: Exclude<ServerFeaturesSnapshot, { status: 'ready' }>;
    }>
    | Readonly<{
        kind: 'not_account_service';
        endpointUrl: string;
        serverIdentityId: string | null;
        snapshot: ServerFeaturesSnapshot & { status: 'ready' };
    }>
    | Readonly<{
        kind: 'identity_mismatch';
        endpointUrl: string;
        expectedServerIdentityId: string;
        observedServerIdentityId: string | null;
        snapshot: ServerFeaturesSnapshot & { status: 'ready' };
    }>
    | Readonly<{
        kind: 'authentication_unavailable';
        endpointUrl: string;
        serverIdentityId: string;
        reason: 'unavailable' | 'incompatible';
        snapshot: ServerFeaturesSnapshot & { status: 'ready' };
    }>
    | (Readonly<{ kind: 'supported_account_service' }> & AccountDirectoryAuthMethodDiscovery)
    | (Readonly<{
        kind: 'requested_method_unavailable';
        requestedMethod: AccountDirectoryRequestedAuthMethod;
    }> & AccountDirectoryAuthMethodDiscovery);

export type AccountDirectoryEndpointVerificationResult =
    | Extract<AccountDirectoryAuthMethodDiscoveryResult, { kind: 'endpoint_unavailable' | 'identity_mismatch' }>
    | Readonly<{
        kind: 'invalid_endpoint_metadata';
        endpointUrl: string;
        serverIdentityId: string | null;
        snapshot: ServerFeaturesSnapshot & { status: 'ready' };
    }>
    | Readonly<{
        kind: 'verified_endpoint';
        endpointUrl: string;
        serverIdentityId: string;
        canonicalServerUrl: string;
        capability: AccountDirectoryCapabilities | null;
        snapshot: ServerFeaturesSnapshot & { status: 'ready' };
    }>;

function parseAccountDirectoryCapability(value: unknown): AccountDirectoryCapabilities | null {
    const parsed = AccountDirectoryCapabilitiesSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
}

function buildSupportedDiscovery(
    endpointUrl: string,
    snapshot: ServerFeaturesSnapshot & { status: 'ready' },
    capability: AccountDirectoryCapabilities,
): AccountDirectoryAuthMethodDiscovery | null {
    const serverIdentityId = String(snapshot.serverIdentityId ?? snapshot.features.capabilities.serverIdentity.serverIdentityId ?? '').trim();
    const canonicalServerUrl = normalizeAccountDirectoryEndpoint(
        snapshot.features.capabilities.server.canonicalServerUrl ?? '',
    );
    if (!serverIdentityId || !canonicalServerUrl) return null;
    const projected = projectAuthenticationMethodCapabilities(snapshot.features);
    const authenticationCatalog = projected.catalog;
    const authenticationActions = selectAccountServiceAuthenticationActions(projected.authenticationActions, snapshot);
    const oauthProviderIds = [...new Set(authenticationActions.flatMap(({ execution }) => (
        execution.kind === 'oauth' ? [execution.providerId] : []
    )))];
    const preferredProvisionProviderId = authenticationActions.find(({ action, execution }) => (
        action.id === 'provision' && execution.kind === 'oauth'
    ))?.execution;
    return {
        endpointUrl,
        serverIdentityId,
        canonicalServerUrl,
        capability,
        keyLoginAvailable: authenticationActions.some(({ execution }) => execution.kind === 'key_entry'),
        oauthProviderIds,
        preferredProvisionProviderId: preferredProvisionProviderId?.kind === 'oauth'
            ? preferredProvisionProviderId.providerId
            : null,
        authenticationCatalog,
        authenticationActions,
        accountServiceDisplayName: snapshot.features.accountServicePresentation?.displayName ?? null,
        snapshot,
    };
}

function buildSupportedDiscoveryFromAuthEntry(
    endpointUrl: string,
    snapshot: ServerFeaturesSnapshot & { status: 'ready' },
    capability: AccountDirectoryCapabilities,
    projection: Parameters<typeof projectAuthEntryMethodCapabilities>[0],
): AccountDirectoryAuthMethodDiscovery | null {
    const serverIdentityId = String(snapshot.serverIdentityId ?? snapshot.features.capabilities.serverIdentity.serverIdentityId ?? '').trim();
    const canonicalServerUrl = normalizeAccountDirectoryEndpoint(
        snapshot.features.capabilities.server.canonicalServerUrl ?? '',
    );
    if (!serverIdentityId || !canonicalServerUrl) return null;
    const projected = projectAuthEntryMethodCapabilities(projection);
    const authenticationActions = selectAccountServiceAuthenticationActions(projected.authenticationActions, snapshot);
    const oauthProviderIds = [...new Set(authenticationActions.flatMap(({ execution }) => (
        execution.kind === 'oauth' ? [execution.providerId] : []
    )))];
    const preferredProvision = authenticationActions.find(({ action, execution }) => (
        action.id === 'provision' && execution.kind === 'oauth'
    ))?.execution;
    return {
        endpointUrl,
        serverIdentityId,
        canonicalServerUrl,
        capability,
        keyLoginAvailable: authenticationActions.some(({ execution }) => execution.kind === 'key_entry'),
        oauthProviderIds,
        preferredProvisionProviderId: preferredProvision?.kind === 'oauth'
            ? preferredProvision.providerId
            : null,
        authenticationCatalog: projected.catalog,
        authenticationActions,
        accountServiceDisplayName: snapshot.features.accountServicePresentation?.displayName ?? null,
        snapshot,
    };
}

async function verifyAccountDirectoryEndpoint(input: Readonly<{
    endpointUrl: string;
    expectedServerIdentityId?: string | null;
    signal?: AbortSignal;
}> & AccountDirectoryAuthTransport): Promise<AccountDirectoryEndpointVerificationResult> {
    const endpointUrl = normalizeAccountDirectoryEndpoint(input.endpointUrl) ?? '';
    if (!endpointUrl) {
        return { kind: 'endpoint_unavailable', endpointUrl, reason: 'invalid_endpoint' };
    }
    const expectedServerIdentityId = String(input.expectedServerIdentityId ?? '').trim();
    const snapshot = await probeServerFeaturesAtUrl({
        endpointUrl,
        ...(expectedServerIdentityId ? { serverId: expectedServerIdentityId } : {}),
        ...(input.runtimeOrigin ? { runtimeOrigin: input.runtimeOrigin } : {}),
        ...(input.homeCarrier ? { homeCarrier: input.homeCarrier } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
        force: true,
    });
    if (snapshot.status !== 'ready') {
        return { kind: 'endpoint_unavailable', endpointUrl, reason: 'probe_failed', snapshot };
    }
    const serverIdentityId = String(
        snapshot.serverIdentityId
        ?? snapshot.features.capabilities.serverIdentity?.serverIdentityId
        ?? '',
    ).trim();
    if (expectedServerIdentityId && serverIdentityId !== expectedServerIdentityId) {
        return {
            kind: 'identity_mismatch',
            endpointUrl,
            expectedServerIdentityId,
            observedServerIdentityId: serverIdentityId || null,
            snapshot,
        };
    }
    const canonicalServerUrl = normalizeAccountDirectoryEndpoint(
        snapshot.features.capabilities.server?.canonicalServerUrl ?? '',
    ) ?? '';
    if (!serverIdentityId || !canonicalServerUrl) {
        return {
            kind: 'invalid_endpoint_metadata',
            endpointUrl,
            serverIdentityId: serverIdentityId || null,
            snapshot,
        };
    }
    return {
        kind: 'verified_endpoint',
        endpointUrl,
        serverIdentityId,
        canonicalServerUrl,
        capability: parseAccountDirectoryCapability(snapshot.features.capabilities.accountDirectory),
        snapshot,
    };
}

/**
 * Account Service authentication is intentionally explicit-targeted. These methods never
 * consult or mutate the focused Home runtime; callers decide when/where a discovered Home is
 * adopted.
 */
export async function acquireAccountServiceAuthTransport(target: Readonly<{ serverIdentityId: string; canonicalServerUrl: string }>, transport?: AccountDirectoryAuthTransport) {
    if (transport?.runtimeOrigin || transport?.homeCarrier) return { transport, close: async () => {} };
    const profile = resolveServerProfileForPortableIdentity(target.serverIdentityId);
    const descriptor = profile.kind === 'resolved' ? buildHomeConnectionDescriptorForProfile(profile.profile) : null;
    if (!descriptor || normalizeAccountDirectoryEndpoint(descriptor.canonicalServerUrl) !== normalizeAccountDirectoryEndpoint(target.canonicalServerUrl)) {
        return { transport: {}, close: async () => {} };
    }
    const resolved = await resolveHomeEnrollmentTransport(descriptor);
    if (!resolved.ok) throw new HappyError('Account Service transport unavailable', resolved.reason === 'iroh_transport_unavailable', {
        kind: resolved.reason === 'iroh_transport_unavailable' ? 'network' : 'config',
        code: resolved.reason,
    });
    return { transport: {
        ...(resolved.transport.runtimeOrigin ? { runtimeOrigin: resolved.transport.runtimeOrigin } : {}),
        ...(resolved.transport.homeCarrier ? { homeCarrier: resolved.transport.homeCarrier } : {}),
    }, close: resolved.transport.close };
}

async function commitAccountDirectoryCredentials(
    target: Readonly<{ endpoint: string; serverIdentityId: string }>,
    credentials: TokenOnlyAuthCredentials,
): Promise<TokenOnlyAuthCredentials> {
    const stored = await TokenStorage.accountDirectoryAuthCredentials.set(target, credentials);
    if (!stored) {
        throw new Error('Failed to persist Account Service credentials');
    }
    return credentials;
}

export const accountDirectoryAuthClient = {
    verifyEndpoint: verifyAccountDirectoryEndpoint,

    async discoverAuthenticationMethods(input: Readonly<{
        endpointUrl: string;
        expectedServerIdentityId?: string | null;
        requestedMethod?: AccountDirectoryRequestedAuthMethod;
        signal?: AbortSignal;
    }> & AccountDirectoryAuthTransport): Promise<AccountDirectoryAuthMethodDiscoveryResult> {
        const verified = await verifyAccountDirectoryEndpoint(input);
        if (verified.kind === 'invalid_endpoint_metadata') {
            return {
                kind: 'not_account_service',
                endpointUrl: verified.endpointUrl,
                serverIdentityId: verified.serverIdentityId,
                snapshot: verified.snapshot,
            };
        }
        if (verified.kind !== 'verified_endpoint') return verified;
        const { endpointUrl, serverIdentityId, snapshot, capability } = verified;
        if (capability?.homeDirectory !== true) {
            return { kind: 'not_account_service', endpointUrl, serverIdentityId, snapshot };
        }
        const authEntry = await fetchHomeAuthEntry({
            purpose: 'account_service',
            endpointUrl,
            serverId: serverIdentityId,
            ...(input.runtimeOrigin ? { runtimeOrigin: input.runtimeOrigin } : {}),
            ...(input.homeCarrier ? { homeCarrier: input.homeCarrier } : {}),
            ...(input.signal ? { signal: input.signal } : {}),
        });
        if (authEntry.kind === 'incompatible' || authEntry.kind === 'unavailable') {
            return {
                kind: 'authentication_unavailable',
                endpointUrl,
                serverIdentityId,
                reason: authEntry.kind === 'incompatible' ? 'incompatible' : 'unavailable',
                snapshot,
            };
        }
        let discovery: AccountDirectoryAuthMethodDiscovery | null;
        if (authEntry.kind === 'ready') {
            if (authEntry.projection.state !== 'ready') {
                return {
                    kind: 'authentication_unavailable',
                    endpointUrl,
                    serverIdentityId,
                    reason: 'unavailable',
                    snapshot,
                };
            }
            discovery = buildSupportedDiscoveryFromAuthEntry(endpointUrl, snapshot, capability, authEntry.projection);
        } else {
            discovery = buildSupportedDiscovery(endpointUrl, snapshot, capability);
        }
        if (!discovery) {
            return { kind: 'not_account_service', endpointUrl, serverIdentityId, snapshot };
        }
        const methodSelection = input.requestedMethod
            ? selectAccountServiceAuthenticationMethod({
                advertised: {
                    keyLoginAvailable: discovery.keyLoginAvailable,
                    oauthProviderIds: discovery.oauthProviderIds,
                },
                requested: input.requestedMethod,
            })
            : null;
        if (methodSelection?.kind === 'requested_method_unavailable') {
            return {
                kind: 'requested_method_unavailable',
                requestedMethod: methodSelection.requestedMethod,
                ...discovery,
            };
        }
        return { kind: 'supported_account_service', ...discovery };
    },

    async loginWithKey(input: AccountDirectoryKeyLoginInput): Promise<TokenOnlyAuthCredentials> {
        input.signal?.throwIfAborted();
        const endpointUrl = normalizeAccountDirectoryEndpoint(input.endpointUrl);
        const endpointServerIdentityId = input.endpointServerIdentityId.trim();
        const canonicalServerUrl = normalizeAccountDirectoryEndpoint(input.canonicalServerUrl);
        if (!endpointUrl || !endpointServerIdentityId || !canonicalServerUrl) {
            throw new Error('Account Service key login requires a known endpoint identity and canonical audience');
        }
        if (!(input.secret instanceof Uint8Array) || input.secret.length !== 32) {
            throw new Error('Account Service key login requires a 32-byte secret');
        }

        const credentials = await authGetTokenAtEndpoint({
            endpointUrl,
            canonicalServerUrl,
            serverId: endpointServerIdentityId,
            serverIdentityId: endpointServerIdentityId,
            secret: input.secret,
            requireKeyChallengeV2: true,
            credentialTarget: 'account_directory',
            verifiedServerFeaturesSnapshot: input.verifiedServerFeaturesSnapshot,
            signal: input.signal,
            ...(input.runtimeOrigin ? { runtimeOrigin: input.runtimeOrigin } : {}),
            ...(input.homeCarrier ? { homeCarrier: input.homeCarrier } : {}),
        }).catch((error: unknown) => {
            if (error instanceof HappyError && error.status !== undefined) {
                const parsed = AccountDirectoryRouteErrorResponseV1Schema.safeParse({ error: error.code });
                if (parsed.success) throw new AccountDirectoryRequestError(error.status, parsed.data.error);
            }
            throw error;
        });
        if (!isTokenOnlyAuthCredentials(credentials)) {
            throw new Error('Account Service returned non-Directory credentials');
        }
        input.signal?.throwIfAborted();
        return await commitAccountDirectoryCredentials({ endpoint: endpointUrl, serverIdentityId: endpointServerIdentityId }, credentials);
    },

    /**
     * Email and password sign-in to an account service, through the one native password login
     * owner. The Account's stored mode decides the branch (the service's prelogin answer): a Plain
     * Account gets its Directory credential from the password route; an E2EE Account unlocks its
     * key from the password envelope and redeems it at the Directory Key Challenge. Only the token
     * enters Directory custody; an E2EE key is handed back for the session to hold, as key sign-in
     * does, and never persisted here.
     */
    async loginWithPassword(input: Readonly<{
        endpointUrl: string;
        endpointServerIdentityId: string;
        canonicalServerUrl: string;
        email: string;
        password: string;
        signal?: AbortSignal;
        verifiedServerFeaturesSnapshot: ServerFeaturesSnapshot & { status: 'ready' };
    }> & AccountDirectoryAuthTransport): Promise<Readonly<{
        credentials: TokenOnlyAuthCredentials;
        keyAuthSecret: Uint8Array | null;
    }>> {
        input.signal?.throwIfAborted();
        const endpointUrl = normalizeAccountDirectoryEndpoint(input.endpointUrl);
        const serverIdentityId = input.endpointServerIdentityId.trim();
        const canonicalServerUrl = normalizeAccountDirectoryEndpoint(input.canonicalServerUrl);
        if (!endpointUrl || !serverIdentityId || !canonicalServerUrl) {
            throw new Error('Account Service password sign-in requires a known endpoint identity and canonical audience');
        }
        const credentials = await loginEmailPassword({
            target: {
                endpointUrl,
                canonicalServerUrl,
                addressAnchorUrl: endpointUrl,
                serverId: serverIdentityId,
                serverIdentityId,
                ...(input.runtimeOrigin ? { runtimeOrigin: input.runtimeOrigin } : {}),
                ...(input.homeCarrier ? { homeCarrier: input.homeCarrier } : {}),
            },
            email: input.email,
            password: input.password,
            credentialTarget: 'account_directory',
            verifiedServerFeaturesSnapshot: input.verifiedServerFeaturesSnapshot,
            ...(input.signal ? { signal: input.signal } : {}),
        }).catch((error: unknown) => {
            if (error instanceof HappyError && error.status !== undefined) {
                const parsed = AccountDirectoryRouteErrorResponseV1Schema.safeParse({ error: error.code });
                if (parsed.success) throw new AccountDirectoryRequestError(error.status, parsed.data.error);
            }
            throw error;
        });
        const keyAuthSecret = isLegacyAuthCredentials(credentials) ? decodeBase64(credentials.secret, 'base64url') : null;
        try {
            // Fail closed on a mode/material mismatch: a key is only ever 32 bytes.
            if (keyAuthSecret && keyAuthSecret.length !== 32) {
                throw new HappyError('Password authentication failed', false, { kind: 'auth', code: 'authentication_failed' });
            }
            input.signal?.throwIfAborted();
            const committed = await commitAccountDirectoryCredentials(
                { endpoint: endpointUrl, serverIdentityId },
                { token: credentials.token },
            );
            return { credentials: committed, keyAuthSecret };
        } catch (error) {
            keyAuthSecret?.fill(0);
            throw error;
        }
    },

    async exchangeOAuth(input: AccountDirectoryOAuthExchangeInput): Promise<AccountDirectoryOAuthExchangeResult> {
        const pending = input.pending;
        const failed = (
            code: string,
            retryable = false,
            error?: unknown,
            accountCredentialCommitted = false,
        ): AccountDirectoryOAuthExchangeResult => ({
            kind: 'failed',
            code,
            retryable,
            accountCredentialCommitted,
            ...(error === undefined ? {} : { error }),
        });
        if (input.signal?.aborted) return { kind: 'cancelled', accountCredentialCommitted: false };
        const endpoint = normalizeAccountDirectoryEndpoint(input.endpointUrl ?? '');
        const canonicalServerUrl = normalizeAccountDirectoryEndpoint(input.canonicalServerUrl ?? '');
        const destination = pending ? createAccountServiceReturn(pending) : null;
        if (!pending || !destination || !endpoint || !canonicalServerUrl
            || endpoint !== normalizeAccountDirectoryEndpoint(pending.endpoint)
            || canonicalServerUrl !== normalizeAccountDirectoryEndpoint(pending.canonicalServerUrl)
            || input.serverIdentityId !== pending.serverIdentityId
            || input.purpose !== 'account_directory' || input.credentialTarget !== 'account_directory'
            || input.providerId !== pending.provider || input.mode !== pending.mode
            || !input.pendingKey.trim() || (pending.pending && pending.pending !== input.pendingKey)) {
            return failed('invalid-pending');
        }
        if (Date.now() >= pending.expiresAt) return failed('request-expired');
        const target = { endpoint, serverIdentityId: pending.serverIdentityId };
        const ownsCustody = async () => {
            const current = await TokenStorage.getPendingAccountDirectoryAuth(target);
            return current !== null && current.provider === pending.provider && current.mode === pending.mode
                && current.createdAt === pending.createdAt && current.expiresAt === pending.expiresAt
                && current.proof === pending.proof && current.secret === pending.secret
                && current.pending === pending.pending && current.returnTo === pending.returnTo
                && current.accountEntryReturnTo === pending.accountEntryReturnTo
                && current.canonicalServerUrl === pending.canonicalServerUrl
                && JSON.stringify(current.entryIntent) === JSON.stringify(pending.entryIntent);
        };
        if (!await ownsCustody()) return failed('invalid-pending');
        let committed = false;
        let closeTransport = async () => {};
        try {
            const acquired = await acquireAccountServiceAuthTransport(pending, input.transport);
            closeTransport = acquired.close;
            const transport = acquired.transport;
            const verified = await accountDirectoryAuthClient.verifyEndpoint({
                endpointUrl: endpoint, expectedServerIdentityId: pending.serverIdentityId, signal: input.signal,
                ...transport,
                runtimeOrigin: transport.runtimeOrigin ?? undefined,
            });
            if (verified.kind !== 'verified_endpoint') return failed(
                verified.kind === 'identity_mismatch' ? 'identity-changed' : 'service-unavailable',
                verified.snapshot !== undefined && isServerFeaturesProbeRetryable(verified.snapshot),
            );
            if (verified.canonicalServerUrl !== canonicalServerUrl) return failed('canonical-url-changed');
            if (verified.capability?.homeDirectory !== true) return failed('service-unavailable');
            input.signal?.throwIfAborted();
            let payload: Record<string, string>;
            if (pending.mode === 'keyless') {
                if (!pending.proof) return failed('invalid-pending');
                payload = { pending: input.pendingKey, proof: pending.proof };
            } else {
                if (!pending.secret) return failed('invalid-pending');
                const secret = decodeBase64(pending.secret, 'base64url');
                try {
                    if (secret.length !== 32) return failed('invalid-pending');
                    const challenge = authChallenge(secret);
                    payload = {
                        pending: input.pendingKey,
                        publicKey: encodeBase64(challenge.publicKey),
                        challenge: encodeBase64(challenge.challenge),
                        signature: encodeBase64(challenge.signature),
                        ...(pending.proof ? { proof: pending.proof } : {}),
                    };
                } finally {
                    secret.fill(0);
                }
            }
            const request = createServerFetchAtEndpoint({
                endpointUrl: endpoint, serverId: pending.serverIdentityId, credentials: null, signal: input.signal,
                ...(transport.runtimeOrigin ? { runtimeOrigin: transport.runtimeOrigin } : {}),
                ...(transport.homeCarrier ? { homeCarrier: transport.homeCarrier } : {}),
            });
            const response = await request(
                `/v1/auth/external/${encodeURIComponent(input.providerId)}/${pending.mode === 'keyless' ? 'finalize-keyless' : 'finalize'}`,
                { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: input.signal },
                { includeAuth: false, retry: 'none' },
            );
            const body: unknown = await response.json();
            input.signal?.throwIfAborted();
            if (!response.ok) {
                const parsed = AccountDirectoryRouteErrorResponseV1Schema.safeParse(body);
                const error = new AccountDirectoryRequestError(response.status, parsed.success ? parsed.data.error : undefined);
                if (isAccountDirectoryRelinkConflict(error)) return { kind: 'relink_required', error };
                const code = body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
                    ? body.error : 'token-exchange-failed';
                return failed(code, error.transient, error);
            }
            if (!body || typeof body !== 'object' || !('token' in body) || typeof body.token !== 'string' || !body.token.trim()) {
                return failed('invalid-response');
            }
            input.signal?.throwIfAborted();
            input.onCredentialCommitStarted?.();
            const credentialCommit = await TokenStorage.commitAccountDirectoryOAuthCredential({
                expectedPending: pending,
                credentials: { token: body.token.trim() },
            });
            if (credentialCommit.kind === 'custody_lost') return failed('invalid-pending');
            if (credentialCommit.kind === 'storage_failed') {
                committed = credentialCommit.accountCredentialCommitted;
                return failed(
                    'credential-storage-failed',
                    false,
                    undefined,
                    credentialCommit.accountCredentialCommitted,
                );
            }
            committed = true;
            const keyAuthSecret = pending.mode === 'keyed' && pending.secret ? decodeBase64(pending.secret, 'base64url') : undefined;
            try {
                const recorded = await TokenStorage.recordAccountDirectoryOAuthReturn({
                endpoint, serverIdentityId: pending.serverIdentityId, canonicalServerUrl,
                entryIntent: pending.entryIntent, returnTo: destination.pathname,
                ...(pending.accountEntryReturnTo ? { accountEntryReturnTo: pending.accountEntryReturnTo } : {}),
                ...(keyAuthSecret ? { keyAuthSecret } : {}),
                }, { expectedCredentialToken: body.token.trim() });
                if (!recorded) return failed('invalid-pending', false, undefined, true);
            } finally {
                keyAuthSecret?.fill(0);
            }
            if (input.signal?.aborted) return { kind: 'cancelled', accountCredentialCommitted: true };
            return { kind: 'authenticated', destination };
        } catch (error) {
            if (input.signal?.aborted) return { kind: 'cancelled', accountCredentialCommitted: committed };
            return failed('token-exchange-failed', isExplicitlyRetryableError(error), error);
        } finally {
            await closeTransport().catch(() => {});
        }
    },

    async startOAuth(input: AccountDirectoryOAuthStartInput): Promise<AccountDirectoryOAuthStartResult> {
        input.signal?.throwIfAborted();
        const intent = parseAccountContinuationIntent(input.entryIntent);
        const returnTo = normalizeInternalReturnPath(input.returnTo);
        const accountEntryReturnTo = normalizeInternalReturnPath(input.accountEntryReturnTo);
        if (input.accountEntryReturnTo !== undefined && !accountEntryReturnTo) throw new Error('Invalid Account entry return destination');
        if (!intent || !returnTo) throw new Error('Account Service OAuth requires a recorded intent and invoking surface');
        const endpointUrl = normalizeAccountDirectoryEndpoint(input.endpointUrl);
        const endpointServerIdentityId = input.endpointServerIdentityId.trim();
        const canonicalServerUrl = normalizeAccountDirectoryEndpoint(input.canonicalServerUrl);
        if (!endpointUrl || !endpointServerIdentityId || !canonicalServerUrl) {
            throw new Error('Account Service OAuth requires a known endpoint identity and canonical audience');
        }
        const providerId = input.providerId.trim().toLowerCase();
        const provider = getAuthProvider(providerId);
        if (!provider) throw new Error('Unsupported Account Service OAuth provider');

        const secretBytes = input.mode === 'keyed'
            ? await getRandomBytesAsync(32)
            : null;
        const secret = secretBytes
            ? encodeBase64(secretBytes, 'base64url')
            : null;
        const proof = input.mode === 'keyless'
            ? encodeBase64(await getRandomBytesAsync(32), 'base64url')
            : null;
        const proofHash = proof
            ? encodeHex(await digest('SHA-256', new TextEncoder().encode(proof))).toLowerCase()
            : null;
        const publicKey = secretBytes
            ? encodeBase64(deriveAccountSigningPublicKey(secretBytes))
            : null;
        let closeTransport = async () => {};
        try {
        const acquired = await acquireAccountServiceAuthTransport({ serverIdentityId: endpointServerIdentityId, canonicalServerUrl }, input.transport);
        closeTransport = acquired.close;
        input.signal?.throwIfAborted();
        const request = createServerFetchAtEndpoint({
            endpointUrl,
            serverId: endpointServerIdentityId,
            credentials: null,
            ...(acquired.transport.runtimeOrigin ? { runtimeOrigin: acquired.transport.runtimeOrigin } : {}),
            ...(acquired.transport.homeCarrier ? { homeCarrier: acquired.transport.homeCarrier } : {}),
            signal: input.signal,
        });
        const start = await provider.getExternalAuthUrl(
            input.mode === 'keyed'
                ? { mode: 'keyed', publicKey: publicKey! }
                : { mode: 'keyless', proofHash: proofHash! },
            {
                request,
                purpose: 'account_directory',
                endpointUrl,
                endpointServerIdentityId,
                canonicalServerUrl,
            },
        );
        input.signal?.throwIfAborted();
        const pending: PendingAccountDirectoryAuth = {
            endpoint: endpointUrl,
            serverIdentityId: endpointServerIdentityId,
            canonicalServerUrl,
            credentialTarget: start.credentialTarget,
            entryIntent: intent,
            provider: providerId,
            purpose: start.purpose,
            createdAt: Date.now(),
            expiresAt: start.expiresAt,
            mode: input.mode,
            ...(proof ? { proof } : {}),
            ...(secret ? { secret } : {}),
            returnTo,
            ...(accountEntryReturnTo ? { accountEntryReturnTo } : {}),
            ...(intent.kind === 'link' ? { linkHomeServerIdentityId: intent.homeServerIdentityId } : {}),
            ...(intent.kind === 'enter' && intent.target.kind === 'explicit' ? { explicitHomeServerIdentityId: intent.target.homeServerIdentityId } : {}),
        };
        const stored = await TokenStorage.setPendingAccountDirectoryAuth(pending);
        if (!stored) {
            throw new Error('Failed to persist Account Service OAuth continuation');
        }
        return { url: start.url, pending };
        } finally {
            secretBytes?.fill(0);
            await closeTransport().catch(() => {});
        }
    },
};
