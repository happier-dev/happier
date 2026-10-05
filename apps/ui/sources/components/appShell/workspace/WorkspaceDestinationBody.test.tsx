import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installPanelCommonModuleMocks } from '@/components/ui/panels/panelTestHelpers';
import { DestinationInstanceHost } from './DestinationInstanceHost';
import { Stack, useLocalSearchParams } from './destinationRoute';
import { WorkspaceDestinationBody } from './WorkspaceDestinationBody';
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

// Expo's context/module loader is the boundary. Fixture modules retain real React providers,
// route adapters and local editor state beneath that boundary.
beforeAll(() => {
    const modules: Record<string, unknown> = {
        './(app)/settings/_layout.tsx': { default: RootLayout },
        './(app)/settings/agents/_layout.tsx': { default: CollectionLayout },
        './(app)/settings/agents/index.tsx': { WorkspaceRouteBody: Index },
        './(app)/settings/agents/custom/index.tsx': { WorkspaceRouteBody: Editor },
        './(app)/settings/server/_layout.tsx': { default: CollectionLayout },
        './(app)/settings/server/index.tsx': { WorkspaceRouteBody: Editor },
        './(app)/settings/machines/_layout.tsx': { default: CollectionLayout },
        './(app)/settings/machines/[id].tsx': { WorkspaceRouteBody: Editor },
        './(app)/settings/connected-services/_layout.tsx': { default: CollectionLayout },
        './(app)/settings/connected-services/account.tsx': { WorkspaceRouteBody: Editor },
        './(app)/artifacts/index.tsx': { WorkspaceRouteBody: ArtifactBody },
        './(app)/artifacts/new.tsx': { WorkspaceRouteBody: ArtifactBody },
        './(app)/artifacts/[id].tsx': { WorkspaceRouteBody: ArtifactBody },
        './(app)/artifacts/edit/[id].tsx': { WorkspaceRouteBody: ArtifactBody },
    };
    registerWorkspaceRouteContext(Object.assign((key: string) => {
        if (!(key in modules)) throw new Error(`Unexpected route module: ${key}`);
        return modules[key];
    }, { keys: () => Object.keys(modules) }));
});

function hosted(pathname: string, params: Record<string, string> = {}) {
    const catalog = resolveCompactAppDestinations({ pages: [], builtins: {
        externalSessions: false, inbox: false, workflows: false, friends: false,
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
        ['/settings/machines/machine%201', { id: 'machine 1', serverId: 'home-a' }],
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
});
