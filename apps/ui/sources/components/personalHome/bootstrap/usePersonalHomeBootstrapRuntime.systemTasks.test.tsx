import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { installLocalStorageMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import type { ServerCredentialLookupOptions } from '@/auth/storage/tokenStorage';
import type { ServerProfile } from '@/sync/domains/server/serverProfiles';
import type { PersonalHomeFacts } from './personalHomeBootstrapTypes';
import { usePersonalHomeBootstrapRuntime } from './usePersonalHomeBootstrapRuntime';

/**
 * Production-composition regression test for the Desktop Personal Home bootstrap.
 *
 * Real production seams exercised:
 * - `usePersonalHomeBootstrapRuntime` with the REAL `useLocalRelayRuntimeControl`;
 * - the REAL system-task spec builder (`buildLocalRelayRuntimeSystemTaskSpec`, including the
 *   fixed `renderPersonalHomeRuntimeEnv` map) inside the REAL `createSystemTaskRunner`;
 * - the REAL `waitForSystemTaskResult` wait path and `useSystemTaskSnapshot` store subscription;
 * - the REAL `runPersonalHomeBootstrapFromSystemTasks` composition caller delegating to the REAL
 *   `runPersonalHomeBootstrap` from `@happier-dev/cli-common/firstPartyRuntime`;
 * - the REAL `serverProfiles`/`adoptHomeProfile` owner (arranged through
 *   `upsertServerProfile`/`setActiveServerId`; internal profile logic is not a boundary).
 * - the REAL `useLocalDaemonControl` and `readLocalDaemonStatusData`, including setup adoption.
 *
 * Mocked boundaries (genuine system boundaries only):
 * - the system-task bridge (process/native boundary behind `createSystemTaskBridge`) — the only
 *   mocked process boundary;
 * - endpoint/network probes and the endpoint auth request;
 * - Home-scoped secure token storage.
 */
const harness = vi.hoisted(() => {
    const SYSTEM_TASK_PROTOCOL_VERSION = 1;
    const CANONICAL_SERVER_URL = 'http://127.0.0.1:3005';
    const HOME_B_IDENTITY = 'srv_home_b_identity';
    // Credential boundary mirrors the account subject returned by this Home's account endpoint.
    const HOME_B_TOKEN = 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJhY2N0X2hvbWVfYiJ9.fixture';
    const DEFAULT_HOME_DESCRIPTOR = {
        v: 1,
        homeServerIdentityId: HOME_B_IDENTITY,
        canonicalServerUrl: CANONICAL_SERVER_URL,
        revision: 1,
        endpoints: [{ kind: 'iroh', endpointId: 'c'.repeat(64) }],
    };

    type PersonalHomePurpose = Readonly<{ kind: 'personal-home'; canonicalServerUrl: string }>;
    type RecordedTaskSpec = Readonly<{
        seq: number;
        taskId: string;
        /** 'auto-refresh' = the hook's one mount status refresh; 'bootstrap' = started during the operation. */
        phase: 'auto-refresh' | 'bootstrap';
        kind: string;
        params: Record<string, unknown>;
    }>;
    type RecordedResult = Readonly<{ taskId: string; kind: string; data: Record<string, unknown>; error?: Readonly<{ code: string; message: string }> }>;

    const runtime = {
        installed: false,
        healthy: false,
        serviceActive: false,
        signupEnabled: false,
        purpose: null as PersonalHomePurpose | null,
        relayUrl: CANONICAL_SERVER_URL,
        version: null as string | null,
    };

    type DaemonRuntime = {
        serviceInstalled: boolean;
        daemonRunning: boolean;
        needsAuth: boolean;
        machineId: string | null;
        daemonServerUrl: string | null;
        daemonComparableKey: string | null;
        daemonAccountId: string | null;
        daemonMachineRegistered: boolean | null;
    };

    const daemonRuntime: DaemonRuntime = {
        serviceInstalled: false,
        daemonRunning: false,
        needsAuth: true,
        machineId: null,
        daemonServerUrl: null,
        daemonComparableKey: null,
        daemonAccountId: null,
        daemonMachineRegistered: null,
    };
    /** When set, status readbacks report this instead of the moved daemon state (wrong-Home injection). */
    let daemonStatusOverride: DaemonRuntime | null = null;
    /** When set, the override clears once the setup task approval succeeds (re-pair fixed the binding). */
    let daemonStatusClearsOnApproval = false;
    /** When set, status reads FAIL with this task error (e.g. the CLI cannot tell which profile is this Home). */
    let daemonStatusFailure: Readonly<{ code: string; message: string }> | null = null;
    let setupFailureAfterApproval: Readonly<{ code: string; message: string }> | null = null;

    const recordedSpecs: Array<RecordedTaskSpec> = [];
    const recordedResults: Array<RecordedResult> = [];
    const recordedPromptAnswers: Array<Readonly<{ taskId: string; answer: unknown }>> = [];
    const endpointRequests: Array<Readonly<{ endpointUrl: string; serverId: string | null; path: string; authorization: string | null }>> = [];
    const events: string[] = [];
    const listeners = new Map<string, { onEvent: (payload: unknown) => void; onResult: (payload: unknown) => void }>();
    const pendingTimers = new Set<ReturnType<typeof setTimeout>>();
    const promptAnswerResolvers = new Map<string, (answer: unknown) => void>();
    let nextTaskId = 0;
    let nextTsMs = 0;
    let bootstrapStarted = false;
    let authPingFailureCount = 0;
    /** /v1/features Home descriptor published by the endpoint feature probe; null = omitted. */
    let publishedHomeConnectionDescriptor: Record<string, unknown> | null = { ...DEFAULT_HOME_DESCRIPTOR };

    let credentialsStore: Readonly<{ token: string }> | null = null;
    let persistedCredentials: Readonly<{ token: string }> | null = null;
    const persistCalls: Array<Readonly<{ serverUrl: string; serverId: string | null; credentials: Record<string, string> }>> = [];
    const endpointAuthCalls: Array<Readonly<{
        endpointUrl: string;
        canonicalServerUrl: string | undefined;
        serverIdentityId: string | undefined;
        secretBase64Url: string | null;
    }>> = [];

    // Home-scoped pending bootstrap-seed custody boundary state (the storage beneath the
    // Home-scoped token-storage owner). Keyed by explicit canonical URL + stable identity.
    const pendingSeedStore = new Map<string, Uint8Array>();
    let pendingSeedWriteFailure = false;
    let pendingSeedReadbackFailure = false;

    // Simulated Home server account registry: a key-challenge account identity is fully
    // determined by its signing seed's public key, so the registry is keyed by the exact seed
    // bytes the endpoint auth call carried. Duplicate accounts are observable as registry size.
    const serverAccountsBySeedBase64Url = new Map<string, string>();
    /** When set, the endpoint commits the Account and then fails before the token returns. */
    let failCreateAfterCommit = false;

    function seedKey(serverUrl: string, options: ServerCredentialLookupOptions | undefined): string {
        return `${serverUrl}|${options?.serverId ?? ''}`;
    }

    function seedBase64Url(seed: Uint8Array | undefined): string {
        if (!seed) return '';
        let binary = '';
        for (const byte of seed) binary += String.fromCharCode(byte);
        return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
    }

    function statusData(): Record<string, unknown> {
        return {
            installed: runtime.installed,
            version: runtime.installed ? runtime.version : null,
            // relay.runtime.status.v1 always owns and reports the planned canonical URL,
            // including before the runtime is installed.
            relayUrl: runtime.relayUrl,
            healthy: runtime.installed && runtime.healthy,
            service: {
                active: runtime.installed ? runtime.serviceActive : null,
                enabled: runtime.installed ? true : null,
            },
            // The persisted Personal Home purpose survives every later task (moving runtime state).
            ...(runtime.purpose ? {
                purpose: runtime.purpose,
                canonicalServerUrl: runtime.purpose.canonicalServerUrl,
            } : {}),
            anonymousSignupEnabled: runtime.purpose?.kind === 'personal-home' ? runtime.signupEnabled : null,
            // A fresh server-light install creates meaningful master-secret/database state before
            // account creation, so interruption recovery must not equate data presence with an
            // already-committed Account.
            dataPresent: runtime.installed || serverAccountsBySeedBase64Url.size > 0,
        };
    }

    function readRecord(value: unknown): Record<string, unknown> {
        return value && typeof value === 'object' && !Array.isArray(value)
            ? value as Record<string, unknown>
            : {};
    }

    function emitLater(taskId: string, kind: string, delayMs: number): void {
        const timer = setTimeout(() => {
            pendingTimers.delete(timer);
            const listener = listeners.get(taskId);
            const data = statusData();
            recordedResults.push({ taskId, kind, data: JSON.parse(JSON.stringify(data)) as Record<string, unknown> });
            events.push(`task:${kind}:result`);
            listener?.onResult({
                protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
                taskId,
                ok: true,
                data,
            });
        }, delayMs);
        pendingTimers.add(timer);
    }

    function emitStepLater(taskId: string, stepId: string, delayMs: number): void {
        const timer = setTimeout(() => {
            pendingTimers.delete(timer);
            nextTsMs += 10;
            listeners.get(taskId)?.onEvent({
                protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
                taskId,
                tsMs: nextTsMs,
                type: 'progress',
                stepId,
                message: 'Personal Home runtime task in progress',
            });
        }, delayMs);
        pendingTimers.add(timer);
    }

    function daemonStatusData(): Record<string, unknown> {
        const status = daemonStatusOverride ?? daemonRuntime;
        return {
            serviceInstalled: status.serviceInstalled,
            daemonRunning: status.daemonRunning,
            needsAuth: status.needsAuth,
            machineId: status.machineId,
            daemonServerUrl: status.daemonServerUrl,
            daemonComparableKey: status.daemonComparableKey,
            daemonAccountId: status.daemonAccountId,
            daemonMachineRegistered: status.daemonMachineRegistered,
        };
    }

    function markDaemonReadyForPersonalHome(relayUrl: string): void {
        daemonRuntime.serviceInstalled = true;
        daemonRuntime.daemonRunning = true;
        daemonRuntime.needsAuth = false;
        daemonRuntime.machineId = 'machine-home-b';
        daemonRuntime.daemonServerUrl = relayUrl;
        daemonRuntime.daemonComparableKey = relayUrl;
        daemonRuntime.daemonAccountId = 'acct_home_b';
        daemonRuntime.daemonMachineRegistered = true;
    }

    async function endpointRequest(input: Readonly<{ endpointUrl: string; serverId: string | null; path: string; authorization: string | null }>): Promise<Response> {
        endpointRequests.push(input);
        if (input.endpointUrl !== CANONICAL_SERVER_URL) {
            return new Response(JSON.stringify({ error: 'wrong_endpoint' }), { status: 502 });
        }
        if (input.path.startsWith('/v1/account/profile')) {
            if (input.authorization !== `Bearer ${HOME_B_TOKEN}`) {
                return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
            }
            return new Response(JSON.stringify({ id: 'acct_home_b' }), { status: 200 });
        }
        if (input.path === '/v1/auth/response') {
            if (input.authorization !== `Bearer ${HOME_B_TOKEN}`) {
                return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
            }
            return new Response(JSON.stringify({ success: true }), { status: 200 });
        }
        // The real approval owner checks the pairing status at the explicit endpoint before it
        // posts the response.
        if (input.path.startsWith('/v1/auth/request/status')) {
            return new Response(JSON.stringify({ status: 'pending', supportsV2: true }), { status: 200 });
        }
        return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
    }

    function applyInstallOrUpdate(params: Record<string, unknown>): void {
        const purpose = readRecord(params.purpose);
        if (purpose.kind !== 'personal-home' || typeof purpose.canonicalServerUrl !== 'string') {
            throw new Error('manual bridge: installOrUpdate requires the personal-home purpose');
        }
        const env = readRecord(params.env);
        runtime.installed = true;
        runtime.healthy = true;
        runtime.serviceActive = true;
        runtime.purpose = { kind: 'personal-home', canonicalServerUrl: purpose.canonicalServerUrl };
        runtime.relayUrl = purpose.canonicalServerUrl;
        runtime.version = '0.3.0-manual-bridge';
        runtime.signupEnabled = env.AUTH_ANONYMOUS_SIGNUP_ENABLED !== '0';
    }

    const makeManualBridge = () => ({
        async start(spec: { kind: string; params?: unknown }): Promise<string> {
            const taskId = `bridge-task-${++nextTaskId}`;
            const params = JSON.parse(JSON.stringify(spec.params ?? {})) as Record<string, unknown>;
            recordedSpecs.push({
                seq: recordedSpecs.length + 1,
                taskId,
                phase: bootstrapStarted ? 'bootstrap' : 'auto-refresh',
                kind: spec.kind,
                params,
            });
            switch (spec.kind) {
                case 'relay.runtime.installOrUpdate.v1':
                    applyInstallOrUpdate(params);
                    emitStepLater(taskId, 'relay.runtime.install', 4);
                    emitLater(taskId, spec.kind, 14);
                    break;
                case 'relay.runtime.start.v1':
                case 'relay.runtime.restart.v1':
                    if (!runtime.installed) throw new Error('manual bridge: runtime is not installed');
                    runtime.healthy = true;
                    runtime.serviceActive = true;
                    if (spec.kind === 'relay.runtime.restart.v1') emitStepLater(taskId, 'relay.runtime.restart', 4);
                    emitLater(taskId, spec.kind, 14);
                    break;
                case 'relay.runtime.status.v1':
                    emitLater(taskId, spec.kind, 8);
                    break;
                case 'setup.thisComputer.v1': {
                    events.push('setup:thisComputer:started');
                    // The runner subscribes to bridge events only after start() resolves, so the
                    // blocking approval prompt is deferred exactly like the other emissions
                    // (emitStepLater/emitLater); an immediate emit would be dropped.
                    const promptTimer = setTimeout(() => {
                        pendingTimers.delete(promptTimer);
                        // hsetup seals the v3 token-only pairing response and asks the UI to post
                        // it: a blocking prompt carrying only public/opaque material.
                        nextTsMs += 10;
                        listeners.get(taskId)?.onEvent({
                            protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
                            taskId,
                            tsMs: nextTsMs,
                            type: 'prompt',
                            stepId: 'setup.thisComputer.auth.request',
                            message: 'Approve this computer in Happier to continue',
                            data: {
                                kind: 'authRequest',
                                publicKey: 'pub-home-b',
                                response: 'opaque-token-only-response',
                                responseKind: 'tokenOnly',
                                relayUrl: params.activeRelayUrl,
                                webappUrl: params.activeWebappUrl,
                                cliProvenance: 'managed',
                            },
                        });
                    }, 4);
                    pendingTimers.add(promptTimer);
                    void (async () => {
                        const answer = await new Promise((resolve) => {
                            promptAnswerResolvers.set(taskId, resolve);
                        });
                        const approved = (answer as { approved?: unknown } | null)?.approved === true;
                        events.push(`setup:thisComputer:answered:${approved ? 'approved' : 'declined'}`);
                        if (approved && typeof params.activeRelayUrl === 'string') {
                            markDaemonReadyForPersonalHome(params.activeRelayUrl);
                        }
                        if (approved && daemonStatusClearsOnApproval) {
                            daemonStatusOverride = null;
                            daemonStatusClearsOnApproval = false;
                        }
                        const data = { machineId: approved ? 'machine-home-b' : null };
                        recordedResults.push({ taskId, kind: spec.kind, data });
                        events.push(`task:${spec.kind}:result`);
                        // This Home's own service is set up, but hsetup still fails the run (for
                        // example one of the other services could not follow the CLI choice).
                        const failure = approved ? setupFailureAfterApproval : null;
                        listeners.get(taskId)?.onResult({
                            protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
                            taskId,
                            ok: approved && !failure,
                            ...(failure
                                ? { error: failure }
                                : approved ? { data } : { error: { code: 'approval_required', message: 'Pairing was not approved.' } }),
                        });
                    })();
                    break;
                }
                case 'daemon.service.status.v1': {
                    events.push('daemon:status:read');
                    // Like relay status, deliver after the real runner subscribes to this task.
                    const statusTimer = setTimeout(() => {
                        pendingTimers.delete(statusTimer);
                        if (daemonStatusFailure) {
                            recordedResults.push({ taskId, kind: spec.kind, data: {}, error: daemonStatusFailure });
                            listeners.get(taskId)?.onResult({
                                protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
                                taskId,
                                ok: false,
                                error: daemonStatusFailure,
                            });
                            return;
                        }
                        const data = daemonStatusData();
                        recordedResults.push({ taskId, kind: spec.kind, data: JSON.parse(JSON.stringify(data)) as Record<string, unknown> });
                        listeners.get(taskId)?.onResult({
                            protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
                            taskId,
                            ok: true,
                            data,
                        });
                    }, 8);
                    pendingTimers.add(statusTimer);
                    break;
                }
                default:
                    throw new Error(`manual bridge: unexpected task kind ${spec.kind}`);
            }
            return taskId;
        },
        async subscribe(taskId: string, listenerSet: { onEvent: (payload: unknown) => void; onResult: (payload: unknown) => void }) {
            listeners.set(taskId, listenerSet);
            return () => {
                listeners.delete(taskId);
            };
        },
        async cancel(taskId: string): Promise<void> {
            listeners.get(taskId)?.onResult({
                protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
                taskId,
                ok: false,
                error: { code: 'cancelled', message: 'Task cancelled' },
            });
        },
        async respond(taskId: string, answer: unknown): Promise<void> {
            recordedPromptAnswers.push({ taskId, answer });
            const resolver = promptAnswerResolvers.get(taskId);
            if (resolver) {
                promptAnswerResolvers.delete(taskId);
                resolver(answer);
            }
        },
    });

    const authGetTokenAtEndpoint = vi.fn(async (params: {
        endpointUrl: string;
        canonicalServerUrl?: string;
        serverIdentityId?: string;
        secret?: Uint8Array;
    }) => {
        endpointAuthCalls.push({
            endpointUrl: params.endpointUrl,
            canonicalServerUrl: params.canonicalServerUrl,
            serverIdentityId: params.serverIdentityId,
            secretBase64Url: seedBase64Url(params.secret),
        });
        if (runtime.installed && runtime.purpose?.kind === 'personal-home' && runtime.signupEnabled === false) {
            // Fresh unauthenticated signup attempt after closure: refused on the real endpoint path.
            events.push('auth:endpoint-token:signup-closed');
            throw Object.assign(new Error('anonymous signup is disabled'), { code: 'signup-disabled' });
        }
        // Simulated server commit: the account identity is the seed's public key. An account
        // already committed for these exact bytes is reused instead of re-created.
        const committedSeedKey = seedBase64Url(params.secret);
        if (committedSeedKey && !serverAccountsBySeedBase64Url.has(committedSeedKey)) {
            if (failCreateAfterCommit) {
                serverAccountsBySeedBase64Url.set(committedSeedKey, `acct_${committedSeedKey.slice(0, 8)}`);
                events.push('auth:endpoint-token:committed-then-crashed');
                throw new Error('crashed after the server committed the Account, before token persistence');
            }
            serverAccountsBySeedBase64Url.set(committedSeedKey, `acct_${committedSeedKey.slice(0, 8)}`);
        }
        events.push('auth:endpoint-token:signup-open');
        return { token: HOME_B_TOKEN };
    });
    const focusedAuthGetToken = vi.fn(async () => {
        events.push('auth:focused-token');
        throw new Error('focused auth must not be used during Personal Home bootstrap');
    });

    return {
        CANONICAL_SERVER_URL,
        HOME_B_IDENTITY,
        HOME_B_TOKEN,
        makeManualBridge,
        markBootstrapStarted: () => {
            bootstrapStarted = true;
        },
        recordedSpecs: () => recordedSpecs,
        recordedResults: () => recordedResults,
        events: () => [...events],
        state: () => ({ ...runtime }),
        installExistingHome() {
            runtime.installed = true;
            runtime.healthy = true;
            runtime.serviceActive = true;
            runtime.purpose = { kind: 'personal-home', canonicalServerUrl: CANONICAL_SERVER_URL };
            runtime.version = '0.3.0-manual-bridge';
            credentialsStore = { token: HOME_B_TOKEN };
        },
        resultForTask: (taskId: string) => recordedResults.find((entry) => entry.taskId === taskId)?.data ?? null,
        endpointAuthCalls: () => endpointAuthCalls,
        persistCalls: () => persistCalls,
        persistedCredentials: () => persistedCredentials,
        authGetTokenAtEndpoint,
        focusedAuthGetToken,
        recordedPromptAnswers: () => recordedPromptAnswers,
        endpointRequests: () => endpointRequests,
        endpointRequest,
        setDaemonStatusOverride: (override: DaemonRuntime | null) => {
            daemonStatusOverride = override;
        },
        setDaemonStatusFailure: (failure: Readonly<{ code: string; message: string }> | null) => {
            daemonStatusFailure = failure;
        },
        setSetupFailureAfterApproval: (failure: Readonly<{ code: string; message: string }> | null) => {
            setupFailureAfterApproval = failure;
        },
        setDaemonStatusOverrideClearsOnApproval: () => {
            daemonStatusClearsOnApproval = true;
        },
        daemonFacts: () => ({ ...daemonRuntime }),
        reset() {
            runtime.installed = false;
            runtime.healthy = false;
            runtime.serviceActive = false;
            runtime.signupEnabled = false;
            runtime.purpose = null;
            runtime.relayUrl = CANONICAL_SERVER_URL;
            runtime.version = null;
            daemonRuntime.serviceInstalled = false;
            daemonRuntime.daemonRunning = false;
            daemonRuntime.needsAuth = true;
            daemonRuntime.machineId = null;
            daemonRuntime.daemonServerUrl = null;
            daemonRuntime.daemonComparableKey = null;
            daemonRuntime.daemonAccountId = null;
            daemonRuntime.daemonMachineRegistered = null;
            daemonStatusOverride = null;
            daemonStatusClearsOnApproval = false;
            daemonStatusFailure = null;
            setupFailureAfterApproval = null;
            recordedSpecs.length = 0;
            recordedResults.length = 0;
            recordedPromptAnswers.length = 0;
            endpointRequests.length = 0;
            events.length = 0;
            bootstrapStarted = false;
            for (const timer of pendingTimers) clearTimeout(timer);
            pendingTimers.clear();
            listeners.clear();
            promptAnswerResolvers.clear();
            credentialsStore = null;
            persistedCredentials = null;
            persistCalls.length = 0;
            endpointAuthCalls.length = 0;
            pendingSeedStore.clear();
            pendingSeedWriteFailure = false;
            pendingSeedReadbackFailure = false;
            serverAccountsBySeedBase64Url.clear();
            failCreateAfterCommit = false;
            authPingFailureCount = 0;
            publishedHomeConnectionDescriptor = { ...DEFAULT_HOME_DESCRIPTOR };
            authGetTokenAtEndpoint.mockClear();
            focusedAuthGetToken.mockClear();
        },
        // Storage/auth/probe side effects shared with the vi.mock factories below.
        storage: {
            readCredentials: async () => {
                events.push('storage:read');
                return credentialsStore;
            },
            getPendingSeed: async (serverUrl: string, options: ServerCredentialLookupOptions | undefined) => {
                if (pendingSeedReadbackFailure) return null;
                const seed = pendingSeedStore.get(seedKey(serverUrl, options));
                return seed ? new Uint8Array(seed) : null;
            },
            setPendingSeed: async (
                serverUrl: string,
                options: ServerCredentialLookupOptions | undefined,
                seed: Uint8Array,
            ) => {
                if (pendingSeedWriteFailure) return false;
                pendingSeedStore.set(seedKey(serverUrl, options), new Uint8Array(seed));
                return true;
            },
            clearPendingSeed: async (serverUrl: string, options: ServerCredentialLookupOptions | undefined) => {
                pendingSeedStore.delete(seedKey(serverUrl, options));
                return true;
            },
            persistCredentials: async (serverUrl: string, options: ServerCredentialLookupOptions, credentials: { token: string }) => {
                events.push('storage:persist');
                persistCalls.push({
                    serverUrl,
                    serverId: options?.serverId ?? null,
                    credentials: { ...credentials },
                });
                credentialsStore = { ...credentials };
                persistedCredentials = { ...credentials };
                return true;
            },
        },
        serverAccounts: () => serverAccountsBySeedBase64Url,
        pendingSeeds: () => [...pendingSeedStore.entries()].map(([key, seed]) => ({ key, seed })),
        setPendingSeedWriteFailure(value: boolean) {
            pendingSeedWriteFailure = value;
        },
        setPendingSeedReadbackFailure(value: boolean) {
            pendingSeedReadbackFailure = value;
        },
        setFailCreateAfterCommit(value: boolean) {
            failCreateAfterCommit = value;
        },
        probes: {
            serverFeatures: async () => {
                events.push('probe:endpoint');
                if (!runtime.installed || !runtime.healthy) {
                    return { status: 'error' as const, reason: 'network' as const };
                }
                return {
                    status: 'ready' as const,
                    serverIdentityId: HOME_B_IDENTITY,
                    features: {
                        capabilities: {
                            serverIdentity: { serverIdentityId: HOME_B_IDENTITY },
                            encryption: { storagePolicy: 'plaintext_only' },
                            auth: {
                                signup: {
                                    methods: [{ id: 'anonymous', enabled: runtime.signupEnabled }],
                                },
                            },
                        },
                        ...(publishedHomeConnectionDescriptor
                            ? { homeConnectionDescriptor: publishedHomeConnectionDescriptor }
                            : {}),
                    },
                };
            },
            authPing: async (params: { endpoint: string; token: string }) => {
                events.push('auth:ping');
                if (authPingFailureCount > 0) {
                    authPingFailureCount -= 1;
                    return { status: 'auth_failed' as const, statusCode: 401 as const, errorMessage: 'unauthorized' };
                }
                if (params.token === credentialsStore?.token && runtime.installed && runtime.healthy) {
                    return { status: 'ready' as const };
                }
                return { status: 'auth_failed' as const, statusCode: 401 as const, errorMessage: 'unauthorized' };
            },
            setNextAuthPingFailure(count: number) {
                authPingFailureCount = count;
            },
            setPublishedHomeConnectionDescriptor(descriptor: Record<string, unknown> | null) {
                publishedHomeConnectionDescriptor = descriptor;
            },
        },
    };
});

// Modal boundary: the account-move consent (R10 D1) is a user answer, supplied per test.
const modalConsent = vi.hoisted(() => ({
    confirm: vi.fn(async (..._args: unknown[]) => true),
}));
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: { confirm: (...args) => modalConsent.confirm(...args) } }).module;
});

