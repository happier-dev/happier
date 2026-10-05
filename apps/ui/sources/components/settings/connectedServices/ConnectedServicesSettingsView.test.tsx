import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectedServiceIdSchema } from '@happier-dev/protocol';
import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';
import type { ConnectedAccountIndexFacts } from './index/ConnectedAccountIndexRow';
import type { ConnectedServicesConnectMore } from './setup/ConnectedServicesConnectMore';
import type { IModal } from '@/modal';
import {
    connectedServicesModuleState,
    installConnectedServicesCommonModuleMocks,
} from './connectedServicesTestHelpers';


(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const modalAlertSpy = vi.hoisted(() => vi.fn((..._args: Parameters<IModal['alert']>) => undefined));

installConnectedServicesCommonModuleMocks({
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({ spies: { alert: modalAlertSpy } }).module;
    },
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: 'View',
            AppState: {
                currentState: 'active',
                addEventListener: vi.fn(() => ({ remove: vi.fn() })),
            },
            Platform: {
                OS: 'web',
                select: (options?: Readonly<{ default?: unknown }>) => (options && 'default' in options ? options.default : undefined),
            },
        });
    },
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

const profileState = vi.hoisted(() => ({
    activeAccountScope: null as null | { serverId: string; accountId: string },
    teamCredentialCatalog: {
        resources: [] as Array<Record<string, unknown>>,
        teamNameById: {} as Record<string, string>,
        homeNameByTeamId: {} as Record<string, string>,
        currentResourceKeys: new Set<string>(),
        current: true,
    },
    connectedServicesV2: [
        {
            serviceId: 'openai-codex',
            profiles: [{ profileId: 'work', status: 'connected', kind: 'oauth' }],
        },
    ] as Array<Record<string, unknown>>,
}));
const connectedServiceRegistryState = vi.hoisted(() => ({
    status: 'ready' as 'loading' | 'ready' | 'stale' | 'error' | 'conflict',
    errorReason: null as string | null,
    entries: [{
        serviceId: 'openai-codex',
        service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
        legacyServiceId: 'openai-codex',
        connectCommand: 'happier connect codex',
        supportsOauth: true,
        executable: true,
    }] as Array<Record<string, unknown>>,
}));
const serverFeaturesState = vi.hoisted(() => ({
    qualifiedAccounts: undefined as { protocolVersion: number } | undefined,
}));
const daemonAgentProjectionState = vi.hoisted(() => ({
    mergedProviderProjectionById: {} as Record<string, Record<string, unknown>>,
}));

const projectionReloadSpy = vi.hoisted(() => vi.fn());

vi.mock('@/components/appShell/plugins/AppShellPluginUiProjection', () => ({
    useAppShellPluginUiProjection: () => ({
        machineId: 'machine-a',
        serverId: 'server-1',
        reloadConnectedAccountProjection: projectionReloadSpy,
    }),
    useProjectedConnectedServicesRegistry: () => ({
        scopeKey: 'server-1', status: connectedServiceRegistryState.status,
        errorReason: connectedServiceRegistryState.errorReason, entries: connectedServiceRegistryState.entries,
    }),
    useProjectedPluginLocalizedTextResolver: () => (_pluginId: string, value: unknown) =>
        typeof value === 'string' ? value : '',
}));

vi.mock('@/agents/backendCatalog/useDaemonMergedProjectionInputs', () => ({
    useDaemonMergedProjectionInputs: () => ({
        phase: 'ready',
        inputs: {
            mergedProviderProjectionById: daemonAgentProjectionState.mergedProviderProjectionById,
            mergedBackendProjectionById: {},
        },
    }),
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => false,
}));

vi.mock('@/sync/domains/features/featureDecisionRuntime', () => ({
    useServerFeaturesRuntimeSnapshot: () => ({
        status: 'ready',
        features: {
            capabilities: {
                connectedServices: {
                    qualifiedAccounts: serverFeaturesState.qualifiedAccounts,
                },
            },
        },
    }),
}));

const machineState = vi.hoisted(() => ({
    machines: [] as Array<{ id: string; active: boolean; activeAt?: number; metadata?: { displayName?: string } }>,
}));

