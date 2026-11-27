import type { HomeConnectionDescriptorV1, SystemTaskResult } from '@happier-dev/protocol';
import {
    PersonalHomeCredentialsUnverifiedError,
    runPersonalHomeBootstrap,
    type PersonalHomeBootstrapDeps,
    type PersonalHomeBootstrapResult,
} from './bootstrap.js';
import {
    PersonalHomeSignupClosureError,
    type PersonalHomeSignupPolicyState,
} from '../personalHomeSignupPolicy.js';
import { readRelayRuntimeStatusData } from '../../relayHost/relayRuntimeStatus.js';

export type PersonalHomeBootstrapTaskKind =
    | 'relay.runtime.status.v1'
    | 'relay.runtime.installOrUpdate.v1'
    | 'relay.runtime.start.v1'
    | 'relay.runtime.restart.v1';

export type PersonalHomeBootstrapTaskOptions = Readonly<{
    purpose?: Readonly<{
        kind: 'personal-home';
        canonicalServerUrl: string;
    }>;
    anonymousSignupEnabled?: boolean;
    expectedPersonalHomeState?: Readonly<{
        installed: boolean;
        canonicalServerUrl: string | null;
        dataPresent: boolean;
    }>;
}>;

export type PersonalHomeEndpointSnapshot =
    | Readonly<{
        status: 'ready';
        serverIdentityId: string;
        storagePolicy: 'required_e2ee' | 'optional' | 'plaintext_only';
        anonymousSignup: 'enabled' | 'disabled' | 'unknown';
        /**
         * Canonical Home descriptor observed at /v1/features. The probe owner
         * already fail-closes on a descriptor whose homeServerIdentityId
         * disagrees with the independently observed server identity.
         */
        homeConnectionDescriptor?: HomeConnectionDescriptorV1;
    }>
    | Readonly<{ status: 'unreachable' | 'unsupported' }>;

type TokenOnlyCredentials = Readonly<{ token: string }>;

/**
 * Explicit "Use this local Home" disposition for the existing-runtime decision. Recovery keeps
 * the runtime's current storage policy and existing credentials; it never creates an account,
 * fabricates secret material, or changes the focused Home.
 */
export type PersonalHomeExistingRuntimeDisposition = 'use-this-local-home' | 'update-this-local-home';

export type PersonalHomeBootstrapSystemTaskDeps = Readonly<{
    runRelayTask: (
        kind: PersonalHomeBootstrapTaskKind,
        options: PersonalHomeBootstrapTaskOptions,
    ) => Promise<SystemTaskResult | null>;
    probeEndpoint: (endpoint: string) => Promise<PersonalHomeEndpointSnapshot>;
    readCredentials: (input: Readonly<{
        serverUrl: string;
        serverIdentityId: string;
    }>) => Promise<Readonly<{ token: string; secret?: string }> | null>;
    createLocalAccount: (input: Readonly<{
        endpoint: string;
        canonicalServerUrl: string;
        serverIdentityId: string;
        /** Retained Home data permits only idempotent reuse of existing pending custody. */
        resumePendingSeedOnly: boolean;
    }>) => Promise<Readonly<{ token: string; secret?: string }>>;
    preparePendingBootstrapSeed: (input: Readonly<{
        serverUrl: string;
        serverIdentityId?: string;
        /** Only a fresh status may create custody; retained data can reuse exact custody only. */
        allowCreate: boolean;
    }>) => Promise<boolean>;
    persistCredentials: (input: Readonly<{
        serverUrl: string;
        serverIdentityId: string;
        credentials: TokenOnlyCredentials;
    }>) => Promise<boolean>;
    verifyAuthenticatedAccess: (input: Readonly<{
        endpoint: string;
        token: string;
    }>) => Promise<boolean>;
    clearPendingBootstrapSeed: (input: Readonly<{
        serverUrl: string;
        serverIdentityId: string;
    }>) => Promise<boolean>;
    preflightCompletedProfile: (input: Readonly<{
        canonicalServerUrl: string;
        localServerUrl: string;
        serverIdentityId: string;
    }>) => void;
    probeAnonymousSignupRefused: (input: Readonly<{
        endpoint: string;
    }>) => Promise<boolean>;
    adoptCompletedProfile: (input: Readonly<{
        canonicalServerUrl: string;
        localServerUrl: string;
        serverIdentityId: string;
        /** Canonical descriptor from /v1/features; present only when identity-verified at completion. */
        connectionDescriptor?: HomeConnectionDescriptorV1;
    }>) => Promise<Readonly<{ id: string }>>;
}>;

