import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let mockSessionId = 'session-1';
let mockSession: any = null;
let isDataReady = true;
let sessionHydrated = true;
const routerPushSpy = vi.fn();
const readMachineTargetForSessionSpy = vi.fn();
let mockAgentCore: any = {
    resume: {},
    ui: { agentPickerIconName: 'code-slash-outline' },
};
const mockResolveAgentIdFromFlavor = vi.fn<(flavor: string | null | undefined) => string | undefined>(() => 'claude');
const useSessionSpy = vi.fn<(sessionId: string) => any>(() => mockSession);

vi.mock('expo-router', () => ({
    useLocalSearchParams: () => ({ id: mockSessionId }),
    useRouter: () => ({ push: routerPushSpy }),
}));

vi.mock('react-native', async (importOriginal) => {
    const rn = await importOriginal<typeof import('react-native')>();
    class AnimatedValue {
        constructor(public value = 1) {}
        setValue(next: number) {
            this.value = next;
        }
    }
    return {
        ...rn,
        View: 'View',
        Animated: {
            View: 'AnimatedView',
            Value: AnimatedValue,
            loop: vi.fn(() => ({ start: vi.fn() })),
            sequence: vi.fn(() => ({ start: vi.fn() })),
            timing: vi.fn(() => ({ start: vi.fn() })),
        },
    };
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
    Octicons: 'Octicons',
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                text: '#000',
                textSecondary: '#666',
                accent: { blue: '#00f', purple: '#80f' },
            },
        },
    }),
}));

vi.mock('@/sync/domains/state/storage', () => ({
    storage: { getState: () => ({}) },
    useSession: (sessionId: string) => useSessionSpy(sessionId),
    useIsDataReady: () => isDataReady,
    useLocalSetting: () => false,
    useSetting: () => null,
}));

vi.mock('@/sync/ops/sessionMachineTarget', () => ({
    readMachineTargetForSession: (sessionId: string) => readMachineTargetForSessionSpy(sessionId),
}));

vi.mock('@/hooks/session/useHydrateSessionForRoute', () => ({
    useHydrateSessionForRoute: () => sessionHydrated,
}));

