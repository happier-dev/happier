import React from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { installLocalStorageMock, installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import type { AccountDirectoryAuthMethodDiscovery } from '@/auth/accountDirectory/accountDirectoryAuthClient';
import type { AccountServiceEntryOptions } from '@/components/account/auth/useAccountServiceEntryOptions';
import { installConnectionStatusControlCommonModuleMocks } from './connectionStatusControlTestHelpers';


(
    globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
).IS_REACT_ACT_ENVIRONMENT = true;

type PopoverCaptureProps = {
    open?: boolean;
    autoFocusOnOpen?: boolean;
    focusReturnRef?: React.RefObject<unknown>;
    portal?: {
        web?: boolean;
        native?: boolean;
        matchAnchorWidth?: boolean;
    };
    maxWidthCap?: number;
    children?: ((params: { maxHeight: number }) => React.ReactNode) | React.ReactNode;
};

type ActionLike = {
    id?: unknown;
    label?: unknown;
    subtitle?: unknown;
    right?: unknown;
    accessibilityLabel?: unknown;
    icon?: unknown;
    selected?: boolean;
    disabled?: boolean;
    onPress?: () => void;
};
type ActionListSectionProps = {
    actions?: ActionLike[];
};

type DropdownMenuCaptureProps = {
    items?: Array<{ id?: string; title?: string; subtitle?: string }>;
    selectedId?: string | null;
    matchTriggerWidth?: boolean;
    maxWidthCap?: number;
    overlayStyle?: unknown;
    itemTrigger?: { title?: string; subtitle?: string };
    onSelect?: (itemId: string) => void;
};

type AccountServiceEntryOptionsFixture = Omit<AccountServiceEntryOptions, 'retry'> & {
    retry: ReturnType<typeof vi.fn>;
};

let restoreWebLocksMock: (() => void) | null = null;

const capture = vi.hoisted(() => ({
    popoverProps: null as PopoverCaptureProps | null,
    actionSections: [] as ActionListSectionProps[],
    dropdownMenuProps: [] as DropdownMenuCaptureProps[],
    reset() {
        this.popoverProps = null;
        this.actionSections = [];
        this.dropdownMenuProps = [];
    },
}));

const authMocks = vi.hoisted(() => ({
    refreshFromActiveServer: vi.fn(async () => {}),
}));

const connectionMocks = vi.hoisted(() => ({
    switchConnectionToActiveServer: vi.fn(async (_params?: unknown): Promise<unknown> => null),
    retryActiveServerConnection: vi.fn(async () => undefined),
    appliedServerId: '',
    appliedListeners: new Set<() => void>(),
}));

const modalMocks = vi.hoisted(() => ({
    confirm: vi.fn(async () => true),
    show: vi.fn((_config: unknown) => 'modal-id'),
}));

const tokenStorageMock = vi.hoisted(() => ({
    getCredentialsForServerUrl: vi.fn<(serverUrl: string) => Promise<{ token: string; secret: string } | null>>(
        async () => ({ token: 'e30.eyJzdWIiOiJhY2NvdW50LWFkYSJ9.signature', secret: 'scoped-secret' })
    ),
    readPendingExternalAuthState: vi.fn(async () => ({ value: null, serverMismatch: false })),
    readPendingExternalAuthStateForServerUrl: vi.fn(async () => ({ value: null, serverMismatch: false })),
}));

const credentialScopeState = vi.hoisted(() => ({
    resolutions: new Map<string, Readonly<
        | { kind: 'signed_out' }
        | { kind: 'bound'; scope: { serverId: string; accountId: string } }
    >>(),
    cacheKey: '',
    cached: new Map<string, Readonly<
        | { kind: 'signed_out' }
        | { kind: 'bound'; scope: { serverId: string; accountId: string } }
    >>(),
}));

vi.mock('@/sync/domains/scope/useServerCredentialAccountScopes', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/sync/domains/scope/useServerCredentialAccountScopes')>(),
    useServerCredentialAccountScopeResolutions: (serverIds: readonly string[]) => {
        const cacheKey = JSON.stringify(serverIds.map((serverId) => [
            serverId,
            credentialScopeState.resolutions.get(serverId)?.kind ?? 'bound',
        ]));
        if (credentialScopeState.cacheKey !== cacheKey) {
            credentialScopeState.cacheKey = cacheKey;
            credentialScopeState.cached = new Map(
                serverIds.map((serverId) => [serverId, credentialScopeState.resolutions.get(serverId) ?? {
                    kind: 'bound' as const,
                    scope: { serverId, accountId: 'account-ada' },
                }]),
            );
        }
        return credentialScopeState.cached;
    },
}));

const accountDirectoryCredentialState = vi.hoisted(() => ({
    credentials: null as { token: string } | null,
    revision: 0,
}));

const routerMocks = vi.hoisted(() => ({
    push: vi.fn(),
    replace: vi.fn(),
}));

const syncMocks = vi.hoisted(() => ({
    retryNow: vi.fn(),
}));

const irohDiagnosticsState = vi.hoisted(() => ({
    values: [] as Array<Record<string, unknown>>,
    revision: 0,
    listeners: new Set<() => void>(),
}));

const clipboardMock = vi.hoisted(() => ({
    setClipboardStringSafe: vi.fn(async (_value: string) => true),
}));

const accountDirectoryHttpBoundary = vi.hoisted(() => ({
    request: vi.fn(),
}));

const accountEntryState: {
    targetContexts: unknown[];
    useOptions: ReturnType<typeof vi.fn>;
    options: AccountServiceEntryOptionsFixture;
} = vi.hoisted(() => {
    const options = {
        effectiveSignInService: { kind: 'not_offered' as const },
        endpoint: { url: 'https://accounts.example.test', source: 'default' as const },
        status: 'not_offered' as const,
        discovery: null,
        transport: {},
        retry: vi.fn(),
    } satisfies AccountServiceEntryOptionsFixture;
    return {
        targetContexts: Array<unknown>(),
        useOptions: vi.fn(),
        options,
    };
});

function createAccountServiceDiscoveryFixture(): AccountDirectoryAuthMethodDiscovery {
    const capability = {
        version: 1 as const,
        homeDirectory: true,
        homeEnrollment: true,
        homeLoginAssertion: {
            keyId: 'a'.repeat(64),
            publicKeyBase64Url: 'A'.repeat(43),
        },
    };
    const features = createRootLayoutFeaturesResponse({
        capabilities: {
            serverIdentity: { serverIdentityId: 'srv_accounts' },
            server: { canonicalServerUrl: 'https://accounts.example.test' },
            accountDirectory: capability,
            auth: { keyChallenge: { v2: true } },
        },
    });
    return {
        endpointUrl: 'https://accounts.example.test',
        serverIdentityId: 'srv_accounts',
        canonicalServerUrl: 'https://accounts.example.test',
        capability,
        keyLoginAvailable: true,
        oauthProviderIds: [],
        preferredProvisionProviderId: null,
        authenticationCatalog: {
            provenance: 'structured',
            methods: [{
                id: 'key_challenge',
                enabledActions: [{ id: 'login', mode: 'keyed' }],
            }],
        },
        authenticationActions: [{
            method: {
                id: 'key_challenge',
                enabledActions: [{ id: 'login', mode: 'keyed' }],
            },
            action: { id: 'login', mode: 'keyed' },
            execution: { kind: 'key_entry' },
        }],
        accountServiceDisplayName: 'Acme',
        snapshot: { status: 'ready', features },
    };
}

const serverFeaturesState = vi.hoisted(() => ({
    snapshot: {
        status: 'ready' as const,
        features: {
            signInService: {
                v: 1 as const,
                mode: 'external' as const,
                endpoint: 'https://accounts.example.test',
                expectedServerIdentityId: 'srv_accounts',
            },
        },
    },
}));

const settingsState = vi.hoisted(() => ({
    serverSelectionGroups: [] as Array<{ id: string; name: string; serverIds: string[]; presentation: 'grouped' | 'flat-with-badge' }>,
    serverSelectionActiveTargetKind: null as 'server' | 'group' | null,
    serverSelectionActiveTargetId: null as string | null,
}));

const connectionState = vi.hoisted(() => ({
    socketStatus: 'connected' as 'connected' | 'connecting' | 'disconnected' | 'error',
    syncError: null as null | { message: string; retryable?: boolean; kind?: string; at?: number },
    lastSyncAt: null as number | null,
}));

const machineListStatusState = vi.hoisted(() => ({
    byServerId: {} as Record<string, 'idle' | 'loading' | 'signedOut' | 'error'>,
    subscriptionCalls: 0,
}));

const connectionHealthState = vi.hoisted(() => ({
    activeCalls: 0,
    selectionCalls: 0,
    kind: 'no_machine' as
        | 'healthy'
        | 'connecting'
        | 'server_error'
        | 'server_unreachable'
        | 'auth_required'
        | 'no_machine'
        | 'machine_offline'
        | 'machine_not_ready',
    color: '#ff9900',
    isPulsing: false,
    statusLabelKey: 'status.actionRequired',
    machineLabelKey: 'newSession.noMachinesFound',
    endpointStatus: 'online' as 'idle' | 'offline' | 'connecting' | 'online' | 'auth_failed' | 'shutting_down',
    machineCount: 0,
    onlineCount: 0,
    hasUnknownMachines: false,
    primaryMachineLabel: null as string | null,
}));

installConnectionStatusControlCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'web',
                select: (options: { web?: unknown; default?: unknown; ios?: unknown; android?: unknown }) =>
                    options.web ?? options.default ?? options.ios ?? options.android,
            },
            View: 'View',
            Text: 'Text',
            Pressable: 'Pressable',
        });
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({
            theme: {
                colors: {
                    status: {
                        connected: '#00ff00',
                        connecting: '#ffcc00',
                        actionRequired: '#ff9900',
                        disconnected: '#ff0000',
                        error: '#ff0000',
                        default: '#999999',
                    },
                    surface: '#000000',
                    surfaceHigh: '#111111',
                    divider: '#222222',
                    text: '#111111',
                    textSecondary: '#666666',
                },
            },
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({
            translate: (key, params) => params
                ? `${key}(${Object.entries(params).map(([name, value]) => `${name}=${String(value)}`).join(',')})`
                : key,
        });
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useSocketStatus: () => ({ status: connectionState.socketStatus }),
            useSyncError: () => connectionState.syncError,
            useLastSyncAt: () => connectionState.lastSyncAt,
            useMachineListStatusByServerId: () => {
                machineListStatusState.subscriptionCalls += 1;
                return machineListStatusState.byServerId;
            },
            useSettings: () => settingsState,
            useSetting: (key: keyof typeof settingsState) => settingsState[key],
            useSettingMutable: (key: keyof typeof settingsState) => [
                settingsState[key],
                (value: unknown) => {
                    (settingsState as Record<string, unknown>)[String(key)] = value;
                },
            ],
        });
    },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                confirm: modalMocks.confirm,
                show: modalMocks.show,
            },
        }).module;
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({
            router: { push: routerMocks.push, replace: routerMocks.replace },
        }).module;
    },
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/constants/Typography', async (importOriginal) => await importOriginal());

vi.mock('@/components/ui/status/StatusDot', () => ({
    StatusDot: 'StatusDot',
}));

vi.mock('@/components/ui/lists/ActionListSection', () => ({
    ActionListSection: (props: ActionListSectionProps) => {
        capture.actionSections.push(props);
        return null;
    },
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: DropdownMenuCaptureProps) => {
        capture.dropdownMenuProps.push(props);
        return null;
    },
}));

vi.mock('@/components/ui/overlays/FloatingOverlay', () => ({
    FloatingOverlay: (props: { children?: React.ReactNode }) =>
        React.createElement(React.Fragment, null, props.children),
}));

vi.mock('@/components/ui/popover', () => ({
    Popover: (props: PopoverCaptureProps) => {
        capture.popoverProps = props;
        if (!props.open) return null;
        return React.createElement(
            React.Fragment,
            null,
            typeof props.children === 'function' ? props.children({ maxHeight: 520 }) : props.children,
        );
    },
    PopoverScope: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ isAuthenticated: true, refreshFromActiveServer: authMocks.refreshFromActiveServer }),
}));