export class PersonalHomeExistingRuntimeConflictError extends Error {
    readonly code = 'personal_home_existing_runtime_conflict';

    constructor() {
        super('An existing local Home must be handled explicitly before Personal Home setup can continue.');
        this.name = 'PersonalHomeExistingRuntimeConflictError';
    }
}

export class PersonalHomeDescriptorUnverifiedError extends Error {
    readonly code = 'personal_home_descriptor_unverified';

    constructor() {
        super('Personal Home did not publish a matching connection descriptor.');
        this.name = 'PersonalHomeDescriptorUnverifiedError';
    }
}

class PersonalHomeSystemTaskError extends Error {
    readonly code: string;

    constructor(code: string, message: string) {
        super(message);
        this.name = 'PersonalHomeSystemTaskError';
        this.code = code;
    }
}

function normalizeUrl(value: unknown): string {
    return String(value ?? '').trim().replace(/\/+$/u, '');
}

function readRelayStatusData(result: SystemTaskResult) {
    if (!result.ok) {
        throw new PersonalHomeSystemTaskError(result.error.code, result.error.message);
    }
    const decoded = readRelayRuntimeStatusData(result);
    if (!decoded) {
        throw new PersonalHomeSystemTaskError(
            'invalid_relay_runtime_status',
            'Personal Home runtime status returned an invalid result.',
        );
    }
    return decoded;
}

function requireSuccessfulTask(result: SystemTaskResult | null, operation: string): SystemTaskResult {
    if (!result) {
        throw new PersonalHomeSystemTaskError(
            'system_task_unavailable',
            `${operation} is unavailable.`,
        );
    }
    if (!result.ok) {
        throw new PersonalHomeSystemTaskError(result.error.code, result.error.message);
    }
    return result;
}

function requireLoopbackPort(value: string): number {
    let parsed: URL;
    try {
        parsed = new URL(value);
    } catch {
        throw new Error('Personal Home runtime did not provide a valid local origin.');
    }
    const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/gu, '');
    const port = Number(parsed.port);
    if (
        parsed.protocol !== 'http:'
        || (hostname !== '127.0.0.1' && hostname !== 'localhost' && hostname !== '::1')
        || !Number.isInteger(port)
        || port < 1
        || port > 65_535
        || parsed.username
        || parsed.password
        || parsed.pathname !== '/'
        || parsed.search
        || parsed.hash
    ) {
        throw new Error('Personal Home runtime must use a loopback HTTP origin with an explicit port.');
    }
    return port;
}

function observedPolicy(enabled: boolean | null): PersonalHomeSignupPolicyState {
    return enabled === true ? 'enabled' : enabled === false ? 'disabled' : 'unknown';
}

function normalizeTokenOnlyCredentials(value: Readonly<{ token: string; secret?: string }> | null): TokenOnlyCredentials | null {
    const token = String(value?.token ?? '').trim();
    return token ? { token } : null;
}

