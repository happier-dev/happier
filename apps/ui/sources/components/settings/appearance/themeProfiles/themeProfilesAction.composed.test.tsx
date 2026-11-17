import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import axios from 'axios';
import type { Socket } from 'socket.io-client';
import type { Theme } from '@/theme';
import { THEME_ACTION_IDS } from '@happier-dev/protocol/actions/themeActionIdsV1';
import { THEME_ARTIFACT_KIND } from '@happier-dev/protocol/account/settings/themeProfileArtifact';
import { ArtifactReadHeadersBatchInputV1Schema } from '@happier-dev/protocol/artifacts/artifactAccessV1';
import { parseThemeProfileDocument, type ThemeProfileDocument } from '@happier-dev/protocol/account/settings/themeProfiles';

import { renderHook, renderSettingsView } from '@/dev/testkit';
import { countStoreNotifications, createRenderCommitCounter, useRenderCommitCounter } from '@/dev/testkit/performance/counts';
import { measureMountedCollections } from '@/dev/testkit/render/renderInCollectionLayout';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createPlainArtifactHttpFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { createSecretSettingsTestHarness, type SecretSettingsTestHarness } from '@/components/settings/secrets/secretSettingsTestHarness';
import { settingsParse } from '@/sync/domains/settings/settings';
import { storage } from '@/sync/domains/state/storage';
import { createFrontDoorActionExecute, requireActionSuccess } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { createThemeProfileDraft } from '@/theme/profiles/createThemeProfileDraft';
import { projectThemeLibraryEntry, projectThemeMiniature, projectThemeMiniaturePalette } from '@/theme/profiles/themeProfilePresentation';
import { getThemePresetSourceReferenceId } from './themeProfilePresetOptions';
import { Modal } from '@/modal';
import type { createThemePluginShareForm } from './themePluginShareForm';
import { createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { ActionInputFormModal, type ActionInputFormModalProps } from '@/components/plugins/actions/ActionInputFormModal';
import { ActionInputFields } from '@/components/sessions/actions/ActionInputFields';
import { useThemePluginShare } from './useThemePluginShare';
import { useThemeActionExecution } from './useThemeActionExecution';
import { useLocalSetting } from '@/sync/store/settingsReadHooks';
import { useThemeLibraryEntries, useThemeProfileReferenceSelection } from '@/sync/store/useThemeProfiles';
import { useApplyThemeSelection } from '../useApplyThemeSelection';

const router = vi.hoisted(() => ({ back: vi.fn(), push: vi.fn() }));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
    Appearance: { getColorScheme: () => 'light' },
}));
vi.mock('react-native-unistyles', async () => {
    const { lightTheme, darkTheme } = await import('@/theme');
    const themes = { light: lightTheme, dark: darkTheme };
    // Unistyles is the platform boundary; preserve its stored-theme update semantics.
    return (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock({ runtime: {
        getTheme: (name: 'light' | 'dark') => themes[name],
        updateTheme: (name: 'light' | 'dark', update: (theme: Theme) => Theme) => { themes[name] = update(themes[name]); },
    } });
});
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ router }).module);
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('expo-status-bar', () => ({ setStatusBarStyle: vi.fn() }));
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', async importOriginal => {
    const original = await importOriginal<typeof import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')>();
    return { ...original, createFrontDoorActionExecute:
        (await import('@/dev/testkit/harness/frontDoorActionExecutorBoundary')).createFrontDoorActionExecuteForVitest(original) };
});

const boundarySockets = new Set<Socket>();
installDisconnectedServerSocketBoundary(socket => {
    socket.id = 'theme-ui-client';
    boundarySockets.add(socket);
});
await loadSyncSingletonForTests();
const { sync } = await import('@/sync/sync');
const { ThemeProfilesSettingsScreen } = await import('./ThemeProfilesSettingsScreen');
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const originalState = storage.getState();
const originalAxiosAdapter = axios.defaults.adapter;
afterEach(() => {
    standardCleanup(); storage.setState(originalState, true); axios.defaults.adapter = originalAxiosAdapter;
    for (const socket of boundarySockets) socket.id = 'theme-ui-client';
    vi.unstubAllGlobals(); router.back.mockClear(); router.push.mockClear();
});

