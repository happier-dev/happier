import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ComposerAttachmentDraftV1 } from '@happier-dev/protocol';

import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { createDeferred, pressTestInstanceAsync, renderScreen, standardCleanup } from '@/dev/testkit';
import { createReactNativeWebMock } from '@/dev/testkit/mocks/reactNative';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';
import { createStorageModuleStub } from '@/dev/testkit/mocks/storage';
import { createTextModuleMock } from '@/dev/testkit/mocks/text';
import { createUnistylesMock } from '@/dev/testkit/mocks/unistyles';
import {
    resetSessionDraftValueCachesForTests,
    writeSessionDraftValue,
} from '@/sync/domains/input/draftValues/sessionDraftValueStore';
import {
    applyComposerPresentationTransaction,
    createComposerPresentationHostHandlers,
    readComposerPresentationSnapshot,
} from '@/components/sessions/presentation/sessionComposerPresentationTargets';
import type {
    PluginContributedActionController,
    PluginContributedActionDescriptor,
    PluginContributedActionOpenOutcome,
} from '@/components/plugins/actions/pluginContributedActionController';
import type { ComposerScopePluginPresentation } from '@/components/sessions/presentation/useComposerScopePluginPresentation';
import { localSettingsDefaults, type LocalSettings } from '@/sync/domains/settings/localSettings';
import { settingsDefaults, type Settings } from '@/sync/domains/settings/settings';

import { installSessionShellCommonModuleMocks } from './sessionShellTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const daemonMergedProjectionState = vi.hoisted(() => ({
    value: {
        inputs: null as unknown,
        phase: 'idle' as string,
    },
}));
const composerChipFactorySpy = vi.hoisted(() => vi.fn());
const currentSessionPresentationPropsSpy = vi.hoisted(() => vi.fn());
const pluginSurfaceHostPropsSpy = vi.hoisted(() => vi.fn());
const agentInputPropsSpy = vi.hoisted(() => vi.fn());
const machinePluginStructuredMessageActionExecuteMock = vi.hoisted(() => vi.fn());
const sessionSendMessageMock = vi.hoisted(() => vi.fn());
const sessionEnqueuePendingMessageMock = vi.hoisted(() => vi.fn());
const composerScopePluginPresentationSpy = vi.hoisted(() => vi.fn());
const composerScopePluginPresentationState = vi.hoisted(() => ({ value: null as ComposerScopePluginPresentation | null }));

vi.mock('@/agents/backendCatalog/getResolvedBackendCatalogEntries', () => ({
    getResolvedBackendCatalogEntries: () => [],
}));
vi.mock('@/agents/backendCatalog/useDaemonMergedProjectionInputs', () => ({
    useDaemonMergedProjectionInputs: () => daemonMergedProjectionState.value,
}));
vi.mock('@/components/plugins/actions/pluginContributedActionComposerChips', () => ({
    createPluginContributedActionComposerChips: (input: unknown) => {
        composerChipFactorySpy(input);
        return [];
    },
}));
vi.mock('@/sync/ops/machineContributionRegistryProjection', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/sync/ops/machineContributionRegistryProjection')>()),
    machinePluginStructuredMessageActionExecute: machinePluginStructuredMessageActionExecuteMock,
}));
vi.mock('@/components/sessions/presentation/CurrentSessionPresentationSurface', () => ({
    CurrentSessionPresentationSurface: (props: Record<string, unknown>) => {
        currentSessionPresentationPropsSpy(props);
        const renderComposerRegion = props.renderComposerRegion;
        const regions = Array.isArray(props.composerRegions)
            ? props.composerRegions.filter((region): region is Record<string, unknown> => (
                region !== null && typeof region === 'object'
            ))
            : [];
        const mountedRegions = typeof renderComposerRegion === 'function'
            ? regions
                .filter((region) => region.definition
                    && typeof region.definition === 'object'
                    && (region.definition as Record<string, unknown>).placement === props.placement)
                .map((region) => renderComposerRegion(region))
            : [];
        return React.createElement(
            React.Fragment,
            null,
            ...mountedRegions,
            React.createElement('CurrentSessionPresentationSurface', props),
        );
    },
}));
vi.mock('@/components/plugins/surfaces/PluginSurfaceHost', () => ({
    PluginSurfaceHost: (props: Record<string, unknown>) => {
        pluginSurfaceHostPropsSpy(props);
        return React.createElement('PluginSurfaceHost', props);
    },
}));
vi.mock('@/components/sessions/presentation/useComposerScopePluginPresentation', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/components/sessions/presentation/useComposerScopePluginPresentation')>();
    return {
        ...actual,
        useComposerScopePluginPresentation: (
            params: Parameters<typeof actual.useComposerScopePluginPresentation>[0],
        ) => {
            composerScopePluginPresentationSpy(params);
            return composerScopePluginPresentationState.value
                ?? actual.useComposerScopePluginPresentation(params);
        },
    };
});

// Some deps resolve `react-native-reanimated` into ESM entrypoints that use extensionless imports
// (not Node-safe). Stub both the package id and its resolved module entrypoint.
vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    return createReanimatedModuleMock();
});
vi.mock('react-native-reanimated/lib/module', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    return createReanimatedModuleMock();
});
vi.mock('react-native-reanimated/lib/module/index.js', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    return createReanimatedModuleMock();
});
vi.mock('react-native-reanimated/lib/module/index', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    return createReanimatedModuleMock();
});

const gestureHandlerState = vi.hoisted(() => ({
    gestures: [] as Array<{
        kind: string;
        config: Record<string, unknown>;
        handlers: {
            onEnd?: (event: { translationY: number; velocityY: number }) => void;
        };
    }>,
}));
const settingMutators = vi.hoisted(() => ({
    setMobileWorkspaceExperience: vi.fn(),
}));
const chatListPropsSpy = vi.hoisted(() => vi.fn());
const deviceTypeState = vi.hoisted(() => ({
    value: 'tablet' as 'phone' | 'tablet' | 'desktop',
}));
const safeAreaState = vi.hoisted(() => ({
    bottom: 0,
}));

vi.mock('react-native-gesture-handler', () => {
    function createGesture(kind: string) {
        const gesture = {
            kind,
            config: {} as Record<string, unknown>,
            handlers: {} as {
                onEnd?: (event: { translationY: number; velocityY: number }) => void;
            },
            minDistance(value: number) {
                gesture.config.minDistance = value;
                return gesture;
            },
            activeOffsetY(value: readonly [number, number]) {
                gesture.config.activeOffsetY = value;
                return gesture;
            },
            onEnd(handler: (event: { translationY: number; velocityY: number }) => void) {
                gesture.handlers.onEnd = handler;
                return gesture;
            },
        };
        gestureHandlerState.gestures.push(gesture);
        return gesture;
    }

    return {
        Gesture: {
            Pan: () => createGesture('pan'),
        },
        GestureDetector: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
            React.createElement('GestureDetector', props, props.children),
    };
});

vi.mock('react-native-worklets', () => ({
    scheduleOnRN: (fn: (...args: unknown[]) => void, ...args: unknown[]) => fn(...args),
}));

const themeColors = {
    text: '#000',
    textSecondary: '#666',
    textLink: '#00f',
    surface: '#fff',
    surfaceHigh: '#f5f5f5',
    surfaceSelected: '#eef4ff',
    divider: '#ddd',
    border: '#ddd',
    indigo: '#5856D6',
    radio: { active: '#007AFF' },
    accent: {
        blue: '#007AFF',
        green: '#34C759',
        orange: '#FF9500',
        yellow: '#FFCC00',
        red: '#FF3B30',
        indigo: '#5856D6',
        purple: '#AF52DE',
    },
    modal: { border: '#ddd' },
    input: { background: '#f5f5f5' },
    header: { tint: '#000' },
    status: { error: '#f00' },
    shadow: { color: '#000', opacity: 0.2 },
} as const;

