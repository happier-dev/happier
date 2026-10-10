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
import { createCapturingLegendListMock, createDeferred, createMachineFixture, flushHookEffects, renderHook, renderScreen } from '@/dev/testkit';
import { createPassThroughModule } from '@/dev/testkit/mocks/components';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';
import { createReactNativeWebMock } from '@/dev/testkit/mocks/reactNative';
import { createModalModuleMock } from '@/dev/testkit/mocks/modal';
import { createTextModuleMock } from '@/dev/testkit/mocks/text';
import { createUnistylesMock } from '@/dev/testkit/mocks/unistyles';
import { MachineMetadataSchema } from '@/sync/domains/state/storageTypes';
import {
    createMachineAdministrationTargetSelectionMock,
    installMachineAdministrationTargetSelectionBoundary,
} from '@/dev/testkit/mocks/machineAdministrationTargetSelection';
import type {
    MergedBackendProjectionEntry,
    MergedProviderProjectionEntry,
} from '@/agents/backendCatalog/mergedProjectionTypes';
import { AgentCatalogIdentityIcon } from '@/agents/presentation/AgentCatalogIdentityIcon';
import { SessionContextChips } from '@/components/sessions/context/SessionContextChips';
import { installNewSessionComponentsCommonModuleMocks } from '../../new/components/newSessionComponentsTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const candidateDeleteSpy = vi.hoisted(() => vi.fn(async () => ({ ok: true as const, deleted: true as const })));
const modalConfirmSpy = vi.hoisted(() => vi.fn(async () => true));
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
const memoryRpcSpy = vi.hoisted(() => vi.fn());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: (...args: unknown[]) => memoryRpcSpy(...args),
}));
const routerPushSpy = vi.hoisted(() => vi.fn());
// Navigation may load through the destination host before the shared component
// overrides are installed. Bind the real router boundary during module collection.
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ router: { push: routerPushSpy } }).module;
});
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
            profiles: [{ profileId: 'work', status: 'connected' as const }],
        },
    ],
}));
const settingsMock = vi.hoisted(() => ({
    connectedServicesProfileLabelByKey: {
        'openai-codex/work': 'Work Profile',
    },
}));
const daemonProjectionHookSpy = vi.hoisted(() => vi.fn());
const administrationTargetSelection = createMachineAdministrationTargetSelectionMock({
    serverId: 'server-a',
    serverIdentityId: 'server-identity-a',
    machines: [
        { machineId: 'machine-1', displayName: 'MacBook Pro' },
        {
            machineId: 'machine-2',
            displayName: 'Linux Box',
            serverId: 'server-b',
            serverIdentityId: 'server-identity-b',
            serverLabel: 'Other server',
        },
    ],
    selectedMachineId: 'machine-1',
});
installMachineAdministrationTargetSelectionBoundary(administrationTargetSelection);
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
        contentSearch?: boolean;
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
                ...(params.contentSearch === true ? { contentSearch: true } : {}),
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
                contentSearch: true,
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

async function publishMachinesState(): Promise<void> {
    const { getStorage } = await import('@/sync/domains/state/storageStore');
    const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
    const metadata = createMachineFixture().metadata;
    if (!metadata) throw new Error('The canonical unlocked machine fixture must supply metadata');
    const machines = machinesState.map((machine) => createMachineFixture({
        ...machine,
        metadata: MachineMetadataSchema.parse({ ...metadata, ...machine.metadata }),
    }));
    const activeServerId = getActiveServerSnapshot().serverId;
    // These are the two Home inventories represented by the Administration fixture.
    // Legacy locked callers without a server id still use the real active Home.
    getStorage().setState({
        machineListByServerId: {
            ...getStorage().getState().machineListByServerId,
            ...(activeServerId ? { [activeServerId]: machines } : {}),
            'server-a': machines.filter((machine) => machine.id === 'machine-1'),
            'server-b': machines.filter((machine) => machine.id === 'machine-2'),
        },
    });
}

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
            if (key === 'agentInput.agent.codex') return 'Codex';
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
            confirm: modalConfirmSpy,
        },
    }).module,
});
// The unified search owner consumes real store hooks; partial store mocks can
// deadlock their dependency cycle and cannot characterize the content boundary.
vi.unmock('@/sync/domains/state/storage');
vi.unmock('@/sync/store/hooks');
vi.mock('@/sync/sync', () => ({
    sync: {
        mutateAccountSettingsOnce: vi.fn(async ({ mutate }: Readonly<{
            mutate: (raw: Record<string, unknown>) => Readonly<{
                settings: Record<string, unknown>;
                value: unknown;
            }>;
        }>) => {
            const proposal = mutate(accountSettingsState.current);
            await mutateAccountSettingsSpy((raw) => proposal.settings ?? raw);
            return { status: 'applied', value: proposal.value };
        }),
    },
}));

vi.mock('@/agents/backendCatalog/useDaemonMergedProjectionInputs', () => ({
    useDaemonMergedProjectionInputs: (params: unknown) => {
        daemonProjectionHookSpy(params);
        return daemonProjectionState.current;
    },
}));