vi.mock('@/auth/storage/tokenStorage', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/auth/storage/tokenStorage')>();
    const accountDirectoryAuthCredentials = {
        read: vi.fn(async () => accountDirectoryCredentialState.credentials
            ? { kind: 'valid' as const, value: accountDirectoryCredentialState.credentials }
            : { kind: 'absent' as const }),
        get: vi.fn(async () => accountDirectoryCredentialState.credentials),
        set: vi.fn(async (_target: unknown, credentials: { token: string }) => {
            accountDirectoryCredentialState.credentials = credentials;
            accountDirectoryCredentialState.revision += 1;
            return true;
        }),
        remove: vi.fn(async () => {
            const removed = accountDirectoryCredentialState.credentials !== null;
            accountDirectoryCredentialState.credentials = null;
            accountDirectoryCredentialState.revision += 1;
            return removed;
        }),
        clear: vi.fn(async () => {
            const removed = accountDirectoryCredentialState.credentials !== null;
            accountDirectoryCredentialState.credentials = null;
            accountDirectoryCredentialState.revision += 1;
            return removed;
        }),
        logout: vi.fn(async () => {
            const removed = accountDirectoryCredentialState.credentials !== null;
            accountDirectoryCredentialState.credentials = null;
            accountDirectoryCredentialState.revision += 1;
            return removed;
        }),
    };
    return {
        ...actual,
        TokenStorage: tokenStorageMock,
        accountDirectoryAuthCredentials,
        captureAccountDirectoryCredentialCustody: () => {
            const capturedRevision = accountDirectoryCredentialState.revision;
            const isCurrent = () => capturedRevision === accountDirectoryCredentialState.revision;
            return {
                isCurrent,
                checkCurrent: async () => isCurrent(),
                read: async () => {
                    if (!isCurrent()) throw new Error('Account Service credential custody superseded');
                    return accountDirectoryCredentialState.credentials;
                },
                issue: async <T>(request: () => Promise<T>) => {
                    if (!isCurrent()) throw new Error('Account Service credential custody superseded');
                    return await request();
                },
                logout: async () => {
                    if (!isCurrent()) return false;
                    return await accountDirectoryAuthCredentials.logout();
                },
            };
        },
        normalizeAccountDirectoryEndpoint: actual.normalizeAccountDirectoryEndpoint,
        parseAccountContinuationIntent: actual.parseAccountContinuationIntent,
        subscribeHomeCredentialMutations: () => () => {},
    };
});

vi.mock('@/sync/sync', () => ({
    sync: { retryNow: syncMocks.retryNow },
}));

vi.mock('@/sync/http/client', () => ({
    createServerFetchAtEndpoint: (options: { endpointUrl: string }) =>
        (path: string, init?: RequestInit) => accountDirectoryHttpBoundary.request(options.endpointUrl, path, init),
    serverFetch: (path: string, init?: RequestInit) => accountDirectoryHttpBoundary.request('ambient', path, init),
}));

vi.mock('@/sync/runtime/orchestration/connectionManager', () => ({
    switchConnectionToActiveServer: connectionMocks.switchConnectionToActiveServer,
    retryActiveServerConnection: connectionMocks.retryActiveServerConnection,
    getAppliedActiveServerId: () => connectionMocks.appliedServerId,
    subscribeAppliedActiveServer: (listener: () => void) => {
        connectionMocks.appliedListeners.add(listener);
        return () => connectionMocks.appliedListeners.delete(listener);
    },
}));

vi.mock('@/sync/runtime/irohHomeTransportDiagnostics', () => ({
    retireIrohHomeTransportDiagnostics: vi.fn(),
    readIrohHomeTransportDiagnostics: () => irohDiagnosticsState.values,
    readIrohHomeTransportDiagnosticsRevision: () => irohDiagnosticsState.revision,
    isIrohHomeTransportDiagnosticsCurrent: (diagnostics: { state?: unknown; current?: unknown } | null | undefined) => (
        diagnostics?.state === 'connected' && diagnostics.current !== undefined
    ),
    subscribeIrohHomeTransportDiagnostics: (listener: () => void) => {
        irohDiagnosticsState.listeners.add(listener);
        return () => irohDiagnosticsState.listeners.delete(listener);
    },
}));

vi.mock('@/utils/ui/clipboard', () => ({
    setClipboardStringSafe: clipboardMock.setClipboardStringSafe,
}));

vi.mock('@/utils/platform/desktopHost', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/utils/platform/desktopHost')>()),
    desktopHostKind: () => null,
    isDesktopHost: () => false,
}));

vi.mock('@/components/navigation/connectionStatus/useConnectionHealth', () => ({
    useActiveHomeConnectionHealth: () => {
        connectionHealthState.activeCalls += 1;
        return connectionHealthState;
    },
    useConnectionHealth: () => {
        connectionHealthState.selectionCalls += 1;
        return connectionHealthState;
    },
}));

vi.mock('@/components/account/auth/useAccountServiceEntryOptions', () => ({
    useAccountServiceEntryOptions: (targetContext: unknown) => {
        accountEntryState.useOptions(targetContext);
        accountEntryState.targetContexts.push(targetContext);
        return accountEntryState.options;
    },
}));

// The machine guidance reads this computer's daemon through the system-task runner (an OS/process
// boundary). Left real, its status resolves at a racy moment and flips which sentence the guidance
// says; these tests pin "no local daemon reading" so the web/phone sentence is deterministic.
vi.mock('@/components/settings/machines/localControl/useLocalDaemonControl', () => ({
    useLocalDaemonControl: () => ({ status: null }),
}));

vi.mock('@/sync/domains/features/featureDecisionRuntime', () => ({
    useServerFeaturesSnapshotForServerId: () => serverFeaturesState.snapshot,
}));

function getActionLabels(): string[] {
    return capture.actionSections.flatMap((section) =>
        (section.actions ?? []).flatMap((action) => {
            if (!action || typeof action !== 'object') return [];
            const label = action.label;
            return typeof label === 'string' ? [label] : [];
        }),
    );
}

/** The row of the Home this device is in (selected in these single-Home fixtures). */
function findCurrentHomeAction(): ActionLike | undefined {
    return getActions().filter((action) => String(action.id).startsWith('target-use-server-') && action.selected).at(-1);
}

function getActions(): ActionLike[] {
    return capture.actionSections.flatMap((section) => section.actions ?? []);
}

function findAction(id: string): ActionLike | undefined {
    const actions = getActions();
    for (let index = actions.length - 1; index >= 0; index -= 1) {
        if (actions[index]?.id === id) return actions[index];
    }
    return undefined;
}

async function openStep(id: 'account-identity' | 'connection-details') {
    const row = findAction(id);
    if (!row?.onPress) throw new Error(`expected an openable ${id} row`);
    capture.actionSections = [];
    await act(async () => {
        row.onPress?.();
    });
}

/** Presses an inline row button (a RoundButton element passed as the row's `right`). */
async function pressRowButton(id: string) {
    const right = (findAction(id) as { right?: React.ReactElement<{ onPress?: () => void }> } | undefined)?.right;
    if (!right?.props.onPress) throw new Error(`expected an inline button on ${id}`);
    await act(async () => {
        right.props.onPress?.();
    });
}

async function importConnectionStatusControl() {
    const module = await import('./ConnectionStatusControl');
    return module.ConnectionStatusControl;
}

// The first import transforms the control's whole module graph, which alone can take most of a
// test's timeout on a loaded host. Load it once up front so each test measures only its behaviour.
beforeAll(async () => {
    await import('./ConnectionStatusControl');
}, 240_000);

beforeEach(() => {
    restoreWebLocksMock = installWebLockManagerMock().restore;
});

afterEach(() => {
    restoreWebLocksMock?.();
    restoreWebLocksMock = null;
    capture.reset();
    authMocks.refreshFromActiveServer.mockClear();
    connectionMocks.switchConnectionToActiveServer.mockReset();
    connectionMocks.switchConnectionToActiveServer.mockResolvedValue(null);
    connectionMocks.retryActiveServerConnection.mockReset();
    connectionMocks.retryActiveServerConnection.mockResolvedValue(undefined);
    connectionMocks.appliedServerId = '';
    connectionMocks.appliedListeners.clear();
    modalMocks.confirm.mockReset();
    modalMocks.show.mockClear();
    syncMocks.retryNow.mockReset();
    tokenStorageMock.getCredentialsForServerUrl.mockReset();
    tokenStorageMock.getCredentialsForServerUrl.mockResolvedValue({ token: 'e30.eyJzdWIiOiJhY2NvdW50LWFkYSJ9.signature', secret: 'scoped-secret' });
    credentialScopeState.resolutions.clear();
    credentialScopeState.cacheKey = '';
    routerMocks.push.mockReset();
    routerMocks.replace.mockReset();
    settingsState.serverSelectionGroups = [];
    settingsState.serverSelectionActiveTargetKind = null;
    settingsState.serverSelectionActiveTargetId = null;
    connectionState.socketStatus = 'connected';
    connectionState.syncError = null;
    connectionState.lastSyncAt = null;
    irohDiagnosticsState.values = [];
    irohDiagnosticsState.revision = 0;
    irohDiagnosticsState.listeners.clear();
    clipboardMock.setClipboardStringSafe.mockClear();
    accountDirectoryHttpBoundary.request.mockReset();
    accountDirectoryCredentialState.credentials = null;
    accountDirectoryCredentialState.revision += 1;
    machineListStatusState.byServerId = {};
    machineListStatusState.subscriptionCalls = 0;
    connectionHealthState.kind = 'no_machine';
    connectionHealthState.color = '#ff9900';
    connectionHealthState.isPulsing = false;
    connectionHealthState.statusLabelKey = 'status.actionRequired';
    connectionHealthState.machineLabelKey = 'newSession.noMachinesFound';
    connectionHealthState.endpointStatus = 'online';
    connectionHealthState.machineCount = 0;
    connectionHealthState.onlineCount = 0;
    connectionHealthState.hasUnknownMachines = false;
    connectionHealthState.primaryMachineLabel = null;
    connectionHealthState.activeCalls = 0;
    connectionHealthState.selectionCalls = 0;
    accountEntryState.targetContexts = [];
    accountEntryState.useOptions.mockReset();
    accountEntryState.options = {
        effectiveSignInService: { kind: 'not_offered' },
        endpoint: { url: 'https://accounts.example.test', source: 'default' },
        status: 'not_offered',
        discovery: null,
        transport: {},
        retry: accountEntryState.options.retry,
    };
    accountEntryState.options.retry.mockReset();
});

