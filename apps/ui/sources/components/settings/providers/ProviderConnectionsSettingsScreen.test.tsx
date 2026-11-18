import * as React from 'react';
import { CollectionDraftTitleScope, useCollectionDraftTitle } from '@/components/ui/lists/collection/CollectionDraftTitle';

import { createProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    createProviderConnectionViewFixture,
    createProviderConnectionsDescribeFixture,
    createProviderSettingsHarness,
    createProviderSettingsAccountHarness,
    installProviderSettingsRpcBoundary,
    installBundledProviderDeclarationsRpcBoundary,
    installProviderConnectionsCatalogHttpBoundary,
} from '@/dev/testkit/harness/providerSettingsHarness';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { measureMountedCollections, renderInCollectionLayout } from '@/dev/testkit/render/renderInCollectionLayout';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { act } from '@/dev/testkit';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { answerTeamCredentialDiscoveryForTests, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { teamCapabilitiesFixture, teamSummaryFixture } from '@/dev/testkit/fixtures/teamFixtures';
import { TEAM_DIRECTORY_PAGE_LIMIT_DEFAULT_V1, TeamCredentialResourceDiscoveryPageV1Schema } from '@happier-dev/protocol/teams';
import { bindHomeDomainActionHttpRequestV1 } from '@happier-dev/protocol/actions/homeDomainActionFamily';
import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';
import { clearActiveUnsavedChangesGuard, setActiveUnsavedChangesGuard } from '@/utils/navigation/runGuardedNavigation';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { ProviderConnectionV1Schema } from '@happier-dev/protocol/providers/connections/v1';
import {
    DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
    PROVIDER_CONNECTIONS_ROWS_ROUTE_V1,
    ProviderConnectionsCatalogV1Schema,
} from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { createAccountProviderActionExecuteV1 } from '@happier-dev/protocol/providers/connections/accountProviderActionV1';
import { parseProviderActionRequestV1 } from '@happier-dev/protocol/providers/providerActionsV1';
import { serializeModelVisibilityRefV1 } from '@happier-dev/protocol/providers/model-selection';
import {
    buildCustomProviderTemplate,
    createCustomProviderDraft,
} from '@/providers/authoring/state';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';

function providerErrorState(screen: Awaited<ReturnType<typeof renderScreen>>, code?: string) {
    return screen.findAll((node) => (code ? node.props.testID === `provider-error:${code}`
        : node.props.testID?.startsWith('provider-error:')) && 'kind' in node.props)[0];
}

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const state = vi.hoisted(() => ({
    // Reply/error/deferred transport input; the production query and reducer stay real.
    describeReply: null as null | Record<string, unknown>,
    teamCredentialCatalog: {
        resources: [] as Array<Record<string, unknown>>,
        teamNameById: {} as Record<string, string>,
        homeNameByTeamId: {} as Record<string, string>,
        resourceStatusByKey: new Map(),
        current: true,
        condition: null,
    },
}));
const run = vi.hoisted(() => vi.fn());
const routerPush = vi.hoisted(() => vi.fn());
const routerReplace = vi.hoisted(() => vi.fn());
const navigationState = vi.hoisted(() => ({
    focusEffects: [] as Array<() => void | (() => void)>,
    pathname: '/settings/providers',
    params: {} as Record<string, string>,
    navigatorMounts: 0,
    focused: true,
    focusListeners: new Set<() => void>(),
}));
const providerHarness = createProviderSettingsHarness();
const providerConnectionReads = () => providerHarness.state.requests.filter(
    request => request.method === RPC_METHODS.DAEMON_PROVIDERS_CONNECTIONS_DESCRIBE,
);
installProviderSettingsRpcBoundary(providerHarness);
const account = createProviderSettingsAccountHarness();
let machine = createMachineFixture({ id: 'machine-a', kind: 'persistent', activeAt: Date.now(), metadata: {
    host: 'mac.local', platform: 'darwin', displayName: 'Mac', happyCliVersion: 'test',
    happyHomeDir: '/Users/tester/.happy', homeDir: '/Users/tester',
} });
// The composed layout must exercise the real target control, including unavailable states.
vi.doUnmock('@/components/settings/machines/MachineAdministrationTargetSelector');

/** The Connect action of a found local server's row. */
function findConnectAction(screen: Awaited<ReturnType<typeof renderScreen>>, title: string) {
    return screen.findAllByType(Item).find((item) => item.props.title === title)?.props.rightElement as
        | { props: { onPress?: () => unknown; accessibilityLabel?: string } }
        | undefined;
}

function findConnectionRow(screen: Awaited<ReturnType<typeof renderScreen>>, connectionId: string) {
    return screen.findAllByType(Item).find(item => item.props.testID === `settings-provider-connection:${connectionId}`) ?? null;
}

function createDeferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((next) => { resolve = next; });
    return { promise, resolve };
}

installSettingsViewCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            useWindowDimensions: () => ({ width: 1200, height: 800, scale: 1, fontScale: 1 }),
        });
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        const router = createExpoRouterMock({
            pathname: () => navigationState.pathname,
            params: () => navigationState.params,
            router: { push: routerPush, replace: routerReplace },
        });
        // Expo owns route mounting. A stateful boundary exposes unwanted navigator remounts.
        const Stack = Object.assign(function Stack() {
            const [draft, setDraft] = React.useState('');
            React.useEffect(() => { navigationState.navigatorMounts += 1; }, []);
            return React.createElement('ProviderDraft', { testID: 'provider-draft', value: draft, onChangeText: setDraft });
        }, { Screen: router.module.Stack.Screen });
        return { ...router.module, Stack };
    },
    storage: 'real',
});

vi.mock('@/components/ui/popover', async (importOriginal) => {
    const { createInlinePopoverModuleMock } = await import('@/dev/testkit/mocks/popover');
    return createInlinePopoverModuleMock(importOriginal);
});

vi.mock('@react-navigation/native', async () => {
    const ReactModule = await import('react');
    const { createReactNavigationNativeMock } = await import('@/dev/testkit/mocks/reactNavigation');
    return {
        ...createReactNavigationNativeMock(),
        useIsFocused: () => ReactModule.useSyncExternalStore(
            (listener) => {
                navigationState.focusListeners.add(listener);
                return () => navigationState.focusListeners.delete(listener);
            },
            () => navigationState.focused,
        ),
        useFocusEffect: (effect: () => void | (() => void)) => {
            ReactModule.useEffect(() => {
                navigationState.focusEffects.push(effect);
                const cleanup = effect();
                return () => {
                    navigationState.focusEffects = navigationState.focusEffects.filter(
                        (registered) => registered !== effect,
                    );
                    if (typeof cleanup === 'function') cleanup();
                };
            }, [effect]);
        },
    };
});

/** The rendered component that carries `prop` for a test id (the host view under it carries none). */
function findComposite(screen: Awaited<ReturnType<typeof renderScreen>>, testID: string, prop: string) {
    return screen.findAllByTestId(testID).find((node) => node.props[prop] !== undefined) ?? null;
}

await loadSyncSingletonForTests();
// Install transport leaves before loading the screen; cold compilation is collection work.
await import('./ProviderConnectionsSettingsScreen');
await import('@/app/(app)/settings/providers/new');
const [{ Item }, { Switch }] = await Promise.all([
    import('@/components/ui/lists/Item'), import('@/components/ui/forms/Switch'),
]);

function DraftTitlePublisher(props: Readonly<{ title: string }>) {
    const titles = useCollectionDraftTitle();
    React.useEffect(() => { titles.publish(props.title); }, [props.title, titles]);
    return null;
}

/** The modal portal is a platform boundary; its real shared body and domain hooks remain mounted. */
async function openProviderPicker(screen: Awaited<ReturnType<typeof renderScreen>>, trigger = 'settings-providers-add') {
    const { Modal } = await import('@/modal');
    vi.mocked(Modal.show).mockClear();
    await screen.pressByTestIdAsync(trigger);
    expect(Modal.show).toHaveBeenCalled();
    const opened = vi.mocked(Modal.show).mock.calls.at(-1)![0];
    const onClose = vi.fn();
    const modal = await renderScreen(React.createElement(opened.component, { ...opened.props, onClose }));
    const { CapabilityAddModalBody } = await import('@/components/capabilities/add/CapabilityAddModal');
    const config = () => modal.findByType(CapabilityAddModalBody).props.config;
    await waitForHomeGovernance(() => expect(config().catalog.items.length).toBeGreaterThan(0));
    await measureMountedCollections(modal);
    const select = async (key: string) => {
        const collection = modal.findAll(node => node.props.testID === 'providers.add:collection'
            && typeof node.props.model?.actions?.open === 'function')[0]!;
        await React.act(async () => collection.props.model.actions.open(key));
    };
    return { modal, config, select, onClose };
}

/** A phone's page lists found model servers behind the shared "On machines" view, as the rail does. */
async function showFound(screen: Awaited<ReturnType<typeof renderScreen>>) {
    await waitForHomeGovernance(() => expect(providerConnectionReads().length).toBeGreaterThan(0));
    await flushHookEffects();
    const found = screen.findAll((node) => node.props?.testID === 'settings-providers-view:found' && typeof node.props.onPress === 'function')[0];
    if (found) await React.act(async () => { found.props.onPress(); });
}