const firstId = '11111111-1111-4111-8111-111111111111';
const siblingId = '22222222-2222-4222-8222-222222222222';
function document(id: string, name: string): ThemeProfileDocument {
    const parsed = parseThemeProfileDocument({ ...createThemeProfileDraft({ id, name, now: '2026-11-16T12:00:00.000Z' }),
        assetAppearance: 'light', overrides: { light: { 'background.canvas': '#F1E2D3' }, dark: {} },
        futureThemeField: { retained: true } });
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.document;
}

/** Seed the Home's persisted bytes; the real Sync inventory reader must publish the private headers. */
async function seedLibrary(account: SecretSettingsTestHarness, documents = [document(firstId, 'Custom theme'), document(siblingId, 'Sibling theme')]) {
    for (const value of documents) {
        const entry = projectThemeLibraryEntry(value);
        const rawHeader = { v: 1, kind: THEME_ARTIFACT_KIND, title: entry.name, mode: entry.mode, themeSource: entry.source,
            compatibility: entry.compatibility, palette: projectThemeMiniaturePalette(value.profile) };
        account.artifacts.replaceStoredRow(createPlainArtifactHttpFixture({ id: entry.id, title: entry.name,
            body: JSON.stringify(value.raw), rawHeader, headerVersion: 1, bodyVersion: 1, seq: 1,
            createdAt: Date.parse(value.profile.createdAt), updatedAt: Date.parse(value.profile.updatedAt), isDecrypted: true,
            ownerAccountId: account.scope.accountId, access: 'owner', sourceServerId: account.scope.serverId }, account.scope.accountId));
    }
    await sync.awaitBootstrapForegroundAcquisition();
    await sync.fetchArtifactsList({ kinds: [THEME_ARTIFACT_KIND] });
    return documents;
}