vi.mock('@/sync/store/hooks', () => ({
    useActiveServerAccountScope: () => profileState.activeAccountScope,
    useAllMachines: () => machineState.machines,
    useProfile: () => ({
        connectedServicesV2: profileState.connectedServicesV2,
    }),
    useSettings: () => ({
        connectedServicesDefaultProfileByServiceId: {},
        connectedServicesProfileLabelByKey: {},
        connectedServicesProviderStateSharingSettingsV1: {},
        connectedServicesDefaultAuthByAgentIdV1: {},
    }),
    useSettingMutable: () => [{}, vi.fn()],
    useSetting: () => undefined,
    useLocalSetting: () => undefined,
    useLocalSettingMutable: () => [undefined, vi.fn()],
}));

vi.mock('@/sync/store/settingsWriters', () => ({ useApplySettings: () => vi.fn() }));

vi.mock('@/hooks/teams/useHomeTeamCredentialModelCatalog', () => ({
    useHomeTeamCredentialModelCatalog: () => profileState.teamCredentialCatalog,
}));

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: ({ children }: { children?: React.ReactNode }) => React.createElement('ItemList', null, children),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children }: { children?: React.ReactNode }) => React.createElement('ItemGroup', null, children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: { rightElement?: React.ReactNode; leftElement?: React.ReactNode }) =>
        React.createElement('Item', props, props.leftElement, props.rightElement),
}));

// Account rows own their own quota reads (server requests); the index decides only which accounts it
// lists and what each row says, so a host stand-in keeps the row props assertable.
vi.mock('./index/ConnectedAccountIndexRow', async (importOriginal) => ({
    ...(await importOriginal<typeof import('./index/ConnectedAccountIndexRow')>()),
    ConnectedAccountIndexLiveFacts: ({ render }: { render: (facts: ConnectedAccountIndexFacts) => React.ReactElement }) => render({
        usage: { kind: 'none' }, planLabel: null, subscription: null, recoveryCredits: null,
        fetchedAt: null, staleSince: null, refreshing: false, refresh: null,
    }),
}));
// The setup panel runs the sign-in on a machine (daemon RPCs); the page decides where it opens and on what.
vi.mock('./setup/ConnectedServicesConnectMore', () => ({
    ConnectedServicesConnectMore: (props: React.ComponentProps<typeof ConnectedServicesConnectMore>) =>
        React.createElement('ConnectedServicesConnectMore', props),
}));

vi.mock('./ConnectedServicesDefaultAuthRow', () => ({
    ConnectedServicesDefaultAuthRow: (props: Record<string, unknown>) => React.createElement('ConnectedServicesDefaultAuthRow', props),
}));

vi.mock('./ConnectedServicesProviderStateSharingSettings', () => ({
    ConnectedServicesProviderStateSharingDisclosure: (props: Record<string, unknown>) => React.createElement('ConnectedServicesProviderStateSharingDisclosure', props),
}));

vi.mock('@/sync/domains/connectedServices/connectedServiceRegistry', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/domains/connectedServices/connectedServiceRegistry')>();
    return {
        ...actual,
        // Only the daemon projection is fixed; released identity adaptation stays real.
        getLegacyConnectedServiceRegistryEntry: (serviceId: string) =>
            connectedServiceRegistryState.entries.find((entry) => entry.legacyServiceId === serviceId)
            ?? actual.getLegacyConnectedServiceRegistryEntry(serviceId),
        getConnectedServiceRegistrySnapshot: () => ({
            scopeKey: 'server-1', status: connectedServiceRegistryState.status, errorReason: connectedServiceRegistryState.errorReason,
            entries: connectedServiceRegistryState.entries,
        }),
        installConnectedAccountDescriptorProjection: vi.fn(),
    };
});

vi.mock('@/hooks/server/connectedServices/useConnectedServiceQuotaBadges', () => ({
    useConnectedServiceQuotaBadges: () => ({}),
}));

vi.mock('@/hooks/server/connectedServices/useConnectedServiceQuotaSummaries', () => ({
    useConnectedServiceQuotaSummaries: () => ({
        summaries: [],
        accountsWithoutUsage: [],
        accountsNeedingSignIn: [],
        keysWithoutLimits: 0,
        inUseAccountKeys: new Set(),
        isRefreshing: false,
        hasConnectedProfiles: false,
    }),
}));
vi.mock('@/sync/domains/state/warmCachePersistence', () => ({
    loadUsageSummaryWarmCache: () => null,
    saveUsageSummaryWarmCache: () => {},
}));

