import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import { profileDefaults } from '@/sync/domains/profiles/profile';
import { storage } from '@/sync/domains/state/storageStore';

import { renderScreen } from '@/dev/testkit';
import type { ConnectedAccountIndexFacts } from './index/ConnectedAccountIndexRow';
import type { ConnectedServicesConnectMore } from './setup/ConnectedServicesConnectMore';

import { connectedServicesModuleState, installConnectedServicesCommonModuleMocks } from './connectedServicesTestHelpers';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// P8 / O-COLUMNS-R3: these are overview rows, not the phone collection index.
installConnectedServicesCommonModuleMocks({ searchParams: { view: 'all' } });
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');

const profileState = vi.hoisted(() => ({
    connectedServicesV2: [] as Array<Record<string, unknown>>,
    connectedAccountsV4: [] as Array<Record<string, unknown>>,
    connectedAccountGroupsV4: [] as Array<Record<string, unknown>>,
}));
const registryState = vi.hoisted(() => ({
    status: 'ready' as 'loading' | 'ready' | 'stale' | 'error' | 'conflict',
    errorReason: null as string | null,
    entries: [] as Array<Record<string, unknown>>,
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => false,
}));

vi.mock('@/sync/domains/features/featureDecisionRuntime', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/sync/domains/features/featureDecisionRuntime')>()),
    useServerFeaturesRuntimeSnapshot: () => ({
        status: 'ready',
        features: {
            capabilities: {
                connectedServices: { qualifiedAccounts: { protocolVersion: 4 } },
            },
        },
    }),
}));


vi.mock('@/hooks/teams/useHomeTeamCredentialModelCatalog', () => ({
    useHomeTeamCredentialModelCatalog: () => ({
        resources: [], teamNameById: {}, homeNameByTeamId: {}, resourceStatusByKey: new Map(), current: true, condition: null,
    }),
}));

vi.mock('@/components/appShell/plugins/AppShellPluginUiProjection', () => ({
    useAppShellPluginUiProjection: () => ({ machineId: null, serverId: null }),
    useProjectedPluginLocalizedTextResolver: () => (_pluginId: string, value: unknown) => (typeof value === 'string' ? value : ''),
    useProjectedConnectedServicesRegistry: () => ({
        scopeKey: 'server-1',
        status: registryState.status,
        errorReason: registryState.errorReason,
        entries: registryState.entries,
    }),
}));

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
vi.mock('@/sync/domains/state/warmCachePersistence', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/sync/domains/state/warmCachePersistence')>()),
    loadUsageSummaryWarmCache: () => null,
    saveUsageSummaryWarmCache: () => {},
}));
// The agent projection is a machine read; without it, every service stays with the agent accounts.
vi.mock('@/agents/backendCatalog/useDaemonMergedProjectionInputs', () => ({
    useDaemonMergedProjectionInputs: () => ({ phase: 'ready', inputs: null }),
}));

vi.mock('./index/ConnectedAccountIndexRow', async (importOriginal) => ({
    ...(await importOriginal<typeof import('./index/ConnectedAccountIndexRow')>()),
    ConnectedAccountIndexLiveFacts: ({ render }: { render: (facts: ConnectedAccountIndexFacts) => React.ReactElement }) => render({
        usage: { kind: 'none' }, planLabel: null, subscription: null, recoveryCredits: null,
        fetchedAt: null, staleSince: null, refreshing: false, refresh: null,
    }),
}));
vi.mock('./setup/ConnectedServicesConnectMore', () => ({
    ConnectedServicesConnectMore: (props: React.ComponentProps<typeof ConnectedServicesConnectMore>) =>
        React.createElement('ConnectedServicesConnectMore', props),
}));

vi.mock('./ConnectedServicesDefaultAuthRow', () => ({
    ConnectedServicesDefaultAuthRow: (props: Record<string, unknown>) =>
        React.createElement('ConnectedServicesDefaultAuthRow', props),
}));

vi.mock('./ConnectedServicesProviderStateSharingSettings', () => ({
    ConnectedServicesProviderStateSharingDisclosure: (props: Record<string, unknown>) =>
        React.createElement('ConnectedServicesProviderStateSharingDisclosure', props),
}));