const routerPushSpy = vi.fn();
let endpointConnectivityStatus: 'idle' | 'offline' | 'connecting' | 'online' | 'auth_failed' | 'shutting_down' = 'online';
let isDataReadyState = false;
let syncErrorState: {
    message: string;
    retryable: boolean;
    kind: 'auth' | 'config' | 'network' | 'server' | 'unknown';
    at: number;
    serverId?: string;
} | null = null;
let sessionState: any = {
    id: 's1',
    seq: 1,
    presence: 'online',
    active: true,
    accessLevel: 'edit',
    metadata: { machineId: 'm1', flavor: 'codex', version: '0.0.0', path: '/tmp', homeDir: '/tmp' },
    agentState: {},
};
const profileState = {
    id: 'prof_1',
    timestamp: 0,
    firstName: null,
    lastName: null,
    username: null,
    avatar: null,
    linkedProviders: [],
    connectedServices: [],
    connectedServicesV2: [],
    connectedServiceCredentialRevisionsV1: [],
};

installSessionShellCommonModuleMocks({
    reactNative: async () =>
        createReactNativeWebMock({
            View: 'View',
            Text: 'Text',
            Pressable: 'Pressable',
            ActivityIndicator: 'ActivityIndicator',
            Platform: {
                OS: 'web',
                select: (spec: Record<string, unknown>) =>
                    spec && Object.prototype.hasOwnProperty.call(spec, 'web')
                        ? (spec as any).web
                        : (spec as any).default,
            },
            useWindowDimensions: () => ({ width: 1200, height: 800 }),
        }),
    unistyles: async () =>
        createUnistylesMock({
            theme: themeColors,
            runtime: {
                hairlineWidth: 1,
            },
        }),
    text: async () =>
        createTextModuleMock({
            translate: (key: string) => key,
        }),
    router: async () =>
        createExpoRouterMock({
            pathname: '/session/s1',
            router: {
                push: routerPushSpy,
                back: vi.fn(),
                replace: vi.fn(),
                setParams: vi.fn(),
            },
        }).module,
    storage: async () =>
        createStorageModuleStub({
            storage: Object.assign(
                (
                    selector?: (value: {
                        sessions: Record<string, unknown>;
                        sessionMessages: Record<string, unknown>;
                        settings: Record<string, unknown>;
                        sessionListIndexByServerId: Record<string, unknown>;
                    }) => unknown,
                ) => {
                    const snapshot = {
                        sessions: sessionState ? { s1: sessionState } : {},
                        sessionMessages: {},
                        sessionPending: {},
                        settings: {},
                        profile: profileState,
                        sessionListIndexByServerId: {},
                    };
                    return typeof selector === 'function' ? selector(snapshot) : snapshot;
                },
                {
                    getState: () => ({
                        sessions: sessionState ? { s1: sessionState } : {},
                        sessionMessages: {},
                        sessionPending: {},
                        settings: {},
                        profile: profileState,
                        sessionListIndexByServerId: {},
                    }),
                    getInitialState: () => ({
                        sessions: sessionState ? { s1: sessionState } : {},
                        sessionMessages: {},
                        sessionPending: {},
                        settings: {},
                        profile: profileState,
                        sessionListIndexByServerId: {},
                    }),
                    setState: () => undefined,
                    subscribe: () => () => undefined,
                    destroy: () => undefined,
                },
            ),
            useSession: () => sessionState,
            useSessionMachineId: () => sessionState?.metadata?.machineId ?? null,
            useIsDataReady: () => isDataReadyState,
            useRealtimeStatus: () => 'connected',
            useEndpointStatus: () => endpointConnectivityStatus,
            useEndpointConnectivity: () => ({
                status: endpointConnectivityStatus,
                reason: null,
                attempt: 0,
                nextRetryAt: null,
                lastConnectedAt: null,
                lastDisconnectedAt: null,
                lastErrorMessage: null,
            }),
            useSessionMessages: () => ({ messages: [], isLoaded: true }),
            useSessionMessagesVersion: () => 0,
            useSessionTranscriptIds: () => ({ ids: [], isLoaded: true }),
            useSessionPendingMessages: () => ({ messages: [], discarded: [], isLoaded: true }),
            useSessionSubagentSourceMessages: () => [],
            useSessionRpcAvailabilityState: () => ({
                sessionExists: true,
                sessionRpcAvailable: true,
            }),
            useSessionReviewCommentsDrafts: () => [],
            useWorkspaceReviewCommentsDrafts: () => [],
            useSessionUsage: () => null,
            useSyncError: () => syncErrorState,
            useArtifacts: () => [],
            useLocalSetting: <K extends keyof LocalSettings>(key: K) => localSettingsDefaults[key],
            useLocalSettingMutable: <K extends keyof LocalSettings>(key: K) => [
                localSettingsDefaults[key],
                vi.fn<(value: LocalSettings[K]) => void>(),
            ],
            useSetting: <K extends keyof Settings>(key: K) => settingsDefaults[key],
            useSettingMutable: <K extends keyof Settings>(key: K) => [
                settingsDefaults[key],
                key === 'mobileWorkspaceExperienceV1'
                    ? ((value: Settings[K]) => {
                        settingMutators.setMobileWorkspaceExperience(value);
                    })
                    : vi.fn<(value: Settings[K]) => void>(),
            ],
            useSettings: () => ({ ...settingsDefaults, experiments: true, featureToggles: {} }),
            useProfile: () => profileState,
            useAutomations: () => [],
            useAllMachines: () => [],
            useMachine: () => null,
        }),
});

vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: safeAreaState.bottom, left: 0, right: 0 }),
}));
vi.mock('@react-navigation/native', () => ({
    useFocusEffect: () => {},
    useIsFocused: () => true,
}));
vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ credentials: { token: 't', secret: 's' } }),
}));

vi.mock('@/components/sessions/transcript/ChatHeaderView', () => ({
    ChatHeaderView: (props: any) => React.createElement(
        React.Fragment,
        null,
        React.createElement('Text', { testID: 'session-header-title' }, props.title ?? ''),
        props.rightElement ?? null,
    ),
}));
vi.mock('@/components/sessions/transcript/AgentContentView', () => ({
    AgentContentView: (props: any) => React.createElement('AgentContentView', props, props.input ?? null),
}));
vi.mock('@/components/appShell/panes/AppPaneScopeHost', () => ({
    AppPaneScopeHost: (props: any) => React.createElement('AppPaneScopeHost', props, props.main ?? null),
}));
vi.mock('@/components/sessions/agentInput', () => ({
    AgentInput: (props: Record<string, unknown>) => {
        agentInputPropsSpy(props);
        return React.createElement('View', { testID: 'session-composer-input' });
    },
}));
vi.mock('@/components/sessions/actions/SessionHeaderActionMenu', () => ({
    SessionHeaderActionMenu: () => React.createElement('View', { testID: 'session-header-action-menu-trigger' }),
}));
vi.mock('@/components/sessions/transcript/ChatList', () => ({
    ChatList: (props: any) => {
        chatListPropsSpy(props);
        return React.createElement('ChatList', props);
    },
}));
vi.mock('@/components/sessions/pending/PendingMessagesDragReorderList', () => ({
    PendingMessagesDragReorderList: () => null,
}));
vi.mock('@/components/ui/empty/EmptyMessages', () => ({
    EmptyMessages: () => null,
}));
vi.mock('@/components/ui/forms/Deferred', () => ({
    Deferred: (props: any) => React.createElement(React.Fragment, null, props.children),
}));
vi.mock('@/components/voice/surface/VoiceSurface', () => ({
    VoiceSurface: () => null,
}));
vi.mock('@/components/sessions/attachments/AttachmentFilePicker', () => ({
    AttachmentFilePicker: () => null,
}));

