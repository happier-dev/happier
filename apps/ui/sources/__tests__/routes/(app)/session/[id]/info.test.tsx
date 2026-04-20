import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';
import { createStorageModuleMock } from '@/dev/testkit/mocks/storage';
import type { LocalSettings } from '@/sync/domains/settings/localSettings';
import { installSessionRouteCommonModuleMocks } from './sessionRouteTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let mockSessionId = 'session-1';
let mockServerId: string | undefined;
let mockSession: any = null;
let isDataReady = true;
let sessionHydrated = true;
const allSessionsState = vi.hoisted(() => ({
    current: [] as any[],
}));
const allMachinesState = vi.hoisted(() => ({
    current: [] as any[],
}));
const routerPushSpy = vi.fn();
const routerBackSpy = vi.fn();
const safeRouterBackSpy = vi.fn();
const readMachineTargetForSessionSpy = vi.fn();
const resolveSessionTargetServerIdSpy = vi.fn();
const resolveServerIdForSessionIdFromLocalCacheSpy = vi.fn();
const machineRpcWithServerScopeSpy = vi.fn();
const machineContributionRegistryProjectionDescribeMock = vi.fn(async (..._args: unknown[]): Promise<any> => ({ supported: false, reason: 'not-supported' }));
const useSessionExecutionRunsSupportedSpy = vi.fn<(sessionId: string, sessionServerId?: string | null) => boolean>(() => false);
type CreateDefaultActionExecutorConfig = Readonly<{
    resolveServerIdForSessionId?: (sessionId: string) => string | null;
    openSession?: (sessionId: string) => void;
}>;
const createDefaultActionExecutorSpy = vi.fn((_config: CreateDefaultActionExecutorConfig) => ({}));
const sessionStopSpy = vi.fn(async () => ({ success: true }));
const sessionArchiveSpy = vi.fn(async () => ({ success: true, archivedAt: 1 }));
const modalAlertSpy = vi.fn();
const modalConfirmSpy = vi.fn(async () => true);
const applySessionListRenderablePatchesSpy = vi.fn();
let hideInactiveSessions = false;
let pinnedSessionKeysV1: unknown = null;
let acpCatalogSettingsV1: unknown = null;
let backendEnabledByTargetKey: unknown = null;
let resolvedServerId = 'server-1';
let sessionHandoffFeatureEnabled = false;
let serverFeaturesSnapshot: any = {
    status: 'ready',
    features: {
        features: {
            sessions: {
                enabled: true,
                handoff: {
                    enabled: true,
                },
            },
            machines: {
                enabled: true,
                transfer: {
                    enabled: true,
                    directPeer: {
                        enabled: true,
                    },
                    serverRouted: {
                        enabled: false,
                    },
                },
            },
        },
        capabilities: {},
    },
};
let mockAgentCore: any = {
    displayNameKey: 'agentInput.agent.claude',
    resume: {},
    ui: { agentPickerIconName: 'code-slash-outline' },
};
const AnimatedValue = vi.hoisted(
    () =>
        class AnimatedValue {
            constructor(_value: unknown) {}

            setValue(_value: unknown) {}

            interpolate(_config: unknown) {
                return 1;
            }
        },
);
const mockResolveAgentIdFromFlavor = vi.fn<(flavor: string | null | undefined) => string | undefined>(() => 'claude');
const useSessionSpy = vi.fn<(sessionId: string) => any>(() => mockSession);

const routerMock = createExpoRouterMock({
    router: {
        push: routerPushSpy,
        back: routerBackSpy,
        replace: vi.fn(),
        setParams: vi.fn(),
    },
    params: () => ({
        id: mockSessionId,
        serverId: mockServerId,
    }),
});