// System-task bridge (process/native boundary): the REAL runner, spec builder and wait path stay
// live above this mock; the bridge only records actual specs and moves the managed runtime state.
vi.mock('@/components/systemTasks/createSystemTaskBridge', () => ({
    createSystemTaskBridge: () => harness.makeManualBridge(),
}));

// Explicit-endpoint HTTP transport boundary. The focused-Home fetch must never be entered.
vi.mock('@/sync/http/client', () => ({
    serverFetch: async () => {
        throw new Error('focused serverFetch must not be used by Personal Home bootstrap');
    },
    createServerFetchAtEndpoint: (params: { endpointUrl: string; serverId?: string }) => {
        const endpointUrl = params.endpointUrl;
        const serverId = params.serverId ?? null;
        return async (path: string, init?: RequestInit) => {
            const authorization = (init?.headers as Record<string, string> | undefined)?.Authorization ?? null;
            return await harness.endpointRequest({ endpointUrl, serverId, path, authorization });
        };
    },
}));

// Endpoint auth request boundary. The focused-Home flow must never be entered by bootstrap.
vi.mock('@/auth/flows/getToken', () => ({
    authGetToken: harness.focusedAuthGetToken,
    authGetTokenAtEndpoint: harness.authGetTokenAtEndpoint,
}));

