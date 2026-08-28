import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    PluginProjectionV2Schema,
    RPC_ERROR_CODES,
    type ExternalSessionCandidateV1,
    type ExternalSessionLinkEnsureResponse,
    type ExternalSessionsCandidatesListResponse,
    type PluginProjectionV2,
} from '@happier-dev/protocol';
import { createCapturingLegendListMock, createDeferred, flushHookEffects, renderScreen } from '@/dev/testkit';
import { createPassThroughModule } from '@/dev/testkit/mocks/components';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';
import { createReactNativeWebMock } from '@/dev/testkit/mocks/reactNative';
import { createModalModuleMock } from '@/dev/testkit/mocks/modal';
import { createStorageModuleStub } from '@/dev/testkit/mocks/storage';
import { createTextModuleMock } from '@/dev/testkit/mocks/text';
import { createUnistylesMock } from '@/dev/testkit/mocks/unistyles';
import type {
    MergedBackendProjectionEntry,
    MergedProviderProjectionEntry,
} from '@/agents/backendCatalog/mergedProjectionTypes';
import { AgentCatalogIdentityIcon } from '@/agents/presentation/AgentCatalogIdentityIcon';
import { installNewSessionComponentsCommonModuleMocks } from '../../new/components/newSessionComponentsTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const candidatesListSpy = vi.hoisted(() => vi.fn(async (): Promise<ExternalSessionsCandidatesListResponse> => ({
    ok: true,
    candidates: [
        {
            remoteSessionId: 'codex-session-1',
            title: 'Existing Codex Session',
            updatedAtMs: 1_700_000_000_000,
            activity: 'running',
            details: {
                path: '/tmp/worktree',
                source: { kind: 'codexHome', home: 'user', homePath: '/tmp/custom-home' },
            },
        },
    ] as ExternalSessionCandidateV1[],
    nextCursor: null,
})));
const linkEnsureSpy = vi.hoisted(() => vi.fn(async (): Promise<ExternalSessionLinkEnsureResponse> => ({
    ok: true,
    sessionId: 'happy-session-1',
    created: true,
})));
const routerPushSpy = vi.hoisted(() => vi.fn());
const modalAlertSpy = vi.hoisted(() => vi.fn());
const accountSettingsState = vi.hoisted(() => ({
    current: {} as Record<string, unknown>,
}));
const mutateAccountSettingsSpy = vi.hoisted(() => vi.fn(async (
    mutate: (raw: Record<string, unknown>) => Record<string, unknown>,
) => {
    accountSettingsState.current = mutate(accountSettingsState.current);
}));
const profileMock = vi.hoisted(() => ({
    connectedServicesV2: [
        {
            serviceId: 'openai-codex',
            profiles: [{ profileId: 'work', status: 'connected' }],
        },
    ],
}));
const settingsMock = vi.hoisted(() => ({
    connectedServicesProfileLabelByKey: {
        'openai-codex/work': 'Work Profile',
    },
}));
const daemonProjectionHookSpy = vi.hoisted(() => vi.fn());
const daemonProjectionState = vi.hoisted((): {
    current: {
        phase: 'loading' | 'ready' | 'unsupported' | 'error';
        inputs: {
            mergedProviderProjectionById: Record<string, MergedProviderProjectionEntry>;
            mergedBackendProjectionById: Record<string, MergedBackendProjectionEntry>;
            discoveredBackendIds: string[];
            pluginProjectionV2?: PluginProjectionV2 | null;
        } | null;
    };
} => ({
    current: {
        phase: 'ready' as const,
        inputs: {
            mergedProviderProjectionById: {},
            mergedBackendProjectionById: {},
            discoveredBackendIds: [],
        },
    },
}));

function createExternalSessionsBrowsePluginProjection(): PluginProjectionV2 {
    const createAgent = (params: Readonly<{
        id: string;
        localId: string;
        sourceKind: string;
        instances?: readonly unknown[];
        schemaFields?: readonly unknown[];
        keySegments?: readonly unknown[];
    }>) => ({
        id: params.id,
        externalSessions: {
            agent: {
                pluginId: 'happier.external-sessions-screen-fixture',
                localId: params.localId,
            },
            generation: 1,
            operations: {
                listCandidates: true,
                resolveLinkIdentity: true,
                pageTranscript: true,
                readAfterTranscript: true,
            },
            sources: [{
                sourceKind: params.sourceKind,
                schema: {
                    fields: params.schemaFields ?? [
                        { name: 'kind', kind: 'literal', value: params.sourceKind },
                    ],
                },
                key: {
                    segments: params.keySegments ?? [
                        { kind: 'literal', value: params.sourceKind },
                    ],
                },
                instances: params.instances ?? [{ kind: 'default', constants: {} }],
            }],
        },
    });
    return PluginProjectionV2Schema.parse({
        v: 2,
        generation: 1,
        installedPackagesById: {
            'happier.external-sessions-screen-fixture': {
                id: 'happier.external-sessions-screen-fixture',
                displayName: 'External Sessions screen fixture',
                enabled: true,
                source: { kind: 'bundled', locator: 'happier.external-sessions-screen-fixture' },
            },
        },
        agentsById: {
            codex: createAgent({
                id: 'codex',
                localId: 'codex',
                sourceKind: 'codexHome',
                schemaFields: [
                    { name: 'kind', kind: 'literal', value: 'codexHome' },
                    { name: 'home', kind: 'enum', values: ['user', 'connectedService'] },
                    { name: 'homePath', kind: 'string', optional: true },
                    { name: 'connectedServiceId', kind: 'string', optional: true },
                    { name: 'connectedServiceProfileId', kind: 'string', optional: true },
                    { name: 'connectedServiceGroupId', kind: 'string', optional: true },
                ],
                keySegments: [
                    { kind: 'literal', value: 'codexHome' },
                    { kind: 'field', field: 'home' },
                    { kind: 'field', field: 'connectedServiceId' },
                    { kind: 'field', field: 'connectedServiceProfileId' },
                ],
                instances: [
                    { kind: 'default', constants: { home: 'user' } },
                    {
                        kind: 'connectedServiceProfiles',
                        serviceId: 'openai-codex',
                        constants: { home: 'connectedService' },
                        fields: {
                            serviceId: 'connectedServiceId',
                            profileId: 'connectedServiceProfileId',
                        },
                    },
                ],
            }),
            claude: createAgent({ id: 'claude', localId: 'claude', sourceKind: 'claudeConfig' }),
            ohMyPi: createAgent({ id: 'ohMyPi', localId: 'ohmypi', sourceKind: 'ohMyPiAgentDir' }),
            opencode: createAgent({ id: 'opencode', localId: 'opencode', sourceKind: 'opencodeServer' }),
        },
    });
}
let machinesState: Array<{
    id: string;
    active: boolean;
    metadata: {
        displayName: string;
        host: string;
        homeDir?: string;
    };
}> = [
    { id: 'machine-1', active: true, metadata: { displayName: 'MacBook Pro', host: 'mbp.local' } },
    { id: 'machine-2', active: false, metadata: { displayName: 'Linux Box', host: 'linux.local' } },
];

const expoRouterMock = createExpoRouterMock({
    router: { push: routerPushSpy },
});

installNewSessionComponentsCommonModuleMocks({
    reactNative: () => createReactNativeWebMock({
        View: 'View',
        TextInput: 'TextInput',
        ActivityIndicator: 'ActivityIndicator',
        Pressable: 'Pressable',
        ScrollView: 'ScrollView',
    }),
    unistyles: () => createUnistylesMock({
        theme: {
            colors: {
                text: '#000',
                textSecondary: '#666',
                textTertiary: '#444',
                divider: '#ddd',
                surface: '#fff',
                surfaceHigh: '#f5f5f5',
                surfacePressedOverlay: '#eee',
                success: '#0f0',
                accent: { orange: '#f90' },
                modal: { border: '#ddd' },
                shadow: { color: '#000' },
                groupped: { background: '#fff' },
                header: { tint: '#000' },
            },
        },
    }),
    router: () => expoRouterMock.module,
    text: () => createTextModuleMock({
        translate: (key: string, params?: Record<string, unknown>) => {
            if (key === 'time.nowShort') return 'now';
            if (key === 'time.minutesAgoShort') return `${String(params?.count)}m ago`;
            if (key === 'time.hoursAgoShort') return `${String(params?.count)}h ago`;
            if (key === 'time.daysAgoShort') return `${String(params?.count)}d ago`;
            return key;
        },
    }),
    modal: () => createModalModuleMock({
        spies: {
            alert: modalAlertSpy,
        },
    }).module,
    storage: () => createStorageModuleStub({
        useAllMachines: () => machinesState,
        useSetting: (key: string) => {
            if (key === 'externalSessionsSettingsV1') {
                return accountSettingsState.current.externalSessionsSettingsV1;
            }
            if (key === 'connectedServicesProfileLabelByKey') {
                return settingsMock.connectedServicesProfileLabelByKey;
            }
            if (key === 'backendEnabledByTargetKey') return {};
            if (key === 'acpCatalogSettingsV1') return { v: 2, backends: [] };
            return undefined;
        },
    }),
});
vi.mock('@/sync/sync', () => ({
    sync: {
        mutateAccountSettings: mutateAccountSettingsSpy,
    },
}));

vi.mock('@/sync/store/hooks', () => ({
    useProfile: () => profileMock,
    useLocalSetting: (key: string) => key === 'uiItemDensity' ? 'comfortable' : undefined,
}));
vi.mock('@/agents/backendCatalog/useDaemonMergedProjectionInputs', () => ({
    useDaemonMergedProjectionInputs: (params: unknown) => {
        daemonProjectionHookSpy(params);
        return daemonProjectionState.current;
    },
}));