describe('ProviderConnectionsSettingsScreen', () => {
    afterEach(async () => {
        clearActiveUnsavedChangesGuard();
        standardCleanup();
        vi.unstubAllGlobals();
        await account.reset();
    });
    beforeEach(async ({ task }) => {
        providerHarness.reset();
        machine = createMachineFixture({ ...machine, activeAt: Date.now() });


        run.mockReset();
        routerPush.mockReset();
        routerReplace.mockReset();
        navigationState.focusEffects = [];
        navigationState.pathname = '/settings/providers';
        navigationState.params = {};
        navigationState.navigatorMounts = 0;
        navigationState.focused = true;
        navigationState.focusListeners.clear();
        state.teamCredentialCatalog = {
            resources: [], teamNameById: {}, homeNameByTeamId: {}, resourceStatusByKey: new Map(), current: true, condition: null,
        };
        state.describeReply = {
            loading: false, error: null,
            data: createProviderConnectionsDescribeFixture({
                connections: [createProviderConnectionViewFixture({
                    contributionKey: 'plugin/acme',
                    displayName: 'Acme',
                    providerName: 'Acme',
                    runtime: { health: 'available', modelCount: 3, checkedAt: 1, endpoints: [] },
                })],
                available: [{
                    contributionKey: 'plugin/other', name: 'Other', kind: 'cloud', provenance: 'external',
                    icon: null, credential: null, endpointTemplates: [],
                }],
            }),
        };
        await account.restore({ serverIdentityId: 'srv_provider_list', machines: [machine], waivedActions: task.name.startsWith('reviews a detected Provider') ? [] : [
            'providers.connections.enable_detected', 'providers.connections.start_local',
        ], features: createRootLayoutFeaturesResponse({ features: {
            providers: { enabled: true, localDiscovery: { enabled: true }, localModelManagement: { enabled: true } },
            localServices: { enabled: true, inventory: { enabled: true } },
        } }) });
        await account.home.selectHomes([account.serverId]);
        await account.selectMachine(account.serverId, 'machine-a');
        providerHarness.intercept(RPC_METHODS.DAEMON_PROVIDERS_CONNECTIONS_DESCRIBE, async () => {
            const query = state.describeReply as {
                loading?: boolean;
                error?: ReturnType<typeof createProviderErrorV1> | null;
                data?: ReturnType<typeof createProviderConnectionsDescribeFixture> | null;
            } | null;
            if (query?.loading && !query.data) return await new Promise<never>(() => undefined);
            if (query?.error) return { status: 'error', error: query.error };
            return query?.data ?? createProviderConnectionsDescribeFixture({ connections: [] });
        });
        providerHarness.intercept(RPC_METHODS.DAEMON_PROVIDERS_CONNECTION_MUTATE, async (request, next) => {
            const payload = request.payload as { action?: string; connectionId?: string; contributionKey?: string; candidateId?: string };
            const query = state.describeReply as { data?: { discoveryCandidates?: Array<{ candidateId?: string; contributionKey?: string; normalizedEndpointUrl?: string }> } } | null;
            const candidate = query?.data?.discoveryCandidates?.find((entry) => entry.candidateId === payload.candidateId);
            const key = payload.action === 'enableDetected'
                ? `detected:${candidate?.contributionKey}:${candidate?.normalizedEndpointUrl}`
                : payload.action === 'startLocal'
                    ? `start:${payload.contributionKey}`
                    : payload.connectionId;
            const observed = await run(payload, key);
            return observed ?? await next();
        });
    });

    it('opens a Team-provided Provider resource on its exact Home route', async () => {
        state.teamCredentialCatalog = {
            resources: [{
                id: 'resource-1', teamId: 'team-1', displayName: 'Shared OpenRouter', resourceRevision: 3,
                readiness: { kind: 'available' }, recoveryAction: null,
                mayBroker: true, mayReceiveDirect: false, directMaterialState: 'never_delivered',
                sessionUsePolicy: 'personal_allowed', providerModels: [],
                sourcePresentation: {
                    kind: 'provider',
                    provider: { identity: { pluginId: 'happier.provider.openrouter', localId: 'openrouter' }, definitionRevision: 1 },
                },
            }],
            teamNameById: { 'team-1': 'Acme' }, homeNameByTeamId: { 'team-1': 'Home A' },
            resourceStatusByKey: new Map([['team-1:resource-1', { kind: 'current' as const }]]), current: true, condition: null,
        };
        const teams = bindHomeDomainActionHttpRequestV1('teams.list', { v: 1, scope: 'member', archived: 'active',
            limit: TEAM_DIRECTORY_PAGE_LIMIT_DEFAULT_V1, cursor: null });
        account.home.answer(account.serverId, teams.path, { body: { items: [teamSummaryFixture({ name: 'Acme',
            capabilities: teamCapabilitiesFixture({}) })], nextCursor: null } });
        answerTeamCredentialDiscoveryForTests(account.home, account.serverId, () => TeamCredentialResourceDiscoveryPageV1Schema.parse({
            resources: state.teamCredentialCatalog.resources, nextCursor: null, failures: [],
        }));
        await account.publishFeatures(account.serverId, createRootLayoutFeaturesResponse({ features: {
            providers: { enabled: true }, teams: { enabled: true, credentialResources: { enabled: true, externalApi: { enabled: false } } },
        } }));
        const { ProviderConnectionsSettingsScreen } = await import('./ProviderConnectionsSettingsScreen');
        const screen = await renderScreen(<ProviderConnectionsSettingsScreen />);

        await waitForHomeGovernance(() => expect(screen.findByTestId('team-credential-catalog-resource:team-1:resource-1')).not.toBeNull());
        await screen.pressByTestIdAsync('team-credential-catalog-resource:team-1:resource-1');
        expect(routerPush).toHaveBeenCalledWith(`/settings/teams/${account.serverId}/team-1/credentials/resource-1`);
    });

    it("a phone's page is the rail's own list under its title: compact rows without chevrons and the count beside the title (lab sfcols:provP)", async () => {
        const { ProviderConnectionsSettingsScreen } = await import('./ProviderConnectionsSettingsScreen');
        const screen = await renderScreen(<ProviderConnectionsSettingsScreen />);
        await waitForHomeGovernance(() => expect(findConnectionRow(screen, 'pc_a')).not.toBeNull());
        expect(findConnectionRow(screen, 'pc_a')?.props).toMatchObject({ density: 'compact', showChevron: false });
        const header = screen.findAll((node) => node.props?.testID === 'settings-providers-header' && node.props.titleAccessory !== undefined)[0];
        expect(header?.props.titleAccessory).toBeTruthy();
    });

    it('renders the configured connection supplied by the shared Provider RPC boundary', async () => {
        state.describeReply = {
            loading: false,
            error: null,
            data: createProviderConnectionsDescribeFixture({
                connections: [createProviderConnectionViewFixture({
                    displayName: 'Boundary connection',
                    providerName: 'Boundary connection',
                })],
            }),
        };
        const { ProviderConnectionsSettingsScreen } = await import('./ProviderConnectionsSettingsScreen');
        const screen = await renderScreen(<ProviderConnectionsSettingsScreen />);

        await waitForHomeGovernance(() => expect({
            titles: screen.findAllByType(Item).map(item => item.props.title),
            requests: providerHarness.state.requests,
        }).toMatchObject({ titles: expect.arrayContaining(['Boundary connection']) }));
        expect(providerConnectionReads()).toHaveLength(1);
        expect(screen.findAllByType(Item).map((item) => item.props.title))
            .toContain('Boundary connection');
    });

    it('replaces the retained daemon projection each time the index regains focus', async () => {
        const { ProviderConnectionsSettingsScreen } = await import('./ProviderConnectionsSettingsScreen');
        const screen = await renderScreen(<ProviderConnectionsSettingsScreen />);
        await waitForHomeGovernance(() => expect(findConnectionRow(screen, 'pc_a')).not.toBeNull());
        expect(screen.findAllByType(Item).map((item) => item.props.title)).toContain('Acme');

        const query = state.describeReply as {
            data: ReturnType<typeof createProviderConnectionsDescribeFixture>;
        };
        query.data = createProviderConnectionsDescribeFixture({ connections: [] });
        await screen.update(<ProviderConnectionsSettingsScreen active={false} />);
        await screen.update(<ProviderConnectionsSettingsScreen active />);

        await waitForHomeGovernance(() => expect(screen.findAllByType(Item).map((item) => item.props.title)).not.toContain('Acme'));

        query.data = createProviderConnectionsDescribeFixture({
            connections: [createProviderConnectionViewFixture({
                connectionId: 'pc_returned',
                displayName: 'Returned connection',
                providerName: 'Returned connection',
            })],
        });
        await screen.update(<ProviderConnectionsSettingsScreen active={false} />);
        await screen.update(<ProviderConnectionsSettingsScreen active />);

        await waitForHomeGovernance(() => expect(screen.findAllByType(Item).map((item) => item.props.title))
            .toContain('Returned connection'));
    });

    it('pauses the collection focus return until Back reaches the collection route', async () => {
        let activeElement: {
            focus: ReturnType<typeof vi.fn>;
            isConnected: boolean;
            getAttribute: (name: string) => string | null;
        } | null = null;
        vi.stubGlobal('document', {
            get activeElement() {
                return activeElement;
            },
            body: {},
            documentElement: {},
            getElementById: () => null,
            querySelectorAll: () => activeElement ? [activeElement] : [],
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
        });
        const { ProviderConnectionsSettingsScreen } = await import('./ProviderConnectionsSettingsScreen');
        const screen = await renderScreen(<ProviderConnectionsSettingsScreen />);
        await waitForHomeGovernance(() => expect(findConnectionRow(screen, 'pc_a')).not.toBeNull());
        // A connection row, then the "+" menu's catalog provider (a custom endpoint stays in the dialog).
        const entries = [
            { testID: 'settings-provider-connection:pc_a', open: async () => { findConnectionRow(screen, 'pc_a')?.props.onPress?.(); } },
            { testID: 'settings-providers-add', open: async () => {
                const picker = await openProviderPicker(screen);
                await picker.select(picker.config().catalog.itemKey(picker.config().catalog.items[0]));
                await picker.modal.pressByTestIdAsync('providers.add:primary');
                await picker.modal.unmount();
            } },
        ];

        for (const { testID, open } of entries) {
            const focus = vi.fn();
            activeElement = {
                focus,
                isConnected: true,
                getAttribute: (name: string) => name === 'data-testid' ? testID : null,
            };

            await open();

            expect(focus).not.toHaveBeenCalled();

            navigationState.pathname = testID === 'settings-provider-connection:pc_a'
                ? '/settings/providers/pc_a' : '/settings/providers/new';
            await screen.update(<ProviderConnectionsSettingsScreen active />);
            expect(focus).not.toHaveBeenCalled();

            navigationState.pathname = '/settings/providers';
            await screen.update(<ProviderConnectionsSettingsScreen />);
            expect(focus).toHaveBeenCalledOnce();
        }

        expect(routerPush).toHaveBeenNthCalledWith(1, '/(app)/settings/providers/pc_a');
        expect(routerPush).toHaveBeenNthCalledWith(
            2,
            expect.stringMatching(/^\/\(app\)\/settings\/providers\/new\?contributionKey=/),
        );
        expect(routerPush).toHaveBeenCalledTimes(2);
    });

    it('fails closed into the unavailable state when the root provider feature is off', async () => {
        await account.publishFeatures(account.serverId, createRootLayoutFeaturesResponse({ features: { providers: { enabled: false } } }));
        const { ProviderConnectionsSettingsScreen } = await import('./ProviderConnectionsSettingsScreen');
        const screen = await renderScreen(React.createElement(ProviderConnectionsSettingsScreen));
        expect(screen.findAllByType(Item).map((item) => item.props.title))
            .toContain('settingsProviders.unavailable');
    });

    it('does not present a transient feature probe failure as a server-disabled Provider feature', async () => {
        const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
        account.home.answer(account.serverId, '/v1/features', { status: 503 });
        primeServerFeaturesSnapshot({ serverId: account.serverId, snapshot: { status: 'error', reason: 'response_status', httpStatus: 503 } });
        const { ProviderConnectionsSettingsScreen } = await import('./ProviderConnectionsSettingsScreen');
        const screen = await renderScreen(<ProviderConnectionsSettingsScreen />);
        const items = screen.findAllByType(Item);
        expect(items.map((item) => item.props.title)).toContain('settingsProviders.availabilityProblem');
        expect(items.map((item) => item.props.subtitle)).not.toContain('settingsProviders.unavailableDescription');
    });

    it('presents a genuinely unsupported server endpoint truthfully', async () => {
        const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
        account.home.answer(account.serverId, '/v1/features', { status: 404 });
        primeServerFeaturesSnapshot({ serverId: account.serverId, snapshot: { status: 'unsupported', reason: 'endpoint_missing' } });
        const { ProviderConnectionsSettingsScreen } = await import('./ProviderConnectionsSettingsScreen');
        const screen = await renderScreen(<ProviderConnectionsSettingsScreen />);
        expect(screen.findAllByType(Item).map(item => item.props.title)).toContain('settingsProviders.availabilityUnsupported');
        expect(providerHarness.state.requests).toHaveLength(0);
    });

    it('presents a mixed Home feature scope without authorizing Provider queries', async () => {
        const otherServerId = await account.addHome({ name: 'Without Providers', serverUrl: 'https://providers-disabled.test',
            serverIdentityId: 'srv_provider_other', accountId: 'other-account', active: false,
            features: createRootLayoutFeaturesResponse({ features: { providers: { enabled: false } } }) });
        await account.home.selectHomes([account.serverId, otherServerId]);
        const { ProviderConnectionsSettingsScreen } = await import('./ProviderConnectionsSettingsScreen');
        const screen = await renderScreen(<ProviderConnectionsSettingsScreen />);
        expect(screen.findAllByType(Item).map(item => item.props.title)).toContain('settingsProviders.availabilityContextUnsupported');
        expect(providerHarness.state.requests).toHaveLength(0);
    });

    it('invites the providers to connect on a phone\'s page, the same shelf the wide home shows', async () => {
        installBundledProviderDeclarationsRpcBoundary(providerHarness);
        const { readAccountProviderDeclarations } = await import('@/providers/catalog/accountProviderDeclarations');
        const { projectAvailableProviderContributionsV1 } = await import('@happier-dev/protocol/providers/connections/sourceFactsV1');
        const query = state.describeReply as { data: ReturnType<typeof createProviderConnectionsDescribeFixture> };
        query.data = createProviderConnectionsDescribeFixture({ ...query.data, available: projectAvailableProviderContributionsV1({
            connections: [], definitions: readAccountProviderDeclarations({ kind: 'account' }),
        }) });
        const { ProviderConnectionsSettingsScreen } = await import('./ProviderConnectionsSettingsScreen');
        const page = await renderScreen(<ProviderConnectionsSettingsScreen variant="page" />);
        await waitForHomeGovernance(() => expect(findConnectionRow(page, 'pc_a')).not.toBeNull());
        expect(page.findByTestId('settings-providers-home.shelf')).not.toBeNull();
        await measureMountedCollections(page);
        const connect = page.findAll(node => typeof node.props.testID === 'string'
            && node.props.testID.startsWith('settings-providers-home.connect.'))[0];
        expect(connect).toBeDefined();
        const press = connect!.findAll(node => typeof node.props.onPress === 'function')[0]!;
        await act(async () => { press.props.onPress(); });
        expect(routerPush).toHaveBeenCalled();
    });

    it('reads as the overview on the wide home: your providers, each with its state (lab crProv-home)', async () => {
        const { ProviderConnectionsSettingsScreen } = await import('./ProviderConnectionsSettingsScreen');
        const home = await renderScreen(<ProviderConnectionsSettingsScreen variant="home" />);
        await waitForHomeGovernance(() => expect(home.findByTestId('settings-providers-home')).not.toBeNull());
        await waitForHomeGovernance(() => expect(home.findByTestId('settings-providers-home.providers')).not.toBeNull());
        const row = findConnectionRow(home, 'pc_a');
        expect(row).not.toBeNull();
        // Its state is the row's trailing word (On or Off), or the trouble in words on its line.
        expect(row?.props.detail ?? row?.props.subtitle).toBeDefined();
    });

    it('says why a gateway is off on the home when no account stands behind it, and offers a few providers then Browse all', async () => {
        installBundledProviderDeclarationsRpcBoundary(providerHarness);
        const { readAccountProviderDeclarations } = await import('@/providers/catalog/accountProviderDeclarations');
        const { projectAvailableProviderContributionsV1 } = await import('@happier-dev/protocol/providers/connections/sourceFactsV1');
        const { INVITATION_MARK_COUNT } = await import('./collection/ProviderCollectionInvitation');
        const { CollectionStatusLine } = await import('@/components/ui/lists/collection/CollectionStatusGlyph');
        const query = state.describeReply as { data: ReturnType<typeof createProviderConnectionsDescribeFixture> };
        const available = projectAvailableProviderContributionsV1({ connections: [], definitions: readAccountProviderDeclarations({ kind: 'account' }) });
        query.data = createProviderConnectionsDescribeFixture({ ...query.data, available, connections: [
            ...query.data.connections,
            createProviderConnectionViewFixture({
                connectionId: 'pc_gateway', contributionKey: 'happier.provider.cliproxyapi/cliproxyapi',
                deployment: { kind: 'managedLocal', targetMachineId: 'machine-a', effects: null }, managedLocalOption: null,
                authorizationError: createProviderErrorV1('provider_connection_invalid', { connectionId: 'pc_gateway', reason: 'managed_purpose_bindings_missing' }),
            }),
        ] });
        const { ProviderConnectionsSettingsScreen } = await import('./ProviderConnectionsSettingsScreen');
        const home = await renderScreen(<ProviderConnectionsSettingsScreen variant="home" />);
        await waitForHomeGovernance(() => expect(findConnectionRow(home, 'pc_gateway')).not.toBeNull());
        const line = home.findAllByType(CollectionStatusLine).find(node => node.props.testID === 'settings-provider-connection-status:pc_gateway');
        expect(line?.props).toMatchObject({ status: 'signIn', label: 'common.off', description: 'settingsProvidersCollection.gateway.needsAccountStatus' });
        // A few providers to start with, then Browse all with how many more.
        const offered = home.findAll(node => typeof node.props.testID === 'string' && node.props.testID.startsWith('settings-providers-home.row.')
            && typeof node.props.title === 'string');
        expect(offered.length).toBe(Math.min(INVITATION_MARK_COUNT, available.length));
        if (available.length > INVITATION_MARK_COUNT) {
            const browse = home.findAllByType(Item).find(item => item.props.testID === 'settings-providers-home.browse-all');
            expect(browse?.props.subtitle).toBe(`tools.common.more(count=${available.length - INVITATION_MARK_COUNT})`);
        }
    });

    it('opens the shared Provider Add body from the header', async () => {
        installBundledProviderDeclarationsRpcBoundary(providerHarness);
        const { readAccountProviderDeclarations } = await import('@/providers/catalog/accountProviderDeclarations');
        const { projectAvailableProviderContributionsV1 } = await import('@happier-dev/protocol/providers/connections/sourceFactsV1');
        const query = state.describeReply as { data: ReturnType<typeof createProviderConnectionsDescribeFixture> };
        query.data = createProviderConnectionsDescribeFixture({ ...query.data, available: projectAvailableProviderContributionsV1({
            connections: [], definitions: readAccountProviderDeclarations({ kind: 'account' }),
        }) });
        const { ProviderConnectionsSettingsScreen } = await import('./ProviderConnectionsSettingsScreen');
        const screen = await renderScreen(React.createElement(ProviderConnectionsSettingsScreen));
        await waitForHomeGovernance(() => expect(screen.findByTestId('settings-providers-add')).not.toBeNull());
        const picker = await openProviderPicker(screen);
        const selected = picker.config().catalog.items[0];
        await picker.select(picker.config().catalog.itemKey(selected));
        expect(run).not.toHaveBeenCalled();
        expect(providerHarness.state.requests.filter(request => [
            RPC_METHODS.DAEMON_PROVIDERS_PROBE, RPC_METHODS.DAEMON_PROVIDERS_MODELS,
            RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION, RPC_METHODS.DAEMON_PROVIDERS_MODEL_LOAD,
            RPC_METHODS.DAEMON_PROVIDERS_CONNECTION_MUTATE,
        ].includes(request.method as never))).toEqual([]);
        expect(providerHarness.state.requests.every(request => request.machineId === 'machine-a'
            && areServerProfileIdentifiersEquivalent(request.serverId, account.serverId))).toBe(true);
        expect(providerConnectionReads().filter(request => Boolean((request.payload as { authoringPreview?: unknown }).authoringPreview))).toEqual([]);
        await picker.modal.pressByTestIdAsync('providers.add:primary');
        const href = routerPush.mock.calls.at(-1)![0] as string;
        navigationState.params = Object.fromEntries(new URLSearchParams(href.split('?')[1]));
        const { NewProviderConnectionRoute } = await import('@/app/(app)/settings/providers/new');
        const authoring = await renderScreen(<NewProviderConnectionRoute />);
        const { BuiltInProviderAuthoringView } = await import('./authoring/BuiltInProviderAuthoringView');
        await waitForHomeGovernance(() => expect(authoring.findByType(BuiltInProviderAuthoringView).props).toMatchObject({
            contributionKey: navigationState.params.contributionKey, providerName: selected.provider.name,
        }));
        expect(authoring.findByTestId('settings-provider-authoring-built-in')).not.toBeNull();
        expect(run).not.toHaveBeenCalled();
    });

    it('projects declared Provider details without probing during Add browsing', async () => {
        installBundledProviderDeclarationsRpcBoundary(providerHarness);
        const { readAccountProviderDeclarations } = await import('@/providers/catalog/accountProviderDeclarations');
        const declaration = readAccountProviderDeclarations({ kind: 'account' }).find(row => row.definition.id === 'deepseek')!;
        const { ProviderConnectionsSettingsScreen } = await import('./ProviderConnectionsSettingsScreen');
        const screen = await renderScreen(<ProviderConnectionsSettingsScreen />);
        const picker = await openProviderPicker(screen);
        const selected = picker.config().catalog.items.find((row: { kind: string; provider?: { contributionKey: string } }) =>
            row.kind === 'contribution' && row.provider?.contributionKey === declaration.contributionKey);
        expect(selected?.detail).toMatchObject({
            auth: { kind: 'apiKey', required: true, keyUrl: declaration.definition.credential!.keyUrl },
            models: declaration.definition.catalog,
            source: { contributionKey: declaration.contributionKey, provenance: declaration.provenance,
                websiteUrl: declaration.definition.websiteUrl },
            nextStep: { kind: 'apiKey' },
        });
        expect(selected.detail.source).not.toHaveProperty('version');
        expect(selected.detail.worksWith).toEqual(expect.arrayContaining([
            expect.objectContaining({ agentTargetKey: 'agent:happier.agent.claude/claude',
                compatibility: expect.objectContaining({ status: 'experimental', selectedProtocol: 'anthropic' }) }),
        ]));
        expect(selected.detail.worksWith.some((agent: { agentTargetKey: string }) => agent.agentTargetKey === 'agent:happier.agent.codex/codex')).toBe(false);
        await picker.select(picker.config().catalog.itemKey(selected));
        expect(providerHarness.state.requests.filter(request => [RPC_METHODS.DAEMON_PROVIDERS_PROBE,
            RPC_METHODS.DAEMON_PROVIDERS_MODELS, RPC_METHODS.DAEMON_PROVIDERS_MODEL_LOAD,
            RPC_METHODS.DAEMON_PROVIDERS_CONNECTION_MUTATE].includes(request.method as never))).toEqual([]);
        expect(run).not.toHaveBeenCalled();
    });

    it('groups found Machine Providers before declared model providers in Add', async () => {
        const query = state.describeReply as { data: { discoveryCandidates: unknown[] } };
        query.data.discoveryCandidates = [{
            // The bundled Ollama declaration, so the found row's details can name what it needs.
            v: 1, machineId: 'machine-a', contributionKey: 'happier.provider.ollama/ollama', providerName: 'Ollama',
            endpointTemplateId: 'native', normalizedEndpointUrl: 'http://127.0.0.1:22434',
            candidateId: 'discovery-candidate:v1:grouped', evidence: { kind: 'attributed_listener' },
            ownership: 'adopted', connection: { status: 'requires_named_connection' },
        }];
        const { ProviderConnectionsSettingsScreen } = await import('./ProviderConnectionsSettingsScreen');
        const screen = await renderScreen(<ProviderConnectionsSettingsScreen />);
        const picker = await openProviderPicker(screen);
        await waitForHomeGovernance(() => expect(picker.config().catalog.items.some((row: { kind: string }) => row.kind === 'found')).toBe(true));
        const catalog = picker.config().catalog;
        expect(catalog.groups).toEqual([
            expect.objectContaining({ key: 'found', itemKeys: catalog.items.filter((row: { kind: string }) => row.kind === 'found').map(catalog.itemKey) }),
            expect.objectContaining({ key: 'providers', itemKeys: catalog.items.filter((row: { kind: string }) => row.kind === 'contribution').map(catalog.itemKey) }),
        ]);
        expect(catalog.items[0].kind).toBe('found');
        // A found server's details say what that provider needs, works with and holds, as its catalog row's do.
        const details = await renderScreen(<>{picker.config().renderDetail(catalog.items[0])}</>);
        const key = catalog.itemKey(catalog.items[0]);
        expect(details.findByTestId(`providers.add:detail:${key}:needs`)).not.toBeNull();
        expect(details.findByTestId(`providers.add:detail:${key}:works-with`)).not.toBeNull();
    });

    it('reviews a detected Provider with the selected Machine, declared models and unchecked availability', async () => {
        // This case retains the Action's default person confirmation in beforeEach.
        installBundledProviderDeclarationsRpcBoundary(providerHarness);
        const candidate = {
            v: 1 as const, machineId: machine.id, contributionKey: 'happier.provider.ollama/ollama', providerName: 'Ollama',
            endpointTemplateId: 'native', normalizedEndpointUrl: 'http://127.0.0.1:11434',
            candidateId: 'discovery-candidate:v1:review', evidence: { kind: 'attributed_listener' as const },
            ownership: 'adopted' as const, connection: { status: 'enable_default' as const },
        };
        const query = state.describeReply as { data: ReturnType<typeof createProviderConnectionsDescribeFixture> };
        query.data = createProviderConnectionsDescribeFixture({ ...query.data, discoveryCandidates: [candidate] });
        const { Modal } = await import('@/modal');
        vi.mocked(Modal.confirm).mockClear().mockResolvedValue(false);
        const { ProviderConnectionsSettingsScreen } = await import('./ProviderConnectionsSettingsScreen');
        const screen = await renderScreen(<ProviderConnectionsSettingsScreen />);
        const picker = await openProviderPicker(screen);
        await waitForHomeGovernance(() => expect(picker.config().catalog.items.some((row: { kind: string }) => row.kind === 'found')).toBe(true));
        const found = picker.config().catalog.items.find((row: { kind: string }) => row.kind === 'found');
        await picker.select(found.key);
        const readsBeforeReview = providerConnectionReads().length;
        await picker.modal.pressByTestIdAsync('providers.add:primary');
        expect(Modal.confirm).toHaveBeenCalled();
        const [reviewTitle, reviewBody] = vi.mocked(Modal.confirm).mock.calls.at(-1)!;
        const { t } = await import('@/text');
        expect(reviewTitle).toContain('Ollama');
        expect(reviewTitle).not.toContain(t('common.unavailable'));
        expect(reviewBody).toContain('Mac');
        const { readAccountProviderDeclaration } = await import('@/providers/catalog/accountProviderDeclarations');
        const declaration = readAccountProviderDeclaration(candidate.contributionKey, { kind: 'account' })!;
        const models = 'staticModels' in declaration.definition.catalog ? declaration.definition.catalog.staticModels : [];
        expect(models.length).toBeGreaterThan(0);
        const detailModels = picker.modal.findAllByType(Item).map(item => item.props.subtitle).filter(Boolean).join(' ');
        for (const model of models) {
            expect(reviewBody).toContain(model.name);
            expect(detailModels).toContain(model.name);
        }
        expect(reviewBody).toContain(t('settingsProviders.status.notChecked'));
        expect(providerConnectionReads()).toHaveLength(readsBeforeReview);
        expect(run).not.toHaveBeenCalled();
        expect(picker.onClose).not.toHaveBeenCalled();
    });

    it('closes the Provider picker after successful detected Connect withdraws its found row', async () => {
        const query = state.describeReply as { data: ReturnType<typeof createProviderConnectionsDescribeFixture> };
        query.data = createProviderConnectionsDescribeFixture({ ...query.data, discoveryCandidates: [{
            v: 1, machineId: machine.id, contributionKey: 'happier.provider.ollama/ollama', providerName: 'Ollama',
            endpointTemplateId: 'native', normalizedEndpointUrl: 'http://127.0.0.1:11434',
            candidateId: 'discovery-candidate:v1:completion', evidence: { kind: 'attributed_listener' },
            ownership: 'adopted', connection: { status: 'enable_default' },
        }] });
        run.mockImplementationOnce((request: { connectionId: string }) => {
            query.data = createProviderConnectionsDescribeFixture({ ...query.data, discoveryCandidates: [] });
            return { status: 'success', action: 'enableDetected',
                connection: createProviderConnectionViewFixture({ connectionId: request.connectionId }) };
        });
        const { ProviderConnectionsSettingsScreen } = await import('./ProviderConnectionsSettingsScreen');
        const screen = await renderScreen(<ProviderConnectionsSettingsScreen />);
        const picker = await openProviderPicker(screen);
        await waitForHomeGovernance(() => expect(picker.config().catalog.items.some((row: { kind: string }) => row.kind === 'found')).toBe(true));
        const found = picker.config().catalog.items.find((row: { kind: string }) => row.kind === 'found');
        await picker.select(found.key);
        await picker.modal.pressByTestIdAsync('providers.add:primary');
        expect(run).toHaveBeenCalledTimes(1);
        await waitForHomeGovernance(() => expect(picker.config().catalog.items.every((row: { kind: string }) => row.kind !== 'found')).toBe(true));
        expect(picker.onClose).toHaveBeenCalledTimes(1);
        expect(run).toHaveBeenCalledTimes(1);
    });

    it('uses the shared Provider picker for invitation and Custom before real Custom authoring', async () => {
        const query = state.describeReply as { data: { connections: unknown[] } };
        query.data.connections = [];
        await account.publishMachines(account.serverId, []);
        const { ProviderConnectionsSettingsScreen } = await import('./ProviderConnectionsSettingsScreen');
        const screen = await renderScreen(<ProviderConnectionsSettingsScreen />);
        await waitForHomeGovernance(() => expect(screen.findByTestId('settings-providers-invitation-add')).not.toBeNull());
        for (const trigger of ['settings-providers-invitation-add', 'settings-providers-invitation-custom']) {
            const picker = await openProviderPicker(screen, trigger);
            expect(run).not.toHaveBeenCalled();
            await picker.modal.pressByTestIdAsync('providers.add:mode:custom');
            // Custom endpoint is set up inside the dialog, by the same authoring owner as the page.
            await waitForHomeGovernance(() => expect(picker.modal.findByTestId('settings-provider-authoring')).not.toBeNull());
            expect(routerPush).not.toHaveBeenCalled();
            await picker.modal.unmount();
        }
        navigationState.params = {};
        const { NewProviderConnectionRoute } = await import('@/app/(app)/settings/providers/new');
        const authoring = await renderScreen(<NewProviderConnectionRoute />);
        expect(authoring.findByTestId('settings-provider-authoring')).not.toBeNull();
        expect(run).not.toHaveBeenCalled();
    });

    it('refuses retired Account and stale Machine picks from the shared Provider body', async () => {
        const query = state.describeReply as { data: { discoveryCandidates: unknown[] } };
        query.data.discoveryCandidates = [{
            v: 1, machineId: 'machine-a', contributionKey: 'plugin/ollama', providerName: 'Ollama',
            endpointTemplateId: 'native', normalizedEndpointUrl: 'http://127.0.0.1:22434',
            candidateId: 'discovery-candidate:v1:retired', evidence: { kind: 'attributed_listener' },
            ownership: 'adopted', connection: { status: 'requires_named_connection' },
        }];
        const { ProviderConnectionsSettingsScreen } = await import('./ProviderConnectionsSettingsScreen');
        const screen = await renderScreen(<ProviderConnectionsSettingsScreen />);
        const picker = await openProviderPicker(screen);
        await waitForHomeGovernance(() => expect(picker.config().catalog.items.some((row: { kind: string }) => row.kind === 'found')).toBe(true));
        const found = picker.config().catalog.items.find((row: { kind: string }) => row.kind === 'found');
        const contribution = picker.config().catalog.items.find((row: { kind: string }) => row.kind === 'contribution');
        const continueFound = picker.config().detailFooter(found).primary.onPress;
        const continueContribution = picker.config().detailFooter(contribution).primary.onPress;
        await React.act(async () => {
            await account.publishMachines(account.serverId, [machine, createMachineFixture({ ...machine, id: 'machine-b' })]);
            await account.selectMachine(account.serverId, 'machine-b');
        });
        await React.act(async () => { await continueFound(); });
        expect(run).not.toHaveBeenCalled();
        expect(routerPush).not.toHaveBeenCalled();
        await React.act(async () => { await account.restore({ accountId: 'account-b', machines: [machine] }); });
        await React.act(async () => { await continueContribution(); });
        expect(routerPush).not.toHaveBeenCalled();
        expect(routerReplace).not.toHaveBeenCalled();
        expect(run).not.toHaveBeenCalled();
    });

    it('shows Account shown and total catalog counts in the rail without a machine', async () => {
        const connection = ProviderConnectionV1Schema.parse({
            v: 1,
            id: 'pc_a',
            source: {
                kind: 'custom',
                template: buildCustomProviderTemplate({
                    ...createCustomProviderDraft('openai-responses'),
                    name: 'Acme',
                    baseUrl: 'https://acme.example/v1',
                    requiresApiKey: false,
                    catalog: 'manual',
                }),
            },
            role: 'named',
            displayName: 'Acme',
            displayNameMode: 'custom',
            revision: 0,
            createdAt: 1,
            updatedAt: 1,
        });
        let catalog = ProviderConnectionsCatalogV1Schema.parse({
            ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
            connections: [connection],
            manualModelsByConnectionId: {
                [connection.id]: [
                    { id: 'shown', name: 'Shown model', addedAt: 1 },
                    { id: 'hidden', name: 'Hidden model', addedAt: 1 },
                ],
            },
            modelVisibilityByRef: {
                [serializeModelVisibilityRefV1({
                    scope: 'allAgents',
                    providerConnectionId: connection.id,
                    modelId: 'hidden',
                })]: 'hidden',
            },
        });
        // Build a saved grant through its real owner, with only the Account-row transport in memory.
        const execute = createAccountProviderActionExecuteV1({
            assertCurrent() {},
            now: () => 10,
            readCatalog: async () => ({ status: 'ready', revision: 1, catalog }),
            readDefinitions: async () => [],
            writeCatalog: async (input) => {
                catalog = input.catalog;
                return { status: 'updated' };
            },
        });
        expect(
            await execute(
                parseProviderActionRequestV1('providers.connections.enabled.set', {
                    action: 'setEnabled',
                    connectionId: connection.id,
                    scope: 'account',
                    enabled: true,
                }),
                {},
            ),
        ).toMatchObject({ ok: true });
        // A new Account admits its revision-1 catalog instead of replaying the prior Account's cursor.
        await account.restore({
            accountId: 'account-rail-counts',
            machines: [],
            catalog,
        });
        await account.home.selectHomes([account.serverId]);
        await account.selectMachine(account.serverId, null);
        providerHarness.state.requests = [];
        const { ProviderConnectionsSettingsScreen } =
            await import('./ProviderConnectionsSettingsScreen');
        const screen = await renderScreen(
            <ProviderConnectionsSettingsScreen variant="rail" />,
        );
        await waitForHomeGovernance(() =>
            expect(findConnectionRow(screen, connection.id)).not.toBeNull(),
        );
        expect(findConnectionRow(screen, connection.id)?.props.titleMeta).toBe(
            'settingsProvidersCollection.modelsSaved(shown=1,total=2)',
        );
        expect(
            findConnectionRow(screen, connection.id)?.props.subtitleLeading,
        ).toBeUndefined();
        expect(providerHarness.state.requests).toHaveLength(0);
    });

    it.each([
        { health: 'unreachable', status: 'failed', label: 'unreachable' },
        { health: 'partial', status: 'review', label: 'partial' },
        { health: 'available', status: null, label: 'available' },
        { health: 'not_checked', status: null, label: 'notChecked' },
        { health: 'available', status: 'off', label: 'disabled', disabled: true },
        { health: 'available', status: 'review', label: 'sourceUnavailable', sourceUnavailable: true },
    ])('projects $label through the shared configuration status slot without guessing health', async ({ health, status, label, disabled, sourceUnavailable }) => {
        const query = state.describeReply as { data: { connections: Array<Record<string, unknown>> } };
        query.data.connections[0] = {
            ...query.data.connections[0],
            runtime: { health, modelCount: 3, checkedAt: 1, endpoints: [] },
            ...(disabled ? { grants: { accountEnabled: false, enabledMachineIds: [] } } : {}),
            ...(sourceUnavailable ? { sourceStatus: 'unavailable' } : {}),
        };
        const { ProviderConnectionsSettingsScreen } = await import('./ProviderConnectionsSettingsScreen');
        const screen = await renderScreen(<ProviderConnectionsSettingsScreen variant="rail" />);
        await waitForHomeGovernance(() => expect(findConnectionRow(screen, 'pc_a')).not.toBeNull());
        const acme = findConnectionRow(screen, 'pc_a');
        expect(acme?.props.subtitleLeading).toBeUndefined();
        if (status === null) {
            expect(acme?.props.subtitle).toBe('');
            expect(screen.findByTestId('settings-provider-connection-status:pc_a')).toBeNull();
        } else {
            expect(screen.findAll(node => node.props.testID === 'settings-provider-connection-status:pc_a'
                && node.props.status === status)).toHaveLength(1);
            // The state is said in words on the row (line 2 leads with it), never only by a glyph and its tooltip.
            expect(screen.getTextContent()).toContain(`settingsProviders.status.${label}`);
        }
    });

    it.each(['rail', 'page'] as const)('narrows the real %s Providers column by held Source and Status without another read', async variant => {
        state.describeReply = { data: createProviderConnectionsDescribeFixture({ connections: [
            createProviderConnectionViewFixture({ connectionId: 'pc_acme', contributionKey: 'plugin/acme',
                displayName: 'Personal', providerName: 'Acme', role: 'named', displayNameMode: 'custom',
                runtime: { health: 'available', modelCount: 3, checkedAt: 1, endpoints: [] } }),
            createProviderConnectionViewFixture({ connectionId: 'pc_other', contributionKey: 'plugin/other',
                displayName: 'Other', providerName: 'Other',
                runtime: { health: 'unreachable', modelCount: 0, checkedAt: 1, endpoints: [] } }),
            ...Array.from({ length: 6 }, (_, index) => createProviderConnectionViewFixture({
                connectionId: `pc_extra_${index}`, contributionKey: 'plugin/acme', providerName: 'Acme',
                displayName: `Extra ${index}`, role: 'named', displayNameMode: 'custom',
            })),
        ], localInstallations: [{ v: 1, machineId: 'machine-a', contributionKey: 'plugin/other',
            providerName: 'Other', status: 'installed_not_running', managedStartAvailable: false }] }) };
        // Browser positioning is the boundary; the shared editor, adapter and matcher stay real.
        vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
        const { ProviderConnectionsSettingsScreen } = await import('./ProviderConnectionsSettingsScreen');
        const screen = await renderScreen(<ProviderConnectionsSettingsScreen variant={variant} />);
        await waitForHomeGovernance(() => expect(findConnectionRow(screen, 'pc_other')).not.toBeNull());
        const reads = providerConnectionReads().length;
        await React.act(async () => { findComposite(screen, 'settings-providers-search', 'onChangeText')!.props.onChangeText('Personal'); });
        expect(findConnectionRow(screen, 'pc_other')).toBeNull();
        await screen.pressByTestIdAsync('settings-providers-filter-open');
        const editor = () => screen.findAll(node => node.props.testID === 'settings-providers-editor' && node.props.model !== undefined)[0]!;
        expect(editor().props.model.availableFields.find((field: { id: string }) => field.id === 'source').valueOptions)
            .toEqual(expect.arrayContaining([{ value: 'plugin/acme', label: 'Acme' }, { value: 'plugin/other', label: 'Other' }]));
        // Search narrows visible rows, not the admitted corpus that supplies condition choices/counts.
        await React.act(async () => { findComposite(screen, 'settings-providers-search', 'onChangeText')!.props.onChangeText(''); });
        await React.act(async () => { editor().props.onChange({ type: 'add', condition: {
            fieldId: 'source', operator: 'is', values: ['plugin/other'],
        } }); });
        expect(findConnectionRow(screen, 'pc_acme')).toBeNull();
        expect(findConnectionRow(screen, 'pc_other')).not.toBeNull();
        await showFound(screen);
        expect(screen.findByTestId('settings-provider-found:installation:plugin/other')).not.toBeNull();
        await React.act(async () => { editor().props.onChange({ type: 'add', condition: {
            fieldId: 'status', operator: 'is', values: ['unreachable'],
        } }); });
        // Found installations have no connection health: a status condition must not guess it.
        expect(screen.findByTestId('settings-provider-found:installation:plugin/other')).toBeNull();
        expect(editor().props.result).toMatchObject({ matchedCount: 1, coverage: 'partial' });
        await screen.pressByTestIdAsync('settings-providers-view:all');
        expect(findConnectionRow(screen, 'pc_other')).not.toBeNull();
        await screen.pressByTestIdAsync('settings-providers-filter-token:source');
        expect(findConnectionRow(screen, 'pc_acme')).toBeNull();
        expect(findConnectionRow(screen, 'pc_other')).not.toBeNull();
        await screen.pressByTestIdAsync('settings-providers-filter-token:status');
        expect(findConnectionRow(screen, 'pc_acme')).not.toBeNull();
        expect(providerConnectionReads()).toHaveLength(reads);
        await React.act(async () => { findConnectionRow(screen, 'pc_other')?.props.onPress(); });
        expect(routerPush).toHaveBeenCalledWith('/(app)/settings/providers/pc_other');
    });

    it('keeps an untested healthy row quiet: how it signs in, never "Not checked" (P3)', async () => {
        const query = state.describeReply as {
            data: { connections: Array<Record<string, unknown>> };
        };
        query.data.connections[0] = {
            ...query.data.connections[0],
            credential: { required: true, accountBound: true, boundMachineIds: [] },
            runtime: {
                health: 'not_checked',
                modelCount: null,
                checkedAt: null,
                endpoints: [],
            },
        };
        const { ProviderConnectionsSettingsScreen } =
            await import('./ProviderConnectionsSettingsScreen');
        const screen = await renderScreen(
            <ProviderConnectionsSettingsScreen variant="rail" />,
        );
        await waitForHomeGovernance(() => expect(findConnectionRow(screen, 'pc_a')).not.toBeNull());
        const acme = findConnectionRow(screen, 'pc_a');
        expect(acme?.props.subtitle).toContain(
            'settingsProviders.authoring.apiKey',
        );
        expect(acme?.props.subtitle).not.toContain(
            'settingsProviders.status.notChecked',
        );
        expect(acme?.props.subtitleLeading).toBeUndefined();
    });

    it('selects the route connection in the rail and searches only a collection too long to scan', async () => {
        const { ProviderConnectionsSettingsScreen } = await import('./ProviderConnectionsSettingsScreen');
        const small = await renderScreen(<ProviderConnectionsSettingsScreen variant="rail" selectedConnectionId="pc_a" />);
        await waitForHomeGovernance(() => expect(findConnectionRow(small, 'pc_a')).not.toBeNull());
        expect(findConnectionRow(small, 'pc_a')?.props.selected).toBe(true);
        expect(small.findByTestId('settings-providers-search')).toBeNull();

        const query = state.describeReply as { data: { connections: Array<Record<string, unknown>> } };
        const exemplar = query.data.connections[0]!;
        query.data.connections = Array.from({ length: 10 }, (_, index) => ({
            ...exemplar,
            connectionId: index === 0 ? 'pc_a' : `pc_${index}`,
            displayName: index === 0 ? 'Acme' : `Provider ${index}`,
            providerName: index === 0 ? 'Acme' : `Provider ${index}`,
        }));
        const large = await renderScreen(<ProviderConnectionsSettingsScreen variant="rail" selectedConnectionId="pc_a" />);
        await waitForHomeGovernance(() => expect(findConnectionRow(large, 'pc_3')).not.toBeNull());
        await React.act(async () => { large.changeTextByTestId('settings-providers-search', 'provider 3'); });
        expect(findConnectionRow(large, 'pc_a')).toBeNull();
        expect(large.findAllByType(Item).map((item) => item.props.title)).toContain('Provider 3');
        await React.act(async () => { large.changeTextByTestId('settings-providers-search', ''); });
        expect(findConnectionRow(large, 'pc_a')?.props.selected).toBe(true);
    });

    it('groups admitted gateways in the Providers rail without relabeling an ordinary managed source', async () => {
        installBundledProviderDeclarationsRpcBoundary(providerHarness);
        const { CollectionListGroupLabel } = await import('@/components/ui/lists/collection/CollectionList');
        state.describeReply = { data: createProviderConnectionsDescribeFixture({ connections: [
            createProviderConnectionViewFixture({ connectionId: 'pc_gateway', displayName: 'Subscriptions',
                contributionKey: 'happier.provider.cliproxyapi/cliproxyapi', deployment: { kind: 'managedLocal', targetMachineId: 'machine-a', effects: null },
                managedLocalOption: { targetMachineId: 'machine-a', connectedAccountPurposes: [
                    { purpose: 'upstream', service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, required: false },
                ] } }),
            createProviderConnectionViewFixture({ connectionId: 'pc_local', displayName: 'Local models',
                contributionKey: 'happier.provider.ollama/ollama', deployment: { kind: 'managedLocal', targetMachineId: 'machine-a', effects: null },
                managedLocalOption: { targetMachineId: 'machine-a', connectedAccountPurposes: [] } }),
        ] }) };
        const { ProviderConnectionsSettingsScreen } = await import('./ProviderConnectionsSettingsScreen');
        const screen = await renderScreen(<ProviderConnectionsSettingsScreen variant="rail" selectedConnectionId="pc_gateway" />);
        await waitForHomeGovernance(() => expect(screen.findAllByType(CollectionListGroupLabel)
            .map(node => ({ title: node.props.title, count: node.props.count })))
            .toContainEqual({ title: 'settingsProvidersCollection.gateway.railGroup', count: 1 }));
        expect(findConnectionRow(screen, 'pc_gateway')?.props.selected).toBe(true);
        // Said once for the group, never on a row (it truncated at rail width).
        expect(findConnectionRow(screen, 'pc_gateway')?.props.subtitle).not.toBe('settingsProvidersCollection.gateway.managedFromConnectedServices');
        expect(findConnectionRow(screen, 'pc_local')?.props.subtitle).not.toBe('settingsProvidersCollection.gateway.managedFromConnectedServices');
        // Beside the home, the home's Gateways section says where they are managed; the rail does not repeat it.
        expect(screen.getTextContent()).not.toContain('settingsProvidersCollection.gateway.managedFromConnectedServices');

        // Where no rail shows, the page is the rail's own list: gateways keep their own titled group.
        const page = await renderScreen(<ProviderConnectionsSettingsScreen variant="page" />);
        await waitForHomeGovernance(() => expect(findConnectionRow(page, 'pc_gateway')).not.toBeNull());
        expect(page.findAllByType(CollectionListGroupLabel).map(node => ({ title: node.props.title, count: node.props.count })))
            .toContainEqual({ title: 'settingsProvidersCollection.gateway.railGroup', count: 1 });
        // A phone's page has no home beside it, so it says once where gateways are managed.
        expect(page.getTextContent().split('settingsProvidersCollection.gateway.managedFromConnectedServices')).toHaveLength(2);
    });

    it('does not leave a dirty editor when another connection is selected until its guard permits navigation', async () => {
        const { ProviderConnectionsSettingsScreen } = await import('./ProviderConnectionsSettingsScreen');
        const screen = await renderScreen(<ProviderConnectionsSettingsScreen />);
        await waitForHomeGovernance(() => expect(findConnectionRow(screen, 'pc_a')).not.toBeNull());
        const decision = vi.fn<() => Promise<'keepEditing' | 'discard'>>(async () => 'keepEditing');
        setActiveUnsavedChangesGuard({
            isDirtyRef: { current: true },
            requestDecision: decision,
            tag: 'provider-collection-test',
        });
        await screen.pressByTestIdAsync('settings-provider-connection:pc_a');
        expect(decision).toHaveBeenCalledOnce();
        expect(routerPush).not.toHaveBeenCalled();
        decision.mockResolvedValueOnce('discard');
        await screen.pressByTestIdAsync('settings-provider-connection:pc_a');
        expect(routerPush).toHaveBeenCalledWith('/(app)/settings/providers/pc_a');
    });

    it('pauses the collection RPC while a narrow detail hides it and reloads when the collection becomes visible', async () => {
        const { ProviderConnectionsSettingsScreen } = await import('./ProviderConnectionsSettingsScreen');
        const screen = await renderScreen(<ProviderConnectionsSettingsScreen active={false} />);
        expect(providerHarness.state.requests).toHaveLength(0);
        await React.act(async () => {
            screen.tree.update(<ProviderConnectionsSettingsScreen active />);
            await flushHookEffects();
        });
        await waitForHomeGovernance(() => expect(findConnectionRow(screen, 'pc_a')).not.toBeNull());
        expect(screen.findAllByType(Item).map((item) => item.props.title)).toContain('Acme');
        expect(providerConnectionReads()).toHaveLength(1);
        await screen.update(<ProviderConnectionsSettingsScreen active={false} />);
        const hiddenRequests = providerHarness.state.requests.length;
        await React.act(async () => { await flushHookEffects(); });
        expect(providerHarness.state.requests).toHaveLength(hiddenRequests);
        await screen.update(<ProviderConnectionsSettingsScreen active />);
        await waitForHomeGovernance(() => expect(providerConnectionReads()).toHaveLength(2));
    });

    it('preserves the route editor and collection selection when its measured panes resize', async () => {
        navigationState.pathname = '/settings/providers/pc_a';
        navigationState.params = { connectionId: 'pc_a' };
        const { ProviderSettingsLayout } = await import('./ProviderSettingsLayout');
        const screen = await renderScreen(<ProviderSettingsLayout />);
        const resize = async (width: number) => {
            await React.act(async () => {
                screen.findByTestId('settings-providers-layout')?.props.onLayout({ nativeEvent: { layout: { width } } });
                await flushHookEffects();
            });
        };
        expect(providerHarness.state.requests).toHaveLength(0);
        await resize(1200);
        await waitForHomeGovernance(() => expect(findConnectionRow(screen, 'pc_a')).not.toBeNull());
        expect(findConnectionRow(screen, 'pc_a')?.props.selected).toBe(true);
        await React.act(async () => {
            screen.findByTestId('provider-draft')?.props.onChangeText('Unsubmitted endpoint');
        });
        await resize(480);
        expect(screen.findByTestId('settings-providers-list-pane')?.props.accessibilityElementsHidden).toBe(true);
        await resize(1200);
        expect(screen.findByTestId('settings-providers-list-pane')?.props.accessibilityElementsHidden).toBe(false);
        expect(screen.findByTestId('provider-draft')?.props.value).toBe('Unsubmitted endpoint');
        expect(navigationState.navigatorMounts).toBe(1);
        expect(findConnectionRow(screen, 'pc_a')?.props.selected).toBe(true);
    });

    it('keeps the provider rail beside a detail with no machine, reading nothing until one is chosen', async () => {
        navigationState.pathname = '/settings/providers';
        navigationState.params = {};
        await account.publishMachines(account.serverId, []);
        const { ProviderSettingsLayout } = await import('./ProviderSettingsLayout');
        const screen = await renderScreen(<ProviderSettingsLayout />);
        await React.act(async () => {
            screen.findByTestId('settings-providers-layout')?.props.onLayout({ nativeEvent: { layout: { width: 1200 } } });
            await flushHookEffects();
        });
        // The collection is Account data: its rail never waits for a machine to exist.
        expect(screen.findByTestId('settings-providers-screen')).not.toBeNull();
        expect(screen.findByTestId('settings-providers-detail-pane')?.props.accessibilityElementsHidden).toBe(false);
        expect(screen.findByTestId('provider-draft')).not.toBeNull();
        expect(providerHarness.state.requests).toHaveLength(0);
        expect(navigationState.navigatorMounts).toBe(1);
    });

    it('shows the provider rail beside the detail on desktop and only the detail stack on a narrow screen', async () => {
        navigationState.pathname = '/settings/providers';
        navigationState.params = {};
        const { ProviderSettingsLayout } = await import('./ProviderSettingsLayout');
        const screen = await renderScreen(<ProviderSettingsLayout />);
        const resize = async (width: number) => {
            await React.act(async () => {
                screen.findByTestId('settings-providers-layout')?.props.onLayout({ nativeEvent: { layout: { width } } });
                await flushHookEffects();
            });
        };

        await resize(1200);
        expect(screen.findByTestId('settings-providers-list-pane')?.props.accessibilityElementsHidden).toBe(false);
        expect(screen.findByTestId('settings-providers-detail-pane')?.props.accessibilityElementsHidden).toBe(false);

        // Narrow: the detail stack alone, whose index page is the provider list.
        await resize(480);
        expect(screen.findByTestId('settings-providers-list-pane')?.props.accessibilityElementsHidden).toBe(true);
        expect(screen.findByTestId('settings-providers-detail-pane')?.props.accessibilityElementsHidden).toBe(false);
    });

    it('pauses the collection when the Providers navigator loses focus', async () => {
        await account.publishMachines(account.serverId, [machine, createMachineFixture({ ...machine, id: 'machine-b' })]);
        const { ProviderSettingsLayout } = await import('./ProviderSettingsLayout');
        // The navigation boundary is mocked with the canonical context factory;
        // the real optional-focus adapter requires a mounted screen context.
        const { NavigationContext } = await import('@react-navigation/native') as unknown as {
            NavigationContext: React.Context<Readonly<Record<string, unknown>> | undefined>;
        };
        const screen = await renderScreen(
            <NavigationContext.Provider value={{ isFocused: () => navigationState.focused }}>
                <ProviderSettingsLayout />
            </NavigationContext.Provider>,
        );
        await React.act(async () => {
            screen.findByTestId('settings-providers-layout')?.props.onLayout({ nativeEvent: { layout: { width: 1200 } } });
            await flushHookEffects();
        });
        await waitForHomeGovernance(() => expect(findConnectionRow(screen, 'pc_a')).not.toBeNull());
        expect(findConnectionRow(screen, 'pc_a')).not.toBeNull();
        await React.act(async () => {
            navigationState.focused = false;
            for (const listener of navigationState.focusListeners) listener();
        });
        expect(findConnectionRow(screen, 'pc_a')).not.toBeNull();
        const readsBeforeTargetChange = providerHarness.state.requests.length;
        const connectionReadsBeforeTargetChange = providerConnectionReads().length;
        await React.act(async () => { await account.selectMachine(account.serverId, 'machine-b'); });
        expect(providerHarness.state.requests).toHaveLength(readsBeforeTargetChange);
        await React.act(async () => {
            navigationState.focused = true;
            for (const listener of navigationState.focusListeners) listener();
        });
        await waitForHomeGovernance(() => expect(findConnectionRow(screen, 'pc_a')).not.toBeNull());
        await waitForHomeGovernance(() => expect(providerConnectionReads()).toHaveLength(connectionReadsBeforeTargetChange + 1));
        expect(providerConnectionReads().at(-1)?.machineId).toBe('machine-b');
        expect(navigationState.navigatorMounts).toBe(1);
    });

    it('says Providers is unavailable without reading a machine', async () => {
        await account.publishFeatures(account.serverId, createRootLayoutFeaturesResponse({ features: { providers: { enabled: false } } }));
        const { ProviderSettingsIndex } = await import('./ProviderSettingsIndex');
        const screen = await renderInCollectionLayout(<ProviderSettingsIndex />, 'split');
        expect(screen.findAllByType(Item).map((item) => item.props.title)).toContain('settingsProviders.unavailable');
        expect(providerHarness.state.requests).toHaveLength(0);
    });

    it('keeps the wide home reachable and opens an explicit connection before returning to All', async () => {
        const query = state.describeReply as { data: { connections: Array<Record<string, unknown>> } };
        const exemplar = query.data.connections[0]!;
        query.data.connections = [
            exemplar,
            { ...exemplar, connectionId: 'pc_b', displayName: 'Beta', providerName: 'Beta' },
        ];
        const { ProviderSettingsIndex } = await import('./ProviderSettingsIndex');
        const screen = await renderInCollectionLayout(<ProviderSettingsIndex />, 'split');
        expect(screen.findAllByType('Redirect')).toHaveLength(0);
        await waitForHomeGovernance(() => expect(screen.findByTestId('settings-providers-home')).not.toBeNull());
        const picker = await openProviderPicker(screen);
        const admittedKeys = picker.config().catalog.items.map(picker.config().catalog.itemKey);
        expect(admittedKeys).not.toContain('contribution:plugin/other');
        expect(admittedKeys).toContain('contribution:happier.provider.openrouter/openrouter');
        await picker.select('contribution:happier.provider.openrouter/openrouter');
        await picker.modal.pressByTestIdAsync('providers.add:primary');
        expect(routerPush).toHaveBeenCalledWith('/(app)/settings/providers/new?contributionKey=happier.provider.openrouter%2Fopenrouter');
        await picker.modal.unmount();
        expect(providerConnectionReads().every(request => request.machineId === 'machine-a'
            && areServerProfileIdentifiersEquivalent(request.serverId, account.serverId))).toBe(true);
        const { ProviderConnectionsSettingsScreen } = await import('./ProviderConnectionsSettingsScreen');
        await screen.update(<ProviderConnectionsSettingsScreen variant="rail" />);
        await waitForHomeGovernance(() => expect(screen.findHostByTestId('settings-provider-connection:pc_b')).not.toBeNull());
        await screen.pressByTestIdAsync('settings-provider-connection:pc_b');
        expect(routerPush).toHaveBeenCalledWith('/(app)/settings/providers/pc_b');
        navigationState.pathname = '/settings/providers/pc_b';
        await screen.update(<ProviderConnectionsSettingsScreen variant="rail" selectedConnectionId="pc_b" />);
        await waitForHomeGovernance(() => expect(screen.findHostByTestId('settings-providers-all')).not.toBeNull());
        await screen.pressByTestIdAsync('settings-providers-all');
        expect(routerReplace).toHaveBeenCalledWith('/(app)/settings/providers');
    });

    it('invites a wide collection with nothing to select to add its first provider', async () => {
        const query = state.describeReply as { data: { connections: Array<Record<string, unknown>> } };
        query.data.connections = [];
        const { ProviderSettingsIndex } = await import('./ProviderSettingsIndex');
        const screen = await renderInCollectionLayout(<ProviderSettingsIndex />, 'split');
        expect(screen.findAllByType('Redirect')).toHaveLength(0);
        await waitForHomeGovernance(() => expect(screen.findByTestId('settings-providers-invitation')).not.toBeNull());
        const picker = await openProviderPicker(screen, 'settings-providers-invitation-custom');
        await picker.modal.pressByTestIdAsync('providers.add:mode:custom');
        await waitForHomeGovernance(() => expect(picker.modal.findByTestId('settings-provider-authoring')).not.toBeNull());
        expect(routerPush).not.toHaveBeenCalled();
    });

    it.each(['page', 'landing'] as const)('offers guarded Account authoring in the no-machine %s presentation', async (presentation) => {
        await account.publishMachines(account.serverId, []);
        await account.selectMachine(account.serverId, null);
        const { ProviderSettingsIndex } = await import('./ProviderSettingsIndex');
        const { ProviderConnectionsSettingsScreen } = await import('./ProviderConnectionsSettingsScreen');
        const screen = presentation === 'landing'
            ? await renderInCollectionLayout(<ProviderSettingsIndex />, 'split')
            : await renderScreen(<ProviderConnectionsSettingsScreen variant="page" />);
        // Empty Account configuration leads directly to authoring; no machine setup is needed.
        const authoringId = 'settings-providers-invitation-custom';
        await waitForHomeGovernance(() => expect(screen.findHostByTestId(authoringId)).not.toBeNull());
        const picker = await openProviderPicker(screen, authoringId);
        await picker.modal.pressByTestIdAsync('providers.add:mode:custom');
        await waitForHomeGovernance(() => expect(picker.modal.findByTestId('settings-provider-authoring')).not.toBeNull());
        expect(routerPush).not.toHaveBeenCalled();
        expect(routerReplace).not.toHaveBeenCalled();
        expect(providerHarness.state.requests).toHaveLength(0);
    });

    it('says what failed and offers its recovery when a wide collection cannot read its Account', async () => {
        account.home.answer(account.serverId, `GET ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, { status: 503, body: { error: 'unavailable' } });
        const { ProviderSettingsIndex } = await import('./ProviderSettingsIndex');
        const screen = await renderInCollectionLayout(<ProviderSettingsIndex />, 'split');
        await waitForHomeGovernance(() => expect(providerErrorState(screen)?.props.diagnosticCode).toBe('provider_catalog_unavailable'));
        expect(providerErrorState(screen)?.props.action.label).toBe('settingsProviders.errors.actions.retry');
        expect(screen.findByTestId('settings-providers-invitation')).toBeNull();

        // Recovery admits the Account, then augments it from the exact machine and lands on its connection.
        const describeReads = () => providerHarness.state.requests.filter(
            (request) => request.method === RPC_METHODS.DAEMON_PROVIDERS_CONNECTIONS_DESCRIBE,
        ).length;
        const readsBefore = describeReads();
        account.home.answer(account.serverId, `GET ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, { body: {
            status: 'present', revision: 1, content: { t: 'plain', v: DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1 },
        } });
        state.describeReply = {
            loading: false, error: null,
            data: createProviderConnectionsDescribeFixture({ connections: [createProviderConnectionViewFixture({ connectionId: 'pc_a' })] }),
        };
        const retry = providerErrorState(screen)?.props.action;
        await React.act(async () => { await retry?.onPress?.(); });
        await flushHookEffects();
        expect(describeReads()).toBe(readsBefore + 1);
        await waitForHomeGovernance(() => expect(screen.findByTestId('settings-providers-home')).not.toBeNull());
    });

    it('keeps the Overview when a later read fails', async () => {
        const { ProviderSettingsIndex } = await import('./ProviderSettingsIndex');
        const screen = await renderInCollectionLayout(<ProviderSettingsIndex />, 'split');
        await waitForHomeGovernance(() => expect(screen.findByTestId('settings-providers-home')).not.toBeNull());

        (state.describeReply as { error: ReturnType<typeof createProviderErrorV1> | null }).error =
            createProviderErrorV1('provider_endpoint_unavailable', { machineId: 'machine-a' });
        await React.act(async () => {
            navigationState.focused = false;
            for (const listener of navigationState.focusListeners) listener();
        });
        await React.act(async () => {
            navigationState.focused = true;
            for (const listener of navigationState.focusListeners) listener();
        });
        await flushHookEffects();
        // The error does not replace what it already knows.
        expect(screen.findByTestId('settings-providers-home')).not.toBeNull();
        expect(screen.findAllByType(Item).map((item) => item.props.title))
            .not.toContain('settingsProviders.errors.unreachableTitle');
    });

    it('shows the new provider as a selected draft row while its editor is open', async () => {
        navigationState.pathname = '/settings/providers/new';
        const { ProviderConnectionsSettingsScreen } = await import('./ProviderConnectionsSettingsScreen');
        const element = (title: string) => <CollectionDraftTitleScope><DraftTitlePublisher title={title} />
            <ProviderConnectionsSettingsScreen variant="rail" /></CollectionDraftTitleScope>;
        const screen = await renderScreen(element(''));
        expect(screen.findAllByType(Item).find((item) => item.props.testID === 'settings-providers-draft')?.props.title).toBe('settingsProvidersCollection.newTitle');
        await screen.update(element('Company gateway'));
        expect(screen.findAllByType(Item).find((item) => item.props.testID === 'settings-providers-draft')?.props.title).toBe('Company gateway');
        expect(screen.findAllByType(Item).find((item) => item.props.testID === 'settings-providers-draft')?.props.selected).toBe(true);
    });

    it('keeps collection rows to identity and state: no switch beside a connection', async () => {
        const { ProviderConnectionsSettingsScreen } = await import('./ProviderConnectionsSettingsScreen');
        const screen = await renderScreen(<ProviderConnectionsSettingsScreen variant="rail" />);
        expect(findConnectionRow(screen, 'pc_a')?.props.rightElement).toBeUndefined();
        expect(screen.findAllByType(Switch)).toHaveLength(0);
    });

    it('retries the exact typed list mutation instead of substituting a catalog read', async () => {
        run.mockResolvedValue({
            status: 'error',
            error: createProviderErrorV1('provider_endpoint_unavailable', {
                connectionId: 'pc_a', machineId: 'machine-a',
            }),
        });
        const query = state.describeReply as { data: { discoveryCandidates: unknown[] } };
        query.data.discoveryCandidates = [{
            v: 1, machineId: 'machine-a', contributionKey: 'plugin/ollama',
            providerName: 'Ollama', endpointTemplateId: 'native',
            normalizedEndpointUrl: 'http://127.0.0.1:11435',
            candidateId: 'discovery-candidate:v1:exact-listener',
            evidence: { kind: 'attributed_listener' }, ownership: 'adopted',
            connection: { status: 'enable_default' },
        }];
        const { ProviderConnectionsSettingsScreen } = await import('./ProviderConnectionsSettingsScreen');
        const screen = await renderScreen(<ProviderConnectionsSettingsScreen />);

        await showFound(screen);
        await React.act(async () => { await findConnectAction(screen, 'Ollama')?.props.onPress?.(); });
        await waitForHomeGovernance(() => expect(providerErrorState(screen)?.props.action).toBeDefined());
        const retry = providerErrorState(screen)?.props.action;
        expect(retry).toBeDefined();
        await React.act(async () => { await retry?.onPress?.(); });

        await waitForHomeGovernance(() => expect(run).toHaveBeenCalledTimes(2));
        expect(run.mock.calls[1]).toEqual(run.mock.calls[0]);
    });

    it('preserves an unknown list mutation when its reconciliation read also fails', async () => {
        run.mockRejectedValueOnce(new Error('acknowledgement lost after dispatch'));
        const query = state.describeReply as { data: { discoveryCandidates: unknown[] } };
        query.data.discoveryCandidates = [{
            v: 1, machineId: 'machine-a', contributionKey: 'plugin/ollama',
            providerName: 'Ollama', endpointTemplateId: 'native',
            normalizedEndpointUrl: 'http://127.0.0.1:11435',
            candidateId: 'discovery-candidate:v1:exact-listener',
            evidence: { kind: 'attributed_listener' }, ownership: 'adopted',
            connection: { status: 'enable_default' },
        }];
        const { ProviderConnectionsSettingsScreen } = await import('./ProviderConnectionsSettingsScreen');
        const screen = await renderScreen(<ProviderConnectionsSettingsScreen />);
        const erroring = state.describeReply as { error: ReturnType<typeof createProviderErrorV1> | null };
        await showFound(screen);
        await waitForHomeGovernance(() => expect(findConnectAction(screen, 'Ollama')).toBeDefined());
        erroring.error = createProviderErrorV1('provider_endpoint_unavailable', {
            machineId: 'machine-a',
        });

        await React.act(async () => { await findConnectAction(screen, 'Ollama')?.props.onPress?.(); });

        const unknownMutationState = () => providerErrorState(screen, 'provider_rpc_mutation_outcome_unknown');
        await waitForHomeGovernance(() => expect(unknownMutationState()?.props.title).toBe('settingsProviders.errors.mutationOutcomeUnknownTitle'));
        const review = unknownMutationState()?.props.action;
        expect(review?.label).toBe('settingsProviders.errors.actions.reviewCurrentState');
        expect(review).toBeDefined();
        const readsBeforeReview = providerHarness.state.requests.filter(
            (request) => request.method === RPC_METHODS.DAEMON_PROVIDERS_CONNECTIONS_DESCRIBE,
        ).length;
        await React.act(async () => { await review?.onPress?.(); });

        expect(run).toHaveBeenCalledOnce();
        expect(providerHarness.state.requests.filter(
            (request) => request.method === RPC_METHODS.DAEMON_PROVIDERS_CONNECTIONS_DESCRIBE,
        )).toHaveLength(readsBeforeReview + 1);
    });

    it('keeps search and its no-results explanation when a refreshed collection becomes smaller', async () => {
        const query = state.describeReply as { data: { connections: Array<Record<string, unknown>>; available: Array<Record<string, unknown>> } };
        const exemplar = query.data.connections[0]!;
        query.data.connections = Array.from({ length: 10 }, (_, index) => ({
            ...exemplar,
            connectionId: `pc_${index}`,
            displayName: `Provider ${index}`,
            providerName: `Provider ${index}`,
        }));
        query.data.available = [];
        const { ProviderConnectionsSettingsScreen } = await import('./ProviderConnectionsSettingsScreen');
        const screen = await renderScreen(<ProviderConnectionsSettingsScreen />);
        const titles = () => screen.findAllByType(Item).map((item) => item.props.title);
        await waitForHomeGovernance(() => expect(screen.findByTestId('settings-providers-search')).not.toBeNull());
        await React.act(async () => { screen.changeTextByTestId('settings-providers-search', 'not-a-provider'); });
        expect(titles()).toContain('settingsProviders.searchEmptyTitle');
        expect(titles()).not.toContain('settingsProviders.emptyTitle');

        query.data.connections = [exemplar];
        await screen.update(<ProviderConnectionsSettingsScreen active={false} />);
        await screen.update(<ProviderConnectionsSettingsScreen active />);
        expect(screen.findHostByTestId('settings-providers-search')?.props.value).toBe('not-a-provider');
        expect(titles()).toContain('settingsProviders.searchEmptyTitle');
    });

    it('shows first-load skeletons until the configured empty state is known', async () => {
        const firstRead = createDeferred<void>();
        account.home.answer(account.serverId, `GET ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, { body: {
            status: 'present', revision: 1, content: { t: 'plain', v: DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1 },
        }, respondAfter: firstRead.promise });
        const { ProviderConnectionsSettingsScreen } = await import('./ProviderConnectionsSettingsScreen');
        const loading = await renderScreen(<ProviderConnectionsSettingsScreen />);
        expect(loading.findByTestId('settings-providers-skeleton')).not.toBeNull();

        state.describeReply = {
            loading: false, error: null,
            data: { status: 'success', diagnostics: [], diagnosticsTruncated: false, availableTruncated: false, discoveryCandidates: [], discoveryCandidatesTruncated: false, localInstallations: [], connections: [], available: [] },
        };
        await React.act(async () => { firstRead.resolve(); await flushHookEffects(); });
        await waitForHomeGovernance(() => expect(loading.findByTestId('settings-providers-invitation')).not.toBeNull());
        expect(loading.findByTestId('settings-providers-skeleton')).toBeNull();
    });

    it('invites a narrow collection with nothing to list the same way as a wide one (lab PI1p)', async () => {
        const query = state.describeReply as { data: { connections: Array<Record<string, unknown>> } };
        query.data.connections = [];
        const { ProviderSettingsIndex } = await import('./ProviderSettingsIndex');
        const screen = await renderInCollectionLayout(<ProviderSettingsIndex />, 'stacked');
        await waitForHomeGovernance(() => expect(screen.findByTestId('settings-providers-invitation')).not.toBeNull());
        expect(screen.findAllByType(Item).map((item) => item.props.title)).not.toContain('settingsProviders.emptyTitle');
        const picker = await openProviderPicker(screen, 'settings-providers-invitation-custom');
        await picker.modal.pressByTestIdAsync('providers.add:mode:custom');
        await waitForHomeGovernance(() => expect(picker.modal.findByTestId('settings-provider-authoring')).not.toBeNull());
        expect(routerPush).not.toHaveBeenCalled();
    });

    it('retains Account rows while the Found view retries a typed Machine refresh failure', async () => {
        installProviderConnectionsCatalogHttpBoundary({ home: account.home, serverId: account.serverId,
            catalog: ProviderConnectionsCatalogV1Schema.parse({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
                connections: [ProviderConnectionV1Schema.parse({ v: 1, id: 'pc_a', source: { kind: 'custom', template: buildCustomProviderTemplate({
                    ...createCustomProviderDraft('openai-chat'), name: 'Acme', baseUrl: 'https://acme.test/v1', requiresApiKey: false, catalog: 'manual',
                }) }, role: 'named', displayName: 'Acme', displayNameMode: 'custom', revision: 1, createdAt: 1, updatedAt: 1 })] }),
        });
        const query = state.describeReply as {
            data: ReturnType<typeof createProviderConnectionsDescribeFixture>;
            error: ReturnType<typeof createProviderErrorV1> | null;
        };
        query.data.connections[0] = createProviderConnectionViewFixture({
            contributionKey: null, role: 'named', displayNameMode: 'custom', displayName: 'Acme', providerName: 'Acme',
        });
        const { ProviderConnectionsSettingsScreen } = await import('./ProviderConnectionsSettingsScreen');
        const screen = await renderScreen(<ProviderConnectionsSettingsScreen />);
        query.error = createProviderErrorV1('provider_endpoint_unreachable', {
            machineId: 'machine-a',
        });
        await screen.update(<ProviderConnectionsSettingsScreen active={false} />);
        await screen.update(<ProviderConnectionsSettingsScreen active />);

        expect(screen.findAllByType(Item).map((item) => item.props.title)).toContain('Acme');
        // Account connections remain usable; the optional Machine failure belongs to its Found view.
        await showFound(screen);
        await waitForHomeGovernance(() => expect(providerErrorState(screen)?.props.title).toBe('settingsProviders.errors.unreachableTitle'));
        expect(providerErrorState(screen)?.props.action.label).toBe('settingsProviders.errors.actions.retry');
        query.error = null;
        await screen.pressByTestIdAsync('provider-error-action:provider_endpoint_unreachable');
        await waitForHomeGovernance(() => expect(providerErrorState(screen)).toBeUndefined());
        await screen.pressByTestIdAsync('settings-providers-view:all');
        expect(findConnectionRow(screen, 'pc_a')).not.toBeNull();
    });

    it('renders an attributed local candidate only when local discovery is enabled', async () => {
        const query = state.describeReply as { data: { discoveryCandidates: unknown[] } };
        query.data.discoveryCandidates = [{
            v: 1, machineId: 'machine-a', contributionKey: 'plugin/ollama',
            providerName: 'Ollama', endpointTemplateId: 'native',
            normalizedEndpointUrl: 'http://127.0.0.1:11435',
            evidence: { kind: 'attributed_listener' }, ownership: 'adopted',
            connection: { status: 'enable_default' },
        }];
        const { ProviderConnectionsSettingsScreen } = await import('./ProviderConnectionsSettingsScreen');
        const shown = await renderScreen(React.createElement(ProviderConnectionsSettingsScreen));
        await showFound(shown);
        expect(shown.findAllByType(Item).map((item) => item.props.title)).toContain('Ollama');

        await account.publishFeatures(account.serverId, createRootLayoutFeaturesResponse({ features: {
            providers: { enabled: true, localDiscovery: { enabled: false } },
        } }));
        const hidden = await renderScreen(React.createElement(ProviderConnectionsSettingsScreen));
        await showFound(hidden);
        expect(hidden.findAllByType(Item).filter((item) => item.props.title === 'Ollama')).toHaveLength(0);
    });

    it('qualifies same-provider Connect actions with their exact endpoint identity', async () => {
        const query = state.describeReply as { data: { discoveryCandidates: unknown[] } };
        query.data.discoveryCandidates = [11434, 11435].map((port) => ({
            v: 1, machineId: 'machine-a', contributionKey: 'plugin/ollama',
            providerName: 'Ollama', endpointTemplateId: 'native',
            normalizedEndpointUrl: `http://127.0.0.1:${port}`,
            evidence: { kind: 'attributed_listener' }, ownership: 'adopted',
            connection: { status: 'enable_default' },
        }));
        const { ProviderConnectionsSettingsScreen } = await import('./ProviderConnectionsSettingsScreen');
        const screen = await renderScreen(<ProviderConnectionsSettingsScreen />);
        await showFound(screen);
        const labels = screen.findAllByType(Item)
            .filter((item) => item.props.title === 'Ollama')
            .map((item) => item.props.rightElement.props.accessibilityLabel);

        expect(labels).toEqual([
            'settingsProvidersCollection.connect: Ollama, http://127.0.0.1:11434/',
            'settingsProvidersCollection.connect: Ollama, http://127.0.0.1:11435/',
        ]);
    });

    it('lists a detected server already matched to a connection only as that connection', async () => {
        const query = state.describeReply as { data: { discoveryCandidates: unknown[] } };
        query.data.discoveryCandidates = [{
            v: 1, machineId: 'machine-a', contributionKey: 'plugin/acme',
            providerName: 'Acme', endpointTemplateId: 'native',
            normalizedEndpointUrl: 'https://api.acme.example',
            evidence: { kind: 'attributed_listener' }, ownership: 'adopted',
            connection: { status: 'matched', connectionId: 'pc_a' },
        }];
        const { ProviderConnectionsSettingsScreen } = await import('./ProviderConnectionsSettingsScreen');
        const screen = await renderScreen(<ProviderConnectionsSettingsScreen />);
        await waitForHomeGovernance(() => expect(findConnectionRow(screen, 'pc_a')).not.toBeNull());
        const acmeRows = screen.findAllByType(Item).filter((item) => item.props.title === 'Acme');

        expect(acmeRows.map((item) => item.props.testID)).toEqual(['settings-provider-connection:pc_a']);
    });

    it('enables an exact detected endpoint through the canonical mutation action', async () => {
        const query = state.describeReply as { data: { discoveryCandidates: unknown[] } };
        query.data.discoveryCandidates = [{
            v: 1, machineId: 'machine-a', contributionKey: 'plugin/ollama',
            providerName: 'Ollama', endpointTemplateId: 'native',
            normalizedEndpointUrl: 'http://127.0.0.1:11435',
            candidateId: 'discovery-candidate:v1:exact-listener',
            evidence: { kind: 'default_port_hint' }, ownership: 'adopted',
            connection: { status: 'enable_default' },
        }];
        const { ProviderConnectionsSettingsScreen } = await import('./ProviderConnectionsSettingsScreen');
        const screen = await renderScreen(React.createElement(ProviderConnectionsSettingsScreen));
        await showFound(screen);
        await React.act(async () => {
            await findConnectAction(screen, 'Ollama')?.props.onPress?.();
        });

        await waitForHomeGovernance(() => expect(run).toHaveBeenCalledWith(expect.objectContaining({
            action: 'enableDetected', machineId: 'machine-a',
            candidateId: 'discovery-candidate:v1:exact-listener',
            displayName: null, savedSecretId: null,
        }), 'detected:plugin/ollama:http://127.0.0.1:11435'));
        expect(run.mock.calls[0]?.[0]).not.toHaveProperty('contributionKey');
        expect(run.mock.calls[0]?.[0]).not.toHaveProperty('endpointTemplateId');
        expect(run.mock.calls[0]?.[0]).not.toHaveProperty('normalizedEndpointUrl');
    });

    it('fails closed with review-required recovery when an older daemon omits candidate identity', async () => {
        const query = state.describeReply as { data: { discoveryCandidates: unknown[] } };
        query.data.discoveryCandidates = [{
            v: 1, machineId: 'machine-a', contributionKey: 'plugin/ollama',
            providerName: 'Ollama', endpointTemplateId: 'native',
            normalizedEndpointUrl: 'http://127.0.0.1:11435',
            evidence: { kind: 'default_port_hint' }, ownership: 'adopted',
            connection: { status: 'enable_default' },
        }];
        const { ProviderConnectionsSettingsScreen } = await import('./ProviderConnectionsSettingsScreen');
        const screen = await renderScreen(<ProviderConnectionsSettingsScreen />);
        await showFound(screen);
        await React.act(async () => { await findConnectAction(screen, 'Ollama')?.props.onPress?.(); });

        expect(run).not.toHaveBeenCalled();
        expect(providerErrorState(screen)?.props.title).toBe('settingsProviders.errors.accessChangedTitle');
    });

    it('opens the shared authoring draft before creating a named discovered connection', async () => {
        const query = state.describeReply as { data: { discoveryCandidates: unknown[] } };
        query.data.discoveryCandidates = [{
            v: 1, machineId: 'machine-a', contributionKey: 'plugin/ollama',
            providerName: 'Ollama', endpointTemplateId: 'native',
            normalizedEndpointUrl: 'http://127.0.0.1:22434',
            candidateId: 'discovery-candidate:v1:named',
            evidence: { kind: 'attributed_listener' }, ownership: 'adopted',
            connection: { status: 'requires_named_connection' },
        }];
        const { ProviderConnectionsSettingsScreen } = await import('./ProviderConnectionsSettingsScreen');
        const screen = await renderScreen(<ProviderConnectionsSettingsScreen />);
        const picker = await openProviderPicker(screen);
        const candidate = () => picker.config().catalog.items.find((row: { kind: string; found?: { candidate?: { candidateId?: string } } }) =>
            row.kind === 'found' && row.found?.candidate?.candidateId === 'discovery-candidate:v1:named');
        await waitForHomeGovernance(() => expect(candidate()).toBeDefined());
        await picker.select(candidate().key);
        expect(run).not.toHaveBeenCalled();
        await picker.modal.pressByTestIdAsync('providers.add:primary');

        expect(run).not.toHaveBeenCalled();
        expect(routerPush).toHaveBeenCalledWith(expect.stringContaining(
            '/settings/providers/new?contributionKey=plugin%2Follama&candidateId=discovery-candidate%3Av1%3Anamed',
        ));
        expect(routerPush).toHaveBeenCalledWith(expect.stringContaining('displayName='));
    });

    it('opens the second discovered draft when Connect replaces the first on the same Machine', async () => {
        const candidates = [11434, 22434].map(port => ({
            v: 1 as const, machineId: machine.id, contributionKey: 'plugin/ollama',
            providerName: `Ollama on ${port}`, endpointTemplateId: 'native',
            normalizedEndpointUrl: `http://127.0.0.1:${port}/`,
            candidateId: `discovery-candidate:v1:${port}`,
            evidence: { kind: 'attributed_listener' as const }, ownership: 'adopted' as const,
            connection: { status: 'requires_named_connection' as const },
        }));
        const query = state.describeReply as { data: ReturnType<typeof createProviderConnectionsDescribeFixture> };
        query.data = createProviderConnectionsDescribeFixture({
            ...query.data,
            discoveryCandidates: candidates,
            available: [{
                contributionKey: 'plugin/ollama', name: 'Ollama', kind: 'local', provenance: 'external',
                icon: null, credential: null, endpointTemplates: [],
            }],
        });
        const { ProviderConnectionsSettingsScreen } = await import('./ProviderConnectionsSettingsScreen');
        const { NewProviderConnectionRoute } = await import('@/app/(app)/settings/providers/new');
        navigationState.pathname = '/settings/providers/pc_a';
        const rail = await renderScreen(<ProviderConnectionsSettingsScreen variant="rail" />);
        await showFound(rail);

        const connect = async (candidate: typeof candidates[number]) => {
            await waitForHomeGovernance(() => expect(findConnectAction(rail, candidate.providerName)).toBeDefined());
            routerReplace.mockClear();
            await React.act(async () => { findConnectAction(rail, candidate.providerName)!.props.onPress?.(); });
            expect(routerReplace).toHaveBeenCalledWith(expect.stringContaining('/settings/providers/new?'));
            const href: string = routerReplace.mock.lastCall![0];
            navigationState.pathname = '/settings/providers/new';
            navigationState.params = Object.fromEntries(new URLSearchParams(href.split('?')[1]));
        };
        await connect(candidates[0]);
        const authoring = await renderScreen(<NewProviderConnectionRoute />);
        const expectPreview = (candidate: typeof candidates[number]) => waitForHomeGovernance(() =>
            expect(providerConnectionReads().findLast(request =>
                Boolean((request.payload as { authoringPreview?: unknown }).authoringPreview),
            )).toMatchObject({
                machineId: machine.id,
                payload: { authoringPreview: { selectedCandidateId: candidate.candidateId } },
            }));
        await expectPreview(candidates[0]);
        expect(authoring.findByTestId('settings-provider-authoring-name')?.props.value).toContain(candidates[0].providerName);

        await connect(candidates[1]);
        await authoring.update(<NewProviderConnectionRoute />);

        await expectPreview(candidates[1]);
        expect(authoring.findByTestId('settings-provider-authoring-name')?.props.value).toContain(candidates[1].providerName);
    });

    it('preserves the daemon candidate identity when credential recovery opens authoring', async () => {
        const query = state.describeReply as { data: { discoveryCandidates: unknown[] } };
        query.data.discoveryCandidates = [{
            v: 1, machineId: 'machine-a', contributionKey: 'plugin/ollama',
            providerName: 'Ollama', endpointTemplateId: 'native',
            normalizedEndpointUrl: 'http://127.0.0.1:22434',
            candidateId: 'discovery-candidate:v1:exact',
            evidence: { kind: 'attributed_listener' }, ownership: 'adopted',
            connection: { status: 'enable_default' },
        }];
        run.mockResolvedValueOnce({
            status: 'error',
            error: createProviderErrorV1('provider_secret_missing', {
                connectionId: 'pc_new', machineId: 'machine-a',
            }),
        });
        const { ProviderConnectionsSettingsScreen } = await import('./ProviderConnectionsSettingsScreen');
        const screen = await renderScreen(<ProviderConnectionsSettingsScreen />);
        await showFound(screen);
        await React.act(async () => {
            await findConnectAction(screen, 'Ollama')?.props.onPress?.();
        });

        await waitForHomeGovernance(() => expect(routerPush).toHaveBeenCalledWith(expect.stringContaining(
            'candidateId=discovery-candidate%3Av1%3Aexact',
        )));
        expect(routerPush).toHaveBeenCalledWith(expect.not.stringContaining('normalizedEndpointUrl'));
    });

    it('renders verified installed and app-running states without claiming endpoint availability', async () => {
        const query = state.describeReply as { data: { localInstallations: unknown[] } };
        query.data.localInstallations = [
            { v: 1, machineId: 'machine-a', contributionKey: 'plugin/ollama', providerName: 'Ollama', status: 'installed_not_running', managedStartAvailable: false },
            { v: 1, machineId: 'machine-a', contributionKey: 'plugin/lmstudio', providerName: 'LM Studio', status: 'app_running_server_off', managedStartAvailable: false },
        ];
        const { ProviderConnectionsSettingsScreen } = await import('./ProviderConnectionsSettingsScreen');
        const screen = await renderScreen(React.createElement(ProviderConnectionsSettingsScreen));
        await showFound(screen);
        const rows = screen.findAllByType(Item);
        for (const [title, label] of [['Ollama', 'settingsProviders.local.installedNotRunning'],
            ['LM Studio', 'settingsProviders.local.appRunningServerOff']]) {
            const row = rows.find(row => row.props.title === title);
            // The state leads line 2 in words; the row's end stays free for its action.
            expect(row?.props.subtitle?.props).toMatchObject({ status: 'off', label });
            expect(row?.props.subtitleLeading).toBeUndefined();
            expect(row?.props.rightElement).toBeUndefined();
        }
    });

    it('counts only the Provider rows listed by the selected collection view', async () => {
        const query = state.describeReply as { data: { localInstallations: unknown[] } };
        query.data.localInstallations = [
            { v: 1, machineId: 'machine-a', contributionKey: 'plugin/ollama', providerName: 'Ollama', status: 'installed_not_running', managedStartAvailable: false },
            { v: 1, machineId: 'machine-a', contributionKey: 'plugin/lmstudio', providerName: 'LM Studio', status: 'app_running_server_off', managedStartAvailable: false },
        ];
        const { ProviderConnectionsSettingsScreen } = await import('./ProviderConnectionsSettingsScreen');
        const { CollectionList } = await import('@/components/ui/lists/collection/CollectionList');
        const screen = await renderScreen(<ProviderConnectionsSettingsScreen variant="rail" />);
        await waitForHomeGovernance(() => expect(findConnectionRow(screen, 'pc_a')).not.toBeNull());
        expect(screen.findByType(CollectionList).props.count).toBe(1);
        await showFound(screen);
        await waitForHomeGovernance(() => expect(screen.findAllByType(Item).map(row => row.props.title)).toContain('Ollama'));
        expect(findConnectionRow(screen, 'pc_a')).toBeNull();
        expect(screen.findByType(CollectionList).props.count).toBe(2);
    });

    it('deduplicates discovery and installation rows sharing one canonical contribution key', async () => {
        const query = state.describeReply as { data: { discoveryCandidates: unknown[]; localInstallations: unknown[] } };
        query.data.discoveryCandidates = [{
            v: 1, machineId: 'machine-a', contributionKey: 'acme.plugin/ollama',
            providerName: 'Ollama', endpointTemplateId: 'native',
            normalizedEndpointUrl: 'http://127.0.0.1:11434',
            evidence: { kind: 'attributed_listener' }, ownership: 'adopted',
            connection: { status: 'enable_default' },
        }];
        query.data.localInstallations = [{
            v: 1, machineId: 'machine-a', contributionKey: 'acme.plugin/ollama',
            providerName: 'Ollama', status: 'installed_not_running', managedStartAvailable: false,
        }];

        const { ProviderConnectionsSettingsScreen } = await import('./ProviderConnectionsSettingsScreen');
        const screen = await renderScreen(<ProviderConnectionsSettingsScreen />);
        await showFound(screen);
        expect(screen.findAllByType(Item).filter((item) => item.props.title === 'Ollama')).toHaveLength(1);
    });

    it('offers managed Start only when the daemon projects the exact capability', async () => {
        const query = state.describeReply as { data: { localInstallations: unknown[] } };
        query.data.localInstallations = [
            { v: 1, machineId: 'machine-a', contributionKey: 'plugin/ollama', providerName: 'Ollama', status: 'installed_not_running', managedStartAvailable: true },
            { v: 1, machineId: 'machine-a', contributionKey: 'plugin/lmstudio', providerName: 'LM Studio', status: 'installed_not_running', managedStartAvailable: false },
        ];
        run.mockResolvedValueOnce({ status: 'success', action: 'startLocal', contributionKey: 'plugin/ollama', phase: 'detecting' });
        const { ProviderConnectionsSettingsScreen } = await import('./ProviderConnectionsSettingsScreen');
        const screen = await renderScreen(React.createElement(ProviderConnectionsSettingsScreen));
        await showFound(screen);
        const rows = screen.findAllByType(Item);
        const startButton = rows.find((row) => row.props.title === 'Ollama')?.props.rightElement;

        expect(startButton).toBeTruthy();
        expect(screen.findByTestId('settings-provider-found-start:installation:plugin/lmstudio')).toBeNull();
        expect(rows.find(row => row.props.title === 'LM Studio')?.props.subtitle.props).toMatchObject({
            status: 'off', label: 'settingsProviders.local.installedNotRunning',
        });
        await React.act(async () => {
            await startButton.props.onPress?.();
        });
        await waitForHomeGovernance(() => expect(run).toHaveBeenCalledWith(expect.objectContaining({
            action: 'startLocal', machineId: 'machine-a', contributionKey: 'plugin/ollama',
            connectionId: expect.stringMatching(/^pc_/u),
        }), 'start:plugin/ollama'));
    });

    it('shows the existing pending spinner while managed Start awaits readiness', async () => {
        const query = state.describeReply as { data: { localInstallations: unknown[] } };
        query.data.localInstallations = [{
            v: 1, machineId: 'machine-a', contributionKey: 'plugin/ollama',
            providerName: 'Ollama', status: 'installed_not_running', managedStartAvailable: true,
        }];
        const deferred = createDeferred<Readonly<{
            status: 'success'; action: 'startLocal'; contributionKey: string; phase: 'running';
        }>>();
        run.mockReturnValueOnce(deferred.promise);
        const { ProviderConnectionsSettingsScreen } = await import('./ProviderConnectionsSettingsScreen');
        const screen = await renderScreen(<ProviderConnectionsSettingsScreen />);
        await showFound(screen);
        const startButton = screen.findAllByType(Item)
            .find((row) => row.props.title === 'Ollama')?.props.rightElement;
        let startPromise!: Promise<void>;

        await React.act(async () => {
            startPromise = startButton.props.onPress();
            await Promise.resolve();
        });
        expect(screen.findAllByType(Item)
            .find((row) => row.props.title === 'Ollama')?.props.rightElement.type.name)
            .toBe('ActivitySpinner');

        deferred.resolve({
            status: 'success', action: 'startLocal',
            contributionKey: 'plugin/ollama', phase: 'running',
        });
        await React.act(async () => { await startPromise; });
    });

    it('retries the exact managed Start after a typed local endpoint failure', async () => {
        const query = state.describeReply as { data: { localInstallations: unknown[] } };
        query.data.localInstallations = [{
            v: 1,
            machineId: 'machine-a',
            contributionKey: 'plugin/ollama',
            providerName: 'Ollama',
            status: 'installed_not_running',
            managedStartAvailable: true,
        }];
        run.mockResolvedValue({
            status: 'error',
            error: createProviderErrorV1('provider_endpoint_unavailable', { machineId: 'machine-a' }),
        });
        const { ProviderConnectionsSettingsScreen } = await import('./ProviderConnectionsSettingsScreen');
        const screen = await renderScreen(<ProviderConnectionsSettingsScreen />);
        await showFound(screen);
        const startButton = screen.findAllByType(Item)
            .find((row) => row.props.title === 'Ollama')?.props.rightElement;

        await React.act(async () => { await startButton?.props.onPress?.(); });
        await waitForHomeGovernance(() => expect(providerErrorState(screen)?.props.action).toBeDefined());
        const retry = providerErrorState(screen)?.props.action;
        expect(retry).toBeDefined();
        expect(providerErrorState(screen)?.props.title).not.toBe('settingsProviders.errors.connectionInvalidTitle');
        await React.act(async () => { await retry?.onPress?.(); });

        await waitForHomeGovernance(() => expect(run).toHaveBeenCalledTimes(2));
        expect(run.mock.calls[1]).toEqual(run.mock.calls[0]);
        expect(routerPush).not.toHaveBeenCalled();
    });
});
