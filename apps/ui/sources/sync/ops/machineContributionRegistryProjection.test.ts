import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { RpcError } from '@happier-dev/protocol/rpcErrors';

const machineRpcWithServerScopeMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: machineRpcWithServerScopeMock,
}));

const mountedTarget = {
    pluginId: 'acme.preview',
    immutableGenerationId: 'target-generation-a',
} as const;

function targetedSnapshot(
    target: Readonly<{ pluginId: string; immutableGenerationId: string }> = mountedTarget,
) {
    return {
        target,
        points: [],
    } as const;
}

function automationEligibleEventsSnapshot() {
    return [{
        event: {
            id: 'acme.events/repository/updated',
            identity: { pluginId: 'acme.events', localId: 'repository/updated' },
            immutableGenerationId: 'event-generation-a',
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
            immutableGenerationId: 'event-generation-a',
            title: 'Configure source',
            description: null,
            inputSchema: { type: 'object', additionalProperties: false },
            inputHints: null,
        },
    }] as const;
}

describe('machine contribution registry projection ops', () => {
    beforeEach(() => {
        vi.resetModules();
        machineRpcWithServerScopeMock.mockReset();
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
        vi.doMock('@/components/plugins/hostedWeb/hostedWebFrameCapability', () => ({
            resolveHostedWebFrameCapability: () => platform === 'web'
                ? { platform: 'web' as const, adapter: 'domIframe' as const }
                : null,
        }));
    }

    it('routes projection.describe through server-scoped machine rpc', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            protocolVersion: 1,
            projection: { v: 1, agentsById: {}, backendsById: {} },
            automationEligibleEvents: automationEligibleEventsSnapshot(),
        });
        const { machineContributionRegistryProjectionDescribe } = await import('./machineContributionRegistryProjection');

        const res = await machineContributionRegistryProjectionDescribe('machine-1', { serverId: 'server-a' });

        expect(res).toEqual({
            supported: true,
            projection: expect.objectContaining({
                v: 1,
                agentsById: {},
                backendsById: {},
            }),
            automationEligibleEvents: automationEligibleEventsSnapshot(),
        });
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-a',
            method: RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE,
            payload: expect.objectContaining({ machineId: 'machine-1' }),
        }));
    });

    it('forwards one exact mounted target and preserves only its matching admitted snapshot', async () => {
        const targetedSurfaceMounts = [] as const;
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            protocolVersion: 1,
            projection: { v: 1, agentsById: {}, backendsById: {} },
            targetedContributions: targetedSnapshot(),
            targetedSurfaceMounts,
        });
        const { machineContributionRegistryProjectionDescribe } = await import('./machineContributionRegistryProjection');

        const res = await machineContributionRegistryProjectionDescribe('machine-1', {
            serverId: 'server-a',
            mountedTarget,
        });

        expect(res).toEqual({
            supported: true,
            projection: expect.objectContaining({ v: 1 }),
            targetedContributions: targetedSnapshot(),
            targetedSurfaceMounts,
        });
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            payload: expect.objectContaining({
                machineId: 'machine-1',
                mountedTarget,
            }),
        }));
    });

    it('rejects a targeted snapshot whose target differs from the requested current generation', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            protocolVersion: 1,
            projection: { v: 1, agentsById: {}, backendsById: {} },
            targetedContributions: targetedSnapshot({
                pluginId: 'acme.preview',
                immutableGenerationId: 'target-generation-b',
            }),
        });
        const { machineContributionRegistryProjectionDescribe } = await import('./machineContributionRegistryProjection');

        await expect(machineContributionRegistryProjectionDescribe('machine-1', {
            serverId: 'server-a',
            mountedTarget,
        })).resolves.toEqual({ supported: false, reason: 'error' });
    });

    it('coalesces concurrent projection reads for the same current scope', async () => {
        let resolveRpc!: (value: unknown) => void;
        machineRpcWithServerScopeMock.mockImplementationOnce(async () => await new Promise((resolve) => {
            resolveRpc = resolve;
        }));
        const { machineContributionRegistryProjectionDescribe } = await import('./machineContributionRegistryProjection');

        const first = machineContributionRegistryProjectionDescribe('machine-1', {
            serverId: 'server-a',
            timeoutMs: 5_000,
        });
        const second = machineContributionRegistryProjectionDescribe('machine-1', {
            serverId: 'server-a',
            timeoutMs: 5_000,
        });
        await Promise.resolve();
        const issuedRpcCount = machineRpcWithServerScopeMock.mock.calls.length;

        resolveRpc({
            protocolVersion: 1,
            projection: { v: 1, agentsById: {}, backendsById: {} },
        });
        await expect(Promise.all([first, second])).resolves.toEqual([
            expect.objectContaining({ supported: true }),
            expect.anything(),
        ]);
        expect(issuedRpcCount).toBe(1);
    });

    it('does not join an in-flight fallback projection after the browser observes an exact frame fact', async () => {
        let browserFrameReady = false;
        const pendingResolvers: Array<(value: unknown) => void> = [];
        vi.doMock('@/components/plugins/hostedWeb/hostedWebFrameCapability', () => ({
            resolveHostedWebFrameCapability: () => browserFrameReady
                ? { platform: 'web' as const, adapter: 'domIframe' as const }
                : null,
        }));
        machineRpcWithServerScopeMock.mockImplementation(async () => await new Promise((resolve) => {
            pendingResolvers.push(resolve);
        }));
        const { machineContributionRegistryProjectionDescribe } = await import('./machineContributionRegistryProjection');

        const beforeBrowserFrame = machineContributionRegistryProjectionDescribe('machine-1', {
            serverId: 'server-a',
            timeoutMs: 5_000,
        });
        await Promise.resolve();
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledTimes(1);
        browserFrameReady = true;
        const afterBrowserFrame = machineContributionRegistryProjectionDescribe('machine-1', {
            serverId: 'server-a',
            timeoutMs: 5_000,
        });

        await Promise.resolve();
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledTimes(2);
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
            resolve({
                protocolVersion: 1,
                projection: { v: 1, agentsById: {}, backendsById: {} },
            });
        }
        await expect(Promise.all([beforeBrowserFrame, afterBrowserFrame])).resolves.toHaveLength(2);
    });

    it('does not join a pre-reconnect projection flight after the caller advances its request epoch', async () => {
        const pendingResolvers: Array<(value: unknown) => void> = [];
        machineRpcWithServerScopeMock.mockImplementation(async () => await new Promise((resolve) => {
            pendingResolvers.push(resolve);
        }));
        const { machineContributionRegistryProjectionDescribe } = await import('./machineContributionRegistryProjection');

        const beforeDisconnect = machineContributionRegistryProjectionDescribe('machine-1', {
            serverId: 'server-a',
            timeoutMs: 5_000,
            requestEpoch: 'connection-0',
        });
        const afterReconnect = machineContributionRegistryProjectionDescribe('machine-1', {
            serverId: 'server-a',
            timeoutMs: 5_000,
            requestEpoch: 'connection-1',
        });
        await Promise.resolve();
        const issuedRpcCount = machineRpcWithServerScopeMock.mock.calls.length;

        for (const resolve of pendingResolvers) {
            resolve({
                protocolVersion: 1,
                projection: { v: 1, agentsById: {}, backendsById: {} },
            });
        }
        await expect(Promise.all([beforeDisconnect, afterReconnect])).resolves.toHaveLength(2);
        expect(issuedRpcCount).toBe(2);
    });

    it('does not join a stale projection flight after scope invalidation', async () => {
        const pendingResolvers: Array<(value: unknown) => void> = [];
        machineRpcWithServerScopeMock.mockImplementation(async () => await new Promise((resolve) => {
            pendingResolvers.push(resolve);
        }));
        const mod = await import('./machineContributionRegistryProjection');

        const first = mod.machineContributionRegistryProjectionDescribe('machine-1', {
            serverId: 'server-a',
            timeoutMs: 5_000,
        });
        await Promise.resolve();
        mod.publishMachineContributionRegistryProjectionInvalidation({
            machineId: 'machine-1',
            serverId: 'server-a',
        });
        const refreshed = mod.machineContributionRegistryProjectionDescribe('machine-1', {
            serverId: 'server-a',
            timeoutMs: 5_000,
        });
        await Promise.resolve();

        expect(machineRpcWithServerScopeMock).toHaveBeenCalledTimes(2);
        pendingResolvers[0]?.({
            protocolVersion: 1,
            projection: { v: 2, generation: 1, installedPackagesById: {}, agentsById: {}, backendsById: {}, actionsById: {}, toolsById: {}, commandsById: {}, resourcesById: {}, settingsById: {}, familiesById: {}, diagnostics: [] },
        });
        pendingResolvers[1]?.({
            protocolVersion: 1,
            projection: { v: 2, generation: 2, installedPackagesById: {}, agentsById: {}, backendsById: {}, actionsById: {}, toolsById: {}, commandsById: {}, resourcesById: {}, settingsById: {}, familiesById: {}, diagnostics: [] },
        });

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

    it('keeps different scopes and timeout budgets independent and retries after failure', async () => {
        machineRpcWithServerScopeMock
            .mockRejectedValueOnce(new Error('temporary transport failure'))
            .mockResolvedValue({
                protocolVersion: 1,
                projection: { v: 1, agentsById: {}, backendsById: {} },
            });
        const { machineContributionRegistryProjectionDescribe } = await import('./machineContributionRegistryProjection');

        await expect(machineContributionRegistryProjectionDescribe('machine-1', {
            serverId: 'server-a',
            timeoutMs: 5_000,
        })).resolves.toEqual({ supported: false, reason: 'error' });
        await expect(Promise.all([
            machineContributionRegistryProjectionDescribe('machine-1', { serverId: 'server-a', timeoutMs: 5_000 }),
            machineContributionRegistryProjectionDescribe('machine-2', { serverId: 'server-a', timeoutMs: 5_000 }),
            machineContributionRegistryProjectionDescribe('machine-1', { serverId: 'server-b', timeoutMs: 5_000 }),
            machineContributionRegistryProjectionDescribe('machine-1', { serverId: 'server-a', timeoutMs: 10_000 }),
        ])).resolves.toHaveLength(4);

        expect(machineRpcWithServerScopeMock).toHaveBeenCalledTimes(5);
    });

    it('lets one caller cancel its wait without cancelling a same-scope flight', async () => {
        let resolveRpc!: (value: unknown) => void;
        machineRpcWithServerScopeMock.mockImplementationOnce(async () => await new Promise((resolve) => {
            resolveRpc = resolve;
        }));
        const { machineContributionRegistryProjectionDescribe } = await import('./machineContributionRegistryProjection');
        const controller = new AbortController();

        const retained = machineContributionRegistryProjectionDescribe('machine-1', {
            serverId: 'server-a',
            timeoutMs: 5_000,
        });
        const cancelled = machineContributionRegistryProjectionDescribe('machine-1', {
            serverId: 'server-a',
            timeoutMs: 5_000,
            signal: controller.signal,
        });
        // Desktop capability discovery is an async native boundary. Wait for
        // the shared flight to issue before exercising waiter-only cancellation.
        await Promise.resolve();
        await Promise.resolve();
        controller.abort();
        resolveRpc({
            protocolVersion: 1,
            projection: { v: 1, agentsById: {}, backendsById: {} },
        });

        await expect(cancelled).resolves.toEqual({ supported: false, reason: 'error' });
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
            .mockImplementationOnce((input: Readonly<{ signal?: AbortSignal }>) => new Promise<never>((_resolve, reject) => {
                input.signal?.addEventListener('abort', () => {
                    reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
                }, { once: true });
            }));
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
                timeoutMs: 35_000,
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

    it('routes structured-message actions through the canonical generation-leased daemon RPC', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({ ok: true, result: { opened: true } });
        const { machinePluginStructuredMessageActionExecute } = await import('./machineContributionRegistryProjection');
        const abortController = new AbortController();

        await expect(machinePluginStructuredMessageActionExecute('machine-1', {
            serverId: 'server-a',
            expectedGeneration: '7',
            qualifiedActionId: 'acme.preview/open-preview',
            input: { previewId: 'preview-1' },
            expectedContributorImmutableGenerationId: 'contributor-generation-a',
            sessionId: 'session-1',
            executionSurface: 'ui',
            invocation: {
                kind: 'mountedPluginSurface',
                mountedBinding: {
                    contributionLocalId: 'message-preview',
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
                expectedGeneration: '7',
                qualifiedActionId: 'acme.preview/open-preview',
                input: { previewId: 'preview-1' },
                expectedContributorImmutableGenerationId: 'contributor-generation-a',
                sessionId: 'session-1',
                executionSurface: 'ui',
                invocation: {
                    kind: 'mountedPluginSurface',
                    mountedBinding: {
                        contributionLocalId: 'message-preview',
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
            expectedGeneration: '7',
            qualifiedActionId: 'acme.preview/open-preview',
            executionSurface: 'ui',
        })).resolves.toEqual({ supported: true, result: { ok: true, result: null } });
        await expect(machinePluginStructuredMessageActionExecute('machine-1', {
            serverId: 'server-a',
            expectedGeneration: '7',
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
            expectedGeneration: '7',
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
            expectedGeneration: '7',
            qualifiedActionId: 'acme.preview/open-preview',
            input: null,
            executionSurface: 'ui',
        })).resolves.toEqual({ supported: false, reason: 'not-supported' });
    });

    it('routes a current grouped Composer attachment prepare request through the registry projection RPC', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            ok: true,
            attachment: { pluginId: 'acme.issues', localId: 'issue' },
            result: {
                attachments: [{
                    instanceId: 'issue-42',
                    status: 'ready',
                    value: { issueId: 42 },
                    presentation: { label: 'Issue #42' },
                }],
            },
        });
        const { machinePluginComposerAttachmentPrepare } = await import('./machineContributionRegistryProjection');
        const abortController = new AbortController();

        await expect(machinePluginComposerAttachmentPrepare('machine-1', {
            serverId: 'server-a',
            expectedGeneration: '7',
            attachment: { pluginId: 'acme.issues', localId: 'issue' },
            request: {
                sessionId: 'session-1',
                localId: 'pending-1',
                attachments: [{
                    instanceId: 'issue-42',
                    key: '42',
                    value: { issueId: 42 },
                }],
            },
            signal: abortController.signal,
        })).resolves.toEqual({
            supported: true,
            result: {
                ok: true,
                attachment: { pluginId: 'acme.issues', localId: 'issue' },
                result: {
                    attachments: [{
                        instanceId: 'issue-42',
                        status: 'ready',
                        value: { issueId: 42 },
                        presentation: { label: 'Issue #42' },
                    }],
                },
            },
        });
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-a',
            method: RPC_METHODS.DAEMON_PLUGIN_COMPOSER_ATTACHMENT_PREPARE,
            payload: {
                machineId: 'machine-1',
                expectedGeneration: '7',
                attachment: { pluginId: 'acme.issues', localId: 'issue' },
                request: {
                    sessionId: 'session-1',
                    localId: 'pending-1',
                    attachments: [{
                        instanceId: 'issue-42',
                        key: '42',
                        value: { issueId: 42 },
                    }],
                },
            },
            signal: abortController.signal,
        }));
    });

    it('preserves daemon-owned stale-generation failure while classifying a cancelled prepare transport', async () => {
        machineRpcWithServerScopeMock
            .mockResolvedValueOnce({
                ok: false,
                code: 'stale_generation',
                reason: 'stale_generation',
            })
            .mockRejectedValueOnce(Object.assign(new Error('cancelled'), { code: 'MACHINE_RPC_ABORTED' }));
        const { machinePluginComposerAttachmentPrepare } = await import('./machineContributionRegistryProjection');
        const request = {
            serverId: 'server-a',
            expectedGeneration: '7',
            attachment: { pluginId: 'acme.issues', localId: 'issue' },
            request: {
                sessionId: 'session-1',
                localId: 'pending-1',
                attachments: [{ instanceId: 'issue-42', key: '42', value: { issueId: 42 } }],
            },
        };

        await expect(machinePluginComposerAttachmentPrepare('machine-1', request)).resolves.toEqual({
            supported: true,
            result: { ok: false, code: 'stale_generation', reason: 'stale_generation' },
        });
        await expect(machinePluginComposerAttachmentPrepare('machine-1', {
            ...request,
            signal: new AbortController().signal,
        })).resolves.toEqual({ supported: false, reason: 'aborted' });
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
            expectedGeneration: '7',
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
                expectedGeneration: '7',
                qualifiedActionId: 'acme.preview/configure-account',
                fieldPath: 'credentialRef',
            },
        }));
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
            expectedGeneration: '7',
            callerPluginId: 'acme.preview',
            resource: { pluginId: 'acme.preview', localId: 'live-activity' },
            context,
        });
        await machinePluginUiResourceWatchOpen('machine-1', {
            serverId: 'server-a',
            expectedGeneration: '7',
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
        machineRpcWithServerScopeMock.mockRejectedValueOnce(Object.assign(
            new Error('opaque transport failure'),
            { code: 'MACHINE_RPC_TIMEOUT' },
        ));
        const { machinePluginUiResourceRead } = await import('./machineContributionRegistryProjection');

        await expect(machinePluginUiResourceRead('machine-1', {
            serverId: 'server-a',
            expectedGeneration: '7',
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
            expectedGeneration: '7',
            qualifiedActionId: 'acme.preview/configure-account',
            fieldPath: 'credentialRef',
        })).resolves.toEqual({ supported: false, reason: 'not-supported' });
    });

    it('includes the resolved React Native host runtime identity on native requests', async () => {
        await installReactNativeRuntimeMocks('ios');
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            protocolVersion: 1,
            projection: { v: 1, agentsById: {}, backendsById: {} },
        });
        const { machineContributionRegistryProjectionDescribe } = await import('./machineContributionRegistryProjection');

        await machineContributionRegistryProjectionDescribe('machine-1', { serverId: 'server-a' });

        const request = machineRpcWithServerScopeMock.mock.calls.at(-1)?.[0] as {
            payload?: Record<string, unknown>;
        };
        expect(request.payload).toMatchObject({
            machineId: 'machine-1',
            reactNativeHostRuntimeIdentity: {
                platform: 'ios',
                channel: 'internal',
                appVersion: '0.2.1',
                nativeApplicationVersion: '0.2.0',
                nativeBuildVersion: '101',
                applicationId: 'dev.happier.app',
                reactNativeVersion: '0.83.4',
                expoRuntimeVersion: 'runtime-55',
                availableNativeCapabilities: [],
            },
        });
        expect(request.payload?.reactNativeHostRuntimeIdentity).not.toHaveProperty('scriptManagerRuntimeIntegrated');
    });

    it('omits native identity but reports only observed web runtime capabilities on web requests', async () => {
        await installReactNativeRuntimeMocks('web');
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            protocolVersion: 1,
            projection: { v: 1, agentsById: {}, backendsById: {} },
        });
        const { machineContributionRegistryProjectionDescribe } = await import('./machineContributionRegistryProjection');

        await machineContributionRegistryProjectionDescribe('machine-1', { serverId: 'server-a' });

        const request = machineRpcWithServerScopeMock.mock.calls.at(-1)?.[0] as {
            payload?: Record<string, unknown>;
        };
        // Web requests omit the native RN identity but report the real web
        // executable loader capability so the daemon can project loadability.
        expect(request.payload).not.toHaveProperty('reactNativeHostRuntimeIdentity');
        expect(request.payload).toMatchObject({
            machineId: 'machine-1',
            reactNativeWebLoaderCapability: {
                integrated: true,
                installedArtifactLoaderAvailable: true,
            },
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
                backendsById: {},
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

    it('receives an active predecessor external-session source through the canonical response normalizer', async () => {
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
                                    passthrough: true,
                                },
                                key: { segments: [{ kind: 'literal', value: 'acmeArchive' }] },
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