/** Approval policy remains the real Account-owned policy, with only Home HTTP/credential storage synthetic. */
describe('theme profile library Action ingress', () => {
    it('keeps the same try bar mounted through exit and paints the chosen preview mode', async () => {
        const account = await createSecretSettingsTestHarness({ settings: settingsParse({}) });
        const { ThemeTryBarHost } = await import('@/theme/ThemeTryBarHost');
        const { ThemeTryBar } = await import('./ThemeTryBar');
        const { getThemeTryOnOwner } = await import('@/theme/profiles/themeTryOnRuntime');
        try {
            await sync.awaitBootstrapForegroundAcquisition();
            storage.getState().applyLocalSettings({ themePreference: 'light' });
            const parsed = parseThemeProfileDocument({ ...document(firstId, 'Two modes').raw,
                overrides: { light: { 'background.canvas': '#F1E2D3' }, dark: { 'background.canvas': '#172033' } } });
            if (!parsed.ok) throw new Error(parsed.error);
            getThemeTryOnOwner().begin({ document: parsed.document, mode: 'dark', origin: { kind: 'agent' } });
            const screen = await renderSettingsView(React.createElement(ThemeTryBarHost));
            const bar = screen.findAllByType<typeof ThemeTryBar>(ThemeTryBar)[0]!;
            expect(bar.props).toMatchObject({ visible: true, switchToMode: 'dark', faceName: 'Two modes',
                miniature: projectThemeMiniature(parsed.document.profile, 'dark') });
            await act(async () => { await bar.props.onRevert(); });
            expect(getThemeTryOnOwner().read()).toBeNull();
            const exiting = screen.findAllByType<typeof ThemeTryBar>(ThemeTryBar)[0];
            expect(exiting).toBe(bar);
            expect(exiting?.props.visible).toBe(false);
        } finally { standardCleanup(); await account.dispose(); }
    });

    it('publishes mode and slot once per Apply or Undo and isolates mode-only subscriber renders', async () => {
        const account = await createSecretSettingsTestHarness({ settings: settingsParse({}) });
        let notifications: ReturnType<typeof countStoreNotifications<ReturnType<typeof storage.getState>>> | undefined;
        try {
            await seedLibrary(account);
            const previousSelection = { light: { kind: 'artifact' as const, id: firstId }, dark: null };
            storage.getState().applyLocalSettings({ themePreference: 'light', themeProfileSelection: previousSelection });
            const modeCount = createRenderCommitCounter();
            const selectionCount = createRenderCommitCounter();
            const libraryCount = createRenderCommitCounter();
            const mode = await renderHook(() => {
                useRenderCommitCounter(modeCount);
                return { preference: useLocalSetting('themePreference'), apply: useApplyThemeSelection() };
            });
            const selection = await renderHook(() => {
                useRenderCommitCounter(selectionCount);
                return useThemeProfileReferenceSelection();
            });
            const library = await renderHook(() => {
                useRenderCommitCounter(libraryCount);
                return useThemeLibraryEntries();
            });
            const entries = library.getCurrent();
            notifications = countStoreNotifications(storage);
            const reset = () => { notifications?.reset(); modeCount.reset(); selectionCount.reset(); libraryCount.reset(); };
            const localPublications = () => notifications!.read().filter(keys => keys.includes('localSettings'));
            reset();
            const execute = createFrontDoorActionExecute();
            let undoHandle = '';
            await act(async () => {
                const applied = await execute(THEME_ACTION_IDS.apply,
                    { ref: { kind: 'built-in', presetId: 'nightDark' }, mode: 'dark' }, { surface: 'ui' });
                requireActionSuccess(applied, THEME_ACTION_IDS.apply);
                if (!applied.result || typeof applied.result !== 'object' || !('undoHandle' in applied.result)
                    || typeof applied.result.undoHandle !== 'string') throw new Error('Apply did not return its Undo handle');
                undoHandle = applied.result.undoHandle;
            });
            expect(localPublications()).toHaveLength(1);
            expect(mode.getCurrent().preference).toBe('dark');
            expect(selection.getCurrent()).toEqual({ ...previousSelection, dark: { kind: 'built-in', presetId: 'nightDark' } });
            expect(modeCount.read()).toEqual({ renders: 1, commits: 1 });
            expect(selectionCount.read()).toEqual({ renders: 1, commits: 1 });
            expect(libraryCount.read()).toEqual({ renders: 0, commits: 0 });
            expect(library.getCurrent()).toBe(entries);

            reset();
            await act(async () => {
                requireActionSuccess(await execute(THEME_ACTION_IDS.undo, { undoHandle }, { surface: 'ui' }), THEME_ACTION_IDS.undo);
            });
            expect(localPublications()).toHaveLength(1);
            expect(mode.getCurrent().preference).toBe('light');
            expect(selection.getCurrent()).toEqual(previousSelection);
            expect(modeCount.read()).toEqual({ renders: 1, commits: 1 });
            expect(selectionCount.read()).toEqual({ renders: 1, commits: 1 });
            expect(libraryCount.read()).toEqual({ renders: 0, commits: 0 });

            const retainedSelection = selection.getCurrent();
            reset();
            await act(async () => { expect(await mode.getCurrent().apply('adaptive')).toBe(true); });
            expect(localPublications()).toHaveLength(1);
            expect(mode.getCurrent().preference).toBe('adaptive');
            expect(modeCount.read()).toEqual({ renders: 1, commits: 1 });
            expect(selectionCount.read()).toEqual({ renders: 0, commits: 0 });
            expect(libraryCount.read()).toEqual({ renders: 0, commits: 0 });
            expect(selection.getCurrent()).toBe(retainedSelection);
            expect(library.getCurrent()).toBe(entries);
        } finally { notifications?.stop(); standardCleanup(); await account.dispose(); }
    });

    it('resolves Share Machine choices in the captured Home without treating its local form fields as Action fields', async () => {
        const machine = createPlainMachineRowFixture({ id: 'theme-author', accountId: 'account-a' });
        const account = await createSecretSettingsTestHarness({
            settings: settingsParse({}),
            handleRequest: async path => path === '/v1/machines' || path === '/v1/machines?includeRevoked=true'
                ? Response.json([machine]) : null,
        });
        let share: ReturnType<typeof useThemePluginShare> | undefined;
        function ShareLauncher() {
            share = useThemePluginShare(useThemeActionExecution());
            return null;
        }
        try {
            await sync.awaitBootstrapForegroundAcquisition();
            await sync.refreshMachines({ serverId: account.scope.serverId });
            await renderSettingsView(React.createElement(ShareLauncher));
            vi.mocked(Modal.show).mockClear();
            await act(async () => { share?.([{ kind: 'artifact', id: firstId }]); });
            const presentation = vi.mocked(Modal.show).mock.calls.at(-1)?.[0];
            expect(presentation).toBeDefined();
            const props = presentation!.props as Omit<ActionInputFormModalProps, 'onClose' | 'setChrome'>;
            const machineField = props.form.getFields().find(field => field.path === 'machine')!;
            // The existing Action field proves this Home's Machine inventory works before testing the local form.
            const control = await createFrontDoorActionExecute()('action.options.resolve', {
                actionId: 'browser.extensions.install', fieldPath: 'machineId', draftInput: {},
            }, { surface: 'ui', serverId: account.scope.serverId, runtimeAccountId: account.scope.accountId });
            requireActionSuccess(control, 'action.options.resolve');
            expect(control.result).toMatchObject({ options: [
                { value: machine.id },
            ] });
            const screen = await renderSettingsView(React.createElement(ActionInputFormModal, {
                ...props, onClose: vi.fn(), setChrome: vi.fn(),
            }));
            const readMachineOptions = () => screen.findAllByType<typeof ActionInputFields>(ActionInputFields)[0]!.props.resolveFieldOptions;
            await vi.waitFor(() => {
                const state = readMachineOptions().state?.(machineField);
                expect(state, JSON.stringify(state)).toMatchObject({ status: 'ready' });
            });
            expect(readMachineOptions()(machineField)).toMatchObject([
                { value: { serverId: account.scope.serverId, machineId: machine.id } },
            ]);
            expect(props.form.getInput()).toEqual({});
            await act(async () => screen.findAllByType<typeof ActionInputFields>(ActionInputFields)[0]!.props.onPatch({
                machine: { serverId: account.scope.serverId, machineId: machine.id },
            }));
            expect(props.form.getInput()).toEqual({ machine: { serverId: account.scope.serverId, machineId: machine.id } });
        } finally { standardCleanup(); await account.dispose(); }
    });

    it('refuses explicit absent Account scope without borrowing the active library', async () => {
        const account = await createSecretSettingsTestHarness({ settings: settingsParse({}) });
        try {
            await sync.awaitBootstrapForegroundAcquisition();
            await expect(sync.withThemeProfileLibrary(async () => 'admitted', { expectedScope: account.scope }))
                .resolves.toBe('admitted');
            await expect(sync.withThemeProfileLibrary(async () => 'borrowed current Account', { expectedScope: null }))
                .rejects.toThrow('Artifact Account scope changed');
        } finally { standardCleanup(); await account.dispose(); }
    });
    it('saves and selects an addressed theme beyond fifty profiles without removing siblings', async () => {
        const account = await createSecretSettingsTestHarness({ settings: settingsParse({ actionsSettingsV1: { v: 1,
            approvalWaivedSurfaces: { 'settings.set': ['ui'] },
        } }) });
        try {
            const existing = [document(firstId, 'Custom theme'), document(siblingId, 'Sibling theme'),
                ...Array.from({ length: 48 }, (_, index) => document(`aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, '0')}`, `Theme ${index}`))];
            await seedLibrary(account, existing);
            const extra = document('theme-extra', 'Extra theme');
            const execute = createFrontDoorActionExecute();
            const saved = await execute(THEME_ACTION_IDS.save, { document: extra }, { surface: 'ui' });
            requireActionSuccess(saved, THEME_ACTION_IDS.save);
            const entriesBeforeSelect = await sync.withThemeProfileLibrary(library => library.list(), { expectedScope: account.scope });
            const entry = entriesBeforeSelect.find(entry => entry.name === 'Extra theme')!;
            const selected = await execute(THEME_ACTION_IDS.apply, { ref: entry.reference, mode: 'light' }, { surface: 'ui' });
            requireActionSuccess(selected, THEME_ACTION_IDS.apply);
            const reference = storage.getState().localSettings.themeProfileSelection?.light;
            expect(reference?.kind).toBe('artifact');
            const entries = await sync.withThemeProfileLibrary(library => library.list(), { expectedScope: account.scope });
            expect(entries.find(entry => entry.name === 'Extra theme')?.reference).toEqual(reference);
            expect(entries.filter(entry => entry.source.kind === 'yours')).toHaveLength(51);
            expect(account.artifacts.readPlainBody(siblingId)).not.toBeNull();
        } finally { standardCleanup(); await account.dispose(); }
    });

    it('activates the acknowledged saved document without acquiring the whole header library', async () => {
        const account = await createSecretSettingsTestHarness({ settings: settingsParse({ actionsSettingsV1: { v: 1,
            approvalWaivedSurfaces: { 'settings.set': ['ui'] },
        } }) });
        try {
            await sync.awaitBootstrapForegroundAcquisition();
            const before = account.request.mock.calls.length;
            const saved = document(firstId, 'Save and activate');
            const execute = createFrontDoorActionExecute();
            requireActionSuccess(await execute(THEME_ACTION_IDS.save, { document: saved }, { surface: 'ui' }), THEME_ACTION_IDS.save);
            const result = await execute(THEME_ACTION_IDS.apply, { ref: { kind: 'artifact', id: firstId }, mode: 'light' }, { surface: 'ui' });
            expect(account.request.mock.calls.slice(before).filter(([url, init]) =>
                new URL(String(url)).pathname === '/v1/artifacts' && (!init?.method || init.method === 'GET'))).toEqual([]);
            requireActionSuccess(result, THEME_ACTION_IDS.apply);
            expect(storage.getState().localSettings.themeProfileSelection?.light).toEqual({ kind: 'artifact', id: firstId });
            expect(account.settingsWrites).toEqual([]);
        } finally { standardCleanup(); await account.dispose(); }
    });

    it('browses private headers and tries a saved theme before Keep when its Action is allowed', async () => {
        const account = await createSecretSettingsTestHarness({ settings: settingsParse({ actionsSettingsV1: { v: 1,
            actions: { [THEME_ACTION_IDS.tryOn]: { disabledSurfaces: ['ui'] } },
        } }) });
        try {
            await seedLibrary(account);
            storage.getState().applyLocalSettings({ themePreference: 'light', themeProfileSelection: {
                light: null, dark: { kind: 'built-in', presetId: 'nightDark' },
            }, uiFontScale: 1.15 });
            const beforeBrowse = account.request.mock.calls.length;
            const screen = await renderSettingsView(React.createElement(ThemeProfilesSettingsScreen));
            await measureMountedCollections(screen);
            const key = getThemePresetSourceReferenceId({ kind: 'artifact', id: firstId });
            expect(screen.findAllByProps({ testID: `settings-theme-light:${key}` }).length).toBeGreaterThan(0);
            const browseRequests = account.request.mock.calls.slice(beforeBrowse);
            expect(browseRequests.flatMap(([url, init]) => {
                const path = new URL(String(url)).pathname;
                if (path === `/v1/artifacts/${firstId}` || path === `/v1/artifacts/${siblingId}`) return [{ path }];
                if (path !== '/v1/artifacts/read') return [];
                const body: unknown = JSON.parse(String(init?.body));
                // Addressed header acquisition shares the endpoint, and never acquires a body.
                return ArtifactReadHeadersBatchInputV1Schema.safeParse(body).success ? [] : [{ path, body }];
            })).toEqual([]);
            // The real visual grid reveals an unselected theme's operations on hover.
            const frame = screen.tree.findAll(node => typeof node.props.onHoverIn === 'function' && node.props.accessible === false
                && node.findAll(child => child.props.testID === `settings-theme-light:${key}`).length > 0)[0]!;
            await act(async () => { frame.props.onHoverIn(); });
            const share = screen.findAllByProps({ testID: `settings-theme-tile-menu-${key}` })
                .flatMap(node => (node.props.actions ?? []) as readonly { id: string; onSelect: () => void }[])
                .find(action => action.id === 'share-plugin');
            expect(share).toBeDefined();
            vi.mocked(Modal.show).mockClear();
            await act(async () => { share?.onSelect(); });
            // Modal presentation is the boundary; the mounted controller supplies the real form.
            const shareForm = vi.mocked(Modal.show).mock.calls.at(-1)?.[0].props?.form as
                ReturnType<typeof createThemePluginShareForm> | undefined;
            expect(shareForm?.getInput()).toEqual({ refs: [{ kind: 'artifact', id: firstId }] });
            expect(shareForm?.getFields()).toMatchObject([
                { path: 'refs', required: true, widget: 'multiselect' },
                { path: 'machine', required: true, inputType: { hostType: 'machine' } },
                { path: 'path', required: true },
            ]);
            expect(shareForm?.getFields().find(field => field.path === 'refs')?.options).toEqual(expect.arrayContaining([
                { value: { kind: 'artifact', id: firstId }, label: 'Custom theme' },
                { value: { kind: 'artifact', id: siblingId }, label: 'Sibling theme' },
            ]));
            shareForm?.cancel();
            expect(shareForm?.isRetired()).toBe(true);
            const siblingBefore = account.artifacts.readPlainBody(siblingId);
            vi.mocked(Modal.alert).mockClear();
            await screen.pressByTestIdAsync(`settings-theme-light:${key}`);
            await vi.waitFor(() => expect(Modal.alert).toHaveBeenCalled());
            expect(storage.getState().localSettings.themeProfileSelection?.light).toBeNull();
            await act(async () => { account.replaceSettings(settingsParse({ ...account.persistedSettings, actionsSettingsV1: {
                v: 1, approvalWaivedSurfaces: { [THEME_ACTION_IDS.tryOn]: ['ui'] },
            } })); });
            vi.mocked(Modal.alert).mockClear();
            await screen.pressByTestIdAsync(`settings-theme-light:${key}`);
            const { getThemeTryOnOwner } = await import('@/theme/profiles/themeTryOnRuntime');
            await vi.waitFor(() => expect(getThemeTryOnOwner().read()?.document?.profile.id).toBe(firstId));
            expect(storage.getState().localSettings.themeProfileSelection?.light).toBeNull();
            requireActionSuccess(await createFrontDoorActionExecute()(THEME_ACTION_IDS.keep,
                { previewRef: getThemeTryOnOwner().read()!.previewRef }, { surface: 'ui' }), THEME_ACTION_IDS.keep);
            await vi.waitFor(() => expect(storage.getState().localSettings.themeProfileSelection).toEqual({
                light: { kind: 'artifact', id: firstId }, dark: { kind: 'built-in', presetId: 'nightDark' },
            }));
            await screen.pressByTestIdAsync('settings-theme-light:light');
            await vi.waitFor(() => expect(getThemeTryOnOwner().read()?.document).toBeNull());
            requireActionSuccess(await createFrontDoorActionExecute()(THEME_ACTION_IDS.keep,
                { previewRef: getThemeTryOnOwner().read()!.previewRef }, { surface: 'ui' }), THEME_ACTION_IDS.keep);
            await vi.waitFor(() => expect(storage.getState().localSettings.themeProfileSelection).toEqual({
                light: null, dark: { kind: 'built-in', presetId: 'nightDark' },
            }));
            expect(Modal.alert).not.toHaveBeenCalled();
            // An offline local apply must settle successfully, with no invented transport identity.
            for (const socket of boundarySockets) socket.id = undefined;
            const result = await createFrontDoorActionExecute()(THEME_ACTION_IDS.apply,
                { ref: { kind: 'artifact', id: firstId }, mode: 'light' }, { surface: 'ui' });
            requireActionSuccess(result, THEME_ACTION_IDS.apply);
            expect(result.result).toMatchObject({ applied: { mode: 'light' }, undoHandle: expect.any(String) });
            expect(result.result).not.toHaveProperty('applied.clientId');
            expect(storage.getState().localSettings.uiFontScale).toBe(1.15);
            expect(account.artifacts.readPlainBody(siblingId)).toBe(siblingBefore);
            expect(account.settingsWrites).toEqual([]);
        } finally { standardCleanup(); await account.dispose(); }
    });

    it('keeps generic theme settings readable while writes use the theme Action owner', async () => {
        const account = await createSecretSettingsTestHarness({ settings: settingsParse({}) });
        try {
            await seedLibrary(account);
            const execute = createFrontDoorActionExecute();
            const anchor = 'appearance.themes.yourThemes';
            const read = await execute('settings.get', { anchor }, { surface: 'ui' });
            expect(read).toMatchObject({ ok: true, result: { anchor } });
            const before = account.artifacts.readPlainBody(firstId);
            for (const css of ['', '[data-surface="composer"] { display: none }']) {
                const value = document(firstId, 'Generic write');
                const result = await execute('settings.set', { anchor,
                    value: { saveDocument: { ...value.raw, css } } }, { surface: 'ui' });
                expect(result).toMatchObject({ ok: false, errorCode: 'setting_read_only' });
                expect(account.artifacts.readPlainBody(firstId)).toBe(before);
            }
        } finally { standardCleanup(); await account.dispose(); }
    });

    it('edits an addressed Artifact through the default Action executor without replacing siblings or future fields', async () => {
        const account = await createSecretSettingsTestHarness({ settings: settingsParse({ actionsSettingsV1: { v: 1,
            approvalWaivedSurfaces: { [THEME_ACTION_IDS.save]: ['ui'] },
        } }) });
        try {
            const [before] = await seedLibrary(account);
            const edited = parseThemeProfileDocument({ ...before!.raw, name: 'Edited here' });
            if (!edited.ok) throw new Error(edited.error);
            const siblingBefore = account.artifacts.readPlainBody(siblingId);
            const execute = createFrontDoorActionExecute();
            const result = await execute(THEME_ACTION_IDS.save, { ref: { kind: 'artifact', id: firstId }, document: edited.document }, { surface: 'ui' });
            expect(result.ok ? 'ok' : result.errorCode).toBe('ok');
            expect(JSON.parse(account.artifacts.readPlainBody(firstId)!)).toMatchObject({ name: 'Edited here', futureThemeField: { retained: true } });
            expect(account.artifacts.readPlainBody(siblingId)).toBe(siblingBefore);
            expect(account.artifacts.list().map(row => row.id)).toEqual([firstId, siblingId]);
            expect(account.settingsWrites).toEqual([]);
        } finally { standardCleanup(); await account.dispose(); }
    });
});