installSessionRouteCommonModuleMocks({
    router: async () => routerMock.module,
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: 'View',
            Animated: {
                View: 'AnimatedView',
                Value: AnimatedValue,
                loop: vi.fn(() => ({ start: vi.fn() })),
                sequence: vi.fn(() => ({ start: vi.fn() })),
                timing: vi.fn(() => ({ start: vi.fn() })),
            },
        });
    },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            confirmResult: true,
            spies: {
                alert: modalAlertSpy,
                confirm: modalConfirmSpy,
            },
        }).module;
    },
    storageModule: async (importOriginal) =>
        createStorageModuleMock({
            importOriginal,
            overrides: {
                storage: {
                    getState: () => ({
                        sessions: { [mockSessionId]: mockSession },
                        machines: {},
                        settings: {},
                        concurrentSessionListCacheByServerId: {},
                        sessionListIndexByServerId: {},
                        sessionListRowStateByServerId: {},
                        applySessionListRenderablePatches: applySessionListRenderablePatchesSpy,
                    }),
                } as any,
                useSession: (sessionId: string) => useSessionSpy(sessionId),
                useIsDataReady: () => isDataReady,
                useAllSessions: () => allSessionsState.current,
                useAllMachines: () => allMachinesState.current,
                useProjectForSession: () => null,
                useLocalSetting: <K extends keyof LocalSettings>(name: K): LocalSettings[K] => {
                    if (name === 'devModeEnabled') {
                        return false as LocalSettings[K];
                    }
                    return null as unknown as LocalSettings[K];
                },
                useSetting: (key: string) => {
                    if (key === 'hideInactiveSessions') {
                        return hideInactiveSessions;
                    }
                    if (key === 'pinnedSessionKeysV1') {
                        return pinnedSessionKeysV1;
                    }
                    if (key === 'acpCatalogSettingsV1') {
                        return acpCatalogSettingsV1;
                    }
                    if (key === 'backendEnabledByTargetKey') {
                        return backendEnabledByTargetKey;
                    }
                    return null;
                },
            },
        }),
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
    Octicons: 'Octicons',
}));

vi.mock('@/sync/ops/sessionMachineTarget', () => ({
    readMachineTargetForSession: (sessionId: string) => readMachineTargetForSessionSpy(sessionId),
}));

vi.mock('@/hooks/session/useHydrateSessionForRoute', () => ({
    useHydrateSessionForRoute: () => sessionHydrated,
}));
vi.mock('@/utils/navigation/safeRouterBack', () => ({
    safeRouterBack: (...args: any[]) => safeRouterBackSpy(...args),
}));

vi.mock('@/components/ui/text/Text', () => ({ Text: (props: any) => React.createElement('Text', props, props.children) }));
vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => React.createElement('Item', { ...props, testID: props.testID ?? props.title }, props.children),
}));
vi.mock('@/components/ui/lists/ItemGroup', () => ({ ItemGroup: 'ItemGroup' }));
vi.mock('@/components/ui/lists/ItemList', () => ({ ItemList: 'ItemList' }));
vi.mock('@/components/ui/avatar/Avatar', () => ({
    Avatar: (props: any) => React.createElement('Avatar', { ...props, testID: props.testID ?? 'session-info-avatar' }),
}));
vi.mock('@/components/ui/media/CodeView', () => ({ CodeView: 'CodeView' }));
vi.mock('@/components/sessions/info/SessionRetentionNotice', () => ({ SessionRetentionNotice: 'SessionRetentionNotice' }));
vi.mock('@/hooks/ui/useHappyAction', () => ({ useHappyAction: (fn: any) => [false, fn] }));
vi.mock('@/sync/ops', () => ({
    sessionArchiveWithServerScope: sessionArchiveSpy,
    sessionDelete: vi.fn(),
    sessionRename: vi.fn(),
    sessionStop: sessionStopSpy,
    sessionStopWithServerScope: sessionStopSpy,
}));