vi.mock('@/components/ui/lists/ItemList', () => createPassThroughModule(['ItemList']));
vi.mock('@/components/ui/lists/ItemGroup', () => createPassThroughModule(['ItemGroup']));
// Same pass-through host element as its siblings, plus the row accessory
// mounted as a child. The real `Item` renders `rightElement` into the tree, so
// a mock that only forwards it as an inert prop would hide every accessory
// control — the candidate delete overflow among them — from this screen.
vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement(
            'Item',
            props,
            props.rightElement as React.ReactNode,
            props.children,
        ),
}));
// The row overflow is asserted by type, so it needs a host element with that
// name; the real component only renders generic Views and would be invisible.
vi.mock('@/components/ui/lists/ItemRowActions', () => createPassThroughModule(['ItemRowActions']));
vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => createPassThroughModule(['DropdownMenu']));
vi.mock('@/components/ui/forms/Switch', () => createPassThroughModule(['Switch']));
vi.mock('@/components/ui/popover', () => ({
    ...createPassThroughModule(['PopoverScope']),
    // Filter chips anchor a popover; its content is exercised by the SelectionList filter owner's tests.
    Popover: () => null,
    MODAL_AWARE_FLOATING_POPOVER_PORTAL_OPTIONS: {},
}));
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

// The mock factory runs while this file's own static imports are still being
// evaluated (the virtualized list backend pulls Legend in transitively), which
// is before `capturedLegendList` is initialized. Read the captured
// implementation at render time instead, so the factory never touches the
// binding during module collection.
vi.mock('@legendapp/list/react-native', () => ({
    LegendList: React.forwardRef<unknown, Record<string, unknown>>((props, ref) =>
        React.createElement(capturedLegendList.LegendList, { ...props, ref })),
}));

vi.mock('@/sync/ops/machineExternalSessions', () => ({
    machineExternalSessionsCandidatesList: candidatesListSpy,
    machineExternalSessionCandidateDelete: candidateDeleteSpy,
    machineExternalSessionLinkEnsure: linkEnsureSpy,
}));

const externalSessionsBrowseScreenModulePromise = import('./ExternalSessionsBrowseScreen');

type DropdownTriggerPresentation = Readonly<{
    title: string;
    subtitle?: string;
}>;

