import * as React from 'react';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { renderScreen } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { DEFAULT_HOME_ATMOSPHERE } from '@happier-dev/protocol/account/settings/accountSettings';
import { GlassRuntimeEnvironmentProvider } from '@/components/ui/glass/glassRuntimeEnvironment';
import { pictureStore } from './pictureStore.web';
import { useAtmosphere } from './useAtmosphere';
import { AppShellPluginUiProjectionValueProvider, type AppShellPluginUiProjectionValue } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { EMPTY_PLUGIN_UI_PROJECTION } from '@/sync/domains/plugins/ui/projection';
import { useAtmospherePictureCatalog } from './useAtmospherePictureCatalog';
import { ATMOSPHERE_PICTURES } from '@happier-dev/brand/atmosphere';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { useAtmosphereRouteSurface } from './useAtmosphereRouteSurface';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('./pictureStore', async () => import('./pictureStore.web'));

const initial = storage.getState();
afterEach(() => { storage.setState(initial, true); });

describe('Atmosphere input locality', () => {
    it('keeps viewer Home presentation for a shared Session without reading private Project membership', async () => {
        const scope = { serverId: 'shared-atmosphere-home', accountId: 'shared-atmosphere-viewer' };
        const session = createSessionFixture({ id: 'shared-atmosphere-session', serverId: scope.serverId,
            ownerAccountId: 'another-owner', accessLevel: 'view', projectKey: 'private-owner-project' });
        storage.setState(state => ({ settingsScope: scope, profileScope: scope, projectAccountRows: null,
            sessionListRowsByServerId: {}, settings: { ...state.settings, homeAtmosphere: {
                ...DEFAULT_HOME_ATMOSPHERE, source: 'picture', showOn: ['sessions'],
                picture: { ref: { kind: 'user', localId: 'shared-viewer-picture' }, layout: 'wallpaper' },
            } } }));
        storage.getState().applyServerScopedSessionListRows(scope.serverId,
            [buildSessionListRenderableFromSession(session)], { source: 'ordinary', mode: 'append' });
        await pictureStore.put({ localId: 'shared-viewer-picture', kind: 'user', data: new Blob(['viewer pixels']) });
        let shown: ReturnType<typeof useAtmosphere> | undefined;
        function Probe() { shown = useAtmosphere({ session: { serverId: scope.serverId, sessionId: session.id } }); return null; }
        const screen = await renderScreen(<Probe />);
        try {
            await vi.waitFor(() => expect(shown?.pictureRecord?.localId).toBe('shared-viewer-picture'));
            expect(shown?.shown).toBe(true);
            expect(storage.getState().projectAccountRows).toBeNull();
        } finally { await screen.unmount(); await pictureStore.remove('shared-viewer-picture'); }
    });
    it('reads a cached built-in once per arriving reader without preparing or downloading it again', async () => {
        const picture = ATMOSPHERE_PICTURES.find(picture => picture.id === 'snowy-alps')!;
        const localId = 'builtin:' + picture.id;
        await pictureStore.put({ localId, kind: 'builtin', data: new Blob(['cached pixels']), source: picture.src });
        storage.setState(state => ({ settings: { ...state.settings, homeAtmosphere: {
            ...DEFAULT_HOME_ATMOSPHERE, source: 'picture', moments: { ...DEFAULT_HOME_ATMOSPHERE.moments, idleResettle: false },
            picture: { ref: { kind: 'builtin', id: picture.id }, layout: 'wallpaper' },
        } } }));
        const transaction = vi.spyOn(IDBDatabase.prototype, 'transaction');
        const fetch = vi.spyOn(globalThis, 'fetch');
        let shown: ReturnType<typeof useAtmosphere> | undefined;
        const commits: ReturnType<typeof useAtmosphere>[] = [];
        function Probe() {
            const atmosphere = useAtmosphere('home');
            shown = atmosphere;
            React.useLayoutEffect(() => { commits.push(atmosphere); }, [atmosphere]);
            return null;
        }
        let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
        try {
            screen = await renderScreen(<Probe />);
            await vi.waitFor(() => expect(shown?.pictureRecord?.localId).toBe(localId));
            expect(commits[0]).toMatchObject({ source: 'picture', pictureRecord: null, fallbackReason: null });
            expect(commits.every(commit => commit.source === 'picture')).toBe(true);
            expect(transaction).toHaveBeenCalledTimes(1);
            expect(fetch).not.toHaveBeenCalled();
        } finally { await screen?.unmount(); transaction.mockRestore(); fetch.mockRestore(); await pictureStore.remove(localId); }
    });
    it.each([true, false])('shows a cached thumbnail before acquisition settles (success=%s)', async success => {
        const picture = ATMOSPHERE_PICTURES.find(picture => picture.id === 'snowy-alps')!;
        const localId = 'builtin:' + picture.id;
        const thumbId = 'builtin-thumb:' + picture.id;
        await pictureStore.remove(localId);
        await pictureStore.put({ localId: thumbId, kind: 'builtin', data: new Blob(['thumbnail']), source: picture.src });
        storage.setState(state => ({ settings: { ...state.settings, homeAtmosphere: {
            ...DEFAULT_HOME_ATMOSPHERE, source: 'picture', moments: { idleResettle: false },
            picture: { ref: { kind: 'builtin', id: picture.id }, layout: 'wallpaper' },
        } } }));
        let release!: (response: Response) => void;
        const response = new Promise<Response>(resolve => { release = resolve; });
        const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(() => response);
        vi.stubGlobal('createImageBitmap', async () => ({ width: 100, height: 100, close() {} }));
        vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0,
            getContext: () => ({ drawImage() {} }),
            toBlob: (done: (blob: Blob) => void, mime: string) => done(new Blob(['full'], { type: mime })),
        }) });
        let shown: ReturnType<typeof useAtmosphere> | undefined;
        const displayed: string[] = [];
        function Probe() {
            shown = useAtmosphere('home');
            const id = shown.pictureRecord?.localId;
            React.useLayoutEffect(() => { if (id) displayed.push(id); }, [id]);
            return null;
        }
        let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
        try {
            screen = await renderScreen(<Probe />);
            await vi.waitFor(() => expect(shown).toMatchObject({ source: 'picture', fallbackReason: null, pictureRecord: { localId: thumbId } }));
            await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
            await act(async () => { release(new Response(new Blob(['full']), { status: success ? 200 : 503 })); });
            await vi.waitFor(() => expect(shown).toMatchObject(success
                ? { source: 'picture', pictureRecord: { localId }, fallbackReason: null }
                : { source: 'planet', pictureRecord: null, fallbackReason: 'picture-unavailable' }));
            expect(displayed).toEqual(success ? [thumbId, localId] : [thumbId]);
            expect(fetch).toHaveBeenCalledTimes(1);
        } finally {
            release(new Response(null, { status: 503 }));
            await screen?.unmount(); fetch.mockRestore(); vi.unstubAllGlobals();
            await pictureStore.remove(localId); await pictureStore.remove(thumbId);
        }
    });
    it('uses accepted qualified Session and Project-page membership, updates the override, and never borrows another Account census', async () => {
        const scope = { serverId: 'project-atmosphere-home', accountId: 'project-atmosphere-account' };
        const project = { serverId: scope.serverId, projectKey: 'accepted-project' };
        const localId = 'project-atmosphere-picture';
        await pictureStore.put({ localId, kind: 'user', data: new Blob(['project pixels']) });
        const override = { ...DEFAULT_HOME_ATMOSPHERE, source: 'picture' as const,
            showOn: ['sessions', 'pages'] as ('sessions' | 'pages')[],
            picture: { ref: { kind: 'user' as const, localId }, layout: 'wallpaper' as const } };
        const session = createSessionFixture({ id: 'same-session-id', serverId: scope.serverId, ownerAccountId: scope.accountId,
            projectKey: project.projectKey, metadata: { path: '/irrelevant-not-a-membership-key', host: 'test', machineId: 'm' } });
        storage.setState(state => ({ settingsScope: scope, profileScope: scope, settings: { ...state.settings,
            homeAtmosphere: { ...DEFAULT_HOME_ATMOSPHERE, source: 'none' } } }));
        storage.getState().applyServerScopedSessionListRows(scope.serverId, [buildSessionListRenderableFromSession(session)], { source: 'ordinary', mode: 'append' });
        storage.getState().activateProjectAccountRowsScope(scope);
        const rows = { scope, status: 'ready' as const, coverage: 'complete' as const, workspaceRefs: [{
            id: 'route-checkout', serverId: scope.serverId, machineId: 'm', rootPath: '/different-path', projectKey: project.projectKey,
            label: null, createdAtMs: 1, lastOpenedAtMs: null,
        }], relationships: [], organizations: [{ key: { kind: 'project-organization' as const, ...project }, revision: 1,
            value: { atmosphere: override } }], revisionsByPhysicalKey: {} };
        storage.getState().applyProjectAccountRowsForScope(scope, rows);
        let sessionShown: ReturnType<typeof useAtmosphere> | undefined;
        let pageShown: ReturnType<typeof useAtmosphere> | undefined;
        function Probe() {
            sessionShown = useAtmosphere({ session: { serverId: scope.serverId, sessionId: session.id } });
            const surface = useAtmosphereRouteSurface({ place: 'pages', workspace: { serverId: scope.serverId, workspaceRefId: 'route-checkout' } });
            pageShown = useAtmosphere(surface);
            return null;
        }
        const screen = await renderScreen(<Probe />);
        try {
            await act(async () => { await pictureStore.get(localId); });
            expect(sessionShown).toMatchObject({ source: 'picture', shown: true, pictureRecord: { localId } });
            expect(pageShown).toMatchObject({ source: 'picture', shown: true, pictureRecord: { localId } });
            await act(async () => { storage.getState().applyProjectAccountRowsForScope(scope, { ...rows,
                organizations: [{ ...rows.organizations[0]!, revision: 2, value: { atmosphere: 'home' } }] }); });
            expect(sessionShown?.source).toBe('none');
            expect(pageShown?.source).toBe('none');
            await act(async () => { storage.getState().applyProjectAccountRowsForScope(scope, { ...rows,
                organizations: [{ ...rows.organizations[0]!, revision: 3 }] }); });
            await act(async () => { await pictureStore.get(localId); });
            expect(sessionShown?.source).toBe('picture');
            await act(async () => { storage.setState({ profileScope: { ...scope, accountId: 'different-account' } }); });
            expect(sessionShown?.source).toBe('none');
            expect(pageShown?.source).toBe('none');
        } finally { await screen.unmount(); await pictureStore.remove(localId); }
    });
    it('does no picture I/O for excluded pages and reuses the picture across shown page navigation without waking unrelated readers', async () => {
        const epoch = 1_800_000_000_000;
        const picture = ATMOSPHERE_PICTURES[0]!;
        vi.spyOn(Date, 'now').mockReturnValue(epoch);
        await pictureStore.put({ localId: `builtin:${picture.id}`, kind: 'builtin', data: new Blob(['pixels']), source: picture.src });
        storage.setState(state => ({ settings: { ...state.settings, homeAtmosphere: {
            ...DEFAULT_HOME_ATMOSPHERE, source: 'picture', showOn: ['home'],
            picture: { ref: { kind: 'builtin', id: picture.id }, layout: 'wallpaper' },
        } } }));
        const transaction = vi.spyOn(IDBDatabase.prototype, 'transaction');
        let shown: ReturnType<typeof useAtmosphere> | undefined;
        let unrelatedRenders = 0;
        function Page({ name }: { name: string }) { shown = useAtmosphere('pages'); return <>{name}</>; }
        function Unrelated() { useAtmosphere('home'); unrelatedRenders++; return null; }
        const stableReader = <Unrelated />;
        let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
        try {
            screen = await renderScreen(<Page name="settings" />);
            expect(shown?.source).toBe('none');
            expect(transaction).not.toHaveBeenCalled();
            await act(async () => { storage.setState(state => ({ settings: { ...state.settings,
                homeAtmosphere: { ...state.settings.homeAtmosphere, showOn: ['home', 'pages'] } } })); });
            await act(async () => { await pictureStore.get(`builtin:${picture.id}`); });
            expect(shown?.pictureRecord?.localId).toBe(`builtin:${picture.id}`);
            await screen.update(<>{stableReader}<Page name="settings" /></>);
            await act(async () => { await pictureStore.get(`builtin:${picture.id}`); });
            const record = shown?.pictureRecord;
            transaction.mockClear(); unrelatedRenders = 0;
            for (const name of ['inbox', 'machines', 'store', 'settings']) await screen.update(<>{stableReader}<Page name={name} /></>);
            expect(shown?.pictureRecord).toBe(record);
            expect(transaction).not.toHaveBeenCalled();
            expect(unrelatedRenders).toBe(0);
            await act(async () => { storage.setState(state => ({ settings: { ...state.settings,
                homeAtmosphere: { ...state.settings.homeAtmosphere, showOn: ['home'] } } })); });
            expect(shown?.source).toBe('none');
        } finally {
            await screen?.unmount(); vi.restoreAllMocks(); await pictureStore.remove(`builtin:${picture.id}`);
        }
    });
    it('samples a fresh arrival after the last Home reader leaves without keeping a clock alive', async () => {
        const epoch = 1_800_000_000_000;
        vi.spyOn(Date, 'now').mockReturnValue(epoch);
        storage.setState(state => ({ settingsScope: { serverId: 'sample-home', accountId: 'remount' }, settings: { ...state.settings, homeAtmosphere: {
            ...DEFAULT_HOME_ATMOSPHERE, source: 'picture',
        } } }));
        for (const picture of ATMOSPHERE_PICTURES.slice(0, 2)) await pictureStore.put({ localId: `builtin:${picture.id}`,
            kind: 'builtin', data: new Blob(['pixels']), source: picture.src });
        let shown: ReturnType<typeof useAtmosphere> | undefined;
        function Probe() { shown = useAtmosphere('home'); return null; }
        let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
        try {
            screen = await renderScreen(<Probe />);
            await act(async () => { await pictureStore.get(`builtin:${ATMOSPHERE_PICTURES[0]!.id}`); });
            expect(shown?.builtinPicture?.id).toBe(ATMOSPHERE_PICTURES[0]!.id);
            await screen.unmount();
            vi.spyOn(Date, 'now').mockReturnValue(epoch + 3_600_000);
            screen = await renderScreen(<Probe />);
            await act(async () => { await pictureStore.get(`builtin:${ATMOSPHERE_PICTURES[1]!.id}`); });
            expect(shown?.builtinPicture?.id).toBe(ATMOSPHERE_PICTURES[1]!.id);
        } finally {
            await screen?.unmount(); vi.restoreAllMocks();
            for (const picture of ATMOSPHERE_PICTURES.slice(0, 2)) await pictureStore.remove(`builtin:${picture.id}`);
        }
    });

    it('samples the new Account while a Home reader remains mounted', async () => {
        const epoch = 1_800_000_000_000;
        const scope = { serverId: 'sample-home', accountId: 'sample-account-a' };
        vi.spyOn(Date, 'now').mockReturnValue(epoch);
        storage.setState(state => ({ settingsScope: scope, settings: { ...state.settings, homeAtmosphere: {
            ...DEFAULT_HOME_ATMOSPHERE, source: 'picture', picture: { ...DEFAULT_HOME_ATMOSPHERE.picture },
        } } }));
        let shown: ReturnType<typeof useAtmosphere> | undefined;
        function Probe() { shown = useAtmosphere('home'); return null; }
        let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
        try {
            for (const picture of ATMOSPHERE_PICTURES.slice(0, 2)) await pictureStore.put({ localId: 'builtin:' + picture.id,
                kind: 'builtin', data: new Blob(['pixels']), source: picture.src });
            screen = await renderScreen(<Probe />);
            await act(async () => { await pictureStore.get('builtin:' + ATMOSPHERE_PICTURES[0]!.id); });
            expect(shown?.builtinPicture?.id).toBe(ATMOSPHERE_PICTURES[0]!.id);
            vi.spyOn(Date, 'now').mockReturnValue(epoch + 3_600_000);
            await act(async () => { storage.setState({ settingsScope: { ...scope, accountId: 'sample-account-b' } }); });
            await act(async () => { await pictureStore.get('builtin:' + ATMOSPHERE_PICTURES[0]!.id); });
            expect(shown?.builtinPicture?.id).toBe(ATMOSPHERE_PICTURES[0]!.id);
        } finally {
            await screen?.unmount(); vi.restoreAllMocks();
            for (const picture of ATMOSPHERE_PICTURES.slice(0, 2)) await pictureStore.remove('builtin:' + picture.id);
        }
    });

    it('keeps explicit Project and profile pictures fixed while retaining the local Home rotation epoch', async () => {
        const epoch = 1_800_000_000_000;
        const scope = { serverId: 'sample-home', accountId: 'sample-account' };
        const project = { serverId: scope.serverId, projectKey: 'explicit-sample-project' };
        const home = { ...DEFAULT_HOME_ATMOSPHERE, source: 'picture' as const,
            picture: { ...DEFAULT_HOME_ATMOSPHERE.picture } };
        storage.setState(state => ({ settingsScope: scope, profileScope: scope, settings: { ...state.settings, homeAtmosphere: home },
            projectAccountRows: { scope, status: 'ready', coverage: 'complete', workspaceRefs: [], relationships: [],
                organizations: [{ key: { kind: 'project-organization', ...project }, revision: 1,
                    value: { v: 1, atmosphere: home } }], revisionsByPhysicalKey: {} } }));
        let projectShown: ReturnType<typeof useAtmosphere> | undefined;
        let profileShown: ReturnType<typeof useAtmosphere> | undefined;
        let homeShown: ReturnType<typeof useAtmosphere> | undefined;
        function Explicit() {
            projectShown = useAtmosphere({ project });
            profileShown = useAtmosphere({ publicProfile: home });
            return null;
        }
        function Home() { homeShown = useAtmosphere('home'); return null; }
        const scene = (homeOpen: boolean) => <><Explicit />{homeOpen ? <Home /> : null}</>;
        let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
        try {
            vi.spyOn(Date, 'now').mockReturnValue(epoch);
            for (const picture of ATMOSPHERE_PICTURES.slice(0, 2)) await pictureStore.put({ localId: 'builtin:' + picture.id,
                kind: 'builtin', data: new Blob(['pixels']), source: picture.src });
            screen = await renderScreen(scene(true));
            await act(async () => { await pictureStore.get('builtin:' + ATMOSPHERE_PICTURES[0]!.id); });
            expect(homeShown?.builtinPicture?.id).toBe(ATMOSPHERE_PICTURES[0]!.id);
            await screen.update(scene(false));
            vi.spyOn(Date, 'now').mockReturnValue(epoch + 3_600_000);
            await screen.update(scene(true));
            await act(async () => { await pictureStore.get('builtin:' + ATMOSPHERE_PICTURES[1]!.id); });
            expect(homeShown?.builtinPicture?.id).toBe(ATMOSPHERE_PICTURES[1]!.id);
            expect(projectShown?.builtinPicture?.id).toBe(ATMOSPHERE_PICTURES[0]!.id);
            expect(profileShown?.builtinPicture?.id).toBe(ATMOSPHERE_PICTURES[0]!.id);
        } finally {
            await screen?.unmount(); vi.restoreAllMocks();
            for (const picture of ATMOSPHERE_PICTURES.slice(0, 2)) await pictureStore.remove('builtin:' + picture.id);
        }
    });

    it('keeps newer same-id bytes when an older IndexedDB read completes later', async () => {
        const localId = 'same-id-read-order';
        await pictureStore.put({ localId, kind: 'user', data: new Blob(['old']) });
        storage.setState(state => ({ settings: { ...state.settings, homeAtmosphere: {
            ...DEFAULT_HOME_ATMOSPHERE, source: 'picture',
            picture: { ...DEFAULT_HOME_ATMOSPHERE.picture, ref: { kind: 'user', localId } },
        } } }));
        const dispatch = IDBTransaction.prototype.dispatchEvent;
        let release: (() => void) | undefined;
        // Delay one completed read at the database boundary, preserving its earlier snapshot.
        const spy = vi.spyOn(IDBTransaction.prototype, 'dispatchEvent').mockImplementation(function (this: IDBTransaction, event: Event) {
            if (!release && event.type === 'complete' && this.mode === 'readonly' && this.objectStoreNames.contains('pictures')) {
                release = () => { dispatch.call(this, event); };
                return true;
            }
            return dispatch.call(this, event);
        });
        let shown: ReturnType<typeof useAtmosphere> | undefined;
        function Probe() { shown = useAtmosphere('home'); return null; }
        const screen = await renderScreen(<Probe />);
        try {
            await act(async () => {
                await pictureStore.put({ localId, kind: 'user', data: new Blob(['new']) });
                await pictureStore.get(localId);
            });
            const newest = shown?.pictureRecord;
            expect(newest?.data).toBeInstanceOf(Blob);
            await act(async () => { release?.(); });
            expect(shown?.pictureRecord).toBe(newest);
            const data = shown?.pictureRecord?.data;
            expect(data instanceof Blob ? await data.text() : data).toBe('new');
        } finally { spy.mockRestore(); await screen.unmount(); }
    });
    it('does not render catalog readers for unrelated plugin executable publications', async () => {
        let renders = 0;
        function Probe() { useAtmospherePictureCatalog(); renders += 1; return null; }
        const value: AppShellPluginUiProjectionValue = {
            pluginUiProjection: EMPTY_PLUGIN_UI_PROJECTION, pluginBrowserProjection: null,
            phase: 'current', interactionEnabled: true, machineId: null, serverId: null,
            platform: 'web', accountLifetime: null, connectedAccountProjectionRevision: 1,
            reloadConnectedAccountProjection: () => {}, clientExecutableActivation: { status: 'ready' },
            reloadClientExecutables: () => {},
        };
        const child = <Probe />;
        const screen = await renderScreen(<AppShellPluginUiProjectionValueProvider value={value}>{child}</AppShellPluginUiProjectionValueProvider>);
        renders = 0;
        for (let index = 0; index < 5; index += 1) {
            await screen.update(<AppShellPluginUiProjectionValueProvider value={{ ...value, connectedAccountProjectionRevision: index + 2 }}>{child}</AppShellPluginUiProjectionValueProvider>);
        }
        expect(renders).toBe(0);
    });
    it('does not render for unrelated glass facts, while a transparency change reaches the reader', async () => {
        storage.setState(state => ({ settings: { ...state.settings, homeAtmosphere: DEFAULT_HOME_ATMOSPHERE } }));
        let publications = 0;
        let renders = 0;
        function Probe() {
            renders++;
            const atmosphere = useAtmosphere('home');
            React.useEffect(() => { publications += 1; }, [atmosphere]);
            return null;
        }
        const child = <Probe />;
        const screen = await renderScreen(<GlassRuntimeEnvironmentProvider value={{ highContrast: true }}>{child}</GlassRuntimeEnvironmentProvider>);
        publications = 0;
        renders = 0;
        for (let index = 0; index < 5; index += 1) {
            await screen.update(<GlassRuntimeEnvironmentProvider value={{ highContrast: index % 2 === 0 }}>{child}</GlassRuntimeEnvironmentProvider>);
        }
        expect(publications).toBe(0);
        expect(renders).toBe(0);
        await screen.update(<GlassRuntimeEnvironmentProvider value={{ reduceTransparency: true }}>{child}</GlassRuntimeEnvironmentProvider>);
        expect(publications).toBe(1);
        expect(renders).toBe(1);
    });

    it('does not render Planet for unrelated picture writes', async () => {
        storage.setState(state => ({ settings: { ...state.settings, homeAtmosphere: DEFAULT_HOME_ATMOSPHERE } }));
        let renders = 0;
        function Probe() { useAtmosphere('home'); renders += 1; return null; }
        await renderScreen(<Probe />);
        renders = 0;
        await act(async () => {
            await pictureStore.put({ localId: 'unrelated-to-planet', kind: 'user', data: new Blob(['pixels']) });
        });
        expect(renders).toBe(0);
    });
});