vi.mock('@/utils/platform/responsive', () => ({
    getDeviceType: () => 'tablet',
    useDeviceType: () => deviceTypeState.value,
    useHeaderHeight: () => 0,
    useIsLandscape: () => false,
    useIsTablet: () => true,
}));
vi.mock('@/components/sessions/model/inactiveSessionUi', () => ({
    getInactiveSessionUiState: () => ({ noticeKind: 'none', inactiveStatusTextKey: null, shouldShowInput: true }),
}));
vi.mock('@/components/sessions/model/resolveSessionMachineReachability', () => ({
    resolveSessionMachineReachability: () => true,
}));
vi.mock(
    '@/components/sessions/model/useSessionMachineReachability',
    async (importOriginal) => {
        const {
            createReachableSessionMachineReachability,
            createSessionMachineReachabilityModuleMock,
        } = await import('@/dev/testkit/mocks/sessionMachineReachability');
        return createSessionMachineReachabilityModuleMock({
            importOriginal,
            overrides: {
                useSessionMachineReachability: createReachableSessionMachineReachability,
                useSessionReachableMachineTarget: () => ({ machineId: 'm1', basePath: '/tmp' }),
            },
        });
    },
);
vi.mock('@/components/appShell/panes/useRegisterSessionPaneDriver', () => ({
    useRegisterSessionPaneDriver: () => 'session:s1',
}));
vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
    useAppPaneScope: () => ({
        openRight: vi.fn(),
        setRightTab: vi.fn(),
        closeRight: vi.fn(),
        openDetailsTab: vi.fn(),
        closeDetails: vi.fn(),
        pinDetailsTab: vi.fn(),
        closeDetailsTab: vi.fn(),
        setActiveDetailsTab: vi.fn(),
        setRightTabState: vi.fn(),
        scopeState: null,
    }),
}));
vi.mock('@/components/sessions/panes/url/useSessionPaneUrlSync', () => ({
    useSessionPaneUrlSync: () => {},
}));
vi.mock('@/sync/domains/session/activeViewingSession', () => ({
    setActiveViewingSessionId: () => {},
    clearActiveViewingSessionId: () => {},
    markSessionVisible: () => {},
    markSessionHidden: () => {},
}));
vi.mock('@/sync/sync', async () => {
    const { createAcceptedExternalSessionTailCursorSyncBoundary } = await import('@/dev/testkit/mocks/sync');
    return {
        sync: {
            ...createAcceptedExternalSessionTailCursorSyncBoundary(),
            markSessionViewed: async () => {},
            fetchPendingMessages: async () => {},
            publishSessionPermissionModeToMetadata: async () => {},
            publishSessionAcpSessionModeOverrideToMetadata: async () => {},
            publishSessionAcpConfigOptionOverrideToMetadata: async () => {},
            publishSessionModelOverrideToMetadata: async () => {},
            refreshSessions: async () => {},
            onSessionVisible: () => {},
            onSessionViewportChange: () => {},
            sendMessage: sessionSendMessageMock,
            enqueuePendingMessage: sessionEnqueuePendingMessageMock,
            wakeSessionAfterSend: async () => null,
            submitMessage: async () => {},
        },
    };
});

const sessionViewModulePromise = import('./SessionView');

function flattenStyle(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) {
        return Object.assign({}, ...style.map((entry) => flattenStyle(entry)));
    }
    if (style && typeof style === 'object') {
        return style as Record<string, unknown>;
    }
    return {};
}