// Home-scoped secure token storage boundary (native storage beneath the owner), including the
// pending Personal Home bootstrap-seed custody used before the account-creating endpoint call.
vi.mock('@/auth/storage/tokenStorage', async (importOriginal) => {
    const { createTokenStorageModuleMock } = await import('@/dev/testkit/mocks/tokenStorage');
    return createTokenStorageModuleMock({
        importOriginal,
        tokenStorage: {
        getCredentialsForServerUrl: vi.fn(async () => await harness.storage.readCredentials()),
        setCredentialsForServerUrl: vi.fn(async (
            serverUrl: string,
            options: ServerCredentialLookupOptions,
            credentials: Readonly<{ token: string }>,
        ) => await harness.storage.persistCredentials(serverUrl, options, credentials)),
        getPendingPersonalHomeBootstrapSeed: vi.fn(async (
            serverUrl: string,
            options?: ServerCredentialLookupOptions,
        ) => await harness.storage.getPendingSeed(serverUrl, options)),
        setPendingPersonalHomeBootstrapSeed: vi.fn(async (
            serverUrl: string,
            options: ServerCredentialLookupOptions | undefined,
            seed: Uint8Array,
        ) => await harness.storage.setPendingSeed(serverUrl, options, seed)),
        clearPendingPersonalHomeBootstrapSeed: vi.fn(async (
            serverUrl: string,
            options?: ServerCredentialLookupOptions,
        ) => await harness.storage.clearPendingSeed(serverUrl, options)),
        },
    });
});