vi.mock('@/components/ui/lists/ItemList', () => createPassThroughModule(['ItemList']));
vi.mock('@/components/ui/lists/ItemGroup', () => createPassThroughModule(['ItemGroup']));
vi.mock('@/components/ui/lists/Item', () => createPassThroughModule(['Item']));
vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => createPassThroughModule(['DropdownMenu']));
vi.mock('@/components/ui/forms/Switch', () => createPassThroughModule(['Switch']));
vi.mock('@/components/ui/popover', () => createPassThroughModule(['PopoverScope']));
vi.mock('@/components/ui/text/Text', () => createPassThroughModule(['Text', 'TextInput']));
vi.mock('@/components/ui/status/StatusPill', () => ({
    StatusPill: (props: Record<string, unknown>) => React.createElement('StatusPill', props),
    resolveStatusPillVariantForState: (state: string) => state === 'live'
        ? 'success'
        : state === 'needsAttention'
            ? 'warning'
            : 'neutral',
}));
vi.mock('@/agents/registry/AgentIcon', () => ({
    AgentIcon: (props: Record<string, unknown>) => React.createElement('AgentIcon', props),
}));

const { module: capturedLegendList, state: legendListState } = createCapturingLegendListMock({
    renderItems: true,
});

vi.mock('@legendapp/list/react-native', () => ({
    LegendList: capturedLegendList.LegendList,
}));

vi.mock('@/sync/ops/machineExternalSessions', () => ({
    machineExternalSessionsCandidatesList: candidatesListSpy,
    machineExternalSessionLinkEnsure: linkEnsureSpy,
}));

const externalSessionsBrowseScreenModulePromise = import('./ExternalSessionsBrowseScreen');

type DropdownTriggerPresentation = Readonly<{
    title: string;
    subtitle?: string;
}>;

type DropdownMenuTestNode = Readonly<{
    props?: {
        items?: ReadonlyArray<Readonly<{
            id: string;
            icon?: React.ReactElement;
        }>>;
        itemRowProps?: {
            density?: unknown;
        };
        itemTrigger?: {
            itemProps?: {
                testID?: string;
                density?: unknown;
            };
            showSelectedDetail?: boolean;
            subtitleFormatter?: (presentation: DropdownTriggerPresentation) => string;
        };
        onSelect?: (value: string) => Promise<void> | void;
        popoverBoundaryRef?: React.RefObject<unknown> | null;
        selectedId?: string;
    };
}>;

function findDropdownMenuByTriggerTestId(
    screen: { findAllByType: (type: unknown) => DropdownMenuTestNode[] },
    testID: string,
): DropdownMenuTestNode | undefined {
    return screen.findAllByType('DropdownMenu').find((node) => node.props?.itemTrigger?.itemProps?.testID === testID);
}

