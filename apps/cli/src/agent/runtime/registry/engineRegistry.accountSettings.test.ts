import { accountSettingsParse } from '@happier-dev/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Credentials } from '@/persistence';
import {
    getActiveAccountSettingsSnapshot,
    setActiveAccountSettingsSnapshot,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { resolveBackendEngineAdapterResolution } from './engineRegistry';

const mocks = vi.hoisted(() => ({
    readCredentials: vi.fn(),
    updateAccountSettingsV2WithRetry: vi.fn(),
    resolveMergedContributionRegistry: vi.fn(),
    resolveExecutablePluginRuntimeRegistry: vi.fn(),
    resolvePluginBackendSurfaceHandlers: vi.fn(),
    pluginReloadControllerState: vi.fn(),
}));

vi.mock('@/persistence', () => ({
    readCredentials: mocks.readCredentials,
}));

vi.mock('@/settings/accountSettings/updateAccountSettingsV2WithRetry', () => ({
    updateAccountSettingsV2WithRetry: mocks.updateAccountSettingsV2WithRetry,
}));

vi.mock('../../../plugins/projection/registry/createResolvedContributionRegistry', () => ({
    resolveMergedContributionRegistry: mocks.resolveMergedContributionRegistry,
}));

vi.mock('../../../plugins/runtime/resolveExecutablePluginRuntimeRegistry', () => ({
    resolveExecutablePluginRuntimeRegistry: mocks.resolveExecutablePluginRuntimeRegistry,
}));

vi.mock('../../../plugins/runtime/reload/singleton', () => ({
    pluginReloadController: {
        getState: mocks.pluginReloadControllerState,
    },
}));

vi.mock('./resolvePluginBackendSurfaceHandlers', () => ({
    resolvePluginBackendSurfaceHandlers: mocks.resolvePluginBackendSurfaceHandlers,
}));

type ObservedPluginContext = Readonly<{
    account?: Readonly<{
        settings?: Readonly<{
            set?: (key: string, value: unknown) => Promise<unknown>;
        }>;
    }>;
}>;

function createCredentials(token = 'token-1'): Credentials {
    return {
        token,
        encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
    };
}

describe('engineRegistry account settings context', () => {
    beforeEach(() => {
        vi.resetModules();
        mocks.readCredentials.mockReset();
        mocks.updateAccountSettingsV2WithRetry.mockReset();
        mocks.resolveMergedContributionRegistry.mockReset();
        mocks.resolveExecutablePluginRuntimeRegistry.mockReset();
        mocks.resolvePluginBackendSurfaceHandlers.mockReset();
        mocks.pluginReloadControllerState.mockReset();
        mocks.pluginReloadControllerState.mockReturnValue({
            generation: 0,
            activeRegistry: null,
            lastResult: null,
        });
        setActiveAccountSettingsSnapshot({
            source: 'none',
            settings: accountSettingsParse({ schemaVersion: 6 }),
            settingsVersion: 0,
            loadedAtMs: 0,
            settingsSecretsReadKeys: [],
            scopeKey: 'previous-scope',
        });
    });

    it('stores plugin account setting updates with the authenticated credential scope key', async () => {
        const credentials = createCredentials();
        let observedContext: ObservedPluginContext | null = null;
        let setAccountSetting: ((key: string, value: unknown) => Promise<unknown>) | null = null;

        mocks.readCredentials.mockResolvedValue(credentials);
        mocks.updateAccountSettingsV2WithRetry.mockImplementation(async ({ mutate }: {
            mutate: (settings: Readonly<Record<string, unknown>>) => Record<string, unknown>;
        }) => {
            const settings = accountSettingsParse(mutate({ schemaVersion: 6 }));
            return { version: 3, settings };
        });
        mocks.resolvePluginBackendSurfaceHandlers.mockResolvedValue({
            surfaces: {
                terminalRuntime: null,
                externalSession: null,
                attach: null,
                handoff: null,
                fork: null,
                checkpoint: null,
            },
            diagnostics: [],
        });

        const providerContribution = {
            id: 'acme.sample.provider',
            provenance: 'external',
            source: { kind: 'path' },
            definition: {
                kindVersion: 1,
                id: 'acme.sample.provider',
                ownedBackendIds: ['acme.sample.backend'],
            },
            richDefinition: {
                source: 'plugin',
                definition: {
                    kindVersion: 1,
                    id: 'acme.sample.provider',
                    ownedBackendIds: ['acme.sample.backend'],
                },
            },
            runtimeSpec: null,
            pluginId: 'acme.sample',
            daemonEntryPath: '/tmp/acme.sample/daemon.mjs',
        };
        const backendContribution = {
            id: 'acme.sample.backend',
            providerId: 'acme.sample.provider',
            provenance: 'external',
            source: { kind: 'path' },
            definition: {
                kindVersion: 1,
                id: 'acme.sample.backend',
                providerId: 'acme.sample.provider',
            },
            richDefinition: {
                source: 'plugin',
                definition: {
                    kindVersion: 1,
                    id: 'acme.sample.backend',
                    providerId: 'acme.sample.provider',
                    runtimeKind: 'native',
                    capabilities: {},
                    surfaceHandlers: [],
                },
            },
            runtimeKind: 'native',
            surfaceHandlers: [],
            pluginId: 'acme.sample',
            daemonEntryPath: '/tmp/acme.sample/daemon.mjs',
        };
        const registry = {
            providers: [providerContribution],
            backends: [backendContribution],
            actions: [],
            hookRegistrations: [],
            surfaceHandlersByBackendId: new Map(),
            catalogEntriesById: {},
            providerDefinitionsById: new Map([
                ['acme.sample.provider', providerContribution],
            ]),
            backendDefinitionsById: new Map([
                ['acme.sample.backend', backendContribution],
            ]),
            pluginDiagnosticsByPluginId: {},
        };
        mocks.resolveMergedContributionRegistry.mockResolvedValue(registry);
        mocks.resolveExecutablePluginRuntimeRegistry.mockResolvedValue({
            contributes: registry,
            actionHandlersByActionId: new Map(),
            hookHandlersByHookId: new Map(),
            runtimeCoreHandlersByBackendId: new Map(),
            backendEnginesByBackendId: new Map([
                ['acme.sample.backend', {
                    pluginId: 'acme.sample',
                    registration: {
                        backendId: 'acme.sample.backend',
                        create: async (ctx: ObservedPluginContext) => {
                            observedContext = ctx;
                            setAccountSetting = ctx.account?.settings?.set ?? null;
                            return {
                                runtimeCore: {
                                    createSessionRuntime: async () => null,
                                    createExecutionRunBackend: () => ({
                                        provisionSession: vi.fn(async () => ({ sessionId: 'session-1' })),
                                        readResumeSupport: vi.fn(async () => false),
                                        sendPrompt: vi.fn(async () => undefined),
                                        cancel: vi.fn(async () => undefined),
                                        subscribeMessages: vi.fn(() => () => undefined),
                                        dispose: vi.fn(async () => undefined),
                                    }),
                                },
                            };
                        },
                    },
                }],
            ]),
            pluginDiagnosticsByPluginId: {},
            readHookEventEnvelopeV1: vi.fn(),
            dispose: vi.fn(async () => undefined),
        });

        const resolution = await resolveBackendEngineAdapterResolution('acme.sample.backend');
        const runtime = resolution?.engineAdapter.runtimeCore.createExecutionRunBackend({
            cwd: process.cwd(),
            backendId: 'acme.sample.backend',
            permissionMode: 'read_only',
        });

        expect(runtime).toEqual(expect.any(Object));
        expect(observedContext).toEqual(expect.any(Object));
        const accountSettingSetter = setAccountSetting as unknown;
        expect(accountSettingSetter).toEqual(expect.any(Function));
        if (typeof accountSettingSetter !== 'function') {
            throw new Error('Expected plugin account settings setter to be available');
        }
        await (accountSettingSetter as (key: string, value: unknown) => Promise<unknown>)('pushEnabled', true);

        expect(getActiveAccountSettingsSnapshot()).toMatchObject({
            settingsVersion: 3,
            scopeKey: resolveAccountSettingsScopeKey(credentials),
        });
    });
});
