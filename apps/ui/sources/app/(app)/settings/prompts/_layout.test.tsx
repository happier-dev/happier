import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { act } from 'react-test-renderer';

import { createDeferred, renderScreen } from '@/dev/testkit';
import { serveSessionActionHome } from '@/dev/testkit/harness/sessionActionHome';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createArtifactListHttpResponse } from '@/dev/testkit/harness/artifactStoreBoundary';
import { isArtifactInventoryLoaded, PROMPT_LIBRARY_ARTIFACT_KINDS } from '@/sync/domains/artifacts/artifactInventory';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import type { Artifact } from '@/sync/domains/artifacts/artifactTypes';
import { getSettingsStackScreenDefinitions } from '@/components/settings/navigation/settingsRouteRegistry';
import { NavigationLargeTitleProvider } from '@/components/ui/layout/navigationTitleChrome';

const routerState = vi.hoisted(() => ({ pathname: '/settings/prompts', screenOptions: null as null | Record<string, unknown>, Body: null as React.ComponentType | null,
    params: {} as Record<string, string | string[]> }));

// expo-router is the navigation boundary: record what the layout asks its settings-stack screen to show.
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    const boundary = createExpoRouterMock({ pathname: () => routerState.pathname, params: () => routerState.params });
    return {
        ...boundary.module,
        Slot: () => routerState.Body ? React.createElement(routerState.Body) : React.createElement('PromptRouteSlot'),
        Stack: {
            ...boundary.module.Stack,
            Screen: (props: { options?: Record<string, unknown> }) => {
                routerState.screenOptions = props.options ?? null;
                return null;
            },
        },
    };
});
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('socket.io-client', async original =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));
installDisconnectedServerSocketBoundary();
await import('@/sync/syncEngine');
const { storage } = await import('@/sync/domains/state/storage');
const { sync } = await import('@/sync/sync');

let home: Awaited<ReturnType<typeof serveSessionActionHome>> | undefined;
let disconnect: (() => Promise<void>) | undefined;
let releaseRequest: (() => void) | undefined;
let disposeScreen: (() => void) | undefined;
afterEach(async () => {
    const [dispose, release, close, served] = [disposeScreen, releaseRequest, disconnect, home];
    disposeScreen = releaseRequest = disconnect = home = undefined;
    // A failed release must not leave this Home connected under the next case.
    try { await dispose?.(); release?.(); } finally {
        try { await close?.(); } finally { await served?.dispose(); }
    }
});

async function unknownPromptInventory(route: NonNullable<Parameters<typeof serveSessionActionHome>[0]>['route']) {
    home = await serveSessionActionHome({ homes: [{ key: 'session', serverUrl: 'https://prompts-layout.test',
        accountId: 'prompt-layout-account', currentAccount: true }], route: request => {
        if (request.path === '/v1/artifacts' && request.method === 'GET') {
            if (request.url.searchParams.has('kinds') || request.url.searchParams.has('unclassified')) return route(request);
            return Response.json([]);
        }
        return undefined;
    } });
    disconnect = await home.restoreActiveConnection();
    await waitForHomeGovernance(() => expect(storage.getState().isDataReady).toBe(true));
    await sync.fetchArtifactsList();
    storage.setState({ artifacts: {}, artifactsLoaded: false, artifactBrowserLoaded: false, artifactInventoryKindsLoaded: [], artifactInventoryKindsPartial: [] });
}

