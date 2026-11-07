import * as React from 'react';
import { act, create } from 'react-test-renderer';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installPanelCommonModuleMocks } from '@/components/ui/panels/panelTestHelpers';
import { DestinationInstanceHost } from './DestinationInstanceHost';
import { Stack, useLocalSearchParams } from './destinationRoute';
import { WorkspaceDestinationBody } from './WorkspaceDestinationBody';
import { AppShellColumnContext } from '@/components/navigation/shell/appRail/appShellColumnContext';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { registerWorkspaceRouteContext } from './workspaceRouteContext';
import { resolveCompactAppDestinations, resolveDestinationRefFromHref } from '../destinations/compactAppDestinationCatalog';

installPanelCommonModuleMocks();
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
    pathname: '/settings/agents', params: { id: 'unrelated-session' },
}).module);

const CollectionContext = React.createContext<string | null>(null);
function CollectionLayout() {
    const [identity] = React.useState(() => ({}));
    return <CollectionContext.Provider value="collection">
        {React.createElement('LayoutState', { identity })}
        <Stack><Stack.Screen name="index" /><Stack.Screen name="custom/index" /></Stack>
    </CollectionContext.Provider>;
}
function RootLayout() { return <Stack />; }
function Editor() {
    const collection = React.useContext(CollectionContext);
    if (!collection) throw new Error('Missing route layout provider');
    const params = useLocalSearchParams();
    const [draft, setDraft] = React.useState('');
    return React.createElement('HostedEditor', { collection, params, draft, setDraft });
}
function Index() { return React.createElement('HostedIndex'); }
function ArtifactBody() {
    return React.createElement('HostedArtifact', { params: useLocalSearchParams() });
}
function WorkflowBody() {
    const [draft, setDraft] = React.useState('');
    return React.createElement('HostedWorkflow', { params: useLocalSearchParams(), draft, setDraft });
}
function BoardsBody() { return React.createElement('HostedBoards'); }
function HomeBody() { return React.createElement('HostedHome'); }
function RunSettingsBody() { return React.createElement('HostedRunSettings', { params: useLocalSearchParams() }); }
function MachineBody() {
    const [draft, setDraft] = React.useState('');
    const [scroll, setScroll] = React.useState(0);
    const [mount] = React.useState(() => ({}));
    return React.createElement('HostedMachine', { draft, setDraft, scroll, setScroll, mount, params: useLocalSearchParams() });
}

// Expo's context/module loader is the boundary. Fixture modules retain real React providers,
// route adapters and local editor state beneath that boundary.
beforeAll(async () => {
    const { AutomationSettingsRoute } = await import('@/app/(app)/automations/settings');
    const modules: Record<string, unknown> = {
        './(app)/settings/_layout.tsx': { default: RootLayout },
        './(app)/settings/agents/_layout.tsx': { default: CollectionLayout },
        './(app)/settings/agents/index.tsx': { WorkspaceRouteBody: Index },
        './(app)/settings/agents/custom/index.tsx': { WorkspaceRouteBody: Editor },
        './(app)/settings/server/_layout.tsx': { default: CollectionLayout },
        './(app)/settings/server/index.tsx': { WorkspaceRouteBody: Editor },
        './(app)/settings/machines/_layout.tsx': { default: CollectionLayout },
        './(app)/settings/machines/[id]/index.tsx': { WorkspaceRouteBody: MachineBody },
        './(app)/machines/[id]/index.tsx': { WorkspaceRouteBody: MachineBody },
        './(app)/settings/connected-services/_layout.tsx': { default: CollectionLayout },
        './(app)/settings/connected-services/account.tsx': { WorkspaceRouteBody: Editor },
        './(app)/settings/embeds/_layout.tsx': { default: CollectionLayout },
        './(app)/settings/embeds/index.tsx': { WorkspaceRouteBody: Index },
        './(app)/settings/embeds/new.tsx': { WorkspaceRouteBody: Editor },
        './(app)/settings/embeds/[tokenId].tsx': { WorkspaceRouteBody: Editor },
        './(app)/settings/account/api-tokens/_layout.tsx': { default: CollectionLayout },
        './(app)/settings/account/api-tokens/index.tsx': { WorkspaceRouteBody: Index },
        './(app)/settings/account/api-tokens/[tokenId].tsx': { WorkspaceRouteBody: Editor },
        './(app)/artifacts/index.tsx': { WorkspaceRouteBody: ArtifactBody },
        './(app)/artifacts/new.tsx': { WorkspaceRouteBody: ArtifactBody },
        './(app)/artifacts/[id].tsx': { WorkspaceRouteBody: ArtifactBody },
        './(app)/artifacts/edit/[id].tsx': { WorkspaceRouteBody: ArtifactBody },
        // Both public URLs are rendered by the same Expo module.
        './(app)/workflows/[id]/index.tsx': { WorkspaceRouteBody: WorkflowBody },
        './(app)/workflows/settings.tsx': { WorkspaceRouteBody: RunSettingsBody },
        './(app)/automations/settings.tsx': { WorkspaceRouteBody: AutomationSettingsRoute },
        './(app)/boards/index.tsx': { WorkspaceRouteBody: BoardsBody },
        './(app)/index.tsx': { WorkspaceRouteBody: HomeBody },
        './(app)/boards/[boardId].tsx': { WorkspaceRouteBody: BoardsBody },
    };
    registerWorkspaceRouteContext(Object.assign((key: string) => {
        if (!(key in modules)) throw new Error(`Unexpected route module: ${key}`);
        return modules[key];
    }, { keys: () => Object.keys(modules) }));
});

