import 'fake-indexeddb/auto';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ATMOSPHERE_PICTURES, releaseLook } from '@happier-dev/brand/atmosphere';
import { createProjectAccountRowCipherV1 } from '@happier-dev/protocol/projects/projectAccountRowCipherV1';
import { PROJECT_ACCOUNT_ROWS_ROUTE_V1, ProjectAccountOrganizationV1Schema, ProjectAccountRowMutationRequestV1Schema,
    ProjectAccountRowMutationResponseV1Schema } from '@happier-dev/protocol/projects/projectAccountRowsV1';

import { createDeferred, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { decideApprovalAsInbox } from '@/dev/testkit/harness/approvalInbox';
import { applyProjectAccountRowsFixture, createPlainProjectAccountRowListFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import { createSecretSettingsTestHarness } from '@/components/settings/secrets/secretSettingsTestHarness';
import { settingsParse } from '@/sync/domains/settings/settings';
import { storage } from '@/sync/domains/state/storage';
import { readProjectAtmosphere } from '@/sync/store/domains/projectAccountRows';
import { Modal } from '@/modal';
import type { BackdropWorkerRequest, BackdropWorkerResponse } from '../backdropCanvas.types';
import type { AtmosphereEditor } from './atmosphereEditor';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
// Select the genuine browser persistence adapter over the fake IndexedDB system boundary.
vi.mock('@/components/atmosphere/pictureStore', async () => import('../pictureStore.web'));
vi.mock('@/components/atmosphere/BackdropCanvas', async () => import('../BackdropCanvas.web'));

vi.mock('@/components/ui/popover', async importOriginal =>
    (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(importOriginal));

installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { AtmosphereWhereItShows, AtmosphereMoments, useAtmosphereMomentsSummary } = await import('@/components/settings/appearance/AtmosphereAppearanceRows');
const { useHomeAtmosphereEditor } = await import('./atmosphereEditor');
const { useProjectAtmosphereEditor } = await import('./useProjectAtmosphereEditor');
const { AtmosphereShowOnPanel } = await import('./AtmosphereShowOnControl');
const { useAtmosphere } = await import('../useAtmosphere');
const { HomeIdleResettle } = await import('../HomeIdleResettle');
const { pictureStore } = await import('../pictureStore');
const originalState = storage.getState();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => { standardCleanup(); vi.restoreAllMocks(); storage.setState(originalState, true); });

function HomeShowOnPanel() {
    return <AtmosphereShowOnPanel editor={useHomeAtmosphereEditor()} />;
}

function ProjectShowOnPanel({ project }: { project: Readonly<{ serverId: string; projectKey: string }> }) {
    return <AtmosphereShowOnPanel editor={useProjectAtmosphereEditor(project)} />;
}

async function chooseShowOn(screen: Awaited<ReturnType<typeof renderScreen>>, mode: 'everywhere' | 'home' | 'custom', presentation: 'page' | 'panel' = 'page') {
    if (presentation === 'panel') {
        await screen.pressByTestIdAsync(`look-show-on:${mode}`);
        return;
    }
    await screen.pressByTestIdAsync('atmosphere-show-on');
    await vi.waitFor(() => expect(screen.findAllHostsByTestId(`atmosphere-show-on:${mode}`).length).toBeGreaterThan(0));
    await screen.pressByTestIdAsync(`atmosphere-show-on:${mode}`);
}

describe('Home Atmosphere editor through declared Settings Actions', () => {
    it('starts one shared thumbnail acquisition for a held picture before the Settings POST', async () => {
        const account = await createSecretSettingsTestHarness({ settings: settingsParse({
            homeAtmosphere: { ...settingsParse({}).homeAtmosphere, source: 'none' },
            actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'settings.set': ['ui'] } },
        }) });
        const picture = ATMOSPHERE_PICTURES[2]!;
        await pictureStore.remove(`builtin:${picture.id}`);
        await pictureStore.remove(`builtin-thumb:${picture.id}`);
        const request = account.request.getMockImplementation()!;
        const release = createDeferred<void>();
        const download = createDeferred<Response>();
        const fetchPicture = vi.fn((_input: RequestInfo | URL) => download.promise);
        vi.stubGlobal('fetch', fetchPicture);
        account.request.mockImplementation(async (input, init) => {
            if (new URL(String(input)).pathname === '/v2/account/settings' && init?.method !== 'POST') await release.promise;
            return request(input, init);
        });
        const editor = await renderHook(useHomeAtmosphereEditor);
        await renderHook(() => useAtmosphere('home'));
        await renderHook(() => useAtmosphere('home'));
        let write: unknown;
        try {
            await act(async () => { write = editor.getCurrent().updateHome(current => ({ ...current, source: 'picture',
                picture: { ...current.picture, ref: { kind: 'builtin', id: picture.id } } })); });
            await vi.waitFor(() => expect(fetchPicture).toHaveBeenCalledTimes(1));
            const requested = new URL(String(fetchPicture.mock.calls[0]![0]));
            requested.searchParams.delete('happier-atmosphere');
            expect(requested.href).toBe(picture.src.thumb);
            expect(account.settingsWrites).toHaveLength(0);
            expect(storage.getState().settings.homeAtmosphere.source).toBe('none');
            expect(editor.getCurrent().value.picture.ref).toEqual({ kind: 'builtin', id: picture.id });
            download.resolve(new Response(null, { status: 503 }));
            release.resolve();
            await act(async () => { await write; });
        } finally {
            download.resolve(new Response(null, { status: 503 })); release.resolve();
            standardCleanup(); vi.unstubAllGlobals(); await account.dispose();
        }
    });
    it('does not open the Home picture when Project Look already supplies its editor', async () => {
        const home = { ...settingsParse({}).homeAtmosphere, source: 'picture' as const,
            picture: { ref: { kind: 'user' as const, localId: 'unused-home-editor' }, layout: 'wallpaper' as const } };
        const account = await createSecretSettingsTestHarness({ settings: settingsParse({ homeAtmosphere: home }) });
        await pictureStore.put({ localId: 'unused-home-editor', kind: 'user', data: new Blob(['pixels']) });
        const { LookPopover } = await import('./LookChip');
        const project = { serverId: account.scope.serverId, projectKey: 'look-locality' };
        const editor: AtmosphereEditor = { value: { ...home, source: 'none' }, update() {} };
        const gets = vi.spyOn(IDBObjectStore.prototype, 'get');
        try {
            const screen = await renderScreen(<LookPopover open target={{ surface: { project }, editor }}
                anchorRef={React.createRef()} onRequestClose={() => {}} />);
            expect(gets.mock.calls.filter(([key]) => key === 'unused-home-editor')).toHaveLength(0);
            await screen.unmount();
            await renderHook(useHomeAtmosphereEditor);
            expect(gets.mock.calls.filter(([key]) => key === 'unused-home-editor')).toHaveLength(1);
        } finally { gets.mockRestore(); standardCleanup(); await pictureStore.remove('unused-home-editor'); await account.dispose(); }
    });
    it('holds Rich then Digits off as one cumulative choice while the first acknowledgement is pending', async () => {
        const account = await createSecretSettingsTestHarness({ settings: settingsParse({
            actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'settings.set': ['ui'] } },
        }) });
        const request = account.request.getMockImplementation()!;
        const posted = createDeferred<void>();
        const release = createDeferred<void>();
        let first = true;
        account.request.mockImplementation(async (input, init) => {
            const response = await request(input, init);
            if (new URL(String(input)).pathname === '/v2/account/settings' && init?.method === 'POST' && first) {
                first = false; posted.resolve(); await release.promise;
            }
            return response;
        });
        const editor = await renderHook(useHomeAtmosphereEditor);
        let rich: unknown;
        let digits: unknown;
        try {
            await act(async () => { rich = editor.getCurrent().updateHome(current => ({ ...current, planet: { ...current.planet, style: 'rich' } })); });
            await posted.promise;
            await act(async () => { digits = editor.getCurrent().updateHome(current => ({ ...current, planet: { ...current.planet, digits: false } })); });
            expect(editor.getCurrent().value.planet).toMatchObject({ style: 'rich', digits: false });
            expect(storage.getState().settings.homeAtmosphere.planet).toMatchObject({ style: 'balanced', digits: true });
            release.resolve();
            await act(async () => { await Promise.all([rich, digits]); });
            expect(account.persistedSettings.homeAtmosphere.planet).toMatchObject({ style: 'rich', digits: false });
            expect(editor.getCurrent().value.planet).toMatchObject({ style: 'rich', digits: false });
        } finally { release.resolve(); standardCleanup(); await account.dispose(); }
    });
    it('keeps value-only Appearance readers free of picture transactions', async () => {
        const home = { ...settingsParse({}).homeAtmosphere, source: 'picture' as const,
            picture: { ref: { kind: 'user' as const, localId: 'appearance-values-only' }, layout: 'wallpaper' as const } };
        const account = await createSecretSettingsTestHarness({ settings: settingsParse({ homeAtmosphere: home }) });
        await pictureStore.put({ localId: 'appearance-values-only', kind: 'user', data: new Blob(['pixels']) });
        function Summary() { return <>{useAtmosphereMomentsSummary()}</>; }
        const transactions = vi.spyOn(IDBDatabase.prototype, 'transaction');
        try {
            const screen = await renderScreen(<><Summary /><AtmosphereWhereItShows /><AtmosphereMoments /></>);
            expect(screen.findByTestId('atmosphere-moment:send')).not.toBeNull();
            expect(transactions.mock.calls.filter(([store]) => store === 'pictures')).toHaveLength(0);
            await screen.unmount();
        } finally { transactions.mockRestore(); await pictureStore.remove('appearance-values-only'); await account.dispose(); }
    });
    it.each(['plain', 'e2ee'] as const)('commits a first Look field edit from an absent stored owner in a %s Account', async mode => {
        const account = await createSecretSettingsTestHarness({ mode, rawSettings: {
            actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'settings.set': ['ui'] } },
        } });
        try {
            const editor = await renderHook(useHomeAtmosphereEditor);
            await act(async () => { await editor.getCurrent().setShowOn!(['home']); });
            expect(account.settingsWrites).toHaveLength(1);
            expect(account.persistedSettings.homeAtmosphere.showOn).toEqual(['home']);
            expect(editor.getCurrent().showOn).toEqual(['home']);
            expect(Modal.alert).not.toHaveBeenCalled();
        } finally { standardCleanup(); await account.dispose(); }
    });

    it('projects Show background on at the HTTP acknowledgement without advancing another timer', async () => {
        const everywhere = ['home', 'new-session', 'projects', 'sessions', 'pages'] as const;
        const account = await createSecretSettingsTestHarness({ settings: settingsParse({
            homeAtmosphere: { ...settingsParse({}).homeAtmosphere, showOn: [...everywhere] },
            actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'settings.set': ['ui'] } },
        }) });
        const originalRequest = account.request.getMockImplementation()!;
        const posted = createDeferred<void>();
        let acknowledgementTimer: ReturnType<typeof setTimeout> | undefined;
        let acknowledgementAt: number | undefined;
        let projectedAt: number | undefined;
        const unsubscribe = storage.subscribe((state, previous) => {
            if (state.settings.homeAtmosphere.showOn !== previous.settings.homeAtmosphere.showOn
                && state.settings.homeAtmosphere.showOn.length === 1) projectedAt = Date.now();
        });
        try {
            const editor = await renderHook(() => useHomeAtmosphereEditor());
            vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
            const startedAt = Date.now();
            account.request.mockImplementation(async (input, init) => {
                const response = await originalRequest(input, init);
                if (new URL(String(input)).pathname === '/v2/account/settings' && init?.method === 'POST') {
                    // A constructed 15 s transport wait, below every real Action/settings owner.
                    const reply = new Promise<void>(resolve => {
                        acknowledgementTimer = setTimeout(() => { acknowledgementAt = Date.now(); resolve(); }, 15_000);
                    });
                    posted.resolve();
                    await reply;
                }
                return response;
            });
            const write = Promise.resolve(editor.getCurrent().setShowOn!(['home']));
            await posted.promise;
            expect(Date.now()).toBe(startedAt);
            expect(account.persistedSettings.homeAtmosphere.showOn).toEqual(['home']);
            expect(storage.getState().settings.homeAtmosphere.showOn).toEqual(everywhere);
            await act(async () => { await vi.advanceTimersByTimeAsync(14_999); });
            expect(projectedAt).toBeUndefined();
            await act(async () => { await vi.advanceTimersByTimeAsync(1); });
            await act(async () => { await write; });
            expect(projectedAt).toBe(acknowledgementAt);
            expect(projectedAt).toBe(startedAt + 15_000);
            expect(editor.getCurrent().showOn).toEqual(['home']);
            expect(account.settingsWrites).toHaveLength(1);
            // The canonical fresh-baseline owner also settles an unchanged choice with no clock advance.
            await act(async () => { await editor.getCurrent().setShowOn!(['home']); });
            expect(Date.now()).toBe(projectedAt);
            expect(account.settingsWrites).toHaveLength(1);
            expect(Modal.alert).not.toHaveBeenCalled();
        } finally {
            clearTimeout(acknowledgementTimer); unsubscribe();
            vi.useRealTimers(); standardCleanup(); await account.dispose();
        }
    });

    it('keeps the last of five explicit Look choices when an older HTTP CAS request finishes last', async () => {
        const everywhere = ['home', 'new-session', 'projects', 'sessions', 'pages'] as const;
        const account = await createSecretSettingsTestHarness({ settings: settingsParse({
            homeAtmosphere: { ...settingsParse({}).homeAtmosphere, showOn: [...everywhere] },
            actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'settings.set': ['ui'] } },
        }) });
        const originalRequest = account.request.getMockImplementation()!;
        const release = createDeferred<void>();
        const firstPost = createDeferred<void>();
        const writes: Promise<void>[] = [];
        let delayed = false;
        let networkDelay: ReturnType<typeof setTimeout> | undefined;
        function Panel() {
            const editor = useHomeAtmosphereEditor();
            return <AtmosphereShowOnPanel editor={{ ...editor, setShowOn: places => {
                // Observe the real Action's settlement; never replace an internal decision.
                writes.push(Promise.resolve(editor.setShowOn!(places)));
            } }} />;
        }
        try {
            const screen = await renderScreen(<Panel />);
            account.request.mockImplementation(async (input, init) => {
                if (new URL(String(input)).pathname === '/v2/account/settings' && init?.method === 'POST' && !delayed) {
                    delayed = true;
                    firstPost.resolve();
                    // This is transport scheduling, not an assertion about execution time.
                    // A serial owner releases naturally; concurrent later writes can finish first.
                    networkDelay = setTimeout(() => release.resolve(), 1000);
                    await release.promise;
                }
                return originalRequest(input, init);
            });
            await chooseShowOn(screen, 'everywhere', 'panel');
            await writes.at(-1);
            await chooseShowOn(screen, 'home', 'panel');
            await firstPost.promise;
            for (const mode of ['everywhere', 'home', 'everywhere'] as const) await chooseShowOn(screen, mode, 'panel');
            await act(async () => { await Promise.all(writes.slice(2)); });
            release.resolve();
            await act(async () => { await Promise.all(writes); });
            expect(account.persistedSettings.homeAtmosphere.showOn).toEqual(everywhere);
            expect(storage.getState().settings.homeAtmosphere.showOn).toEqual(everywhere);
            expect(writes).toHaveLength(5);
            expect(Modal.alert).not.toHaveBeenCalled();
        } finally { clearTimeout(networkDelay); release.resolve(); standardCleanup(); await account.dispose(); }
    });

    it.each(['page', 'panel'] as const)('retains an explicit return to Everywhere from the %s while the Home-only acknowledgement is in flight', async presentation => {
        const everywhere = ['home', 'new-session', 'projects', 'sessions', 'pages'] as const;
        const account = await createSecretSettingsTestHarness({ settings: settingsParse({
            homeAtmosphere: { ...settingsParse({}).homeAtmosphere, showOn: [...everywhere] },
            actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'settings.set': ['ui'] } },
        }) });
        const request = account.request.getMockImplementation()!;
        const acknowledgement = createDeferred<void>();
        const firstPost = createDeferred<void>();
        let held = false;
        try {
            const screen = await renderScreen(presentation === 'page' ? <AtmosphereWhereItShows /> : <HomeShowOnPanel />);
            account.request.mockImplementation(async (input, init) => {
                const response = await request(input, init);
                if (new URL(String(input)).pathname === '/v2/account/settings' && init?.method === 'POST' && !held) {
                    held = true;
                    firstPost.resolve();
                    await acknowledgement.promise;
                }
                return response;
            });
            await chooseShowOn(screen, 'home', presentation);
            await firstPost.promise;
            // The admitted first write reached the server, but its acknowledgement has not
            // updated the rendered preference. This is an explicit reversal, not a no-op.
            expect(account.persistedSettings.homeAtmosphere.showOn).toEqual(['home']);
            expect(storage.getState().settings.homeAtmosphere.showOn).toEqual(everywhere);
            await chooseShowOn(screen, 'everywhere', presentation);
            acknowledgement.resolve();
            await vi.waitFor(() => {
                expect(account.persistedSettings.homeAtmosphere.showOn).toEqual(everywhere);
                expect(storage.getState().settings.homeAtmosphere.showOn).toEqual(everywhere);
            });
            expect(account.persistedSettings.homeAtmosphere.showOn).toEqual(everywhere);
            expect(account.settingsWrites).toHaveLength(2);
        } finally { acknowledgement.resolve(); standardCleanup(); await account.dispose(); }
    });

    it('retains five explicit Project Look choices through its serialized row CAS without changing Home or sibling Project fields', async () => {
        const everywhere = ['home', 'new-session', 'projects', 'sessions', 'pages'] as const;
        const account = await createSecretSettingsTestHarness({ settings: settingsParse({
            actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'settings.set': ['ui'] } },
            homeAtmosphere: { ...settingsParse({}).homeAtmosphere, showOn: [...everywhere] },
        }) });
        const project = { serverId: account.scope.serverId, projectKey: 'show-on-project' };
        const key = { kind: 'project-organization' as const, ...project };
        const { moments: _moments, ...atmosphere } = account.persistedSettings.homeAtmosphere;
        const organization = { key, revision: 0, value: { label: 'Retained Project', pinned: true, atmosphere } };
        const initialRows = createPlainProjectAccountRowListFixture({ organizations: [organization] });
        if (initialRows.status !== 'listed') throw new Error('Expected the complete Project fixture list');
        let row = initialRows.rows.find(item => item.key.kind === 'project-organization')!;
        const cipher = createProjectAccountRowCipherV1({ mode: 'plain', material: null,
            randomBytes: () => { throw new Error('Plain Project rows need no encryption key'); } });
        const readSaved = () => {
            if (!row.content) throw new Error('Expected retained Project organization');
            return ProjectAccountOrganizationV1Schema.parse(cipher.open(key, row.content).value);
        };
        const request = account.request.getMockImplementation()!;
        const acknowledgement = createDeferred<void>();
        const firstPost = createDeferred<void>();
        let writes = 0;
        account.request.mockImplementation(async (input, init) => {
            const path = new URL(String(input)).pathname;
            if (path === `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`) return Response.json({ ...initialRows,
                rows: [...initialRows.rows.filter(item => item.key.kind !== 'project-organization'), row] });
            if (path !== `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/mutate`) return request(input, init);
            const mutation = ProjectAccountRowMutationRequestV1Schema.parse(JSON.parse(String(init?.body)));
            expect(mutation.mutations).toHaveLength(1);
            const changed = mutation.mutations[0]!;
            expect(changed.key).toEqual(key);
            expect(changed.expectedRevision).toBe(row.revision);
            row = { key, revision: row.revision + 1, content: changed.content };
            const response = ProjectAccountRowMutationResponseV1Schema.parse({ status: 'updated', rows: [row], cursor: ++writes });
            if (writes === 1) { firstPost.resolve(); await acknowledgement.promise; }
            return Response.json(response);
        });
        try {
            storage.setState({ profileScope: account.scope });
            applyProjectAccountRowsFixture(storage, { organizations: [organization] });
            const screen = await renderScreen(<ProjectShowOnPanel project={project} />);
            const reader = await renderHook(() => useProjectAtmosphereEditor(project));
            await chooseShowOn(screen, 'everywhere', 'panel');
            await chooseShowOn(screen, 'home', 'panel');
            await firstPost.promise;
            expect(readSaved().atmosphere).toMatchObject({ showOn: ['home'] });
            expect(readProjectAtmosphere(storage.getState(), project)).toMatchObject({ showOn: everywhere });
            expect(reader.getCurrent().showOn).toEqual(['home']);
            await chooseShowOn(screen, 'everywhere', 'panel');
            await chooseShowOn(screen, 'home', 'panel');
            await chooseShowOn(screen, 'everywhere', 'panel');
            expect(reader.getCurrent().showOn).toEqual(everywhere);
            await screen.unmount();
            acknowledgement.resolve();
            await vi.waitFor(() => {
                expect(writes).toBe(4);
                expect(readSaved().atmosphere).toMatchObject({ showOn: everywhere });
                expect(readProjectAtmosphere(storage.getState(), project)).toMatchObject({ showOn: everywhere });
            });
            expect(readSaved()).toMatchObject({ label: 'Retained Project', pinned: true });
            expect(writes).toBe(4);
            expect(account.settingsWrites).toHaveLength(0);
            expect(account.persistedSettings.homeAtmosphere.showOn).toEqual(everywhere);
        } finally { acknowledgement.resolve(); standardCleanup(); await account.dispose(); }
    });

    it('keeps an inherited Project arrival when real Look closes during a Strength preview across a window', async () => {
        const epoch = 1_800_000_000_000;
        const first = ATMOSPHERE_PICTURES[0]!;
        const next = ATMOSPHERE_PICTURES[1]!;
        const account = await createSecretSettingsTestHarness({ settings: settingsParse({
            homeAtmosphere: { ...settingsParse({}).homeAtmosphere, source: 'picture',
                picture: { ...settingsParse({}).homeAtmosphere.picture, selectedAtMs: epoch } },
        }) });
        const { useProjectAtmosphereEditor } = await import('./useProjectAtmosphereEditor');
        const { LookPopover } = await import('./LookChip');
        const project = { serverId: account.scope.serverId, projectKey: 'inherited-preview-arrival' };
        let shown: ReturnType<typeof useAtmosphere> | undefined;
        function Project({ open }: { open: boolean }) {
            const editor = useProjectAtmosphereEditor(project);
            shown = useAtmosphere({ project });
            const anchorRef = React.useRef(null);
            return <LookPopover target={{ surface: { project }, editor }} open={open}
                anchorRef={anchorRef} onRequestClose={() => {}} />;
        }
        let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
        try {
            vi.spyOn(Date, 'now').mockReturnValue(epoch);
            for (const picture of [first, next]) await pictureStore.put({ localId: 'builtin:' + picture.id,
                kind: 'builtin', data: new Blob(['pixels']), source: picture.src });
            screen = await renderScreen(<Project open />);
            await act(async () => { await pictureStore.get('builtin:' + first.id); });
            expect(shown?.builtinPicture?.id).toBe(first.id);
            vi.spyOn(Date, 'now').mockReturnValue(epoch + 3_600_000);
            const track = screen.findByTestId('look-strength-track');
            if (!track) throw new Error('Missing Strength Slider track');
            await act(async () => { track.props.onLayout({ nativeEvent: { layout: { width: 100, height: 40, x: 0, y: 0 } } }); });
            await act(async () => { track.props.onResponderGrant({ nativeEvent: { locationX: 37, pageX: 37 } }); });
            expect(shown?.looks[first.id]?.strength).toBe(0.37);
            expect(shown?.builtinPicture?.id).toBe(first.id);
            await screen.update(<Project open={false} />);
            await act(async () => { await pictureStore.get('builtin:' + next.id); });
            expect(account.settingsWrites).toHaveLength(0);
            expect(shown?.builtinPicture?.id).toBe(first.id);
            expect(shown?.looks).toEqual(account.persistedSettings.homeAtmosphere.looks);
        } finally {
            await screen?.unmount(); vi.restoreAllMocks();
            for (const picture of [first, next]) await pictureStore.remove('builtin:' + picture.id);
            await account.dispose();
        }
    });

    it('keeps a later Look editor and its preview on the painted shell while a nonempty composer withholds resettling', async () => {
        const epoch = 1_800_000_000_000;
        const first = ATMOSPHERE_PICTURES[0]!;
        const next = ATMOSPHERE_PICTURES[1]!;
        const account = await createSecretSettingsTestHarness({ settings: settingsParse({
            homeAtmosphere: { ...settingsParse({}).homeAtmosphere, source: 'picture',
                picture: { ...settingsParse({}).homeAtmosphere.picture, selectedAtMs: epoch } },
        }) });
        const { AtmosphereLayer } = await import('../AtmosphereLayer');
        const { atmosphereStageStore, useAtmosphereComposerText } = await import('../atmosphereStage');
        const { withPictureLook } = await import('./atmosphereEdits');
        let editor: AtmosphereEditor | undefined;
        const jobs: Extract<BackdropWorkerRequest, { request: unknown }>['request'][] = [];
        let paints = 0;
        vi.stubGlobal('Worker', class {
            onmessage: ((event: { data: BackdropWorkerResponse }) => void) | null = null;
            postMessage(message: BackdropWorkerRequest) {
                if (!('request' in message)) return;
                jobs.push(message.request);
                const { width: w, height: h } = message.request;
                queueMicrotask(() => this.onmessage?.({ data: { id: message.id, ok: true,
                    result: { rgba: new Uint8ClampedArray(w * h * 4), w, h } } }));
            }
            terminate() {}
        });
        vi.stubGlobal('ImageData', class {
            constructor(public data: Uint8ClampedArray, public width: number, public height: number) {}
        });
        const prompt = { getPrompt: () => 'still writing', subscribe: () => () => {} };
        function Home() {
            useAtmosphereComposerText(prompt);
            const atmosphere = useAtmosphere('home');
            return <HomeIdleResettle picture={atmosphere.builtinPicture?.id ?? null} focused writing={false} sending={false} />;
        }
        function Look() { editor = useHomeAtmosphereEditor(); return null; }
        const scene = (open: boolean) => <><AtmosphereLayer sheetRadius={12} chrome={false} /><Home />{open ? <Look /> : null}</>;
        let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
        try {
            vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'performance'] });
            vi.setSystemTime(epoch);
            for (const picture of [first, next]) await pictureStore.put({ localId: `builtin:${picture.id}`,
                kind: 'builtin', data: new Blob(['pixels']), source: picture.src });
            atmosphereStageStore.setStage({ id: -12, surface: 'home', geometry: {
                rect: { x: 0, y: 0, width: 80, height: 60 }, band: 35, horizonAt: 0.86, focus: { x: 40, y: 25 },
            } }, true);
            screen = await renderScreen(scene(false), { createNodeMock: element => element.type === 'canvas'
                ? { getContext: () => ({ putImageData() { paints++; } }) }
                : { measureInWindow: (done: (x: number, y: number, width: number, height: number) => void) => done(0, 0, 80, 60) } });
            await act(async () => { await pictureStore.get(`builtin:${first.id}`); await vi.advanceTimersByTimeAsync(0); });
            expect(paints).toBeGreaterThan(0);
            const painted = screen.findAllHostsByTestId('atmosphere-band')[0];
            const job = jobs.at(-1)!;
            expect(job.source).toMatchObject({ localId: `builtin:${first.id}` });
            await act(async () => { await vi.advanceTimersByTimeAsync(3_600_000); });
            expect(jobs).toHaveLength(1);
            await screen.update(scene(true));
            await act(async () => { await pictureStore.get(`builtin:${next.id}`); });
            expect(editor?.shownPictureRef).toEqual({ kind: 'builtin', id: first.id });
            await act(async () => { editor!.preview!(current => withPictureLook(current, { strength: 0.37 }, ATMOSPHERE_PICTURES, editor!.shownPictureRef)); });
            expect(screen.findAllHostsByTestId('atmosphere-band')[0]).toBe(painted);
            expect(jobs.at(-1)).toMatchObject({ source: { localId: `builtin:${first.id}` }, job: { params: { strength: 0.37 } } });
            expect(account.settingsWrites).toHaveLength(0);
        } finally {
            await screen?.unmount();
            atmosphereStageStore.clearStage(-12);
            vi.useRealTimers(); vi.unstubAllGlobals();
            for (const picture of [first, next]) await pictureStore.remove(`builtin:${picture.id}`);
            await account.dispose();
        }
    });

    it.each(['stale', 'absent'] as const)('anchors a new whole-object picture choice with %s time and retains the time on presentation edits', async time => {
        const epoch = 1_800_000_000_000;
        const account = await createSecretSettingsTestHarness({ settings: settingsParse({
            actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'settings.set': ['ui'] } },
            homeAtmosphere: { ...settingsParse({}).homeAtmosphere, source: 'picture',
                picture: { ...settingsParse({}).homeAtmosphere.picture, selectedAtMs: epoch } },
        }) });
        try {
            const now = epoch + 3_600_000;
            vi.spyOn(Date, 'now').mockReturnValue(now);
            const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
            const { selectAtmosphereSettings } = await import('../resolveAtmosphere');
            const executor = createDefaultActionExecutor();
            const before = account.persistedSettings.homeAtmosphere;
            const { selectedAtMs: _selected, ...picture } = before.picture;
            const wanted = { kind: 'builtin' as const, id: ATMOSPHERE_PICTURES[1]!.id };
            const context = { surface: 'ui' as const, authority: 'present_user' as const, serverId: account.scope.serverId };
            expect(await executor.execute('settings.set', { anchor: 'appearance.homeAtmosphere', value: {
                ...before, picture: { ...picture, ref: wanted, ...(time === 'stale' ? { selectedAtMs: epoch } : {}) },
            } }, context)).toMatchObject({ ok: true });
            const chosen = account.persistedSettings.homeAtmosphere;
            expect(selectAtmosphereSettings('home', chosen, undefined, now).picture.ref).toEqual(wanted);
            expect(chosen.picture.selectedAtMs).toBe(now);
            vi.spyOn(Date, 'now').mockReturnValue(now + 3_600_000);
            expect(await executor.execute('settings.set', { anchor: 'appearance.homeAtmosphere', value: {
                ...chosen, picture: { ...chosen.picture, layout: 'wallpaper' },
            } }, context)).toMatchObject({ ok: true });
            expect(account.persistedSettings.homeAtmosphere.picture).toMatchObject({ ref: wanted, layout: 'wallpaper', selectedAtMs: now });
        } finally { standardCleanup(); vi.restoreAllMocks(); await account.dispose(); }
    });

    it('advances idle windows without real Settings writes and agrees with a newly mounted Home', async () => {
        const account = await createSecretSettingsTestHarness({ settings: settingsParse({
            actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'settings.set': ['ui'] } },
            homeAtmosphere: { ...settingsParse({}).homeAtmosphere, source: 'picture',
                picture: { ...settingsParse({}).homeAtmosphere.picture, selectedAtMs: 1_800_000_000_000 } },
        }) });
        const shown = new Map<string, string | null>();
        const hour = 3_600_000;
        for (const picture of ATMOSPHERE_PICTURES) {
            await pictureStore.put({ localId: `builtin:${picture.id}`, kind: 'builtin', data: new Blob(['pixels']), source: picture.src });
        }
        function Probe({ name }: { name: string }) {
            const atmosphere = useAtmosphere('home');
            const picture = atmosphere.builtinPicture?.id ?? null;
            shown.set(name, picture);
            return <HomeIdleResettle picture={picture} focused writing={false} sending={false} />;
        }
        try {
            vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
            vi.setSystemTime(1_800_000_000_000);
            const screen = await renderScreen(<><Probe key="first" name="first" /></>);
            await act(async () => { await vi.advanceTimersByTimeAsync(0); });
            expect(shown.get('first')).toBe(ATMOSPHERE_PICTURES[0]!.id);
            for (let window = 1; window <= 3; window += 1) {
                await act(async () => {
                    await vi.advanceTimersByTimeAsync(hour);
                    // Settle the real image reads started by admission before observing transport writes.
                    await Promise.all(ATMOSPHERE_PICTURES.map(picture => pictureStore.get(`builtin:${picture.id}`)));
                    await vi.advanceTimersByTimeAsync(0);
                });
                expect(account.settingsWrites).toHaveLength(0);
                expect(shown.get('first')).toBe(ATMOSPHERE_PICTURES[window]!.id);
            }
            await screen.update(<><Probe key="first" name="first" /><Probe key="second" name="second" /></>);
            await act(async () => { await vi.advanceTimersByTimeAsync(0); });
            expect(shown.get('second')).toBe(shown.get('first'));
            expect(account.settingsWrites).toHaveLength(0);
            expect(account.persistedSettings.homeAtmosphere.picture.ref).toEqual({ kind: 'builtin', id: ATMOSPHERE_PICTURES[0]!.id });
            await screen.unmount();
        } finally {
            standardCleanup();
            vi.useRealTimers();
            for (const picture of ATMOSPHERE_PICTURES) await pictureStore.remove(`builtin:${picture.id}`);
            await account.dispose();
        }
    });
    it('admits the real Show background on control under Off, Ask reject/approve and Allowed', async () => {
        const account = await createSecretSettingsTestHarness({ settings: settingsParse({ memoryUseInNewSessions: false,
            actionsSettingsV1: { v: 1, actions: { 'settings.set': { disabledSurfaces: ['ui'] } } },
        }) });
        const alert = vi.spyOn(Modal, 'alert');
        try {
            const screen = await renderScreen(<AtmosphereWhereItShows />);
            await chooseShowOn(screen, 'everywhere');
            await vi.waitFor(() => expect(alert).toHaveBeenCalled());
            expect(account.persistedSettings.homeAtmosphere.showOn.includes('sessions')).toBe(false);
            expect(account.settingsWrites).toEqual([]);

            await act(async () => { account.replaceSettings(settingsParse({ ...account.persistedSettings,
                actionsSettingsV1: { v: 1, actions: { 'settings.set': { approvalRequiredSurfaces: ['ui'] } } },
            })); });
            await chooseShowOn(screen, 'everywhere');
            await vi.waitFor(() => expect(account.artifacts.list()).toHaveLength(1));
            expect(account.settingsWrites).toEqual([]);
            await decideApprovalAsInbox(account.scope.serverId, account.artifacts.list()[0]!.id, 'reject');
            expect(account.persistedSettings.homeAtmosphere.showOn.includes('sessions')).toBe(false);

            await chooseShowOn(screen, 'everywhere');
            await vi.waitFor(() => expect(account.artifacts.list()).toHaveLength(2));
            await decideApprovalAsInbox(account.scope.serverId, account.artifacts.list()[1]!.id, 'approve');
            await vi.waitFor(() => expect(account.persistedSettings.homeAtmosphere.showOn.includes('sessions')).toBe(true));
            expect(storage.getState().settings.homeAtmosphere.showOn.includes('sessions')).toBe(true);

            await act(async () => { account.replaceSettings(settingsParse({ ...account.persistedSettings,
                actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'settings.set': ['ui'] } },
            })); });
            await chooseShowOn(screen, 'home');
            await vi.waitFor(() => expect(account.persistedSettings.homeAtmosphere.showOn.includes('sessions')).toBe(false));
            expect(account.persistedSettings.memoryUseInNewSessions).toBe(false);
            expect(account.artifacts.list()).toHaveLength(2);
        } finally { standardCleanup(); await account.dispose(); }
    });

    it('edits the latest Home snapshot and preserves custom pictures, sibling fields and absent catalog choices', async () => {
        const account = await createSecretSettingsTestHarness({ settings: settingsParse({ memoryUseInNewSessions: false,
            actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'settings.set': ['ui'] } },
        }) });
        const localId = 'atmosphere-editor-picture';
        await pictureStore.put({ localId, kind: 'user', data: new Blob(['pixels'], { type: 'image/webp' }) });
        try {
            const editor = await renderHook(() => useHomeAtmosphereEditor());
            const staleUpdate = editor.getCurrent().update;
            const staleHomeUpdate = editor.getCurrent().updateHome;
            const currentHome = { ...account.persistedSettings.homeAtmosphere, source: 'picture' as const,
                picture: { ref: { kind: 'user' as const, localId }, layout: 'horizon' as const },
                showOn: ['home', 'new-session', 'projects', 'sessions'], moments: { ...account.persistedSettings.homeAtmosphere.moments, welcome: false },
                looks: { 'acme.gallery/aurora': { look: 'fine' as const, strength: 1 }, [localId]: { look: 'engraving' as const } },
            };
            await act(async () => { account.replaceSettings(settingsParse({ ...account.persistedSettings, homeAtmosphere: currentHome })); });
            await act(async () => { await staleUpdate(current => ({ ...current, picture: { ...current.picture, layout: 'wallpaper' } })); });
            await vi.waitFor(() => expect(account.persistedSettings.homeAtmosphere.picture.layout).toBe('wallpaper'));
            expect(account.persistedSettings.homeAtmosphere).toMatchObject({ ...currentHome,
                picture: { ref: { kind: 'user', localId }, layout: 'wallpaper' } });
            expect(editor.getCurrent().value).toEqual(account.persistedSettings.homeAtmosphere);
            expect(await pictureStore.get(localId)).toMatchObject({ kind: 'user' });

            const picture = ATMOSPHERE_PICTURES[0]!;
            const release = releaseLook(picture);
            await act(async () => { await staleHomeUpdate(current => ({ ...current,
                looks: { ...current.looks, [picture.id]: { look: release.effect, strength: release.strength, dissolve: release.fade } },
            })); });
            await vi.waitFor(() => expect(account.persistedSettings.homeAtmosphere.looks).toEqual(currentHome.looks));
            expect(account.persistedSettings.homeAtmosphere.picture.layout).toBe('wallpaper');
            expect(account.persistedSettings.memoryUseInNewSessions).toBe(false);

            const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
            const before = account.persistedSettings.homeAtmosphere;
            expect(await createDefaultActionExecutor().execute('settings.set', { anchor: 'appearance.homeAtmosphere',
                value: { ...before, picture: { ...before.picture, ref: { kind: 'user', localId: 17 } } },
            }, { surface: 'ui', authority: 'present_user', serverId: account.scope.serverId }))
                .toMatchObject({ ok: false, errorCode: 'invalid_setting_value' });
            expect(account.persistedSettings.homeAtmosphere).toEqual(before);
        } finally { standardCleanup(); await pictureStore.remove(localId); await account.dispose(); }
    });
});