describe('SessionView (data ready gating)', () => {
    afterEach(() => {
        routerPushSpy.mockClear();
        endpointConnectivityStatus = 'online';
        syncErrorState = null;
        isDataReadyState = false;
        daemonMergedProjectionState.value = { inputs: null, phase: 'idle' };
        sessionState = {
            id: 's1',
            seq: 1,
            presence: 'online',
            active: true,
            accessLevel: 'edit',
            metadata: { machineId: 'm1', flavor: 'codex', version: '0.0.0', path: '/tmp', homeDir: '/tmp' },
            agentState: {},
        };
        settingMutators.setMobileWorkspaceExperience.mockReset();
        gestureHandlerState.gestures = [];
        deviceTypeState.value = 'tablet';
        safeAreaState.bottom = 0;
        resetSessionDraftValueCachesForTests();
        standardCleanup();
        chatListPropsSpy.mockReset();
        composerChipFactorySpy.mockReset();
        currentSessionPresentationPropsSpy.mockReset();
        pluginSurfaceHostPropsSpy.mockReset();
        agentInputPropsSpy.mockReset();
        machinePluginStructuredMessageActionExecuteMock.mockReset();
        sessionSendMessageMock.mockReset();
        sessionEnqueuePendingMessageMock.mockReset();
        composerScopePluginPresentationSpy.mockReset();
        composerScopePluginPresentationState.value = null;
    });

    it('renders the session shell when the session exists even if global data readiness is false', async () => {
        const { SessionView } = await sessionViewModulePromise;

        const screen = await renderScreen(
            <AppPaneProvider>
                <SessionView id="s1" />
            </AppPaneProvider>,
        );

        expect(screen.findAllByTestId('session-composer-input')).toHaveLength(1);
        expect(screen.findAllByTestId('session-header-action-menu-trigger')).toHaveLength(1);
    });

    it('projects decorations and edit locks through the mounted session AgentInput', async () => {
        const { SessionView } = await sessionViewModulePromise;

        await renderScreen(
            <AppPaneProvider>
                <SessionView id="s1" />
            </AppPaneProvider>,
        );

        const ref = { kind: 'session' as const, sessionId: 's1' };
        const snapshot = readComposerPresentationSnapshot(ref);
        expect(snapshot).not.toBeNull();
        if (!snapshot) throw new Error('expected mounted session composer target');
        const handlers = createComposerPresentationHostHandlers({
            owner: {
                identity: { pluginId: 'acme.fixture', localId: 'composer-tools' },
                immutableGenerationId: 'generation-1',
                surfaceInstanceKey: 'mounted-1',
            },
        });
        const request = (method: 'setComposerDecorations' | 'acquireComposerInputLock', payload: unknown) => ({
            version: 1,
            requestId: `request:${method}`,
            surface: {
                pluginId: 'acme.fixture',
                contributionId: 'composer-tools',
                surfaceId: 'composer-tools:mounted',
                placement: 'composerSurface',
                platform: 'web',
                channel: 'internal',
                resourceScope: [],
                diagnostics: [],
            },
            method,
            payload,
        }) as never;

        await act(async () => {
            expect(handlers.setComposerDecorations!(request('setComposerDecorations', {
                ref,
                key: 'analysis',
                decorations: {
                    revision: snapshot.revision,
                    ranges: [{ range: { start: 0, end: 0 }, treatment: 'highlight' }],
                },
            }))).toEqual({ status: 'set' });
        });
        let agentInputProps = agentInputPropsSpy.mock.lastCall?.[0] as Readonly<{
            composerDecorations?: readonly Readonly<{ key: string }>[];
            composerInputLock?: unknown;
            disabled?: boolean;
            isSendDisabled?: boolean;
        }>;
        expect(agentInputProps.composerDecorations).toEqual([
            expect.objectContaining({ key: 'analysis' }),
        ]);

        await act(async () => {
            expect(handlers.acquireComposerInputLock!(request('acquireComposerInputLock', {
                subscriptionId: 'lock-1',
                ref,
                request: { reason: 'Review required', mode: 'editAndSubmit' },
            }))).toBeNull();
        });
        agentInputProps = agentInputPropsSpy.mock.lastCall?.[0] as typeof agentInputProps;
        expect(agentInputProps.composerInputLock).toEqual({
            mode: 'editAndSubmit',
            reasons: ['Review required'],
        });
        expect(agentInputProps.disabled).toBe(true);
        expect(agentInputProps.isSendDisabled).toBe(true);
        expect(readComposerPresentationSnapshot(ref)?.state).toMatchObject({
            editable: false,
            submittable: false,
            inputLock: { mode: 'editAndSubmit', reasons: ['Review required'] },
        });

        await act(async () => {
            handlers.dispose();
        });
        agentInputProps = agentInputPropsSpy.mock.lastCall?.[0] as typeof agentInputProps;
        expect(agentInputProps.composerDecorations).toEqual([]);
        expect(agentInputProps.composerInputLock).toBeNull();
    });

    it('projects the mounted action-bar layout through the Session Composer snapshot', async () => {
        const { SessionView } = await sessionViewModulePromise;

        await renderScreen(
            <AppPaneProvider>
                <SessionView id="s1" />
            </AppPaneProvider>,
        );

        const composerRef = { kind: 'session' as const, sessionId: 's1' };
        const inputProps = agentInputPropsSpy.mock.lastCall?.[0] as Readonly<{
            onComposerActionBarLayoutChange?: (layout: 'wrap' | 'scroll' | 'collapsed') => void;
        }>;
        expect(readComposerPresentationSnapshot(composerRef)?.layout).toBe('wrap');
        expect(inputProps.onComposerActionBarLayoutChange).toEqual(expect.any(Function));

        inputProps.onComposerActionBarLayoutChange?.('scroll');
        expect(readComposerPresentationSnapshot(composerRef)?.layout).toBe('scroll');

        inputProps.onComposerActionBarLayoutChange?.('collapsed');
        expect(readComposerPresentationSnapshot(composerRef)?.layout).toBe('collapsed');
    });

    it('consumes the shared Composer presentation for existing-Session controls and regions', async () => {
        const sharedChip: ComposerScopePluginPresentation['extraActionChips'][number] = {
            key: 'shared-composer-control',
            render: () => null,
        };
        const sharedRegions: ComposerScopePluginPresentation['composerRegions'] = [{
            id: 'acme.compose/before',
            pluginId: 'acme.compose',
            identity: { pluginId: 'acme.compose', localId: 'before' },
            immutableGenerationId: 'compose-generation-a',
            definition: {
                id: 'before',
                placement: 'beforeComposer',
                renderer: { renderer: 'compose-region' },
            },
        }, {
            id: 'acme.compose/after',
            pluginId: 'acme.compose',
            identity: { pluginId: 'acme.compose', localId: 'after' },
            immutableGenerationId: 'compose-generation-a',
            definition: {
                id: 'after',
                placement: 'afterComposer',
                renderer: { renderer: 'compose-region' },
            },
        }];
        const sharedPresentation: ComposerScopePluginPresentation = {
            attachmentEntriesById: null,
            actionController: {
                list: () => [],
                listSlashCommands: () => [],
                open: async () => ({ kind: 'stale', reason: 'host_retired' }),
                isReferenceAvailable: () => false,
                isSessionReferenceAvailable: () => false,
                invokeReference: async () => ({ kind: 'stale', reason: 'host_retired' }),
                openSessionReference: async () => ({ kind: 'stale', reason: 'host_retired' }),
            },
            composerRegions: sharedRegions,
            getCurrentActionSnapshot: () => null,
            scopeSignal: new AbortController().signal,
            renderComposerRegion: (region) => React.createElement('SharedComposerRegion', {
                testID: `shared-composer-region:${region.id}`,
            }),
            extraActionChips: [sharedChip],
            beforeComposer: null,
            afterComposer: null,
            renderAttachmentSurface: () => undefined,
            resolveAttachmentInteraction: () => undefined,
        };
        composerScopePluginPresentationState.value = sharedPresentation;
        const { SessionView } = await sessionViewModulePromise;

        const screen = await renderScreen(
            <AppPaneProvider>
                <SessionView id="s1" />
            </AppPaneProvider>,
        );

        expect(composerScopePluginPresentationSpy).toHaveBeenCalledWith(expect.objectContaining({
            composer: { kind: 'session', sessionId: 's1' },
            physicalTarget: { kind: 'session', sessionId: 's1' },
            resourceContext: { kind: 'session', sessionId: 's1' },
            attachmentsEnabled: true,
            includeSessionActions: true,
            isScopeCurrent: expect.any(Function),
        }));
        expect(agentInputPropsSpy).toHaveBeenCalledWith(expect.objectContaining({
            extraActionChips: expect.arrayContaining([sharedChip]),
        }));
        expect(screen.findByTestId('shared-composer-region:acme.compose/before')).toBeTruthy();
        expect(screen.findByTestId('shared-composer-region:acme.compose/after')).toBeTruthy();
    });

    it('projects admitted composer controls and before/after regions from the one current daemon snapshot', async () => {
        daemonMergedProjectionState.value = {
            phase: 'ready',
            inputs: {
                pluginProjectionById: {},
                pluginProjectionV2: {
                    v: 2,
                    generation: 7,
                    installedPackagesById: {},
                    agentsById: {},
                    backendsById: {},
                    actionsById: {},
                    toolsById: {},
                    commandsById: {},
                    resourcesById: {},
                    settingsById: {},
                    familiesById: {
                        composerControls: {
                            family: 'composerControls',
                            entriesById: {
                                'acme.compose/launch': {
                                    id: 'acme.compose/launch',
                                    pluginId: 'acme.compose',
                                    identity: { pluginId: 'acme.compose', localId: 'launch' },
                                    immutableGenerationId: 'compose-generation-a',
                                    definition: {
                                        id: 'launch',
                                        label: 'Launch compose helper',
                                        icon: 'sparkles',
                                        interaction: {
                                            kind: 'action',
                                            action: 'launch-action',
                                        },
                                    },
                                },
                            },
                        },
                        composerRegions: {
                            family: 'composerRegions',
                            entriesById: {
                                'acme.compose/before': {
                                    id: 'acme.compose/before',
                                    pluginId: 'acme.compose',
                                    identity: { pluginId: 'acme.compose', localId: 'before' },
                                    immutableGenerationId: 'compose-generation-a',
                                    definition: {
                                        id: 'before',
                                        placement: 'beforeComposer',
                                        renderer: [{ pluginId: 'acme.compose', localId: 'before-renderer' }],
                                    },
                                },
                                'acme.compose/after': {
                                    id: 'acme.compose/after',
                                    pluginId: 'acme.compose',
                                    identity: { pluginId: 'acme.compose', localId: 'after' },
                                    immutableGenerationId: 'compose-generation-a',
                                    definition: {
                                        id: 'after',
                                        placement: 'afterComposer',
                                        renderer: [{ pluginId: 'acme.compose', localId: 'after-renderer' }],
                                    },
                                },
                            },
                        },
                    },
                    diagnostics: [],
                },
                composerSurfaceCatalog: [],
            },
        };
        const { SessionView } = await sessionViewModulePromise;

        await renderScreen(
            <AppPaneProvider>
                <SessionView id="s1" />
            </AppPaneProvider>,
        );

        expect(composerChipFactorySpy).toHaveBeenCalledWith(expect.objectContaining({
            composerControls: [expect.objectContaining({ id: 'acme.compose/launch' })],
            composerControlHost: expect.objectContaining({
                scope: 'session',
                isCurrent: expect.any(Function),
            }),
        }));
        expect(currentSessionPresentationPropsSpy).toHaveBeenCalledWith(expect.objectContaining({
            placement: 'beforeComposer',
            // SessionView forwards the single normalized region projection;
            // CurrentSessionPresentationSurface remains the physical-slot owner.
            composerRegions: [
                expect.objectContaining({ id: 'acme.compose/before' }),
                expect.objectContaining({ id: 'acme.compose/after' }),
            ],
            renderComposerRegion: expect.any(Function),
        }));
        expect(currentSessionPresentationPropsSpy).toHaveBeenCalledWith(expect.objectContaining({
            placement: 'afterComposer',
            composerRegions: [
                expect.objectContaining({ id: 'acme.compose/before' }),
                expect.objectContaining({ id: 'acme.compose/after' }),
            ],
            renderComposerRegion: expect.any(Function),
        }));
        expect(agentInputPropsSpy).toHaveBeenCalled();
        expect(pluginSurfaceHostPropsSpy).not.toHaveBeenCalled();
    });

    it('reads the current Composer presentation snapshot at semantic Action click time', async () => {
        daemonMergedProjectionState.value = {
            phase: 'ready',
            inputs: {
                pluginProjectionById: {
                    'acme.compose': {
                        pluginId: 'acme.compose',
                        title: 'Compose',
                        description: null,
                        version: '1.0.0',
                        enabled: true,
                        generation: 7,
                        generationLabel: '7',
                        status: null,
                        provenance: null,
                        diagnostics: [],
                        resources: [],
                        editableSettingsGroups: [],
                        actions: [{
                            id: 'refresh-context',
                            title: 'Refresh context',
                            description: null,
                            icon: null,
                            scopes: ['session'],
                            surfaces: ['ui'],
                            placementBindings: ['composer.primary'],
                            inputSchema: null,
                            inputHints: { fields: [] },
                            slash: null,
                            priority: null,
                            dangerLevel: 'safe',
                            confirmation: null,
                            available: true,
                        }],
                    },
                },
                pluginProjectionV2: {
                    v: 2,
                    generation: 7,
                    installedPackagesById: {},
                    agentsById: {},
                    backendsById: {},
                    actionsById: {},
                    toolsById: {},
                    commandsById: {},
                    resourcesById: {},
                    settingsById: {},
                    familiesById: {},
                    diagnostics: [],
                },
                composerSurfaceCatalog: [],
            },
        };
        machinePluginStructuredMessageActionExecuteMock.mockResolvedValue({
            supported: true,
            result: { ok: true, result: { refreshed: true } },
        });
        const { SessionView } = await sessionViewModulePromise;

        await renderScreen(
            <AppPaneProvider>
                <SessionView id="s1" />
            </AppPaneProvider>,
        );

        const controller = composerChipFactorySpy.mock.calls
            .map(([input]) => (input as { controller?: PluginContributedActionController }).controller)
            .find((candidate): candidate is PluginContributedActionController => candidate !== undefined);
        if (!controller) throw new Error('expected the Composer Action controller');
        const [action] = controller.list({ placement: 'composer.primary', scope: 'session' });
        if (!action) throw new Error('expected the semantic Composer Action');

        const composerRef = { kind: 'session' as const, sessionId: 's1' };
        const initial = readComposerPresentationSnapshot(composerRef);
        if (!initial) throw new Error('expected the mounted Composer snapshot');
        expect(applyComposerPresentationTransaction({
            ref: composerRef,
            transaction: {
                expectedRevision: initial.revision,
                operations: [{ kind: 'text.set', text: 'updated before action click' }],
            },
        })).toEqual({ status: 'applied', revision: initial.revision + 1 });

        await controller.open(action);

        expect(machinePluginStructuredMessageActionExecuteMock).toHaveBeenCalledWith('m1', expect.objectContaining({
            qualifiedActionId: 'acme.compose/refresh-context',
            invocation: {
                kind: 'hostPresentedComposer',
                currentComposerIntent: {
                    composer: composerRef,
                    revision: initial.revision + 1,
                },
            },
        }));
    });

    it('serializes direct contributed Actions and sends through the Session composer reservation', async () => {
        sessionState = {
            ...sessionState,
            pendingVersion: 2,
            agentStateVersion: 1,
        };
        daemonMergedProjectionState.value = {
            phase: 'ready',
            inputs: {
                pluginProjectionById: {
                    'acme.compose': {
                        pluginId: 'acme.compose',
                        title: 'Compose',
                        description: null,
                        version: '1.0.0',
                        enabled: true,
                        generation: 7,
                        generationLabel: '7',
                        status: null,
                        provenance: null,
                        diagnostics: [],
                        resources: [],
                        editableSettingsGroups: [],
                        actions: [{
                            id: 'refresh-context',
                            title: 'Refresh context',
                            description: null,
                            icon: null,
                            scopes: ['session'],
                            surfaces: ['ui'],
                            placementBindings: ['composer.primary'],
                            inputSchema: null,
                            inputHints: { fields: [] },
                            slash: null,
                            priority: null,
                            dangerLevel: 'safe',
                            confirmation: null,
                            available: true,
                        }],
                    },
                },
                pluginProjectionV2: {
                    v: 2,
                    generation: 7,
                    installedPackagesById: {},
                    agentsById: {},
                    backendsById: {},
                    actionsById: {},
                    toolsById: {},
                    commandsById: {},
                    resourcesById: {},
                    settingsById: {},
                    familiesById: {},
                    diagnostics: [],
                },
                composerSurfaceCatalog: [],
            },
        };
        const firstActionDispatch = createDeferred<{
            supported: true;
            result: { ok: true; result: { refreshed: boolean } };
        }>();
        const secondActionDispatch = createDeferred<{
            supported: true;
            result: { ok: true; result: { refreshed: boolean } };
        }>();
        const secondSend = createDeferred<{ localId: string }>();
        const successfulActionDispatch = {
            supported: true as const,
            result: { ok: true as const, result: { refreshed: true } },
        };
        machinePluginStructuredMessageActionExecuteMock
            .mockImplementationOnce(() => firstActionDispatch.promise)
            .mockImplementationOnce(() => secondActionDispatch.promise);
        let outboundDispatchCount = 0;
        const dispatchOutboundMessage = () => {
            outboundDispatchCount += 1;
            return outboundDispatchCount === 2
                ? secondSend.promise
                : Promise.resolve({ localId: `message-${outboundDispatchCount}` });
        };
        sessionSendMessageMock.mockImplementation(dispatchOutboundMessage);
        sessionEnqueuePendingMessageMock.mockImplementation(dispatchOutboundMessage);

        const { SessionView } = await sessionViewModulePromise;
        await renderScreen(
            <AppPaneProvider>
                <SessionView id="s1" />
            </AppPaneProvider>,
        );

        const controller = composerChipFactorySpy.mock.calls
            .map(([input]) => (input as { controller?: PluginContributedActionController }).controller)
            .find((candidate): candidate is PluginContributedActionController => candidate !== undefined);
        if (!controller) throw new Error('expected the Composer Action controller');
        const [action] = controller.list({ placement: 'composer.primary', scope: 'session' });
        if (!action || action.kind !== 'direct') throw new Error('expected a direct Composer Action');

        const agentInputProps = agentInputPropsSpy.mock.lastCall?.[0] as Readonly<{
            onContributedActionSuggestionSelect?: (
                action: PluginContributedActionDescriptor,
            ) => Promise<PluginContributedActionOpenOutcome> | PluginContributedActionOpenOutcome;
            onSend?: (options?: Readonly<{ inputTextOverride?: string }>) => void;
        }>;
        if (!agentInputProps.onContributedActionSuggestionSelect || !agentInputProps.onSend) {
            throw new Error('expected Session composer dispatch callbacks');
        }

        let openingWhileSendIsReserved: Promise<PluginContributedActionOpenOutcome> | null = null;
        try {
            const actionOpening = Promise.resolve(agentInputProps.onContributedActionSuggestionSelect(action));
            await vi.waitFor(() => {
                expect(machinePluginStructuredMessageActionExecuteMock).toHaveBeenCalledOnce();
            });

            await act(async () => {
                agentInputProps.onSend?.({ inputTextOverride: 'send while Action dispatch is pending' });
                await Promise.resolve();
            });
            expect(outboundDispatchCount).toBe(0);

            firstActionDispatch.resolve(successfulActionDispatch);
            await expect(actionOpening).resolves.toMatchObject({ kind: 'direct', outcome: { ok: true } });

            await act(async () => {
                agentInputProps.onSend?.({ inputTextOverride: 'retry after Action dispatch settles' });
            });
            await vi.waitFor(() => {
                expect(outboundDispatchCount).toBe(1);
            });

            await act(async () => {
                agentInputProps.onSend?.({ inputTextOverride: 'send before Action dispatch' });
            });
            await vi.waitFor(() => {
                expect(outboundDispatchCount).toBe(2);
            });

            openingWhileSendIsReserved = Promise.resolve(
                agentInputProps.onContributedActionSuggestionSelect(action),
            );
            await expect(openingWhileSendIsReserved).resolves.toEqual({
                kind: 'unavailable',
                reason: 'submission_in_flight',
            });
            expect(machinePluginStructuredMessageActionExecuteMock).toHaveBeenCalledOnce();

            secondSend.resolve({ localId: 'message-2' });
            await act(async () => {
                await Promise.resolve();
                await Promise.resolve();
                await Promise.resolve();
            });

            const actionRetry = Promise.resolve(agentInputProps.onContributedActionSuggestionSelect(action));
            await vi.waitFor(() => {
                expect(machinePluginStructuredMessageActionExecuteMock).toHaveBeenCalledTimes(2);
            });
            secondActionDispatch.resolve(successfulActionDispatch);
            await expect(actionRetry).resolves.toMatchObject({ kind: 'direct', outcome: { ok: true } });
        } finally {
            firstActionDispatch.resolve(successfulActionDispatch);
            secondSend.resolve({ localId: 'message-2' });
            secondActionDispatch.resolve(successfulActionDispatch);
            if (openingWhileSendIsReserved) {
                await openingWhileSendIsReserved.catch(() => {});
            }
        }
    });

    it('mounts an exact admitted control and both Composer regions through the one physical surface host', async () => {
        const control = {
            id: 'acme.compose/inline',
            pluginId: 'acme.compose',
            identity: { pluginId: 'acme.compose', localId: 'inline' },
            immutableGenerationId: 'compose-generation-a',
            definition: {
                id: 'inline',
                label: 'Inline compose helper',
                icon: 'sparkles',
                interaction: {
                    kind: 'surface',
                    renderer: [{ pluginId: 'acme.compose', localId: 'inline-renderer' }],
                    presentation: 'popover',
                    layout: 'content',
                },
            },
        };
        const beforeRegion = {
            id: 'acme.compose/before',
            pluginId: 'acme.compose',
            identity: { pluginId: 'acme.compose', localId: 'before' },
            immutableGenerationId: 'compose-generation-a',
            definition: {
                id: 'before',
                placement: 'beforeComposer',
                renderer: [{ pluginId: 'acme.compose', localId: 'before-renderer' }],
            },
        };
        const afterRegion = {
            id: 'acme.compose/after',
            pluginId: 'acme.compose',
            identity: { pluginId: 'acme.compose', localId: 'after' },
            immutableGenerationId: 'compose-generation-a',
            definition: {
                id: 'after',
                placement: 'afterComposer',
                renderer: [{ pluginId: 'acme.compose', localId: 'after-renderer' }],
            },
        };
        const catalogEntry = (contribution: Readonly<{ pluginId: string; localId: string }>, role: string, rendererId: string) => ({
            contribution,
            immutableGenerationId: 'compose-generation-a',
            projectionGeneration: 7,
            role,
            rendererChain: [{ pluginId: contribution.pluginId, localId: rendererId }],
            selectedRenderer: {
                identity: { pluginId: contribution.pluginId, localId: rendererId },
                renderer: {
                    kind: 'declarative',
                    contributionId: rendererId,
                    model: { visible: true },
                },
                availability: { state: 'available', reason: 'available', diagnostics: [] },
            },
            executionOrigin: {
                serverIdentityId: 'srv_acme',
                materializationRef: {
                    machineId: 'machine-compose',
                    materializationId: 'compose-materialization-a',
                    pluginId: contribution.pluginId,
                },
            },
            resourceCapability: { readable: true, dynamic: true },
            contributorTargetedContributions: {
                target: {
                    pluginId: contribution.pluginId,
                    immutableGenerationId: 'compose-generation-a',
                },
                points: [],
            },
        });
        daemonMergedProjectionState.value = {
            phase: 'ready',
            inputs: {
                pluginProjectionById: {},
                pluginProjectionV2: {
                    v: 2,
                    generation: 7,
                    installedPackagesById: {},
                    agentsById: {},
                    backendsById: {},
                    actionsById: {},
                    toolsById: {},
                    commandsById: {},
                    resourcesById: {},
                    settingsById: {},
                    familiesById: {
                        composerControls: {
                            family: 'composerControls',
                            entriesById: { [control.id]: control },
                        },
                        composerRegions: {
                            family: 'composerRegions',
                            entriesById: {
                                [beforeRegion.id]: beforeRegion,
                                [afterRegion.id]: afterRegion,
                            },
                        },
                    },
                    diagnostics: [],
                },
                composerSurfaceCatalog: [
                    catalogEntry(control.identity, 'controlCompact', 'inline-renderer'),
                    catalogEntry(beforeRegion.identity, 'region', 'before-renderer'),
                    catalogEntry(afterRegion.identity, 'region', 'after-renderer'),
                ],
            },
        };
        const { SessionView } = await sessionViewModulePromise;

        await renderScreen(
            <AppPaneProvider>
                <SessionView id="s1" />
            </AppPaneProvider>,
        );

        const composerControlHost = composerChipFactorySpy.mock.calls
            .map(([input]) => input as { composerControlHost?: { renderSurfaceContent?: (input: unknown) => React.ReactNode } })
            .find((input) => input.composerControlHost !== undefined)
            ?.composerControlHost;
        const beforeProps = currentSessionPresentationPropsSpy.mock.calls
            .map(([props]) => props as { placement?: unknown; renderComposerRegion?: (region: unknown) => React.ReactNode })
            .find((props) => props.placement === 'beforeComposer');
        const afterProps = currentSessionPresentationPropsSpy.mock.calls
            .map(([props]) => props as { placement?: unknown; renderComposerRegion?: (region: unknown) => React.ReactNode })
            .find((props) => props.placement === 'afterComposer');
        if (!composerControlHost?.renderSurfaceContent || !beforeProps?.renderComposerRegion || !afterProps?.renderComposerRegion) {
            throw new Error('expected SessionView to expose the admitted Composer physical-mount callbacks');
        }

        pluginSurfaceHostPropsSpy.mockClear();
        const physicalMountScreen = await renderScreen(
            <>
                {composerControlHost.renderSurfaceContent({
                    kind: 'control',
                    role: 'compact',
                    control,
                    state: {},
                })}
                {beforeProps.renderComposerRegion(beforeRegion)}
                {afterProps.renderComposerRegion(afterRegion)}
            </>,
        );

        // The SessionView renderer remains mounted while this isolated physical
        // slot tree is checked, so the module-level prop spy may also observe a
        // re-render of the original region hosts. Count the physical nodes in
        // this tree instead of treating component render calls as mount count.
        expect(physicalMountScreen.findAllByType('PluginSurfaceHost')).toHaveLength(3);

        const mounts = pluginSurfaceHostPropsSpy.mock.calls.map(([props]) => {
            const composerMount = (props as { composerMount?: { mount?: { mount?: {
                role?: unknown;
                input?: unknown;
                contribution?: unknown;
            }; catalogEntry?: unknown; binding?: unknown; physicalTarget?: unknown } } }).composerMount;
            return composerMount;
        });
        expect(mounts).toEqual(expect.arrayContaining([
            expect.objectContaining({
                mount: expect.objectContaining({
                    mount: expect.objectContaining({
                        role: 'controlCompact',
                        contribution: control.identity,
                        input: expect.objectContaining({ role: 'controlCompact', controlLocalId: 'inline' }),
                    }),
                    catalogEntry: expect.objectContaining({ role: 'controlCompact' }),
                }),
                physicalTarget: { kind: 'session', sessionId: 's1' },
                binding: expect.objectContaining({
                    mountedHostApiHandlers: expect.objectContaining({
                        readComposer: expect.any(Function),
                        applyComposer: expect.any(Function),
                    }),
                }),
            }),
            expect.objectContaining({
                mount: expect.objectContaining({
                    mount: expect.objectContaining({
                        role: 'region',
                        contribution: beforeRegion.identity,
                        input: expect.objectContaining({ role: 'region', regionLocalId: 'before' }),
                    }),
                    catalogEntry: expect.objectContaining({ role: 'region' }),
                }),
                physicalTarget: { kind: 'session', sessionId: 's1' },
            }),
            expect.objectContaining({
                mount: expect.objectContaining({
                    mount: expect.objectContaining({
                        role: 'region',
                        contribution: afterRegion.identity,
                        input: expect.objectContaining({ role: 'region', regionLocalId: 'after' }),
                    }),
                    catalogEntry: expect.objectContaining({ role: 'region' }),
                }),
                physicalTarget: { kind: 'session', sessionId: 's1' },
            }),
        ]));
    });

    it('mounts exact admitted attachment display and preview surfaces through the one physical host', async () => {
        const attachment: ComposerAttachmentDraftV1 = {
            v: 1 as const,
            instanceId: 'issue-42',
            attachment: { pluginId: 'acme.issues', localId: 'issue' },
            key: '42',
            value: { issueId: 42 },
            presentation: { label: 'Issue #42', typeLabel: 'Issue', icon: 'file' },
        };
        writeSessionDraftValue(null, 's1', 'structuredInput.composerAttachments', [attachment]);
        const attachmentEntry = {
            id: 'acme.issues/issue',
            pluginId: attachment.attachment.pluginId,
            identity: attachment.attachment,
            immutableGenerationId: 'issues-generation-a',
            definition: {
                id: attachment.attachment.localId,
                title: 'Issue',
                icon: 'file',
                cardinality: 'many',
                valueSchema: { type: 'object' },
                display: {
                    kind: 'surface',
                    renderer: { renderer: 'issue-display' },
                    sizing: 'content',
                },
                preview: {
                    kind: 'surface',
                    renderer: { renderer: 'issue-preview' },
                    presentation: 'popover',
                },
            },
        };
        daemonMergedProjectionState.value = {
            phase: 'ready',
            inputs: {
                pluginProjectionById: {},
                pluginProjectionV2: {
                    v: 2,
                    generation: 7,
                    installedPackagesById: {},
                    agentsById: {},
                    backendsById: {},
                    actionsById: {},
                    toolsById: {},
                    commandsById: {},
                    resourcesById: {},
                    settingsById: {},
                    familiesById: {
                        composerAttachments: {
                            family: 'composerAttachments',
                            entriesById: { [attachmentEntry.id]: attachmentEntry },
                        },
                    },
                    diagnostics: [],
                },
                composerSurfaceCatalog: [{
                    contribution: attachment.attachment,
                    immutableGenerationId: attachmentEntry.immutableGenerationId,
                    projectionGeneration: 7,
                    role: 'attachmentDisplay',
                    rendererChain: [{ pluginId: attachment.attachment.pluginId, localId: 'issue-display' }],
                    selectedRenderer: {
                        identity: { pluginId: attachment.attachment.pluginId, localId: 'issue-display' },
                        renderer: {
                            kind: 'declarative',
                            contributionId: 'issue-display',
                            model: { visible: true },
                        },
                        availability: { state: 'available', reason: 'available', diagnostics: [] },
                    },
                    executionOrigin: {
                        serverIdentityId: 'srv_acme',
                        materializationRef: {
                            machineId: 'machine-compose',
                            materializationId: 'issues-materialization-a',
                            pluginId: attachment.attachment.pluginId,
                        },
                    },
                    resourceCapability: { readable: true, dynamic: true },
                    contributorTargetedContributions: {
                        target: {
                            pluginId: attachment.attachment.pluginId,
                            immutableGenerationId: attachmentEntry.immutableGenerationId,
                        },
                        points: [],
                    },
                }, {
                    contribution: attachment.attachment,
                    immutableGenerationId: attachmentEntry.immutableGenerationId,
                    projectionGeneration: 7,
                    role: 'attachmentPreview',
                    rendererChain: [{ pluginId: attachment.attachment.pluginId, localId: 'issue-preview' }],
                    selectedRenderer: {
                        identity: { pluginId: attachment.attachment.pluginId, localId: 'issue-preview' },
                        renderer: {
                            kind: 'declarative',
                            contributionId: 'issue-preview',
                            model: { visible: true },
                        },
                        availability: { state: 'available', reason: 'available', diagnostics: [] },
                    },
                    executionOrigin: {
                        serverIdentityId: 'srv_acme',
                        materializationRef: {
                            machineId: 'machine-compose',
                            materializationId: 'issues-materialization-a',
                            pluginId: attachment.attachment.pluginId,
                        },
                    },
                    resourceCapability: { readable: true, dynamic: true },
                    contributorTargetedContributions: {
                        target: {
                            pluginId: attachment.attachment.pluginId,
                            immutableGenerationId: attachmentEntry.immutableGenerationId,
                        },
                        points: [],
                    },
                }],
            },
        };
        const { SessionView } = await sessionViewModulePromise;

        await renderScreen(
            <AppPaneProvider>
                <SessionView id="s1" />
            </AppPaneProvider>,
        );

        const attachmentSurface = agentInputPropsSpy.mock.calls
            .flatMap(([props]) => (
                (props as { attachmentRowItems?: readonly unknown[] }).attachmentRowItems ?? []
            ))
            .find((item): item is Readonly<{
                kind: 'surface';
                key: string;
                sizing: string;
                renderedContent: React.ReactNode;
                renderPreviewPopover?: (ctx: Readonly<{
                    open: boolean;
                    anchorRef: React.RefObject<any>;
                    onRequestClose: () => void;
                }>) => React.ReactNode;
            }> => (
                typeof item === 'object'
                && item !== null
                && (item as { kind?: unknown }).kind === 'surface'
                && (item as { key?: unknown }).key === 'composer-attachment:issue-42'
            ));
        if (!attachmentSurface) throw new Error('expected the current attachment display surface row');
        expect(attachmentSurface.sizing).toBe('content');

        pluginSurfaceHostPropsSpy.mockClear();
        await renderScreen(<>{attachmentSurface.renderedContent}</>);

        expect(pluginSurfaceHostPropsSpy).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'm1',
            composerMount: expect.objectContaining({
                physicalTarget: { kind: 'session', sessionId: 's1' },
                mount: expect.objectContaining({
                    kind: 'composer',
                    mount: expect.objectContaining({
                        role: 'attachmentDisplay',
                        contribution: attachment.attachment,
                        input: expect.objectContaining({
                            role: 'attachmentDisplay',
                            attachmentLocalId: 'issue',
                            instance: expect.objectContaining({ instanceId: 'issue-42' }),
                        }),
                    }),
                    catalogEntry: expect.objectContaining({ role: 'attachmentDisplay' }),
                }),
            }),
        }));

        if (!attachmentSurface.renderPreviewPopover) {
            throw new Error('expected the exact current attachment preview presentation');
        }
        const previewPopover = attachmentSurface.renderPreviewPopover({
            open: true,
            anchorRef: React.createRef(),
            onRequestClose: vi.fn(),
        });
        if (!React.isValidElement(previewPopover)) {
            throw new Error('expected the attachment preview to reuse the incumbent popover shell');
        }
        const previewContent = (previewPopover.props as { content?: unknown }).content;
        if (typeof previewContent !== 'function') {
            throw new Error('expected the popover to defer the physical preview mount until it opens');
        }

        pluginSurfaceHostPropsSpy.mockClear();
        await renderScreen(<>{previewContent()}</>);

        expect(pluginSurfaceHostPropsSpy).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'm1',
            composerMount: expect.objectContaining({
                physicalTarget: { kind: 'session', sessionId: 's1' },
                mount: expect.objectContaining({
                    kind: 'composer',
                    mount: expect.objectContaining({
                        role: 'attachmentPreview',
                        contribution: attachment.attachment,
                        input: expect.objectContaining({
                            role: 'attachmentPreview',
                            attachmentLocalId: 'issue',
                            instance: expect.objectContaining({ instanceId: 'issue-42' }),
                        }),
                    }),
                    catalogEntry: expect.objectContaining({ role: 'attachmentPreview' }),
                }),
            }),
        }));
    });

    it('does not pass route hydration blocking state into an already loaded same-server session', async () => {
        isDataReadyState = true;
        sessionState = {
            ...sessionState,
            serverId: 'server-target',
        };
        const { SessionView } = await sessionViewModulePromise;

        const screen = await renderScreen(
            <AppPaneProvider>
                <SessionView
                    id="s1"
                    routeServerId="server-target"
                    routeHydrationState={{ kind: 'loading', sessionId: 's1', serverId: 'server-target', reason: 'store-miss' }}
                />
            </AppPaneProvider>,
        );

        expect(screen.findAllByTestId('session-route-loading')).toHaveLength(0);
        expect(screen.findAllByTestId('session-composer-input')).toHaveLength(1);
        const latestChatListProps = chatListPropsSpy.mock.calls
            .map((call) => call[0])
            .find((props) => props?.session?.id === 's1');
        expect(latestChatListProps?.routeHydrationPending).not.toBe(true);
    });

    it('can render chat content without the legacy web bottom spacer when cockpit owns bottom chrome', async () => {
        safeAreaState.bottom = 34;
        const { SessionView } = await sessionViewModulePromise;

        const screen = await renderScreen(
            <AppPaneProvider>
                <SessionView id="s1" chatBottomSpacing="none" />
            </AppPaneProvider>,
        );

        const chatContentContainers = screen.tree.findAllByType('View' as never).filter((node) => {
            const style = flattenStyle(node.props.style);
            return style.flexBasis === 0 && style.flexGrow === 1;
        });
        expect(chatContentContainers).toHaveLength(1);
        expect(Number(flattenStyle(chatContentContainers[0]?.props.style).paddingBottom ?? 0)).toBe(0);

        const agentContentView = screen.tree.findByType('AgentContentView' as never);
        expect(agentContentView.props.safeAreaBottom).toBeUndefined();
    });

    it('does not expose a gesture handle that can unintentionally open cockpit mode from the composer', async () => {
        deviceTypeState.value = 'phone';
        const { SessionView } = await sessionViewModulePromise;

        const screen = await renderScreen(
            <AppPaneProvider>
                <SessionView id="s1" />
            </AppPaneProvider>,
        );

        expect(screen.findAllByTestId('session-cockpit-open-swipe-handle')).toHaveLength(0);
        const gesture = gestureHandlerState.gestures.find((candidate) => candidate.kind === 'pan');
        expect(gesture).toBeUndefined();

        gesture?.handlers.onEnd?.({ translationY: -48, velocityY: -120 });

        expect(settingMutators.setMobileWorkspaceExperience).not.toHaveBeenCalledWith('cockpit');
    });

    it('surfaces auth sync errors as a restore-account action instead of generic retry', async () => {
        syncErrorState = {
            message: 'Authentication required',
            retryable: false,
            kind: 'auth',
            at: 123,
        };
        const { SessionView } = await sessionViewModulePromise;

        const screen = await renderScreen(
            <AppPaneProvider>
                <SessionView id="s1" />
            </AppPaneProvider>,
        );

        expect(screen.findByTestId('session-auth-sync-error')).toBeTruthy();
        expect(screen.findByTestId('session-auth-sync-error-restore')).toBeTruthy();
        expect(screen.findByTestId('session-auth-sync-error-retry')).toBeNull();

        await pressTestInstanceAsync(
            screen.findByTestId('session-auth-sync-error-restore'),
            'session auth sync error restore action',
        );

        expect(routerPushSpy).toHaveBeenCalledWith('/restore');
    });

    it('ignores auth sync errors that belong to a different scoped server', async () => {
        syncErrorState = {
            message: 'Authentication required',
            retryable: false,
            kind: 'auth',
            at: 123,
            serverId: 'server-b',
        };
        sessionState = { ...sessionState, serverId: 'server-a' };
        const { SessionView } = await sessionViewModulePromise;

        const screen = await renderScreen(
            <AppPaneProvider>
                <SessionView id="s1" routeServerId="server-a" />
            </AppPaneProvider>,
        );

        expect(screen.findAllByTestId('session-composer-input')).toHaveLength(1);
        expect(screen.findByTestId('session-auth-sync-error')).toBeNull();
    });

    it('surfaces endpoint auth_failed as a restore-account action even when syncError is clear', async () => {
        endpointConnectivityStatus = 'auth_failed';
        const { SessionView } = await sessionViewModulePromise;

        const screen = await renderScreen(
            <AppPaneProvider>
                <SessionView id="s1" />
            </AppPaneProvider>,
        );

        expect(screen.findByTestId('session-composer-input')).toBeTruthy();
        expect(screen.findByTestId('session-auth-sync-error')).toBeTruthy();
        expect(screen.findByTestId('session-auth-sync-error-restore')).toBeTruthy();
    });

    it('shows the auth recovery surface instead of the deleted shell when auth fails and the session is missing', async () => {
        endpointConnectivityStatus = 'auth_failed';
        sessionState = null;
        const { SessionView } = await sessionViewModulePromise;

        const screen = await renderScreen(
            <AppPaneProvider>
                <SessionView id="s1" />
            </AppPaneProvider>,
        );

        expect(screen.findByTestId('session-auth-required-fallback')).toBeTruthy();
        expect(screen.findByTestId('session-auth-sync-error-restore')).toBeTruthy();
        expect(screen.getTextContent()).not.toContain('errors.sessionDeleted');
    });

    it('keeps the loading shell while route hydration is pending after global data is ready', async () => {
        isDataReadyState = true;
        sessionState = null;
        const { SessionView } = await sessionViewModulePromise;

        const screen = await renderScreen(
            <AppPaneProvider>
                <SessionView
                    id="s1"
                    routeHydrationState={{ kind: 'loading', sessionId: 's1', reason: 'store-miss' }}
                />
            </AppPaneProvider>,
        );

        expect(screen.getTextContent()).not.toContain('errors.sessionDeleted');
        expect(screen.findAllByTestId('session-route-loading')).toHaveLength(1);
        expect(screen.findByTestId('session-auth-required-fallback')).toBeNull();
    });

    it('marks the route-visible surface before route hydration accepts the full session', async () => {
        isDataReadyState = true;
        sessionState = null;
        const {
            getSessionSurfaceVisibilitySnapshot,
            resetSessionSurfaceVisibilityForTests,
        } = await import('@/sync/domains/session/sessionSurfaceVisibility');
        resetSessionSurfaceVisibilityForTests();
        const { SessionView } = await sessionViewModulePromise;

        const screen = await renderScreen(
            <AppPaneProvider>
                <SessionView
                    id="s1"
                    routeHydrationState={{ kind: 'loading', sessionId: 's1', reason: 'store-miss' }}
                />
            </AppPaneProvider>,
        );

        expect(getSessionSurfaceVisibilitySnapshot()).toEqual({
            focusedSessionId: 's1',
            routeAnchorSessionId: 's1',
            visibleSessionIds: ['s1'],
        });

        await screen.unmount();
        expect(getSessionSurfaceVisibilitySnapshot()).toEqual({
            focusedSessionId: null,
            routeAnchorSessionId: null,
            visibleSessionIds: [],
        });
    });

    it('renders retrying route hydration separately from cold loading', async () => {
        isDataReadyState = true;
        sessionState = null;
        const { SessionView } = await sessionViewModulePromise;

        const screen = await renderScreen(
            <AppPaneProvider>
                <SessionView
                    id="s1"
                    routeHydrationState={{ kind: 'retrying', sessionId: 's1', cause: 'server_unavailable' }}
                />
            </AppPaneProvider>,
        );

        expect(screen.findAllByTestId('session-route-loading')).toHaveLength(0);
        expect(screen.findAllByTestId('session-route-retrying')).toHaveLength(1);
        expect(screen.getTextContent()).toContain('newSession.notConnectedToServer');
        expect(screen.getTextContent()).not.toContain('errors.sessionDeleted');
    });

    it('shows the deleted shell only after route hydration returns terminal missing', async () => {
        isDataReadyState = true;
        sessionState = null;
        const { SessionView } = await sessionViewModulePromise;

        const screen = await renderScreen(
            <AppPaneProvider>
                <SessionView
                    id="s1"
                    routeHydrationState={{ kind: 'missing', sessionId: 's1', cause: 'not_found' }}
                />
            </AppPaneProvider>,
        );

        expect(screen.getTextContent()).toContain('errors.sessionDeleted');
    });

    it('keeps the header neutral while route hydration is pending', async () => {
        isDataReadyState = true;
        sessionState = null;
        const { SessionView } = await sessionViewModulePromise;

        const screen = await renderScreen(
            <AppPaneProvider>
                <SessionView
                    id="s1"
                    routeHydrationState={{ kind: 'retrying', sessionId: 's1', cause: 'network' }}
                />
            </AppPaneProvider>,
        );

        expect(screen.findByTestId('session-header-title')?.props.children).toBe('');
        expect(screen.getTextContent()).not.toContain('errors.sessionDeleted');
    });
});