vi.mock('@/sync/ops/machineContributionRegistryProjection', () => ({
    machineContributionRegistryProjectionDescribe: (...args: any[]) => machineContributionRegistryProjectionDescribeMock(...args),
}));
vi.mock('@/agents/catalog/catalog', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/agents/catalog/catalog')>();
    return {
        ...actual,
        DEFAULT_AGENT_ID: 'claude',
        getAgentCore: () => mockAgentCore,
        resolveAgentIdFromFlavor: (flavor: string | null | undefined) => mockResolveAgentIdFromFlavor(flavor),
    };
});
vi.mock('@/hooks/session/useSessionSharingSupport', () => ({ useSessionSharingSupport: () => false }));
vi.mock('@/hooks/server/useAutomationsSupport', () => ({ useAutomationsSupport: () => ({ enabled: false }) }));
vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (featureId: string) => {
        if (featureId === 'sessions.handoff') {
            return sessionHandoffFeatureEnabled;
        }
        return false;
    },
}));
vi.mock('@/hooks/server/useSessionExecutionRunsSupported', () => ({
    useSessionExecutionRunsSupported: (sessionId: string, sessionServerId?: string | null) =>
        useSessionExecutionRunsSupportedSpy(sessionId, sessionServerId),
}));
vi.mock('@/sync/ops/actions/defaultActionExecutor', () => ({ createDefaultActionExecutor: (config: CreateDefaultActionExecutorConfig) => createDefaultActionExecutorSpy(config) }));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId', () => ({
    resolvePreferredServerIdForSessionId: (sessionId: string) => resolveSessionTargetServerIdSpy(sessionId),
}));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/resolveServerIdForSessionIdFromLocalCache', () => ({
    resolveServerIdForSessionIdFromLocalCache: (sessionId: string) => resolveServerIdForSessionIdFromLocalCacheSpy(sessionId),
}));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: (...args: unknown[]) => machineRpcWithServerScopeSpy(...args),
}));
vi.mock('@/sync/domains/features/featureDecisionRuntime', () => ({
    useServerFeaturesSnapshotForServerId: () => serverFeaturesSnapshot,
}));
vi.mock('@/sync/domains/settings/actionsSettings', () => ({ isActionEnabledInState: () => true }));
vi.mock('@/sync/domains/sessionFork/forkUiSupport', () => ({ canForkConversation: () => true }));
vi.mock('@/sync/domains/sessionFork/executeSessionForkAction', () => ({ executeSessionForkAction: vi.fn() }));
vi.mock('@/sync/domains/sessionHandoff/handoffUiSupport', () => ({ canHandoffConversation: () => true }));
vi.mock('@/sync/domains/sessionHandoff/runSessionHandoffPickerFlow', () => ({ runSessionHandoffPickerFlow: vi.fn() }));
vi.mock('@happier-dev/protocol', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@happier-dev/protocol')>();
    return {
        ...actual,
        getActionSpec: () => ({
            id: 'session.handoff',
            title: 'Hand off session',
            description: 'Move the current session',
        }),
    };
});
vi.mock('@happier-dev/agents', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@happier-dev/agents')>();
    return {
        ...actual,
        resolveAgentIdFromSessionMetadata: (metadata: Record<string, unknown> | null | undefined) => {
            const runtimeDescriptor = metadata?.agentRuntimeDescriptorV1 as any;
            return typeof runtimeDescriptor?.providerId === 'string' ? runtimeDescriptor.providerId : null;
        },
    };
});
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));
vi.mock('@/utils/sessions/sessionUtils', () => ({
    getSessionName: () => 'name',
    useSessionStatus: () => ({
        isConnected: true,
        statusText: 'Connected',
        statusColor: 'green',
        statusDotColor: 'green',
        isPulsing: false,
    }),
    formatOSPlatform: () => 'macOS',
    formatPathRelativeToHome: (p: string) => p,
    getSessionAvatarId: () => 'id',
}));
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn() }));
vi.mock('@/utils/system/versionUtils', () => ({ isVersionSupported: () => true, MINIMUM_CLI_VERSION: '0.0.0' }));
vi.mock('@/utils/sessions/terminalSessionDetails', () => ({ getAttachCommandForSession: () => null, getTmuxFallbackReason: () => null, getTmuxTargetForSession: () => null }));
vi.mock('@/utils/errors/errors', () => ({ HappyError: class HappyError extends Error {} }));
vi.mock('@/sync/domains/profiles/profileUtils', () => ({ resolveProfileById: () => null }));
vi.mock('@/components/profiles/profileDisplay', () => ({ getProfileDisplayName: () => 'profile' }));
vi.mock('@/components/ui/layout/layout', () => ({ layout: { screenPaddingHorizontal: 16 } }));