describe('ConnectionStatusControl (native popover config)', () => {
    it('projects the verified signed-in service and linked Homes, then signs out only that service', async () => {
        const previousScope = process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = `test_${Date.now()}_${Math.random().toString(16).slice(2)}`;
        const localStorage = installLocalStorageMock();

        try {
            (await import('@/sync/domains/server/serverProfiles')).resetServerProfilesRuntimeForTests();
            const tokenStorage = await vi.importActual<typeof import('@/auth/storage/tokenStorage')>('@/auth/storage/tokenStorage');
            const profiles = await import('@/sync/domains/server/serverProfiles');
            const home = await profiles.upsertServerProfile({ serverUrl: 'https://home-l2.example.test', name: 'Personal Home L2' });
            await profiles.setServerProfileIdentityForUrl(home.serverUrl, 'srv_home_l2');
            await profiles.setActiveServerId(home.id, { scope: 'device' });
            connectionMocks.appliedServerId = 'srv_home_l2';
            await tokenStorage.TokenStorage.setCredentialsForServerUrl(
                home.serverUrl,
                { serverId: 'srv_home_l2' },
                { token: 'home-token', secret: 'home-secret' },
            );
            accountDirectoryCredentialState.credentials = { token: 'account-service-token' };
            accountDirectoryCredentialState.revision += 1;
            accountDirectoryHttpBoundary.request.mockImplementation(async (_endpoint: string, path: string) => {
                if (path === '/v1/account-directory/homes') {
                    return new Response(JSON.stringify({
                        v: 1,
                        homes: [{
                            v: 1,
                            homeServerIdentityId: 'srv_home_l1',
                            canonicalServerUrl: 'https://home-l1.example.test',
                            label: 'Team Home L1',
                            preferred: true,
                            createdAtMs: 1,
                            updatedAtMs: 1,
                            connectionDescriptor: {
                                v: 1,
                                homeServerIdentityId: 'srv_home_l1',
                                canonicalServerUrl: 'https://home-l1.example.test',
                                revision: 1,
                                endpoints: [{ kind: 'https', url: 'https://home-l1.example.test' }],
                            },
                        }],
                        preferredHomeServerIdentityId: 'srv_home_l1',
                    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
                }
                throw new Error(`Unexpected Account Directory request: ${path}`);
            });
            accountEntryState.options = {
                effectiveSignInService: {
                    kind: 'external',
                    endpoint: 'https://accounts.example.test',
                    expectedServerIdentityId: 'srv_accounts',
                },
                endpoint: {
                    url: 'https://accounts.example.test',
                    serverIdentityId: 'srv_accounts',
                    source: 'default',
                },
                status: 'ready',
                discovery: createAccountServiceDiscoveryFixture(),
                transport: {},
                retry: accountEntryState.options.retry,
            };

            const ConnectionStatusControl = await importConnectionStatusControl();
            const screen = await renderScreen(React.createElement(ConnectionStatusControl, { variant: 'sidebar' }));
            await act(async () => pressTestInstanceAsync(screen.findByProps({ accessibilityRole: 'button' })));

            // The identity row names the signed-in service; its own actions sit behind it.
            await vi.waitFor(() => expect(findAction('account-identity')).toMatchObject({ subtitle: 'Acme' }));
            await openStep('account-identity');
            await vi.waitFor(() => expect(findAction('account-back')).toMatchObject({
                label: 'Acme',
                subtitle: 'settingsAccount.accountServiceSignedInTo(accountService=Acme)',
            }));
            expect(findAction('account-back')?.subtitle).not.toContain('srv_accounts');
            await vi.waitFor(() => expect(findAction('account-directory-home-srv_home_l1')).toMatchObject({ label: 'Team Home L1' }));

            await act(async () => {
                await findAction('account-service-sign-out')?.onPress?.();
            });

            expect(accountDirectoryCredentialState.credentials).toBeNull();
            expect(await tokenStorage.TokenStorage.getCredentialsForServerUrl(
                home.serverUrl,
                { serverId: 'srv_home_l2' },
            )).toEqual({ token: 'home-token', secret: 'home-secret' });
        } finally {
            localStorage.restore();
            if (previousScope === undefined) delete process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
            else process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = previousScope;
        }
    });

    it('launches Find without L2 and Link with the exact authenticated L2 identity', async () => {
        const previousScope = process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = `test_${Date.now()}_${Math.random().toString(16).slice(2)}`;

        try {
            (await import('@/sync/domains/server/serverProfiles')).resetServerProfilesRuntimeForTests();
            const profiles = await import('@/sync/domains/server/serverProfiles');
            const home = await profiles.upsertServerProfile({ serverUrl: 'https://home-l2.example.test', name: 'Personal Home L2' });
            await profiles.setServerProfileIdentityForUrl(home.serverUrl, 'srv_home_l2');
            await profiles.setActiveServerId(home.id, { scope: 'device' });
            await profiles.setAccountServiceEndpoint({
                url: 'https://device-default.example.test',
                serverIdentityId: 'srv_device_default',
                source: 'user',
            });
            connectionMocks.appliedServerId = 'srv_home_l2';
            accountEntryState.options = {
                effectiveSignInService: {
                    kind: 'external',
                    endpoint: 'https://accounts.example.test',
                    expectedServerIdentityId: 'srv_accounts',
                },
                endpoint: {
                    url: 'https://accounts.example.test',
                    serverIdentityId: 'srv_accounts',
                    source: 'default',
                },
                status: 'ready',
                discovery: createAccountServiceDiscoveryFixture(),
                transport: {},
                retry: accountEntryState.options.retry,
            };

            const ConnectionStatusControl = await importConnectionStatusControl();
            const screen = await renderScreen(React.createElement(ConnectionStatusControl, { variant: 'sidebar' }));
            await act(async () => pressTestInstanceAsync(screen.findByProps({ accessibilityRole: 'button' })));

            expect(accountEntryState.useOptions).toHaveBeenCalled();
            expect(accountEntryState.targetContexts.at(-1)).toMatchObject({
                kind: 'home',
                target: { kind: 'saved_profile', profileRef: home.id },
                policy: {
                    mode: 'external',
                    endpoint: 'https://accounts.example.test',
                    expectedServerIdentityId: 'srv_accounts',
                },
            });

            await openStep('account-identity');
            const findHomes = findAction('account-find-homes');
            await act(async () => {
                findHomes?.onPress?.();
                findHomes?.onPress?.();
            });
            expect(routerMocks.push).toHaveBeenCalledTimes(1);
            expect(routerMocks.push).toHaveBeenLastCalledWith({
                pathname: '/homes/sign-in',
                params: {
                    accountServiceEndpoint: 'https://accounts.example.test',
                    accountServiceIdentity: 'srv_accounts',
                    accountIntent: JSON.stringify({ kind: 'enter', target: { kind: 'automatic' } }),
                    accountEntryReturnTo: '/',
                },
            });

            await act(async () => screen.findByProps({ accessibilityRole: 'button' }).props.onPress());
            // "Make this Home available…" is on the first layer, as a row with an inline Link.
            const linkHome = findAction('account-link-current-home');
            expect(linkHome?.label).toBe('sidebarFooter.linkToService(service=Acme)');
            await pressRowButton('account-link-current-home');
            await act(async () => {
                linkHome?.onPress?.();
            });
            expect(routerMocks.push).toHaveBeenCalledTimes(2);
            expect(routerMocks.push).toHaveBeenLastCalledWith({
                pathname: '/homes/sign-in',
                params: {
                    accountServiceEndpoint: 'https://accounts.example.test',
                    accountServiceIdentity: 'srv_accounts',
                    accountIntent: JSON.stringify({ kind: 'link', homeServerIdentityId: 'srv_home_l2' }),
                    accountEntryReturnTo: '/',
                },
            });
            expect(profiles.resolveSelectedAccountServiceEndpoint()).toMatchObject({
                url: 'https://device-default.example.test',
                serverIdentityId: 'srv_device_default',
                source: 'user',
            });
        } finally {
            if (previousScope === undefined) delete process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
            else process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = previousScope;
        }
    });

    it('does not mount the closed popover shell until the trigger opens it', async () => {
        const ConnectionStatusControl = await importConnectionStatusControl();
        const screen = await renderScreen(React.createElement(ConnectionStatusControl, { variant: 'sidebar' }));

        expect(capture.popoverProps).toBeNull();
        expect(accountEntryState.useOptions).not.toHaveBeenCalled();
        expect(connectionHealthState.activeCalls).toBeGreaterThan(0);
        expect(connectionHealthState.selectionCalls).toBe(0);
        expect(machineListStatusState.subscriptionCalls).toBe(0);

        const trigger = screen.findByProps({ accessibilityRole: 'button' });
        await act(async () => {
            await pressTestInstanceAsync(trigger);
        });

        expect(capture.popoverProps?.open).toBe(true);
        expect(accountEntryState.useOptions).toHaveBeenCalled();
        expect(machineListStatusState.subscriptionCalls).toBeGreaterThan(0);
    });

    it('does not publish account-entry actions before exact service discovery is ready', async () => {
        const ConnectionStatusControl = await importConnectionStatusControl();
        const screen = await renderScreen(React.createElement(ConnectionStatusControl, { variant: 'sidebar' }));

        await act(async () => pressTestInstanceAsync(screen.findByProps({ accessibilityRole: 'button' })));

        expect(findAction('account-find-homes')).toBeUndefined();
        expect(findAction('account-link-current-home')).toBeUndefined();
        expect(findAction('account-identity')?.onPress).toBeUndefined();
    });

    it('keeps a retryable notice in the popover when sign-in-service discovery fails', async () => {
        accountEntryState.options = {
            effectiveSignInService: { kind: 'no_target_default', endpoint: 'https://accounts.example.test' },
            endpoint: { url: 'https://accounts.example.test', displayName: 'Acme', source: 'user' },
            status: 'unavailable',
            discovery: null,
            transport: {},
            retry: accountEntryState.options.retry,
        };
        const ConnectionStatusControl = await importConnectionStatusControl();
        const screen = await renderScreen(React.createElement(ConnectionStatusControl, { variant: 'sidebar' }));

        await act(async () => pressTestInstanceAsync(screen.findByProps({ accessibilityRole: 'button' })));

        const identity = findAction('account-identity');
        expect(identity?.subtitle).toBe('accountPopover.serviceUnavailable(service=Acme)');
        await pressRowButton('account-identity');
        expect(accountEntryState.options.retry).toHaveBeenCalledTimes(1);
    });

    it('says a Home that is its own sign-in service is signed in, offers no link, and tells its trigger the same', async () => {
        const previousSnapshot = serverFeaturesState.snapshot;
        (serverFeaturesState as { snapshot: unknown }).snapshot = {
            status: 'ready',
            features: { signInService: { v: 1, mode: 'self' } },
        };
        accountEntryState.options = {
            effectiveSignInService: { kind: 'self', target: { kind: 'saved_profile', profileRef: 'home' } },
            endpoint: { url: 'https://home.example.test', source: 'default' },
            status: 'ready',
            discovery: { ...createAccountServiceDiscoveryFixture(), accountServiceDisplayName: 'Personal Home' },
            transport: {},
            retry: accountEntryState.options.retry,
        } as AccountServiceEntryOptionsFixture;
        try {
            const triggerStates: Array<{ accountService?: unknown }> = [];
            const ConnectionStatusControl = await importConnectionStatusControl();
            const screen = await renderScreen(React.createElement(ConnectionStatusControl, {
                variant: 'sidebar',
                renderTrigger: (state: { activate: () => void; accountService?: unknown }) => {
                    triggerStates.push(state);
                    return React.createElement('Pressable', { accessibilityRole: 'button', onPress: state.activate });
                },
            }));
            // Closed chrome already knows, from the same owner, without probing the service.
            expect(triggerStates.at(-1)?.accountService).toEqual({ kind: 'self' });

            await act(async () => pressTestInstanceAsync(screen.findByProps({ accessibilityRole: 'button' })));
            await vi.waitFor(() => expect(findAction('account-identity')?.subtitle).toBe('accountPopover.signedInToThisHome'));
            expect(findAction('account-identity')?.subtitle).not.toContain('notLinkedTo');
            expect(findAction('account-link-current-home')).toBeUndefined();
            await act(async () => screen.tree?.unmount());
        } finally {
            (serverFeaturesState as { snapshot: unknown }).snapshot = previousSnapshot;
        }
    });

    it('names the viewer\'s unnamed Account and always gives the identity row its service line', async () => {
        const previousSnapshot = serverFeaturesState.snapshot;
        (serverFeaturesState as { snapshot: unknown }).snapshot = { status: 'loading' };
        try {
            const ConnectionStatusControl = await importConnectionStatusControl();
            const screen = await renderScreen(React.createElement(ConnectionStatusControl, { variant: 'sidebar' }));
            await act(async () => pressTestInstanceAsync(screen.findByProps({ accessibilityRole: 'button' })));

            const identity = findAction('account-identity');
            expect(identity?.label).toBe('accountDisplay.yours');
            // The Home's sign-in policy is not read yet: a quiet placeholder, never an empty line.
            expect(identity?.subtitle).toBe('accountPopover.checkingSignIn');
            await act(async () => screen.tree?.unmount());
        } finally {
            (serverFeaturesState as { snapshot: unknown }).snapshot = previousSnapshot;
        }
    });

    it('settles the identity line when the current Home cannot be reached, and updates when it answers', async () => {
        const previousSnapshot = serverFeaturesState.snapshot;
        (serverFeaturesState as { snapshot: unknown }).snapshot = { status: 'loading' };
        connectionHealthState.kind = 'server_unreachable';
        try {
            const ConnectionStatusControl = await importConnectionStatusControl();
            const screen = await renderScreen(React.createElement(ConnectionStatusControl, { variant: 'sidebar' }));
            await act(async () => pressTestInstanceAsync(screen.findByProps({ accessibilityRole: 'button' })));
            expect(findAction('account-identity')?.subtitle).toBe('accountPopover.signInStatusUnavailable');

            // The Home answers: the line follows the canonical owners again.
            connectionHealthState.kind = 'healthy';
            (serverFeaturesState as { snapshot: unknown }).snapshot = previousSnapshot;
            await act(async () => screen.tree?.update(React.createElement(ConnectionStatusControl, { variant: 'sidebar', textSize: 12 })));
            expect(findAction('account-identity')?.subtitle).not.toBe('accountPopover.signInStatusUnavailable');
            await act(async () => screen.tree?.unmount());
        } finally {
            (serverFeaturesState as { snapshot: unknown }).snapshot = previousSnapshot;
        }
    });

    it('offers the identity row\'s chevron exactly when the row opens the account step', async () => {
        accountEntryState.options = {
            effectiveSignInService: { kind: 'external', endpoint: 'https://accounts.example.test', expectedServerIdentityId: 'srv_accounts' },
            endpoint: { url: 'https://accounts.example.test', serverIdentityId: 'srv_accounts', source: 'default' },
            status: 'ready',
            discovery: createAccountServiceDiscoveryFixture(),
            transport: {},
            retry: accountEntryState.options.retry,
        };
        const ConnectionStatusControl = await importConnectionStatusControl();
        const screen = await renderScreen(React.createElement(ConnectionStatusControl, { variant: 'sidebar' }));
        await act(async () => pressTestInstanceAsync(screen.findByProps({ accessibilityRole: 'button' })));
        const openable = findAction('account-identity') as { onPress?: unknown; right?: React.ReactElement<{ name?: string }> };
        expect(openable.onPress).toBeTypeOf('function');
        expect(openable.right?.props.name).toBe('caret-right');
        await act(async () => screen.tree?.unmount());
    });

    it('uses the shared popover autofocus and trigger focus-return contract', async () => {
        const ConnectionStatusControl = await importConnectionStatusControl();
        const screen = await renderScreen(React.createElement(ConnectionStatusControl, { variant: 'sidebar' }));
        const trigger = screen.findByProps({ accessibilityRole: 'button' });

        await act(async () => pressTestInstanceAsync(trigger));

        expect(capture.popoverProps?.autoFocusOnOpen).toBe(true);
        expect(capture.popoverProps?.focusReturnRef).toBeDefined();
        await act(async () => screen.tree?.unmount());
    });

    it('offers "Add a Home", which closes the popover and opens the Homes collection draft', async () => {
        const ConnectionStatusControl = await importConnectionStatusControl();
        const screen = await renderScreen(React.createElement(ConnectionStatusControl, { variant: 'sidebar' }));
        const trigger = screen.findByProps({ accessibilityRole: 'button' });

        await act(async () => pressTestInstanceAsync(trigger));
        const addHome = findAction('add-home-or-sign-in');
        expect(addHome?.label).toBe('accountPopover.addHome');

        capture.popoverProps = null;
        await act(async () => {
            addHome?.onPress?.();
        });

        expect(capture.popoverProps).toBeNull();
        const { HOMES_ADD_ROUTE } = await import('@/components/settings/server/collection/homeCollectionModel');
        expect(routerMocks.push).toHaveBeenCalledWith(HOMES_ADD_ROUTE);
        await act(async () => screen.tree?.unmount());
    });

    it('toggles the popover when pressing the trigger twice', async () => {
        const ConnectionStatusControl = await importConnectionStatusControl();
        let tree: renderer.ReactTestRenderer | undefined;
        const screen = await renderScreen(React.createElement(ConnectionStatusControl, { variant: 'sidebar' }));
        tree = screen.tree;

        expect(capture.popoverProps).toBeNull();

        const trigger = screen.findByProps({ accessibilityRole: 'button' });
        await act(async () => {
            await pressTestInstanceAsync(trigger);
        });

        expect(capture.popoverProps?.open).toBe(true);

        capture.popoverProps = null;
        await act(async () => {
            await pressTestInstanceAsync(trigger);
        });

        expect(capture.popoverProps).toBeNull();

        await act(async () => {
            tree?.unmount();
        });
    });

    it('enables a native portal so the menu is not width-constrained to the trigger', async () => {
        const ConnectionStatusControl = await importConnectionStatusControl();
        let tree: renderer.ReactTestRenderer | undefined;
        const screen = await renderScreen(React.createElement(ConnectionStatusControl, { variant: 'sidebar' }));
        tree = screen.tree;

        const trigger = screen.findByProps({ accessibilityRole: 'button' });
        await act(async () => {
            await pressTestInstanceAsync(trigger);
        });

        expect(capture.popoverProps).toBeTruthy();
        expect(capture.popoverProps?.portal?.web).toBe(true);
        expect(capture.popoverProps?.portal?.native).toBe(true);
        expect(capture.popoverProps?.portal?.matchAnchorWidth).toBe(false);

        await act(async () => {
            tree?.unmount();
        });
    });

    it('lets the content size the popover within the shared bounds', async () => {
        const ConnectionStatusControl = await importConnectionStatusControl();
        let tree: renderer.ReactTestRenderer | undefined;
        const screen = await renderScreen(React.createElement(ConnectionStatusControl, { variant: 'sidebar' }));
        tree = screen.tree;

        const trigger = screen.findByProps({ accessibilityRole: 'button' });
        await act(async () => {
            await pressTestInstanceAsync(trigger);
        });

        expect(capture.popoverProps?.portal).toMatchObject({ sizeToContent: true, anchorAlign: 'start' });

        await act(async () => {
            tree?.unmount();
        });
    });

    it('keeps the first layer to Homes and puts live and technical connection facts behind Connection details', async () => {
        const profiles = await import('@/sync/domains/server/serverProfiles');
        const activeProfile = profiles.listServerProfiles().find((profile) => profile.name === 'Happier Cloud');
        if (!activeProfile) throw new Error('expected default Happier Cloud profile');
        const target = profiles.captureActiveServerRuntimeTarget();
        const leaseId = 'iroh-effective-carrier-for-current-label';
        expect(profiles.publishActiveServerRuntimeOrigin({
            target,
            leaseId,
            runtimeOrigin: 'http://127.0.0.1:43123',
            carrier: 'iroh',
        })).toBe(true);
        irohDiagnosticsState.values = [{
            homeServerIdentityId: profiles.resolveServerProfileScopeId(activeProfile),
            remoteEndpointId: 'iroh-endpoint-123',
            state: 'connected',
            current: { carrier: 'iroh', observedPath: 'relay' },
            effectiveConfiguration: {
                policy: 'automatic',
                relayUrls: ['https://relay.example.test'],
                directAddressCount: 1,
            },
            lastTransitionAtMs: 1_700_000_000_000,
        }];
        try {
            const ConnectionStatusControl = await importConnectionStatusControl();
            let tree: renderer.ReactTestRenderer | undefined;
            const screen = await renderScreen(React.createElement(ConnectionStatusControl, { variant: 'sidebar' }));
            tree = screen.tree;

            const trigger = screen.findByProps({ accessibilityRole: 'button' });
            await act(async () => {
                await pressTestInstanceAsync(trigger);
            });

            expect(getActions().some((action) => String(action.id).startsWith('target-use-server-'))).toBe(true);
            expect(tree!.root.findAllByProps({ testID: 'connection-popover-relay' })).toHaveLength(0);
            expect(tree!.root.findAllByProps({ testID: 'connection-popover-realtime' })).toHaveLength(0);
            expect(tree!.root.findAllByProps({ testID: 'connection-popover-machines' })).toHaveLength(0);
            expect(screen.getTextContent()).not.toContain('iroh-endpoint-123');

            await openStep('connection-details');

            expect(findAction('details-back')?.label).toBe('accountPopover.connectionDetails');
            expect(screen.getTextContent()).toContain('systemStatus.transport.irohCurrent');
            expect(screen.getTextContent()).not.toContain('systemStatus.server.activeServer');
            expect(tree!.root.findAllByProps({ testID: 'connection-popover-realtime' }).length).toBeGreaterThan(0);
            expect(tree!.root.findAllByProps({ testID: 'connection-popover-machines' }).length).toBeGreaterThan(0);
            expect(screen.getTextContent()).toContain('iroh-endpoint-123');
            expect(screen.getTextContent()).toContain('relay.example.test');
            expect(screen.getTextContent()).not.toContain('connectionStatus.labels.transport');
            expect(screen.getTextContent()).not.toContain('connectionStatus.labels.connectionMode');
            await act(async () => tree?.unmount());
        } finally {
            profiles.releaseActiveServerRuntimeOrigin({ target, leaseId });
        }
    });

    it('places an icon-only retry action next to the relay status badge when the server is unreachable', async () => {
        connectionHealthState.kind = 'server_unreachable';
        connectionHealthState.color = '#ff0000';
        connectionHealthState.statusLabelKey = 'status.disconnected';
        connectionHealthState.machineLabelKey = 'status.unknown';
        connectionHealthState.endpointStatus = 'offline';
        const profiles = await import('@/sync/domains/server/serverProfiles');
        const activeProfile = profiles.listServerProfiles().find((profile) => profile.name === 'Happier Cloud');
        if (!activeProfile) throw new Error('expected default Happier Cloud profile');
        irohDiagnosticsState.values = [{
            homeServerIdentityId: profiles.resolveServerProfileScopeId(activeProfile),
            state: 'disconnected',
            lastKnown: { carrier: 'iroh', observedPath: 'relay' },
        }];

        const ConnectionStatusControl = await importConnectionStatusControl();
        let tree: renderer.ReactTestRenderer | undefined;
        const screen = await renderScreen(React.createElement(ConnectionStatusControl, { variant: 'sidebar' }));
        tree = screen.tree;

        const trigger = screen.findByProps({ accessibilityRole: 'button' });
        await act(async () => {
            await pressTestInstanceAsync(trigger);
        });

        await openStep('connection-details');

        const retryButton = screen.findByTestId('connection-popover-relay-retry');
        expect(retryButton).toBeTruthy();
        expect(retryButton?.props.style).toMatchObject({ minWidth: 44, minHeight: 44 });

        await act(async () => {
            await pressTestInstanceAsync(retryButton);
        });

        expect(connectionMocks.retryActiveServerConnection).toHaveBeenCalledTimes(1);
        expect(syncMocks.retryNow).not.toHaveBeenCalled();

        await act(async () => {
            tree?.unmount();
        });
    });

    it('renders every Home in the primary list without a nested dropdown', async () => {
        const previousScope = process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
        const scope = `test_${Date.now()}_${Math.random().toString(16).slice(2)}`;
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;

        try {
            (await import('@/sync/domains/server/serverProfiles')).resetServerProfilesRuntimeForTests();
            const profiles = await import('@/sync/domains/server/serverProfiles');
            const local = await profiles.upsertServerProfile({ serverUrl: 'https://local.example.test', name: 'Local' });
            const company = await profiles.upsertServerProfile({ serverUrl: 'https://company.example.test', name: 'Company' });
            await profiles.setActiveServerId(local.id, { scope: 'device' });
            connectionMocks.appliedServerId = local.id;
            settingsState.serverSelectionGroups = [
                {
                    id: 'grp-dev',
                    name: 'Dev Group',
                    serverIds: [local.id, company.id],
                    presentation: 'grouped',
                },
            ];
            const ConnectionStatusControl = await importConnectionStatusControl();

            let tree: renderer.ReactTestRenderer | undefined;
            const screen = await renderScreen(React.createElement(ConnectionStatusControl, { variant: 'sidebar' }));
            tree = screen.tree;

            const trigger = screen.findByProps({ accessibilityRole: 'button' });
            await act(async () => {
                await pressTestInstanceAsync(trigger);
            });

            const actionLabels = getActionLabels();

            expect(capture.dropdownMenuProps).toHaveLength(0);
            expect(actionLabels.some((label) => label.toLowerCase().includes('company'))).toBe(true);
            expect(actionLabels.some((label) => label.toLowerCase().includes('dev group'))).toBe(true);

            await act(async () => {
                tree?.unmount();
            });
        } finally {
            if (previousScope === undefined) {
                delete process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
            } else {
                process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = previousScope;
            }
        }
    });

    it('keeps the trigger and details on the applied Home while another Home is staged', async () => {
        const previousScope = process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
        const scope = `test_${Date.now()}_${Math.random().toString(16).slice(2)}`;
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;

        try {
            (await import('@/sync/domains/server/serverProfiles')).resetServerProfilesRuntimeForTests();
            const profiles = await import('@/sync/domains/server/serverProfiles');
            const local = await profiles.upsertServerProfile({ serverUrl: 'https://local.example.test', name: 'Local' });
            const company = await profiles.upsertServerProfile({ serverUrl: 'https://company.example.test', name: 'Company' });
            await profiles.setActiveServerId(local.id, { scope: 'device' });
            connectionMocks.appliedServerId = local.id;
            settingsState.serverSelectionGroups = [{
                id: 'grp-dev',
                name: 'Dev Group',
                serverIds: [local.id, company.id],
                presentation: 'grouped',
            }];

            const ConnectionStatusControl = await importConnectionStatusControl();
            const screen = await renderScreen(React.createElement(ConnectionStatusControl, { variant: 'sidebar' }));
            await act(async () => {
                for (const listener of connectionMocks.appliedListeners) listener();
            });
            const trigger = screen.findByProps({ accessibilityRole: 'button' });
            await act(async () => {
                await pressTestInstanceAsync(trigger);
            });
            await openStep('connection-details');

            await act(async () => {
                // Model the reachable production boundary directly: selection is
                // staged to Company while full Sync remains applied to Local.
                await profiles.setActiveServerId(company.id, { scope: 'device' });
                await vi.waitFor(() => {
                    expect(profiles.areServerProfileIdentifiersEquivalent(
                        profiles.getActiveServerSnapshot().serverId,
                        company.id,
                    )).toBe(true);
                });
            });

            expect(trigger.props.accessibilityLabel).toContain('Local');
            expect(trigger.props.accessibilityLabel).not.toContain('Company');
            expect(screen.getTextContent()).toContain('local.example.test');
            expect(screen.getTextContent()).not.toContain('company.example.test');
            await act(async () => {
                screen.tree.unmount();
            });
        } finally {
            if (previousScope === undefined) delete process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
            else process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = previousScope;
        }
    });

    it('opens the Homes page from Manage Homes', async () => {
        const ConnectionStatusControl = await importConnectionStatusControl();

        let tree: renderer.ReactTestRenderer | undefined;
        const screen = await renderScreen(React.createElement(ConnectionStatusControl, { variant: 'sidebar' }));
        tree = screen.tree;

        const trigger = screen.findByProps({ accessibilityRole: 'button' });
        await act(async () => {
            await pressTestInstanceAsync(trigger);
        });

        const manageHomes = findAction('manage-homes');
        expect(manageHomes?.label).toBe('accountPopover.manageHomes');

        await act(async () => {
            manageHomes?.onPress?.();
        });

        expect(routerMocks.push).toHaveBeenCalledWith('/settings/server');

        await act(async () => {
            tree?.unmount();
        });
    });

    it('shows the active server target row even when there is only one saved server', async () => {
        const previousScope = process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
        const scope = `test_${Date.now()}_${Math.random().toString(16).slice(2)}`;
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;

        try {
            (await import('@/sync/domains/server/serverProfiles')).resetServerProfilesRuntimeForTests();
            const profiles = await import('@/sync/domains/server/serverProfiles');
            const local = await profiles.upsertServerProfile({ serverUrl: 'https://local.example.test', name: 'Local' });
            await profiles.setActiveServerId(local.id, { scope: 'device' });

            const ConnectionStatusControl = await importConnectionStatusControl();

            let tree: renderer.ReactTestRenderer | undefined;
            const screen = await renderScreen(React.createElement(ConnectionStatusControl, { variant: 'sidebar' }));
            tree = screen.tree;

            const trigger = screen.findByProps({ accessibilityRole: 'button' });
            await act(async () => {
                await pressTestInstanceAsync(trigger);
            });

            const actionLabels = getActionLabels();
            expect(capture.dropdownMenuProps).toHaveLength(0);
            expect(actionLabels.some((label) => label.toLowerCase().includes('local'))).toBe(true);

            await act(async () => {
                tree?.unmount();
            });
        } finally {
            if (previousScope === undefined) {
                delete process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
            } else {
                process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = previousScope;
            }
        }
    });

    it('switches server without reload by using runtime switch handlers', async () => {
        const previousScope = process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
        const scope = `test_${Date.now()}_${Math.random().toString(16).slice(2)}`;
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;
        const webGlobals = globalThis as unknown as Record<string, unknown>;
        const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
        const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
        const previousSessionStorage = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
        const sessionValues = new Map<string, string>();
        Object.defineProperties(globalThis, {
            window: { configurable: true, value: {} },
            document: { configurable: true, value: { getElementById: () => null } },
            sessionStorage: {
                configurable: true,
                value: {
                    getItem: (key: string) => sessionValues.get(key) ?? null,
                    setItem: (key: string, value: string) => sessionValues.set(key, value),
                    removeItem: (key: string) => sessionValues.delete(key),
                },
            },
        });

        try {
            (await import('@/sync/domains/server/serverProfiles')).resetServerProfilesRuntimeForTests();
            const profiles = await import('@/sync/domains/server/serverProfiles');
            const local = await profiles.upsertServerProfile({ serverUrl: 'https://local.example.test', name: 'Local' });
            const company = await profiles.upsertServerProfile({ serverUrl: 'https://company.example.test', name: 'Company' });
            await profiles.setActiveServerId(local.id, { scope: 'device' });
            const previousDeviceDefault = profiles.getDeviceDefaultServerId();
            const ConnectionStatusControl = await importConnectionStatusControl();

            let tree: renderer.ReactTestRenderer | undefined;
            const screen = await renderScreen(React.createElement(ConnectionStatusControl, { variant: 'sidebar' }));
            tree = screen.tree;

            const trigger = screen.findByProps({ accessibilityRole: 'button' });
            await act(async () => {
                await pressTestInstanceAsync(trigger);
            });

            const companyItem = findAction(`target-use-server-${company.id}`);
            expect(companyItem).toBeTruthy();
            const localItem = findAction(`target-use-server-${local.id}`);
            expect(localItem).toMatchObject({ selected: true });
            expect(localItem?.disabled).not.toBe(true);

            await act(async () => {
                localItem?.onPress?.();
            });
            expect(connectionMocks.switchConnectionToActiveServer).not.toHaveBeenCalled();

            await act(async () => {
                companyItem?.onPress?.();
            });

            await vi.waitFor(() => {
                expect(connectionMocks.switchConnectionToActiveServer).toHaveBeenCalledTimes(1);
                expect(authMocks.refreshFromActiveServer).toHaveBeenCalledTimes(1);
                expect(profiles.getTabActiveServerId()).toBe(company.id);
            });
            expect(profiles.getDeviceDefaultServerId()).toBe(previousDeviceDefault);

            await act(async () => {
                tree?.unmount();
            });
        } finally {
            for (const [key, descriptor] of [
                ['window', previousWindow],
                ['document', previousDocument],
                ['sessionStorage', previousSessionStorage],
            ] as const) {
                if (descriptor) Object.defineProperty(globalThis, key, descriptor);
                else delete webGlobals[key];
            }
            if (previousScope === undefined) {
                delete process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
            } else {
                process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = previousScope;
            }
        }
    });

    it('gives same-named Homes distinct accessible labels without adding visible row metadata', async () => {
        const previousScope = process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = `test_${Date.now()}_${Math.random().toString(16).slice(2)}`;

        try {
            (await import('@/sync/domains/server/serverProfiles')).resetServerProfilesRuntimeForTests();
            const profiles = await import('@/sync/domains/server/serverProfiles');
            const first = await profiles.upsertServerProfile({ serverUrl: 'https://first.example.test', name: 'Personal Home' });
            const second = await profiles.upsertServerProfile({ serverUrl: 'https://second.example.test', name: 'Personal Home' });
            machineListStatusState.byServerId = { [first.id]: 'idle', [second.id]: 'idle' };

            const ConnectionStatusControl = await importConnectionStatusControl();
            const screen = await renderScreen(React.createElement(ConnectionStatusControl, { variant: 'sidebar' }));
            const trigger = screen.findByProps({ accessibilityRole: 'button' });
            await act(async () => {
                await pressTestInstanceAsync(trigger);
            });

            const firstAction = findAction(`target-use-server-${first.id}`);
            const secondAction = findAction(`target-use-server-${second.id}`);
            expect(firstAction?.subtitle).toBe('connectionStatus.summary.connected');
            expect(secondAction?.subtitle).toBe('connectionStatus.summary.connected');
            expect(firstAction?.accessibilityLabel).not.toBe(secondAction?.accessibilityLabel);
            expect(firstAction?.accessibilityLabel).toContain('first.example.test');
            expect(secondAction?.accessibilityLabel).toContain('second.example.test');

            await act(async () => {
                screen.tree.unmount();
            });
        } finally {
            if (previousScope === undefined) delete process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
            else process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = previousScope;
        }
    });

    it('labels each Home target with only its own provable auth and connection facts', async () => {
        const previousScope = process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
        const scope = `test_${Date.now()}_${Math.random().toString(16).slice(2)}`;
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;

        try {
            (await import('@/sync/domains/server/serverProfiles')).resetServerProfilesRuntimeForTests();
            const profiles = await import('@/sync/domains/server/serverProfiles');
            const company = await profiles.upsertServerProfile({ serverUrl: 'https://company.example.test', name: 'Company' });
            const local = profiles.listServerProfiles().find((profile) => profile.id !== company.id)!;
            await profiles.setActiveServerId(local.id, { scope: 'device' });
            machineListStatusState.byServerId = { [company.id]: 'error' };
            tokenStorageMock.getCredentialsForServerUrl.mockImplementation(async (...args: unknown[]) => {
                const url = String(args[0] ?? '');
                return url.includes('company.example.test') ? null : { token: 'e30.eyJzdWIiOiJhY2NvdW50LWFkYSJ9.signature', secret: 'scoped-secret' };
            });
            credentialScopeState.resolutions.set(company.id, { kind: 'signed_out' });

            const ConnectionStatusControl = await importConnectionStatusControl();
            const screen = await renderScreen(React.createElement(ConnectionStatusControl, { variant: 'sidebar' }));

            const trigger = screen.findByProps({ accessibilityRole: 'button' });
            await act(async () => {
                await pressTestInstanceAsync(trigger);
            });
            const localAction = findAction(`target-use-server-${local.id}`);
            const companyAction = findAction(`target-use-server-${company.id}`);
            // The displayed Home's one line says what its machines are; a signed-out Home says so
            // and carries its Sign in inline. Neither claims more than its own facts.
            expect(localAction?.subtitle).toBe('accountPopover.noMachines');
            expect(localAction?.accessibilityLabel).toBe(`${local.name}, accountPopover.noMachines`);
            expect(localAction?.right).toBeUndefined();
            expect(companyAction?.subtitle).toBe('accountPopover.signedOut');
            expect(companyAction?.accessibilityLabel).toBe('Company, accountPopover.signedOut');
            // Sign in stays a labelled action (the quiet toolbar action), not a bordered pill.
            expect((companyAction?.right as React.ReactElement<{ label?: string }> | undefined)?.props.label).toBe('accountPopover.signIn');

            await act(async () => {
                screen.tree.unmount();
            });
        } finally {
            if (previousScope === undefined) delete process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
            else process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = previousScope;
        }
    });

    it('says a signed-in secondary Home cannot be reached from its projection error', async () => {
        const previousScope = process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = `test_${Date.now()}_${Math.random().toString(16).slice(2)}`;

        try {
            (await import('@/sync/domains/server/serverProfiles')).resetServerProfilesRuntimeForTests();
            const profiles = await import('@/sync/domains/server/serverProfiles');
            const secondary = await profiles.upsertServerProfile({ serverUrl: 'https://secondary.example.test', name: 'Secondary' });
            machineListStatusState.byServerId = { [secondary.id]: 'error' };

            const ConnectionStatusControl = await importConnectionStatusControl();
            const screen = await renderScreen(React.createElement(ConnectionStatusControl, { variant: 'sidebar' }));
            await act(async () => pressTestInstanceAsync(screen.findByProps({ accessibilityRole: 'button' })));
            expect(findAction(`target-use-server-${secondary.id}`)?.subtitle)
                .toBe('accountPopover.cantReach');
            // A retry reconnects only the Home this device is in; another Home offers none.
            expect(findAction(`target-use-server-${secondary.id}`)?.right).toBeUndefined();

            await act(async () => screen.tree.unmount());
        } finally {
            if (previousScope === undefined) delete process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
            else process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = previousScope;
        }
    });

    it('uses stable server identity ids for relay switch actions', async () => {
        const previousScope = process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
        const scope = `test_${Date.now()}_${Math.random().toString(16).slice(2)}`;
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;

        try {
            (await import('@/sync/domains/server/serverProfiles')).resetServerProfilesRuntimeForTests();
            const profiles = await import('@/sync/domains/server/serverProfiles');
            const company = await profiles.upsertServerProfile({ serverUrl: 'https://company.example.test', name: 'Company' });
            await profiles.setServerProfileIdentityForUrl(company.serverUrl, 'srv_identity_company');
            const ConnectionStatusControl = await importConnectionStatusControl();

            let tree: renderer.ReactTestRenderer | undefined;
            const screen = await renderScreen(React.createElement(ConnectionStatusControl, { variant: 'sidebar' }));
            tree = screen.tree;

            const trigger = screen.findByProps({ accessibilityRole: 'button' });
            await act(async () => {
                await pressTestInstanceAsync(trigger);
            });

            const companyItem = findAction('target-use-server-srv_identity_company');
            expect(companyItem).toBeTruthy();

            await act(async () => {
                companyItem?.onPress?.();
            });

            expect(connectionMocks.switchConnectionToActiveServer).toHaveBeenCalledTimes(1);
            expect(authMocks.refreshFromActiveServer).toHaveBeenCalledTimes(1);

            await act(async () => {
                tree?.unmount();
            });
        } finally {
            if (previousScope === undefined) {
                delete process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
            } else {
                process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = previousScope;
            }
        }
    });

    it('selects the active server row when saved target settings point at a previous server', async () => {
        const previousScope = process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
        const scope = `test_${Date.now()}_${Math.random().toString(16).slice(2)}`;
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;

        try {
            (await import('@/sync/domains/server/serverProfiles')).resetServerProfilesRuntimeForTests();
            const profiles = await import('@/sync/domains/server/serverProfiles');
            const company = await profiles.upsertServerProfile({ serverUrl: 'https://company.example.test', name: 'Company' });
            const defaultServer = profiles.listServerProfiles().find((profile) => profile.id !== company.id);
            expect(defaultServer).toBeTruthy();
            await profiles.setActiveServerId(company.id, { scope: 'device' });
            settingsState.serverSelectionActiveTargetKind = 'server';
            settingsState.serverSelectionActiveTargetId = defaultServer!.id;

            const ConnectionStatusControl = await importConnectionStatusControl();

            let tree: renderer.ReactTestRenderer | undefined;
            const screen = await renderScreen(React.createElement(ConnectionStatusControl, { variant: 'sidebar' }));
            tree = screen.tree;

            const trigger = screen.findByProps({ accessibilityRole: 'button' });
            await act(async () => {
                await pressTestInstanceAsync(trigger);
            });

            expect(findAction(`target-use-server-${defaultServer!.id}`)).toBeTruthy();
            expect(findAction(`target-use-server-${company.id}`)).toBeTruthy();

            await act(async () => {
                tree?.unmount();
            });
        } finally {
            if (previousScope === undefined) {
                delete process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
            } else {
                process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = previousScope;
            }
        }
    });

    it('starts target-specific sign-in directly for a signed-out Home', async () => {
        const previousScope = process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
        const scope = `test_${Date.now()}_${Math.random().toString(16).slice(2)}`;
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;

        try {
            (await import('@/sync/domains/server/serverProfiles')).resetServerProfilesRuntimeForTests();
            const profiles = await import('@/sync/domains/server/serverProfiles');
            const company = await profiles.upsertServerProfile({ serverUrl: 'https://company.example.test', name: 'Company' });
            tokenStorageMock.getCredentialsForServerUrl.mockImplementation(async (...args: unknown[]) => {
                const url = String(args[0] ?? '');
                if (url.includes('company.example.test')) return null;
                return { token: 'e30.eyJzdWIiOiJhY2NvdW50LWFkYSJ9.signature', secret: 'scoped-secret' };
            });
            credentialScopeState.resolutions.set(company.id, { kind: 'signed_out' });
            const ConnectionStatusControl = await importConnectionStatusControl();

            let tree: renderer.ReactTestRenderer | undefined;
            const screen = await renderScreen(React.createElement(ConnectionStatusControl, { variant: 'sidebar' }));
            tree = screen.tree;

            const trigger = screen.findByProps({ accessibilityRole: 'button' });
            await act(async () => {
                await pressTestInstanceAsync(trigger);
            });

            const companyItem = findAction(`target-use-server-${company.id}`);
            expect(companyItem).toBeTruthy();

            // The inline Sign in is the row's own fix: it starts the same target-specific sign-in.
            await pressRowButton(`target-use-server-${company.id}`);

            expect(modalMocks.confirm).not.toHaveBeenCalled();
            expect(connectionMocks.switchConnectionToActiveServer).toHaveBeenCalledTimes(1);
            expect(authMocks.refreshFromActiveServer).toHaveBeenCalledTimes(1);
            expect(routerMocks.replace).toHaveBeenCalledWith('/');

            await act(async () => {
                tree?.unmount();
            });
        } finally {
            if (previousScope === undefined) {
                delete process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
            } else {
                process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = previousScope;
            }
        }
    });

    it('activates the first credentialed group member through the primary switcher', async () => {
        const previousScope = process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
        const scope = `test_${Date.now()}_${Math.random().toString(16).slice(2)}`;
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;
        const webGlobals = globalThis as unknown as Record<string, unknown>;
        const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
        const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
        const previousSessionStorage = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
        const sessionValues = new Map<string, string>();
        Object.defineProperties(globalThis, {
            window: { configurable: true, value: {} },
            document: { configurable: true, value: { getElementById: () => null } },
            sessionStorage: {
                configurable: true,
                value: {
                    getItem: (key: string) => sessionValues.get(key) ?? null,
                    setItem: (key: string, value: string) => sessionValues.set(key, value),
                    removeItem: (key: string) => sessionValues.delete(key),
                },
            },
        });

        try {
            (await import('@/sync/domains/server/serverProfiles')).resetServerProfilesRuntimeForTests();
            const profiles = await import('@/sync/domains/server/serverProfiles');
            const selection = await import('@/sync/domains/server/selection/homeViewSelectionState');
            const local = await profiles.upsertServerProfile({ serverUrl: 'https://local.example.test', name: 'Local' });
            const signedOut = await profiles.upsertServerProfile({ serverUrl: 'https://signed-out.example.test', name: 'Signed out' });
            const credentialed = await profiles.upsertServerProfile({ serverUrl: 'https://credentialed.example.test', name: 'Credentialed' });
            await profiles.setActiveServerId(local.id, { scope: 'device' });

            settingsState.serverSelectionActiveTargetKind = 'server';
            settingsState.serverSelectionActiveTargetId = local.id;
            settingsState.serverSelectionGroups = [
                {
                    id: 'grp-one',
                    name: 'One',
                    serverIds: [signedOut.id, credentialed.id],
                    presentation: 'grouped',
                },
            ];
            await profiles.updateHomeViewState(() => ({
                version: 1,
                groups: settingsState.serverSelectionGroups,
                activeTargetKind: 'server',
                activeTargetId: local.id,
            }));

            tokenStorageMock.getCredentialsForServerUrl.mockImplementation(async (...args: unknown[]) => {
                const url = String(args[0] ?? '');
                if (url.includes('signed-out.example.test')) return null;
                return { token: 'e30.eyJzdWIiOiJhY2NvdW50LWFkYSJ9.signature', secret: 'scoped-secret' };
            });
            credentialScopeState.resolutions.set(signedOut.id, { kind: 'signed_out' });
            const ConnectionStatusControl = await importConnectionStatusControl();

            let tree: renderer.ReactTestRenderer | undefined;
            const screen = await renderScreen(React.createElement(ConnectionStatusControl, { variant: 'sidebar' }));
            tree = screen.tree;

            const trigger = screen.findByProps({ accessibilityRole: 'button' });
            await act(async () => {
                await pressTestInstanceAsync(trigger);
            });

            const groupItem = findAction('target-use-group-grp-one');
            expect(groupItem).toBeTruthy();

            await act(async () => {
                groupItem?.onPress?.();
            });

            expect(tokenStorageMock.getCredentialsForServerUrl).not.toHaveBeenCalled();
            expect(modalMocks.confirm).not.toHaveBeenCalled();
            await vi.waitFor(() => {
                expect(selection.loadEffectiveHomeViewState()?.activeTargetKind).toBe('group');
                expect(selection.loadEffectiveHomeViewState()?.activeTargetId).toBe('grp-one');
                expect(profiles.loadHomeViewState()?.activeTargetKind).toBe('server');
                expect(profiles.loadHomeViewState()?.activeTargetId).toBe(local.id);
                expect(profiles.getTabActiveServerId()).toBe(credentialed.id);
                expect(connectionMocks.switchConnectionToActiveServer).toHaveBeenCalledTimes(1);
                expect(authMocks.refreshFromActiveServer).toHaveBeenCalledTimes(1);
                expect(routerMocks.replace).not.toHaveBeenCalled();
            });

            await act(async () => {
                tree?.unmount();
            });
        } finally {
            for (const [key, descriptor] of [
                ['window', previousWindow],
                ['document', previousDocument],
                ['sessionStorage', previousSessionStorage],
            ] as const) {
                if (descriptor) Object.defineProperty(globalThis, key, descriptor);
                else delete webGlobals[key];
            }
            if (previousScope === undefined) {
                delete process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
            } else {
                process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = previousScope;
            }
        }
    });

    it('offers All Homes first once there are two usable Homes, and choosing it shows every Home together', async () => {
        // Prior profile-fixture resets clear subscriptions; rebuild the real credential-backed projection too.
        vi.resetModules();
        const previousScope = process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
        const scope = `test_${Date.now()}_${Math.random().toString(16).slice(2)}`;
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;
        const webGlobals = globalThis as unknown as Record<string, unknown>;
        const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
        const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
        const previousSessionStorage = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
        const sessionValues = new Map<string, string>();
        Object.defineProperties(globalThis, {
            window: { configurable: true, value: {} },
            document: { configurable: true, value: { getElementById: () => null } },
            sessionStorage: {
                configurable: true,
                value: {
                    getItem: (key: string) => sessionValues.get(key) ?? null,
                    setItem: (key: string, value: string) => sessionValues.set(key, value),
                    removeItem: (key: string) => sessionValues.delete(key),
                },
            },
        });

        try {
            (await import('@/sync/domains/server/serverProfiles')).resetServerProfilesRuntimeForTests();
            const profiles = await import('@/sync/domains/server/serverProfiles');
            const selection = await import('@/sync/domains/server/selection/homeViewSelectionState');
            const { ALL_HOMES_SELECTION_TARGET_ID } = await import('@/sync/domains/server/selection/allHomesSelectionTarget');
            const local = await profiles.upsertServerProfile({ serverUrl: 'https://local.example.test', name: 'Local' });
            const company = await profiles.upsertServerProfile({ serverUrl: 'https://company.example.test', name: 'Company' });
            await profiles.setActiveServerId(local.id, { scope: 'device' });
            connectionMocks.appliedServerId = local.id;
            settingsState.serverSelectionActiveTargetKind = 'server';
            settingsState.serverSelectionActiveTargetId = local.id;
            settingsState.serverSelectionGroups = [];
            await profiles.updateHomeViewState(() => ({
                version: 1,
                groups: [],
                activeTargetKind: 'server',
                activeTargetId: local.id,
            }));
            const ConnectionStatusControl = await importConnectionStatusControl();
            const { readUsableHomeServerIds } = await import('@/sync/domains/scope/usableHomeServerIds');
            await vi.waitFor(() => expect(readUsableHomeServerIds()).toEqual(expect.arrayContaining([local.id, company.id])));

            const screen = await renderScreen(React.createElement(ConnectionStatusControl, { variant: 'sidebar' }));
            const trigger = screen.findByProps({ accessibilityRole: 'button' });
            await act(async () => {
                await pressTestInstanceAsync(trigger);
            });

            const allHomesActionId = `target-use-group-${ALL_HOMES_SELECTION_TARGET_ID}`;
            const allHomes = findAction(allHomesActionId);
            expect(allHomes?.label).toBe('accountPopover.allHomes');
            expect(allHomes?.selected).toBe(false);
            const homeRowIds = getActions().map((action) => String(action.id)).filter((id) => id.startsWith('target-use-'));
            expect(homeRowIds[0]).toBe(allHomesActionId);

            await act(async () => {
                allHomes?.onPress?.();
            });

            await vi.waitFor(() => {
                expect(selection.loadEffectiveHomeViewState()).toMatchObject({
                    activeTargetKind: 'group',
                    activeTargetId: ALL_HOMES_SELECTION_TARGET_ID,
                });
            });

            await act(async () => {
                screen.tree.unmount();
            });
        } finally {
            for (const [key, descriptor] of [
                ['window', previousWindow],
                ['document', previousDocument],
                ['sessionStorage', previousSessionStorage],
            ] as const) {
                if (descriptor) Object.defineProperty(globalThis, key, descriptor);
                else delete webGlobals[key];
            }
            if (previousScope === undefined) {
                delete process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
            } else {
                process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = previousScope;
            }
        }
    });

    it('uses target action ids and does not expose legacy scope toggles', async () => {
        const previousScope = process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
        const scope = `test_${Date.now()}_${Math.random().toString(16).slice(2)}`;
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;

        try {
            (await import('@/sync/domains/server/serverProfiles')).resetServerProfilesRuntimeForTests();
            const { Platform } = await import('react-native');
            const previousPlatform = Platform.OS;
            (Platform as any).OS = 'web';
            const profiles = await import('@/sync/domains/server/serverProfiles');
            await profiles.upsertServerProfile({ serverUrl: 'https://company.example.test', name: 'Company' });
            const ConnectionStatusControl = await importConnectionStatusControl();

            let tree: renderer.ReactTestRenderer | undefined;
            const screen = await renderScreen(React.createElement(ConnectionStatusControl, { variant: 'sidebar' }));
            tree = screen.tree;

            const trigger = screen.findByProps({ accessibilityRole: 'button' });
            await act(async () => {
                await pressTestInstanceAsync(trigger);
            });

            const actionIds = new Set(
                getActions().flatMap((action) => typeof action.id === 'string' ? [action.id] : []),
            );
            expect(Array.from(actionIds).some((id) => id.startsWith('server-use-') && id.endsWith('-tab'))).toBe(false);
            expect(Array.from(actionIds).some((id) => id.startsWith('server-use-') && id.endsWith('-device'))).toBe(false);
            expect(Array.from(actionIds).some((id) => id.startsWith('target-use-server-'))).toBe(true);
            expect(Array.from(actionIds).some((id) => id === 'server-switch-tab')).toBe(false);
            expect(Array.from(actionIds).some((id) => id === 'server-switch-device')).toBe(false);
            expect(actionIds.has('connection-popover-manage-relay')).toBe(false);

            (Platform as any).OS = previousPlatform;

            await act(async () => {
                tree?.unmount();
            });
        } finally {
            if (previousScope === undefined) {
                delete process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
            } else {
                process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = previousScope;
            }
        }
    });

    it('shows a retry CTA and sanitized error text inside the popover for retryable connection failures', async () => {
        connectionState.syncError = { message: 'xhr poll error', retryable: true, kind: 'unknown', at: Date.now() };

        const ConnectionStatusControl = await importConnectionStatusControl();
        let tree: renderer.ReactTestRenderer | undefined;
        const screen = await renderScreen(React.createElement(ConnectionStatusControl, { variant: 'sidebar' }));
        tree = screen.tree;

        const trigger = screen.findByProps({ accessibilityRole: 'button' });
        await act(async () => {
            await pressTestInstanceAsync(trigger);
        });

        const right = findCurrentHomeAction()?.right as React.ReactElement<{ title?: string }> | undefined;
        // A failed Home offers an icon-only Retry: the refresh glyph with no chrome, named and explained.
        const { IconButton } = await import('@/components/ui/buttons/IconButton');
        const retry = await renderScreen(right as React.ReactElement);
        expect(retry.tree.root.findByType(IconButton).props).toMatchObject({
            iconName: 'arrow-clockwise',
            variant: 'plain',
            accessibilityLabel: 'common.retry',
            tooltip: 'common.retry',
        });
        await act(async () => retry.tree.unmount());

        await openStep('connection-details');

        const joined = screen.getTextContent();
        expect(joined).toContain('Connection error');
        expect(joined).not.toContain('xhr poll error');

        await act(async () => {
            tree?.unmount();
        });
    });

    it('shows a restore-account CTA inside the popover for auth failures', async () => {
        connectionState.syncError = { message: 'Forbidden', retryable: false, kind: 'auth', at: Date.now() };

        const ConnectionStatusControl = await importConnectionStatusControl();
        let tree: renderer.ReactTestRenderer | undefined;
        const screen = await renderScreen(React.createElement(ConnectionStatusControl, { variant: 'sidebar' }));
        tree = screen.tree;

        const trigger = screen.findByProps({ accessibilityRole: 'button' });
        await act(async () => {
            await pressTestInstanceAsync(trigger);
        });

        const right = findCurrentHomeAction()?.right as React.ReactElement<{ title?: string }> | undefined;
        expect((right as React.ReactElement<{ label?: string }> | undefined)?.props.label).toBe('accountPopover.signIn');

        await act(async () => {
            tree?.unmount();
        });
    });

    it('opens exact selected-Home recovery instead of the generic restore scanner', async () => {
        connectionState.syncError = { message: 'Forbidden', retryable: false, kind: 'auth', at: Date.now() };
        const profiles = await import('@/sync/domains/server/serverProfiles');
        const activeProfile = profiles.listServerProfiles().find((profile) => profile.name === 'Happier Cloud');
        if (!activeProfile) throw new Error('expected default Happier Cloud profile');

        const ConnectionStatusControl = await importConnectionStatusControl();
        const screen = await renderScreen(React.createElement(ConnectionStatusControl, { variant: 'sidebar' }));
        await act(async () => pressTestInstanceAsync(screen.findByProps({ accessibilityRole: 'button' })));
        await pressRowButton(String(findCurrentHomeAction()?.id));

        expect(routerMocks.push).toHaveBeenCalledWith({
            pathname: '/server',
            params: {
                recoveryProfile: activeProfile.id,
                recoveryReturnTo: '/',
            },
        });
        expect(routerMocks.push).not.toHaveBeenCalledWith('/restore');
        await act(async () => screen.tree?.unmount());
    });

    it('shows restore-account from endpoint authentication state even without a separate sync error', async () => {
        connectionState.syncError = null;
        connectionHealthState.kind = 'auth_required';
        connectionHealthState.endpointStatus = 'auth_failed';

        const ConnectionStatusControl = await importConnectionStatusControl();
        const screen = await renderScreen(React.createElement(ConnectionStatusControl, { variant: 'sidebar' }));
        await act(async () => pressTestInstanceAsync(screen.findByProps({ accessibilityRole: 'button' })));

        const current = findCurrentHomeAction();
        expect(current?.subtitle).toBe('accountPopover.signedOut');
        expect((current?.right as React.ReactElement<{ label?: string }> | undefined)?.props.label).toBe('accountPopover.signIn');
        await act(async () => screen.tree?.unmount());
    });

    it('answers Home identity, truthful status, and the applicable action in the first popover layer', async () => {
        connectionHealthState.kind = 'auth_required';
        connectionHealthState.endpointStatus = 'auth_failed';

        const ConnectionStatusControl = await importConnectionStatusControl();
        const screen = await renderScreen(React.createElement(ConnectionStatusControl, { variant: 'sidebar' }));
        await act(async () => pressTestInstanceAsync(screen.findByProps({ accessibilityRole: 'button' })));

        // No second layer: the Home, its state and its recovery are answered in its own row.
        const current = findCurrentHomeAction();
        expect(current?.label).toBe('Happier Cloud');
        expect(current?.subtitle).toBe('accountPopover.signedOut');
        await pressRowButton(String(current?.id));
        expect(routerMocks.push).toHaveBeenCalledWith(expect.objectContaining({ pathname: '/server' }));

        await act(async () => screen.tree?.unmount());
    });

    it('reports the Home as connected in the first layer while only machines need attention', async () => {
        connectionHealthState.kind = 'machine_offline';
        connectionHealthState.statusLabelKey = 'status.actionRequired';

        const ConnectionStatusControl = await importConnectionStatusControl();
        const screen = await renderScreen(React.createElement(ConnectionStatusControl, { variant: 'sidebar' }));
        await act(async () => pressTestInstanceAsync(screen.findByProps({ accessibilityRole: 'button' })));

        const current = findCurrentHomeAction();
        expect(current?.subtitle).not.toBe('accountPopover.cantReach');
        expect(current?.right).toBeUndefined();

        await act(async () => screen.tree?.unmount());
    });

    // S11 / R17: "no machines" is one sentence naming the signed-in account and the Home, with one
    // action — never a bare "Start a Happier session on your computer first" pill with no way on.
    it('explains an empty machine list in one sentence with setup as the one action', async () => {
        const ConnectionStatusControl = await importConnectionStatusControl();
        const screen = await renderScreen(React.createElement(ConnectionStatusControl, { variant: 'sidebar' }));
        await act(async () => pressTestInstanceAsync(screen.findByProps({ accessibilityRole: 'button' })));

        const message = screen.findByTestId('connection-popover-machine-guidance-message');
        expect(message).toBeTruthy();
        expect(screen.getTextContent()).toContain('machine.thisComputer.noComputers');
        expect(screen.getTextContent()).not.toContain('newSession.noMachinesFound');

        routerMocks.push.mockClear();
        await act(async () => pressTestInstanceAsync(screen.findByTestId('connection-popover-machine-guidance-action')));
        const { buildMachineAddHref } = await import('@/components/settings/machines/collection/machineCollectionModel');
        expect(routerMocks.push).toHaveBeenCalledWith(buildMachineAddHref({ path: 'thisComputer' }));

        await act(async () => screen.tree?.unmount());
    });

    it('reports an unavailable Home with a retry in the first layer', async () => {
        connectionHealthState.kind = 'server_unreachable';

        const ConnectionStatusControl = await importConnectionStatusControl();
        const screen = await renderScreen(React.createElement(ConnectionStatusControl, { variant: 'sidebar' }));
        await act(async () => pressTestInstanceAsync(screen.findByProps({ accessibilityRole: 'button' })));
        // Nothing has loaded from a Home that does not answer: no "no machines" guidance.
        expect(screen.findByTestId('connection-popover-machine-guidance')).toBeNull();

        expect(findCurrentHomeAction()?.subtitle).toBe('accountPopover.cantReach');
        await pressRowButton(String(findCurrentHomeAction()?.id));
        expect(connectionMocks.retryActiveServerConnection).toHaveBeenCalled();
        // Retry acts in place: the popover stays open and the row reports the outcome.
        expect(capture.popoverProps?.open).toBe(true);
        expect(screen.findByTestId('connection-popover-content')).toBeTruthy();

        await act(async () => screen.tree?.unmount());
    });

    it('keeps the collapsed trigger free of transport vocabulary', async () => {
        const ConnectionStatusControl = await importConnectionStatusControl();
        const screen = await renderScreen(React.createElement(ConnectionStatusControl, { variant: 'header' }));

        const trigger = screen.findByProps({ accessibilityRole: 'button' });
        const triggerLabel = String(trigger.props.accessibilityLabel);
        for (const transportTerm of ['iroh', 'relay', 'socket', 'https', 'direct', 'tunnel']) {
            expect(triggerLabel.toLowerCase()).not.toContain(transportTerm);
        }
        expect(triggerLabel).toContain('Happier Cloud');
        expect(triggerLabel).toContain('connectionStatus.summary.connected');
        expect(triggerLabel).not.toContain('status.actionRequired');

        await act(async () => screen.tree?.unmount());
    });

    it('opens the Account & Homes page from the phone/narrow header without mounting a popover', async () => {
        const ConnectionStatusControl = await importConnectionStatusControl();
        const screen = await renderScreen(React.createElement(ConnectionStatusControl, { variant: 'header' }));

        await act(async () => pressTestInstanceAsync(screen.findByProps({ accessibilityRole: 'button' })));

        expect(routerMocks.push).toHaveBeenCalledWith('/homes');
        expect(capture.popoverProps).toBeNull();
        expect(screen.findByTestId('connection-popover-content')).toBeNull();

        await act(async () => screen.tree?.unmount());
    });

    it('composes the same Home recovery and copyable Details semantics in the full-screen surface', async () => {
        connectionHealthState.kind = 'auth_required';
        connectionHealthState.endpointStatus = 'auth_failed';
        const profiles = await import('@/sync/domains/server/serverProfiles');
        const activeProfile = profiles.listServerProfiles().find((profile) => profile.name === 'Happier Cloud');
        if (!activeProfile) throw new Error('expected default Happier Cloud profile');
        irohDiagnosticsState.values = [{
            homeServerIdentityId: profiles.resolveServerProfileScopeId(activeProfile),
            remoteEndpointId: 'iroh-endpoint-123',
            state: 'connected',
            current: { carrier: 'iroh', observedPath: 'relay' },
        }];

        const ConnectionStatusControl = await importConnectionStatusControl();
        const screen = await renderScreen(React.createElement(ConnectionStatusControl, { variant: 'fullScreen' }));

        expect(screen.findByTestId('connection-status-full-screen')).toBeTruthy();
        // Embedded under the Homes page's "Connection details" row, it carries no title of its own.
        expect(screen.getTextContent()).not.toContain('connectionStatus.title');
        expect(screen.findByTestId('connection-popover-primary-action')).toBeTruthy();
        expect(screen.findByTestId('connection-details-disclosure')?.props.accessibilityState).toEqual({ expanded: false });

        await act(async () => pressTestInstanceAsync(screen.findByTestId('connection-details-disclosure')));

        expect(screen.findByTestId('connection-transport-diagnostics')).toBeTruthy();
        expect(screen.getTextContent()).toContain('iroh-endpoint-123');
        const copyButton = screen.findByTestId('connection-copy-diagnostics');
        expect(copyButton?.props.accessibilityRole).toBe('button');
        await act(async () => screen.tree?.unmount());
    });

    it('renders the same identity and Homes inline on the phone page, with steps in place', async () => {
        const ConnectionStatusControl = await importConnectionStatusControl();
        const screen = await renderScreen(React.createElement(ConnectionStatusControl, { variant: 'page' }));

        expect(capture.popoverProps).toBeNull();
        expect(screen.findByTestId('account-homes-page-content')).toBeTruthy();
        expect(findAction('account-identity')).toBeTruthy();
        expect(findCurrentHomeAction()?.label).toBe('Happier Cloud');
        expect(findAction('add-home-or-sign-in')).toBeTruthy();
        expect(findAction('manage-homes')).toBeTruthy();

        await openStep('connection-details');
        expect(findAction('details-back')).toBeTruthy();
        expect(screen.tree?.root.findAllByProps({ testID: 'connection-popover-realtime' }).length).toBeGreaterThan(0);

        await act(async () => screen.tree?.unmount());
    });

    it('retains the anchored popover on the desktop/sidebar surface', async () => {
        const ConnectionStatusControl = await importConnectionStatusControl();
        const screen = await renderScreen(React.createElement(ConnectionStatusControl, { variant: 'sidebar' }));

        await act(async () => pressTestInstanceAsync(screen.findByProps({ accessibilityRole: 'button' })));

        expect(routerMocks.push).not.toHaveBeenCalledWith('/server');
        expect(capture.popoverProps?.open).toBe(true);
        expect(screen.findByTestId('connection-popover-content')).toBeTruthy();

        await act(async () => screen.tree?.unmount());
    });

    it('presents browser Iroh as secure relay and refreshes open Details from the diagnostics owner', async () => {
        const profiles = await import('@/sync/domains/server/serverProfiles');
        const activeProfile = profiles.listServerProfiles().find((profile) => profile.name === 'Happier Cloud');
        if (!activeProfile) throw new Error('expected default Happier Cloud profile');
        const homeServerIdentityId = profiles.resolveServerProfileScopeId(activeProfile);
        irohDiagnosticsState.values = [{
            homeServerIdentityId,
            remoteEndpointId: 'browser-endpoint-123',
            state: 'connecting',
            effectiveConfiguration: {
                policy: 'automatic',
                relayUrls: ['https://relay.example.test'],
                directAddressCount: 0,
            },
            lastTransitionAtMs: 1_700_000_000_000,
        }];

        const ConnectionStatusControl = await importConnectionStatusControl();
        const screen = await renderScreen(React.createElement(ConnectionStatusControl, { variant: 'sidebar' }));
        await act(async () => pressTestInstanceAsync(screen.findByProps({ accessibilityRole: 'button' })));
        await openStep('connection-details');

        expect(screen.getTextContent()).toContain('browser-endpoint-123');
        expect(screen.getTextContent()).not.toContain('connectionStatus.labels.effectiveCarrier');
        expect(screen.getTextContent()).not.toContain('Iroh');
        expect(screen.getTextContent()).not.toContain('connectionStatus.labels.currentPath');
        expect(screen.getTextContent()).toContain('connectionStatus.labels.lastTransition');

        irohDiagnosticsState.values = [{
            ...irohDiagnosticsState.values[0],
            state: 'connected',
            current: { carrier: 'iroh', observedPath: 'relay' },
            lastKnown: { carrier: 'iroh', observedPath: 'relay' },
            lastTransitionAtMs: 1_700_000_001_000,
        }];
        irohDiagnosticsState.revision += 1;
        await act(async () => {
            for (const listener of irohDiagnosticsState.listeners) listener();
        });

        const joined = screen.getTextContent();
        expect(joined).toContain('Iroh · connectionStatus.values.pathRelay');
        expect(joined).not.toContain('connectionStatus.values.pathDirect');

        await act(async () => screen.tree?.unmount());
    });

    it('labels current and last-known transport paths without presenting stale facts as current', async () => {
        const profiles = await import('@/sync/domains/server/serverProfiles');
        const activeProfile = profiles.listServerProfiles().find((profile) => profile.name === 'Happier Cloud');
        if (!activeProfile) throw new Error('expected default Happier Cloud profile');
        irohDiagnosticsState.values = [{
            homeServerIdentityId: profiles.resolveServerProfileScopeId(activeProfile),
            state: 'reconnecting',
            lastKnown: { carrier: 'iroh', observedPath: 'relay' },
            lastTransitionAtMs: 1_700_000_001_000,
        }];

        const ConnectionStatusControl = await importConnectionStatusControl();
        const screen = await renderScreen(React.createElement(ConnectionStatusControl, { variant: 'sidebar' }));
        await act(async () => pressTestInstanceAsync(screen.findByProps({ accessibilityRole: 'button' })));
        await openStep('connection-details');

        const joined = screen.getTextContent();
        expect(joined).toContain('connectionStatus.labels.lastKnownPath');
        expect(joined).toContain('connectionStatus.values.pathRelay');
        expect(joined).not.toContain('connectionStatus.labels.currentPath');

        await act(async () => screen.tree?.unmount());
    });

    it('keeps retained Iroh diagnostics historical and non-retryable when the effective Home carrier is HTTPS', async () => {
        const profiles = await import('@/sync/domains/server/serverProfiles');
        const activeProfile = profiles.listServerProfiles().find((profile) => profile.name === 'Happier Cloud');
        if (!activeProfile) throw new Error('expected default Happier Cloud profile');
        const target = profiles.captureActiveServerRuntimeTarget();
        const leaseId = 'https-effective-carrier-for-history-label';
        expect(profiles.publishActiveServerRuntimeOrigin({
            target,
            leaseId,
            runtimeOrigin: 'https://runtime.example.test',
            carrier: 'https',
        })).toBe(true);
        irohDiagnosticsState.values = [{
            homeServerIdentityId: profiles.resolveServerProfileScopeId(activeProfile),
            state: 'unavailable',
            current: { carrier: 'iroh', observedPath: 'direct' },
            lastKnown: { carrier: 'iroh', observedPath: 'relay' },
        }];

        try {
            const ConnectionStatusControl = await importConnectionStatusControl();
            const screen = await renderScreen(React.createElement(ConnectionStatusControl, { variant: 'sidebar' }));
            await act(async () => pressTestInstanceAsync(screen.findByProps({ accessibilityRole: 'button' })));
            await openStep('connection-details');

            expect(screen.getTextContent()).toContain('systemStatus.transport.irohHistory');
            expect(screen.getTextContent()).not.toContain('systemStatus.transport.irohCurrent');
            expect(screen.getTextContent()).toContain('connectionStatus.labels.lastKnownPath');
            expect(screen.getTextContent()).not.toContain('connectionStatus.labels.currentPath');
            expect(screen.findByTestId('connection-popover-relay-retry')).toBeNull();

            const copyButton = screen.findByTestId('connection-copy-diagnostics');
            if (!copyButton) throw new Error('expected diagnostics copy action');
            await act(async () => pressTestInstanceAsync(copyButton));
            const copied = String(clipboardMock.setClipboardStringSafe.mock.calls.at(-1)?.[0] ?? '');
            expect(copied).toContain('connectionStatus.labels.lastKnownPath');
            expect(copied).not.toContain('connectionStatus.labels.currentPath');
            await act(async () => screen.tree?.unmount());
        } finally {
            profiles.releaseActiveServerRuntimeOrigin({ target, leaseId });
        }
    });

    it('keeps canonical and runtime origins with endpoint and relay diagnostics behind Details, with a copy affordance', async () => {
        const profiles = await import('@/sync/domains/server/serverProfiles');
        const activeProfile = profiles.listServerProfiles().find((profile) => profile.name === 'Happier Cloud');
        if (!activeProfile) throw new Error('expected default Happier Cloud profile');
        irohDiagnosticsState.values = [{
            homeServerIdentityId: profiles.resolveServerProfileScopeId(activeProfile),
            remoteEndpointId: 'iroh-endpoint-123',
            state: 'connected',
            current: { carrier: 'iroh', observedPath: 'direct' },
            lastKnown: { carrier: 'iroh', observedPath: 'direct' },
            effectiveConfiguration: {
                policy: 'automatic',
                relayUrls: ['https://relay.example.test', 'https://alice:relay-password@relay-2.example.test/path?token=query-secret'],
                relayUrlCount: 4,
                relayUrlsTruncated: true,
                directAddressCount: 2,
            },
            diagnosticError: {
                code: 'transport_stalled',
                message: 'no usable path\nAuthorization: Bearer bearer-secret\npassword:\nmultiline-secret',
                atMs: 1_700_000_000_000,
            },
        }];

        const ConnectionStatusControl = await importConnectionStatusControl();
        const screen = await renderScreen(React.createElement(ConnectionStatusControl, { variant: 'sidebar' }));
        await act(async () => pressTestInstanceAsync(screen.findByProps({ accessibilityRole: 'button' })));

        expect(screen.getTextContent()).not.toContain('connectionStatus.labels.endpointId');

        await openStep('connection-details');

        const joined = screen.getTextContent();
        expect(joined).toContain('connectionStatus.labels.canonicalAddress');
        expect(joined).toContain('connectionStatus.labels.endpointId');
        expect(joined).toContain('iroh-endpoint-123');
        expect(joined).toContain('connectionStatus.labels.currentPath');
        expect(joined).not.toContain('connectionStatus.labels.lastKnownPath');
        expect(joined).toContain('connectionStatus.values.pathDirect');
        expect(joined).toContain('connectionStatus.labels.relayConfiguration');
        expect(joined).toContain('relay.example.test');
        expect(joined).toContain('2/4');
        expect(joined).toContain('connectionStatus.labels.transportError');
        expect(joined).toContain('transport_stalled: no usable path');
        expect(joined).toContain('connectionStatus.labels.lastSync');
        for (const secret of ['alice', 'relay-password', 'query-secret', 'bearer-secret', 'multiline-secret']) {
            expect(joined).not.toContain(secret);
        }

        const copyButton = screen.findByTestId('connection-copy-diagnostics');
        if (!copyButton) throw new Error('expected diagnostics copy action');
        expect(copyButton.props.accessibilityRole).toBe('button');
        expect(copyButton.props.accessibilityLabel).toBe('connectionStatus.copyDiagnostics');
        await act(async () => pressTestInstanceAsync(copyButton));
        expect(clipboardMock.setClipboardStringSafe).toHaveBeenCalled();
        const copied = String(clipboardMock.setClipboardStringSafe.mock.calls.at(-1)?.[0] ?? '');
        expect(copied).toContain('iroh-endpoint-123');
        expect(copied).toContain('relay.example.test');
        expect(copied).toContain('no usable path');
        for (const secret of ['alice', 'relay-password', 'query-secret', 'bearer-secret', 'multiline-secret']) {
            expect(copied).not.toContain(secret);
        }
        expect(screen.getTextContent()).toContain('connectionStatus.diagnosticsCopied');
        const copiedButton = screen.findByTestId('connection-copy-diagnostics');
        if (!copiedButton) throw new Error('expected diagnostics copied action');
        expect(copiedButton.props.accessibilityLabel)
            .toBe('connectionStatus.diagnosticsCopied');

        await act(async () => screen.tree?.unmount());
    });

    it('reads current same-Home diagnostics on rerender instead of retaining the opening snapshot', async () => {
        const profiles = await import('@/sync/domains/server/serverProfiles');
        const activeProfile = profiles.listServerProfiles().find((profile) => profile.name === 'Happier Cloud');
        if (!activeProfile) throw new Error('expected default Happier Cloud profile');
        const homeServerIdentityId = profiles.resolveServerProfileScopeId(activeProfile);
        irohDiagnosticsState.values = [{
            homeServerIdentityId,
            remoteEndpointId: 'endpoint-before',
            state: 'connected',
        }];

        const ConnectionStatusControl = await importConnectionStatusControl();
        const element = React.createElement(ConnectionStatusControl, { variant: 'sidebar' });
        const screen = await renderScreen(element);
        await act(async () => pressTestInstanceAsync(screen.findByProps({ accessibilityRole: 'button' })));
        await openStep('connection-details');
        expect(screen.getTextContent()).toContain('endpoint-before');

        irohDiagnosticsState.values = [{
            homeServerIdentityId,
            remoteEndpointId: 'endpoint-after',
            state: 'connected',
        }];
        irohDiagnosticsState.revision += 1;
        await act(async () => screen.tree?.update(
            React.createElement(ConnectionStatusControl, { variant: 'sidebar', textSize: 13 }),
        ));

        expect(screen.getTextContent()).toContain('endpoint-after');
        expect(screen.getTextContent()).not.toContain('endpoint-before');
        await act(async () => screen.tree?.unmount());
    });

    it('omits Iroh transport history for a healthy HTTPS Home without Iroh diagnostics', async () => {
        connectionHealthState.kind = 'healthy';
        connectionHealthState.color = '#00ff00';
        connectionHealthState.statusLabelKey = 'status.connected';
        connectionHealthState.machineLabelKey = 'status.online';
        connectionHealthState.endpointStatus = 'idle';
        connectionHealthState.machineCount = 1;
        connectionHealthState.onlineCount = 1;
        connectionHealthState.primaryMachineLabel = 'mbp';
        connectionState.socketStatus = 'connected';

        const ConnectionStatusControl = await importConnectionStatusControl();
        let tree: renderer.ReactTestRenderer | undefined;
        const screen = await renderScreen(React.createElement(ConnectionStatusControl, { variant: 'sidebar' }));
        tree = screen.tree;

        const trigger = screen.findByProps({ accessibilityRole: 'button' });
        await act(async () => {
            await pressTestInstanceAsync(trigger);
        });

        await openStep('connection-details');

        const joined = screen.getTextContent();
        expect(joined).not.toContain('status.unknown');
        expect(joined.match(/status\.connected/g)?.length ?? 0).toBeGreaterThanOrEqual(1);
        expect(tree!.root.findAllByProps({ testID: 'connection-popover-relay' })).toHaveLength(0);

        await act(async () => {
            tree?.unmount();
        });
    });
});