type DropdownMenuTestNode = Readonly<{
    props?: {
        testID?: string;
        items?: ReadonlyArray<Readonly<{
            id: string;
            icon?: React.ReactElement;
            disabled?: boolean;
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

type BrowseFilterTestNode = Readonly<{
    id: string;
    selectedId?: string | null;
    options?: ReadonlyArray<Readonly<{ id: string; icon?: any }>>;
    onChange?: (id: string) => void;
    valueLabel?: string;
    testID?: string;
    ownerProps?: any;
}>;

/** The browse scope's SelectionList filter with this chip testID (machine, Agent, source). */
function findBrowseFilter(
    screen: { findAll: (predicate: (node: any) => boolean) => any[] },
    testID: string,
): BrowseFilterTestNode | undefined {
    const list = screen.findAll((node) => Array.isArray(node.props?.filters))[0];
    return (list?.props.filters as BrowseFilterTestNode[] | undefined)?.find((filter) => filter.testID === testID);
}

const MACHINE_FILTER_TEST_ID = 'external-sessions.browse.administration.target.chip';

function findDropdownMenuByTriggerTestId(
    screen: { findAllByType: (type: unknown) => DropdownMenuTestNode[] },
    testID: string,
): DropdownMenuTestNode | undefined {
    return screen.findAllByType('DropdownMenu').find((node) => (
        node.props?.testID === testID || node.props?.itemTrigger?.itemProps?.testID === testID
    ));
}

describe('ExternalSessionsBrowseScreen', () => {
    beforeEach(async () => {
        vi.useRealTimers();
        machinesState = [
            { id: 'machine-1', active: true, metadata: { displayName: 'MacBook Pro', host: 'mbp.local' } },
            { id: 'machine-2', active: false, metadata: { displayName: 'Linux Box', host: 'linux.local' } },
        ];
        await publishMachinesState();
        memoryRpcSpy.mockReset().mockResolvedValue({ v: 1, enabled: false });
        administrationTargetSelection.controller.reset();
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
        candidateDeleteSpy.mockClear();
        candidateDeleteSpy.mockResolvedValue({ ok: true, deleted: true });
        modalConfirmSpy.mockClear();
        modalConfirmSpy.mockResolvedValue(true);
        routerPushSpy.mockClear();
        modalAlertSpy.mockClear();
        mutateAccountSettingsSpy.mockClear();
        accountSettingsState.current = {};
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        const { settingsDefaults } = await import('@/sync/domains/settings/settings');
        getStorage().setState(state => ({ profile: { ...state.profile, ...profileMock },
            settingsVersion: 1,
            settings: { ...settingsDefaults, ...settingsMock,
                backendEnabledByTargetKey: {}, experiments: true, featureToggles: { 'memory.search': true } },
        }));
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

        // Auto-link is a policy, so it lives in the ⋯ menu as a checked item rather than a switch
        // pushing the results down.
        const menu = findDropdownMenuByTriggerTestId(screen, 'external-sessions-browse-menu') as any;
        const autoLink = menu?.props?.items?.find((item: { id: string }) => item.id === 'auto-link');
        expect(autoLink?.title).toBe('externalSessions.browseAutoLinkTitle');
        expect(autoLink?.checked).toBe(false);

        await act(async () => {
            await menu.props.onSelect('auto-link');
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

        const menu = findDropdownMenuByTriggerTestId(screen, 'external-sessions-browse-menu') as any;
        expect(menu?.props?.items?.some((item: { id: string }) => item.id === 'auto-link')).toBe(false);
        expect(mutateAccountSettingsSpy).not.toHaveBeenCalled();
        expect(linkEnsureSpy).not.toHaveBeenCalled();
    });

    it('does not grant foreground Account consent to a foreign locked credential scope', async () => {
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const { upsertAndActivateServer, upsertServerProfileOnly } = await import('@/sync/domains/server/serverRuntime');
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        const { getActiveServerAccountScope } = await import('@/sync/domains/scope/activeServerAccountScope');
        const connectionManager = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
        const foreground = await upsertAndActivateServer({ serverUrl: 'https://browse-consent-foreground.test' });
        const foreign = await upsertServerProfileOnly({ serverUrl: 'https://browse-consent-foreign.test' });
        const foregroundScope = { serverId: foreground.id, accountId: 'foreground-account' };
        const previous = getStorage().getState();
        // Secure storage and applied connection identity are the genuine boundaries;
        // credential lifetime, currentness, and settings scope readers stay real.
        const credentialsSpy = vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockImplementation(async (_url, options) => (
            options?.serverId === foreign.id
                ? { token: `header.${Buffer.from(JSON.stringify({ sub: 'foreign-account' })).toString('base64')}.signature` }
                : null
        ));
        const appliedSnapshotSpy = vi.spyOn(connectionManager, 'getAppliedActiveServerSnapshot').mockReturnValue({
            serverId: foreground.id, serverUrl: foreground.serverUrl, generation: 0,
        });
        const appliedAvailableSpy = vi.spyOn(connectionManager, 'isAppliedActiveServerRuntimeAvailable').mockReturnValue(true);
        try {
            const { useServerCredentialAccountScopes } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
            const bindings = await renderHook(() => useServerCredentialAccountScopes([foreign.id]));
            await vi.waitFor(() => expect(bindings.getCurrent().get(foreign.id)?.accountId).toBe('foreign-account'));
            const accountLifetime = bindings.getCurrent().get(foreign.id)!;
            getStorage().setState({ profileScope: foregroundScope, settingsScope: foregroundScope });
            expect(getActiveServerAccountScope()).toEqual(foregroundScope);
            expect(accountLifetime.isCurrent()).toBe(true);
            expect(accountLifetime.scope).not.toEqual(foregroundScope);

            candidatesListSpy.mockResolvedValue({
                ok: true,
                candidates: [{ remoteSessionId: 'foreign-consent-row', title: 'Foreign session', updatedAtMs: 1 }],
                nextCursor: null,
                autoLinkPolicyScopeV1: {
                    qualifiedIdentity: {
                        v: 1,
                        agent: { pluginId: 'happier.external-sessions-screen-fixture', localId: 'codex' },
                        source: { kind: 'codexHome', contractVersion: 1 },
                    },
                    sourcePolicyId: `es-source-policy:v1:${'a'.repeat(64)}`,
                },
            });
            const { ExternalSessionsBrowseScreen } = await externalSessionsBrowseScreenModulePromise;
            const screen = await renderScreen(<ExternalSessionsBrowseScreen
                accountLifetime={accountLifetime}
                lockScope={{ serverId: foreign.id, machineId: 'machine-1', providerId: 'codex', source: { kind: 'codexHome', home: 'user' } }}
            />);
            await flushHookEffects();
            expect(screen.findByTestId('direct-session-candidate:foreign-consent-row')).not.toBeNull();
            const menu = findDropdownMenuByTriggerTestId(screen, 'external-sessions-browse-menu');
            const consent = menu?.props?.items?.find((item) => item.id === 'auto-link');
            // Even a direct dispatch cannot grant a foreign policy in the foreground Account.
            await act(async () => { await menu?.props?.onSelect?.('auto-link'); });
            expect(mutateAccountSettingsSpy).not.toHaveBeenCalled();
            expect(consent === undefined || consent.disabled === true).toBe(true);
            expect(accountSettingsState.current).toEqual({});
            expect(accountLifetime.isCurrent()).toBe(true);
        } finally {
            await act(async () => {
                getStorage().setState({ profileScope: previous.profileScope, settingsScope: previous.settingsScope });
            });
            credentialsSpy.mockRestore();
            appliedSnapshotSpy.mockRestore();
            appliedAvailableSpy.mockRestore();
        }
    });


    describe('Agent-owned candidate deletion', () => {
        const deletableCandidates = [{
            remoteSessionId: ' provider\nsession-1 ',
            title: 'Existing Codex Session',
            updatedAtMs: 1_700_000_000_000,
        }] as ExternalSessionCandidateV1[];

        function findCandidateActions(screen: Readonly<{
            findAllByType: (type: string) => ReadonlyArray<Readonly<{ props: Record<string, unknown> }>>;
        }>) {
            return screen.findAllByType('ItemRowActions').find(
                (node) => Array.isArray(node.props.actions),
            );
        }

        it('offers no deletion when the listing did not advertise the capability', async () => {
            candidatesListSpy.mockResolvedValue({
                ok: true,
                candidates: deletableCandidates,
                nextCursor: null,
            });
            const { ExternalSessionsBrowseScreen } = await externalSessionsBrowseScreenModulePromise;
            const screen = await renderScreen(<ExternalSessionsBrowseScreen />);
            await flushHookEffects();

            expect(screen.findAllByType('ItemRowActions')).toHaveLength(0);
            expect(candidateDeleteSpy).not.toHaveBeenCalled();
        });

        it('confirms, deletes the exact opaque id, and removes the row only after the Agent commits', async () => {
            candidatesListSpy.mockResolvedValue({
                ok: true,
                candidates: deletableCandidates,
                nextCursor: null,
                capabilities: { deleteCandidate: true },
            });
            const { ExternalSessionsBrowseScreen } = await externalSessionsBrowseScreenModulePromise;
            const screen = await renderScreen(<ExternalSessionsBrowseScreen />);
            await flushHookEffects();

            const actions = findCandidateActions(screen)?.props.actions as ReadonlyArray<Readonly<{
                id: string;
                destructive?: boolean;
                onPress: () => void;
            }>>;
            const deleteAction = actions.find((action) => action.id === 'delete_agent_session');
            expect(deleteAction?.destructive).toBe(true);
            expect(screen.findByTestId('direct-session-candidate: provider\nsession-1 ')).not.toBeNull();

            await act(async () => {
                deleteAction?.onPress();
                await flushHookEffects();
            });

            expect(modalConfirmSpy).toHaveBeenCalledTimes(1);
            // The destructive call is server-scoped: it must reach the same
            // server that served the listing, not an ambient default.
            expect(candidateDeleteSpy).toHaveBeenCalledWith(
                {
                    machineId: 'machine-1',
                    agentId: 'codex',
                    source: { kind: 'codexHome', home: 'user' },
                    remoteSessionId: ' provider\nsession-1 ',
                },
                { serverId: 'server-a' },
            );
            expect(screen.findByTestId('direct-session-candidate: provider\nsession-1 ')).toBeNull();
        });

        it('deletes nothing when the user cancels the confirmation', async () => {
            candidatesListSpy.mockResolvedValue({
                ok: true,
                candidates: deletableCandidates,
                nextCursor: null,
                capabilities: { deleteCandidate: true },
            });
            modalConfirmSpy.mockResolvedValue(false);
            const { ExternalSessionsBrowseScreen } = await externalSessionsBrowseScreenModulePromise;
            const screen = await renderScreen(<ExternalSessionsBrowseScreen />);
            await flushHookEffects();

            const actions = findCandidateActions(screen)?.props.actions as ReadonlyArray<Readonly<{
                id: string;
                onPress: () => void;
            }>>;
            await act(async () => {
                actions.find((action) => action.id === 'delete_agent_session')?.onPress();
                await flushHookEffects();
            });

            expect(modalConfirmSpy).toHaveBeenCalledTimes(1);
            expect(candidateDeleteSpy).not.toHaveBeenCalled();
            expect(screen.findByTestId('direct-session-candidate: provider\nsession-1 ')).not.toBeNull();
        });

        it('keeps the row and reports the failure when the Agent refuses deletion', async () => {
            candidatesListSpy.mockResolvedValue({
                ok: true,
                candidates: deletableCandidates,
                nextCursor: null,
                capabilities: { deleteCandidate: true },
            });
            candidateDeleteSpy.mockResolvedValueOnce({
                ok: false,
                errorCode: 'agent_unavailable',
                error: 'provider refused deletion',
            } as never);
            const { ExternalSessionsBrowseScreen } = await externalSessionsBrowseScreenModulePromise;
            const screen = await renderScreen(<ExternalSessionsBrowseScreen />);
            await flushHookEffects();

            const actions = findCandidateActions(screen)?.props.actions as ReadonlyArray<Readonly<{
                id: string;
                onPress: () => void;
            }>>;
            await act(async () => {
                actions.find((action) => action.id === 'delete_agent_session')?.onPress();
                await flushHookEffects();
            });

            expect(modalAlertSpy).toHaveBeenCalledWith(
                'common.error',
                'externalSessions.browseAgentUnavailable',
            );
            expect(screen.findByTestId('direct-session-candidate: provider\nsession-1 ')).not.toBeNull();
            const retryable = findCandidateActions(screen)?.props.actions as ReadonlyArray<Readonly<{
                id: string;
                disabled?: boolean;
            }>>;
            expect(retryable.find((action) => action.id === 'delete_agent_session')?.disabled).toBe(false);
        });

        /**
         * One deletion is in flight; the whole destructive affordance is
         * suspended until it settles, but only the row actually being deleted
         * may show progress. A second row that still offered its delete control
         * would let the user start an overlapping Agent-side deletion the
         * screen cannot represent.
         */
        it('suspends every candidate delete while one is pending and shows progress only on its own row', async () => {
            candidatesListSpy.mockResolvedValue({
                ok: true,
                candidates: [
                    ...deletableCandidates,
                    {
                        remoteSessionId: ' provider\nsession-2 ',
                        title: 'Second Codex Session',
                        updatedAtMs: 1_700_000_001_000,
                    },
                ] as ExternalSessionCandidateV1[],
                nextCursor: null,
                capabilities: { deleteCandidate: true },
            });
            const pendingDeletion = createDeferred<{ ok: true; deleted: true }>();
            candidateDeleteSpy.mockImplementationOnce(() => pendingDeletion.promise);
            const { ExternalSessionsBrowseScreen } = await externalSessionsBrowseScreenModulePromise;
            const screen = await renderScreen(<ExternalSessionsBrowseScreen />);
            await flushHookEffects();

            const readDeleteActionDisabledByRow = () => new Map(
                screen.findAllByType('ItemRowActions')
                    .map((node) => [
                        node.props.overflowTriggerTestID as string,
                        (node.props.actions as ReadonlyArray<Readonly<{
                            id: string;
                            disabled?: boolean;
                            onPress: () => void;
                        }>>).find((action) => action.id === 'delete_agent_session'),
                    ] as const),
            );
            const readRowLoadingByTestId = () => new Map(
                screen.findAllByType('Item')
                    .filter((node) => typeof node.props.testID === 'string'
                        && (node.props.testID as string).startsWith('direct-session-candidate:'))
                    .map((node) => [node.props.testID as string, node.props.loading === true] as const),
            );

            const idle = readDeleteActionDisabledByRow();
            expect(idle.size).toBe(2);
            expect([...idle.values()].map((action) => action?.disabled)).toEqual([false, false]);

            await act(async () => {
                idle.get('external-session-candidate-actions: provider\nsession-1 ')?.onPress();
                await flushHookEffects();
            });

            const pending = readDeleteActionDisabledByRow();
            expect([...pending.values()].map((action) => action?.disabled)).toEqual([true, true]);
            expect(readRowLoadingByTestId()).toEqual(new Map([
                ['direct-session-candidate: provider\nsession-1 ', true],
                ['direct-session-candidate: provider\nsession-2 ', false],
            ]));

            await act(async () => {
                pendingDeletion.resolve({ ok: true, deleted: true });
                await pendingDeletion.promise;
                await flushHookEffects();
            });

            // The surviving sibling re-enables the moment the deletion settles.
            const settled = readDeleteActionDisabledByRow();
            expect([...settled.values()].map((action) => action?.disabled)).toEqual([false]);
            expect(readRowLoadingByTestId()).toEqual(new Map([
                ['direct-session-candidate: provider\nsession-2 ', false],
            ]));
        });

        /**
         * Admission has to be decided synchronously. Two activations dispatched
         * from the same commit both read the pre-press pending state, so a guard
         * that only consults rendered state lets each open its own confirmation
         * and send its own irreversible Agent-side deletion.
         */
        it('admits one destructive request when two presses land before the pending state commits', async () => {
            candidatesListSpy.mockResolvedValue({
                ok: true,
                candidates: deletableCandidates,
                nextCursor: null,
                capabilities: { deleteCandidate: true },
            });
            const pendingConfirmation = createDeferred<boolean>();
            modalConfirmSpy.mockImplementationOnce(() => pendingConfirmation.promise);
            const { ExternalSessionsBrowseScreen } = await externalSessionsBrowseScreenModulePromise;
            const screen = await renderScreen(<ExternalSessionsBrowseScreen />);
            await flushHookEffects();

            const deleteAction = (findCandidateActions(screen)?.props.actions as ReadonlyArray<Readonly<{
                id: string;
                onPress: () => void;
            }>>).find((action) => action.id === 'delete_agent_session');

            await act(async () => {
                deleteAction?.onPress();
                deleteAction?.onPress();
                await flushHookEffects();
            });

            expect(modalConfirmSpy).toHaveBeenCalledTimes(1);
            expect(candidateDeleteSpy).not.toHaveBeenCalled();

            await act(async () => {
                pendingConfirmation.resolve(true);
                await pendingConfirmation.promise;
                await flushHookEffects();
            });

            expect(modalConfirmSpy).toHaveBeenCalledTimes(1);
            expect(candidateDeleteSpy).toHaveBeenCalledTimes(1);
            expect(screen.findByTestId('direct-session-candidate: provider\nsession-1 ')).toBeNull();
        });

        /**
         * A destructive request belongs to the browse scope that produced it.
         * The Agent's opaque id is only unique inside one machine, Agent and
         * source, so neither a confirmation answered after the scope moved nor
         * a success that lands after it may be replayed against a same-keyed
         * row in the listing now on screen, and neither may leave that listing
         * holding the departed scope's pending state.
         */
        it('fences a candidate deletion across a scope switch and spares the colliding row', async () => {
            machinesState = [
                { id: 'machine-1', active: true, metadata: { displayName: 'MacBook Pro', host: 'mbp.local' } },
                { id: 'machine-2', active: true, metadata: { displayName: 'Linux Box', host: 'linux.local' } },
            ];
            await publishMachinesState();
            // Both machines serve a row under the same Agent-owned key: the id is
            // opaque and unique only inside the scope that produced it.
            const collidingKey = 'shared-agent-session';
            candidatesListSpy.mockResolvedValue({
                ok: true,
                candidates: [{
                    remoteSessionId: collidingKey,
                    title: 'Colliding Agent Session',
                    updatedAtMs: 1_700_000_000_000,
                }] as ExternalSessionCandidateV1[],
                nextCursor: null,
                capabilities: { deleteCandidate: true },
            });
            const readDeleteAction = () => (findCandidateActions(screen)?.props.actions as ReadonlyArray<Readonly<{
                id: string;
                disabled?: boolean;
                onPress: () => void;
            }>>).find((action) => action.id === 'delete_agent_session');
            const { ExternalSessionsBrowseScreen } = await externalSessionsBrowseScreenModulePromise;
            const screen = await renderScreen(<ExternalSessionsBrowseScreen />);
            await flushHookEffects();

            // The scope moves while the confirmation is still on screen.
            const pendingConfirmation = createDeferred<boolean>();
            modalConfirmSpy.mockImplementationOnce(() => pendingConfirmation.promise);
            await act(async () => {
                readDeleteAction()?.onPress();
                await Promise.resolve();
            });
            await act(async () => {
                administrationTargetSelection.controller.select('machine-2', 'server-identity-b');
            });
            await flushHookEffects();
            await act(async () => {
                pendingConfirmation.resolve(true);
                await pendingConfirmation.promise;
                await flushHookEffects();
            });

            expect(candidateDeleteSpy).not.toHaveBeenCalled();
            expect(modalAlertSpy).not.toHaveBeenCalled();
            expect(screen.findByTestId(`direct-session-candidate:${collidingKey}`)).not.toBeNull();
            expect(readDeleteAction()?.disabled).toBe(false);

            // The confirmation is answered inside the scope, but the scope moves
            // back while the Agent call is still in flight.
            const pendingDeletion = createDeferred<{ ok: true; deleted: true }>();
            candidateDeleteSpy.mockImplementationOnce(() => pendingDeletion.promise);
            await act(async () => {
                readDeleteAction()?.onPress();
                await flushHookEffects();
            });
            expect(candidateDeleteSpy).toHaveBeenCalledTimes(1);
            expect(candidateDeleteSpy).toHaveBeenLastCalledWith(
                expect.objectContaining({ machineId: 'machine-2' }),
                { serverId: 'server-b' },
            );

            await act(async () => {
                administrationTargetSelection.controller.select('machine-1', 'server-identity-a');
            });
            await flushHookEffects();
            await act(async () => {
                pendingDeletion.resolve({ ok: true, deleted: true });
                await pendingDeletion.promise;
                await flushHookEffects();
            });

            expect(modalAlertSpy).not.toHaveBeenCalled();
            expect(screen.findByTestId(`direct-session-candidate:${collidingKey}`)).not.toBeNull();
            // Pending ownership left with the departed scope, so the listing on
            // screen is neither stuck in progress nor refused a fresh deletion.
            expect(readDeleteAction()?.disabled).toBe(false);
            await act(async () => {
                readDeleteAction()?.onPress();
                await flushHookEffects();
            });
            expect(candidateDeleteSpy).toHaveBeenCalledTimes(2);
            expect(candidateDeleteSpy).toHaveBeenLastCalledWith(
                expect.objectContaining({ machineId: 'machine-1' }),
                { serverId: 'server-a' },
            );
            expect(screen.findByTestId(`direct-session-candidate:${collidingKey}`)).toBeNull();
        });
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('loads candidates for the persisted Administration target and default provider', async () => {
        const { ExternalSessionsBrowseScreen } = await externalSessionsBrowseScreenModulePromise;
        const screen = await renderScreen(<ExternalSessionsBrowseScreen />);

        await flushHookEffects();

        expect(candidatesListSpy).toHaveBeenCalledWith({
            machineId: 'machine-1',
            agentId: 'codex',
            source: { kind: 'codexHome', home: 'user' },
            limit: 50,
        }, expect.objectContaining({ signal: expect.any(AbortSignal) }));

        const providerFilter = findBrowseFilter(screen, 'direct-session-provider-picker');
        const sourceFilter = findBrowseFilter(screen, 'direct-session-source-picker');
        const machineFilter = findBrowseFilter(screen, MACHINE_FILTER_TEST_ID);
        const popoverScopes = screen.findAllByType('PopoverScope' as any);

        expect(machineFilter?.ownerProps.selection.selectedTarget).toEqual({
            serverIdentityId: 'server-identity-a',
            machineId: 'machine-1',
        });
        // The scope is SelectionList filters beside the search band — the machine (through its
        // canonical owner), the Agent and the source — and the popover scope still bounds the screen.
        expect(popoverScopes).toHaveLength(1);
        expect(providerFilter).toBeTruthy();
        expect(sourceFilter).toBeTruthy();
        expect(providerFilter?.selectedId).toBe('codex');
        expect(providerFilter?.options?.length).toBeGreaterThan(0);
        expect(providerFilter?.options?.every((option) => option.icon?.type === AgentCatalogIdentityIcon)).toBe(true);
        expect(screen.findAllByType('ItemGroup' as any)).toHaveLength(0);

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
        expect(candidateItem?.props.icon?.type?.name).toBe('AgentCatalogIdentityIcon');
        expect(candidateItem?.props.icon?.props.entry.agentId).toBe('codex');
        expect(String(candidateSubtitleLines[2]?.props?.children)).toContain('MacBook Pro');
        expect(String(candidateSubtitleLines[2]?.props?.children)).toContain('Codex');
        expect(candidateItem?.props.rightElement).toBeTruthy();
        const badgeChildren = React.Children.toArray(candidateItem!.props.rightElement.props.children);
        const statusPill = badgeChildren.find((child: any) => child?.type?.name === 'StatusPill');
        expect((statusPill as any)?.props?.label).toBe('status.workingExternally');
        expect((statusPill as any)?.props?.isPulsing).toBe(true);
    });

    it('hides internal threads by default and reveals them, labelled with their parent, from the Sub-agent threads filter', async () => {
        const { ExternalSessionsBrowseScreen } = await externalSessionsBrowseScreenModulePromise;
        const screen = await renderScreen(<ExternalSessionsBrowseScreen />);
        await flushHookEffects();

        const threadsFilter = findBrowseFilter(screen, 'external-sessions.browse.threads');
        expect(threadsFilter?.selectedId).toBe('hidden');
        expect(candidatesListSpy).toHaveBeenLastCalledWith(
            expect.not.objectContaining({ includeThreads: expect.anything() }),
            expect.anything(),
        );

        candidatesListSpy.mockResolvedValueOnce({
            ok: true,
            candidates: [
                {
                    remoteSessionId: 'codex-session-1',
                    title: 'Existing Codex Session',
                    updatedAtMs: 1_700_000_000_000,
                    details: { path: '/tmp/worktree' },
                },
                {
                    remoteSessionId: 'codex-reviewer-1',
                    title: 'Approve the migration',
                    updatedAtMs: 1_699_999_000_000,
                    thread: { kind: 'reviewer', parentRemoteSessionId: 'codex-session-1' },
                    details: { path: '/tmp/worktree' },
                },
            ] as ExternalSessionCandidateV1[],
            nextCursor: null,
        });
        await act(async () => {
            threadsFilter!.onChange?.('shown');
        });
        await flushHookEffects();

        expect(candidatesListSpy).toHaveBeenLastCalledWith(
            expect.objectContaining({ includeThreads: true }),
            expect.anything(),
        );
        expect(findBrowseFilter(screen, 'external-sessions.browse.threads')?.selectedId).toBe('shown');
        const reviewerSubtitle = screen.findByTestId('direct-session-candidate:codex-reviewer-1')?.props.subtitle;
        const reviewerSubtitleText = (React.Children.toArray((reviewerSubtitle as any).props.children) as any[])
            .map((line) => String(line?.props?.children ?? ''))
            .join('');
        // The parent is resolved from the listing itself when the Agent did not name it.
        expect(reviewerSubtitleText).toMatch(/Reviewer of Existing Codex Session|browseThreadReviewerOf/);
    });

    it('uses the selected machine home directory for candidate project presentation', async () => {
        administrationTargetSelection.controller.setMachines([{
            machineId: 'machine-1',
            displayName: 'Windows PC',
            homeDir: 'C:\\Users\\alice',
        }]);
        machinesState = [{
            id: 'machine-1',
            active: true,
            metadata: {
                displayName: 'Windows PC',
                host: 'windows.local',
                homeDir: 'C:\\Users\\alice',
            },
        }];
        await publishMachinesState();
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

        expect(screen.getTextContent()).toContain('~/projects/happier');
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

    it('requires an explicit Administration target when several eligible machines have no saved selection', async () => {
        administrationTargetSelection.controller.select(null);
        const { ExternalSessionsBrowseScreen } = await externalSessionsBrowseScreenModulePromise;

        const screen = await renderScreen(<ExternalSessionsBrowseScreen />);

        await flushHookEffects();

        expect(findBrowseFilter(screen, MACHINE_FILTER_TEST_ID)).toBeTruthy();
        expect(candidatesListSpy).not.toHaveBeenCalled();
        expect(linkEnsureSpy).not.toHaveBeenCalled();
        expect(mutateAccountSettingsSpy).not.toHaveBeenCalled();
    });

    it('uses the exact Administration machine and server target for candidate reads', async () => {
        administrationTargetSelection.controller.select('machine-2', 'server-identity-b');
        const { ExternalSessionsBrowseScreen } = await externalSessionsBrowseScreenModulePromise;

        const screen = await renderScreen(<ExternalSessionsBrowseScreen />);
        await flushHookEffects();

        expect(findBrowseFilter(screen, MACHINE_FILTER_TEST_ID)).toBeTruthy();
        expect(daemonProjectionHookSpy).toHaveBeenLastCalledWith(expect.objectContaining({
            machineId: 'machine-2',
            serverId: 'server-b',
        }));
        expect(candidatesListSpy).toHaveBeenCalledWith({
            machineId: 'machine-2',
            agentId: 'codex',
            source: { kind: 'codexHome', home: 'user' },
            limit: 50,
        }, expect.objectContaining({
            serverId: 'server-b',
            signal: expect.any(AbortSignal),
        }));
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
        // The band names what it searches: the selected Agent's sessions ("Search Codex sessions…").
        expect(searchInput!.props.placeholder).toBe('externalSessions.browseSearchAgentPlaceholder');

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
        await act(async () => {
            machinesState = [
                { id: 'machine-1', active: false, metadata: { displayName: 'MacBook Pro', host: 'mbp.local' } },
                { id: 'machine-2', active: false, metadata: { displayName: 'Linux Box', host: 'linux.local' } },
            ];
            await publishMachinesState();
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
        expect(routerPushSpy).toHaveBeenCalledWith('/session/happy-session-linked?serverId=server-a');

        // And the footer must not claim the stale listing is complete.
        const paginated = screen
            .findAllByProps({ testID: 'direct-session-candidates' })
            .find((node) => node.props?.pagination !== undefined);
        expect(paginated?.props.pagination.error).toBe('externalSessions.browseMachineOfflineBody');
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
        }), { serverId: 'server-a' });
        expect(routerPushSpy).toHaveBeenCalledWith('/session/happy-session-1?serverId=server-a');
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
        }), { serverId: 'server-a' });
        expect(routerPushSpy).toHaveBeenCalledWith('/session/happy-session-1?serverId=server-a');
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
        }), { serverId: 'server-a' });
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

        expect(findBrowseFilter(screen, 'direct-session-provider-picker')?.selectedId).toBe('codex');
        expect(findBrowseFilter(screen, 'direct-session-source-picker')?.selectedId).toBe('codex:user');
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

        expect(routerPushSpy).toHaveBeenCalledWith('/session/happy-session-1?serverId=server-a');
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

        const candidate = screen.findByTestId('direct-session-candidate:codex-session-1');
        let pendingPress: Promise<void> | undefined;
        await act(async () => {
            pendingPress = candidate?.props.onPress?.();
            await Promise.resolve();
        });
        expect(linkEnsureSpy).toHaveBeenCalledTimes(1);

        await act(async () => {
            administrationTargetSelection.controller.select('machine-2', 'server-identity-b');
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

        const staleLinkedPress = screen.findByTestId('direct-session-candidate:codex-linked-1')?.props.onPress;
        const staleUnlinkedPress = screen.findByTestId('direct-session-candidate:codex-session-1')?.props.onPress;
        expect(typeof staleLinkedPress).toBe('function');
        expect(typeof staleUnlinkedPress).toBe('function');

        await act(async () => {
            administrationTargetSelection.controller.select('machine-2', 'server-identity-b');
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

        const stalePress = screen.findByTestId('direct-session-candidate:codex-session-1')?.props.onPress;

        await act(async () => {
            administrationTargetSelection.controller.select('machine-2', 'server-identity-b');
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
        expect(routerPushSpy).toHaveBeenCalledWith('/session/happy-session-1?serverId=server-a');
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

        const sourceFilter = findBrowseFilter(screen, 'direct-session-source-picker');
        expect(sourceFilter).toBeTruthy();

        await act(async () => {
            sourceFilter!.onChange?.('codex:connected-service:openai-codex:work');
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
        }), { serverId: 'server-a' });
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

        const providerFilter = findBrowseFilter(screen, 'direct-session-provider-picker');
        expect(providerFilter).toBeTruthy();

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
            providerFilter!.onChange?.('ohMyPi');
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
        }, { serverId: 'server-a' });
    });

    it('keeps a missing persisted target selected and does not fall back to another machine', async () => {
        const { ExternalSessionsBrowseScreen } = await externalSessionsBrowseScreenModulePromise;
        const screen = await renderScreen(<ExternalSessionsBrowseScreen />);

        await flushHookEffects();

        await act(async () => {
            administrationTargetSelection.controller.select('machine-2', 'server-identity-b');
        });
        await flushHookEffects();

        expect(candidatesListSpy).toHaveBeenLastCalledWith({
            machineId: 'machine-2',
            agentId: 'codex',
            source: { kind: 'codexHome', home: 'user' },
            limit: 50,
        }, expect.objectContaining({
            serverId: 'server-b',
            signal: expect.any(AbortSignal),
        }));

        candidatesListSpy.mockClear();
        await act(async () => {
            administrationTargetSelection.controller.setMachines([
                { machineId: 'machine-1', displayName: 'MacBook Pro' },
            ]);
        });
        await flushHookEffects();

        const targetSelection = findBrowseFilter(screen, MACHINE_FILTER_TEST_ID)?.ownerProps.selection;
        expect(targetSelection.selectedTarget).toEqual({
            serverIdentityId: 'server-identity-b',
            machineId: 'machine-2',
        });
        expect(targetSelection.state.kind).toBe('missing');
        // The missing machine speaks first; it never reads as "no agent can browse".
        expect(screen.findByTestId('direct-session-candidates:machine-gone')).not.toBeNull();
        expect(screen.findByTestId('direct-session-candidates:no-agents')).toBeNull();
        const text = screen.getTextContent();
        expect(text).not.toContain('machine-2');
        expect(text).not.toContain('server-identity-b');
        expect(candidatesListSpy).not.toHaveBeenCalled();
        expect(linkEnsureSpy).not.toHaveBeenCalled();
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

        // Switch to machine-2 (this starts a slow request)
        await act(async () => {
            administrationTargetSelection.controller.select('machine-2', 'server-identity-b');
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
            administrationTargetSelection.controller.select('machine-1', 'server-identity-a');
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
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        const state = getStorage().getState();
        const machineInventory = state.machineListByServerId['server-b'];
        if (!machineInventory) throw new Error('Expected the canonical machine-2 inventory fixture');
        getStorage().setState({
            machineListByServerId: { ...state.machineListByServerId, 'server-1': machineInventory },
        });

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

        // A locked scope shows its machine and Agent as fixed filter chips: nothing to change.
        expect(findBrowseFilter(screen, 'direct-session-provider-picker')).toBeUndefined();
        expect(findBrowseFilter(screen, 'direct-session-source-picker')).toBeUndefined();
        expect(findBrowseFilter(screen, MACHINE_FILTER_TEST_ID)).toBeUndefined();
        const lockedMachine = findBrowseFilter(screen, 'external-sessions.browse.locked.machine');
        const lockedAgent = findBrowseFilter(screen, 'external-sessions.browse.locked.agent');
        expect(lockedMachine?.valueLabel).toBe('Linux Box');
        expect(lockedAgent?.valueLabel).toBe('Codex · My Codex home');
        expect(lockedMachine?.options).toBeUndefined();
        expect(lockedAgent?.onChange).toBeUndefined();

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
        administrationTargetSelection.controller.select('machine-2', 'server-identity-b');
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

        expect(routerPushSpy).toHaveBeenCalledWith('/session/happy-existing-1?serverId=server-b');
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