// Keep the group props on the host stand-in so the screen's section headings
// stay inspectable (the list group and the dev-only usage summary must not
// present the same heading twice in a row).

// `Item` owns the fixed leading slot; render `leftElement` and `titleAccessory` so the brand mark
// and the state pill are actually mounted and inspectable in the tree.

// The generic fallback glyph draws through Hugeicons/Phosphor primitives; a host
// stand-in keeps the resolved `name` assertable without the drawing stack.
vi.mock('@/components/ui/icons/Icon', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    Icon: (props: Record<string, unknown>) => React.createElement('Icon', props),
}));

const REGISTRY_ENTRIES: Array<Record<string, unknown>> = [
    // Registry arrival order deliberately differs from qualified identity order.
    {
        serviceId: 'github', legacyServiceId: 'github',
        service: { pluginId: 'happier.scm.forge.github', localId: 'github-account' },
        connectCommand: 'happier connect github', supportsOauth: true, executable: true, projectedTitle: 'GitHub',
    },
    {
        serviceId: 'anthropic', legacyServiceId: 'anthropic',
        service: { pluginId: 'happier.agent.claude', localId: 'anthropic' },
        connectCommand: 'happier connect anthropic', supportsOauth: true, executable: true, projectedTitle: 'Anthropic',
    },
    {
        serviceId: 'vault',
        service: { pluginId: 'acme.connected-accounts-conformance', localId: 'vault' },
        connectCommand: 'happier connect acme.connected-accounts-conformance/vault',
        supportsOauth: true,
        executable: true,
        projectedTitle: 'Acme Vault',
    },
    {
        serviceId: 'openai-codex', legacyServiceId: 'openai-codex',
        service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
        connectCommand: 'happier connect openai-codex', supportsOauth: true, executable: true, projectedTitle: 'OpenAI Codex',
    },
];

const PROFILES = [
    {
        ref: { service: { pluginId: 'happier.scm.forge.github', localId: 'github-account' }, accountId: 'personal' },
        status: 'connected', authenticationModeId: 'oauth', revisionSemantics: 'revisioned', credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa', configurationReady: true, configurationRevision: null, scopes: [],
    },
    {
        ref: { service: { pluginId: 'happier.agent.claude', localId: 'anthropic' }, accountId: 'work' },
        status: 'refresh_failed_retryable', authenticationModeId: 'oauth', revisionSemantics: 'revisioned', credentialRevision: 'csr_bbbbbbbbbbbbbbbbbbbbbb', configurationReady: true, configurationRevision: null, scopes: [],
    },
    {
        ref: { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'work' },
        status: 'needs_reauth', authenticationModeId: 'oauth', revisionSemantics: 'revisioned', credentialRevision: 'csr_cccccccccccccccccccccc', configurationReady: true, configurationRevision: null, scopes: [],
    },
];

async function renderView(child?: React.ReactElement) {
    storage.setState({ profile: AccountProfileSchema.parse({ ...profileDefaults, ...profileState }) });
    const { ConnectedServicesSettingsView } = await import('./ConnectedServicesSettingsView');
    const { DestinationInstanceContext } = await import('@/components/appShell/workspace/destinationInstanceContext');
    const { router } = await import('expo-router');
    const { tree } = await renderScreen(<DestinationInstanceContext.Provider value={{ tabId: 'services-overview',
        ref: { kind: 'settings', params: connectedServicesModuleState.searchParams }, pathname: '/settings/connected-services',
        focused: true, isFocused: () => true, visible: true, navigation: router,
    }}><InjectedAuthProvider credentials={null}>{child ?? <ConnectedServicesSettingsView />}</InjectedAuthProvider></DestinationInstanceContext.Provider>);
    return tree;
}


function accountRows(tree: Awaited<ReturnType<typeof renderView>>) {
    // Credentials is one presentation (crHome A): every account is a row of its section, led by its service's mark.
    return tree.root.findAll((node) => Boolean(node.props?.facts && node.props?.accountId && node.props?.legacyServiceId !== undefined));
}

