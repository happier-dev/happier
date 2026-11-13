import { projectActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PluginSourceCustodyV1 } from '@happier-dev/protocol';

import {
    createDaemonManagedServiceEndpointReadOwner,
} from './daemonManagedServiceEndpointReadOwner';
import {
    createManagedServiceEndpointProjectionV1,
    type ManagedServiceEndpointProjectionResolveQuery,
} from './managedServiceEndpointProjection';
import {
    MANAGED_SERVICE_ENDPOINT_READ_RPC_METHODS,
    ManagedServiceEndpointReadCancelRequestV1Schema,
    ManagedServiceEndpointReadOpenRequestV1Schema,
} from '@/agent/runtime/session/process/managedServiceEndpointReadProtocol';

const pluginId = 'happier.agent.opencode';
const contributionId = `${pluginId}/agents/opencode`;
const immutableGenerationId = 'immutable-opencode-occurrenceId';
const sourceCustody = Object.freeze({
    kind: 'managed' as const,
    immutableGenerationId,
    installSource: 'localPath' as const,
});
function endpointProjection(
    custody: PluginSourceCustodyV1 = sourceCustody,
) {
    return createManagedServiceEndpointProjectionV1({
        sessionId: 'session-one',
        pluginId,
        contributionId,
        serverId: 'opencode-server',
        instanceId: 'opencode-instance',
        sourceCustody: custody,
        custodyOwner: 'sessionRunner',
        mode: 'managedSpawn',
        endpoint: {
            baseUrl: 'http://127.0.0.1:4312',
            host: '127.0.0.1',
            port: 4312,
        },
        process: {
            pid: 42,
            startIdentity: 'runner-start-42',
        },
        createdAtMs: 1_000,
    });
}

function replacementEndpointProjection() {
    return createManagedServiceEndpointProjectionV1({
        sessionId: 'session-two',
        pluginId,
        contributionId,
        serverId: 'opencode-server',
        instanceId: 'opencode-instance-two',
        sourceCustody,
        custodyOwner: 'sessionRunner',
        mode: 'managedSpawn',
        endpoint: {
            baseUrl: 'http://127.0.0.1:4313',
            host: '127.0.0.1',
            port: 4313,
        },
        process: {
            pid: 43,
            startIdentity: 'runner-start-43',
        },
        createdAtMs: 2_000,
    });
}

const projection = endpointProjection();

const identity = Object.freeze({
    pluginId,
    agentId: 'opencode',
    occurrenceId: 'opencode-occurrence',
    contributionQualifiedId: contributionId,
    sourceCustody,
});
type BindHostInput = Parameters<
    ReturnType<
        typeof createDaemonManagedServiceEndpointReadOwner
    >['bindHost']
>[0];
type BindingOverride = Readonly<{
    identity?: BindHostInput['identity'];
    source?: BindHostInput['source'];
}>;
const invalidBindings: readonly (readonly [string, BindingOverride])[] = [
    ['wrong plugin', { identity: { ...identity, pluginId: 'other.plugin' } }],
    ['wrong contribution', {
        identity: {
            ...identity,
            contributionQualifiedId: `${pluginId}/agents/other`,
        },
    }],
    ['wrong source custody', {
        identity: {
            ...identity,
            sourceCustody: {
                ...sourceCustody,
                immutableGenerationId: 'other-occurrenceId',
            },
        },
    }],
    ['missing marker', { source: { kind: 'opencodeServer' } }],
    ['wrong marker', {
        source: { kind: 'opencodeServer', managedEndpoint: 'true' },
    }],
    ['explicit base URL', {
        source: {
            kind: 'opencodeServer',
            managedEndpoint: true,
            baseUrl: projection.endpoint.baseUrl,
        },
    }],
];

