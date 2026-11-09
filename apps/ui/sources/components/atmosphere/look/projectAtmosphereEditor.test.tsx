import 'fake-indexeddb/auto';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProjectAccountRowCipherV1 } from '@happier-dev/protocol/projects/projectAccountRowCipherV1';
import { PROJECT_ACCOUNT_ROWS_ROUTE_V1, ProjectAccountOrganizationV1Schema, ProjectAccountRowMutationRequestV1Schema,
    ProjectAccountRowMutationResponseV1Schema } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { decideApprovalAsInbox } from '@/dev/testkit/harness/approvalInbox';
import { applyProjectAccountRowsFixture, createPlainProjectAccountRowListFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import { createSecretSettingsTestHarness } from '@/components/settings/secrets/secretSettingsTestHarness';
import { settingsParse } from '@/sync/domains/settings/settings';
import { storage } from '@/sync/domains/state/storage';
import { readProjectAtmosphere } from '@/sync/store/domains/projectAccountRows';
import { Modal } from '@/modal';
import { createDeferred } from '@/dev/testkit';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('@/components/atmosphere/pictureStore', async () => import('../pictureStore.web'));
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { useProjectAtmosphereEditor } = await import('./useProjectAtmosphereEditor');
const { AtmosphereShowOnPanel } = await import('./AtmosphereShowOnControl');
const originalState = storage.getState();
afterEach(() => { standardCleanup(); vi.restoreAllMocks(); storage.setState(originalState, true); });

async function createProjectHarness(mode: 'plain' | 'e2ee' = 'plain') {
    const account = await createSecretSettingsTestHarness({ mode, settings: settingsParse({
        actionsSettingsV1: { v: 1, actions: { 'settings.set': { disabledSurfaces: ['ui'] } } },
    }) });
    // Observe the real cold Sync census before measuring control-triggered reads.
    await vi.waitFor(() => expect(storage.getState().projectAccountRows).toMatchObject({
        scope: account.scope, status: 'ready', coverage: 'complete',
    }));
    const project = { serverId: account.scope.serverId, projectKey: 'admitted-project' };
    const key = { kind: 'project-organization' as const, ...project };
    const { moments: _moments, ...atmosphere } = account.persistedSettings.homeAtmosphere;
    const organization = { key, revision: 0, value: { label: 'Retained', pinned: true, atmosphere } };
    const listed = createPlainProjectAccountRowListFixture({ organizations: [organization] });
    if (listed.status !== 'listed') throw new Error('Expected complete Project fixture');
    const { resolveAccountScopedCryptoMaterialFromCredentials } = await import('@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials');
    const { getRandomBytes } = await import('@/platform/cryptoRandom');
    const cipher = createProjectAccountRowCipherV1({ mode,
        material: mode === 'plain' ? null : resolveAccountScopedCryptoMaterialFromCredentials(account.credentials), randomBytes: getRandomBytes });
    const plain = createProjectAccountRowCipherV1({ mode: 'plain', material: null, randomBytes: getRandomBytes });
    const rows = listed.rows.map(item => ({ ...item, content: item.content ? cipher.seal(plain.open(item.key, item.content)) : null }));
    let row = rows.find(item => item.key.kind === 'project-organization')!;
    const read = () => {
        if (!row.content) throw new Error('Expected organization');
        return ProjectAccountOrganizationV1Schema.parse(cipher.open(key, row.content).value);
    };
    let writes = 0;
    let reads = 0;
    let conflicts = 0;
    let conflictNext = false;
    const requests: string[] = [];
    let held: { issued: ReturnType<typeof createDeferred<void>>; acknowledgement: ReturnType<typeof createDeferred<void>> } | undefined;
    const request = account.request.getMockImplementation()!;
    account.request.mockImplementation(async (input, init) => {
        const path = new URL(String(input)).pathname;
        requests.push(`${init?.method ?? 'GET'} ${path}`);
        if (path === `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`) {
            reads++;
            return Response.json({ ...listed, rows: [...rows.filter(item => item.key.kind !== 'project-organization'), row] });
        }
        if (path !== `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/mutate`) return request(input, init);
        const mutation = ProjectAccountRowMutationRequestV1Schema.parse(JSON.parse(String(init?.body)));
        expect(mutation.mutations).toHaveLength(1);
        const changed = mutation.mutations[0]!;
        expect(changed.key).toEqual(key);
        if (conflictNext) {
            conflictNext = false;
            conflicts++;
            const saved = read();
            row = { ...row, revision: row.revision + 1, content: cipher.seal({ key, value: { ...saved, label: 'Concurrent winner' } }) };
            return Response.json({ status: 'conflict', key, revision: row.revision });
        }
        expect(changed.expectedRevision).toBe(row.revision);
        row = { key, revision: row.revision + 1, content: changed.content };
        const pause = held;
        held = undefined;
        if (pause) { pause.issued.resolve(); await pause.acknowledgement.promise; }
        return Response.json(ProjectAccountRowMutationResponseV1Schema.parse({ status: 'updated', rows: [row], cursor: ++writes }));
    });
    storage.setState({ profileScope: account.scope });
    applyProjectAccountRowsFixture(storage, { organizations: [organization] });
    return { account, project, read, writes: () => writes, reads: () => reads, conflicts: () => conflicts,
        requests, conflictNext: () => { conflictNext = true; },
        holdNext: () => {
            const pause = { issued: createDeferred<void>(), acknowledgement: createDeferred<void>() };
            held = pause;
            return { issued: pause.issued.promise, release: () => pause.acknowledgement.resolve() };
        },
        replace: (value: ReturnType<typeof read>) => {
            row = { ...row, revision: row.revision + 1, content: cipher.seal({ key, value }) };
        } };
}

describe('Project atmosphere Settings Action ingress', () => {
    it.each(['plain', 'e2ee'] as const)('commits ten mode gestures with one fresh row read and one CAS each in %s', async mode => {
        const fixture = await createProjectHarness(mode);
        const { account, project, read } = fixture;
        try {
            account.replaceSettings(settingsParse({ ...account.persistedSettings,
                actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'settings.set': ['ui'] } },
            }));
            function Panel() { return <AtmosphereShowOnPanel editor={useProjectAtmosphereEditor(project)} />; }
            const screen = await renderScreen(<Panel />);
            const before = fixture.reads();
            const requestStart = fixture.requests.length;
            const transitions: unknown[] = [];
            let previous = JSON.stringify(readProjectAtmosphere(storage.getState(), project));
            const unsubscribe = storage.subscribe(state => {
                const value = readProjectAtmosphere(state, project);
                const next = JSON.stringify(value);
                if (next !== previous) { previous = next; transitions.push(value && value !== 'home' ? value.showOn : value); }
            });
            try {
                await act(async () => {
                    for (let index = 0; index < 10; index++) {
                        await screen.pressByTestIdAsync(`look-show-on:${index % 2 === 0 ? 'home' : 'everywhere'}`);
                    }
                    await vi.waitFor(() => expect(fixture.writes()).toBe(10));
                });
            } finally { unsubscribe(); }
            expect(read()).toMatchObject({ label: 'Retained', pinned: true,
                atmosphere: { showOn: ['home', 'new-session', 'projects', 'sessions', 'pages'] } });
            expect(readProjectAtmosphere(storage.getState(), project)).toMatchObject({ showOn: ['home', 'new-session', 'projects', 'sessions', 'pages'] });
            expect(fixture.conflicts()).toBe(0);
            expect(transitions).toEqual(Array.from({ length: 10 }, (_, index) => index % 2 === 0 ? ['home']
                : ['home', 'new-session', 'projects', 'sessions', 'pages']));
            expect(fixture.reads() - before).toBe(10);
            expect(account.settingsWrites).toHaveLength(0);
            const routes = fixture.requests.slice(requestStart).reduce<Record<string, number>>((counts, route) => {
                counts[route] = (counts[route] ?? 0) + 1;
                return counts;
            }, {});
            console.info('PROJSETLAT_REQUEST_COUNTS', JSON.stringify({ mode, gestures: 10, routes, conflicts: fixture.conflicts() }));
        } finally { standardCleanup(); await account.dispose(); }
    });

    it('publishes the Project change only after the HTTP acknowledgement arrives', async () => {
        const fixture = await createProjectHarness();
        const { account, project } = fixture;
        let pending: unknown;
        let pause: ReturnType<typeof fixture.holdNext> | undefined;
        try {
            account.replaceSettings(settingsParse({ ...account.persistedSettings,
                actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'settings.set': ['ui'] } },
            }));
            const editor = await renderHook(() => useProjectAtmosphereEditor(project));
            const original = readProjectAtmosphere(storage.getState(), project);
            pause = fixture.holdNext();
            await act(async () => { pending = editor.getCurrent().setShowOn!(['home']); await pause!.issued; });
            expect(fixture.read().atmosphere).toMatchObject({ showOn: ['home'] });
            expect(readProjectAtmosphere(storage.getState(), project)).toEqual(original);
            await act(async () => { pause!.release(); await pending; });
            expect(readProjectAtmosphere(storage.getState(), project)).toMatchObject({ showOn: ['home'] });
            expect(fixture.writes()).toBe(1);
        } finally { pause?.release(); await pending; standardCleanup(); await account.dispose(); }
    });

    it('settles a real intervening organization conflict without retrying or publishing the rejected edit', async () => {
        const fixture = await createProjectHarness();
        const { account, project, read } = fixture;
        try {
            account.replaceSettings(settingsParse({ ...account.persistedSettings,
                actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'settings.set': ['ui'] } },
            }));
            const editor = await renderHook(() => useProjectAtmosphereEditor(project));
            const original = readProjectAtmosphere(storage.getState(), project);
            const before = fixture.reads();
            fixture.conflictNext();
            await act(async () => { await editor.getCurrent().setShowOn!(['home']); });
            expect(fixture.conflicts()).toBe(1);
            expect(fixture.writes()).toBe(0);
            expect(fixture.reads() - before).toBe(1);
            expect(read().label).toBe('Concurrent winner');
            expect(readProjectAtmosphere(storage.getState(), project)).toEqual(original);
            expect(Modal.alert).toHaveBeenCalled();
        } finally { standardCleanup(); await account.dispose(); }
    });

    it('admits the real Show background on control under Off, Ask reject/approve and Allowed', async () => {
        const fixture = await createProjectHarness();
        const { account, project, read } = fixture;
        function Panel() { return <AtmosphereShowOnPanel editor={useProjectAtmosphereEditor(project)} />; }
        try {
            const screen = await renderScreen(<Panel />);
            await screen.pressByTestIdAsync('look-show-on:home');
            await vi.waitFor(() => expect(Modal.alert).toHaveBeenCalled());
            expect(fixture.writes()).toBe(0);
            await act(async () => { account.replaceSettings(settingsParse({ ...account.persistedSettings,
                actionsSettingsV1: { v: 1, actions: { 'settings.set': { approvalRequiredSurfaces: ['ui'] } } },
            })); });
            await screen.pressByTestIdAsync('look-show-on:home');
            await vi.waitFor(() => expect(account.artifacts.list()).toHaveLength(1));
            expect(fixture.writes()).toBe(0);
            await decideApprovalAsInbox(account.scope.serverId, account.artifacts.list()[0]!.id, 'reject');
            expect(fixture.writes()).toBe(0);
            await screen.pressByTestIdAsync('look-show-on:home');
            await vi.waitFor(() => expect(account.artifacts.list()).toHaveLength(2));
            await decideApprovalAsInbox(account.scope.serverId, account.artifacts.list()[1]!.id, 'approve');
            await vi.waitFor(() => expect(read().atmosphere).toMatchObject({ showOn: ['home'] }));
            expect(readProjectAtmosphere(storage.getState(), project)).toMatchObject({ showOn: ['home'] });
            await act(async () => { account.replaceSettings(settingsParse({ ...account.persistedSettings,
                actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'settings.set': ['ui'] } },
            })); });
            await screen.pressByTestIdAsync('look-show-on:everywhere');
            await vi.waitFor(() => expect(read().atmosphere).toMatchObject({ showOn: ['home', 'new-session', 'projects', 'sessions', 'pages'] }));
            expect(read()).toMatchObject({ label: 'Retained', pinned: true });
            expect(account.settingsWrites).toHaveLength(0);
            expect(account.artifacts.list()).toHaveLength(2);
        } finally { standardCleanup(); await account.dispose(); }
    });

    it('admits update and reset while previews stay transient, and applies approved edits to the fresh row', async () => {
        const fixture = await createProjectHarness();
        const { account, project, read } = fixture;
        try {
            const editor = await renderHook(() => useProjectAtmosphereEditor(project));
            await act(async () => { editor.getCurrent().preview!(current => ({ ...current, source: 'none' })); });
            expect(editor.getCurrent().value.source).toBe('none');
            expect(fixture.writes()).toBe(0);
            await act(async () => { editor.getCurrent().preview!(undefined); });
            await act(async () => { await editor.getCurrent().update(current => ({ ...current, source: 'none' })); });
            await vi.waitFor(() => expect(Modal.alert).toHaveBeenCalled());
            await act(async () => { await editor.getCurrent().resetToHome!(); });
            expect(fixture.writes()).toBe(0);
            await act(async () => { account.replaceSettings(settingsParse({ ...account.persistedSettings,
                actionsSettingsV1: { v: 1, actions: { 'settings.set': { approvalRequiredSurfaces: ['ui'] } } },
            })); });
            let pending: unknown;
            await act(async () => { pending = editor.getCurrent().update(current => ({ ...current, source: 'none' })); });
            await vi.waitFor(() => expect(account.artifacts.list()).toHaveLength(1));
            const saved = read();
            if (!saved.atmosphere || saved.atmosphere === 'home') throw new Error('Expected override');
            fixture.replace({ ...saved, label: 'Changed during approval', atmosphere: { ...saved.atmosphere,
                planet: { ...saved.atmosphere.planet, digits: false }, showOn: ['projects'] } });
            await decideApprovalAsInbox(account.scope.serverId, account.artifacts.list()[0]!.id, 'approve');
            await act(async () => { await pending; });
            expect(read()).toMatchObject({ label: 'Changed during approval', pinned: true,
                atmosphere: { source: 'none', planet: { digits: false }, showOn: ['projects'] } });
            await act(async () => { account.replaceSettings(settingsParse({ ...account.persistedSettings,
                actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'settings.set': ['ui'] } },
            })); });
            await act(async () => { await editor.getCurrent().resetToHome!(); });
            await vi.waitFor(() => expect(read().atmosphere).toBe('home'));
            expect(read()).toMatchObject({ label: 'Changed during approval', pinned: true });
        } finally { standardCleanup(); await account.dispose(); }
    });
});
