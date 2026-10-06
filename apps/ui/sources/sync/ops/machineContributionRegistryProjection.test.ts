import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { RpcError, readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';
import { createSocketIoAckTimeoutError } from '@happier-dev/sync-client';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';

const machineRpcWithServerScopeMock = vi.hoisted(() => vi.fn());
let network: Awaited<ReturnType<typeof installSessionOpsNetworkBoundary>>;

const mountedTarget = {
    pluginId: 'acme.preview',
    occurrenceId: 'target-generation-a',
} as const;

function v2Projection(generation = 1) {
    return { v: 2, generation, familiesById: {} } as const;
}

function targetedSnapshot(
    target: Readonly<{ pluginId: string; occurrenceId: string }> = mountedTarget,
) {
    return {
        target: { ...target, sourceCustody: { kind: 'development', registeredRootId: 'preview-root' } },
        points: [],
    } as const;
}

function automationEligibleEventsSnapshot() {
    return [{
        event: {
            id: 'acme.events/repository/updated',
            identity: { pluginId: 'acme.events', localId: 'repository/updated' },
            occurrenceId: 'event-generation-a',
            sourceCustody: { kind: 'development', registeredRootId: 'events-root' },
            title: 'Repository updated',
            description: null,
            payloadSchema: { type: 'object', additionalProperties: false },
            automation: {
                v: 1,
                eligible: true,
                source: {
                    sourceContractVersion: 1,
                    supportedObservationTransports: ['checkpointedPull'],
                    sourceConfigSchema: { type: 'object', additionalProperties: false },
                    setupActionRef: { pluginId: 'acme.events', localId: 'configure-source' },
                },
            },
        },
        setupAction: {
            id: 'acme.events/configure-source',
            identity: { pluginId: 'acme.events', localId: 'configure-source' },
            occurrenceId: 'event-generation-a',
            title: 'Configure source',
            description: null,
            inputSchema: { type: 'object', additionalProperties: false },
            inputHints: null,
        },
    }] as const;
}

describe('machine contribution registry projection ops', () => {
    beforeEach(async () => {
        vi.resetModules();
        machineRpcWithServerScopeMock.mockReset();
        network = await installSessionOpsNetworkBoundary();
        const homes = await Promise.all([
            network.addHome('https://server-a', 'account-a'),
            network.addHome('https://server-b', 'account-a'),
        ]);
        // Record the request at the physical Socket.IO boundary. Scoped Home /
        // Account routing, framing, projection parsing and currentness stay real.
        network.setRpcAckResponder(async (request) => {
            try {
                return { ok: true, result: await machineRpcWithServerScopeMock({
                    machineId: request.targetId,
                    serverId: homes.find((home) => home.serverUrl === request.serverUrl)?.id,
                    method: request.method,
                    payload: request.payload,
                    timeoutMs: request.timeoutMs,
                }) };
            } catch (error) {
                const errorCode = readRpcErrorCode(error);
                if (errorCode === RPC_ERROR_CODES.METHOD_NOT_FOUND || errorCode === RPC_ERROR_CODES.METHOD_NOT_AVAILABLE) {
                    return { ok: false, error: 'Daemon method unavailable', errorCode };
                }
                throw error; // A physical timeout/disconnect rejects the transport, not a daemon ACK.
            }
        });
    });
    afterEach(async () => {
        const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
        const { resetScopedMachineTransportCacheForTests } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcPool');
        serverScopedRpcSocketPool.resetForTests();
        resetScopedMachineTransportCacheForTests();
        network.dispose();
    });

    async function installReactNativeRuntimeMocks(platform: 'ios' | 'android' | 'web') {
        vi.doMock('react-native', async () => {
            const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
            const runtime = await createReactNativeWebMock({
                Platform: {
                    OS: platform,
                    constants: {
                        reactNativeVersion: { major: 0, minor: 83, patch: 4 },
                    },
                    select: <T,>(options: {
                        ios?: T;
                        android?: T;
                        web?: T;
                        native?: T;
                        default?: T;
                    }) => options[platform] ?? options.native ?? options.default ?? options.web,
                },
            });
            return runtime;
        });
        vi.doMock('expo-constants', () => ({
            default: {
                expoConfig: {
                    version: '0.2.1',
                    updates: {
                        requestHeaders: {
                            'expo-channel-name': 'internal',
                        },
                    },
                },
            },
        }));
        vi.doMock('expo-application', () => ({
            nativeApplicationVersion: '0.2.0',
            nativeBuildVersion: '101',
            applicationId: platform === 'android' ? 'dev.happier.app.android' : 'dev.happier.app',
        }));
        vi.doMock('expo-updates', () => ({
            channel: 'internal',
            updateId: null,
            runtimeVersion: 'runtime-55',
            createdAt: null,
            isEmbeddedLaunch: true,
        }));
        if (platform === 'web') {
            // The real capability owner probes a physical browser iframe.
            vi.stubGlobal('document', {
                body: { appendChild: vi.fn(), removeChild: vi.fn() },
                createElement: (tag: string) => ({ nodeName: tag.toUpperCase(), contentWindow: {}, setAttribute: vi.fn() }),
            });
        }
    }

    it('routes projection.describe through server-scoped machine rpc within the machine RPC budget', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            protocolVersion: 1,
            projection: v2Projection(),
            automationEligibleEvents: automationEligibleEventsSnapshot(),
        });
        const { machineContributionRegistryProjectionDescribe } = await import('./machineContributionRegistryProjection');

        const res = await machineContributionRegistryProjectionDescribe('machine-1', { serverId: 'server-a' });

        expect(res).toEqual({
            supported: true,
            projection: expect.objectContaining({ v: 2, generation: 1 }),
            automationEligibleEvents: automationEligibleEventsSnapshot(),
        });
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-a',
            method: RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE,
            payload: expect.not.objectContaining({ mountedTarget: expect.anything() }),
        }));
        // The emitted request consumes, rather than replaces, its owning RPC budget.
        const { DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcTypes');
        expect(network.requests[0]?.timeoutMs).toBeGreaterThan(0);
        expect(network.requests[0]?.timeoutMs).toBeLessThanOrEqual(DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS);
    });

    it('classifies why a projection read failed', async () => {
        const { machineContributionRegistryProjectionDescribe } = await import('./machineContributionRegistryProjection');

        machineRpcWithServerScopeMock.mockRejectedValueOnce(createSocketIoAckTimeoutError());
        await expect(machineContributionRegistryProjectionDescribe('machine-1', { serverId: 'server-a' }))
            .resolves.toEqual({ supported: false, reason: 'timeout' });

        machineRpcWithServerScopeMock.mockResolvedValueOnce({ protocolVersion: 1, projection: { v: 1 } });
        await expect(machineContributionRegistryProjectionDescribe('machine-1', { serverId: 'server-a' }))
            .resolves.toEqual({ supported: false, reason: 'invalid-response' });

        machineRpcWithServerScopeMock.mockRejectedValueOnce(new Error('socket closed'));
        await expect(machineContributionRegistryProjectionDescribe('machine-1', { serverId: 'server-a' }))
            .resolves.toEqual({ supported: false, reason: 'error' });
    });

    it('reads only the target slice and accepts the daemon’s current occurrence tag', async () => {
        const reloaded = { pluginId: 'acme.preview', occurrenceId: 'target-generation-b' } as const;
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            status: 'current',
            targetedContributions: targetedSnapshot(reloaded),
            targetedSurfaceMounts: [],
        });
        const { machinePluginUiTargetedContributionsRead } = await import('./machineContributionRegistryProjection');

        const res = await machinePluginUiTargetedContributionsRead('machine-1', {
            serverId: 'server-a',
            pluginId: 'acme.preview',
        });

        // A newer occurrence than the one the caller mounted is a reload, not
        // an error: the caller follows the tag.
        expect(res).toEqual({
            supported: true,
            targetedContributions: targetedSnapshot(reloaded),
            targetedSurfaceMounts: [],
        });
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            method: RPC_METHODS.DAEMON_PLUGIN_UI_TARGETED_CONTRIBUTIONS_READ,
            payload: expect.objectContaining({ machineId: 'machine-1', pluginId: 'acme.preview' }),
        }));
    });

    it('never shows a target slice that answers for another plugin, and reports a daemon unavailable answer', async () => {
        const { machinePluginUiTargetedContributionsRead } = await import('./machineContributionRegistryProjection');
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            status: 'current',
            targetedContributions: targetedSnapshot({ pluginId: 'acme.other', occurrenceId: 'other-a' }),
            targetedSurfaceMounts: [],
        });
        await expect(machinePluginUiTargetedContributionsRead('machine-1', {
            serverId: 'server-a',
            pluginId: 'acme.preview',
        })).resolves.toEqual({ supported: false, reason: 'invalid-response' });

        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            status: 'unavailable',
            code: 'plugin_targeted_contributions_target_unavailable',
        });
        await expect(machinePluginUiTargetedContributionsRead('machine-1', {
            serverId: 'server-a',
            pluginId: 'acme.preview',
        })).resolves.toEqual({
            supported: false,
            reason: 'unavailable',
            code: 'plugin_targeted_contributions_target_unavailable',
        });
    });

    it('coalesces concurrent projection reads for the same current scope', async () => {
        let resolveRpc!: (value: unknown) => void;
        machineRpcWithServerScopeMock.mockImplementationOnce(async () => await new Promise((resolve) => {
            resolveRpc = resolve;
        }));
        const { machineContributionRegistryProjectionDescribe } = await import('./machineContributionRegistryProjection');

        const first = machineContributionRegistryProjectionDescribe('machine-1', { serverId: 'server-a' });
        const second = machineContributionRegistryProjectionDescribe('machine-1', { serverId: 'server-a' });
        await vi.waitFor(() => expect(resolveRpc).toBeTypeOf('function'));
        const issuedRpcCount = machineRpcWithServerScopeMock.mock.calls.length;

        resolveRpc({ protocolVersion: 1, projection: v2Projection() });
        await expect(Promise.all([first, second])).resolves.toEqual([
            expect.objectContaining({ supported: true }),
            expect.objectContaining({ supported: true }),
        ]);
        expect(issuedRpcCount).toBe(1);
    });

    it('shares a read between handles of one Account but never with a successor Account', async () => {
        const pendingResolvers: Array<(value: unknown) => void> = [];
        machineRpcWithServerScopeMock.mockImplementation(() => new Promise((resolve) => { pendingResolvers.push(resolve); }));
        const { machineContributionRegistryProjectionDescribe } = await import('./machineContributionRegistryProjection');
        const handle = (accountId: string) => ({ scope: { serverId: 'server-a', accountId } });

        const reads = [
            machineContributionRegistryProjectionDescribe('machine-1', { serverId: 'server-a', accountLifetime: handle('account-a') }),
            machineContributionRegistryProjectionDescribe('machine-1', { serverId: 'server-a', accountLifetime: handle('account-a') }),
        ];
        await vi.waitFor(() => expect(pendingResolvers).toHaveLength(1));
        network.setAccount('https://server-a', 'account-b');
        reads.push(machineContributionRegistryProjectionDescribe('machine-1', { serverId: 'server-a', accountLifetime: handle('account-b') }));
        await vi.waitFor(() => expect(pendingResolvers.length).toBeGreaterThanOrEqual(2));
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledTimes(2);
        const { parseToken } = await import('@/utils/auth/parseToken');
        expect(network.requests.map(({ token }) => token ? parseToken(token) : null)).toEqual(['account-a', 'account-b']);
        for (const resolve of pendingResolvers) resolve({ protocolVersion: 1, projection: v2Projection() });
        await expect(Promise.all(reads)).resolves.toEqual([
            expect.objectContaining({ supported: true }),
            expect.objectContaining({ supported: true }),
            expect.objectContaining({ supported: true }),
        ]);
    });

    it('does not join an in-flight fallback projection after the browser observes an exact frame fact', async () => {
        const pendingResolvers: Array<(value: unknown) => void> = [];
        await installReactNativeRuntimeMocks('web');
        vi.stubGlobal('document', undefined);
        machineRpcWithServerScopeMock.mockImplementation(async () => await new Promise((resolve) => {
            pendingResolvers.push(resolve);
        }));
        const { machineContributionRegistryProjectionDescribe } = await import('./machineContributionRegistryProjection');

        const beforeBrowserFrame = machineContributionRegistryProjectionDescribe('machine-1', { serverId: 'server-a' });
        await vi.waitFor(() => expect(machineRpcWithServerScopeMock).toHaveBeenCalledTimes(1));
        vi.stubGlobal('document', {
            body: { appendChild: vi.fn(), removeChild: vi.fn() },
            createElement: (tag: string) => ({ nodeName: tag.toUpperCase(), contentWindow: {}, setAttribute: vi.fn() }),
        });
        const afterBrowserFrame = machineContributionRegistryProjectionDescribe('machine-1', { serverId: 'server-a' });

        await vi.waitFor(() => expect(machineRpcWithServerScopeMock).toHaveBeenCalledTimes(2));
        expect(pendingResolvers).toHaveLength(2);
        expect(machineRpcWithServerScopeMock.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
            payload: expect.not.objectContaining({
                hostedWebFrameCapability: expect.anything(),
            }),
        }));
        expect(machineRpcWithServerScopeMock.mock.calls[1]?.[0]).toEqual(expect.objectContaining({
            payload: expect.objectContaining({
                hostedWebFrameCapability: {
                    platform: 'web',
                    adapter: 'domIframe',
                },
            }),
        }));

        for (const resolve of pendingResolvers) {
            resolve({ protocolVersion: 1, projection: v2Projection() });
        }
        await expect(Promise.all([beforeBrowserFrame, afterBrowserFrame])).resolves.toHaveLength(2);
    });

    it('does not join a stale projection flight after scope invalidation', async () => {
        const pendingResolvers: Array<(value: unknown) => void> = [];
        machineRpcWithServerScopeMock.mockImplementation(async () => await new Promise((resolve) => {
            pendingResolvers.push(resolve);
        }));
        const mod = await import('./machineContributionRegistryProjection');

        const first = mod.machineContributionRegistryProjectionDescribe('machine-1', { serverId: 'server-a' });
        await vi.waitFor(() => expect(pendingResolvers).toHaveLength(1));
        mod.publishMachineContributionRegistryProjectionInvalidation({
            machineId: 'machine-1',
            serverId: 'server-a',
        });
        const refreshed = mod.machineContributionRegistryProjectionDescribe('machine-1', { serverId: 'server-a' });
        await vi.waitFor(() => expect(pendingResolvers).toHaveLength(2));

        expect(machineRpcWithServerScopeMock).toHaveBeenCalledTimes(2);
        pendingResolvers[0]?.({ protocolVersion: 1, projection: v2Projection(1) });
        pendingResolvers[1]?.({ protocolVersion: 1, projection: v2Projection(2) });

        await expect(first).resolves.toMatchObject({ supported: true, projection: { generation: 1 } });
        await expect(refreshed).resolves.toMatchObject({ supported: true, projection: { generation: 2 } });
    });

    it('invalidates every mounted projection scope after the authenticated socket reconnects', async () => {
        const mod = await import('./machineContributionRegistryProjection');
        const machineOneScope = { machineId: 'machine-1', serverId: 'server-a' };
        const machineTwoScope = { machineId: 'machine-2', serverId: 'server-b' };
        const machineOneListener = vi.fn();
        const machineTwoListener = vi.fn();
        const unsubscribeMachineOne =
            mod.subscribeMachineContributionRegistryProjectionInvalidation(
                machineOneScope,
                machineOneListener,
            );
        const unsubscribeMachineTwo =
            mod.subscribeMachineContributionRegistryProjectionInvalidation(
                machineTwoScope,
                machineTwoListener,
            );

        mod.publishMachineContributionRegistryProjectionReconnect();

        expect(mod.getMachineContributionRegistryProjectionRevision(machineOneScope)).toBe(1);
        expect(mod.getMachineContributionRegistryProjectionRevision(machineTwoScope)).toBe(1);
        expect(machineOneListener).toHaveBeenCalledOnce();
        expect(machineTwoListener).toHaveBeenCalledOnce();

        unsubscribeMachineOne();
        unsubscribeMachineTwo();
    });

    it('keeps different scopes independent and retries after failure', async () => {
        machineRpcWithServerScopeMock
            .mockRejectedValueOnce(new Error('temporary transport failure'))
            .mockResolvedValue({ protocolVersion: 1, projection: v2Projection() });
        const { machineContributionRegistryProjectionDescribe } = await import('./machineContributionRegistryProjection');

        await expect(machineContributionRegistryProjectionDescribe('machine-1', { serverId: 'server-a' }))
            .resolves.toEqual({ supported: false, reason: 'error' });
        await expect(Promise.all([
            machineContributionRegistryProjectionDescribe('machine-1', { serverId: 'server-a' }),
            machineContributionRegistryProjectionDescribe('machine-2', { serverId: 'server-a' }),
            machineContributionRegistryProjectionDescribe('machine-1', { serverId: 'server-b' }),
        ])).resolves.toHaveLength(3);

        expect(machineRpcWithServerScopeMock).toHaveBeenCalledTimes(4);
    });

    it('lets one caller cancel its wait without cancelling a same-scope flight', async () => {
        let resolveRpc!: (value: unknown) => void;
        machineRpcWithServerScopeMock.mockImplementationOnce(async () => await new Promise((resolve) => {
            resolveRpc = resolve;
        }));
        const { machineContributionRegistryProjectionDescribe } = await import('./machineContributionRegistryProjection');
        const controller = new AbortController();

        const retained = machineContributionRegistryProjectionDescribe('machine-1', { serverId: 'server-a' });
        const cancelled = machineContributionRegistryProjectionDescribe('machine-1', {
            serverId: 'server-a',
            signal: controller.signal,
        });
        // Desktop capability discovery is an async native boundary. Wait for
        // the shared flight to issue before exercising waiter-only cancellation.
        await vi.waitFor(() => expect(resolveRpc).toBeTypeOf('function'));
        controller.abort();
        resolveRpc({ protocolVersion: 1, projection: v2Projection() });

        await expect(cancelled).resolves.toEqual({ supported: false, reason: 'aborted' });
        await expect(retained).resolves.toEqual(expect.objectContaining({ supported: true }));
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledTimes(1);
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.not.objectContaining({
            signal: expect.anything(),
        }));
    });

    it('routes plugin settings get and set through server-scoped machine rpc', async () => {
        machineRpcWithServerScopeMock
            .mockResolvedValueOnce({
                protocolVersion: 1,
                pluginId: 'acme.hooks',
                scope: { kind: 'daemon' },
                revision: '3',
                values: { endpoint: 'https://api.example.test' },
                redactedKeys: ['apiToken'],
            })
            .mockResolvedValueOnce({
                status: 'applied',
                snapshot: {
                    protocolVersion: 1,
                    pluginId: 'acme.hooks',
                    scope: { kind: 'daemon' },
                    revision: '4',
                    values: { endpoint: 'https://api.changed.test' },
                    redactedKeys: ['apiToken'],
                },
            });
        const mod = await import('./machineContributionRegistryProjection');

        const snapshot = await mod.machinePluginSettingsGet('machine-1', {
            serverId: 'server-a',
            serverIdentityId: 'srv_server_a',
            pluginId: 'acme.hooks',
        });
        const updated = await mod.machinePluginSettingsSet('machine-1', {
            serverId: 'server-a',
            serverIdentityId: 'srv_server_a',
            pluginId: 'acme.hooks',
            fieldId: 'endpoint',
            mutation: { kind: 'set', value: 'https://api.changed.test' },
            expectedRevision: '3',
        });

        expect(snapshot).toEqual({
            supported: true,
            snapshot: expect.objectContaining({
                values: { endpoint: 'https://api.example.test' },
                redactedKeys: ['apiToken'],
            }),
        });
        expect(updated).toEqual({
            supported: true,
            result: {
                status: 'applied',
                snapshot: expect.objectContaining({
                    values: { endpoint: 'https://api.changed.test' },
                    redactedKeys: ['apiToken'],
                }),
            },
        });
        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(1, expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-a',
            method: RPC_METHODS.DAEMON_PLUGIN_SETTINGS_GET,
            payload: {
                serverIdentityId: 'srv_server_a',
                machineId: 'machine-1',
                pluginId: 'acme.hooks',
                scope: { kind: 'daemon' },
            },
        }));
        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-a',
            method: RPC_METHODS.DAEMON_PLUGIN_SETTINGS_SET,
            payload: {
                serverIdentityId: 'srv_server_a',
                machineId: 'machine-1',
                pluginId: 'acme.hooks',
                scope: { kind: 'daemon' },
                fieldId: 'endpoint',
                mutation: { kind: 'set', value: 'https://api.changed.test' },
                expectedRevision: '3',
            },
        }));
    });

    it('forwards daemon Settings invalidation as revision-only parked watches without duplicate publishes', async () => {
        machineRpcWithServerScopeMock
            .mockResolvedValueOnce({ status: 'ready', revision: 'settings-r1' })
            .mockResolvedValueOnce({ status: 'changed', revision: 'settings-r1' })
            .mockResolvedValueOnce({ status: 'changed', revision: 'settings-r2' })
            .mockImplementationOnce(() => new Promise<never>(() => {}));
        const { watchMachinePluginSettingsChanges } = await import('./machineContributionRegistryProjection');
        const onInvalidated = vi.fn();

        const watch = watchMachinePluginSettingsChanges('machine-1', {
            serverId: 'server-a',
            serverIdentityId: 'srv_server_a',
            pluginId: 'acme.hooks',
            onInvalidated,
        });

        await vi.waitFor(() => {
            expect(machineRpcWithServerScopeMock).toHaveBeenCalledTimes(4);
        });
        expect(onInvalidated).toHaveBeenCalledTimes(1);
        expect(machineRpcWithServerScopeMock.mock.calls.slice(0, 3).map(([input]) => input)).toEqual([
            expect.objectContaining({
                machineId: 'machine-1',
                serverId: 'server-a',
                method: RPC_METHODS.DAEMON_PLUGIN_SETTINGS_WATCH,
                timeoutMs: expect.any(Number),
                payload: {
                    serverIdentityId: 'srv_server_a',
                    machineId: 'machine-1',
                    pluginId: 'acme.hooks',
                    scope: { kind: 'daemon' },
                },
            }),
            expect.objectContaining({
                payload: {
                    serverIdentityId: 'srv_server_a',
                    machineId: 'machine-1',
                    pluginId: 'acme.hooks',
                    scope: { kind: 'daemon' },
                    knownRevision: 'settings-r1',
                },
            }),
            expect.objectContaining({
                payload: {
                    serverIdentityId: 'srv_server_a',
                    machineId: 'machine-1',
                    pluginId: 'acme.hooks',
                    scope: { kind: 'daemon' },
                    knownRevision: 'settings-r1',
                },
            }),
        ]);
        for (const request of network.requests.slice(0, 3)) {
            expect(request.timeoutMs).toBeGreaterThan(30_000);
            expect(request.timeoutMs).toBeLessThanOrEqual(35_000);
        }
        expect(JSON.stringify(machineRpcWithServerScopeMock.mock.calls)).not.toContain('values');

        watch.dispose();
        await Promise.resolve();
        expect(onInvalidated).toHaveBeenCalledTimes(1);
    });

    it('routes an origin-bound daemon secret only through its exact secret custody RPCs', async () => {
        machineRpcWithServerScopeMock
            .mockResolvedValueOnce({
                protocolVersion: 1,
                pluginId: 'happier.agent.opencode',
                secretId: 'opencodeServerPassword',
                state: 'missing',
                revision: 'origin-1',
            })
            .mockResolvedValueOnce({
                protocolVersion: 1,
                pluginId: 'happier.agent.opencode',
                secretId: 'opencodeServerPassword',
                state: 'configured',
                revision: 'origin-2',
            })
            .mockResolvedValueOnce({
                protocolVersion: 1,
                pluginId: 'happier.agent.opencode',
                secretId: 'opencodeServerPassword',
                state: 'missing',
                revision: 'origin-3',
            });
        const mod = await import('./machineContributionRegistryProjection');
        const identity = {
            serverId: 'server-a',
            serverIdentityId: 'srv_server_a',
            pluginId: 'happier.agent.opencode',
            secretId: 'opencodeServerPassword',
            canonicalOrigin: 'https://opencode.example.test',
        };

        const status = await mod.machinePluginSecretStatus('machine-1', identity);
        const created = await mod.machinePluginSecretSet('machine-1', {
            ...identity,
            value: 'user-entered-secret',
            expectedRevision: 'origin-1',
        });
        const deleted = await mod.machinePluginSecretDelete('machine-1', {
            ...identity,
            expectedRevision: 'origin-2',
        });

        expect(status).toEqual({
            supported: true,
            result: expect.objectContaining({ state: 'missing', revision: 'origin-1' }),
        });
        expect(created).toEqual({
            supported: true,
            result: expect.objectContaining({ state: 'configured', revision: 'origin-2' }),
        });
        expect(deleted).toEqual({
            supported: true,
            result: expect.objectContaining({ state: 'missing', revision: 'origin-3' }),
        });
        expect(created).not.toHaveProperty('value');
        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(1, expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-a',
            method: RPC_METHODS.DAEMON_PLUGIN_SECRET_STATUS,
            payload: {
                serverIdentityId: 'srv_server_a',
                machineId: 'machine-1',
                pluginId: 'happier.agent.opencode',
                secretId: 'opencodeServerPassword',
                canonicalOrigin: 'https://opencode.example.test',
            },
        }));
        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
            method: RPC_METHODS.DAEMON_PLUGIN_SECRET_SET,
            payload: {
                serverIdentityId: 'srv_server_a',
                machineId: 'machine-1',
                pluginId: 'happier.agent.opencode',
                secretId: 'opencodeServerPassword',
                canonicalOrigin: 'https://opencode.example.test',
                value: 'user-entered-secret',
                expectedRevision: 'origin-1',
            },
        }));
        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(3, expect.objectContaining({
            method: RPC_METHODS.DAEMON_PLUGIN_SECRET_DELETE,
            payload: {
                serverIdentityId: 'srv_server_a',
                machineId: 'machine-1',
                pluginId: 'happier.agent.opencode',
                secretId: 'opencodeServerPassword',
                canonicalOrigin: 'https://opencode.example.test',
                expectedRevision: 'origin-2',
            },
        }));
    });

    it('distinguishes a failed SET before issuance from a lost acknowledgement after issuance', async () => {
        machineRpcWithServerScopeMock
            .mockRejectedValueOnce(new Error('connection unavailable before SET emission'))
            .mockImplementationOnce(async (input: Readonly<{ onIssued?: () => void }>) => {
                input.onIssued?.();
                throw new Error('SET acknowledgement lost after emission');
            });
        const { machinePluginSettingsSet } = await import('./machineContributionRegistryProjection');
        const input = {
            serverId: 'server-a',
            serverIdentityId: 'srv_server_a',
            pluginId: 'acme.hooks',
            fieldId: 'endpoint',
            mutation: { kind: 'set' as const, value: 'https://api.changed.test' },
            expectedRevision: '3',
        };

        await expect(machinePluginSettingsSet('machine-1', input)).resolves.toEqual({
            supported: false,
            reason: 'error',
        });
        await expect(machinePluginSettingsSet('machine-1', input)).resolves.toEqual({
            supported: false,
            reason: 'outcomeUnknown',
        });
        expect(machineRpcWithServerScopeMock.mock.calls[1]?.[0]).toEqual(expect.objectContaining({
            onIssued: expect.any(Function),
        }));
    });

    it.each([
        RPC_ERROR_CODES.METHOD_NOT_FOUND,
        RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
    ])('treats a thrown older-daemon Settings receiver absence (%s) as unsupported', async (rpcErrorCode) => {
        machineRpcWithServerScopeMock
            .mockRejectedValueOnce(new RpcError('older daemon receiver missing', rpcErrorCode))
            .mockRejectedValueOnce(new RpcError('older daemon receiver missing', rpcErrorCode));
        const mod = await import('./machineContributionRegistryProjection');

        await expect(mod.machinePluginSettingsGet('machine-1', {
            serverId: 'server-a',
            serverIdentityId: 'srv_server_a',
            pluginId: 'acme.hooks',
        })).resolves.toEqual({ supported: false, reason: 'not-supported' });
        await expect(mod.machinePluginSettingsSet('machine-1', {
            serverId: 'server-a',
            serverIdentityId: 'srv_server_a',
            pluginId: 'acme.hooks',
            fieldId: 'endpoint',
            mutation: { kind: 'delete' },
        })).resolves.toEqual({ supported: false, reason: 'not-supported' });
    });

    it('routes structured-message actions through the exact contributor occurrence fence', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({ ok: true, result: { opened: true } });
        const { machinePluginStructuredMessageActionExecute } = await import('./machineContributionRegistryProjection');
        const abortController = new AbortController();

        await expect(machinePluginStructuredMessageActionExecute('machine-1', {
            serverId: 'server-a',
            expectedContributorOccurrenceId: 'acme.preview-occurrence-7',
            qualifiedActionId: 'acme.preview/open-preview',
            input: { previewId: 'preview-1' },
            sessionId: 'session-1',
            executionSurface: 'ui',
            invocation: {
                kind: 'mountedPluginSurface',
                mountedBinding: {
                    pluginId: 'acme.preview',
                    contributionLocalId: 'message-preview',
                    occurrenceId: 'acme.preview:current',
                    materializationRef: {
                        machineId: 'machine-1',
                        materializationId: 'materialization-preview-current',
                        pluginId: 'acme.preview',
                    },
                },
            },
            signal: abortController.signal,
        })).resolves.toEqual({
            supported: true,
            result: { ok: true, result: { opened: true } },
        });
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-a',
            method: RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE,
            payload: {
                machineId: 'machine-1',
                expectedContributorOccurrenceId: 'acme.preview-occurrence-7',
                qualifiedActionId: 'acme.preview/open-preview',
                input: { previewId: 'preview-1' },
                sessionId: 'session-1',
                executionSurface: 'ui',
                invocation: {
                    kind: 'mountedPluginSurface',
                    mountedBinding: {
                        pluginId: 'acme.preview',
                        contributionLocalId: 'message-preview',
                        occurrenceId: 'acme.preview:current',
                        materializationRef: {
                            machineId: 'machine-1',
                            materializationId: 'materialization-preview-current',
                            pluginId: 'acme.preview',
                        },
                    },
                },
            },
            signal: abortController.signal,
        }));
    });

    it('keeps an omitted structured Action input distinct from an explicit JSON null at the daemon RPC boundary', async () => {
        machineRpcWithServerScopeMock
            .mockResolvedValueOnce({ ok: true, result: null })
            .mockResolvedValueOnce({ ok: true, result: null });
        const { machinePluginStructuredMessageActionExecute } = await import('./machineContributionRegistryProjection');

        await expect(machinePluginStructuredMessageActionExecute('machine-1', {
            serverId: 'server-a',
            expectedContributorOccurrenceId: 'preview-occurrence-7',
            qualifiedActionId: 'acme.preview/open-preview',
            executionSurface: 'ui',
        })).resolves.toEqual({ supported: true, result: { ok: true, result: null } });
        await expect(machinePluginStructuredMessageActionExecute('machine-1', {
            serverId: 'server-a',
            expectedContributorOccurrenceId: 'preview-occurrence-7',
            qualifiedActionId: 'acme.preview/open-preview',
            input: null,
            executionSurface: 'ui',
        })).resolves.toEqual({ supported: true, result: { ok: true, result: null } });

        const omittedPayload = machineRpcWithServerScopeMock.mock.calls[0]?.[0]?.payload as Readonly<Record<string, unknown>>;
        const nullPayload = machineRpcWithServerScopeMock.mock.calls[1]?.[0]?.payload as Readonly<Record<string, unknown>>;
        expect(Object.prototype.hasOwnProperty.call(omittedPayload, 'input')).toBe(false);
        expect(Object.prototype.hasOwnProperty.call(nullPayload, 'input')).toBe(true);
        expect(nullPayload.input).toBeNull();
    });

    it('distinguishes a structured Action failure before issuance from a lost acknowledgement after issuance', async () => {
        machineRpcWithServerScopeMock
            .mockRejectedValueOnce(new Error('connection unavailable before Action emission'))
            .mockImplementationOnce(async (input: Readonly<{ onIssued?: () => void }>) => {
                input.onIssued?.();
                throw new Error('Action socket acknowledgement timed out after emission');
            });
        const { machinePluginStructuredMessageActionExecute } = await import('./machineContributionRegistryProjection');
        const input = {
            serverId: 'server-a',
            expectedContributorOccurrenceId: 'preview-occurrence-7',
            qualifiedActionId: 'acme.preview/open-preview',
            executionSurface: 'ui' as const,
        };

        await expect(machinePluginStructuredMessageActionExecute('machine-1', input)).resolves.toEqual({
            supported: false,
            reason: 'error',
        });
        await expect(machinePluginStructuredMessageActionExecute('machine-1', input)).resolves.toEqual({
            supported: false,
            reason: 'outcomeUnknown',
        });
        expect(machineRpcWithServerScopeMock.mock.calls[1]?.[0]).toEqual(expect.objectContaining({
            onIssued: expect.any(Function),
        }));
    });

    it('fails closed when an older daemon does not expose the structured-message Action RPC', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND,
            error: 'Method not found',
        });
        const mod = await import('./machineContributionRegistryProjection');

        await expect(mod.machinePluginStructuredMessageActionExecute('machine-1', {
            serverId: 'server-a',
            expectedContributorOccurrenceId: 'preview-occurrence-7',
            qualifiedActionId: 'acme.preview/open-preview',
            input: null,
            executionSurface: 'ui',
        })).resolves.toEqual({ supported: false, reason: 'not-supported' });
    });

    it('does not expose or call the retired machine Composer attachment prepare transport', async () => {
        const module = await import('./machineContributionRegistryProjection');

        expect(Reflect.has(module, 'machinePluginComposerAttachmentPrepare')).toBe(false);
        expect(Reflect.has(RPC_METHODS, 'DAEMON_PLUGIN_COMPOSER_ATTACHMENT_PREPARE')).toBe(false);
        expect(machineRpcWithServerScopeMock).not.toHaveBeenCalledWith(expect.objectContaining({
            method: 'daemon.plugins.composerAttachments.prepare',
        }));
    });

    it('reads one bounded host-owned Connected Account form option result without sending purpose or service authority', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            ok: true,
            options: [{
                value: {
                    service: { pluginId: 'com.acme.accounts', localId: 'service' },
                    accountId: 'account-1',
                },
                label: 'Work account',
            }],
        });
        const { machinePluginActionFormConnectedAccountOptionsResolve } = await import('./machineContributionRegistryProjection');

        await expect(machinePluginActionFormConnectedAccountOptionsResolve('machine-1', {
            serverId: 'server-a',
            expectedOccurrenceId: 'preview-occurrence-7',
            qualifiedActionId: 'acme.preview/configure-account',
            fieldPath: 'credentialRef',
        })).resolves.toEqual({
            supported: true,
            result: {
                ok: true,
                options: [{
                    value: {
                        service: { pluginId: 'com.acme.accounts', localId: 'service' },
                        accountId: 'account-1',
                    },
                    label: 'Work account',
                }],
            },
        });
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-a',
            method: RPC_METHODS.DAEMON_PLUGIN_ACTION_FORM_CONNECTED_ACCOUNT_OPTIONS_RESOLVE,
            payload: {
                machineId: 'machine-1',
                expectedOccurrenceId: 'preview-occurrence-7',
                qualifiedActionId: 'acme.preview/configure-account',
                fieldPath: 'credentialRef',
            },
        }));
    });

    it('reads one Action\'s schemas once per exact occurrence and re-reads after a plugin reload', async () => {
        const inputSchema = { type: 'object', properties: { title: { type: 'string' } }, additionalProperties: false };
        const reloadedInputSchema = { type: 'object', properties: { name: { type: 'string' } }, additionalProperties: false };
        let answerFirst!: (value: unknown) => void;
        machineRpcWithServerScopeMock
            .mockImplementationOnce(async () => await new Promise((resolve) => { answerFirst = resolve; }))
            .mockResolvedValueOnce({ ok: true, inputSchema: reloadedInputSchema });
        const { machinePluginActionSchemasRead } = await import('./machineContributionRegistryProjection');
        const read = (expectedOccurrenceId: string) => machinePluginActionSchemasRead('machine-1', {
            serverId: 'server-a',
            expectedOccurrenceId,
            qualifiedActionId: 'acme.preview/refresh',
        });

        // Concurrent readers of the same Action occurrence share one request.
        const first = read('occurrence-a');
        const second = read('occurrence-a');
        await vi.waitFor(() => expect(answerFirst).toBeTypeOf('function'));
        answerFirst({ ok: true, inputSchema, outputSchema: { type: 'object' } });
        const expected = {
            supported: true,
            result: { ok: true, inputSchema, outputSchema: { type: 'object' } },
        };
        await expect(first).resolves.toEqual(expected);
        await expect(second).resolves.toEqual(expected);
        // A settled answer is kept for that occurrence.
        await expect(read('occurrence-a')).resolves.toEqual(expected);
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledTimes(1);
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-a',
            method: RPC_METHODS.DAEMON_PLUGIN_ACTION_SCHEMAS_READ,
            payload: {
                machineId: 'machine-1',
                expectedOccurrenceId: 'occurrence-a',
                qualifiedActionId: 'acme.preview/refresh',
            },
        }));

        // A reloaded plugin is a new occurrence: its declaration is read again.
        await expect(read('occurrence-b')).resolves.toEqual({
            supported: true,
            result: { ok: true, inputSchema: reloadedInputSchema },
        });
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledTimes(2);
    });

    it('does not keep a failed Action schema read', async () => {
        machineRpcWithServerScopeMock
            .mockResolvedValueOnce({ ok: false, code: 'plugin_occurrence_stale' })
            .mockResolvedValueOnce({ ok: true, inputSchema: { type: 'object' } });
        const { machinePluginActionSchemasRead } = await import('./machineContributionRegistryProjection');
        const request = {
            serverId: 'server-a',
            expectedOccurrenceId: 'occurrence-a',
            qualifiedActionId: 'acme.preview/refresh',
        } as const;

        await expect(machinePluginActionSchemasRead('machine-1', request)).resolves.toEqual({
            supported: true,
            result: { ok: false, code: 'plugin_occurrence_stale' },
        });
        await expect(machinePluginActionSchemasRead('machine-1', request)).resolves.toEqual({
            supported: true,
            result: { ok: true, inputSchema: { type: 'object' } },
        });
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledTimes(2);
    });

    it('forwards one host-stamped Session Resource context through read and watch-open RPCs', async () => {
        machineRpcWithServerScopeMock
            .mockResolvedValueOnce({
                ok: true,
                resource: { pluginId: 'acme.preview', localId: 'live-activity' },
                kind: 'config',
                contentType: 'application/json',
                digest: `sha256:${'a'.repeat(64)}`,
                bytesBase64: Buffer.from('{"activities":[]}').toString('base64'),
            })
            .mockResolvedValueOnce({
                ok: true,
                subscriptionId: 'watch-1',
                digest: `sha256:${'a'.repeat(64)}`,
            });
        const {
            machinePluginUiResourceRead,
            machinePluginUiResourceWatchOpen,
        } = await import('./machineContributionRegistryProjection');
        const context = { kind: 'session' as const, sessionId: 'session-a' };

        await machinePluginUiResourceRead('machine-1', {
            serverId: 'server-a',
            expectedCallerOccurrenceId: 'preview-occurrence-7',
            callerPluginId: 'acme.preview',
            resource: { pluginId: 'acme.preview', localId: 'live-activity' },
            context,
        });
        await machinePluginUiResourceWatchOpen('machine-1', {
            serverId: 'server-a',
            expectedCallerOccurrenceId: 'preview-occurrence-7',
            callerPluginId: 'acme.preview',
            subscriptionId: 'watch-1',
            resource: { pluginId: 'acme.preview', localId: 'live-activity' },
            context,
        });

        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(1, expect.objectContaining({
            method: RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_READ,
            payload: expect.objectContaining({ context }),
        }));
        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
            method: RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_OPEN,
            payload: expect.objectContaining({ context }),
        }));
    });

    it('preserves the stable machine-RPC timeout fact for Resource transport consumers', async () => {
        machineRpcWithServerScopeMock.mockRejectedValueOnce(createSocketIoAckTimeoutError());
        const { machinePluginUiResourceRead } = await import('./machineContributionRegistryProjection');

        await expect(machinePluginUiResourceRead('machine-1', {
            serverId: 'server-a',
            expectedCallerOccurrenceId: 'preview-occurrence-7',
            callerPluginId: 'acme.preview',
            resource: { pluginId: 'acme.preview', localId: 'live-activity' },
        })).resolves.toEqual({ supported: false, reason: 'timeout' });
    });

    it('fails closed when an older daemon does not expose the Connected Account form-option RPC', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND,
            error: 'Method not found',
        });
        const { machinePluginActionFormConnectedAccountOptionsResolve } = await import('./machineContributionRegistryProjection');

        await expect(machinePluginActionFormConnectedAccountOptionsResolve('machine-1', {
            serverId: 'server-a',
            expectedOccurrenceId: 'preview-occurrence-7',
            qualifiedActionId: 'acme.preview/configure-account',
            fieldPath: 'credentialRef',
        })).resolves.toEqual({ supported: false, reason: 'not-supported' });
    });

    it('includes the resolved React Native host runtime identity on native requests', async () => {
        await installReactNativeRuntimeMocks('ios');
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            protocolVersion: 1,
            projection: v2Projection(),
        });
        const { machineContributionRegistryProjectionDescribe } = await import('./machineContributionRegistryProjection');

        await machineContributionRegistryProjectionDescribe('machine-1', { serverId: 'server-a' });

        const request = machineRpcWithServerScopeMock.mock.calls.at(-1)?.[0] as {
            payload?: Record<string, unknown>;
        };
        expect(request.payload?.machineId).toBe('machine-1');
        expect(request.payload?.reactNativeHostRuntimeIdentity).toEqual({
            platform: 'ios',
            channel: 'internal',
            rawUpdateChannel: 'internal',
            appVersion: '0.2.1',
            nativeApplicationVersion: '0.2.0',
            nativeBuildVersion: '101',
            applicationId: 'dev.happier.app',
        });
        expect(request.payload?.reactNativeHostRuntimeIdentity).not.toHaveProperty('scriptManagerRuntimeIntegrated');
    });

    it('omits native identity but reports only observed web runtime capabilities on web requests', async () => {
        await installReactNativeRuntimeMocks('web');
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            protocolVersion: 1,
            projection: v2Projection(),
        });
        const { machineContributionRegistryProjectionDescribe } = await import('./machineContributionRegistryProjection');

        await machineContributionRegistryProjectionDescribe('machine-1', { serverId: 'server-a' });

        const request = machineRpcWithServerScopeMock.mock.calls.at(-1)?.[0] as {
            payload?: Record<string, unknown>;
        };
        // Web requests report the hosted frame adapter without manufacturing
        // a native identity or an executable React Native loader capability.
        expect(request.payload).not.toHaveProperty('reactNativeHostRuntimeIdentity');
        expect(request.payload).not.toHaveProperty('reactNativeWebLoaderCapability');
        expect(request.payload).toMatchObject({
            machineId: 'machine-1',
            hostedWebFrameCapability: {
                platform: 'web',
                adapter: 'domIframe',
            },
        });
    });

    it('accepts extension projection v2 responses from the daemon', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            protocolVersion: 1,
            projection: {
                v: 2,
                generation: 3,
                installedPackagesById: {
                    'acme.review': {
                        id: 'acme.review',
                        displayName: 'Acme Review',
                        version: '1.0.0',
                        enabled: true,
                        source: {
                            kind: 'path',
                            locator: '/plugins/acme-review',
                        },
                    },
                },
                agentsById: {},
                actionsById: {},
                toolsById: {},
                commandsById: {},
                resourcesById: {},
                diagnostics: [],
            },
        });
        const { machineContributionRegistryProjectionDescribe } = await import('./machineContributionRegistryProjection');

        const res = await machineContributionRegistryProjectionDescribe('machine-1', { serverId: 'server-a' });

        expect(res).toEqual({
            supported: true,
            projection: expect.objectContaining({
                v: 2,
                generation: 3,
                installedPackagesById: expect.objectContaining({
                    'acme.review': expect.objectContaining({
                        displayName: 'Acme Review',
                    }),
                }),
            }),
        });
    });

    it('receives an active external-session source through the canonical response normalizer', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            protocolVersion: 1,
            projection: {
                v: 2,
                generation: 3,
                agentsById: {
                    'acme-agent': {
                        id: 'acme-agent',
                        externalSessions: {
                            agent: { pluginId: 'acme.external', localId: 'acme-agent' },
                            generation: 3,
                            operations: {
                                listCandidates: true,
                                resolveLinkIdentity: true,
                                pageTranscript: true,
                                readAfterTranscript: true,
                            },
                            sources: [{
                                sourceKind: 'acmeArchive',
                                schema: {
                                    fields: [{ name: 'kind', kind: 'literal', value: 'acmeArchive' }],
                                },
                                key: { segments: [{ kind: 'literal', value: 'acmeArchive' }] },
                                instances: [{ kind: 'default', constants: {} }],
                            }],
                        },
                    },
                },
            },
        });
        const { machineContributionRegistryProjectionDescribe } = await import('./machineContributionRegistryProjection');

        await expect(machineContributionRegistryProjectionDescribe('machine-1', { serverId: 'server-a' }))
            .resolves.toMatchObject({
                supported: true,
                projection: {
                    v: 2,
                    agentsById: {
                        'acme-agent': {
                            externalSessions: {
                                sources: [{ schema: { fields: expect.any(Array) } }],
                            },
                        },
                    },
                },
            });
    });

    it('treats method-not-found as unsupported (mixed-version daemon)', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND,
            error: 'Method not found',
        });
        const { machineContributionRegistryProjectionDescribe } = await import('./machineContributionRegistryProjection');

        const res = await machineContributionRegistryProjectionDescribe('machine-1', { serverId: 'server-a' });

        expect(res).toEqual({ supported: false, reason: 'not-supported' });
    });
});