function hosted(pathname: string, params: Record<string, string> = {}) {
    const catalog = resolveCompactAppDestinations({ pages: [], builtins: {
        externalSessions: false, inbox: false, workflows: true, friends: false,
    } });
    const resolved = resolveDestinationRefFromHref(catalog, pathname);
    if (!resolved) throw new Error(`Unadmitted fixture route: ${pathname}`);
    const target = { ...resolved, params: { ...resolved.params, ...params } };
    return <DestinationInstanceHost tabId="settings-tab" ref={target} pathname={pathname} focused visible
        navigation={{ push: () => {}, replace: () => {}, back: () => {} }}>
        <WorkspaceDestinationBody target={target} pathname={pathname} renderSession={() => null} renderSessionDetails={() => null} />
    </DestinationInstanceHost>;
}

describe('workspace destination route composition', () => {
    it('retains the Machine page, unsent composer and scroll through either door', async () => {
        const screen = await renderScreen(hosted('/settings/machines/machine-a?serverId=home-a&tab=processes'));
        const machine = screen.root.findByType('HostedMachine');
        const mount = machine.props.mount;
        await act(async () => { machine.props.setDraft('Review this machine'); machine.props.setScroll(150); });
        await screen.update(hosted('/machines/machine-a?serverId=home-a&tab=processes&sort=memory'));
        expect(screen.root.findByType('HostedMachine').props).toMatchObject({ mount, draft: 'Review this machine', scroll: 150,
            params: { id: 'machine-a', tab: 'processes', sort: 'memory' } });
        expect(screen.root.findByType('HostedMachine').props.mount).toBe(mount);
        await screen.update(hosted('/settings/machines/machine-a?serverId=home-a&tab=processes'));
        expect(screen.root.findByType('HostedMachine').props).toMatchObject({ draft: 'Review this machine', scroll: 150 });
        expect(screen.root.findByType('HostedMachine').props.mount).toBe(mount);
    });
    // A lazy body that is still loading says it once: beside a column, the column already speaks for the
    // destination ("Opening Boards"), so the page waits quietly; without a column the page says it.
    it.each([
        [true, '/boards', 0],
        [false, '/boards/board-a', 1],
    ] as const)('with the column showing (%s) says a loading body %s %i time(s)', async (columnVisible, pathname, cards) => {
        const catalog = resolveCompactAppDestinations({ pages: [], builtins: {
            externalSessions: false, inbox: false, workflows: true, friends: false,
        } });
        const target = resolveDestinationRefFromHref(catalog, pathname)!;
        let renderer!: ReturnType<typeof create>;
        act(() => {
            renderer = create(<AppShellColumnContext.Provider value={{ present: true, columnVisible }}>
                <WorkspaceDestinationBody target={target} pathname={pathname} renderSession={() => null} renderSessionDetails={() => null} />
            </AppShellColumnContext.Provider>);
        });
        expect(renderer.root.findAllByType('HostedBoards')).toHaveLength(0);
        expect(renderer.root.findAllByType(SurfaceStateCard)).toHaveLength(cards);
        await act(async () => {});
        expect(renderer.root.findAllByType('HostedBoards')).toHaveLength(1);
        act(() => renderer.unmount());
    });
    // Home is where a reload lands: while its page loads it holds Home's own shape (greeting, composer, the
    // rows under it), not the generic page rows, and the Home that mounts draws the same shape until its model answers.
    it('holds a loading Home in Home\'s own shape, not the generic page rows', async () => {
        const catalog = resolveCompactAppDestinations({ pages: [], builtins: {
            externalSessions: false, inbox: false, workflows: true, friends: false,
        } });
        const target = resolveDestinationRefFromHref(catalog, '/')!;
        let renderer!: ReturnType<typeof create>;
        act(() => {
            renderer = create(<WorkspaceDestinationBody target={target} pathname="/" renderSession={() => null} renderSessionDetails={() => null} />);
        });
        const hosts = (testID: string) => renderer.root.findAll(node => typeof node.type === 'string' && node.props.testID === testID);
        expect(renderer.root.findAllByType('HostedHome')).toHaveLength(0);
        expect(hosts('workspace-destination-body-loading')).toHaveLength(0);
        expect(hosts('home-hub.loading-greeting')).toHaveLength(1);
        expect(hosts('home-hub.loading-composer')).toHaveLength(1);
        await act(async () => {});
        expect(renderer.root.findAllByType('HostedHome')).toHaveLength(1);
        act(() => renderer.unmount());
    });
    it('adjudicates the retired settings alias as Run settings rather than a Workflow entity or collection', async () => {
        const catalog = resolveCompactAppDestinations({ pages: [], builtins: {
            externalSessions: false, inbox: false, workflows: true, friends: false,
        } });
        const target = resolveDestinationRefFromHref(catalog, '/automations/settings')!;
        const replace = vi.fn();
        const screen = await renderScreen(<DestinationInstanceHost tabId="run-settings-alias" ref={target}
            pathname="/automations/settings" focused visible navigation={{ push: () => {}, replace, back: () => {} }}>
            <WorkspaceDestinationBody target={target} pathname="/automations/settings" renderSession={() => null} renderSessionDetails={() => null} />
        </DestinationInstanceHost>);
        expect(replace).toHaveBeenCalledWith('/workflows/settings');
        expect(screen.root.findAllByType('HostedWorkflow')).toHaveLength(0);
    });
    it('loads Run settings with its own Home and no Workflow entity id', async () => {
        const screen = await renderScreen(hosted('/workflows/settings?serverId=home-a'));
        expect(screen.root.findByType('HostedRunSettings').props.params).toMatchObject({ serverId: 'home-a' });
        expect(screen.root.findByType('HostedRunSettings').props.params.id).toBeUndefined();
        expect(screen.root.findAllByType('HostedWorkflow')).toHaveLength(0);
    });
    it('keeps the mounted workflow editor when its create URL becomes the saved URL', async () => {
        const screen = await renderScreen(hosted('/workflows/new'));
        await act(async () => { screen.root.findByType('HostedWorkflow').props.setDraft('Accepted draft'); });
        await screen.update(hosted('/workflows/saved-workflow'));
        expect(screen.root.findByType('HostedWorkflow').props).toMatchObject({ draft: 'Accepted draft', params: { id: 'saved-workflow' } });
    });
    it.each([
        ['/artifacts', {}],
        ['/artifacts/new', {}],
        ['/artifacts/document%201', { id: 'document 1' }],
        ['/artifacts/edit/document%201', { id: 'document 1' }],
    ] as const)('hosts the admitted Artifacts destination %s with its own params', async (pathname, params) => {
        const screen = await renderScreen(hosted(pathname));
        expect(screen.root.findByType('HostedArtifact').props.params.id).toBe('id' in params ? params.id : undefined);
    });

    it.each([
        ['/settings/agents/custom', {}],
        ['/settings/server', {}],
        ['/settings/connected-services/account', { accountId: 'account-a', pluginId: 'happier.agent.claude', localId: 'anthropic' }],
    ] as const)('hosts %s through its route layouts and destination params', async (pathname, params) => {
        const screen = await renderScreen(hosted(pathname, params));
        expect(screen.root.findByType('HostedEditor').props).toMatchObject({ collection: 'collection', params });
    });

    it('changes the nested leaf while retaining the collection layout and its provider', async () => {
        const screen = await renderScreen(hosted('/settings/agents'));
        expect(screen.root.findAllByType('HostedIndex')).toHaveLength(1);
        const identity = screen.root.findByType('LayoutState').props.identity;
        await act(async () => { screen.update(hosted('/settings/agents/custom')); });
        expect(screen.root.findAllByType('HostedIndex')).toHaveLength(0);
        expect(screen.root.findByType('HostedEditor').props.collection).toBe('collection');
        expect(screen.root.findByType('LayoutState').props.identity).toBe(identity);
    });

    it.each([
        ['/settings/embeds', 'HostedIndex', {}],
        ['/settings/embeds/new', 'HostedEditor', {}],
        ['/settings/embeds/token%201', 'HostedEditor', { tokenId: 'token 1' }],
        ['/settings/account/api-tokens', 'HostedIndex', {}],
        ['/settings/account/api-tokens/token%201', 'HostedEditor', { tokenId: 'token 1' }],
    ] as const)('renders the registered collection leaf for %s', async (pathname, leaf, params) => {
        const screen = await renderScreen(hosted(pathname));
        expect(screen.root.findAllByType(leaf)).toHaveLength(1);
        expect(screen.root.findAllByType('LayoutState')).toHaveLength(1);
        if (leaf === 'HostedEditor') {
            expect(screen.root.findByType(leaf).props).toMatchObject({ collection: 'collection', params });
        }
    });

    it('retains the Embeds collection provider when its index, create and detail URLs settle', async () => {
        const screen = await renderScreen(hosted('/settings/embeds'));
        const identity = screen.root.findByType('LayoutState').props.identity;
        await act(async () => { screen.update(hosted('/settings/embeds/new')); });
        expect(screen.root.findByType('HostedEditor').props.params.tokenId).toBeUndefined();
        await act(async () => { screen.update(hosted('/settings/embeds/token%201')); });
        expect(screen.root.findByType('HostedEditor').props.params.tokenId).toBe('token 1');
        await act(async () => { screen.update(hosted('/settings/embeds')); });
        expect(screen.root.findAllByType('HostedIndex')).toHaveLength(1);
        expect(screen.root.findByType('LayoutState').props.identity).toBe(identity);
    });
});