vi.mock('@/components/ui/text/Text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/lists/Item', () => ({ Item: 'Item' }));
vi.mock('@/components/ui/lists/ItemGroup', () => ({ ItemGroup: 'ItemGroup' }));
vi.mock('@/components/ui/lists/ItemList', () => ({ ItemList: 'ItemList' }));
vi.mock('@/components/ui/avatar/Avatar', () => ({ Avatar: 'Avatar' }));
vi.mock('@/components/ui/media/CodeView', () => ({ CodeView: 'CodeView' }));
vi.mock('@/components/sessions/info/SessionRetentionNotice', () => ({ SessionRetentionNotice: 'SessionRetentionNotice' }));
vi.mock('@/hooks/ui/useHappyAction', () => ({ useHappyAction: () => [false, vi.fn()] }));
vi.mock('@/modal', () => ({ Modal: { alert: vi.fn(), confirm: vi.fn(), show: vi.fn() } }));
vi.mock('@/sync/ops', () => ({ sessionArchiveWithServerScope: vi.fn(), sessionDelete: vi.fn(), sessionRename: vi.fn(), sessionStop: vi.fn() }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/agents/catalog/catalog', () => ({
    DEFAULT_AGENT_ID: 'claude',
    getAgentCore: () => mockAgentCore,
    resolveAgentIdFromFlavor: (flavor: string | null | undefined) => mockResolveAgentIdFromFlavor(flavor),
}));
vi.mock('@/hooks/session/useSessionSharingSupport', () => ({ useSessionSharingSupport: () => false }));
vi.mock('@/hooks/server/useAutomationsSupport', () => ({ useAutomationsSupport: () => ({ enabled: false }) }));
vi.mock('@/hooks/server/useFeatureEnabled', () => ({ useFeatureEnabled: () => false }));
vi.mock('@/hooks/server/useSessionExecutionRunsSupported', () => ({ useSessionExecutionRunsSupported: () => false }));
vi.mock('@/sync/ops/actions/defaultActionExecutor', () => ({ createDefaultActionExecutor: () => ({}) }));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/resolveServerIdForSessionIdFromLocalCache', () => ({ resolveServerIdForSessionIdFromLocalCache: vi.fn() }));
vi.mock('@/sync/domains/settings/actionsSettings', () => ({ isActionEnabledInState: () => true }));
vi.mock('@/sync/domains/sessionFork/forkUiSupport', () => ({ canForkConversation: () => true }));
vi.mock('@/sync/domains/sessionFork/executeSessionForkAction', () => ({ executeSessionForkAction: vi.fn() }));
vi.mock('@/sync/domains/sessionHandoff/handoffUiSupport', () => ({ canHandoffConversation: () => true }));
vi.mock('@/sync/domains/sessionHandoff/runSessionHandoffPickerFlow', () => ({ runSessionHandoffPickerFlow: vi.fn() }));
vi.mock('@happier-dev/protocol', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@happier-dev/protocol')>();
    return { ...actual, getActionSpec: () => ({}) };
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
vi.mock('@/utils/sessions/sessionUtils', () => ({ getSessionName: () => 'name', useSessionStatus: () => ({ color: 'green' }), formatOSPlatform: () => 'macOS', formatPathRelativeToHome: (p: string) => p, getSessionAvatarId: () => 'id' }));
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
        mockSession = null;
        isDataReady = true;
        sessionHydrated = true;
        routerPushSpy.mockReset();
        readMachineTargetForSessionSpy.mockReset();
        readMachineTargetForSessionSpy.mockReturnValue(null);
        mockAgentCore = {
            resume: {},
            ui: { agentPickerIconName: 'code-slash-outline' },
        };
        useSessionSpy.mockClear();
        mockResolveAgentIdFromFlavor.mockReset();
        mockResolveAgentIdFromFlavor.mockReturnValue('claude');
        vi.clearAllMocks();
    });

    it('shows loading while the route hydration is still in progress', async () => {
        sessionHydrated = false;
        const Screen = (await import('@/app/(app)/session/[id]/info')).default;
        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<Screen />);
        });

        const texts = tree!.root.findAllByType('Text' as any).map((node: any) => node.props.children);
        expect(texts).toContain('common.loading');
    });

    it('normalizes the route id before looking up the session', async () => {
        mockSessionId = ['session-2 '] as any;
        const Screen = (await import('@/app/(app)/session/[id]/info')).default;
        await act(async () => {
            renderer.create(<Screen />);
        });

        expect(useSessionSpy).toHaveBeenCalledWith('session-2');
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

        const Screen = (await import('@/app/(app)/session/[id]/info')).default;
        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<Screen />);
        });

        const itemTitles = tree!.root.findAllByType('Item' as any).map((node: any) => node.props.title);
        expect(itemTitles).toContain('sessionInfo.openCodeSessionId');
        expect(itemTitles).toContain('sessionInfo.copyResumeCommand');
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

        const Screen = (await import('@/app/(app)/session/[id]/info')).default;
        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<Screen />);
        });

        const itemTitles = tree!.root.findAllByType('Item' as any).map((node: any) => node.props.title);
        expect(itemTitles).toContain('sessionInfo.openCodeSessionId');
        expect(mockResolveAgentIdFromFlavor).not.toHaveBeenCalled();
        const avatar = tree!.root.findByType('Avatar' as any);
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

        const Screen = (await import('@/app/(app)/session/[id]/info')).default;
        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<Screen />);
        });

        const viewMachineItem = tree!.root.findAllByType('Item' as any).find((node: any) => node.props.title === 'sessionInfo.viewMachine');
        expect(viewMachineItem).toBeTruthy();

        await act(async () => {
            viewMachineItem!.props.onPress();
        });

        expect(routerPushSpy).toHaveBeenCalledWith('/machine/machine-target');
    });
});