describe('daemon managed-service endpoint read owner', () => {
    it.each(['open', 'next', 'environment'] as const)('retains native endpoint %s failure at the daemon consumer', async (phase) => {
        let owner: ReturnType<typeof createDaemonManagedServiceEndpointReadOwner>;
        const failureCause = projectActionFailureCauseV1({ code: 'EIO' }, 'managed_service.endpoint_read');
        owner = createDaemonManagedServiceEndpointReadOwner({
            credentials: { token: 'test-token', encryption: null },
            resolveProjection: async () => projection,
            resolveRunnerEndpointReadRpc: async () => ({ sessionId: projection.sessionId,
                async call(input) {
                    const request = input.request as { requestId: string };
                    if (input.method === MANAGED_SERVICE_ENDPOINT_READ_RPC_METHODS.CANCEL)
                        return { v: 1, requestId: request.requestId, status: 'cancelled', cancelled: true };
                    if (input.method === MANAGED_SERVICE_ENDPOINT_READ_RPC_METHODS.OPEN) {
                        owner.claim({ requestId: request.requestId, projectionToken: projection.projectionToken,
                            sessionId: projection.sessionId, pluginId });
                        if (phase === 'next') return { v: 1, requestId: request.requestId, status: 'opened',
                            response: { status: 200, statusText: 'OK', headers: [], hasBody: true } };
                    }
                    return { v: 1, requestId: request.requestId, status: 'unavailable', failureCause };
                } }),
        });
        try {
            const result = await (async () => {
                if (phase === 'environment') return await owner.resolveSessionClientAccess({ pluginId,
                    sessionId: projection.sessionId, contributionId, targetBaseUrl: projection.endpoint.baseUrl,
                    environmentKey: 'OPENCODE_SERVER_PASSWORD' });
                const read = await owner.bindHost({ identity, source: { kind: 'opencodeServer', managedEndpoint: true }, signal: new AbortController().signal });
                const response = await read({ pathAndQuery: '/session' });
                if (phase === 'next') return await response.body!.getReader().read();
                return response;
            })().catch((error: unknown) => error);
            expect(projectActionFailureCauseV1(result)).toMatchObject({ errorCode: 'EIO' });
        } finally { await owner.dispose(); }
    });

    afterEach(() => vi.useRealTimers());
    it('lets concurrent endpoint reads wait under caller custody and cancels outstanding headers', async () => {
        vi.useFakeTimers();
        let owner: ReturnType<typeof createDaemonManagedServiceEndpointReadOwner>;
        const cancelled: string[] = [];
        owner = createDaemonManagedServiceEndpointReadOwner({
            credentials: { token: 'test-token', encryption: null },
            resolveProjection: async () => projection,
            resolveRunnerEndpointReadRpc: async () => ({
                sessionId: projection.sessionId,
                async call(rpcInput) {
                    const request = rpcInput.request as { requestId: string };
                    if (rpcInput.method === MANAGED_SERVICE_ENDPOINT_READ_RPC_METHODS.CANCEL) {
                        cancelled.push(request.requestId);
                        return { v: 1, requestId: request.requestId, status: 'cancelled', cancelled: true };
                    }
                    expect(owner.claim({ requestId: request.requestId,
                        projectionToken: projection.projectionToken, sessionId: projection.sessionId, pluginId })).toBe(true);
                    return await new Promise<unknown>((resolve, reject) => {
                        const timeout = rpcInput.timeoutMs === null ? undefined
                            : setTimeout(() => reject(new Error('RPC call timeout')), rpcInput.timeoutMs);
                        const response = setTimeout(() => {
                            clearTimeout(timeout);
                            resolve({ v: 1, requestId: request.requestId, status: 'opened',
                                response: { status: 204, statusText: 'No Content', headers: [], hasBody: false } });
                        }, 35_000);
                        const signal = (rpcInput as { signal?: AbortSignal }).signal;
                        const abort = () => {
                            clearTimeout(timeout);
                            clearTimeout(response);
                            reject(signal?.reason);
                        };
                        signal?.addEventListener('abort', abort, { once: true });
                        if (signal?.aborted) abort();
                    });
                },
            }),
        });
        const caller = new AbortController();
        try {
            const read = await owner.bindHost({ identity,
                source: { kind: 'opencodeServer', managedEndpoint: true }, signal: caller.signal });
            const pending = Promise.all(Array.from({ length: 129 }, () => read({ pathAndQuery: '/session' })
                .then(value => ({ status: value.status }), error => ({ error }))));
            await vi.advanceTimersByTimeAsync(35_000);
            expect(await pending).toEqual(Array.from({ length: 129 }, () => ({ status: 204 })));
            const interrupted = read({ pathAndQuery: '/session' }).then(() => null, error => error);
            await vi.advanceTimersByTimeAsync(1);
            caller.abort('caller cancelled');
            expect(await interrupted).toBe('caller cancelled');
            expect(cancelled).toHaveLength(130);
        } finally {
            await owner.dispose();
            vi.useRealTimers();
        }
    });

    it('materializes only the exact requested client credential environment key', async () => {
        let returnedEnvironment: Record<string, string> = {
            OPENCODE_SERVER_PASSWORD: 'exact-password',
        };
        let owner: ReturnType<
            typeof createDaemonManagedServiceEndpointReadOwner
        >;
        const runnerCall = vi.fn(async (rpcInput: Readonly<{
            method: string;
            request: unknown;
        }>) => {
            expect(rpcInput.method).toBe(
                MANAGED_SERVICE_ENDPOINT_READ_RPC_METHODS.OPEN,
            );
            const request = ManagedServiceEndpointReadOpenRequestV1Schema
                .parse(rpcInput.request);
            expect(request.route).toMatchObject({
                kind: 'endpointClientEnvironment',
                environmentKey: 'OPENCODE_SERVER_PASSWORD',
            });
            expect(owner.claim({
                requestId: request.requestId,
                projectionToken: projection.projectionToken,
                sessionId: projection.sessionId,
                pluginId,
            })).toBe(true);
            return {
                v: 1 as const,
                requestId: request.requestId,
                status: 'clientEnvironment' as const,
                environment: returnedEnvironment,
            };
        });
        owner = createDaemonManagedServiceEndpointReadOwner({
            credentials: { token: 'test-token', encryption: null },
            resolveProjection: async (query) => (
                query.pluginId === pluginId
                && query.sessionId === projection.sessionId
                && query.contributionId === contributionId
                && query.selector.kind === 'baseUrl'
                && query.selector.baseUrl === projection.endpoint.baseUrl
                    ? projection
                    : null
            ),
            resolveRunnerEndpointReadRpc: async () => ({
                sessionId: projection.sessionId,
                call: runnerCall,
            }),
        });

        const access = await owner.resolveSessionClientAccess({
            pluginId,
            sessionId: projection.sessionId,
            contributionId,
            targetBaseUrl: projection.endpoint.baseUrl,
            environmentKey: 'OPENCODE_SERVER_PASSWORD',
        });
        expect(access?.childEnvironment).toEqual({
            OPENCODE_SERVER_PASSWORD: 'exact-password',
        });

        returnedEnvironment = { PATH: 'wrong-destination' };
        await expect(owner.resolveSessionClientAccess({
            pluginId,
            sessionId: projection.sessionId,
            contributionId,
            targetBaseUrl: projection.endpoint.baseUrl,
            environmentKey: 'OPENCODE_SERVER_PASSWORD',
        })).resolves.toBeNull();
        await owner.dispose();
    });

    it('binds one exact marked current contribution for the bounded operation', async () => {
        const queries: ManagedServiceEndpointProjectionResolveQuery[] = [];
        const resolveProjection = vi.fn(async (
            query: ManagedServiceEndpointProjectionResolveQuery,
        ) => {
            queries.push(query);
            if (query.selector.kind === 'projectionToken') {
                return query.selector.projectionToken
                    === projection.projectionToken
                    && query.sessionId === projection.sessionId
                    ? projection
                    : null;
            }
            if (
                query.pluginId !== pluginId
                || query.contributionId !== contributionId
                || query.sourceCustody !== sourceCustody
            ) return null;
            if (query.selector.kind === 'currentContribution') return projection;
            return null;
        });
        const owner = createDaemonManagedServiceEndpointReadOwner({
            credentials: { token: 'test-token', encryption: null },
            resolveProjection,
            resolveRunnerEndpointReadRpc: async () => null,
        });

        const read = await owner.bindHost({
            identity,
            source: { kind: 'opencodeServer', managedEndpoint: true },
            signal: new AbortController().signal,
        });

        expect(read).toEqual(expect.any(Function));
        expect(queries).toEqual([{
            pluginId,
            contributionId,
            sourceCustody,
            selector: { kind: 'currentContribution' },
        }]);

        await expect(read({ pathAndQuery: '/global/event' }))
            .rejects.toThrow('Managed server endpoint runner transport is unavailable');
        expect(queries).toEqual(Array.from({ length: 2 }, () => ({
            pluginId,
            contributionId,
            sourceCustody,
            selector: { kind: 'currentContribution' },
        })));
        await owner.dispose();
    });

    it('re-resolves current-global for every read and never dispatches a replaced predecessor', async () => {
        let currentProjection: ReturnType<typeof endpointProjection> | null =
            projection;
        const queries: ManagedServiceEndpointProjectionResolveQuery[] = [];
        const resolveProjection = vi.fn(async (
            query: ManagedServiceEndpointProjectionResolveQuery,
        ) => {
            queries.push(query);
            if (query.selector.kind === 'currentContribution') {
                return currentProjection;
            }
            return null;
        });
        let owner: ReturnType<
            typeof createDaemonManagedServiceEndpointReadOwner
        >;
        const openedProjectionTokens: string[] = [];
        const runnerCall = vi.fn(async (rpcInput: Readonly<{
            method: string;
            request: unknown;
            timeoutMs: number | null;
        }>) => {
            if (
                rpcInput.method
                === MANAGED_SERVICE_ENDPOINT_READ_RPC_METHODS.OPEN
            ) {
                const request =
                    ManagedServiceEndpointReadOpenRequestV1Schema.parse(
                        rpcInput.request,
                    );
                expect(request.route.kind).toBe('endpointProjection');
                if (request.route.kind !== 'endpointProjection') {
                    throw new Error('Expected endpoint-projection read route');
                }
                const current = request.route.projection;
                openedProjectionTokens.push(current.projectionToken);
                expect(owner.claim({
                    requestId: request.requestId,
                    projectionToken: current.projectionToken,
                    sessionId: current.sessionId,
                    pluginId,
                })).toBe(true);
                return {
                    v: 1 as const,
                    requestId: request.requestId,
                    status: 'opened' as const,
                    response: {
                        status: 204,
                        statusText: 'No Content',
                        headers: [],
                        hasBody: false,
                    },
                };
            }
            if (
                rpcInput.method
                === MANAGED_SERVICE_ENDPOINT_READ_RPC_METHODS.CANCEL
            ) {
                const request =
                    ManagedServiceEndpointReadCancelRequestV1Schema.parse(
                        rpcInput.request,
                    );
                return {
                    v: 1 as const,
                    requestId: request.requestId,
                    status: 'cancelled' as const,
                    cancelled: true,
                };
            }
            throw new Error(`Unexpected runner RPC method: ${rpcInput.method}`);
        });
        const resolveRunnerEndpointReadRpc = vi.fn(async (sessionId: string) => ({
            sessionId,
            call: runnerCall,
        }));
        owner = createDaemonManagedServiceEndpointReadOwner({
            credentials: { token: 'test-token', encryption: null },
            resolveProjection,
            resolveRunnerEndpointReadRpc,
        });

        const read = await owner.bindHost({
            identity,
            source: { kind: 'opencodeServer', managedEndpoint: true },
            signal: new AbortController().signal,
        });

        await expect(read({ pathAndQuery: '/global/event' }))
            .resolves.toMatchObject({ ok: true, status: 204 });
        expect(resolveRunnerEndpointReadRpc).toHaveBeenCalledWith(
            projection.sessionId,
        );
        expect(openedProjectionTokens).toEqual([projection.projectionToken]);

        currentProjection = null;
        await expect(read({ pathAndQuery: '/global/event' }))
            .rejects.toThrow('Managed server endpoint read owner is unavailable');
        expect(resolveRunnerEndpointReadRpc).toHaveBeenCalledOnce();
        expect(runnerCall).toHaveBeenCalledTimes(2);

        currentProjection = endpointProjection({
            ...sourceCustody,
            immutableGenerationId: 'mismatched-occurrenceId',
        });
        await expect(read({ pathAndQuery: '/global/event' }))
            .rejects.toThrow('Managed server endpoint read owner is unavailable');
        expect(resolveRunnerEndpointReadRpc).toHaveBeenCalledOnce();
        expect(runnerCall).toHaveBeenCalledTimes(2);

        const successor = replacementEndpointProjection();
        currentProjection = successor;
        await expect(read({ pathAndQuery: '/global/event' }))
            .resolves.toMatchObject({ ok: true, status: 204 });
        expect(resolveRunnerEndpointReadRpc).toHaveBeenCalledTimes(2);
        expect(resolveRunnerEndpointReadRpc).toHaveBeenLastCalledWith(
            successor.sessionId,
        );
        expect(runnerCall).toHaveBeenCalledTimes(4);
        expect(openedProjectionTokens).toEqual([
            projection.projectionToken,
            successor.projectionToken,
        ]);
        expect(queries).toEqual(Array.from({ length: 7 }, () => ({
            pluginId,
            contributionId,
            sourceCustody,
            selector: { kind: 'currentContribution' },
        })));
        await owner.dispose();
    });

    it('does not open a captured projection when current-global changes while its runner transport resolves', async () => {
        let currentProjection: ReturnType<typeof endpointProjection> | null =
            projection;
        const queries: ManagedServiceEndpointProjectionResolveQuery[] = [];
        const resolveProjection = vi.fn(async (
            query: ManagedServiceEndpointProjectionResolveQuery,
        ) => {
            queries.push(query);
            return query.selector.kind === 'currentContribution'
                ? currentProjection
                : null;
        });
        let releaseTransport!: () => void;
        let markTransportStarted!: () => void;
        const transportReleased = new Promise<void>((resolve) => {
            releaseTransport = resolve;
        });
        const transportStarted = new Promise<void>((resolve) => {
            markTransportStarted = resolve;
        });
        let owner: ReturnType<
            typeof createDaemonManagedServiceEndpointReadOwner
        >;
        const runnerCall = vi.fn(async (rpcInput: Readonly<{
            method: string;
            request: unknown;
            timeoutMs: number | null;
        }>) => {
            if (
                rpcInput.method
                === MANAGED_SERVICE_ENDPOINT_READ_RPC_METHODS.OPEN
            ) {
                const request =
                    ManagedServiceEndpointReadOpenRequestV1Schema.parse(
                        rpcInput.request,
                    );
                expect(request.route.kind).toBe('endpointProjection');
                if (request.route.kind !== 'endpointProjection') {
                    throw new Error('Expected endpoint-projection read route');
                }
                expect(owner.claim({
                    requestId: request.requestId,
                    projectionToken: request.route.projection.projectionToken,
                    sessionId: request.route.projection.sessionId,
                    pluginId,
                })).toBe(true);
                return {
                    v: 1 as const,
                    requestId: request.requestId,
                    status: 'opened' as const,
                    response: {
                        status: 204,
                        statusText: 'No Content',
                        headers: [],
                        hasBody: false,
                    },
                };
            }
            if (
                rpcInput.method
                === MANAGED_SERVICE_ENDPOINT_READ_RPC_METHODS.CANCEL
            ) {
                const request =
                    ManagedServiceEndpointReadCancelRequestV1Schema.parse(
                        rpcInput.request,
                    );
                return {
                    v: 1 as const,
                    requestId: request.requestId,
                    status: 'cancelled' as const,
                    cancelled: true,
                };
            }
            throw new Error(`Unexpected runner RPC method: ${rpcInput.method}`);
        });
        const resolveRunnerEndpointReadRpc = vi.fn(async (sessionId: string) => {
            markTransportStarted();
            await transportReleased;
            return { sessionId, call: runnerCall };
        });
        owner = createDaemonManagedServiceEndpointReadOwner({
            credentials: { token: 'test-token', encryption: null },
            resolveProjection,
            resolveRunnerEndpointReadRpc,
        });

        const read = await owner.bindHost({
            identity,
            source: { kind: 'opencodeServer', managedEndpoint: true },
            signal: new AbortController().signal,
        });
        const inFlight = read({ pathAndQuery: '/global/event' });
        await transportStarted;
        const successor = replacementEndpointProjection();
        currentProjection = successor;
        releaseTransport();

        await expect(inFlight)
            .rejects.toThrow('Managed server endpoint read owner is unavailable');
        expect(resolveRunnerEndpointReadRpc).toHaveBeenCalledOnce();
        expect(resolveRunnerEndpointReadRpc).toHaveBeenCalledWith(
            projection.sessionId,
        );
        expect(runnerCall).not.toHaveBeenCalled();
        expect(queries).toEqual(Array.from({ length: 3 }, () => ({
            pluginId,
            contributionId,
            sourceCustody,
            selector: { kind: 'currentContribution' },
        })));
        await owner.dispose();
    });

    it('joins remote cleanup and rejects when disposed while OPEN is settling', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
        let releaseOpen!: () => void;
        let releaseCancel!: () => void;
        let markOpenStarted!: () => void;
        let markCancelStarted!: () => void;
        const openReleased = new Promise<void>((resolve) => {
            releaseOpen = resolve;
        });
        const cancelReleased = new Promise<void>((resolve) => {
            releaseCancel = resolve;
        });
        const openStarted = new Promise<void>((resolve) => {
            markOpenStarted = resolve;
        });
        const cancelStarted = new Promise<void>((resolve) => {
            markCancelStarted = resolve;
        });
        let owner: ReturnType<
            typeof createDaemonManagedServiceEndpointReadOwner
        >;
        const runnerCall = vi.fn(async (rpcInput: Readonly<{
            method: string;
            request: unknown;
            timeoutMs: number | null;
        }>) => {
            if (
                rpcInput.method
                === MANAGED_SERVICE_ENDPOINT_READ_RPC_METHODS.OPEN
            ) {
                const request =
                    ManagedServiceEndpointReadOpenRequestV1Schema.parse(
                        rpcInput.request,
                    );
                expect(owner.claim({
                    requestId: request.requestId,
                    projectionToken: projection.projectionToken,
                    sessionId: projection.sessionId,
                    pluginId,
                })).toBe(true);
                markOpenStarted();
                await openReleased;
                return {
                    v: 1 as const,
                    requestId: request.requestId,
                    status: 'opened' as const,
                    response: {
                        status: 204,
                        statusText: 'No Content',
                        headers: [],
                        hasBody: false,
                    },
                };
            }
            if (
                rpcInput.method
                === MANAGED_SERVICE_ENDPOINT_READ_RPC_METHODS.CANCEL
            ) {
                const request =
                    ManagedServiceEndpointReadCancelRequestV1Schema.parse(
                        rpcInput.request,
                    );
                markCancelStarted();
                let timer: ReturnType<typeof setTimeout> | undefined;
                try {
                    await Promise.race([
                        cancelReleased,
                        new Promise<never>((_resolve, reject) => {
                            if (rpcInput.timeoutMs !== null) {
                                timer = setTimeout(() => reject(new Error('RPC call timeout')), rpcInput.timeoutMs);
                            }
                        }),
                    ]);
                } finally {
                    clearTimeout(timer);
                }
                return {
                    v: 1 as const,
                    requestId: request.requestId,
                    status: 'cancelled' as const,
                    cancelled: true,
                };
            }
            throw new Error(`Unexpected runner RPC method: ${rpcInput.method}`);
        });
        owner = createDaemonManagedServiceEndpointReadOwner({
            credentials: { token: 'test-token', encryption: null },
            resolveProjection: async () => projection,
            resolveRunnerEndpointReadRpc: async () => ({
                sessionId: projection.sessionId,
                call: runnerCall,
            }),
        });
        const read = await owner.bindHost({
            identity,
            source: { kind: 'opencodeServer', managedEndpoint: true },
            signal: new AbortController().signal,
        });

        const readPromise = read({ pathAndQuery: '/global/event' });
        let settled = false;
        const observedRead = readPromise.then(
            (response) => {
                settled = true;
                return { status: 'resolved' as const, response };
            },
            (error: unknown) => {
                settled = true;
                return { status: 'rejected' as const, error };
            },
        );
        await openStarted;
        let disposalSettled = false;
        const firstDisposePromise = owner.dispose();
        expect(owner.dispose()).toBe(firstDisposePromise);
        const disposePromise = firstDisposePromise.then(() => {
            disposalSettled = true;
        });
        await cancelStarted;
        await vi.advanceTimersByTimeAsync(7_000);
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(disposalSettled).toBe(false);

        releaseOpen();
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(settled).toBe(false);
        expect(disposalSettled).toBe(false);

        releaseCancel();
        const [outcome] = await Promise.all([observedRead, disposePromise]);
        expect(outcome.status).toBe('rejected');
        if (outcome.status === 'rejected') {
            expect(outcome.error).toBeInstanceOf(Error);
        }
        expect(disposalSettled).toBe(true);
        expect(runnerCall).toHaveBeenCalledTimes(2);
    });

    it('joins a remote CANCEL that operation abort started before disposal', async () => {
        let releaseOpen!: () => void;
        let releaseCancel!: () => void;
        let markOpenStarted!: () => void;
        let markCancelStarted!: () => void;
        const openReleased = new Promise<void>((resolve) => {
            releaseOpen = resolve;
        });
        const cancelReleased = new Promise<void>((resolve) => {
            releaseCancel = resolve;
        });
        const openStarted = new Promise<void>((resolve) => {
            markOpenStarted = resolve;
        });
        const cancelStarted = new Promise<void>((resolve) => {
            markCancelStarted = resolve;
        });
        let owner: ReturnType<
            typeof createDaemonManagedServiceEndpointReadOwner
        >;
        const runnerCall = vi.fn(async (rpcInput: Readonly<{
            method: string;
            request: unknown;
            timeoutMs: number | null;
        }>) => {
            if (
                rpcInput.method
                === MANAGED_SERVICE_ENDPOINT_READ_RPC_METHODS.OPEN
            ) {
                const request =
                    ManagedServiceEndpointReadOpenRequestV1Schema.parse(
                        rpcInput.request,
                    );
                expect(owner.claim({
                    requestId: request.requestId,
                    projectionToken: projection.projectionToken,
                    sessionId: projection.sessionId,
                    pluginId,
                })).toBe(true);
                markOpenStarted();
                await openReleased;
                return {
                    v: 1 as const,
                    requestId: request.requestId,
                    status: 'opened' as const,
                    response: {
                        status: 204,
                        statusText: 'No Content',
                        headers: [],
                        hasBody: false,
                    },
                };
            }
            if (
                rpcInput.method
                === MANAGED_SERVICE_ENDPOINT_READ_RPC_METHODS.CANCEL
            ) {
                const request =
                    ManagedServiceEndpointReadCancelRequestV1Schema.parse(
                        rpcInput.request,
                    );
                markCancelStarted();
                await cancelReleased;
                return {
                    v: 1 as const,
                    requestId: request.requestId,
                    status: 'cancelled' as const,
                    cancelled: true,
                };
            }
            throw new Error(`Unexpected runner RPC method: ${rpcInput.method}`);
        });
        owner = createDaemonManagedServiceEndpointReadOwner({
            credentials: { token: 'test-token', encryption: null },
            resolveProjection: async () => projection,
            resolveRunnerEndpointReadRpc: async () => ({
                sessionId: projection.sessionId,
                call: runnerCall,
            }),
        });
        const operationAbort = new AbortController();
        const read = await owner.bindHost({
            identity,
            source: { kind: 'opencodeServer', managedEndpoint: true },
            signal: operationAbort.signal,
        });

        let readSettled = false;
        const observedRead = read({ pathAndQuery: '/global/event' }).then(
            (response) => {
                readSettled = true;
                return { status: 'resolved' as const, response };
            },
            (error: unknown) => {
                readSettled = true;
                return { status: 'rejected' as const, error };
            },
        );
        await openStarted;
        operationAbort.abort(new Error('operation cancelled'));
        await cancelStarted;

        let disposalSettled = false;
        const disposePromise = owner.dispose().then(() => {
            disposalSettled = true;
        });
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(disposalSettled).toBe(false);

        releaseOpen();
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(readSettled).toBe(false);
        expect(disposalSettled).toBe(false);

        releaseCancel();
        const [outcome] = await Promise.all([observedRead, disposePromise]);
        expect(outcome.status).toBe('rejected');
        if (outcome.status === 'rejected') {
            expect(outcome.error).toMatchObject({
                message: 'operation cancelled',
            });
        }
        expect(disposalSettled).toBe(true);
        expect(runnerCall).toHaveBeenCalledTimes(2);
    });

    it('does not register or dispatch a read whose runner transport resolves after disposal', async () => {
        let releaseRunnerResolution!: () => void;
        let markRunnerResolutionStarted!: () => void;
        const runnerResolutionReleased = new Promise<void>((resolve) => {
            releaseRunnerResolution = resolve;
        });
        const runnerResolutionStarted = new Promise<void>((resolve) => {
            markRunnerResolutionStarted = resolve;
        });
        const runnerCall = vi.fn(async () => {
            throw new Error('Runner RPC must not be called after disposal');
        });
        const owner = createDaemonManagedServiceEndpointReadOwner({
            credentials: { token: 'test-token', encryption: null },
            resolveProjection: async () => projection,
            resolveRunnerEndpointReadRpc: async () => {
                markRunnerResolutionStarted();
                await runnerResolutionReleased;
                return {
                    sessionId: projection.sessionId,
                    call: runnerCall,
                };
            },
        });
        const read = await owner.bindHost({
            identity,
            source: { kind: 'opencodeServer', managedEndpoint: true },
            signal: new AbortController().signal,
        });

        const readPromise = read({ pathAndQuery: '/global/event' });
        await runnerResolutionStarted;
        await owner.dispose();
        releaseRunnerResolution();

        await expect(readPromise).rejects.toThrow(
            'Managed server endpoint read owner is unavailable',
        );
        expect(runnerCall).not.toHaveBeenCalled();
    });

    it('authorizes the exact non-managed source custody without a occurrenceId alias', async () => {
        const otherSourceCustody = Object.freeze({
            kind: 'development' as const,
            registeredRootId: 'other-source-root',
        });
        const otherProjection = endpointProjection(otherSourceCustody);
        const resolveProjection = vi.fn(async () => otherProjection);
        const owner = createDaemonManagedServiceEndpointReadOwner({
            credentials: { token: 'test-token', encryption: null },
            resolveProjection,
        });

        await expect(owner.bindHost({
            identity: {
                ...identity,
                sourceCustody: otherSourceCustody,
            },
            source: { kind: 'opencodeServer', managedEndpoint: true },
            signal: new AbortController().signal,
        })).resolves.toEqual(expect.any(Function));
        expect(resolveProjection).toHaveBeenCalledWith({
            pluginId,
            contributionId,
            sourceCustody: otherSourceCustody,
            selector: { kind: 'currentContribution' },
        });
        await owner.dispose();
    });

    it.each(invalidBindings)('fails closed for %s', async (_label, override) => {
        const owner = createDaemonManagedServiceEndpointReadOwner({
            credentials: { token: 'test-token', encryption: null },
            resolveProjection: async (
                query: ManagedServiceEndpointProjectionResolveQuery,
            ) => (
                query.pluginId === pluginId
                && query.contributionId === contributionId
                && query.sourceCustody === sourceCustody
                && query.selector.kind === 'currentContribution'
                    ? projection
                    : null
            ),
        });

        await expect(owner.bindHost({
            identity: override.identity ?? identity,
            source: override.source ?? {
                kind: 'opencodeServer',
                managedEndpoint: true,
            },
            signal: new AbortController().signal,
        })).rejects.toThrow('Managed server endpoint read owner is unavailable');
        await owner.dispose();
    });
});