describe('ConnectedServicesSettingsView row presentation', () => {
    const initialState = storage.getState();
    afterEach(() => storage.setState(initialState, true));
    // The page's module graph is large; loading it once up front keeps each case's own time honest.
    beforeAll(async () => {
        await import('./ConnectedServicesSettingsView');
    }, 180_000);

    beforeEach(() => {
        // These cases read the list presentation; a device that never chose shows cards (R7).
        storage.getState().applyLocalSettings({ connectedServicesIndexViewV1: 'list' });
        connectedServicesModuleState.searchParams = { view: 'all' };
        registryState.status = 'ready';
        registryState.errorReason = null;
        registryState.entries = REGISTRY_ENTRIES.map((entry) => ({ ...entry }));
        profileState.connectedServicesV2 = [];
        profileState.connectedAccountsV4 = PROFILES.map((profile) => ({ ...profile }));
        profileState.connectedAccountGroupsV4 = [];
    });

    it('orders accounts by their services\' qualified identity, leaving services without accounts to setup', async () => {
        const services = accountRows(await renderView()).map((row) => String(row.props.testID).split(':')[1]);

        // Needs you leads with the signed-out ChatGPT account; the sections then follow the services' order.
        expect([...new Set(services)]).toEqual([
            'happier.agent.codex/openai-codex',
            'happier.agent.claude/anthropic',
            'happier.scm.forge.github/github-account',
        ]);
    });

    it('says only on the account that needs a new sign-in that it does, never for a retrying refresh', async () => {
        const tree = await renderView();
        const signedOut = tree.root.findAll((node) => node.props.facts && node.props.accountId)
            .filter((row) => row.props.signedOut !== null)
            .map((row) => row.props.testID);

        expect(signedOut).toEqual(['connected-services-account:happier.agent.codex/openai-codex:work']);
        expect(tree.findHostByTestId(`${signedOut[0]}:sign-in-again`)).not.toBeNull();
        expect(tree.findHostByTestId('connected-services-account:happier.agent.claude/anthropic:work:sign-in-again')).toBeNull();
        // The summary line counts it once as "needs you".
        const summary = tree.root.findAll((node) => node.props?.testID === 'connected-services-summary-needs-you');
        expect(summary).not.toHaveLength(0);
    });

    it('repairs the Needs-you account in place without opening Connect more', async () => {
        const { Modal } = await import('@/modal');
        const show = vi.spyOn(Modal, 'show').mockReturnValue('connect-sheet');
        const tree = await renderView();
        const row = tree.findHostByTestId('connected-services-account:happier.agent.codex/openai-codex:work:sign-in-again');
        expect(row).not.toBeNull();
        await act(async () => { row!.props.onPress(); });
        expect(show).toHaveBeenLastCalledWith(expect.objectContaining({ props: expect.objectContaining({
            request: expect.objectContaining({ scope: null, intent: 'reconnect', service: PROFILES[2].ref.service, account: PROFILES[2].ref }),
        }) }));
        expect(tree.root.findByType('ConnectedServicesConnectMore' as never).props.request).toBeUndefined();
        show.mockRestore();
    });

    it('opens npm profile management from Code and tools through the same Connect presenter', async () => {
        const { Modal } = await import('@/modal');
        const show = vi.spyOn(Modal, 'show').mockReturnValue('connect-sheet');
        const tree = await renderView();
        await tree.pressByTestIdAsync('credentials:npm-registry-profiles');
        expect(show).toHaveBeenLastCalledWith(expect.objectContaining({ props: expect.objectContaining({
            request: expect.objectContaining({ service: { kind: 'npm-registry-profile' } }),
        }) }));
        show.mockRestore();
    });

    it('rail opens npm profiles through the same Connect presenter', async () => {
        const { Modal } = await import('@/modal');
        const show = vi.spyOn(Modal, 'show').mockReturnValue('connect-sheet');
        const { ConnectedServicesRail } = await import('./collection/ConnectedServicesRail');
        const tree = await renderView(<ConnectedServicesRail />);
        await tree.pressByTestIdAsync('connected-services-rail:npm-registry-profiles');
        expect(show).toHaveBeenLastCalledWith(expect.objectContaining({ props: expect.objectContaining({
            request: expect.objectContaining({ service: { kind: 'npm-registry-profile' } }),
        }) }));
        show.mockRestore();
    });

    it('opens an Add-menu account in Connect without navigating away from the collection', async () => {
        const { Modal } = await import('@/modal');
        const { router } = await import('expo-router');
        const show = vi.spyOn(Modal, 'show').mockReturnValue('connect-sheet');
        vi.mocked(router.push).mockClear();
        const tree = await renderView();
        // The desktop header keeps this same menu in its collection chrome; mount the supplied action surface.
        const { tree: actions } = await renderScreen(tree.root.findAll(node => node.props.headerActions && typeof node.props.onAddAccount === 'function')[0].props.headerActions);
        const menu = actions.root.findAll(node => node.props.testID === 'connected-services-index:add-menu' && typeof node.props.onSelect === 'function')[0];
        expect(menu).toBeDefined();
        const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
        const anchor = { kind: 'rect', rect: { left: 30, top: 40, width: 24, height: 24 } } as const;
        await act(async () => { actions.root.findByType(DropdownMenu).props.onSelect('account:happier.agent.codex/openai-codex', { anchor }); });
        expect(show).toHaveBeenLastCalledWith(expect.objectContaining({ props: expect.objectContaining({
            request: { scope: null, service: PROFILES[2].ref.service, anchor },
        }) }));
        expect(router.push).not.toHaveBeenCalled();
        show.mockRestore();
    });

    it.each(['scalar', 'qualified', 'collection'] as const)('opens legacy %s Add in the shared sheet and settles in Credentials', async ingress => {
        const { Modal } = await import('@/modal');
        const { router } = await import('expo-router');
        const show = vi.spyOn(Modal, 'show').mockReturnValue('connect-sheet');
        vi.mocked(router.push).mockClear();
        vi.mocked(router.replace).mockClear();
        const service = PROFILES[0].ref.service;
        let child: React.ReactElement | undefined;
        if (ingress === 'scalar') {
            connectedServicesModuleState.searchParams = { view: 'all', serviceId: 'github', profileId: 'personal', add: '1' };
            const { ConnectedAccountLegacyRouteRedirect } = await import('./account/ConnectedAccountLegacyRouteRedirect');
            child = <ConnectedAccountLegacyRouteRedirect />;
        } else if (ingress === 'qualified') {
            connectedServicesModuleState.searchParams = { view: 'all', ...service, accountId: 'personal', add: '1' };
            const { ConnectedAccountServiceView } = await import('./account/ConnectedAccountServiceView');
            child = <ConnectedAccountServiceView />;
        } else {
            connectedServicesModuleState.searchParams = { view: 'all', connect: '1', service: 'happier.scm.forge.github/github-account' };
        }
        const tree = await renderView(child);
        expect(show).toHaveBeenCalledWith(expect.objectContaining({ props: expect.objectContaining({
            request: expect.objectContaining({ scope: null, service,
                ...(ingress === 'collection' ? {} : { account: PROFILES[0].ref }),
            }),
        }) }));
        expect(router.push).not.toHaveBeenCalled();
        expect(router.replace).not.toHaveBeenCalled();
        if (ingress === 'collection') expect(router.setParams).toHaveBeenCalledWith({ connect: undefined, service: undefined, view: 'all' });
        const defaults = structuredClone(storage.getState().settings.connectedServicesDefaultAuthByAgentIdV1);
        const accounts = structuredClone(storage.getState().profile.connectedAccountsV4);
        await act(async () => { show.mock.calls.at(-1)![0].props?.onResult({ kind: 'connected', account: PROFILES[0].ref }); });
        expect(tree.findHostByTestId('connected-services-settle')).not.toBeNull();
        expect(storage.getState().settings.connectedServicesDefaultAuthByAgentIdV1).toEqual(defaults);
        expect(storage.getState().profile.connectedAccountsV4).toEqual(accounts);
        await act(async () => {
            storage.setState({ profile: AccountProfileSchema.parse({ ...storage.getState().profile,
                connectedAccountsV4: accounts.map(account => ({ ...account, displayName: 'Refreshed identity' })),
            }) });
        });
        expect(show).toHaveBeenCalledTimes(1);
        show.mockRestore();
    });

    it('keeps a dismissed legacy Add closed when its route projection refreshes', async () => {
        const { Modal } = await import('@/modal');
        const show = vi.spyOn(Modal, 'show').mockReturnValue('connect-sheet');
        connectedServicesModuleState.searchParams = { view: 'all', serviceId: 'github', add: '1' };
        const { ConnectedAccountLegacyRouteRedirect } = await import('./account/ConnectedAccountLegacyRouteRedirect');
        const tree = await renderView(<ConnectedAccountLegacyRouteRedirect />);
        await act(async () => { show.mock.calls.at(-1)![0].onRequestClose?.(); });
        await act(async () => {
            registryState.entries = REGISTRY_ENTRIES.map(entry => ({ ...entry }));
            storage.setState({ profile: AccountProfileSchema.parse({ ...storage.getState().profile,
                connectedAccountsV4: PROFILES.map(account => ({ ...account, displayName: 'Refreshed identity' })),
            }) });
        });
        expect(show).toHaveBeenCalledTimes(1);
        expect(tree.findHostByTestId('connected-services-settle')).toBeNull();
        show.mockRestore();
    });

    it('offers the existing pool after Add-menu Connect without changing defaults or pool membership', async () => {
        const { Modal } = await import('@/modal');
        const { router } = await import('expo-router');
        const { QualifiedConnectedAccountGroupV4Schema } = await import('@happier-dev/protocol/connect/qualifiedConnectedAccountsV4');
        profileState.connectedAccountGroupsV4 = [QualifiedConnectedAccountGroupV4Schema.parse({
            v: 1, ref: { service: PROFILES[0].ref.service, groupId: 'github-pool' }, incarnation: 'pool-incarnation',
            displayName: 'Code tools', policy: {}, activeConnectedAccountId: null,
            generation: 1, runtimeStateRevision: 0, createdAt: 1, updatedAt: 1, members: [],
        })];
        const show = vi.spyOn(Modal, 'show').mockReturnValue('connect-sheet');
        vi.mocked(router.push).mockClear();
        const tree = await renderView();
        const defaults = structuredClone(storage.getState().settings.connectedServicesDefaultAuthByAgentIdV1);
        const groups = structuredClone(storage.getState().profile.connectedAccountGroupsV4);
        const { tree: actions } = await renderScreen(tree.root.findAll(node => node.props.headerActions && typeof node.props.onAddAccount === 'function')[0].props.headerActions);
        const menu = actions.root.findAll(node => node.props.testID === 'connected-services-index:add-menu' && typeof node.props.onSelect === 'function')[0];
        expect(tree.findHostByTestId('connected-services-settle')).toBeNull();
        await act(async () => { menu.props.onSelect('account:happier.scm.forge.github/github-account'); });
        await act(async () => { show.mock.calls.at(-1)![0].props?.onResult({ kind: 'connected', account: PROFILES[0].ref }); });
        expect(tree.findHostByTestId('connected-services-settle:add-to-pool')).not.toBeNull();
        expect(storage.getState().settings.connectedServicesDefaultAuthByAgentIdV1).toEqual(defaults);
        expect(storage.getState().profile.connectedAccountGroupsV4).toEqual(groups);
        expect(router.push).not.toHaveBeenCalled();
        await act(async () => { tree.findHostByTestId('connected-services-settle:not-now')!.props.onPress(); });
        expect(tree.findHostByTestId('connected-services-settle')).toBeNull();
        expect(storage.getState().profile.connectedAccountGroupsV4).toEqual(groups);
        show.mockRestore();
    });

    it.each(['overview', 'rail'] as const)('adds another account in place while retaining the Credentials %s', async surface => {
        const { Modal } = await import('@/modal');
        const { router } = await import('expo-router');
        const show = vi.spyOn(Modal, 'show').mockReturnValue('connect-sheet');
        vi.mocked(router.push).mockClear();
        const { ConnectedServicesRail } = await import('./collection/ConnectedServicesRail');
        const tree = await renderView(surface === 'rail' ? <ConnectedServicesRail /> : undefined);
        const overview = tree.root.findAll(node => node.props.model && typeof node.props.onAddAccount === 'function')[0];
        expect(overview).toBeDefined();
        const sheet = overview.props.model.sheets.find((candidate: { serviceKey: string }) => candidate.serviceKey === 'happier.agent.codex/openai-codex');
        expect(sheet).toBeDefined();
        const trigger = { getBoundingClientRect: () => ({ left: 30, top: 40, width: 24, height: 24 }) };
        const anchor = surface === 'rail' ? { kind: 'view', ref: { current: trigger } } as const
            : { kind: 'rect', rect: { left: 30, top: 40, width: 24, height: 24 } } as const;
        await act(async () => {
            if (surface === 'rail') tree.findHostByTestId(`connected-services-rail:service:${sheet.serviceKey}:add`)!.props.onPress({ currentTarget: trigger });
            else overview.props.onAddAccount(sheet, anchor);
        });
        expect(show).toHaveBeenLastCalledWith(expect.objectContaining({ props: expect.objectContaining({
            request: { scope: null, intent: 'add', service: PROFILES[2].ref.service, anchor },
        }) }));
        expect(router.push).not.toHaveBeenCalled();
        show.mockRestore();
    });

    it('renders the service brand mark, falling back to the generic key glyph when no mark exists', async () => {
        profileState.connectedAccountsV4 = [
            ...PROFILES.map((profile) => ({ ...profile })),
            {
                ...PROFILES[0],
                ref: { service: { pluginId: 'acme.connected-accounts-conformance', localId: 'vault' }, accountId: 'vault-1' },
            },
        ];
        const rows = accountRows(await renderView());
        const row = (serviceKey: string) => rows.find((candidate) => String(candidate.props.testID).includes(`:${serviceKey}:`))!;
        // Every account row draws its service's mark (R6-2, owner 10-31): accounts stay recognisable on a mixed sheet.
        expect(row('happier.scm.forge.github/github-account').props.legacyServiceId).toBe('github');
        expect(row('happier.scm.forge.github/github-account').findAllByType('SvgXml' as never).length).toBeGreaterThan(0);
        expect(row('happier.agent.codex/openai-codex').findAllByType('SvgXml' as never).length).toBeGreaterThan(0);

        const fallback = row('acme.connected-accounts-conformance/vault');
        expect(fallback.props.legacyServiceId ?? null).toBeNull();
        expect(fallback.findAllByType('SvgXml' as never)).toHaveLength(0);
        expect(fallback.findAllByType('Icon' as never).some((icon) => icon.props.name === 'key')).toBe(true);
    });

    it('keeps the first-run setup loading while machines are still asked for services', async () => {
        registryState.status = 'loading';
        registryState.entries = [];
        profileState.connectedServicesV2 = [];
        profileState.connectedAccountsV4 = [];

        const tree = await renderView();

        // Nothing is claimed empty while the machines are still asked: the first run says so in place.
        expect(tree.root.findAll((node) => node.props?.testID === 'connected-services-empty')).toHaveLength(0);
        const firstRun = tree.root.findByType('ConnectedServicesConnectMore' as never);
        expect(firstRun.props).toMatchObject({ layout: 'firstRun', loading: true });
    });

    it('explains a failed service read instead of claiming there is nothing to connect', async () => {
        registryState.status = 'error';
        registryState.errorReason = 'daemon_unreachable';
        registryState.entries = [];
        profileState.connectedServicesV2 = [];
        profileState.connectedAccountsV4 = [];

        const tree = await renderView();

        expect(tree.root.findAll((node) => node.props?.testID === 'connected-services-empty')).toHaveLength(0);
        expect(tree.root.findAll((node) =>
            node.props?.testID === 'connected-services-projection-error',
        )).not.toHaveLength(0);
    });

    it('says truthfully that services come from online machines when none is offering any', async () => {
        registryState.entries = [];
        profileState.connectedAccountsV4 = [];

        const tree = await renderView();

        expect(tree.root.findAll((node) => node.props?.testID === 'connected-services-empty')).not.toHaveLength(0);
    });
});