describe('ExternalSessionsBrowseScreen', () => {
    beforeEach(() => {
        vi.useRealTimers();
        machinesState = [
            { id: 'machine-1', active: true, metadata: { displayName: 'MacBook Pro', host: 'mbp.local' } },
            { id: 'machine-2', active: false, metadata: { displayName: 'Linux Box', host: 'linux.local' } },
        ];
        candidatesListSpy.mockReset();
        daemonProjectionHookSpy.mockClear();
        daemonProjectionState.current = {
            phase: 'ready',
            inputs: {
                mergedProviderProjectionById: {},
                mergedBackendProjectionById: {},
                discoveredBackendIds: [],
                pluginProjectionV2: createExternalSessionsBrowsePluginProjection(),
            },
        };
        candidatesListSpy.mockResolvedValue({
            ok: true,
            candidates: [
                {
                    remoteSessionId: 'codex-session-1',
                    title: 'Existing Codex Session',
                    updatedAtMs: 1_700_000_000_000,
                    activity: 'running',
                    details: {
                        path: '/tmp/worktree',
                        source: { kind: 'codexHome', home: 'user', homePath: '/tmp/custom-home' },
                    },
                },
            ] as ExternalSessionCandidateV1[],
            nextCursor: null,
        });
        linkEnsureSpy.mockClear();
        routerPushSpy.mockClear();
        modalAlertSpy.mockClear();
        mutateAccountSettingsSpy.mockClear();
        accountSettingsState.current = {};
    });

    it('renders cold daemon projection loading instead of an authoritative empty result', async () => {
        daemonProjectionState.current = {
            phase: 'loading',
            inputs: null,
        };
        const { ExternalSessionsBrowseScreen } = await externalSessionsBrowseScreenModulePromise;
        const screen = await renderScreen(<ExternalSessionsBrowseScreen />);
        await flushHookEffects();

        expect(screen.findByTestId('direct-session-candidates:loading')).not.toBeNull();
        expect(screen.findByTestId('direct-session-candidates:empty')).toBeNull();
        expect(candidatesListSpy).not.toHaveBeenCalled();
    });

    it('renders an actionable unavailable state for an unsupported daemon projection', async () => {
        daemonProjectionState.current = {
            phase: 'unsupported',
            inputs: null,
        };
        const { ExternalSessionsBrowseScreen } = await externalSessionsBrowseScreenModulePromise;
        const screen = await renderScreen(<ExternalSessionsBrowseScreen />);
        await flushHookEffects();

        expect(screen.findByTestId('direct-session-candidates:unavailable')).not.toBeNull();
        expect(screen.findByTestId('direct-session-candidates:empty')).toBeNull();
        expect(screen.findByTestId('direct-session-candidates:unavailable-action')).not.toBeNull();
        expect(candidatesListSpy).not.toHaveBeenCalled();
    });

    it('retries a failed daemon projection without presenting an authoritative empty result', async () => {
        daemonProjectionState.current = {
            phase: 'error',
            inputs: null,
        };
        const { ExternalSessionsBrowseScreen } = await externalSessionsBrowseScreenModulePromise;
        const screen = await renderScreen(<ExternalSessionsBrowseScreen />);
        await flushHookEffects();

        expect(screen.findByTestId('direct-session-candidates:projection-error')).not.toBeNull();
        expect(screen.findByTestId('direct-session-candidates:empty')).toBeNull();

        daemonProjectionState.current = {
            phase: 'ready',
            inputs: {
                mergedProviderProjectionById: {},
                mergedBackendProjectionById: {},
                discoveredBackendIds: [],
                pluginProjectionV2: createExternalSessionsBrowsePluginProjection(),
            },
        };
        await screen.pressByTestIdAsync('direct-session-candidates:projection-error-action');
        await flushHookEffects();

        expect(screen.findByTestId('direct-session-candidate:codex-session-1')).not.toBeNull();
        expect(candidatesListSpy).toHaveBeenCalledTimes(1);
    });

    it('offers one default-off source consent only from the successful scope and mutates no link side effect', async () => {
        const scope = {
            qualifiedIdentity: {
                v: 1 as const,
                agent: {
                    pluginId: 'happier.external-sessions-screen-fixture',
                    localId: 'codex',
                },
                source: { kind: 'codexHome', contractVersion: 1 as const },
            },
            sourcePolicyId: `es-source-policy:v1:${'a'.repeat(64)}` as const,
        };
        candidatesListSpy.mockResolvedValueOnce({
            ok: true,
            candidates: [],
            nextCursor: null,
            autoLinkPolicyScopeV1: scope,
        });
        const { ExternalSessionsBrowseScreen } = await externalSessionsBrowseScreenModulePromise;
        const screen = await renderScreen(<ExternalSessionsBrowseScreen />);
        await flushHookEffects();

        const row = screen.findByTestId('external-sessions-browse-auto-link');
        expect(row).toBeTruthy();
        expect(row?.props.title).toBe('externalSessions.browseAutoLinkTitle');
        const toggle = row?.props.rightElement;
        expect(toggle.props.value).toBe(false);

        await act(async () => {
            await toggle.props.onValueChange(true);
        });
        expect(mutateAccountSettingsSpy).toHaveBeenCalledTimes(1);
        expect(linkEnsureSpy).not.toHaveBeenCalled();
        const updateSettings = mutateAccountSettingsSpy.mock.calls[0]?.[0];
        expect(updateSettings?.({}).externalSessionsSettingsV1).toEqual(
            expect.objectContaining({
                autoLinkSourcePolicies: [
                    expect.objectContaining({
                        machineId: 'machine-1',
                        qualifiedIdentity: scope.qualifiedIdentity,
                        sourcePolicyId: scope.sourcePolicyId,
                        enabledAtMs: expect.any(Number),
                    }),
                ],
            }),
        );
    });

    it('hides automatic-link consent when the successful result has no policy scope', async () => {
        const { ExternalSessionsBrowseScreen } = await externalSessionsBrowseScreenModulePromise;
        const screen = await renderScreen(<ExternalSessionsBrowseScreen />);
        await flushHookEffects();

        expect(screen.findByTestId('external-sessions-browse-auto-link')).toBeNull();
        expect(mutateAccountSettingsSpy).not.toHaveBeenCalled();
        expect(linkEnsureSpy).not.toHaveBeenCalled();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('loads candidates for the default machine and provider', async () => {
        const { ExternalSessionsBrowseScreen } = await externalSessionsBrowseScreenModulePromise;
        const screen = await renderScreen(<ExternalSessionsBrowseScreen />);

        await flushHookEffects();

        expect(candidatesListSpy).toHaveBeenCalledWith({
            machineId: 'machine-1',
            agentId: 'codex',
            source: { kind: 'codexHome', home: 'user' },
            limit: 50,
        }, expect.objectContaining({ signal: expect.any(AbortSignal) }));

        const machineDropdown = findDropdownMenuByTriggerTestId(screen, 'direct-session-machine-picker-trigger');
        const providerDropdown = findDropdownMenuByTriggerTestId(screen, 'direct-session-provider-picker-trigger');
        const sourceDropdown = findDropdownMenuByTriggerTestId(screen, 'direct-session-source-picker-trigger');
        const popoverScopes = screen.findAllByType('PopoverScope' as any);
        const popoverBoundaryRef = popoverScopes[0]?.props?.boundaryRef;

        expect(machineDropdown).toBeTruthy();
        expect(providerDropdown).toBeTruthy();
        expect(sourceDropdown).toBeTruthy();
        expect(popoverScopes).toHaveLength(1);
        expect(popoverBoundaryRef).toBeTruthy();
        expect(machineDropdown?.props?.popoverBoundaryRef).toBe(popoverBoundaryRef);
        expect(providerDropdown?.props?.popoverBoundaryRef).toBe(popoverBoundaryRef);
        expect(sourceDropdown?.props?.popoverBoundaryRef).toBe(popoverBoundaryRef);
        const itemGroups = screen.findAllByType('ItemGroup' as any);
        expect(itemGroups[0]?.props.title).toBe('externalSessions.browseFiltersTitle');
        expect(machineDropdown?.props?.itemTrigger?.itemProps?.density).toBeUndefined();
        expect(providerDropdown?.props?.itemTrigger?.itemProps?.density).toBeUndefined();
        expect(sourceDropdown?.props?.itemTrigger?.itemProps?.density).toBeUndefined();
        expect(machineDropdown?.props?.itemTrigger?.showSelectedDetail).toBe(false);
        expect(providerDropdown?.props?.itemTrigger?.showSelectedDetail).toBe(false);
        expect(sourceDropdown?.props?.itemTrigger?.showSelectedDetail).toBe(false);
        expect(providerDropdown?.props?.items?.length).toBeGreaterThan(0);
        expect(providerDropdown?.props?.items?.every((item) => item.icon?.type === AgentCatalogIdentityIcon)).toBe(true);
        expect(machineDropdown?.props?.itemRowProps?.density).toBeUndefined();
        expect(providerDropdown?.props?.itemRowProps?.density).toBeUndefined();
        expect(sourceDropdown?.props?.itemRowProps?.density).toBeUndefined();
        expect(typeof machineDropdown?.props?.itemTrigger?.subtitleFormatter).toBe('function');
        expect(typeof providerDropdown?.props?.itemTrigger?.subtitleFormatter).toBe('function');
        expect(typeof sourceDropdown?.props?.itemTrigger?.subtitleFormatter).toBe('function');
        expect(machineDropdown!.props?.itemTrigger?.subtitleFormatter?.({
            title: 'Leeroys-MacBook-Pro',
            subtitle: 'Active now',
        })).toBe('Leeroys-MacBook-Pro · Active now');
        expect(providerDropdown!.props?.itemTrigger?.subtitleFormatter?.({
            title: 'Codex',
            subtitle: undefined,
        })).toBe('Codex');
        expect(sourceDropdown!.props?.itemTrigger?.subtitleFormatter?.({
            title: 'My Codex home',
            subtitle: undefined,
        })).toBe('My Codex home');

        const candidateItem = screen.findByTestId('direct-session-candidate:codex-session-1');
        expect(candidateItem).toBeTruthy();
        expect(candidateItem?.props.title).toBe('Existing Codex Session');
        const candidateSubtitle = candidateItem?.props.subtitle;
        expect(React.isValidElement(candidateSubtitle)).toBe(true);
        const candidateSubtitleLines = React.Children.toArray((candidateSubtitle as any).props.children) as any[];
        expect(String(candidateSubtitleLines[0]?.props?.children)).toMatch(/^\d+(?:m|h|d|w|mo|y)$/);
        expect(String(candidateSubtitleLines[2]?.props?.children)).toContain('/tmp/worktree');
        expect(candidateSubtitleLines.map((line) => String(line?.props?.children ?? '')).join('\n')).not.toContain('codex-session-1');
        expect(candidateItem?.props.density).toBeUndefined();
        expect(candidateItem?.props.icon?.type?.name).toBe('AgentIcon');
        expect(candidateItem?.props.icon?.props.agentId).toBe('codex');
        expect(String(candidateSubtitleLines[2]?.props?.children)).toContain('MacBook Pro');
        expect(String(candidateSubtitleLines[2]?.props?.children)).toContain('agentInput.agent.codex');
        expect(candidateItem?.props.rightElement).toBeTruthy();
        const badgeChildren = React.Children.toArray(candidateItem!.props.rightElement.props.children);
        const statusPill = badgeChildren.find((child: any) => child?.type?.name === 'StatusPill');
        expect((statusPill as any)?.props?.label).toBe('status.workingExternally');
        expect((statusPill as any)?.props?.isPulsing).toBe(true);
    });

    it('uses the selected machine home directory for candidate project presentation', async () => {
        machinesState = [{
            id: 'machine-1',
            active: true,
            metadata: {
                displayName: 'Windows PC',
                host: 'windows.local',
                homeDir: 'C:\\Users\\alice',
            },
        }];
        candidatesListSpy.mockResolvedValueOnce({
            ok: true,
            candidates: [{
                remoteSessionId: 'windows-session-1',
                title: 'Windows session',
                updatedAtMs: 1_700_000_000_000,
                details: { path: 'C:\\Users/alice\\projects/happier' },
            }],
            nextCursor: null,
        });
        const { ExternalSessionsBrowseScreen } = await externalSessionsBrowseScreenModulePromise;
        const screen = await renderScreen(<ExternalSessionsBrowseScreen />);
        await flushHookEffects();

        expect(screen.getTextContent()).toContain('~/PROJECTS/HAPPIER');
        expect(screen.getTextContent()).not.toContain('C:\\Users');
    });

    it('retries an empty-page continuation from its cursor instead of restarting the browse scope', async () => {
        candidatesListSpy
            .mockResolvedValueOnce({
                ok: true,
                candidates: [],
                nextCursor: 'cursor-after-empty-page',
            })
            .mockRejectedValueOnce(new Error('continuation failed'))
            .mockResolvedValueOnce({
                ok: true,
                candidates: [{
                    remoteSessionId: 'candidate-after-empty-page',
                    title: 'Recovered continuation',
                    updatedAtMs: 1_700_000_000_001,
                    activity: 'idle',
                }],
                nextCursor: null,
            });
        const { ExternalSessionsBrowseScreen } = await externalSessionsBrowseScreenModulePromise;
        const screen = await renderScreen(<ExternalSessionsBrowseScreen />);
        await flushHookEffects();

        expect(screen.findByTestId('direct-session-candidates:empty-continuation-action')).toBeNull();
        await act(async () => {
            legendListState.props?.onEndReached?.();
        });
        await flushHookEffects();
        expect(screen.findByTestId('direct-session-candidates:pagination:error')).not.toBeNull();

        await screen.pressByTestIdAsync('direct-session-candidates:pagination:retry');
        await flushHookEffects();

        expect(candidatesListSpy).toHaveBeenNthCalledWith(3, expect.objectContaining({
            cursor: 'cursor-after-empty-page',
        }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
        expect(screen.findByTestId('direct-session-candidate:candidate-after-empty-page')).not.toBeNull();
    });

    it('shows last-seen metadata and a recent badge for recently active sessions', async () => {
        candidatesListSpy.mockResolvedValueOnce({
            ok: true,
            candidates: [
                {
                    remoteSessionId: 'claude-session-1',
                    title: 'Recent Claude Session',
                    updatedAtMs: 1_700_000_000_000,
                    activity: 'active_recently',
                    details: {
                        path: '/tmp/claude-project',
                        source: { kind: 'codexHome', home: 'user', homePath: '/tmp/custom-home' },
                    },
                },
            ],
            nextCursor: null,
        } as any);
        const { ExternalSessionsBrowseScreen } = await externalSessionsBrowseScreenModulePromise;

        const screen = await renderScreen(<ExternalSessionsBrowseScreen />);

        await flushHookEffects();

        const candidateItem = screen.findByTestId('direct-session-candidate:claude-session-1');
        expect(candidateItem).toBeTruthy();
        const candidateSubtitle = candidateItem?.props.subtitle;
        expect(React.isValidElement(candidateSubtitle)).toBe(true);
        const candidateSubtitleLines = React.Children.toArray((candidateSubtitle as any).props.children) as any[];
        expect(String(candidateSubtitleLines[0]?.props?.children)).toMatch(/^\d+(?:m|h|d|w|mo|y)$/);
        expect(String(candidateSubtitleLines[2]?.props?.children)).toContain('/tmp/claude-project');
        const badgeChildren = React.Children.toArray(candidateItem!.props.rightElement.props.children);
        const statusPill = badgeChildren.find((child: any) => child?.type?.name === 'StatusPill');
        expect((statusPill as any)?.props?.label).toBe('status.recentlyActive');
        expect((statusPill as any)?.props?.isPulsing).toBe(false);
    });

    it('prefers the first active machine over an earlier offline machine when loading candidates', async () => {
        machinesState = [
            { id: 'machine-offline', active: false, metadata: { displayName: 'Offline Mac', host: 'offline.local' } },
            { id: 'machine-active', active: true, metadata: { displayName: 'Active Mac', host: 'active.local' } },
        ];
        const { ExternalSessionsBrowseScreen } = await externalSessionsBrowseScreenModulePromise;

        const screen = await renderScreen(<ExternalSessionsBrowseScreen />);

        await flushHookEffects();

        expect(candidatesListSpy).toHaveBeenCalledWith({
            machineId: 'machine-active',
            agentId: 'codex',
            source: { kind: 'codexHome', home: 'user' },
            limit: 50,
        }, expect.objectContaining({ signal: expect.any(AbortSignal) }));

        const machineDropdown = findDropdownMenuByTriggerTestId(screen, 'direct-session-machine-picker-trigger');
        expect(machineDropdown?.props?.selectedId).toBe('machine-active');
    });

    it('renders daemon-unavailable copy instead of raw unsupported RPC errors', async () => {
        candidatesListSpy.mockRejectedValueOnce(
            Object.assign(new Error('RPC method not available'), {
                rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
            }),
        );
        const { ExternalSessionsBrowseScreen } = await externalSessionsBrowseScreenModulePromise;

        const screen = await renderScreen(<ExternalSessionsBrowseScreen />);

        await flushHookEffects();

        const text = screen.getTextContent();
        expect(text).toContain('newSession.daemonRpcUnavailableBody');
        expect(text).not.toContain('RPC method not available');
    });

    it('renders daemon-unavailable copy instead of raw machine RPC timeout errors', async () => {
        candidatesListSpy.mockRejectedValueOnce(
            Object.assign(
                new Error('Machine RPC timed out after 1ms while using scoped scope for daemon.externalSessions.candidates.list'),
                { code: 'MACHINE_RPC_TIMEOUT' },
            ),
        );
        const { ExternalSessionsBrowseScreen } = await externalSessionsBrowseScreenModulePromise;

        const screen = await renderScreen(<ExternalSessionsBrowseScreen />);

        await flushHookEffects();

        const text = screen.getTextContent();
        expect(text).toContain('newSession.daemonRpcUnavailableBody');
        expect(text).not.toContain('Machine RPC timed out');
    });

    it('maps typed candidate-list failures without rendering daemon-owned messages', async () => {
        candidatesListSpy.mockResolvedValue({
            ok: false,
            errorCode: 'internal_error',
            error: 'sensitive daemon implementation detail',
        });
        const { ExternalSessionsBrowseScreen } = await externalSessionsBrowseScreenModulePromise;

        const screen = await renderScreen(<ExternalSessionsBrowseScreen />);

        await flushHookEffects();

        const text = screen.getTextContent();
        expect(text).toContain('externalSessions.browseFailedToLoad');
        expect(text).not.toContain('sensitive daemon implementation detail');
    });

    it('makes retained rows inert while the visible query is ahead of the published one', async () => {
        vi.useFakeTimers();
        const { ExternalSessionsBrowseScreen } = await externalSessionsBrowseScreenModulePromise;
        const screen = await renderScreen(<ExternalSessionsBrowseScreen />);

        await flushHookEffects();

        const rowIsDisabled = () => screen
            .findByTestId('direct-session-candidate:codex-session-1')?.props.disabled === true;
        expect(rowIsDisabled()).toBe(false);

        const searchInput = screen.findByTestId('direct-session-candidates-search-input');
        await act(async () => {
            searchInput!.props.onChangeText('refactor');
        });
        await flushHookEffects();

        // The 250 ms debounce has not fired, so the listing on screen still answers
        // the previous query. It must not stay actionable under a query it never ran.
        expect(candidatesListSpy).toHaveBeenCalledTimes(1);
        expect(rowIsDisabled()).toBe(true);

        await act(async () => {
            await vi.advanceTimersByTimeAsync(250);
        });
        await flushHookEffects();

        expect(candidatesListSpy).toHaveBeenCalledTimes(2);
        expect(rowIsDisabled()).toBe(false);
    });

    it('searches provider candidates through the daemon with the search field', async () => {
        vi.useFakeTimers();
        candidatesListSpy.mockResolvedValueOnce({
            ok: true,
            candidates: [
                {
                    remoteSessionId: 'codex-session-1',
                    title: 'Refactor direct session UX',
                    updatedAtMs: 1_700_000_000_000,
                    activity: 'running',
                    details: { path: '/tmp/happier/dev', source: { kind: 'codexHome', home: 'user', homePath: '/tmp/custom-home' } },
                },
                {
                    remoteSessionId: 'codex-session-2',
                    title: 'Investigate opencode startup',
                    updatedAtMs: 1_700_000_000_000,
                    activity: 'idle',
                    details: { path: '/tmp/opencode', source: { kind: 'codexHome', home: 'user', homePath: '/tmp/custom-home' } },
                },
            ],
            nextCursor: null,
        }).mockResolvedValueOnce({
            ok: true,
            candidates: [
                {
                    remoteSessionId: 'codex-hidden-session-9',
                    title: 'Fast filesystem result',
                    updatedAtMs: 1_700_000_000_000,
                    activity: 'idle',
                    details: { path: '/tmp/hidden', source: { kind: 'codexHome', home: 'user', homePath: '/tmp/custom-home' } },
                },
                {
                    remoteSessionId: 'codex-fast-only-session-8',
                    title: 'Fast-only filesystem result',
                    updatedAtMs: 1_699_999_999_000,
                    activity: 'idle',
                    details: { path: '/tmp/fast-only', source: { kind: 'codexHome', home: 'user', homePath: '/tmp/custom-home' } },
                },
            ],
            nextCursor: null,
            searchIncomplete: true,
        });
        let resolveAugmentedSearch!: (value: ExternalSessionsCandidatesListResponse) => void;
        const augmentedSearchPromise = new Promise<ExternalSessionsCandidatesListResponse>((resolve) => {
            resolveAugmentedSearch = resolve;
        });
        candidatesListSpy.mockImplementationOnce(() => augmentedSearchPromise);
        const { ExternalSessionsBrowseScreen } = await externalSessionsBrowseScreenModulePromise;

        const screen = await renderScreen(<ExternalSessionsBrowseScreen />);

        await flushHookEffects();

        const searchInput = screen.findByTestId('direct-session-candidates-search-input');
        expect(searchInput).toBeTruthy();
        expect(searchInput!.props.placeholder).toBe('externalSessions.browseSearchPlaceholder');

        await act(async () => {
            searchInput!.props.onChangeText('codex-hidden-session-9');
        });

        expect(candidatesListSpy).toHaveBeenCalledTimes(1);

        await act(async () => {
            await vi.advanceTimersByTimeAsync(250);
        });
        await flushHookEffects();

        expect(candidatesListSpy).toHaveBeenNthCalledWith(2, {
            machineId: 'machine-1',
            agentId: 'codex',
            source: { kind: 'codexHome', home: 'user' },
            limit: 50,
            searchTerm: 'codex-hidden-session-9',
            searchMode: 'fast',
        }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
        expect(candidatesListSpy).toHaveBeenNthCalledWith(3, {
            machineId: 'machine-1',
            agentId: 'codex',
            source: { kind: 'codexHome', home: 'user' },
            limit: 50,
            searchTerm: 'codex-hidden-session-9',
            searchMode: 'full',
        }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
        expect(screen.findByTestId('direct-session-candidates-search-augmenting')).toBeTruthy();
        expect(screen.findByTestId('direct-session-candidates-search-incomplete')).toBeTruthy();

        await act(async () => {
            resolveAugmentedSearch({
                ok: true,
                candidates: [
                    {
                        remoteSessionId: 'codex-hidden-session-9',
                        title: 'Augmented app-server result',
                        updatedAtMs: 1_700_000_000_000,
                        activity: 'idle',
                        details: { path: '/tmp/hidden', source: { kind: 'codexHome', home: 'user', homePath: '/tmp/custom-home' } },
                    },
                    {
                        remoteSessionId: 'codex-augmented-only-session-7',
                        title: 'Augmented-only app-server result',
                        updatedAtMs: 1_699_999_998_000,
                        activity: 'idle',
                        details: { path: '/tmp/augmented-only', source: { kind: 'codexHome', home: 'user', homePath: '/tmp/custom-home' } },
                    },
                ],
                nextCursor: null,
            });
            await augmentedSearchPromise;
        });
        await flushHookEffects();

        const candidateItem = screen.findByTestId('direct-session-candidate:codex-hidden-session-9');
        expect(candidateItem).toBeTruthy();
        expect(candidateItem?.props.testID).toBe('direct-session-candidate:codex-hidden-session-9');
        expect(candidateItem?.props.title).toBe('Augmented app-server result');
        expect(screen.findByTestId('direct-session-candidate:codex-fast-only-session-8')).toBeTruthy();
        expect(screen.findByTestId('direct-session-candidate:codex-augmented-only-session-7')).toBeTruthy();
        expect(screen.findByTestId('direct-session-candidates-search-incomplete')).toBeNull();
    });

    it('makes retained rows offline-aware instead of leaving them falsely actionable', async () => {
        candidatesListSpy.mockResolvedValue({
            ok: true,
            candidates: [
                {
                    remoteSessionId: 'codex-session-1',
                    title: 'Existing Codex Session',
                    updatedAtMs: 1_700_000_000_000,
                    activity: 'running',
                    details: {
                        path: '/tmp/worktree',
                        source: { kind: 'codexHome', home: 'user', homePath: '/tmp/custom-home' },
                    },
                },
                {
                    remoteSessionId: 'codex-session-linked',
                    title: 'Already Linked Session',
                    updatedAtMs: 1_700_000_000_001,
                    activity: 'idle',
                    linkedSessionId: 'happy-session-linked',
                    details: {
                        path: '/tmp/worktree',
                        source: { kind: 'codexHome', home: 'user', homePath: '/tmp/custom-home' },
                    },
                },
            ] as unknown as ExternalSessionCandidateV1[],
            nextCursor: null,
        });
        const { ExternalSessionsBrowseScreen } = await externalSessionsBrowseScreenModulePromise;
        const screen = await renderScreen(<ExternalSessionsBrowseScreen />);
        await flushHookEffects();

        expect(screen.findByTestId('direct-session-candidate:codex-session-1')?.props.disabled).toBe(false);

        // The machine goes away while its rows stay on screen.
        machinesState = [
            { id: 'machine-1', active: false, metadata: { displayName: 'MacBook Pro', host: 'mbp.local' } },
            { id: 'machine-2', active: false, metadata: { displayName: 'Linux Box', host: 'linux.local' } },
        ];
        await act(async () => {
            screen.tree.update(<ExternalSessionsBrowseScreen key="offline" />);
        });
        await flushHookEffects();

        // Linking needs the machine, so that row is inert rather than starting a round
        // trip that cannot succeed.
        expect(screen.findByTestId('direct-session-candidate:codex-session-1')?.props.disabled).toBe(true);
        linkEnsureSpy.mockClear();
        await screen.pressByTestIdAsync('direct-session-candidate:codex-session-1');
        expect(linkEnsureSpy).not.toHaveBeenCalled();

        // Opening a session that is already linked is local navigation and stays usable.
        expect(screen.findByTestId('direct-session-candidate:codex-session-linked')?.props.disabled).toBe(false);
        await screen.pressByTestIdAsync('direct-session-candidate:codex-session-linked');
        expect(routerPushSpy).toHaveBeenCalledWith('/session/happy-session-linked');

        // And the footer must not claim the stale listing is complete.
        const paginated = screen
            .findAllByProps({ testID: 'direct-session-candidates' })
            .find((node) => node.props?.pagination !== undefined);
        expect(paginated?.props.pagination.error).toBe('newSession.machineOfflineInlineBody');
    });

    it('links the selected provider session and navigates to the Happier session', async () => {
        const { ExternalSessionsBrowseScreen } = await externalSessionsBrowseScreenModulePromise;
        const screen = await renderScreen(<ExternalSessionsBrowseScreen />);

        await flushHookEffects();

        const candidateItem = screen.findByTestId('direct-session-candidate:codex-session-1');
        expect(candidateItem).toBeTruthy();

        await screen.pressByTestIdAsync('direct-session-candidate:codex-session-1');

        expect(linkEnsureSpy).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            agentId: 'codex',
            remoteSessionId: 'codex-session-1',
            titleHint: 'Existing Codex Session',
            directoryHint: '/tmp/worktree',
            source: { kind: 'codexHome', home: 'user', homePath: '/tmp/custom-home' },
        }));
        expect(routerPushSpy).toHaveBeenCalledWith('/session/happy-session-1');
    });

    it('links a candidate the still-building index has already served', async () => {
        const indexingContinuation = vi.fn(() => createDeferred<ExternalSessionsCandidatesListResponse>().promise);
        candidatesListSpy
            .mockResolvedValueOnce({
                ok: true,
                candidates: [
                    {
                        remoteSessionId: 'codex-session-1',
                        title: 'Existing Codex Session',
                        updatedAtMs: 1_700_000_000_000,
                        activity: 'running',
                        details: {
                            path: '/tmp/worktree',
                            source: { kind: 'codexHome', home: 'user', homePath: '/tmp/custom-home' },
                        },
                    },
                ] as ExternalSessionCandidateV1[],
                nextCursor: null,
                preparation: { kind: 'building_candidate_index', scanned: 50, total: 5_000 },
            })
            .mockImplementation(indexingContinuation);
        const { ExternalSessionsBrowseScreen } = await externalSessionsBrowseScreenModulePromise;
        const screen = await renderScreen(<ExternalSessionsBrowseScreen />);
        await flushHookEffects();

        const servedCandidate = screen.findByTestId('direct-session-candidate:codex-session-1');
        expect(servedCandidate).not.toBeNull();
        expect(servedCandidate?.props.disabled).toBe(false);
        expect(indexingContinuation).toHaveBeenCalled();

        await screen.pressByTestIdAsync('direct-session-candidate:codex-session-1');

        expect(linkEnsureSpy).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            agentId: 'codex',
            remoteSessionId: 'codex-session-1',
            titleHint: 'Existing Codex Session',
            directoryHint: '/tmp/worktree',
        }));
        expect(routerPushSpy).toHaveBeenCalledWith('/session/happy-session-1');
    });

    it('keeps a served candidate actionable after the index build is cancelled', async () => {
        const indexingContinuation = vi.fn(() => createDeferred<ExternalSessionsCandidatesListResponse>().promise);
        candidatesListSpy
            .mockResolvedValueOnce({
                ok: true,
                candidates: [
                    {
                        remoteSessionId: 'codex-session-1',
                        title: 'Existing Codex Session',
                        updatedAtMs: 1_700_000_000_000,
                        activity: 'running',
                        details: { path: '/tmp/worktree' },
                    },
                ] as ExternalSessionCandidateV1[],
                nextCursor: null,
                preparation: { kind: 'building_candidate_index', scanned: 50, total: 5_000 },
            })
            .mockImplementation(indexingContinuation);
        const { ExternalSessionsBrowseScreen } = await externalSessionsBrowseScreenModulePromise;
        const screen = await renderScreen(<ExternalSessionsBrowseScreen />);
        await flushHookEffects();
        expect(indexingContinuation).toHaveBeenCalled();

        await screen.pressByTestIdAsync('direct-session-candidates:indexing:cancel');
        await flushHookEffects();

        const servedCandidate = screen.findByTestId('direct-session-candidate:codex-session-1');
        expect(servedCandidate).not.toBeNull();
        expect(servedCandidate?.props.disabled).toBe(false);

        await screen.pressByTestIdAsync('direct-session-candidate:codex-session-1');

        expect(linkEnsureSpy).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            agentId: 'codex',
            remoteSessionId: 'codex-session-1',
        }));
    });

    it('admits only one link submission before React commits the pending state', async () => {
        let resolveLink!: (value: Awaited<ReturnType<typeof linkEnsureSpy>>) => void;
        const pendingLink = new Promise<Awaited<ReturnType<typeof linkEnsureSpy>>>((resolve) => {
            resolveLink = resolve;
        });
        linkEnsureSpy.mockImplementationOnce(() => pendingLink);
        const { ExternalSessionsBrowseScreen } = await externalSessionsBrowseScreenModulePromise;
        const screen = await renderScreen(<ExternalSessionsBrowseScreen />);

        await flushHookEffects();

        const candidateItem = screen.findByTestId('direct-session-candidate:codex-session-1');
        expect(candidateItem).toBeTruthy();
        await act(async () => {
            const first = candidateItem!.props.onPress?.();
            const second = candidateItem!.props.onPress?.();
            expect(linkEnsureSpy).toHaveBeenCalledTimes(1);
            resolveLink({
                ok: true,
                sessionId: 'happy-session-1',
                created: true,
            });
            await first;
            await second;
        });
    });

    it('maps typed link failures without rendering daemon-owned messages', async () => {
        linkEnsureSpy.mockResolvedValueOnce({
            ok: false,
            errorCode: 'agent_unavailable',
            error: 'private daemon path and command',
        });
        const { ExternalSessionsBrowseScreen } = await externalSessionsBrowseScreenModulePromise;
        const screen = await renderScreen(<ExternalSessionsBrowseScreen />);

        await flushHookEffects();
        await screen.pressByTestIdAsync('direct-session-candidate:codex-session-1');

        expect(modalAlertSpy).toHaveBeenCalledWith(
            'common.error',
            'externalSessions.browseAgentUnavailable',
        );
        expect(modalAlertSpy).not.toHaveBeenCalledWith(
            expect.anything(),
            expect.stringContaining('private daemon path and command'),
        );
    });

    it('retains inert Agent and source choices while the selected machine projection refreshes', async () => {
        const { ExternalSessionsBrowseScreen } = await externalSessionsBrowseScreenModulePromise;
        const screen = await renderScreen(<ExternalSessionsBrowseScreen />);
        await flushHookEffects();

        expect(daemonProjectionHookSpy).toHaveBeenLastCalledWith(expect.objectContaining({
            retainInputsAcrossScopeChange: true,
        }));
        const retainedInputs = daemonProjectionState.current.inputs;
        candidatesListSpy.mockClear();
        daemonProjectionState.current = {
            phase: 'loading',
            inputs: retainedInputs,
        };

        await screen.update(
            <ExternalSessionsBrowseScreen onRequestClose={() => undefined} />,
        );
        await flushHookEffects();

        expect(findDropdownMenuByTriggerTestId(
            screen,
            'direct-session-provider-picker-trigger',
        )?.props?.selectedId).toBe('codex');
        expect(findDropdownMenuByTriggerTestId(
            screen,
            'direct-session-source-picker-trigger',
        )?.props?.selectedId).toBe('codex:user');
        const retainedCandidate = screen.findByTestId('direct-session-candidate:codex-session-1');
        expect(retainedCandidate).not.toBeNull();
        expect(retainedCandidate?.props.disabled).toBe(true);
        expect(screen.findByTestId('direct-session-candidates:pagination:loading')).not.toBeNull();

        await act(async () => {
            await retainedCandidate?.props.onPress?.();
        });

        expect(candidatesListSpy).not.toHaveBeenCalled();
        expect(linkEnsureSpy).not.toHaveBeenCalled();
        expect(routerPushSpy).not.toHaveBeenCalled();
    });

    it('keeps retained candidates mounted with retry when daemon projection refresh fails', async () => {
        const { ExternalSessionsBrowseScreen } = await externalSessionsBrowseScreenModulePromise;
        const screen = await renderScreen(<ExternalSessionsBrowseScreen />);
        await flushHookEffects();

        const retainedInputs = daemonProjectionState.current.inputs;
        candidatesListSpy.mockClear();
        daemonProjectionState.current = {
            phase: 'error',
            inputs: retainedInputs,
        };
        await screen.update(<ExternalSessionsBrowseScreen onRequestClose={() => undefined} />);
        await flushHookEffects();

        const retainedCandidate = screen.findByTestId('direct-session-candidate:codex-session-1');
        expect(retainedCandidate).not.toBeNull();
        expect(retainedCandidate?.props.disabled).toBe(true);
        expect(screen.findByTestId('direct-session-candidates:pagination:error')).not.toBeNull();

        daemonProjectionState.current = {
            phase: 'ready',
            inputs: retainedInputs,
        };
        await screen.pressByTestIdAsync('direct-session-candidates:pagination:retry');
        await flushHookEffects();

        expect(candidatesListSpy).toHaveBeenCalledTimes(1);
        expect(screen.findByTestId('direct-session-candidate:codex-session-1')?.props.disabled).toBe(false);
    });

    it('completes an in-flight candidate link across a daemon liveness refresh', async () => {
        let resolveLink!: (value: ExternalSessionLinkEnsureResponse) => void;
        const linkPromise = new Promise<ExternalSessionLinkEnsureResponse>((resolve) => {
            resolveLink = resolve;
        });
        linkEnsureSpy.mockImplementationOnce(() => linkPromise);
        const { ExternalSessionsBrowseScreen } = await externalSessionsBrowseScreenModulePromise;
        const screen = await renderScreen(<ExternalSessionsBrowseScreen />);
        await flushHookEffects();

        const retainedInputs = daemonProjectionState.current.inputs;
        const candidate = screen.findByTestId('direct-session-candidate:codex-session-1');
        let pendingPress: Promise<void> | undefined;
        await act(async () => {
            pendingPress = candidate?.props.onPress?.();
            await Promise.resolve();
        });
        expect(linkEnsureSpy).toHaveBeenCalledTimes(1);

        daemonProjectionState.current = {
            phase: 'loading',
            inputs: retainedInputs,
        };
        await screen.update(<ExternalSessionsBrowseScreen onRequestClose={() => undefined} />);
        await flushHookEffects();

        resolveLink({ ok: true, sessionId: 'happy-session-1', created: true });
        await act(async () => {
            await pendingPress;
        });

        expect(routerPushSpy).toHaveBeenCalledWith('/session/happy-session-1');
    });

    it('fences an in-flight candidate link when the selected machine changes', async () => {
        let resolveLink!: (value: ExternalSessionLinkEnsureResponse) => void;
        const linkPromise = new Promise<ExternalSessionLinkEnsureResponse>((resolve) => {
            resolveLink = resolve;
        });
        linkEnsureSpy.mockImplementationOnce(() => linkPromise);
        const { ExternalSessionsBrowseScreen } = await externalSessionsBrowseScreenModulePromise;
        const screen = await renderScreen(<ExternalSessionsBrowseScreen />);
        await flushHookEffects();

        const machineDropdown = findDropdownMenuByTriggerTestId(screen, 'direct-session-machine-picker-trigger');
        const candidate = screen.findByTestId('direct-session-candidate:codex-session-1');
        let pendingPress: Promise<void> | undefined;
        await act(async () => {
            pendingPress = candidate?.props.onPress?.();
            await Promise.resolve();
        });
        expect(linkEnsureSpy).toHaveBeenCalledTimes(1);

        await act(async () => {
            await machineDropdown!.props?.onSelect?.('machine-2');
        });
        await flushHookEffects();

        resolveLink({ ok: true, sessionId: 'stale-happy-session', created: true });
        await act(async () => {
            await pendingPress;
        });

        expect(routerPushSpy).not.toHaveBeenCalled();
    });

    it('fences a candidate press captured before the scope changed', async () => {
        candidatesListSpy.mockResolvedValue({
            ok: true,
            candidates: [
                {
                    remoteSessionId: 'codex-linked-1',
                    title: 'Linked Codex Session',
                    updatedAtMs: 1_700_000_000_000,
                    activity: 'idle',
                    linkedSessionId: 'happy-existing-1',
                    details: { path: '/tmp/linked' },
                },
                {
                    remoteSessionId: 'codex-session-1',
                    title: 'Existing Codex Session',
                    updatedAtMs: 1_700_000_000_000,
                    activity: 'running',
                    details: { path: '/tmp/worktree' },
                },
            ] as ExternalSessionCandidateV1[],
            nextCursor: null,
        });
        const { ExternalSessionsBrowseScreen } = await externalSessionsBrowseScreenModulePromise;
        const screen = await renderScreen(<ExternalSessionsBrowseScreen />);
        await flushHookEffects();

        const machineDropdown = findDropdownMenuByTriggerTestId(screen, 'direct-session-machine-picker-trigger');
        const staleLinkedPress = screen.findByTestId('direct-session-candidate:codex-linked-1')?.props.onPress;
        const staleUnlinkedPress = screen.findByTestId('direct-session-candidate:codex-session-1')?.props.onPress;
        expect(typeof staleLinkedPress).toBe('function');
        expect(typeof staleUnlinkedPress).toBe('function');

        await act(async () => {
            await machineDropdown!.props?.onSelect?.('machine-2');
        });
        await flushHookEffects();

        await act(async () => {
            await staleLinkedPress?.();
        });
        expect(routerPushSpy).not.toHaveBeenCalled();

        await act(async () => {
            await staleUnlinkedPress?.();
        });
        expect(linkEnsureSpy).not.toHaveBeenCalled();
        expect(routerPushSpy).not.toHaveBeenCalled();
    });

    it('fences a stale-scope candidate press before it picks a remote session id', async () => {
        const onPickRemoteSessionId = vi.fn();
        const { ExternalSessionsBrowseScreen } = await externalSessionsBrowseScreenModulePromise;
        const screen = await renderScreen(
            <ExternalSessionsBrowseScreen
                interaction="pickRemoteSessionId"
                onPickRemoteSessionId={onPickRemoteSessionId}
            />,
        );
        await flushHookEffects();

        const machineDropdown = findDropdownMenuByTriggerTestId(screen, 'direct-session-machine-picker-trigger');
        const stalePress = screen.findByTestId('direct-session-candidate:codex-session-1')?.props.onPress;

        await act(async () => {
            await machineDropdown!.props?.onSelect?.('machine-2');
        });
        await flushHookEffects();

        await act(async () => {
            await stalePress?.();
        });

        expect(onPickRemoteSessionId).not.toHaveBeenCalled();
    });

    it('links a candidate press captured before a daemon liveness round trip', async () => {
        const { ExternalSessionsBrowseScreen } = await externalSessionsBrowseScreenModulePromise;
        const screen = await renderScreen(<ExternalSessionsBrowseScreen />);
        await flushHookEffects();

        const retainedInputs = daemonProjectionState.current.inputs;
        const onPress = screen.findByTestId('direct-session-candidate:codex-session-1')?.props.onPress;
        expect(typeof onPress).toBe('function');

        daemonProjectionState.current = {
            phase: 'loading',
            inputs: retainedInputs,
        };
        await screen.update(<ExternalSessionsBrowseScreen onRequestClose={() => undefined} />);
        daemonProjectionState.current = {
            phase: 'ready',
            inputs: retainedInputs,
        };
        await screen.update(<ExternalSessionsBrowseScreen onRequestClose={() => undefined} />);
        await flushHookEffects();

        await act(async () => {
            await onPress?.();
        });

        expect(linkEnsureSpy).toHaveBeenCalledTimes(1);
        expect(routerPushSpy).toHaveBeenCalledWith('/session/happy-session-1');
    });

    it('keeps retained candidates inert until the post-projection refresh is authoritative', async () => {
        const { ExternalSessionsBrowseScreen } = await externalSessionsBrowseScreenModulePromise;
        const screen = await renderScreen(<ExternalSessionsBrowseScreen />);
        await flushHookEffects();

        const retainedInputs = daemonProjectionState.current.inputs;
        daemonProjectionState.current = {
            phase: 'loading',
            inputs: retainedInputs,
        };
        await screen.update(<ExternalSessionsBrowseScreen onRequestClose={() => undefined} />);
        await flushHookEffects();

        let resolveRefresh!: (value: ExternalSessionsCandidatesListResponse) => void;
        const refreshPromise = new Promise<ExternalSessionsCandidatesListResponse>((resolve) => {
            resolveRefresh = resolve;
        });
        candidatesListSpy.mockImplementationOnce(() => refreshPromise);
        daemonProjectionState.current = {
            phase: 'ready',
            inputs: retainedInputs,
        };
        await screen.update(<ExternalSessionsBrowseScreen onRequestClose={() => undefined} />);
        await act(async () => {
            await Promise.resolve();
        });

        const retainedCandidate = screen.findByTestId('direct-session-candidate:codex-session-1');
        expect(retainedCandidate?.props.disabled).toBe(true);
        await act(async () => {
            await retainedCandidate?.props.onPress?.();
        });
        expect(linkEnsureSpy).not.toHaveBeenCalled();

        resolveRefresh({
            ok: true,
            candidates: [{
                remoteSessionId: 'codex-session-1',
                title: 'Refreshed Codex Session',
                updatedAtMs: 1_700_000_000_001,
                activity: 'idle',
                details: { path: '/tmp/worktree' },
            }],
            nextCursor: null,
        });
        await flushHookEffects();

        expect(screen.findByTestId('direct-session-candidate:codex-session-1')?.props.disabled).toBe(false);
    });

    it('preserves retained candidates as inert context when the post-projection refresh fails', async () => {
        const { ExternalSessionsBrowseScreen } = await externalSessionsBrowseScreenModulePromise;
        const screen = await renderScreen(<ExternalSessionsBrowseScreen />);
        await flushHookEffects();

        const retainedInputs = daemonProjectionState.current.inputs;
        daemonProjectionState.current = {
            phase: 'loading',
            inputs: retainedInputs,
        };
        await screen.update(<ExternalSessionsBrowseScreen onRequestClose={() => undefined} />);
        await flushHookEffects();

        candidatesListSpy.mockResolvedValueOnce({
            ok: false,
            errorCode: 'internal_error',
            error: 'private daemon detail',
        });
        daemonProjectionState.current = {
            phase: 'ready',
            inputs: retainedInputs,
        };
        await screen.update(<ExternalSessionsBrowseScreen onRequestClose={() => undefined} />);
        await flushHookEffects();

        const retainedCandidate = screen.findByTestId('direct-session-candidate:codex-session-1');
        expect(retainedCandidate).not.toBeNull();
        expect(retainedCandidate?.props.disabled).toBe(true);
        expect(screen.findByTestId('direct-session-candidates:pagination:error')).not.toBeNull();
        await act(async () => {
            await retainedCandidate?.props.onPress?.();
        });
        expect(linkEnsureSpy).not.toHaveBeenCalled();

        candidatesListSpy.mockResolvedValueOnce({
            ok: true,
            candidates: [{
                remoteSessionId: 'codex-session-1',
                title: 'Recovered Codex Session',
                updatedAtMs: 1_700_000_000_002,
                activity: 'idle',
                details: { path: '/tmp/worktree' },
            }],
            nextCursor: null,
        });
        await screen.pressByTestIdAsync('direct-session-candidates:pagination:retry');
        await flushHookEffects();

        const recoveredCandidate = screen.findByTestId('direct-session-candidate:codex-session-1');
        expect(recoveredCandidate?.props.title).toBe('Recovered Codex Session');
        expect(recoveredCandidate?.props.disabled).toBe(false);
    });

    it('switches to the codex connected-service source before linking', async () => {
        const { ExternalSessionsBrowseScreen } = await externalSessionsBrowseScreenModulePromise;
        const screen = await renderScreen(<ExternalSessionsBrowseScreen />);
        const tree = screen.tree;

        await flushHookEffects();
        candidatesListSpy.mockClear();

        const sourceDropdown = findDropdownMenuByTriggerTestId(screen, 'direct-session-source-picker-trigger');
        expect(sourceDropdown).toBeTruthy();

        await act(async () => {
            await sourceDropdown!.props?.onSelect?.('codex:connected-service:openai-codex:work');
        });

        candidatesListSpy.mockResolvedValueOnce({
            ok: true,
            candidates: [
                {
                    remoteSessionId: 'codex-session-1',
                    title: 'Existing Codex Session',
                    updatedAtMs: 1_700_000_000_000,
                    activity: 'running',
                    details: {
                        path: '/tmp/worktree',
                        source: {
                            kind: 'codexHome',
                            home: 'connectedService',
                            connectedServiceId: 'openai-codex',
                            connectedServiceProfileId: 'work',
                            homePath: '/tmp/codex-work-home',
                        } as any,
                    },
                },
            ],
            nextCursor: null,
        });
        await act(async () => {
            tree.update(<ExternalSessionsBrowseScreen />);
        });
        await flushHookEffects();

        expect(candidatesListSpy).toHaveBeenCalledWith({
            machineId: 'machine-1',
            agentId: 'codex',
            source: { kind: 'codexHome', home: 'connectedService', connectedServiceId: 'openai-codex', connectedServiceProfileId: 'work' },
            limit: 50,
        }, expect.objectContaining({ signal: expect.any(AbortSignal) }));

        const candidateItem = screen.findByTestId('direct-session-candidate:codex-session-1');
        expect(candidateItem).toBeTruthy();

        await screen.pressByTestIdAsync('direct-session-candidate:codex-session-1');

        expect(linkEnsureSpy).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            agentId: 'codex',
            remoteSessionId: 'codex-session-1',
            titleHint: 'Existing Codex Session',
            directoryHint: '/tmp/worktree',
            source: expect.objectContaining({ kind: 'codexHome', home: 'connectedService', connectedServiceId: 'openai-codex', connectedServiceProfileId: 'work' } as any),
        }));
    });

    it('uses the candidate-provided ohMyPi agent dir when linking from the default source option', async () => {
        candidatesListSpy.mockResolvedValueOnce({
            ok: true,
            candidates: [
                {
                    remoteSessionId: 'omp-session-1',
                    title: 'Existing oh-my-pi Session',
                    updatedAtMs: 1_700_000_000_000,
                    activity: 'running',
                    details: {
                        path: '/tmp/omp-worktree',
                        source: {
                            kind: 'ohMyPiAgentDir',
                            agentDir: '/tmp/omp-agent',
                        },
                    },
                },
            ],
            nextCursor: null,
        });
        const { ExternalSessionsBrowseScreen } = await externalSessionsBrowseScreenModulePromise;
        const screen = await renderScreen(<ExternalSessionsBrowseScreen />);
        const tree = screen.tree;

        await flushHookEffects();

        const providerDropdown = findDropdownMenuByTriggerTestId(screen, 'direct-session-provider-picker-trigger');
        expect(providerDropdown).toBeTruthy();

        candidatesListSpy.mockResolvedValueOnce({
            ok: true,
            candidates: [
                {
                    remoteSessionId: 'omp-session-1',
                    title: 'Existing oh-my-pi Session',
                    updatedAtMs: 1_700_000_000_000,
                    activity: 'running',
                    details: {
                        path: '/tmp/omp-worktree',
                        source: {
                            kind: 'ohMyPiAgentDir',
                            agentDir: '/tmp/omp-agent',
                        },
                    },
                },
            ],
            nextCursor: null,
        });

        await act(async () => {
            await providerDropdown!.props?.onSelect?.('ohMyPi');
        });

        await act(async () => {
            tree.update(<ExternalSessionsBrowseScreen />);
        });
        await flushHookEffects();

        expect(candidatesListSpy).toHaveBeenCalledWith({
            machineId: 'machine-1',
            agentId: 'ohMyPi',
            source: { kind: 'ohMyPiAgentDir' },
            limit: 50,
        }, expect.objectContaining({ signal: expect.any(AbortSignal) }));

        await screen.pressByTestIdAsync('direct-session-candidate:omp-session-1');

        expect(linkEnsureSpy).toHaveBeenCalledWith({
            machineId: 'machine-1',
            agentId: 'ohMyPi',
            remoteSessionId: 'omp-session-1',
            titleHint: 'Existing oh-my-pi Session',
            directoryHint: '/tmp/omp-worktree',
            source: {
                kind: 'ohMyPiAgentDir',
                agentDir: '/tmp/omp-agent',
            },
        });
    });

    it('recovers when the selected machine disappears from the machine list', async () => {
        const { ExternalSessionsBrowseScreen } = await externalSessionsBrowseScreenModulePromise;
        const screen = await renderScreen(<ExternalSessionsBrowseScreen />);
        const tree = screen.tree;

        await flushHookEffects();

        const machineDropdown = findDropdownMenuByTriggerTestId(screen, 'direct-session-machine-picker-trigger');

        await act(async () => {
            await machineDropdown!.props?.onSelect?.('machine-2');
        });

        expect(candidatesListSpy).toHaveBeenLastCalledWith({
            machineId: 'machine-2',
            agentId: 'codex',
            source: { kind: 'codexHome', home: 'user' },
            limit: 50,
        }, expect.objectContaining({ signal: expect.any(AbortSignal) }));

        candidatesListSpy.mockClear();
        machinesState = [{ id: 'machine-1', active: true, metadata: { displayName: 'MacBook Pro', host: 'mbp.local' } }];

        await act(async () => {
            tree.update(<ExternalSessionsBrowseScreen key="rerendered" />);
        });
        await flushHookEffects();

        const rerenderedMachineDropdown = findDropdownMenuByTriggerTestId(screen, 'direct-session-machine-picker-trigger');

        expect(rerenderedMachineDropdown).toBeTruthy();
        expect(rerenderedMachineDropdown!.props?.selectedId).toBe('machine-1');
        expect(candidatesListSpy).toHaveBeenCalledWith({
            machineId: 'machine-1',
            agentId: 'codex',
            source: { kind: 'codexHome', home: 'user' },
            limit: 50,
        }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    });

    it('does not allow stale requests to overwrite newer candidate state after rapid filter changes', async () => {
        let slowResolve: ((value: any) => void) | null = null;
        const slowPromise = new Promise((resolve) => {
            slowResolve = resolve;
        });

        candidatesListSpy.mockResolvedValueOnce({
            ok: true,
            candidates: [
                {
                    remoteSessionId: 'initial-session-1',
                    title: 'Initial Session',
                    updatedAtMs: 1_700_000_000_000,
                    activity: 'running',
                    details: { path: '/tmp/initial', source: { kind: 'codexHome', home: 'user', homePath: '/tmp/custom-home' } },
                },
            ],
            nextCursor: null,
        });

        candidatesListSpy.mockImplementationOnce(async () => {
            await slowPromise;
            return {
                ok: true,
                candidates: [
                    {
                        remoteSessionId: 'stale-session-1',
                        title: 'Stale Session',
                        updatedAtMs: 1_700_000_000_000,
                        activity: 'idle',
                        details: { path: '/tmp/stale', source: { kind: 'codexHome', home: 'user', homePath: '/tmp/custom-home' } },
                    },
                ],
                nextCursor: null,
            };
        });
        const { ExternalSessionsBrowseScreen } = await externalSessionsBrowseScreenModulePromise;

        const screen = await renderScreen(<ExternalSessionsBrowseScreen />);
        const tree = screen.tree;

        await flushHookEffects();

        const machineDropdown = findDropdownMenuByTriggerTestId(screen, 'direct-session-machine-picker-trigger');

        // Switch to machine-2 (this starts a slow request)
        await act(async () => {
            await machineDropdown!.props?.onSelect?.('machine-2');
        });

        // Immediately switch back to machine-1 (this completes quickly)
        candidatesListSpy.mockResolvedValueOnce({
            ok: true,
            candidates: [
                {
                    remoteSessionId: 'fresh-session-1',
                    title: 'Fresh Session',
                    updatedAtMs: 1_700_000_000_000,
                    activity: 'running',
                    details: { path: '/tmp/fresh', source: { kind: 'codexHome', home: 'user', homePath: '/tmp/custom-home' } },
                },
            ],
            nextCursor: null,
        });

        await act(async () => {
            await machineDropdown!.props?.onSelect?.('machine-1');
        });

        await flushHookEffects();

        // Now resolve the slow request from machine-2
        slowResolve!({
            ok: true,
            candidates: [
                {
                    remoteSessionId: 'stale-session-1',
                    title: 'Stale Session',
                    updatedAtMs: 1_700_000_000_000,
                    activity: 'idle',
                    details: { path: '/tmp/stale' },
                },
            ],
            nextCursor: null,
        });
        await flushHookEffects();

        // The displayed candidates should be from machine-1, not the stale machine-2 request
        const candidateItem = screen.findByTestId('direct-session-candidate:fresh-session-1');
        expect(candidateItem).toBeTruthy();
        expect(candidateItem?.props.title).toBe('Fresh Session');
        expect(candidateItem?.props.testID).toBe('direct-session-candidate:fresh-session-1');
    });

    it('can be used as a locked picker that returns a remote session id without linking', async () => {
        const { ExternalSessionsBrowseScreen } = await externalSessionsBrowseScreenModulePromise;

        const onPickRemoteSessionId = vi.fn();

        const screen = await renderScreen(
            <ExternalSessionsBrowseScreen
                interaction="pickRemoteSessionId"
                lockScope={{
                    machineId: 'machine-2',
                    serverId: 'server-1',
                    providerId: 'codex',
                    source: { kind: 'codexHome', home: 'user' },
                }}
                onPickRemoteSessionId={onPickRemoteSessionId}
            />,
        );

        await flushHookEffects();

        expect(candidatesListSpy).toHaveBeenCalledWith({
            machineId: 'machine-2',
            agentId: 'codex',
            source: { kind: 'codexHome', home: 'user' },
            limit: 50,
        }, expect.objectContaining({
            serverId: 'server-1',
            signal: expect.any(AbortSignal),
        }));

        expect(findDropdownMenuByTriggerTestId(screen, 'direct-session-machine-picker-trigger')).toBeUndefined();
        expect(findDropdownMenuByTriggerTestId(screen, 'direct-session-provider-picker-trigger')).toBeUndefined();
        expect(findDropdownMenuByTriggerTestId(screen, 'direct-session-source-picker-trigger')).toBeUndefined();
        const lockedScopeSummary = screen.findByTestId('direct-session-locked-scope-summary');
        expect(lockedScopeSummary?.props.title).toBeUndefined();
        expect(lockedScopeSummary?.props.subtitle).toBeUndefined();
        expect(lockedScopeSummary?.findAllByProps({ children: 'Linux Box' }).length).toBeGreaterThan(0);
        expect(lockedScopeSummary?.findAllByProps({
            children: 'agentInput.agent.codex · externalSessions.browseSourceCodexUserHome',
        }).length).toBeGreaterThan(0);

        const candidateItem = screen.findByTestId('direct-session-candidate:codex-session-1');
        expect(candidateItem).toBeTruthy();
        if (!candidateItem) {
            throw new Error('expected candidate item');
        }

        await act(async () => {
            await candidateItem.props.onPress?.();
        });

        expect(onPickRemoteSessionId).toHaveBeenCalledWith('codex-session-1');
        expect(routerPushSpy).not.toHaveBeenCalled();
        expect(linkEnsureSpy).not.toHaveBeenCalled();
    });

    it('opens an annotated linked or imported candidate without relinking it', async () => {
        candidatesListSpy.mockResolvedValueOnce({
            ok: true,
            candidates: [{
                remoteSessionId: 'codex-imported-1',
                title: 'Imported Codex Session',
                updatedAtMs: 1_700_000_000_000,
                activity: 'idle',
                linkedSessionId: 'happy-existing-1',
                imported: true,
                materializedThrough: 1_699_999_999_000,
                details: { path: '/tmp/imported' },
            }],
            nextCursor: null,
        });
        const { ExternalSessionsBrowseScreen } = await externalSessionsBrowseScreenModulePromise;
        const screen = await renderScreen(<ExternalSessionsBrowseScreen />);
        await flushHookEffects();

        const candidateItem = screen.findByTestId('direct-session-candidate:codex-imported-1');
        expect(candidateItem).toBeTruthy();
        const pills = React.Children.toArray(candidateItem!.props.rightElement.props.children) as any[];
        expect(pills.some((pill) => pill?.props?.testID === 'external-session-candidate-linked:codex-imported-1')).toBe(true);
        expect(pills.some((pill) => pill?.props?.testID === 'external-session-candidate-imported:codex-imported-1')).toBe(true);
        await act(async () => {
            await candidateItem?.props.onPress?.();
        });

        expect(routerPushSpy).toHaveBeenCalledWith('/session/happy-existing-1');
        expect(linkEnsureSpy).not.toHaveBeenCalled();
    });

    it('forwards bounded candidate link data that disambiguates duplicate native project ids', async () => {
        candidatesListSpy.mockResolvedValueOnce({
            ok: true,
            candidates: [
                {
                    remoteSessionId: 'duplicate-native-id',
                    candidateKey: 'project-a-key',
                    title: 'Project A session',
                    updatedAtMs: 1_700_000_000_001,
                    linkData: { projectId: 'project-a' },
                    details: { path: '/tmp/project-a' },
                },
                {
                    remoteSessionId: 'duplicate-native-id',
                    candidateKey: 'project-b-key',
                    title: 'Project B session',
                    updatedAtMs: 1_700_000_000_000,
                    linkData: { projectId: 'project-b' },
                    details: { path: '/tmp/project-b' },
                },
            ],
            nextCursor: null,
        });
        const { ExternalSessionsBrowseScreen } = await externalSessionsBrowseScreenModulePromise;
        const screen = await renderScreen(
            <ExternalSessionsBrowseScreen
                lockScope={{
                    machineId: 'machine-1',
                    providerId: 'claude',
                    source: { kind: 'claudeConfig', configDir: '/tmp/claude' },
                }}
            />,
        );
        await flushHookEffects();
        await screen.pressByTestIdAsync('direct-session-candidate:project-b-key');

        expect(linkEnsureSpy).toHaveBeenCalledWith(expect.objectContaining({
            agentId: 'claude',
            remoteSessionId: 'duplicate-native-id',
            linkData: { projectId: 'project-b' },
        }));
    });

    it('renders locked dynamic Agents through the merged catalog projection', async () => {
        daemonProjectionState.current = {
            phase: 'ready',
            inputs: {
                mergedProviderProjectionById: {
                    'acme.dynamic': {
                        agentId: 'acme.dynamic',
                        qualifiedId: 'happier.agent.acme/dynamic',
                        identity: {
                            pluginId: 'happier.agent.acme',
                            localId: 'dynamic',
                        },
                        installedPackage: {
                            id: 'happier.agent.acme',
                            displayName: 'Acme Agents',
                            enabled: true,
                            source: { kind: 'path', locator: '/tmp/acme-agent' },
                            immutableGenerationId: 'acme-generation-7',
                        },
                        projectionGeneration: 7,
                        title: 'Acme Dynamic',
                        iconAgentId: 'codex',
                        channel: 'plugin',
                        isBuiltIn: false,
                    },
                },
                mergedBackendProjectionById: {},
                discoveredBackendIds: [],
            },
        };
        const { ExternalSessionsBrowseScreen } = await externalSessionsBrowseScreenModulePromise;
        const screen = await renderScreen(
            <ExternalSessionsBrowseScreen
                lockScope={{
                    machineId: 'machine-1',
                    providerId: 'acme.dynamic',
                    source: { kind: 'codexHome', home: 'user' },
                }}
            />,
        );
        await flushHookEffects();

        const candidateItem = screen.findByTestId('direct-session-candidate:codex-session-1');
        const subtitleChildren = React.Children.toArray(candidateItem!.props.subtitle.props.children) as any[];
        expect(String(subtitleChildren[2]?.props?.children)).toContain('Acme Dynamic');
        expect(candidateItem?.props.icon?.type).toBe(AgentCatalogIdentityIcon);
        expect(candidateItem?.props.icon?.props).toMatchObject({
            entry: {
                qualifiedId: 'happier.agent.acme/dynamic',
                identity: {
                    pluginId: 'happier.agent.acme',
                    localId: 'dynamic',
                },
                installedPackage: {
                    id: 'happier.agent.acme',
                    immutableGenerationId: 'acme-generation-7',
                },
                projectionGeneration: 7,
                isBuiltIn: false,
            },
            machineId: 'machine-1',
            current: true,
        });
        expect(candidateItem?.props.icon?.props.entry.iconAgentId).toBe('codex');
    });
});