describe('/session/[id]/info', () => {
    beforeEach(() => {
        mockSessionId = 'session-1';
        mockServerId = undefined;
        mockSession = null;
        isDataReady = true;
        sessionHydrated = true;
        routerPushSpy.mockReset();
        routerBackSpy.mockReset();
        safeRouterBackSpy.mockReset();
        readMachineTargetForSessionSpy.mockReset();
        readMachineTargetForSessionSpy.mockReturnValue(null);
        sessionStopSpy.mockClear();
        sessionArchiveSpy.mockClear();
        modalAlertSpy.mockClear();
        modalConfirmSpy.mockClear();
        resolveSessionTargetServerIdSpy.mockClear();
        resolveServerIdForSessionIdFromLocalCacheSpy.mockClear();
        machineRpcWithServerScopeSpy.mockClear();
        useSessionExecutionRunsSupportedSpy.mockClear();
        resolveSessionTargetServerIdSpy.mockImplementation(() => resolvedServerId);
        resolveServerIdForSessionIdFromLocalCacheSpy.mockImplementation(() => null);
        machineRpcWithServerScopeSpy.mockRejectedValue(new Error('unreachable'));
        hideInactiveSessions = false;
        pinnedSessionKeysV1 = null;
        acpCatalogSettingsV1 = null;
        backendEnabledByTargetKey = null;
        resolvedServerId = 'server-1';
        sessionHandoffFeatureEnabled = false;
        allSessionsState.current = [];
        allMachinesState.current = [];
        serverFeaturesSnapshot = {
            status: 'ready',
            features: {
                features: {
                    sessions: {
                        enabled: true,
                        handoff: {
                            enabled: true,
                        },
                    },
                    machines: {
                        enabled: true,
                        transfer: {
                            enabled: true,
                            directPeer: {
                                enabled: true,
                            },
                            serverRouted: {
                                enabled: false,
                            },
                        },
                    },
                },
                capabilities: {},
            },
        };
        mockAgentCore = {
            displayNameKey: 'agentInput.agent.claude',
            resume: {},
            ui: { agentPickerIconName: 'code-slash-outline' },
        };
        useSessionSpy.mockClear();
        mockResolveAgentIdFromFlavor.mockReset();
        mockResolveAgentIdFromFlavor.mockReturnValue('claude');
        vi.clearAllMocks();
        useSessionExecutionRunsSupportedSpy.mockReturnValue(false);
        machineContributionRegistryProjectionDescribeMock.mockReset();
        machineContributionRegistryProjectionDescribeMock.mockResolvedValue({ supported: false, reason: 'not-supported' });
    });

    afterEach(() => {
        standardCleanup();
    });

    async function renderInfoScreen() {
        const Screen = (await import('@/app/(app)/session/[id]/info')).default;
        return renderScreen(<Screen />);
    }

    it('shows loading while the route hydration is still in progress', async () => {
        sessionHydrated = false;
        const screen = await renderInfoScreen();
        expect(screen.getTextContent()).toContain('common.loading');
    });

    it('fails open and renders the session when the record exists even if global hydration is still in progress', async () => {
        mockSession = {
            id: 'session-1234567890abcdef',
            active: false,
            accessLevel: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 1,
            metadata: {},
        };
        isDataReady = false;
        sessionHydrated = false;
        const screen = await renderInfoScreen();
        expect(screen.getTextContent()).not.toContain('common.loading');
        expect(screen.getTextContent()).toContain('name');
    });

    it('normalizes the route id before looking up the session', async () => {
        mockSessionId = ['session-2 '] as any;
        await renderInfoScreen();
        expect(useSessionSpy).toHaveBeenCalledWith('session-2');
    });

    it('threads the route session server id into the default action executor fallback', async () => {
        mockSession = {
            id: 'session-1',
            serverId: 'server-session-info',
            active: false,
            accessLevel: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 1,
            metadata: {},
        };
        resolveSessionTargetServerIdSpy.mockImplementation((_sessionId, fallbackServerId) => fallbackServerId ?? null);

        await renderInfoScreen();

        const executorConfig = (createDefaultActionExecutorSpy.mock.calls as Array<[CreateDefaultActionExecutorConfig]>).at(-1)?.[0];
        const resolved = await executorConfig?.resolveServerIdForSessionId?.('child-session');
        expect(resolved).toBe('server-session-info');
        expect(useSessionExecutionRunsSupportedSpy).toHaveBeenCalledWith('session-1', 'server-session-info');
    });

    it('uses daemon merged projection titles when resolving the default session action backend label', async () => {
        mockSession = {
            id: 'session-merged-projection',
            serverId: 'server-session-info',
            active: false,
            accessLevel: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 1,
            metadata: {
                machineId: 'machine-projection-1',
                flavor: 'claude',
                host: 'host-a',
                path: '/tmp/session',
                homeDir: '/home/me',
            },
        };

        machineContributionRegistryProjectionDescribeMock.mockResolvedValue({
            supported: true,
            projection: {
                v: 1,
                providersById: {
                    claude: {
                        providerId: 'claude',
                        title: 'Claude Provider',
                        subtitle: null,
                        channel: 'stable',
                        isBuiltIn: true,
                    },
                },
                backendsById: {
                    claude: {
                        backendId: 'claude',
                        providerId: 'claude',
                        title: 'Claude (daemon)',
                        subtitle: null,
                        providerAgentId: 'claude',
                        iconAgentId: 'claude',
                    },
                },
            },
        });

        const screen = await renderInfoScreen();
        await flushHookEffects({ cycles: 10 });

        const aiProviderItems = screen
            .findAllByType('Item' as any)
            .filter((node: any) => node.props?.title === 'sessionInfo.aiProvider');
        expect(aiProviderItems).toHaveLength(1);
        expect(aiProviderItems[0]?.props?.subtitle).toBe('Claude (daemon)');
    });

    it('fails closed and hides the handoff quick action when direct peer truth is runtime-unknown and server-routed fallback would make the UI untruthful', async () => {
        sessionHandoffFeatureEnabled = true;
        serverFeaturesSnapshot = {
            status: 'ready',
            features: {
                features: {
                    sessions: {
                        enabled: true,
                        handoff: {
                            enabled: true,
                        },
                    },
                    machines: {
                        enabled: true,
                        transfer: {
                            enabled: true,
                            directPeer: {
                                enabled: true,
                            },
                            serverRouted: {
                                enabled: true,
                            },
                        },
                    },
                },
                capabilities: {},
            },
        };
        mockSession = {
            id: 'session-1234567890abcdef',
            active: false,
            accessLevel: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 1,
            metadata: {
                machineId: 'machine_source',
                flavor: 'claude',
                claudeSessionId: 'claude-session-1',
            },
        };

        const screen = await renderInfoScreen();
        const handoffItems = screen.findAllByType('Item' as any).filter((node: any) => node.props?.title === 'Hand off session');
        expect(handoffItems).toHaveLength(0);
    });

    it('fails closed and hides the handoff quick action when the selected server only exposes direct-peer handoff transport', async () => {
        sessionHandoffFeatureEnabled = true;
        serverFeaturesSnapshot = {
            status: 'ready',
            features: {
                features: {
                    sessions: {
                        enabled: true,
                        handoff: {
                            enabled: true,
                        },
                    },
                    machines: {
                        enabled: true,
                        transfer: {
                            enabled: true,
                            directPeer: {
                                enabled: true,
                            },
                            serverRouted: {
                                enabled: false,
                            },
                        },
                    },
                },
                capabilities: {},
            },
        };
        mockSession = {
            id: 'session-1234567890abcdef',
            serverId: 'server_reactive_info',
            active: false,
            accessLevel: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 1,
            metadata: {
                machineId: 'machine_source',
                flavor: 'claude',
                claudeSessionId: 'claude-session-1',
            },
        };

        const screen = await renderInfoScreen();
        const handoffItems = screen.findAllByType('Item' as any).filter((node: any) => node.props?.title === 'Hand off session');
        expect(handoffItems).toHaveLength(0);
    });

    it('fails closed and hides the handoff quick action when server-routed transfer is the only transport the selected server advertises', async () => {
        sessionHandoffFeatureEnabled = true;
        serverFeaturesSnapshot = {
            status: 'ready',
            features: {
                features: {
                    sessions: {
                        enabled: true,
                        handoff: {
                            enabled: true,
                        },
                    },
                    machines: {
                        enabled: true,
                        transfer: {
                            enabled: true,
                            directPeer: {
                                enabled: false,
                            },
                            serverRouted: {
                                enabled: true,
                            },
                        },
                    },
                },
                capabilities: {},
            },
        };
        mockSession = {
            id: 'session-1234567890abcdef',
            active: false,
            accessLevel: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 1,
            metadata: {
                machineId: 'machine_source',
                flavor: 'claude',
                claudeSessionId: 'claude-session-1',
            },
        };

        const screen = await renderInfoScreen();
        const handoffItems = screen.findAllByType('Item' as any).filter((node: any) => node.props?.title === 'Hand off session');
        expect(handoffItems).toHaveLength(0);
    });

    it('reacts when machine-rpc direct-peer viability becomes available for the reachable machine target after metadata goes stale', async () => {
        sessionHandoffFeatureEnabled = true;
        resolvedServerId = 'server_reactive_info';
        resolveSessionTargetServerIdSpy.mockReturnValue('server_reactive_info');
        readMachineTargetForSessionSpy.mockReturnValue({
            machineId: 'machine_rebound',
            basePath: '/workspace/repo',
        });
        serverFeaturesSnapshot = {
            status: 'ready',
            features: {
                features: {
                    sessions: {
                        enabled: true,
                        handoff: {
                            enabled: true,
                        },
                    },
                    machines: {
                        enabled: true,
                        transfer: {
                            enabled: true,
                            directPeer: {
                                enabled: true,
                            },
                            serverRouted: {
                                enabled: false,
                            },
                        },
                    },
                },
                capabilities: {},
            },
        };
        mockSession = {
            id: 'session-1234567890abcdef',
            active: false,
            accessLevel: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 1,
            metadata: {
                machineId: 'machine_source',
                flavor: 'claude',
                claudeSessionId: 'claude-session-1',
            },
        };

        const screen = await renderInfoScreen();
        let handoffItems = screen.findAllByType('Item' as any).filter((node: any) => node.props?.title === 'Hand off session');
        expect(handoffItems).toHaveLength(0);

        const { recordCachedMachineRpcDirectRouteViable } = await import('@/sync/domains/transfers/runtime/transferRouteCache');
        await act(async () => {
            recordCachedMachineRpcDirectRouteViable({
                serverId: 'server_reactive_info',
                remoteMachineId: 'machine_rebound',
            });
        });
        await flushHookEffects({ cycles: 10 });

        handoffItems = screen.findAllByType('Item' as any).filter((node: any) => node.props?.title === 'Hand off session');
        expect(handoffItems).toHaveLength(1);
    });

    it('falls back to the canonical target server when the local server cache misses and still surfaces handoff after a scoped reachability probe succeeds', async () => {
        sessionHandoffFeatureEnabled = true;
        resolvedServerId = 'server_preferred_info';
        resolveSessionTargetServerIdSpy.mockReturnValue('server_preferred_info');
        machineRpcWithServerScopeSpy.mockResolvedValue({ ok: true });
        serverFeaturesSnapshot = {
            status: 'ready',
            features: {
                features: {
                    sessions: {
                        enabled: true,
                        handoff: {
                            enabled: true,
                        },
                    },
                    machines: {
                        enabled: true,
                        transfer: {
                            enabled: true,
                            directPeer: {
                                enabled: true,
                            },
                            serverRouted: {
                                enabled: false,
                            },
                        },
                    },
                },
                capabilities: {},
            },
        };
        mockSession = {
            id: 'session-1234567890abcdef',
            active: false,
            accessLevel: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 1,
            metadata: {
                machineId: 'machine_source',
                flavor: 'claude',
                claudeSessionId: 'claude-session-1',
            },
        };

        const screen = await renderInfoScreen();
        await flushHookEffects({ cycles: 10 });

        const handoffItems = screen.findAllByType('Item' as any).filter((node: any) => node.props?.title === 'Hand off session');
        expect(handoffItems).toHaveLength(1);
    });

    it('shows the configured ACP backend title in AI provider metadata when a concrete backend target is stored on the session', async () => {
        mockResolveAgentIdFromFlavor.mockReturnValue('customAcp');
        mockAgentCore = {
            resume: {},
            displayNameKey: 'agents.customAcp.displayName',
            ui: { agentPickerIconName: 'code-slash-outline' },
        };
        acpCatalogSettingsV1 = {
            v: 2,
            backends: [{
                id: 'qa-acp-stub',
                name: 'qa-acp-stub',
                title: 'QA ACP Stub Backend',
                command: 'qa-acp-stub',
                args: [],
                env: {},
                auth: { support: 'unsupported' },
                transportProfile: 'generic',
                capabilities: {
                    supportsLoadSession: false,
                    supportsModes: 'unknown',
                    supportsModels: 'unknown',
                    supportsConfigOptions: 'unknown',
                    promptImageSupport: 'unknown',
                },
                createdAt: 1,
                updatedAt: 1,
            }],
        };
        backendEnabledByTargetKey = {
            'acpBackend:qa-acp-stub': false,
        };
        mockSession = {
            id: 'session-1234567890abcdef',
            active: false,
            accessLevel: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 1,
            metadata: {
                flavor: 'customAcp',
                agent: 'customAcp',
                acpConfiguredBackendV1: {
                    v: 1,
                    updatedAt: 1,
                    backendId: 'qa-acp-stub',
                    title: 'QA ACP Stub Backend',
                },
            },
        };

        const screen = await renderInfoScreen();
        const providerItem = screen.findByTestId('sessionInfo.aiProvider');
        expect(providerItem?.props.subtitle).toBe('QA ACP Stub Backend');
    });

    it('shows the provider resume surfaces when the vendor resume id only exists in agentRuntimeDescriptorV1', async () => {
        mockResolveAgentIdFromFlavor.mockReturnValue('opencode');
        mockAgentCore = {
            resume: {
                vendorResumeIdField: 'opencodeSessionId',
                uiVendorResumeIdLabelKey: 'sessionInfo.openCodeSessionId',
                uiVendorResumeIdCopiedKey: 'sessionInfo.openCodeSessionIdCopied',
            },
            displayNameKey: 'agents.opencode.displayName',
            ui: { agentPickerIconName: 'code-slash-outline' },
        };
        mockSession = {
            id: 'session-1234567890abcdef',
            active: false,
            accessLevel: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 1,
            metadata: {
                flavor: 'opencode',
                agentRuntimeDescriptorV1: {
                    v: 1,
                    providerId: 'opencode',
                    provider: {
                        backendMode: 'server',
                        vendorSessionId: 'runtime-session-1234567890',
                    },
                },
            },
        };

        const screen = await renderInfoScreen();
        expect(screen.findByTestId('sessionInfo.openCodeSessionId')).toBeTruthy();
        expect(screen.findByTestId('sessionInfo.copyResumeCommand')).toBeTruthy();
    });

    it('infers the provider from agentRuntimeDescriptorV1 when flavor is missing', async () => {
        mockAgentCore = {
            resume: {
                vendorResumeIdField: 'opencodeSessionId',
                uiVendorResumeIdLabelKey: 'sessionInfo.openCodeSessionId',
                uiVendorResumeIdCopiedKey: 'sessionInfo.openCodeSessionIdCopied',
            },
            displayNameKey: 'agents.opencode.displayName',
            ui: { agentPickerIconName: 'code-slash-outline' },
        };
        mockSession = {
            id: 'session-1234567890abcdef',
            active: false,
            accessLevel: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 1,
            metadata: {
                agentRuntimeDescriptorV1: {
                    v: 1,
                    providerId: 'opencode',
                    provider: {
                        backendMode: 'server',
                        vendorSessionId: 'runtime-session-1234567890',
                    },
                },
            },
        };

        const screen = await renderInfoScreen();
        expect(screen.findByTestId('sessionInfo.openCodeSessionId')).toBeTruthy();
        const avatar = screen.findByTestId('session-info-avatar');
        if (!avatar) {
            throw new Error('expected session info avatar');
        }
        expect(avatar.props.flavor).toBe('opencode');
    });

    it('routes View Machine to the reachable machine target when session metadata is stale after handoff', async () => {
        readMachineTargetForSessionSpy.mockReturnValue({
            machineId: 'machine-target',
            basePath: '/workspace/repo',
        });
        mockSession = {
            id: 'session-1',
            active: true,
            accessLevel: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 1,
            metadata: {
                machineId: 'machine-source',
                path: '/workspace/repo',
                flavor: 'claude',
            },
        };

        const screen = await renderInfoScreen();
        const viewMachineItem = screen.findByTestId('sessionInfo.viewMachine');
        expect(viewMachineItem).toBeTruthy();
        expect(viewMachineItem?.props.subtitleAccessory).toBeTruthy();
        expect(viewMachineItem?.props.subtitleAccessory?.props.testID).toBe('sessionInfo.viewMachineTargetMachineId');
        expect(viewMachineItem?.props.subtitleAccessory?.props.children).toBe('machine-target');
        expect(screen.findByTestId('sessionInfo.path')).toBeTruthy();

        screen.pressByTestId('sessionInfo.viewMachine');

        expect(routerPushSpy).toHaveBeenCalledWith('/machine/machine-target');
    });

    it('always shows the View session log action even when developer mode is disabled', async () => {
        mockSession = {
            id: 'session-1',
            active: false,
            accessLevel: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 1,
            metadata: {},
        };

        const screen = await renderInfoScreen();
        expect(screen.findByTestId('sessionInfo.viewSessionLogTitle')).toBeTruthy();
    });

    it('shows the session log path row when a sessionLogPath is present even when developer mode is disabled', async () => {
        mockSession = {
            id: 'session-1',
            active: false,
            accessLevel: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 1,
            metadata: {
                sessionLogPath: '/tmp/.happier/logs/session.log',
            },
        };

        const screen = await renderInfoScreen();
        expect(screen.findByTestId('sessionLog.logPathCopyLabel')).toBeTruthy();
    });

    it('stops without archiving even when inactive sessions are hidden and unpinned', async () => {
        mockServerId = 'server-b';
        hideInactiveSessions = true;
        pinnedSessionKeysV1 = [];
        mockSession = {
            id: 'session-1',
            active: true,
            accessLevel: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 1,
            metadata: {},
        };

        const screen = await renderInfoScreen();
        screen.pressByTestId('sessionInfo.stopSession');

        expect(modalAlertSpy).toHaveBeenCalledTimes(1);
        const actions = modalAlertSpy.mock.calls[0][2];
        await actions[1].onPress();

        expect(sessionStopSpy).toHaveBeenCalledWith('session-1', { serverId: 'server-b' });
        expect(modalConfirmSpy).not.toHaveBeenCalled();
        expect(sessionArchiveSpy).not.toHaveBeenCalled();
        expect(routerBackSpy).not.toHaveBeenCalled();
        expect(safeRouterBackSpy).toHaveBeenCalledTimes(2);
        expect(safeRouterBackSpy).toHaveBeenNthCalledWith(1, {
            router: expect.any(Object),
            fallbackHref: '/session/session-1?serverId=server-b',
        });
        expect(safeRouterBackSpy).toHaveBeenNthCalledWith(2, {
            router: expect.any(Object),
            fallbackHref: '/',
        });
    });

    it('stops with the cached owning server id when route scope and preferred scope are unavailable', async () => {
        mockServerId = undefined;
        hideInactiveSessions = true;
        pinnedSessionKeysV1 = [];
        resolvedServerId = 'server-cache-info';
        resolveSessionTargetServerIdSpy.mockReturnValue(null);
        resolveServerIdForSessionIdFromLocalCacheSpy.mockReturnValue('server-cache-info');
        mockSession = {
            id: 'session-1',
            active: true,
            accessLevel: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 1,
            metadata: {},
        };

        const screen = await renderInfoScreen();
        screen.pressByTestId('sessionInfo.stopSession');

        expect(modalAlertSpy).toHaveBeenCalledTimes(1);
        const actions = modalAlertSpy.mock.calls[0][2];
        await actions[1].onPress();

        expect(sessionStopSpy).toHaveBeenCalledWith('session-1', { serverId: 'server-cache-info' });
    });

    it('stops without prompting to archive when the session is pinned', async () => {
        mockServerId = 'server-b';
        hideInactiveSessions = true;
        pinnedSessionKeysV1 = ['server-1:session-1'];
        resolvedServerId = 'server-1';
        mockSession = {
            id: 'session-1',
            serverId: 'server-1',
            active: true,
            accessLevel: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 1,
            metadata: {},
        };

        const screen = await renderInfoScreen();
        screen.pressByTestId('sessionInfo.stopSession');

        expect(modalAlertSpy).toHaveBeenCalledTimes(1);
        const actions = modalAlertSpy.mock.calls[0][2];
        await actions[1].onPress();

        expect(sessionStopSpy).toHaveBeenCalledWith('session-1', { serverId: 'server-b' });
        expect(modalConfirmSpy).not.toHaveBeenCalled();
        expect(sessionArchiveSpy).not.toHaveBeenCalled();
        expect(routerBackSpy).not.toHaveBeenCalled();
        expect(safeRouterBackSpy).toHaveBeenCalledTimes(2);
        expect(safeRouterBackSpy).toHaveBeenNthCalledWith(1, {
            router: expect.any(Object),
            fallbackHref: '/session/session-1?serverId=server-b',
        });
        expect(safeRouterBackSpy).toHaveBeenNthCalledWith(2, {
            router: expect.any(Object),
            fallbackHref: '/',
        });
    });

    it('archives an inactive session and exits via the safe back helper', async () => {
        mockServerId = 'server-b';
        mockSession = {
            id: 'session-1',
            active: false,
            accessLevel: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 1,
            metadata: {},
            archivedAt: null,
        };

        const screen = await renderInfoScreen();
        screen.pressByTestId('sessionInfo.archiveSession');

        expect(modalAlertSpy).toHaveBeenCalledTimes(1);
        const actions = modalAlertSpy.mock.calls[0][2];
        await actions[1].onPress();

        expect(sessionArchiveSpy).toHaveBeenCalledWith('session-1', { serverId: 'server-b' });
        expect(routerBackSpy).not.toHaveBeenCalled();
        expect(safeRouterBackSpy).toHaveBeenCalledTimes(2);
        expect(safeRouterBackSpy).toHaveBeenNthCalledWith(1, {
            router: expect.any(Object),
            fallbackHref: '/session/session-1?serverId=server-b',
        });
        expect(safeRouterBackSpy).toHaveBeenNthCalledWith(2, {
            router: expect.any(Object),
            fallbackHref: '/',
        });
    });

    it('archives an active session by stopping it first and then archiving it', async () => {
        mockServerId = 'server-b';
        mockSession = {
            id: 'session-1',
            active: true,
            accessLevel: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 1,
            metadata: {},
        };

        const screen = await renderInfoScreen();
        screen.pressByTestId('sessionInfo.archiveSession');

        expect(modalAlertSpy).toHaveBeenCalledTimes(1);
        const actions = modalAlertSpy.mock.calls[0][2];
        await actions[1].onPress();

        expect(sessionStopSpy).toHaveBeenCalledWith('session-1', { serverId: 'server-b' });
        expect(sessionArchiveSpy).toHaveBeenCalledWith('session-1', { serverId: 'server-b' });
        expect(safeRouterBackSpy).toHaveBeenCalledTimes(2);
    });
});
