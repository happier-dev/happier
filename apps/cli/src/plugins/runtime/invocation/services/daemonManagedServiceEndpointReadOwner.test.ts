import { describe, expect, it, vi } from 'vitest';

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
const immutableGenerationId = 'immutable-opencode-generation';
function endpointProjection(
    generation = immutableGenerationId,
) {
    return createManagedServiceEndpointProjectionV1({
        sessionId: 'session-one',
        pluginId,
        contributionId,
        serverId: 'opencode-server',
        instanceId: 'opencode-instance',
        immutableGenerationId: generation,
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
        immutableGenerationId,
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
    generation: 'mutable-generation-alias',
    contributionQualifiedId: contributionId,
    immutableGenerationId,
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
    ['wrong generation', {
        identity: {
            ...identity,
            immutableGenerationId: 'other-generation',
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
                || query.immutableGenerationId !== immutableGenerationId
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
            immutableGenerationId,
            selector: { kind: 'currentContribution' },
        }]);

        await expect(read({ pathAndQuery: '/global/event' }))
            .rejects.toThrow('Managed server endpoint runner transport is unavailable');
        expect(queries).toEqual(Array.from({ length: 2 }, () => ({
            pluginId,
            contributionId,
            immutableGenerationId,
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
            timeoutMs: number;
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

        currentProjection = endpointProjection('mismatched-generation');
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
            immutableGenerationId,
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
            timeoutMs: number;
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
            immutableGenerationId,
            selector: { kind: 'currentContribution' },
        })));
        await owner.dispose();
    });

    it('joins remote cleanup and rejects when disposed while OPEN is settling', async () => {
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
            timeoutMs: number;
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
                expect(rpcInput.timeoutMs).toBe(5_000);
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
            timeoutMs: number;
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
                expect(rpcInput.timeoutMs).toBe(5_000);
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

    it('uses the mutable generation only when no immutable generation identity exists', async () => {
        const fallbackGeneration = 'fallback-generation';
        const fallbackProjection = endpointProjection(fallbackGeneration);
        const resolveProjection = vi.fn(async () => fallbackProjection);
        const owner = createDaemonManagedServiceEndpointReadOwner({
            credentials: { token: 'test-token', encryption: null },
            resolveProjection,
        });

        await expect(owner.bindHost({
            identity: {
                ...identity,
                generation: fallbackGeneration,
                immutableGenerationId: null,
            },
            source: { kind: 'opencodeServer', managedEndpoint: true },
            signal: new AbortController().signal,
        })).resolves.toEqual(expect.any(Function));
        expect(resolveProjection).toHaveBeenCalledWith({
            pluginId,
            contributionId,
            immutableGenerationId: fallbackGeneration,
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
                && query.immutableGenerationId === immutableGenerationId
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