// Endpoint/network feature probe boundary.
vi.mock('@/sync/api/capabilities/serverFeaturesClient', () => ({
    probeServerFeaturesAtUrl: vi.fn(async () => await harness.probes.serverFeatures()),
}));

// Endpoint/network authenticated probe boundary.
vi.mock('@/sync/api/capabilities/probeAuthenticatedServerAuthPingEndpoint', () => ({
    probeAuthenticatedServerAuthPingEndpoint: vi.fn(async (
        params: Readonly<{ endpoint: string; token: string }>,
    ) => await harness.probes.authPing(params)),
}));

async function resetProfileRegistry(): Promise<void> {
    const profiles = await import('@/sync/domains/server/serverProfiles');
    profiles.clearTabActiveServerId();
    for (const profile of profiles.listServerProfiles()) await profiles.removeServerProfile(profile.id);
}

const initialFacts: PersonalHomeFacts = {
    hostIsDesktop: true,
    isDesktopMainWindow: true,
    explicitlySelectedOtherHome: false,
    completedPersonalHomeProfile: null,
    candidateLocalProfile: null,
    relayRuntime: null,
    localHomeReachability: 'unknown',
    localHomeIdentity: null,
    localHomeAuth: 'missing',
    anonymousSignup: 'unknown',
    daemon: null,
    activeTask: null,
};

async function runHookOperation<Result>(operation: (() => Promise<Result>) | undefined): Promise<Result> {
    if (!operation) throw new Error('Expected the Personal Home hook operation to be available.');

    let operationPromise!: Promise<Result>;
    let settled = false;
    act(() => {
        operationPromise = operation();
        // Attach a rejection handler immediately while the deterministic task timers are drained.
        // The original promise is still returned below so callers can assert its exact failure.
        void operationPromise.catch(() => {});
        void operationPromise.then(
            () => { settled = true; },
            () => { settled = true; },
        );
    });
    for (let attempt = 0; attempt < 80 && !settled; attempt += 1) {
        await act(async () => {
            for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
        });
        act(() => {
            vi.runOnlyPendingTimers();
        });
        await act(async () => {
            for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
        });
    }
    if (!settled) {
        throw new Error(`Personal Home operation did not settle; events=${JSON.stringify(harness.events())}`);
    }
    return await operationPromise;
}

