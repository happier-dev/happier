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

import { renderSettingsView } from '@/dev/testkit';
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
import { projectThemeLibraryEntry, projectThemeMiniaturePalette } from '@/theme/profiles/themeProfilePresentation';
import { getThemePresetSourceReferenceId } from './themeProfilePresetOptions';
import { Modal } from '@/modal';
import { createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { ActionInputFormModal, type ActionInputFormModalProps } from '@/components/plugins/actions/ActionInputFormModal';
import { ActionInputFields } from '@/components/sessions/actions/ActionInputFields';
import { useThemePluginShare } from './useThemePluginShare';
import { useThemeActionExecution } from './useThemeActionExecution';

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
    it('saves and selects a legacy activation beyond fifty profiles without removing siblings', async () => {
        const account = await createSecretSettingsTestHarness({ settings: settingsParse({ actionsSettingsV1: { v: 1,
            approvalWaivedSurfaces: { 'settings.set': ['ui'] },
        } }) });
        try {
            const existing = [document(firstId, 'Custom theme'), document(siblingId, 'Sibling theme'),
                ...Array.from({ length: 48 }, (_, index) => document(`aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, '0')}`, `Theme ${index}`))];
            await seedLibrary(account, existing);
            const profiles = existing.map(value => value.profile);
            const extra = document('theme-extra', 'Extra theme');
            const result = await createFrontDoorActionExecute()('settings.set', { anchor: 'appearance.themeMode', value: {
                activation: { profileId: extra.profile.id, profileMode: 'light', nextThemePreference: 'light', profile: extra.profile,
                    before: { profiles, activeProfileIds: { light: null, dark: null } } }, reduceMotion: true,
            } }, { surface: 'ui' });
            requireActionSuccess(result, 'settings.set');
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
            const result = await execute('settings.set', { anchor: 'appearance.themeMode', value: {
                activation: { profileId: firstId, profileMode: 'light', nextThemePreference: 'light', saveDocument: saved.raw },
                reduceMotion: true,
            } }, { surface: 'ui' });
            expect(account.request.mock.calls.slice(before).filter(([url, init]) =>
                new URL(String(url)).pathname === '/v1/artifacts' && (!init?.method || init.method === 'GET'))).toEqual([]);
            requireActionSuccess(result, 'settings.set');
            expect(storage.getState().localSettings.themeProfileSelection?.light).toEqual({ kind: 'artifact', id: firstId });
            expect(account.settingsWrites).toEqual([]);
        } finally { standardCleanup(); await account.dispose(); }
    });

    it('browses private headers without bodies and applies a saved theme only when its Action is allowed', async () => {
        const account = await createSecretSettingsTestHarness({ settings: settingsParse({ actionsSettingsV1: { v: 1,
            actions: { [THEME_ACTION_IDS.apply]: { disabledSurfaces: ['ui'] } },
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
            const siblingBefore = account.artifacts.readPlainBody(siblingId);
            vi.mocked(Modal.alert).mockClear();
            await screen.pressByTestIdAsync(`settings-theme-light:${key}`);
            await vi.waitFor(() => expect(Modal.alert).toHaveBeenCalled());
            expect(storage.getState().localSettings.themeProfileSelection?.light).toBeNull();
            await act(async () => { account.replaceSettings(settingsParse({ ...account.persistedSettings, actionsSettingsV1: {
                v: 1, approvalWaivedSurfaces: { [THEME_ACTION_IDS.apply]: ['ui'] },
            } })); });
            vi.mocked(Modal.alert).mockClear();
            await screen.pressByTestIdAsync(`settings-theme-light:${key}`);
            await vi.waitFor(() => expect(storage.getState().localSettings.themeProfileSelection).toEqual({
                light: { kind: 'artifact', id: firstId }, dark: { kind: 'built-in', presetId: 'nightDark' },
            }));
            await screen.pressByTestIdAsync('settings-theme-light:light');
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