describe('ConnectedServicesSettingsView', () => {
    beforeEach(() => {
        profileState.activeAccountScope = null;
        profileState.teamCredentialCatalog = {
            resources: [], teamNameById: {}, homeNameByTeamId: {}, currentResourceKeys: new Set(), current: true,
        };
        daemonAgentProjectionState.mergedProviderProjectionById = {
            codex: {
                agentId: 'codex',
                qualifiedId: 'happier.agent.codex/codex',
                identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
                catalogAgentId: 'codex',
                isBuiltIn: true,
                connectedAccounts: [{
                    purpose: 'primary',
                    service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
                    required: false,
                }],
            },
        };
        serverFeaturesState.qualifiedAccounts = undefined;
        connectedServiceRegistryState.status = 'ready';
        connectedServiceRegistryState.errorReason = null;
        connectedServiceRegistryState.entries = [{
            serviceId: 'openai-codex',
            service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
            legacyServiceId: 'openai-codex',
            connectCommand: 'happier connect codex',
            supportsOauth: true,
            executable: true,
        }];
        modalAlertSpy.mockClear();
        machineState.machines = [];
        connectedServicesModuleState.searchParams = {};
        connectedServicesModuleState.routerPushSpy.mockClear();
        connectedServicesModuleState.options.text = async () => {
            const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
            return createTextModuleMock({
                // Interpolated values stay visible so a test can see what a sentence names.
                translate: (key, params) => (params ? `${key} ${Object.values(params).join(' ')}` : key),
            });
        };
        profileState.connectedServicesV2 = [
            {
                serviceId: 'openai-codex',
                profiles: [{ profileId: 'work', status: 'connected', kind: 'oauth' }],
            },
        ];
    });

    it('opens a Team-shared Connected Service resource on its exact Home route', async () => {
        profileState.activeAccountScope = { serverId: 'server-1', accountId: 'account-1' };
        profileState.teamCredentialCatalog = {
            resources: [{
                id: 'resource-1', teamId: 'team-1', displayName: 'Shared GitHub', resourceRevision: 3,
                readiness: { kind: 'available' }, recoveryAction: null, deliveryMode: 'direct',
                mayBroker: false, mayReceiveDirect: true, directMaterialState: 'current',
                sessionUsePolicy: 'personal_allowed', providerModels: [],
                sourcePresentation: {
                    kind: 'connected_service', service: { pluginId: 'github', localId: 'github' },
                },
            }],
            teamNameById: { 'team-1': 'Acme' }, homeNameByTeamId: { 'team-1': 'Home A' },
            currentResourceKeys: new Set(['team-1:resource-1']), current: true,
        };
        const { ConnectedServicesSettingsView } = await import('./ConnectedServicesSettingsView');
        const screen = await renderScreen(<ConnectedServicesSettingsView />);

        await screen.pressByTestIdAsync('team-credential-catalog-resource:team-1:resource-1');
        expect(connectedServicesModuleState.routerPushSpy)
            .toHaveBeenCalledWith('/settings/teams/server-1/team-1/credentials/resource-1');
    });

    it('keeps boundary diagnostics out of the primary row and exposes only bounded product-safe support detail', async () => {
        const longDiagnostic = `unexpected-${'x'.repeat(512)}`;
        connectedServiceRegistryState.entries = [{
            serviceId: 'bitbucket', connectCommand: 'happier connect bitbucket', supportsOauth: false, supportsToken: false,
            service: { pluginId: 'happier.scm.forge.bitbucket', localId: 'bitbucket-account' },
            legacyServiceId: 'bitbucket',
            executable: false, projectedDescriptor: { id: 'account' }, projectedTitle: 'Bitbucket Cloud',
            projectionStatus: 'ready', availability: { state: 'blocked', reason: '/private/plugin/error' },
            diagnostics: ['missing_runtime', '/unexpected/path-shaped-diagnostic', 'token=never-render-this-primary', longDiagnostic],
        }];
        profileState.connectedServicesV2 = [];

        const { ConnectedServicesSettingsView } = await import('./ConnectedServicesSettingsView');
        const screen = await renderScreen(<ConnectedServicesSettingsView />);
        const row = screen.tree.findAllByType('Item' as never).find((item) => item.props.title === 'Bitbucket Cloud');

        expect(row).toBeTruthy();
        expect(row?.props.subtitle).toContain('common.blocked');
        expect(row?.props.subtitle).toContain('common.unavailable');
        expect(row?.props.subtitle).not.toContain('missing_runtime');
        expect(row?.props.subtitle).not.toContain('/private/plugin/error');
        expect(row?.props.subtitle).not.toContain('/unexpected/path-shaped-diagnostic');
        expect(row?.props.subtitle).not.toContain('token=never-render-this-primary');
        expect(row?.props.subtitle).not.toContain(longDiagnostic);

        const details = screen.tree.root.findByProps({
            testID: 'connected-services-index:happier.scm.forge.bitbucket/bitbucket-account:support-details',
        } as never);
        await pressTestInstanceAsync(details);
        const supportBody = String(modalAlertSpy.mock.calls[0]?.[1] ?? '');
        expect(supportBody).toContain('common.unavailable');
        expect(supportBody).toContain('connectedServices.errors.generic');
        expect(supportBody).not.toContain('missing_runtime');
        expect(supportBody).not.toContain('/private/plugin/error');
        expect(supportBody).not.toContain('/unexpected/path-shaped-diagnostic');
        expect(supportBody).not.toContain('token=never-render-this-primary');
        expect(supportBody).not.toContain(longDiagnostic);
        expect(supportBody.split('\n')).toEqual(['common.unavailable', 'connectedServices.errors.generic']);
    });

    it('keeps projection failure detail product-safe in the failure banner, and retries the read', async () => {
        connectedServiceRegistryState.status = 'error';
        connectedServiceRegistryState.errorReason = '/private/plugin/registry?token=never-render-this';
        connectedServiceRegistryState.entries = [];
        profileState.connectedServicesV2 = [];
        projectionReloadSpy.mockClear();

        const { ConnectedServicesSettingsView } = await import('./ConnectedServicesSettingsView');
        const screen = await renderScreen(<ConnectedServicesSettingsView />);
        const banner = screen.tree.root.findByProps({
            testID: 'connected-services-projection-error',
        } as never);

        // The banner shows the presented diagnostic, never the raw reason, anywhere on the page.
        expect(String(banner.props.description)).toContain('connectedServices.errors.generic');
        const leaked = screen.tree.root.findAll((node) => Object.values(node.props ?? {}).some((value) => (
            typeof value === 'string' && (value.includes('/private/plugin/registry') || value.includes('token=never-render-this'))
        )));
        expect(leaked).toHaveLength(0);

        await pressTestInstanceAsync(screen.tree.root.findByProps({
            testID: 'connected-services-projection-retry',
        } as never));
        expect(projectionReloadSpy).toHaveBeenCalledTimes(1);
    });

    it('says which machine offers no service and leads to Agents', async () => {
        connectedServiceRegistryState.status = 'ready';
        connectedServiceRegistryState.entries = [];
        profileState.connectedServicesV2 = [];
        machineState.machines = [{ id: 'machine-a', active: true, metadata: { displayName: 'lima-happier-fresh' } }];
        const { ConnectedServicesSettingsView } = await import('./ConnectedServicesSettingsView');
        const screen = await renderScreen(<ConnectedServicesSettingsView />);

        const empty = screen.tree.root.findAll((node) => node.props.testID === 'connected-services-empty')[0];
        expect(empty?.props.reason).toBe('connectedServicesSettings.emptyNoServiceOnMachine lima-happier-fresh');
        empty?.props.action?.onPress();
        expect(connectedServicesModuleState.routerPushSpy).toHaveBeenCalledWith('/(app)/settings/agents');
        machineState.machines = [];
    });

    it('asks for an online machine when none is, and leads to Machines', async () => {
        connectedServiceRegistryState.status = 'ready';
        connectedServiceRegistryState.entries = [];
        profileState.connectedServicesV2 = [];
        machineState.machines = [{ id: 'machine-a', active: false, metadata: { displayName: 'lima-happier-fresh' } }];
        const { ConnectedServicesSettingsView } = await import('./ConnectedServicesSettingsView');
        const screen = await renderScreen(<ConnectedServicesSettingsView />);

        const empty = screen.tree.root.findAll((node) => node.props.testID === 'connected-services-empty')[0];
        expect(empty?.props.reason).toBe('connectedServicesSettings.emptyNoMachineOnline');
        empty?.props.action?.onPress();
        expect(connectedServicesModuleState.routerPushSpy).toHaveBeenCalledWith('/(app)/settings/machines');
        machineState.machines = [];
    });

    it('renders first-run setup blocks when agents have services to connect', async () => {
        profileState.connectedServicesV2 = [];
        const { ConnectedServicesSettingsView } = await import('./ConnectedServicesSettingsView');

        const screen = await renderScreen(React.createElement(ConnectedServicesSettingsView));
        const tree = screen.tree;

        expect(tree.root.findAllByProps({ testID: 'connected-services-empty' } as never)).toHaveLength(0);
        const setup = tree.root.findByType('ConnectedServicesConnectMore' as never);
        expect(setup.props.layout).toBe('firstRun');
        expect(setup.props.model.connectable.map((service: { serviceKey: string }) => service.serviceKey))
            .toContain('happier.agent.codex/openai-codex');
        // Nothing navigated away: the setup is where the person asked.
        expect(connectedServicesModuleState.routerPushSpy).not.toHaveBeenCalled();
    });

    it.each([
        [{ connect: '1' }, { kind: 'catalog' }],
        [{ connect: '1', service: 'happier.agent.codex/openai-codex' }, {
            kind: 'service', serviceKey: 'happier.agent.codex/openai-codex',
        }],
    ])('opens a setup request from the collection deep link without navigating', async (params, request) => {
        connectedServicesModuleState.searchParams = params;
        const { ConnectedServicesSettingsView } = await import('./ConnectedServicesSettingsView');
        const { tree } = await renderScreen(<ConnectedServicesSettingsView />);
        const setup = tree.root.findByType('ConnectedServicesConnectMore' as never);

        expect(setup.props.request).toEqual(request);
        expect(connectedServicesModuleState.routerPushSpy).not.toHaveBeenCalled();
        await act(async () => setup.props.onRequestHandled());
        expect(tree.root.findByType('ConnectedServicesConnectMore' as never).props.request).toBeNull();
    });

    it('renders default-auth rows from the live qualified external Agent projection', async () => {
        daemonAgentProjectionState.mergedProviderProjectionById['acme.agent/native'] = {
            agentId: 'acme.agent/native',
            qualifiedId: 'acme.agent/native',
            identity: { pluginId: 'acme.agent', localId: 'native' },
            title: 'Acme Native',
            isBuiltIn: false,
            connectedAccounts: [{
                purpose: 'primary',
                service: { pluginId: 'acme.agent', localId: 'account' },
                required: false,
            }],
        };
        const { ConnectedServicesAgentSignInView } = await import('./collection/ConnectedServicesAgentSignInView');

        const tree = (await renderScreen(<ConnectedServicesAgentSignInView />)).tree;
        const row = tree.root.findAllByType('ConnectedServicesDefaultAuthRow' as never)
            .find((candidate) => candidate.props.agentId === 'acme.agent/native');

        expect(row?.props.agentTitle).toBe('Acme Native');
        expect(row?.props.connectedAccountServiceKeys).toEqual(['acme.agent/account']);
    });

    it('threads the current Team resource catalog into the sole default-auth row', async () => {
        const resource = {
            id: 'resource-1',
            teamId: 'team-1',
            displayName: 'Shared Codex',
            resourceRevision: 3,
            readiness: { kind: 'available' },
            recoveryAction: null,
            connectedServiceSelections: [{
                source: 'team_resource', resourceId: 'resource-1', deliveryMode: 'brokered',
            }],
            sourcePresentation: {
                kind: 'connected_service',
                service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
            },
        };
        profileState.activeAccountScope = { serverId: 'server-1', accountId: 'account-1' };
        profileState.teamCredentialCatalog = {
            resources: [resource],
            teamNameById: { 'team-1': 'Acme' },
            homeNameByTeamId: { 'team-1': 'Home A' },
            currentResourceKeys: new Set(['team-1:resource-1']),
            current: true,
        };
        const { ConnectedServicesAgentSignInView } = await import('./collection/ConnectedServicesAgentSignInView');
        const tree = (await renderScreen(<ConnectedServicesAgentSignInView />)).tree;
        const row = tree.root.findAllByType('ConnectedServicesDefaultAuthRow' as never)
            .find((candidate) => candidate.props.agentId === 'codex');

        expect(row?.props).toMatchObject({
            teamCredentialResources: [resource],
            teamNameById: { 'team-1': 'Acme' },
        });
        expect(row?.props.currentTeamCredentialResourceKeys).toEqual(new Set(['team-1:resource-1']));
    });

    it('lets search reach the per-agent default sign-in rows through the first of them', async () => {
        const { ConnectedServicesAgentSignInView } = await import('./collection/ConnectedServicesAgentSignInView');
        const { CONNECTED_SERVICES_SETTINGS } = await import('./connectedServicesSettings');

        const tree = (await renderScreen(<ConnectedServicesAgentSignInView />)).tree;
        const rows = tree.root.findAllByType('ConnectedServicesDefaultAuthRow' as never);

        expect(rows[0]?.props.setting?.anchor).toBe(CONNECTED_SERVICES_SETTINGS.settings.agentDefaults.anchor);
        expect(rows.slice(1).every((row) => row.props.setting === undefined)).toBe(true);
    });

    it('preserves the released bundled Agent routing id as the default-auth settings key', async () => {
        const { ConnectedServicesAgentSignInView } = await import('./collection/ConnectedServicesAgentSignInView');

        const tree = (await renderScreen(<ConnectedServicesAgentSignInView />)).tree;
        const agentIds = tree.root.findAllByType('ConnectedServicesDefaultAuthRow' as never)
            .map((candidate) => candidate.props.agentId);

        expect(agentIds).toContain('codex');
        expect(agentIds).not.toContain('happier.agent.codex/codex');
    });

    it('does not route a default-auth connect action without an executable projected service owner', async () => {
        connectedServiceRegistryState.entries = [];
        profileState.connectedServicesV2 = [];
        const { ConnectedServicesAgentSignInView } = await import('./collection/ConnectedServicesAgentSignInView');
        const tree = (await renderScreen(<ConnectedServicesAgentSignInView />)).tree;

        await tree.root
            .findAllByType('ConnectedServicesDefaultAuthRow' as never)[0]
            .props.onOpenConnectedServicesSettings('not-a-released-service');

        expect(connectedServicesModuleState.routerPushSpy).not.toHaveBeenCalled();
        expect(modalAlertSpy).toHaveBeenCalledWith(
            'errors.daemonUnavailableTitle',
            'errors.daemonUnavailableBody',
        );
    });

    it('routes a default-auth connect action through its exact projected qualified owner', async () => {
        connectedServiceRegistryState.entries = [{
            serviceId: 'openai-codex',
            service: {
                pluginId: 'happier.agent.codex',
                localId: 'openai-codex',
            },
            legacyServiceId: 'openai-codex',
            connectCommand: 'happier connect openai-codex',
            supportsOauth: true,
            executable: true,
        }];
        profileState.connectedServicesV2 = [];
        const { ConnectedServicesAgentSignInView } = await import('./collection/ConnectedServicesAgentSignInView');
        const tree = (await renderScreen(<ConnectedServicesAgentSignInView />)).tree;

        await tree.root
            .findAllByType('ConnectedServicesDefaultAuthRow' as never)[0]
            .props.onOpenConnectedServicesSettings('openai-codex');

        expect(modalAlertSpy).not.toHaveBeenCalled();
        expect(connectedServicesModuleState.routerPushSpy).toHaveBeenCalledWith({
            pathname: '/(app)/settings/connected-services',
            params: {
                connect: '1',
                service: 'happier.agent.codex/openai-codex',
            },
        });
    });

    it('routes a released legacy fallback through its generated exact identity', async () => {
        connectedServiceRegistryState.entries = [];
        profileState.connectedServicesV2 = [];
        const { ConnectedServicesAgentSignInView } = await import('./collection/ConnectedServicesAgentSignInView');
        const tree = (await renderScreen(<ConnectedServicesAgentSignInView />)).tree;

        await tree.root
            .findAllByType('ConnectedServicesDefaultAuthRow' as never)[0]
            .props.onOpenConnectedServicesSettings('openai-codex');

        expect(modalAlertSpy).not.toHaveBeenCalled();
        expect(connectedServicesModuleState.routerPushSpy).toHaveBeenCalledWith({
            pathname: '/(app)/settings/connected-services',
            params: {
                connect: '1',
                service: 'happier.agent.codex/openai-codex',
            },
        });
    });

    it('renders a released V2 profile through the generated adapter without making a scalar row owner', async () => {
        connectedServiceRegistryState.entries = [];
        profileState.connectedServicesV2 = [{
            serviceId: 'openai-codex',
            profiles: [{ profileId: 'work', status: 'connected', kind: 'oauth' }],
        }];
        const { ConnectedServicesSettingsView } = await import('./ConnectedServicesSettingsView');
        const tree = (await renderScreen(<ConnectedServicesSettingsView />)).tree;
        const rows = tree.root.findAll((node) => node.props.facts && node.props.accountId);
        expect(rows.map((row) => row.props.accountId)).toEqual(['work']);
        await tree.pressByTestIdAsync('connected-services-account:happier.agent.codex/openai-codex:work');
        expect(connectedServicesModuleState.routerPushSpy).toHaveBeenCalledWith({
            pathname: '/(app)/settings/connected-services/account',
            params: {
                pluginId: 'happier.agent.codex',
                localId: 'openai-codex',
                accountId: 'work',
            },
        });
    });

    it('keeps built-in and projected Connected Accounts available when the retired master feature is disabled', async () => {
        // A novel descriptor has no scalar compatibility authority. It is
        // visible once the server advertises the qualified V4 contract, while
        // the built-in row remains available through its generated adapter.
        serverFeaturesState.qualifiedAccounts = { protocolVersion: 4 };
        profileState.connectedServicesV2 = [];
        connectedServiceRegistryState.entries = [
            {
                serviceId: 'openai-codex',
                service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
                legacyServiceId: 'openai-codex',
                connectCommand: 'happier connect codex',
                supportsOauth: true,
                executable: true,
                displayNameKey: 'connectedServices.names.openaiCodex',
            },
            {
                serviceId: 'vault',
                service: { pluginId: 'acme.connected-accounts-conformance', localId: 'vault' },
                connectCommand: 'happier connect acme.connected-accounts-conformance/vault',
                supportsOauth: true,
                executable: true,
                projectedDescriptor: { id: 'vault' },
                projectedTitle: 'Acme Vault',
            },
        ];

        const { ConnectedServicesSettingsView } = await import('./ConnectedServicesSettingsView');
        const screen = await renderScreen(<ConnectedServicesSettingsView />);
        const panel = screen.tree.root.findByType('ConnectedServicesConnectMore' as never);

        // Both the built-in service and the novel qualified descriptor can be added from the catalog,
        // each by its exact qualified identity (never a scalar id).
        expect(ConnectedServiceIdSchema.safeParse('vault').success).toBe(false);
        expect(panel.props.model.connectable.map((entry: { serviceKey: string }) => entry.serviceKey))
            .toEqual(expect.arrayContaining([
                'acme.connected-accounts-conformance/vault',
                'happier.agent.codex/openai-codex',
            ]));
    });

    it('lists every account of a released legacy service, the one needing a new sign-in first', async () => {
        profileState.connectedServicesV2 = [
            {
                serviceId: 'openai-codex',
                profiles: [
                    { profileId: 'connected', status: 'connected', kind: 'oauth' },
                    { profileId: 'retryable', status: 'refresh_failed_retryable', kind: 'oauth' },
                    { profileId: 'reauth', status: 'needs_reauth', kind: 'oauth' },
                ],
            },
        ];
        const { ConnectedServicesSettingsView } = await import('./ConnectedServicesSettingsView');

        const tree = (await renderScreen(React.createElement(ConnectedServicesSettingsView))).tree;

        const rows = tree.root.findAll((node) => node.props.facts && node.props.accountId);
        expect(rows.map((row) => row.props.accountId)).toEqual(['reauth', 'retryable', 'connected']);
        // The fix sits on the account that needs it, not in the service's header.
        expect(rows.map((row) => row.props.signedOut !== null)).toEqual([true, false, false]);
    });
});