describe('PromptsLayoutRoute', () => {
    beforeEach(() => {
        storage.setState({ isDataReady: true, artifactsLoaded: true, artifactBrowserLoaded: false, artifactInventoryKindsLoaded: [], artifactInventoryKindsPartial: [] });
        routerState.pathname = '/settings/prompts';
        routerState.screenOptions = null;
        routerState.params = {};
        routerState.Body = null;
    });

    it.each([
        '/settings/prompts/templates',
        '/settings/prompts/docs/doc-1',
        '/settings/prompts',
    ] as const)('leaves the phone header with its parent while the large page title names %s', async pathname => {
        routerState.pathname = pathname;
        const { t } = await import('@/text');
        routerState.screenOptions = { ...getSettingsStackScreenDefinitions(t).find(screen => screen.name === 'prompts')!.options };
        const { default: PromptsLayoutRoute } = await import('./_layout');
        await renderScreen(<NavigationLargeTitleProvider largeTitle><PromptsLayoutRoute /></NavigationLargeTitleProvider>);

        expect(routerState.screenOptions?.headerTitle).toBe('');
        expect(routerState.screenOptions?.headerLeft).toBeTypeOf('function');
    });

    it('keeps every prompt route unmounted until artifact heads are materialized', async () => {
        const response = createDeferred<Response>();
        releaseRequest = () => response.resolve(Response.json({ items: [], hasUnclassified: false,
            coverage: { status: 'complete', unclassifiedCount: 0 } }));
        await unknownPromptInventory(() => response.promise);
        const { default: PromptsLayoutRoute } = await import('./_layout');
        const screen = await renderScreen(<PromptsLayoutRoute />);
        disposeScreen = () => screen.unmount();

        expect(screen.findByTestId('prompts.artifacts.loading')).toBeTruthy();
        expect(screen.findAllByType('PromptRouteSlot' as never)).toHaveLength(0);
    });

    it('says when the inventory read fails and Retry reads it again, instead of spinning forever', async () => {
        let reads = 0;
        const retryResponse = createDeferred<Response>();
        releaseRequest = () => retryResponse.resolve(Response.json({ items: [], hasUnclassified: false,
            coverage: { status: 'complete', unclassifiedCount: 0 } }));
        await unknownPromptInventory(() => ++reads === 1
            ? Response.json({ error: 'read_failed' }, { status: 503 }) : retryResponse.promise);
        const { default: PromptsLayoutRoute } = await import('./_layout');
        const screen = await renderScreen(<PromptsLayoutRoute />);
        disposeScreen = () => screen.unmount();
        await vi.waitFor(() => expect(screen.findByTestId('prompts.artifacts.failed')).not.toBeNull());

        expect(screen.findByTestId('prompts.artifacts.loading')).toBeNull();
        expect(screen.findAllByType('PromptRouteSlot' as never)).toHaveLength(0);
        const failed = screen.findAll(node => node.props.testID === 'prompts.artifacts.failed' && node.props.action !== undefined)[0]!;
        expect(failed.props.action.label).toBe('Retry');

        await act(async () => { failed.props.action.onPress(); });
        await vi.waitFor(() => expect(reads).toBe(2));
        // An unfinished Retry cannot certify that the previously failed inventory is current.
        expect(screen.findByTestId('prompts.artifacts.failed')).not.toBeNull();
        expect(screen.findByTestId('prompts.artifacts.loading')).toBeNull();
        expect(screen.findAllByType('PromptRouteSlot' as never)).toHaveLength(0);
        await act(async () => { releaseRequest?.(); });
        await vi.waitFor(() => expect(screen.findAllByType('PromptRouteSlot' as never)).toHaveLength(1));
        expect(storage.getState().artifactsLoaded).toBe(false);
        expect(storage.getState().artifactInventoryKindsLoaded).toEqual(PROMPT_LIBRARY_ARTIFACT_KINDS);
    });

    it.each([false, true])('fails rather than mounting empty Prompts without typed coverage (hasUnclassified=%s)', async hasUnclassified => {
        await unknownPromptInventory(() => Response.json({ items: [], hasUnclassified }));
        const { default: PromptsLayoutRoute } = await import('./_layout');
        const screen = await renderScreen(<PromptsLayoutRoute />);
        disposeScreen = () => screen.unmount();
        await vi.waitFor(() => expect(screen.findByTestId('prompts.artifacts.failed')).not.toBeNull());
        expect(screen.findAllByType('PromptRouteSlot' as never)).toHaveLength(0);
        expect(storage.getState().artifactInventoryKindsLoaded).toEqual([]);
        expect(storage.getState().artifactInventoryKindsPartial).toEqual([]);
        expect(storage.getState().artifactsLoaded).toBe(false);
    });

    it('keeps loaded Prompt routes mounted while admission refreshes only their kinds', async () => {
        const requests: string[] = [];
        const refreshed = createDeferred<Response>();
        const row: Artifact = { id: '11111111-1111-4111-8111-000000000001', kind: 'prompt', kindHint: 'prompt_doc.v2',
            ownerAccountId: 'prompt-layout-account', access: 'owner', encryptionMode: 'plain',
            dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
            header: encodePlainArtifactStoredContent({ kind: 'prompt_doc.v2', title: 'Fresh membership' }),
            headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
        let query: URL | undefined;
        let held = false;
        releaseRequest = () => refreshed.resolve(createArtifactListHttpResponse(query!, [row]));
        await unknownPromptInventory(request => {
            if (!held) return createArtifactListHttpResponse(request.url, []);
            requests.push(request.url.search);
            query = request.url;
            return refreshed.promise;
        });
        // The held Prompt census missed a whole-inventory refresh (snapshot repair) while no Prompt route
        // was mounted; that is what makes admission re-read its kinds rather than reuse current rows.
        await (sync as unknown as { snapshotRefreshOnResume(options: { mode: 'fallback'; reason: string }): Promise<unknown> })
            .snapshotRefreshOnResume({ mode: 'fallback', reason: 'prompts-layout-missed-refresh' });
        storage.setState({ artifactsLoaded: false, artifactInventoryKindsLoaded: PROMPT_LIBRARY_ARTIFACT_KINDS });
        held = true;
        const { default: PromptsLayoutRoute } = await import('./_layout');
        const screen = await renderScreen(<PromptsLayoutRoute />);
        disposeScreen = () => screen.unmount();
        await vi.waitFor(() => expect(requests).toHaveLength(1));
        expect(new URLSearchParams(requests[0]).get('kinds')).toBe(JSON.stringify(PROMPT_LIBRARY_ARTIFACT_KINDS));
        expect(screen.findAllByType('PromptRouteSlot' as never)).toHaveLength(1);
        expect(screen.findByTestId('prompts.artifacts.loading')).toBeNull();
        await act(async () => { releaseRequest?.(); });
        await vi.waitFor(() => expect(storage.getState().artifacts[row.id]?.headerVersion).toBe(1));
        expect(requests).toHaveLength(1);
        expect(storage.getState().artifactsLoaded).toBe(false);
    });

    it('mounts Context after one three-header read with thousands of unrelated Artifacts and the full inventory still unknown', async () => {
        const rows: Artifact[] = Array.from({ length: 3503 }, (_, index) => {
            const kind = PROMPT_LIBRARY_ARTIFACT_KINDS[index] ?? 'markdown';
            return { id: `11111111-1111-4111-8111-${String(index + 1).padStart(12, '0')}`,
                kind: 'other', kindHint: kind, ownerAccountId: 'prompt-layout-account', access: 'owner',
                encryptionMode: 'plain', publicAudience: 'none', dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
                header: encodePlainArtifactStoredContent({ kind, title: kind }), headerVersion: 1, bodyVersion: 1,
                seq: index + 1, createdAt: index + 1, updatedAt: index + 1 };
        });
        const pages: number[] = [];
        await unknownPromptInventory(async request => {
            const response = createArtifactListHttpResponse(request.url, rows);
            const body = await response.clone().json();
            pages.push(body.items.length);
            return response;
        });
        routerState.pathname = '/settings/prompts/stacks/coding';
        const { default: PromptsLayoutRoute } = await import('./_layout');
        const screen = await renderScreen(<PromptsLayoutRoute />);
        disposeScreen = () => screen.unmount();
        await vi.waitFor(() => expect(screen.findAllByType('PromptRouteSlot' as never)).toHaveLength(1));
        expect(pages).toEqual([3]);
        expect(Object.keys(storage.getState().artifacts).sort()).toEqual(rows.slice(0, 3).map(row => row.id));
        expect(storage.getState().artifactsLoaded).toBe(false);
        expect(storage.getState().artifactInventoryKindsLoaded).toEqual(PROMPT_LIBRARY_ARTIFACT_KINDS);
    });

    it.each(['socket deletion', 'full inventory removal'] as const)('does not resurrect a Prompt after %s during a partial legacy read', async removal => {
        const row = (index: number): Artifact => ({
            id: `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`,
            kind: 'prompt', kindHint: 'prompt_doc.v2', ownerAccountId: 'prompt-layout-account', access: 'owner',
            encryptionMode: 'plain', publicAudience: 'none', dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
            header: encodePlainArtifactStoredContent({ kind: 'prompt_doc.v2', title: `Prompt ${index}` }),
            headerVersion: 1, bodyVersion: 1, seq: index, createdAt: index, updatedAt: index,
        });
        const a = row(1), unseen = row(2), surviving = row(3);
        const { kindHint: _hint, ...legacy } = row(4);
        const locked = { ...legacy, kind: null, header: 'persistently unreadable header' };
        const requested = createDeferred<void>(), response = createDeferred<Response>();
        const inventory = [a, surviving, locked];
        releaseRequest = () => response.resolve(createArtifactListHttpResponse(
            new URL('https://prompts-layout.test/v1/artifacts?limit=500&unclassified=true'), inventory));
        await unknownPromptInventory(request => {
            if (request.url.searchParams.has('unclassified')) { requested.resolve(); return response.promise; }
            return createArtifactListHttpResponse(request.url, inventory);
        });
        const { decryptArtifactListItems, handleDeleteArtifactSocketUpdate } = await import('@/sync/engine/artifacts/syncArtifacts');
        const opened = await decryptArtifactListItems({ artifacts: [a, unseen], encryption: null, artifactDataKeys: new Map() });
        storage.getState().applyArtifacts(opened.filter((item): item is NonNullable<typeof item> => item !== null));
        const read = sync.fetchArtifactsList({ kinds: PROMPT_LIBRARY_ARTIFACT_KINDS }).then(() => null, (error: unknown) => error);
        try {
            await requested.promise;
            if (removal === 'socket deletion') handleDeleteArtifactSocketUpdate({ artifactId: a.id,
                deleteArtifact: storage.getState().deleteArtifact, artifactDataKeys: new Map() });
            else await sync.fetchArtifactsList();
            expect(storage.getState().artifacts[a.id]).toBeUndefined();
            releaseRequest();
            const error = await read;
            expect(storage.getState().artifacts[a.id]).toBeUndefined();
            expect(storage.getState().artifacts[surviving.id]?.rawHeader?.kind).toBe('prompt_doc.v2');
            expect(storage.getState().artifacts[unseen.id]).toBeUndefined();
            expect(storage.getState().artifactsLoaded).toBe(removal === 'full inventory removal');
            expect(storage.getState().artifactInventoryKindsLoaded).toEqual([]);
            expect(error).toBeNull();
        } finally { releaseRequest(); await read; }
    });

    it('renders readable Prompts with a locked legacy neighbour after successful scoped HTTP reads', async () => {
        const readable: Artifact = { id: '11111111-1111-4111-8111-000000000001', kind: 'prompt', kindHint: 'prompt_doc.v2',
            ownerAccountId: 'prompt-layout-account', access: 'owner', encryptionMode: 'plain', publicAudience: 'none',
            dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
            header: encodePlainArtifactStoredContent({ kind: 'prompt_doc.v2', title: 'Readable Prompt' }),
            headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
        const { kindHint: _hint, ...legacy } = readable;
        const locked = { ...legacy, id: '11111111-1111-4111-8111-000000000002', kind: null, header: 'persistently unreadable header' };
        const pages: number[] = [];
        await unknownPromptInventory(async request => {
            const response = createArtifactListHttpResponse(request.url, [readable, locked]);
            expect(response.status).toBe(200);
            pages.push((await response.clone().json()).items.length);
            return response;
        });
        const { usePromptCollection } = await import('@/components/settings/prompts/collection/PromptCollectionList');
        routerState.Body = function PromptRows() {
            const collection = usePromptCollection('doc', '');
            return React.createElement('PromptRouteSlot', { status: collection.status },
                ...collection.groups.flatMap(group => group.rows.map(row => React.createElement('ReadablePrompt', { key: row.id, title: row.title }))));
        };
        const { default: PromptsLayoutRoute } = await import('./_layout');
        const screen = await renderScreen(<PromptsLayoutRoute />);
        disposeScreen = () => screen.unmount();
        await vi.waitFor(() => expect(screen.findAllByType('ReadablePrompt' as never)).toHaveLength(1));
        expect(screen.findAllByType('ReadablePrompt' as never)[0]?.props.title).toBe('Readable Prompt');
        expect(screen.findByTestId('prompts.artifacts.failed')).toBeNull();
        expect(pages).toEqual([1, 1]);
        expect(storage.getState().artifactsLoaded).toBe(false);
        expect(storage.getState().artifactInventoryKindsLoaded).toEqual([]);
        expect(storage.getState().artifactInventoryKindsPartial).toEqual(PROMPT_LIBRARY_ARTIFACT_KINDS);
        expect(isArtifactInventoryLoaded(storage.getState(), PROMPT_LIBRARY_ARTIFACT_KINDS)).toBe(false);
        expect(storage.getState().artifacts[locked.id]?.isDecrypted).toBe(false);
        expect(storage.getState().artifactInventoryUnreadyCount).toBe(1);
    });

    it('mounts the selected prompt route after artifact heads are ready', async () => {
        storage.setState({ artifactsLoaded: false, artifactInventoryKindsLoaded: PROMPT_LIBRARY_ARTIFACT_KINDS });
        const { default: PromptsLayoutRoute } = await import('./_layout');
        const screen = await renderScreen(<PromptsLayoutRoute />);

        expect(screen.findAllByType('PromptRouteSlot' as never)).toHaveLength(1);
    });

    it.each([
        ['./skills/index', '/settings/skills', {}],
        ['./skills/new', '/settings/skills/new', {}],
        ['./skills/[id]', '/settings/skills/[skillId]', { skillId: 'skill/one' }],
        ['./skills/[id]/export', '/settings/skills/[skillId]', { skillId: 'skill/one' }],
        ['./skills/[id]/files/edit', '/settings/skills/[skillId]', { skillId: 'skill/one' }],
        ['./skills/[id]/files/new', '/settings/skills/[skillId]', { skillId: 'skill/one' }],
        ['./assets', '/settings/skills/found', {}],
        ['./registries', '/settings/skills', { add: 'browse' }],
        ['./registries/item', '/settings/skills', { add: 'browse' }],
    ] as const)('retains the selected Home and item identity through legacy route %s', async (path, pathname, params) => {
        routerState.params = { id: ['skill/one', 'ignored'], serverId: ['home one', 'ignored'] };
        const { WorkspaceRouteBody } = await import(path);
        const screen = await renderScreen(<WorkspaceRouteBody />);
        const href = screen.findAllByType('Redirect' as never)[0]?.props.href;
        expect(href).toEqual({ pathname, params: { ...params, serverId: 'home one' } });
    });

    it('redirects a retired document export to that document on its selected Home', async () => {
        routerState.params = { id: ['doc/one', 'ignored'], serverId: ['home one', 'ignored'],
            assetTypeId: 'claude.command', scope: 'project', workspacePath: '/old-target' };
        const { WorkspaceRouteBody } = await import('./docs/[id]/export');
        const screen = await renderScreen(<WorkspaceRouteBody />);
        expect(screen.findAllByType('Redirect' as never)[0]?.props.href)
            .toEqual({ pathname: '/settings/prompts/docs/[id]', params: { id: 'doc/one', serverId: 'home one' } });
    });
});