async function requirePlainEndpoint(
    deps: PersonalHomeBootstrapSystemTaskDeps,
    endpoint: string,
): Promise<Extract<PersonalHomeEndpointSnapshot, { status: 'ready' }>> {
    const snapshot = await deps.probeEndpoint(endpoint);
    if (snapshot.status !== 'ready') {
        if (snapshot.status === 'unsupported') {
            throw new PersonalHomeSystemTaskError(
                'personal_home_endpoint_update_required',
                'This local Home does not provide the features or identity required for setup. Update it or use another Home.',
            );
        }
        throw new PersonalHomeSystemTaskError(
            'personal_home_endpoint_unreachable',
            'Could not reach the local Home. Check that its background service is running, then try again.',
        );
    }
    if (snapshot.storagePolicy !== 'plaintext_only') {
        throw new PersonalHomeExistingRuntimeConflictError();
    }
    return snapshot;
}

/**
 * The production composition caller. UI state invokes this one owner; every runtime mutation
 * crosses the existing system-task boundary, while auth/storage/profile work is explicitly
 * endpoint-scoped and never changes the focused Home.
 */
export async function runPersonalHomeBootstrapFromSystemTasks(input: Readonly<{
    deps: PersonalHomeBootstrapSystemTaskDeps;
    /** Set only from an explicit existing-runtime decision action. */
    existingRuntimeDisposition?: PersonalHomeExistingRuntimeDisposition;
    /** Only a deliberate retry may recreate the explicitly erased Personal Home runtime. */
    allowErasedRuntimeRecreate?: boolean;
}>): Promise<PersonalHomeBootstrapResult & Readonly<{ profileId: string }>> {
    const readStatus = async () => readRelayStatusData(requireSuccessfulTask(
        await input.deps.runRelayTask('relay.runtime.status.v1', {}),
        'Personal Home runtime status',
    ));
    let initialStatus = await readStatus();
    if (input.existingRuntimeDisposition === 'update-this-local-home') {
        if (!initialStatus.installed) throw new PersonalHomeExistingRuntimeConflictError();
        // Keep the selected runtime's configuration and purpose during the in-place update.
        requireSuccessfulTask(
            await input.deps.runRelayTask('relay.runtime.installOrUpdate.v1', {}),
            'Personal Home runtime update',
        );
        initialStatus = await readStatus();
    }
    const persistedPersonalHomeOrigin = initialStatus.purpose?.kind === 'personal-home'
        ? normalizeUrl(initialStatus.purpose.canonicalServerUrl)
        : null;
    const retainedClassifiedPersonalHome = initialStatus.dataPresent
        && !initialStatus.installed
        && persistedPersonalHomeOrigin != null;
    const selectedCanonicalServerUrl = retainedClassifiedPersonalHome && persistedPersonalHomeOrigin
        ? persistedPersonalHomeOrigin
        : initialStatus.relayUrl;
    const selectedPort = requireLoopbackPort(selectedCanonicalServerUrl);

    const existingRuntimeRecovery = input.existingRuntimeDisposition !== undefined;
    const admissibleGenericNoData = initialStatus.installed
        && initialStatus.dataPresent === false
        && initialStatus.purpose?.kind === 'generic';
    // The explicit recovery action has already selected this runtime and must be allowed to
    // prove its endpoint-bound stored credential before any status ambiguity is interpreted as
    // an erased fresh Home. It never creates an account, so this cannot reopen signup over
    // retained data.
    const erasedPersonalHomeAwaitingRetry = !existingRuntimeRecovery
        && initialStatus.installed
        && initialStatus.dataPresent === false
        && initialStatus.purpose?.kind === 'personal-home'
        && initialStatus.anonymousSignupEnabled === null;

    if (erasedPersonalHomeAwaitingRetry && input.allowErasedRuntimeRecreate !== true) {
        throw new PersonalHomeSystemTaskError(
            'personal_home_erased_retry_required',
            'Your Personal Home was erased. Try again to create a new one.',
        );
    }

    // An uninstalled runtime can still have a retained Personal Home database, files, or master
    // secret. Never run the fresh install/account path over that data. Reuse the existing-runtime
    // decision and generic Home recovery route instead of introducing another recovery state.
    if (initialStatus.dataPresent && !initialStatus.installed && !retainedClassifiedPersonalHome) {
        throw new PersonalHomeExistingRuntimeConflictError();
    }
    if (existingRuntimeRecovery && !initialStatus.installed && !retainedClassifiedPersonalHome) {
        throw new PersonalHomeExistingRuntimeConflictError();
    }

    // Existing-runtime recovery validates the live runtime through read-only and lifecycle-only
    // steps before any reclassification. No account/profile work starts until preflight passes.
    let recoveryCredentials: TokenOnlyCredentials | null = null;
    let existingRuntimePreflightStarted = false;
    if (existingRuntimeRecovery && initialStatus.installed) {
        const classifiedOrigin = initialStatus.purpose?.kind === 'personal-home'
            ? normalizeUrl(initialStatus.purpose.canonicalServerUrl)
            : null;
        if (classifiedOrigin != null && classifiedOrigin !== selectedCanonicalServerUrl) {
            // A classified Personal Home pointing at a different canonical origin is a different
            // Home; adopting it here would move its authentication audience.
            throw new PersonalHomeExistingRuntimeConflictError();
        }
        if (!initialStatus.healthy) {
            // Lifecycle-only start for preflight. No purpose/signup options are sent, so an
            // unclassified runtime stays unclassified even when the later preflight fails.
            requireSuccessfulTask(
                await input.deps.runRelayTask('relay.runtime.start.v1', {}),
                'Personal Home runtime start',
            );
            const startedStatus = readRelayStatusData(requireSuccessfulTask(
                await input.deps.runRelayTask('relay.runtime.status.v1', {}),
                'Personal Home runtime status readback',
            ));
            if (!startedStatus.installed || !startedStatus.healthy) {
                throw new PersonalHomeSystemTaskError(
                    'personal_home_endpoint_unreachable',
                    'The local Home did not become healthy after starting. Check its background service, then try again.',
                );
            }
            existingRuntimePreflightStarted = true;
        }
        const preflightEndpoint = await requirePlainEndpoint(input.deps, selectedCanonicalServerUrl);
        recoveryCredentials = normalizeTokenOnlyCredentials(await input.deps.readCredentials({
            serverUrl: selectedCanonicalServerUrl,
            serverIdentityId: preflightEndpoint.serverIdentityId,
        }));
        if (!recoveryCredentials) throw new PersonalHomeCredentialsUnverifiedError();
        if (!(await input.deps.verifyAuthenticatedAccess({
            endpoint: selectedCanonicalServerUrl,
            token: recoveryCredentials.token,
        }))) {
            throw new PersonalHomeCredentialsUnverifiedError();
        }
        try {
            input.deps.preflightCompletedProfile({
                canonicalServerUrl: selectedCanonicalServerUrl,
                localServerUrl: selectedCanonicalServerUrl,
                serverIdentityId: preflightEndpoint.serverIdentityId,
            });
        } catch {
            // Profile identity/origin conflicts must be decided by the generic Home flow before
            // the runtime purpose or signup policy is mutated.
            throw new PersonalHomeExistingRuntimeConflictError();
        }
    } else {
        if (
            initialStatus.installed
            && !admissibleGenericNoData
            && (
                initialStatus.purpose?.kind !== 'personal-home'
                || normalizeUrl(initialStatus.purpose.canonicalServerUrl) !== selectedCanonicalServerUrl
            )
        ) {
            throw new PersonalHomeExistingRuntimeConflictError();
        }
        if (
            initialStatus.installed
            && !admissibleGenericNoData
            && initialStatus.anonymousSignupEnabled === null
            && !erasedPersonalHomeAwaitingRetry
        ) {
            throw new PersonalHomeExistingRuntimeConflictError();
        }
    }

    let observedIdentityId: string | null = null;
    // Authoritative initial-status facts that make the adapter callbacks below idempotent: an
    // already-classified healthy Personal Home at the exact canonical origin must not be
    // reinstalled or restarted; every read-only verification still runs through the canonical
    // helper and fails closed.
    const classifiedPersonalHomeAtCanonicalOrigin = initialStatus.installed
        && initialStatus.purpose?.kind === 'personal-home'
        && normalizeUrl(initialStatus.purpose.canonicalServerUrl) === selectedCanonicalServerUrl;
    const managedSignupClosureAlreadyLive = classifiedPersonalHomeAtCanonicalOrigin
        && initialStatus.anonymousSignupEnabled === false
        && !erasedPersonalHomeAwaitingRetry;

    // A fresh bootstrap must publish account-key custody before install/start can create a
    // master secret, database, or other meaningful Home data. Retained data never authorizes a
    // new seed; its exact prior URL/identity-scoped custody is checked only if account creation is
    // still required after the runtime and identity are readable.
    if (
        !existingRuntimeRecovery
        && initialStatus.dataPresent !== true
        && !(await input.deps.preparePendingBootstrapSeed({
            serverUrl: selectedCanonicalServerUrl,
            allowCreate: true,
        }))
    ) {
        throw new Error('Personal Home seed custody is unavailable.');
    }

    const runConfiguredTask = async (
        kind: Exclude<PersonalHomeBootstrapTaskKind, 'relay.runtime.status.v1'>,
        anonymousSignupEnabled: boolean,
        purpose: NonNullable<PersonalHomeBootstrapTaskOptions['purpose']>,
        expectedPersonalHomeState?: PersonalHomeBootstrapTaskOptions['expectedPersonalHomeState'],
    ): Promise<SystemTaskResult> => requireSuccessfulTask(
        await input.deps.runRelayTask(kind, {
            purpose,
            anonymousSignupEnabled,
            ...(expectedPersonalHomeState ? { expectedPersonalHomeState } : {}),
        }),
        kind,
    );

    const purposeForDesiredState = (desired: Readonly<{ spec: { canonicalServerUrl: string }; port: number }>) => {
        const canonicalServerUrl = normalizeUrl(desired.spec.canonicalServerUrl);
        if (requireLoopbackPort(canonicalServerUrl) !== desired.port || canonicalServerUrl !== selectedCanonicalServerUrl) {
            throw new Error('Personal Home desired runtime state drifted from the selected canonical origin.');
        }
        return { kind: 'personal-home' as const, canonicalServerUrl };
    };

    const readMutationStatus = async (expectedAnonymousSignupEnabled: boolean | null) => {
        const task = requireSuccessfulTask(
            await input.deps.runRelayTask('relay.runtime.status.v1', {}),
            'Personal Home runtime status readback',
        );
        const status = readRelayStatusData(task);
        if (!status.installed || !status.healthy) {
            throw new Error('Personal Home runtime is not healthy after install/update.');
        }
        if (
            status.purpose?.kind !== 'personal-home'
            || normalizeUrl(status.purpose.canonicalServerUrl) !== selectedCanonicalServerUrl
        ) {
            throw new Error('Personal Home runtime changed during install/update.');
        }
        if (expectedAnonymousSignupEnabled != null) {
            if (expectedAnonymousSignupEnabled === false && status.anonymousSignupEnabled !== false) {
                throw new PersonalHomeSignupClosureError();
            }
            if (status.anonymousSignupEnabled !== expectedAnonymousSignupEnabled) {
                throw new Error('Personal Home runtime changed during install/update.');
            }
        }
        return status;
    };

    const bootstrapDeps: PersonalHomeBootstrapDeps = {
        bindLoopback: async () => {
            requireLoopbackPort(selectedCanonicalServerUrl);
        },
        readPersistedPort: async () => initialStatus.installed ? selectedPort : null,
        resolveNonCollidingPort: async () => selectedPort,
        readPersistedPolicy: async () => observedPolicy(
            existingRuntimeRecovery || retainedClassifiedPersonalHome
                ? false
                : initialStatus.anonymousSignupEnabled,
        ),
        ensureRuntimeStarted: async (desired) => {
            const purpose = purposeForDesiredState(desired);
            let mutated = false;
            if (classifiedPersonalHomeAtCanonicalOrigin && !erasedPersonalHomeAwaitingRetry) {
                if (!initialStatus.healthy && !existingRuntimePreflightStarted) {
                    // Installed but stopped/unhealthy: the smallest lifecycle action only. A
                    // stopped runtime is never a reason to reinstall or rewrite the managed env.
                    requireSuccessfulTask(
                        await input.deps.runRelayTask('relay.runtime.start.v1', {}),
                        'Personal Home runtime start',
                    );
                    mutated = true;
                }
            } else {
                await runConfiguredTask(
                    'relay.runtime.installOrUpdate.v1',
                    desired.anonymousSignupEnabled,
                    purpose,
                    {
                        installed: initialStatus.installed,
                        canonicalServerUrl: initialStatus.purpose?.kind === 'personal-home'
                            ? normalizeUrl(initialStatus.purpose.canonicalServerUrl)
                            : null,
                        dataPresent: initialStatus.dataPresent,
                    },
                );
                mutated = true;
            }
            if (mutated) await readMutationStatus(desired.anonymousSignupEnabled);
            const endpoint = await requirePlainEndpoint(input.deps, selectedCanonicalServerUrl);
            observedIdentityId = endpoint.serverIdentityId;
        },
        readPersistedCredentials: async () => {
            const endpoint = await requirePlainEndpoint(input.deps, selectedCanonicalServerUrl);
            observedIdentityId = endpoint.serverIdentityId;
            if (recoveryCredentials) return recoveryCredentials;
            return normalizeTokenOnlyCredentials(await input.deps.readCredentials({
                serverUrl: selectedCanonicalServerUrl,
                serverIdentityId: endpoint.serverIdentityId,
            }));
        },
        createLocalAccount: async ({ endpoint }) => {
            if (existingRuntimeRecovery) {
                throw new Error('Personal Home existing-runtime recovery must not create a new local account.');
            }
            const snapshot = await requirePlainEndpoint(input.deps, endpoint);
            observedIdentityId = snapshot.serverIdentityId;
            const resumePendingSeedOnly = initialStatus.dataPresent === true;
            if (!(await input.deps.preparePendingBootstrapSeed({
                serverUrl: selectedCanonicalServerUrl,
                serverIdentityId: snapshot.serverIdentityId,
                allowCreate: false,
            }))) {
                // Retained Home data may resume only the exact endpoint-and-identity-scoped seed
                // whose public key can already name a server-committed Account.
                throw new PersonalHomeCredentialsUnverifiedError();
            }
            const credentials = normalizeTokenOnlyCredentials(await input.deps.createLocalAccount({
                endpoint,
                canonicalServerUrl: selectedCanonicalServerUrl,
                serverIdentityId: snapshot.serverIdentityId,
                resumePendingSeedOnly,
            }));
            if (!credentials) throw new Error('Personal Home account creation returned no token.');
            return credentials;
        },
        persistCredentials: async (credentials) => {
            const serverIdentityId = observedIdentityId;
            if (!serverIdentityId) throw new Error('Personal Home identity is unavailable for credential persistence.');
            const tokenOnly = normalizeTokenOnlyCredentials(credentials);
            if (!tokenOnly) throw new Error('Personal Home credentials are unavailable.');
            const persisted = await input.deps.persistCredentials({
                serverUrl: selectedCanonicalServerUrl,
                serverIdentityId,
                credentials: tokenOnly,
            });
            if (!persisted) throw new Error('Failed to save Personal Home credentials.');
        },
        verifyAuthenticatedAccess: async (credentials) => {
            const tokenOnly = normalizeTokenOnlyCredentials(credentials);
            return tokenOnly != null && await input.deps.verifyAuthenticatedAccess({
                endpoint: selectedCanonicalServerUrl,
                token: tokenOnly.token,
            });
        },
        restartHome: async (desired) => {
            if (managedSignupClosureAlreadyLive) {
                // The authoritative initial status proved the managed policy already closed at
                // this exact origin; a restart would only re-apply an unchanged environment. The
                // live refusal/policy/listener-origin readbacks below still fail closed.
                return;
            }
            // An explicit erase or uninstall may win the incumbent mutation lock after account
            // work. Re-admit from authoritative status immediately before the next mutation so
            // that operation wins and bootstrap waits for a deliberate Retry.
            const expectedStatus = await readMutationStatus(null);
            const purpose = purposeForDesiredState(desired);
            await runConfiguredTask(
                'relay.runtime.installOrUpdate.v1',
                desired.anonymousSignupEnabled,
                purpose,
                {
                    installed: true,
                    canonicalServerUrl: selectedCanonicalServerUrl,
                    dataPresent: expectedStatus.dataPresent,
                },
            );
            await readMutationStatus(desired.anonymousSignupEnabled);
        },
        readEffectivePolicy: async () => {
            const endpoint = await requirePlainEndpoint(input.deps, selectedCanonicalServerUrl);
            observedIdentityId = endpoint.serverIdentityId;
            return endpoint.anonymousSignup;
        },
        probeAnonymousSignupRefused: async () => await input.deps.probeAnonymousSignupRefused({
            endpoint: selectedCanonicalServerUrl,
        }),
        readListenerOrigin: async () => {
            const statusTask = requireSuccessfulTask(
                await input.deps.runRelayTask('relay.runtime.status.v1', {}),
                'Personal Home runtime status readback',
            );
            const status = readRelayStatusData(statusTask);
            if (!status.installed || !status.healthy) {
                throw new Error('Personal Home runtime is not healthy after restart.');
            }
            if (status.anonymousSignupEnabled !== false) {
                throw new PersonalHomeSignupClosureError();
            }
            if (
                status.purpose?.kind !== 'personal-home'
                || normalizeUrl(status.purpose.canonicalServerUrl) !== selectedCanonicalServerUrl
            ) {
                throw new PersonalHomeExistingRuntimeConflictError();
            }
            return status.relayUrl;
        },
        persistCompletionReceipt: async (receipt) => {
            const endpoint = await requirePlainEndpoint(input.deps, receipt.localServerUrl);
            const serverIdentityId = observedIdentityId ?? endpoint.serverIdentityId;
            if (serverIdentityId !== endpoint.serverIdentityId) {
                throw new Error('Personal Home identity changed during bootstrap.');
            }
            // Completion requires a server-owned descriptor for the authenticated identity.
            // Remote-carrier publication is independent of local bootstrap readiness.
            const connectionDescriptor = endpoint.homeConnectionDescriptor?.homeServerIdentityId === serverIdentityId
                ? endpoint.homeConnectionDescriptor
                : undefined;
            if (!connectionDescriptor) {
                throw new PersonalHomeDescriptorUnverifiedError();
            }
            // The canonical runner reaches completion persistence only after the token-only
            // credential has survived restart and passed an authenticated endpoint readback.
            // Release account-creation custody before adoption so a clear failure remains
            // retryable and cannot leave an unreachable completed-profile receipt.
            if (!(await input.deps.clearPendingBootstrapSeed({
                serverUrl: receipt.canonicalServerUrl,
                serverIdentityId,
            }))) {
                throw new Error('Failed to release Personal Home account-creation custody.');
            }
            const profile = await input.deps.adoptCompletedProfile({
                canonicalServerUrl: receipt.canonicalServerUrl,
                localServerUrl: receipt.localServerUrl,
                serverIdentityId,
                connectionDescriptor,
            });
            return { profileId: profile.id };
        },
    };

    const result = await runPersonalHomeBootstrap(bootstrapDeps);
    if (!result.profileId) {
        throw new Error('Personal Home completion did not produce an adopted profile.');
    }
    return { ...result, profileId: result.profileId };
}
