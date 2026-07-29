import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

const machineRpcWithServerScopeMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: machineRpcWithServerScopeMock,
}));

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
    }

    it('routes projection.describe through server-scoped machine rpc', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            protocolVersion: 1,
            projection: { v: 1, agentsById: {}, backendsById: {} },
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
        });
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-a',
            method: RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE,
            payload: expect.objectContaining({ machineId: 'machine-1' }),
        }));
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
                storageScope: 'local',
                revision: '3',
                values: { endpoint: 'https://api.example.test' },
                redactedKeys: ['apiToken'],
            })
            .mockResolvedValueOnce({
                protocolVersion: 1,
                pluginId: 'acme.hooks',
                storageScope: 'local',
                revision: '4',
                values: { endpoint: 'https://api.changed.test' },
                redactedKeys: ['apiToken'],
            });
        const mod = await import('./machineContributionRegistryProjection');

        const snapshot = await mod.machinePluginSettingsGet('machine-1', {
            serverId: 'server-a',
            pluginId: 'acme.hooks',
        });
        const updated = await mod.machinePluginSettingsSet('machine-1', {
            serverId: 'server-a',
            pluginId: 'acme.hooks',
            fieldId: 'endpoint',
            value: 'https://api.changed.test',
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
            snapshot: expect.objectContaining({
                values: { endpoint: 'https://api.changed.test' },
                redactedKeys: ['apiToken'],
            }),
        });
        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(1, expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-a',
            method: RPC_METHODS.DAEMON_PLUGIN_SETTINGS_GET,
            payload: {
                machineId: 'machine-1',
                pluginId: 'acme.hooks',
            },
        }));
        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-a',
            method: RPC_METHODS.DAEMON_PLUGIN_SETTINGS_SET,
            payload: {
                machineId: 'machine-1',
                pluginId: 'acme.hooks',
                fieldId: 'endpoint',
                value: 'https://api.changed.test',
                expectedRevision: '3',
            },
        }));
    });

    it('routes structured-message resolution through the generation-leased daemon RPC', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            ok: false,
            code: 'plugin_structured_message_payload_invalid',
            reason: 'invalid_payload',
        });
        const { machinePluginStructuredMessageResolve } = await import('./machineContributionRegistryProjection');

        await expect(machinePluginStructuredMessageResolve('machine-1', {
            serverId: 'server-a',
            expectedGeneration: '7',
            kind: 'acme.preview/preview-card.v1',
            payload: { previewId: 42 },
            resourceRefs: ['preview-icon'],
            facts: { 'plugin.enabled': true, 'session.exists': true },
        })).resolves.toEqual({
            supported: true,
            resolution: {
                ok: false,
                code: 'plugin_structured_message_payload_invalid',
                reason: 'invalid_payload',
            },
        });
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-a',
            method: RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_RESOLVE,
            payload: expect.objectContaining({
                machineId: 'machine-1',
                expectedGeneration: '7',
                resourceRefs: ['preview-icon'],
            }),
        }));
    });

    it('propagates structured-message cancellation to the server-scoped RPC owner', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            ok: false,
            code: 'plugin_structured_message_unavailable',
            reason: 'unavailable',
        });
        const { machinePluginStructuredMessageResolve } = await import('./machineContributionRegistryProjection');
        const abortController = new AbortController();

        await machinePluginStructuredMessageResolve('machine-1', {
            serverId: 'server-a',
            expectedGeneration: '7',
            kind: 'acme.preview/preview-card.v1',
            payload: { previewId: 'preview-1' },
            facts: {},
            signal: abortController.signal,
        });

        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            signal: abortController.signal,
        }));
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
            sessionId: 'session-1',
            executionSurface: 'ui',
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
                sessionId: 'session-1',
                executionSurface: 'ui',
            },
            signal: abortController.signal,
        }));
    });

    it('fails closed when an older daemon does not expose structured-message RPC methods', async () => {
        machineRpcWithServerScopeMock
            .mockResolvedValueOnce({
                errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND,
                error: 'Method not found',
            })
            .mockResolvedValueOnce({
                errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND,
                error: 'Method not found',
            });
        const mod = await import('./machineContributionRegistryProjection');

        await expect(mod.machinePluginStructuredMessageResolve('machine-1', {
            serverId: 'server-a',
            expectedGeneration: '7',
            kind: 'acme.preview/preview-card.v1',
            payload: {},
            facts: {},
        })).resolves.toEqual({ supported: false, reason: 'not-supported' });
        await expect(mod.machinePluginStructuredMessageActionExecute('machine-1', {
            serverId: 'server-a',
            expectedGeneration: '7',
            qualifiedActionId: 'acme.preview/open-preview',
            input: null,
            executionSurface: 'ui',
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

    it('omits native identity but reports the installed web loader capability on web requests', async () => {
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
                        digest: 'sha256:manifest',
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