describe('usePersonalHomeBootstrapRuntime system-task composition', () => {
    beforeEach(async () => {
        vi.useFakeTimers();
        await harness.reset();
        await resetProfileRegistry();
    });

    afterEach(async () => {
        try {
            standardCleanup();
            await resetProfileRegistry();
        } finally {
            await harness.reset();
            const { TokenStorage } = await import('@/auth/storage/tokenStorage');
            vi.mocked(TokenStorage.getCredentialsForServerUrl).mockImplementation(async () => await harness.storage.readCredentials());
            vi.useRealTimers();
        }
    });

    it.each(['primary', 'canonical-alias'] as const)('does not prepare this computer when the runtime URL names two saved Home identities (%s)', async (matching) => {
        const storage = installLocalStorageMock();
        vi.stubGlobal('window', { localStorage: globalThis.localStorage });
        vi.stubGlobal('document', {});
        const profiles = await import('@/sync/domains/server/serverProfiles');
        profiles.resetServerProfilesRuntimeForTests();
        try {
            harness.installExistingHome();
            const profile = await profiles.adoptPersonalHomeProfileAndComplete({
                descriptor: { serverUrl: harness.CANONICAL_SERVER_URL, homeServerIdentityId: harness.HOME_B_IDENTITY },
                source: 'desktop-personal-home',
            });
            const persisted = [...storage.store.entries()].find(([key]) => key.includes('server-state-v1'))!;
            // Seed the genuine persistence boundary: live adoption correctly refuses conflicting identities.
            const state = JSON.parse(persisted[1]) as { servers: Record<string, ServerProfile> };
            state.servers[profile.id] = { ...profile, canonicalServerUrl: harness.CANONICAL_SERVER_URL };
            state.servers['same-url-other-home'] = {
                ...profile, id: 'same-url-other-home', serverIdentityId: 'srv_other_home',
                canonicalServerUrl: harness.CANONICAL_SERVER_URL,
                ...(matching === 'canonical-alias' ? {
                    serverUrl: 'https://other-home.example.test',
                } : {}),
            };
            storage.store.set(persisted[0], JSON.stringify(state));
            profiles.resetServerProfilesRuntimeForTests();
            expect(profiles.resolveSavedServerProfileByUrl(harness.CANONICAL_SERVER_URL, { includeCanonicalServerUrl: true }).kind).toBe('ambiguous');
            const hook = await renderHook(() => usePersonalHomeBootstrapRuntime());
            const facts = await runHookOperation(() => hook.getCurrent().readFacts());
            await expect(runHookOperation(() => hook.getCurrent().operations['prepare-computer']!(facts))).rejects.toBeInstanceOf(Error);
            expect(harness.endpointRequests().filter((request) => request.path === '/v1/auth/response')).toEqual([]);
        } finally {
            standardCleanup();
            storage.restore();
            vi.unstubAllGlobals();
            profiles.resetServerProfilesRuntimeForTests();
        }
    });

    it.each(['replacement', 'first-adoption'])('pairs the newly adopted exact Home at an unchanged URL (%s)', async (scenario) => {
        const profiles = await import('@/sync/domains/server/serverProfiles');
        harness.installExistingHome();
        const previous = scenario === 'replacement' ? await profiles.adoptPersonalHomeProfileAndComplete({
            descriptor: { serverUrl: harness.CANONICAL_SERVER_URL, homeServerIdentityId: 'srv_home_a_identity' },
            source: 'desktop-personal-home',
        }) : null;
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        vi.mocked(TokenStorage.getCredentialsForServerUrl).mockImplementation(async (_url, options) => (
            options?.serverId === harness.HOME_B_IDENTITY ? { token: harness.HOME_B_TOKEN } : null
        ));
        const hook = await renderHook(() => usePersonalHomeBootstrapRuntime());
        // Settle the native status read while the predecessor (or no profile) is
        // still present, so the mounted approval owner has already seen this URL.
        await act(async () => { vi.runOnlyPendingTimers(); });
        await flushHookEffects();
        expect(hook.getCurrent().localServerUrl).toBe(harness.CANONICAL_SERVER_URL);
        await act(async () => {
            if (previous) await profiles.removeServerProfile(previous.id);
            await profiles.adoptPersonalHomeProfileAndComplete({
                descriptor: { serverUrl: harness.CANONICAL_SERVER_URL, homeServerIdentityId: harness.HOME_B_IDENTITY },
                source: 'desktop-personal-home',
            });
        });
        const facts = await runHookOperation(() => hook.getCurrent().readFacts());
        await runHookOperation(() => hook.getCurrent().operations['prepare-computer']!(facts));
        expect(harness.recordedPromptAnswers()).toEqual([expect.objectContaining({ answer: { approved: true } })]);
        expect(harness.endpointRequests().filter((request) => request.path === '/v1/auth/response')).toEqual([
            expect.objectContaining({ serverId: harness.HOME_B_IDENTITY, authorization: `Bearer ${harness.HOME_B_TOKEN}` }),
        ]);
        vi.mocked(TokenStorage.getCredentialsForServerUrl).mockImplementation(async () => await harness.storage.readCredentials());
    });

    it('drives the real relay runtime control and bootstrap helper through canonical install/update readbacks and ends healthy with signup closed', async () => {
        // Arrange the unrelated focused Home A through the real profile owner.
        const profiles = await import('@/sync/domains/server/serverProfiles');
        const focusedHome = await profiles.upsertServerProfile({
            serverUrl: 'https://home-a.example',
            name: 'Focused Home A',
            source: 'manual',
        });
        await profiles.setActiveServerId(focusedHome.id);
        const homeABefore: ServerProfile | null = profiles.getServerProfileById(focusedHome.id);
        expect(homeABefore).not.toBeNull();
        const profileEmissions: Array<readonly ServerProfile[]> = [];
        const unsubscribeProfiles = profiles.subscribeServerProfiles(
            () => profileEmissions.push(profiles.listServerProfiles()),
        );

        const { usePersonalHomeBootstrapRuntime } = await import('./usePersonalHomeBootstrapRuntime');
        const hook = await renderHook(() => usePersonalHomeBootstrapRuntime());

        // Both real runtime-control hooks refresh at mount before bootstrap starts.
        expect(harness.recordedSpecs().map((spec) => [spec.phase, spec.kind])).toEqual([
            ['auto-refresh', 'relay.runtime.status.v1'],
            ['auto-refresh', 'daemon.service.status.v1'],
        ]);

        harness.markBootstrapStarted();
        await runHookOperation(() => hook.getCurrent().operations['ensure-home-ready']!(initialFacts));
        unsubscribeProfiles();
        const eventsDuringBootstrap = harness.events();

        // 1. The actual specs crossed the bridge in the canonical ordered sequence.
        const specs = harness.recordedSpecs();
        const bootstrapSpecs = specs.filter((spec) => spec.phase === 'bootstrap');
        expect(bootstrapSpecs[0]?.kind).toBe('relay.runtime.status.v1');
        expect(harness.resultForTask(bootstrapSpecs[0]!.taskId)).toMatchObject({
            installed: false,
            relayUrl: harness.CANONICAL_SERVER_URL,
        });
        const mutations = bootstrapSpecs.filter((spec) => spec.kind !== 'relay.runtime.status.v1');
        expect(mutations.map((spec) => spec.kind)).toEqual([
            'relay.runtime.installOrUpdate.v1',
            'relay.runtime.installOrUpdate.v1',
        ]);
        const closureInstallSpecIndex = bootstrapSpecs.map((spec) => spec.kind).lastIndexOf('relay.runtime.installOrUpdate.v1');
        const readbackIndex = bootstrapSpecs.findIndex((spec, index) => (
            index > closureInstallSpecIndex && spec.kind === 'relay.runtime.status.v1'
        ));
        expect(readbackIndex).toBeGreaterThan(closureInstallSpecIndex);
        expect(bootstrapSpecs.slice(readbackIndex).every((spec) => spec.kind === 'relay.runtime.status.v1')).toBe(true);

        // 2. Purpose/canonical URL and anonymous signup reached the task specs through the fixed
        //    Personal Home env map (signup enabled during loopback bootstrap, then disabled).
        expect(mutations.map((spec) => spec.params.env)).toMatchObject([
            { AUTH_ANONYMOUS_SIGNUP_ENABLED: '1' },
            { AUTH_ANONYMOUS_SIGNUP_ENABLED: '0' },
        ]);
        expect(mutations[0]?.params.expectedPersonalHomeState).toEqual({
            installed: false,
            canonicalServerUrl: null,
            dataPresent: false,
        });
        expect(mutations[1]?.params.expectedPersonalHomeState).toEqual({
            installed: true,
            canonicalServerUrl: harness.CANONICAL_SERVER_URL,
            dataPresent: true,
        });
        for (const spec of mutations) {
            expect(spec.params.target).toEqual({ kind: 'local' });
            expect(spec.params.mode).toBe('user');
            expect(spec.params.purpose).toEqual({
                kind: 'personal-home',
                canonicalServerUrl: harness.CANONICAL_SERVER_URL,
            });
            expect(spec.params.env).toMatchObject({
                HAPPIER_SERVER_HOST: '127.0.0.1',
                PORT: '3005',
                HAPPIER_CANONICAL_SERVER_URL: harness.CANONICAL_SERVER_URL,
                HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'plaintext_only',
                HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: 'plain',
            });
            expect(spec.params.env).not.toHaveProperty('HAPPIER_PUBLIC_SERVER_URL');
        }
        for (const spec of bootstrapSpecs.filter((entry) => entry.kind === 'relay.runtime.status.v1')) {
            expect(spec.params.purpose).toBeUndefined();
            expect(spec.params.env).toBeUndefined();
        }

        // 3. The managed runtime ends installed, healthy, with anonymous signup disabled; the
        //    post-update status readback reports the persisted Personal Home purpose.
        expect(harness.state()).toMatchObject({ installed: true, healthy: true, signupEnabled: false });
        const readbackData = harness.resultForTask(bootstrapSpecs[readbackIndex]!.taskId);
        expect(readbackData).toMatchObject({
            installed: true,
            healthy: true,
            relayUrl: harness.CANONICAL_SERVER_URL,
            purpose: { kind: 'personal-home', canonicalServerUrl: harness.CANONICAL_SERVER_URL },
            anonymousSignupEnabled: false,
            service: { active: true, enabled: true },
        });
        expect(harness.resultForTask(mutations[0]!.taskId)).toMatchObject({
            installed: true,
            healthy: true,
            purpose: { kind: 'personal-home', canonicalServerUrl: harness.CANONICAL_SERVER_URL },
            anonymousSignupEnabled: true,
        });

        // 4. Account auth is explicit-endpoint against the local Home, never focused auth.
        //    Exactly one account creation and one live signup-refusal attempt (no duplicates).
        const endpointAuthCalls = harness.endpointAuthCalls();
        expect(endpointAuthCalls).toHaveLength(2);
        for (const call of endpointAuthCalls) {
            expect(call.endpointUrl).toBe(harness.CANONICAL_SERVER_URL);
            expect(call.canonicalServerUrl).toBe(harness.CANONICAL_SERVER_URL);
            expect(call.serverIdentityId).toBe(harness.HOME_B_IDENTITY);
        }
        expect(harness.focusedAuthGetToken).not.toHaveBeenCalled();

        // 5. Stored credentials are exactly { token } — no secret material.
        expect(harness.persistedCredentials()).toEqual({ token: harness.HOME_B_TOKEN });
        expect(Object.keys(harness.persistedCredentials() ?? {})).toEqual(['token']);
        expect(harness.persistCalls()).toHaveLength(1);
        expect(harness.persistCalls()[0]).toMatchObject({
            serverUrl: harness.CANONICAL_SERVER_URL,
            serverId: harness.HOME_B_IDENTITY,
        });

        // 6. Adoption happens only after the verified signup refusal (post-restart) and the
        //    authenticated readback. Ordering is observable through the boundary events; the
        //    adopted profile itself is the completion receipt, which production persists only
        //    after the refusal gate and authenticated access check pass (any earlier failure
        //    rejects the operation and leaves no adopted profile behind).
        const refusalAttemptIndex = eventsDuringBootstrap.indexOf('auth:endpoint-token:signup-closed');
        const closureUpdateResultIndex = eventsDuringBootstrap.lastIndexOf('task:relay.runtime.installOrUpdate.v1:result');
        const lastAuthPingIndex = eventsDuringBootstrap.lastIndexOf('auth:ping');
        expect(closureUpdateResultIndex).toBeGreaterThan(-1);
        expect(refusalAttemptIndex).toBeGreaterThan(closureUpdateResultIndex);
        expect(lastAuthPingIndex).toBeGreaterThan(refusalAttemptIndex);
        expect(eventsDuringBootstrap.filter((entry) => entry === 'auth:endpoint-token:signup-open')).toHaveLength(1);
        const personalHomes = profiles.listServerProfiles().filter((profile) => profile.source === 'desktop-personal-home');
        expect(personalHomes).toHaveLength(1);
        expect(personalHomes[0]).toMatchObject({
            serverUrl: harness.CANONICAL_SERVER_URL,
            canonicalServerUrl: harness.CANONICAL_SERVER_URL,
            serverIdentityId: harness.HOME_B_IDENTITY,
            personalHomeBootstrapCompleted: true,
        });
        const personalHomeEmissions = profileEmissions
            .map((next) => next.filter((profile) => profile.serverIdentityId === harness.HOME_B_IDENTITY))
            .filter((next) => next.length > 0);
        expect(personalHomeEmissions).toHaveLength(1);
        expect(personalHomeEmissions[0]).toEqual([
            expect.objectContaining({ personalHomeBootstrapCompleted: true }),
        ]);

        // 7. The unrelated focused Home A is unchanged and remains the focused Home; the real
        //    profile owner performed no focus change and focused auth was never used.
        const homeAAfter = profiles.getServerProfileById(focusedHome.id);
        expect(JSON.stringify(homeAAfter)).toBe(JSON.stringify(homeABefore));
        expect(profiles.getActiveServerSnapshot().serverId).toBe(focusedHome.id);
        expect(eventsDuringBootstrap).not.toContain('auth:focused-token');

        // Re-read facts through the real hook after completion: healthy runtime, closed signup,
        // present auth, adopted profile — the shell-releasing invariants.
        const facts = await runHookOperation(() => hook.getCurrent().readFacts());
        expect(facts.relayRuntime).toMatchObject({
            installed: true,
            healthy: true,
            status: 'healthy',
            anonymousSignupEnabled: false,
            purpose: { kind: 'personal-home', canonicalServerUrl: harness.CANONICAL_SERVER_URL },
        });
        expect(facts.localHomeReachability).toBe('reachable');
        expect(facts.localHomeIdentity).toBe(harness.HOME_B_IDENTITY);
        expect(facts.anonymousSignup).toBe('disabled');
        expect(facts.localHomeAuth).toBe('present');
        expect(facts.completedPersonalHomeProfile).toMatchObject({
            id: personalHomes[0]!.id,
            source: 'desktop-personal-home',
            personalHomeBootstrapCompleted: true,
        });
        expect(facts.candidateLocalProfile).toMatchObject({ id: personalHomes[0]!.id });

        // A running daemon on the same endpoint but authenticated as ANOTHER account must not
        // read as ready: prepare-computer has to actually run the setup task and re-pair it.
        harness.setDaemonStatusOverride({
            serviceInstalled: true,
            daemonRunning: true,
            needsAuth: false,
            machineId: 'machine-home-a',
            daemonServerUrl: harness.CANONICAL_SERVER_URL,
            daemonComparableKey: harness.CANONICAL_SERVER_URL,
            daemonAccountId: 'acct_home_a',
            daemonMachineRegistered: true,
        });
        harness.setDaemonStatusOverrideClearsOnApproval();
        const wrongAccountFacts = await runHookOperation(() => hook.getCurrent().readFacts());
        expect(wrongAccountFacts.daemon).toMatchObject({
            daemonAccountId: 'acct_home_a',
            servesPersonalHome: false,
        });

        // --- Post-shell daemon composition: one explicit setup.thisComputer.v1 for B. ---
        harness.markBootstrapStarted();
        modalConsent.confirm.mockClear();
        await runHookOperation(() => hook.getCurrent().operations['prepare-computer']!(facts));
        // R10 D1: re-pairing a daemon signed in to another account asked once, naming both.
        expect(modalConsent.confirm).toHaveBeenCalledTimes(1);

        // 8. Exactly one explicit setup task, carrying the explicit Home B URLs independent of
        //    the still-focused Home A, with the full configure/auth/pair/install/start/verify scope.
        const setupSpecs = harness.recordedSpecs().filter((spec) => spec.kind === 'setup.thisComputer.v1');
        expect(setupSpecs).toHaveLength(1);
        expect(setupSpecs[0]!.params).toMatchObject({
            activeRelayUrl: harness.CANONICAL_SERVER_URL,
            activeWebappUrl: harness.CANONICAL_SERVER_URL,
            activeLocalRelayUrl: harness.CANONICAL_SERVER_URL,
            installService: true,
            startService: true,
            verifyService: true,
        });

        // 9. The blocking token-only approval was answered through the explicit endpoint with
        //    Home B's scoped token; the answer itself carries no credential or secret.
        expect(harness.recordedPromptAnswers()).toEqual([
            { taskId: setupSpecs[0]!.taskId, answer: { approved: true } },
        ]);
        const approvalRequests = harness.endpointRequests().filter((request) => request.path === '/v1/auth/response');
        expect(approvalRequests).toHaveLength(1);
        expect(approvalRequests[0]).toMatchObject({
            endpointUrl: harness.CANONICAL_SERVER_URL,
            authorization: `Bearer ${harness.HOME_B_TOKEN}`,
        });
        expect(harness.endpointRequests().every((request) => request.endpointUrl === harness.CANONICAL_SERVER_URL)).toBe(true);

        // 10. A fresh daemon status readback ran after the setup result and verified installed,
        //     running, authenticated, registered, machine identity, and Home B URL/account facts.
        const statusTaskIndexes = harness.recordedSpecs()
            .map((spec, index) => (spec.kind === 'daemon.service.status.v1' ? index : -1))
            .filter((index) => index >= 0);
        expect(statusTaskIndexes.length).toBeGreaterThanOrEqual(2);
        const setupResultIndex = harness.events().indexOf('task:setup.thisComputer.v1:result');
        const firstPostSetupStatusIndex = harness.events().indexOf('daemon:status:read', harness.events().indexOf('setup:thisComputer:answered:approved'));
        expect(firstPostSetupStatusIndex).toBeGreaterThan(setupResultIndex);
        const recordedSpecs = harness.recordedSpecs();
        const lastStatusSpec = recordedSpecs[statusTaskIndexes.at(-1)!];
        // D3: readiness reads this Home's own pinned daemon, not the terminal's active server.
        expect(lastStatusSpec.params.relayUrl).toBe(harness.CANONICAL_SERVER_URL);
        const readback = harness.resultForTask(lastStatusSpec.taskId);
        expect(readback).toMatchObject({
            serviceInstalled: true,
            daemonRunning: true,
            needsAuth: false,
            machineId: 'machine-home-b',
            daemonServerUrl: harness.CANONICAL_SERVER_URL,
            daemonComparableKey: harness.CANONICAL_SERVER_URL,
            daemonAccountId: 'acct_home_b',
            daemonMachineRegistered: true,
        });
        // The account identity comparison crossed the explicit endpoint with Home B's token.
        expect(harness.endpointRequests().some((request) => request.path.startsWith('/v1/account/profile'))).toBe(true);

        // 11. No bearer or pairing secret ever enters task artifacts; credentials stay token-only.
        const serializedSpecs = JSON.stringify(harness.recordedSpecs());
        expect(serializedSpecs).not.toContain(harness.HOME_B_TOKEN);
        expect(serializedSpecs.toLowerCase()).not.toMatch(/"(token|secret|pairingsecret|claimsecret|statefile)"/);
        expect(JSON.stringify(harness.recordedPromptAnswers())).not.toContain(harness.HOME_B_TOKEN);

        // 12. Idempotent: rerunning prepare-computer with a correct ready daemon starts no second
        //     setup task and no second pairing.
        const setupCountBefore = harness.recordedSpecs().filter((spec) => spec.kind === 'setup.thisComputer.v1').length;
        const rerunFacts = await runHookOperation(() => hook.getCurrent().readFacts());
        await runHookOperation(() => hook.getCurrent().operations['prepare-computer']!(rerunFacts));
        await flushHookEffects({ cycles: 10, turns: 4 });
        const setupCountAfter = harness.recordedSpecs().filter((spec) => spec.kind === 'setup.thisComputer.v1').length;
        expect(setupCountAfter).toBe(setupCountBefore);
        expect(harness.recordedPromptAnswers()).toHaveLength(1);

        // 13. The unrelated focused Home A remains focused and untouched after daemon setup.
        expect(profiles.getServerProfileById(focusedHome.id)).toEqual(homeABefore);
        expect(profiles.getActiveServerSnapshot().serverId).toBe(focusedHome.id);

        // 14. Post-operation readFacts observes the fresh daemon facts through the daemon-control
        //     owner: the correct post-task status yields daemonReady and a ready snapshot while
        //     the shell stays released.
        const factsAfterComputer = await runHookOperation(() => hook.getCurrent().readFacts());
        expect(factsAfterComputer.daemon).toMatchObject({
            serviceInstalled: true,
            daemonRunning: true,
            needsAuth: false,
            machineId: 'machine-home-b',
            daemonServerUrl: harness.CANONICAL_SERVER_URL,
            daemonAccountId: 'acct_home_b',
            daemonMachineRegistered: true,
            servesPersonalHome: true,
        });
        const { derivePersonalHomeBootstrapSnapshot } = await import('./derivePersonalHomeBootstrapSnapshot');
        expect(derivePersonalHomeBootstrapSnapshot(factsAfterComputer)).toMatchObject({
            shouldGateShell: false,
            homeReady: true,
            daemonReady: true,
            phase: 'ready',
        });

        await hook.unmount();
    });

    it('rejects a daemon that is connected to another Home instead of accepting it for the Personal Home', async () => {
        const profiles = await import('@/sync/domains/server/serverProfiles');
        const focusedHome = await profiles.upsertServerProfile({
            serverUrl: 'https://home-a.example',
            name: 'Focused Home A',
            source: 'manual',
        });
        await profiles.setActiveServerId(focusedHome.id);

        const { usePersonalHomeBootstrapRuntime } = await import('./usePersonalHomeBootstrapRuntime');
        const hook = await renderHook(() => usePersonalHomeBootstrapRuntime());
        harness.markBootstrapStarted();
        await runHookOperation(() => hook.getCurrent().operations['ensure-home-ready']!(initialFacts));

        // The managed daemon reports Home A as its connected Home BEFORE the production facts
        // read: the derivation must never classify it as daemonReady for this Personal Home.
        harness.setDaemonStatusOverride({
            serviceInstalled: true,
            daemonRunning: true,
            needsAuth: false,
            machineId: 'machine-home-a',
            daemonServerUrl: 'https://home-a.example',
            daemonComparableKey: 'https://home-a.example',
            daemonAccountId: 'acct_home_a',
            daemonMachineRegistered: true,
        });
        const facts = await runHookOperation(() => hook.getCurrent().readFacts());
        const { derivePersonalHomeBootstrapSnapshot } = await import('./derivePersonalHomeBootstrapSnapshot');
        expect(derivePersonalHomeBootstrapSnapshot(facts).daemonReady).toBe(false);
        harness.markBootstrapStarted();
        const prepareRejection = expect(runHookOperation(
            () => hook.getCurrent().operations['prepare-computer']!(facts),
        )).rejects.toThrow(
            /different Home|wrong Home|home-a\.example|connected/i,
        );
        await prepareRejection;

        // No Home B adoption of the wrong daemon: the recorded approval answer and setup result
        // are preserved as facts for diagnosis, but the operation failed closed.
        expect(harness.recordedPromptAnswers()).toEqual([
            expect.objectContaining({ answer: { approved: true } }),
        ]);

        // Home readiness is untouched by the daemon failure: the shell stays usable and the
        // operation remains retryable, while the daemon still reads as not-ready-for-this-Home.
        const factsAfterFailure = await runHookOperation(() => hook.getCurrent().readFacts());
        expect(factsAfterFailure.relayRuntime).toMatchObject({ installed: true, healthy: true, status: 'healthy' });
        expect(factsAfterFailure.localHomeAuth).toBe('present');
        expect(factsAfterFailure.anonymousSignup).toBe('disabled');
        expect(factsAfterFailure.daemon).toMatchObject({
            daemonServerUrl: 'https://home-a.example',
            daemonRunning: true,
            servesPersonalHome: false,
        });
        expect(derivePersonalHomeBootstrapSnapshot(factsAfterFailure).daemonReady).toBe(false);
        await hook.unmount();
    });

    // U7 + R10 D1: automatic preparation on launch never moves a daemon the user signed in to
    // another Home or account. It reports the shared, coded fact instead, and mutates nothing.
    it('never re-targets a daemon signed in elsewhere automatically; it reports the coded fact instead', async () => {
        const profiles = await import('@/sync/domains/server/serverProfiles');
        const focusedHome = await profiles.upsertServerProfile({
            serverUrl: 'https://home-a.example',
            name: 'Focused Home A',
            source: 'manual',
        });
        await profiles.setActiveServerId(focusedHome.id);

        const { usePersonalHomeBootstrapRuntime } = await import('./usePersonalHomeBootstrapRuntime');
        const hook = await renderHook(() => usePersonalHomeBootstrapRuntime());
        harness.markBootstrapStarted();
        await runHookOperation(() => hook.getCurrent().operations['ensure-home-ready']!(initialFacts));

        harness.setDaemonStatusOverride({
            serviceInstalled: true,
            daemonRunning: true,
            needsAuth: false,
            machineId: 'machine-home-a',
            daemonServerUrl: 'https://home-a.example',
            daemonComparableKey: 'https://home-a.example',
            daemonAccountId: 'acct_home_a',
            daemonMachineRegistered: true,
        });
        const facts = await runHookOperation(() => hook.getCurrent().readFacts());
        const setupCountBefore = harness.recordedSpecs().filter((spec) => spec.kind === 'setup.thisComputer.v1').length;
        modalConsent.confirm.mockClear();

        let failure: unknown = null;
        try {
            await runHookOperation(() => hook.getCurrent().operations['prepare-computer']!(facts, { trigger: 'automatic' }));
        } catch (error) {
            failure = error;
        }

        expect(failure).toMatchObject({
            code: 'daemon_url_mismatch',
            thisComputer: expect.objectContaining({
                status: 'daemon_url_mismatch',
                daemonHomeLabel: 'https://home-a.example',
            }),
        });
        expect(modalConsent.confirm).not.toHaveBeenCalled();
        expect(harness.recordedSpecs().filter((spec) => spec.kind === 'setup.thisComputer.v1')).toHaveLength(setupCountBefore);
        await hook.unmount();
    });

    // RV2-30: a status read that FAILED (here the CLI cannot tell which saved profile is this Home)
    // is not "no daemon yet": it is reported as blocked, and never starts an automatic setup run.
    it('reports a failed daemon status read as blocked and never starts setup from it', async () => {
        const { usePersonalHomeBootstrapRuntime } = await import('./usePersonalHomeBootstrapRuntime');
        const hook = await renderHook(() => usePersonalHomeBootstrapRuntime());
        harness.markBootstrapStarted();
        await runHookOperation(() => hook.getCurrent().operations['ensure-home-ready']!(initialFacts));

        harness.setDaemonStatusFailure({ code: 'server_profile_ambiguous', message: 'The Happier CLI has 2 saved profiles for this Home.' });
        const facts = await runHookOperation(() => hook.getCurrent().readFacts());
        expect(facts.daemon).toMatchObject({ error: 'The Happier CLI has 2 saved profiles for this Home.' });

        const setupCountBefore = harness.recordedSpecs().filter((spec) => spec.kind === 'setup.thisComputer.v1').length;
        let failure: unknown = null;
        try {
            await runHookOperation(() => hook.getCurrent().operations['prepare-computer']!(facts, { trigger: 'automatic' }));
        } catch (error) {
            failure = error;
        }
        expect(failure).toMatchObject({ code: 'server_profile_ambiguous' });
        expect(harness.recordedSpecs().filter((spec) => spec.kind === 'setup.thisComputer.v1')).toHaveLength(setupCountBefore);
        await hook.unmount();
    });

    // R12: a status read that failed because nobody chose who manages this computer's `happier`
    // yet is not a blocking fact: setup's first step asks exactly that, so preparation starts it.
    it('routes a status read that needs the one-CLI answer into setup, whose first step asks it', async () => {
        const { usePersonalHomeBootstrapRuntime } = await import('./usePersonalHomeBootstrapRuntime');
        const hook = await renderHook(() => usePersonalHomeBootstrapRuntime());
        harness.markBootstrapStarted();
        await runHookOperation(() => hook.getCurrent().operations['ensure-home-ready']!(initialFacts));

        harness.setDaemonStatusFailure({
            code: 'cli_choice_required',
            message: 'Choose who manages the Happier CLI at /usr/local/bin/happier before setup continues.',
        });
        const facts = await runHookOperation(() => hook.getCurrent().readFacts());
        expect(facts.daemon?.error).toBeUndefined();
        const { derivePersonalHomeBootstrapSnapshot } = await import('./derivePersonalHomeBootstrapSnapshot');
        expect(derivePersonalHomeBootstrapSnapshot(facts).daemonState).not.toBe('blocked');

        const setupCountBefore = harness.recordedSpecs().filter((spec) => spec.kind === 'setup.thisComputer.v1').length;
        await runHookOperation(() => hook.getCurrent().operations['prepare-computer']!(facts, { trigger: 'automatic' })).catch(() => {});
        expect(harness.recordedSpecs().filter((spec) => spec.kind === 'setup.thisComputer.v1').length).toBe(setupCountBefore + 1);
        await hook.unmount();
    });

    it('keeps a partly applied CLI switch recoverable: the failure keeps its code, and Retry re-converges instead of reading ready', async () => {
        const { usePersonalHomeBootstrapRuntime } = await import('./usePersonalHomeBootstrapRuntime');
        const hook = await renderHook(() => usePersonalHomeBootstrapRuntime());
        harness.markBootstrapStarted();
        await runHookOperation(() => hook.getCurrent().operations['ensure-home-ready']!(initialFacts));

        // The answer is recorded and this Home's service switched, but another service did not follow.
        const convergenceFailure = {
            code: 'cli_choice_service_convergence_failed',
            message: "This computer's background services could not all be moved to the chosen Happier CLI: happier-daemon.default (systemctl failed)",
        };
        harness.setSetupFailureAfterApproval(convergenceFailure);
        const facts = await runHookOperation(() => hook.getCurrent().readFacts());
        let failure: unknown = null;
        try {
            await runHookOperation(() => hook.getCurrent().operations['prepare-computer']!(facts, { trigger: 'automatic' }));
        } catch (error) {
            failure = error;
        }
        // The typed task error survives into recovery, not just its text.
        expect(failure).toMatchObject({ code: 'cli_choice_service_convergence_failed' });

        // Retry: this Home's daemon now reads ready, yet the retry reruns the convergence with the
        // recorded choice instead of taking the readiness fast path.
        harness.setSetupFailureAfterApproval(null);
        const retryFacts = await runHookOperation(() => hook.getCurrent().readFacts());
        const setupCountBefore = harness.recordedSpecs().filter((spec) => spec.kind === 'setup.thisComputer.v1').length;
        await runHookOperation(() => hook.getCurrent().operations['prepare-computer']!(retryFacts, {
            trigger: 'retry',
            previousErrorCode: 'cli_choice_service_convergence_failed',
        }));
        const setupSpecs = harness.recordedSpecs().filter((spec) => spec.kind === 'setup.thisComputer.v1');
        expect(setupSpecs).toHaveLength(setupCountBefore + 1);
        expect(setupSpecs.at(-1)?.params).toMatchObject({ convergeCliChoice: true });

        // An ordinary retry of a ready daemon still takes the fast path.
        await runHookOperation(() => hook.getCurrent().operations['prepare-computer']!(retryFacts, { trigger: 'retry' }));
        expect(harness.recordedSpecs().filter((spec) => spec.kind === 'setup.thisComputer.v1')).toHaveLength(setupCountBefore + 1);
        await hook.unmount();
    });

    it('rejects an identity/URL conflict before persisting Personal Home credentials or changing focused Home state', async () => {
        const profiles = await import('@/sync/domains/server/serverProfiles');
        const focusedHome = await profiles.upsertServerProfile({
            serverUrl: 'https://focused-home.example',
            name: 'Focused Home A',
            source: 'manual',
        });
        await profiles.setServerProfileIdentityForUrl(focusedHome.serverUrl, harness.HOME_B_IDENTITY);
        const conflictingUrlProfile = await profiles.upsertServerProfile({
            serverUrl: harness.CANONICAL_SERVER_URL,
            name: 'Existing Home at Personal URL',
            source: 'manual',
        });
        await profiles.setServerProfileIdentityForUrl(conflictingUrlProfile.serverUrl, 'srv_conflicting_home_identity');
        await profiles.setActiveServerId(focusedHome.id);
        await profiles.saveHomeViewState({
            version: 1,
            groups: [{
                id: 'focused-group',
                name: 'Focused group',
                serverIds: [focusedHome.id],
            }],
            activeTargetKind: 'server',
            activeTargetId: focusedHome.id,
        });
        const focusedBefore = profiles.getActiveServerSnapshot();
        const homeViewBefore = profiles.loadHomeViewState();

        const { usePersonalHomeBootstrapRuntime } = await import('./usePersonalHomeBootstrapRuntime');
        const hook = await renderHook(() => usePersonalHomeBootstrapRuntime());
        harness.markBootstrapStarted();

        await expect(runHookOperation(
            () => hook.getCurrent().operations['ensure-home-ready']!(initialFacts),
        )).rejects.toThrow(
            'Home identity conflicts with URL',
        );
        await hook.unmount();

        expect(harness.persistCalls()).toHaveLength(0);
        expect(harness.persistedCredentials()).toBeNull();
        expect(profiles.listServerProfiles().filter((profile) => profile.source === 'desktop-personal-home')).toHaveLength(0);
        expect(profiles.getActiveServerSnapshot()).toEqual(focusedBefore);
        expect(profiles.loadHomeViewState()).toEqual(homeViewBefore);
    });

    it('resumes after a real remount with retained data by using the exact committed-account seed once', async () => {
        const { usePersonalHomeBootstrapRuntime } = await import('./usePersonalHomeBootstrapRuntime');
        let hook = await renderHook(() => usePersonalHomeBootstrapRuntime());

        // First attempt: the server commits the Account, then the process fails before the
        // token is persisted. No credential and no adoption receipt may survive.
        harness.markBootstrapStarted();
        harness.setFailCreateAfterCommit(true);
        await expect(runHookOperation(
            () => hook.getCurrent().operations['ensure-home-ready']!(initialFacts),
        )).rejects.toThrow(
            /committed the Account/i,
        );
        await flushHookEffects({ cycles: 8 });

        const accountCallsAfterCrash = harness.endpointAuthCalls().length;
        expect(accountCallsAfterCrash).toBe(1);
        expect(harness.serverAccounts().size).toBe(1);
        expect(harness.persistCalls()).toHaveLength(0);
        expect(harness.persistedCredentials()).toBeNull();
        // The pending seed stayed in Home custody across the crash: retry custody for this Home.
        expect(harness.pendingSeeds()).toHaveLength(2);
        expect(harness.pendingSeeds().every(({ seed }) => seed.length === 32)).toBe(true);
        expect([...harness.pendingSeeds()[0]!.seed]).toEqual([...harness.pendingSeeds()[1]!.seed]);
        const seedAfterCrash = new Uint8Array(harness.pendingSeeds()[0]!.seed);
        await hook.unmount();

        // A true renderer remount now observes retained Home data and no token. The exact pending
        // seed is the only account-creation resume authority; no replacement seed is permitted.
        harness.setFailCreateAfterCommit(false);
        hook = await renderHook(() => usePersonalHomeBootstrapRuntime());
        harness.markBootstrapStarted();
        await runHookOperation(() => hook.getCurrent().operations['ensure-home-ready']!(initialFacts));
        await flushHookEffects({ cycles: 8 });

        const accountCalls = harness.endpointAuthCalls();
        // Create, retry-create, and the post-closure refusal probe (which never commits).
        expect(accountCalls).toHaveLength(3);
        expect(harness.serverAccounts().size).toBe(1);
        expect(harness.events().filter((entry) => entry === 'auth:endpoint-token:signup-open')).toHaveLength(1);
        // The retried account-creating call carried byte-identical seed bytes.
        expect(accountCalls[0]!.secretBase64Url).toBe(accountCalls[1]!.secretBase64Url);
        const retrySeedBase64Url = accountCalls[1]!.secretBase64Url;
        expect(retrySeedBase64Url).not.toBeNull();
        if (!retrySeedBase64Url) throw new Error('Expected the retry to reuse the pending bootstrap seed.');
        const retrySeedBytes = Uint8Array.from(
            atob(retrySeedBase64Url.replace(/-/g, '+').replace(/_/g, '/')),
            (character) => character.charCodeAt(0),
        );
        expect([...retrySeedBytes]).toEqual([...seedAfterCrash]);
        expect(harness.persistCalls()).toHaveLength(1);
        expect(harness.persistedCredentials()).toEqual({ token: harness.HOME_B_TOKEN });
        // Final credentials persisted and authenticated: pending custody was released.
        expect(harness.pendingSeeds()).toEqual([]);
        const profiles = await import('@/sync/domains/server/serverProfiles');
        expect(profiles.listServerProfiles().filter((profile) => profile.source === 'desktop-personal-home')).toHaveLength(1);

        // The bootstrap seed never enters task artifacts or events.
        const serializedArtifacts = JSON.stringify({
            specs: harness.recordedSpecs(),
            events: harness.events(),
            answers: harness.recordedPromptAnswers(),
        });
        for (const call of accountCalls) {
            expect(serializedArtifacts).not.toContain(call.secretBase64Url);
        }
        await hook.unmount();
    });

    it('creates zero accounts and zero account-creating network calls when seed custody write fails', async () => {
        const { usePersonalHomeBootstrapRuntime } = await import('./usePersonalHomeBootstrapRuntime');
        const hook = await renderHook(() => usePersonalHomeBootstrapRuntime());

        harness.markBootstrapStarted();
        harness.setPendingSeedWriteFailure(true);
        await expect(runHookOperation(
            () => hook.getCurrent().operations['ensure-home-ready']!(initialFacts),
        )).rejects.toThrow(
            /seed custody is unavailable/i,
        );

        expect(harness.endpointAuthCalls()).toEqual([]);
        expect(harness.serverAccounts().size).toBe(0);
        expect(harness.pendingSeeds()).toEqual([]);
        expect(harness.persistCalls()).toHaveLength(0);
        await hook.unmount();
    });

    it('creates zero accounts and zero account-creating network calls when the persisted seed readback cannot be verified', async () => {
        const { usePersonalHomeBootstrapRuntime } = await import('./usePersonalHomeBootstrapRuntime');
        const hook = await renderHook(() => usePersonalHomeBootstrapRuntime());

        harness.markBootstrapStarted();
        harness.setPendingSeedReadbackFailure(true);
        await expect(runHookOperation(
            () => hook.getCurrent().operations['ensure-home-ready']!(initialFacts),
        )).rejects.toThrow(
            /seed could not be verified/i,
        );

        expect(harness.endpointAuthCalls()).toEqual([]);
        expect(harness.serverAccounts().size).toBe(0);
        expect(harness.persistCalls()).toHaveLength(0);
        await hook.unmount();
    });

    it('keeps pending custody through a failure after token persistence, then a retry verifies the credential and clears the seed without account creation', async () => {
        const { usePersonalHomeBootstrapRuntime } = await import('./usePersonalHomeBootstrapRuntime');
        const hook = await renderHook(() => usePersonalHomeBootstrapRuntime());

        // First attempt completes account creation and persistence, then fails after the
        // restart at the authenticated readback (simulated crash between persist and clear).
        harness.markBootstrapStarted();
        harness.probes.setNextAuthPingFailure(1);
        await expect(runHookOperation(
            () => hook.getCurrent().operations['ensure-home-ready']!(initialFacts),
        )).rejects.toThrow();
        await flushHookEffects({ cycles: 8 });

        expect(harness.serverAccounts().size).toBe(1);
        expect(harness.persistCalls()).toHaveLength(1);
        expect(harness.persistedCredentials()).toEqual({ token: harness.HOME_B_TOKEN });
        expect(harness.pendingSeeds()).toHaveLength(2);
        expect([...harness.pendingSeeds()[0]!.seed]).toEqual([...harness.pendingSeeds()[1]!.seed]);

        // Retry: the persisted credential is read, verified, and the pending seed is cleared
        // without any second account creation.
        harness.probes.setNextAuthPingFailure(0);
        harness.markBootstrapStarted();
        await runHookOperation(() => hook.getCurrent().operations['ensure-home-ready']!(initialFacts));
        await flushHookEffects({ cycles: 8 });

        expect(harness.serverAccounts().size).toBe(1);
        expect(harness.endpointAuthCalls().length).toBeGreaterThanOrEqual(2);
        expect(harness.events().filter((entry) => entry === 'auth:endpoint-token:signup-open')).toHaveLength(1);
        expect(harness.pendingSeeds()).toEqual([]);
        expect(harness.persistCalls()).toHaveLength(1);
        const profiles = await import('@/sync/domains/server/serverProfiles');
        expect(profiles.listServerProfiles().filter((profile) => profile.source === 'desktop-personal-home')).toHaveLength(1);
        await hook.unmount();
    });

    it('adopts the /v1/features Home descriptor through the real profile owner, and omits an identity-mismatched one', async () => {
        const { usePersonalHomeBootstrapRuntime } = await import('./usePersonalHomeBootstrapRuntime');

        // Composed positive path: the descriptor published at /v1/features survives the real
        // probe/parser, passes the identity check against the independently observed Home
        // identity, and reaches the canonical adoption as the exact canonical descriptor.
        harness.probes.setPublishedHomeConnectionDescriptor({
            v: 1,
            homeServerIdentityId: harness.HOME_B_IDENTITY,
            canonicalServerUrl: harness.CANONICAL_SERVER_URL,
            revision: 5,
            endpoints: [
                { kind: 'iroh', endpointId: 'a'.repeat(64), relayUrls: ['https://relay.example.test'] },
            ],
        });
        const hook = await renderHook(() => usePersonalHomeBootstrapRuntime());
        harness.markBootstrapStarted();
        await runHookOperation(() => hook.getCurrent().operations['ensure-home-ready']!(initialFacts));
        await flushHookEffects({ cycles: 8 });

        const profiles = await import('@/sync/domains/server/serverProfiles');
        const adopted = profiles.listServerProfiles().filter((profile) => profile.source === 'desktop-personal-home');
        expect(adopted).toHaveLength(1);
        expect(adopted[0]).toMatchObject({
            serverUrl: harness.CANONICAL_SERVER_URL,
            canonicalServerUrl: harness.CANONICAL_SERVER_URL,
            serverIdentityId: harness.HOME_B_IDENTITY,
            // The persisted transport identity rides on the profile through adoption.
            homeConnectionDescriptor: {
                revision: 5,
                endpoints: [{
                    kind: 'iroh',
                    endpointId: 'a'.repeat(64),
                    relayUrls: ['https://relay.example.test'],
                }],
            },
        });
        await hook.unmount();

        // Fail-closed negative path on a fresh registry: a descriptor whose homeServerIdentityId
        // disagrees with the independently observed server identity cannot complete adoption.
        for (const profile of profiles.listServerProfiles()) await profiles.removeServerProfile(profile.id);
        harness.probes.setPublishedHomeConnectionDescriptor({
            v: 1,
            homeServerIdentityId: 'srv_other_home_identity',
            canonicalServerUrl: harness.CANONICAL_SERVER_URL,
            revision: 6,
            endpoints: [
                { kind: 'iroh', endpointId: 'b'.repeat(64) },
            ],
        });
        harness.markBootstrapStarted();
        const secondHook = await renderHook(() => usePersonalHomeBootstrapRuntime());
        await expect(runHookOperation(
            () => secondHook.getCurrent().operations['ensure-home-ready']!(initialFacts),
        )).rejects.toMatchObject({ code: 'personal_home_descriptor_unverified' });

        const adoptedAfterMismatch = profiles.listServerProfiles().filter((profile) => profile.source === 'desktop-personal-home');
        expect(adoptedAfterMismatch).toHaveLength(0);
        await secondHook.unmount();
    });
});
