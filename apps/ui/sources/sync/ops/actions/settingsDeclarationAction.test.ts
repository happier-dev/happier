// Enter through the mounted catalog consumer, matching App-shell evaluation:
// a cold owner-first import can observe the catalog mid-initialization.
import '@/components/settings/catalog/runtime/useResolvedSettingsPageCatalog';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import 'fake-indexeddb/auto';
// Vite does not apply Metro's .web selection. Use the real IndexedDB device adapter for this web owner.
vi.mock('@/components/atmosphere/pictureStore', async () => import('@/components/atmosphere/pictureStore.web'));

const humanConfirmation = vi.hoisted(() => ({ confirm: vi.fn(async () => false) }));
const settingsMachineRpc = vi.hoisted(() => vi.fn());
const catalogAudio = vi.hoisted(() => ({ play: vi.fn(), remove: vi.fn(), addListener: vi.fn(() => ({ remove: vi.fn() })) }));
// Expo is the OS media-player boundary; the shared preview and audio-mode owners stay real.
vi.mock('expo-audio', () => ({ createAudioPlayer: () => catalogAudio,
    AudioModule: { setAudioModeAsync: vi.fn(async () => {}) } }));
// The daemon transport is a genuine system boundary; clients, schemas, declarations and policy remain real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async (importOriginal) => {
    const original = await importOriginal<typeof import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc')>();
    // The declaration graph can import the daemon client while this transport module is loading.
    // Spy on the actual boundary export too, so that captured module namespace uses this same boundary.
    vi.spyOn(original, 'machineRpcWithServerScope').mockImplementation(settingsMachineRpc);
    return { ...original, machineRpcWithServerScope: settingsMachineRpc };
});
const themeRuntime = vi.hoisted(() => ({
    setTheme: vi.fn(),
    updateTheme: vi.fn<(name: string, update: (theme: import('@/theme').Theme) => import('@/theme').Theme) => void>(),
    setRootViewBackgroundColor: vi.fn(),
    setStatusBarStyle: vi.fn(),
}));
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    const mock = createModalModuleMock();
    mock.module.Modal.confirm = humanConfirmation.confirm;
    return mock.module;
});

// The theme owner applies a written mode to the platform: the OS colour scheme, the status bar and
// the root view colour are host boundaries; the theme runtime below them stays real.
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Appearance: { getColorScheme: () => 'light' } });
});
vi.mock('expo-status-bar', () => ({ setStatusBarStyle: themeRuntime.setStatusBarStyle }));
vi.mock('expo-system-ui', () => ({ setBackgroundColorAsync: vi.fn(async () => {}) }));
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({ runtime: {
        setTheme: themeRuntime.setTheme,
        updateTheme: themeRuntime.updateTheme,
        setRootViewBackgroundColor: themeRuntime.setRootViewBackgroundColor,
    } });
});

import { settingsDefaults, applySettings, settingsParse, type Settings } from '@/sync/domains/settings/settings';
import { localSettingsDefaults, applyLocalSettings } from '@/sync/domains/settings/localSettings';
import * as desktopHostBoundary from '@/utils/platform/desktopHost';
import { createSettingsDeclarationAction, resolveSettingsDeclarationOperationApprovalPolicy } from './settingsDeclarationAction';
import { UI_FONT_SCALE_PRESETS } from '@/components/ui/text/uiFontScale';
import { readSettingsPageGate } from '@/components/settings/catalog/pageCatalog';
import { ActionsSettingsV1Schema, createActionExecutor, FeaturesResponseSchema, getModelPackCatalogEntry, isApprovalRequiredByActionsSettings, VoiceProviderContributionSchema, type ActionsSettingsV1, type AutomationV3Settings } from '@happier-dev/protocol';
import { createVoiceProviderRegistry } from '@/voice/registry/providerRegistry';
import { commitExternalVoiceProviderRegistration, removeExternalVoiceProviderRegistration } from '@/voice/registry/externalVoiceProviderRegistrations';
import { getResolvedAgentCatalogEntries } from '@/agents/backendCatalog/agentCatalogProjection';
import { getEnabledAgentIds } from '@/agents/catalog/enabled';
import { readLocalConversationVoiceSettings, writeLocalConversationVoiceSettings, readVoiceDiagnosticsSettings, writeVoiceProviderSettingsConfig } from '@/sync/domains/settings/voiceSettings';
import { normalizeVoiceSettingsLocalDelta } from '@/sync/domains/settings/voiceSettingsPersistence';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { activateStorageAccountScope } from '@/dev/testkit/mocks/storage';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { PluginManifestV2Schema } from '@happier-dev/protocol/plugins/manifest';
import { projectBundledVoiceManifestContributions } from '@/voice/registry/bundledVoiceManifestProjection';
import { resolveVoiceConversationLanguageSetting } from '@/voice/settings/voiceSettingsDeclarations';
import { t } from '@/text';
import { buildScmDiffSummaryModelProfiles } from '@/settings/scmDiffSummary/models';
import { getAgentCore, getAgentStaticModels } from '@happier-dev/agents';
import { readBackendTargetRefV2 } from '@happier-dev/protocol';
import { getResolvedBackendCatalogEntries } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { createScmDiffSummarySettingsCatalogReader } from './scmDiffSummarySettingsCatalog';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { resolveRuntimeFeatureDecisionFromSnapshot } from '@/sync/domains/features/featureDecisionRuntime';
import type { ServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { captureLazyActionAccountContext } from './actionAccountContext';
import { createExternalActionAccountHttpBoundary } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { setServerProfileIdentityForUrl } from '@/sync/domains/server/serverProfiles';
import { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1 } from '@/sync/domains/machines/administration/selectionPreferences';
import { readAcpCatalogInContext } from '@/sync/api/account/apiAcpCatalog';
import { ACP_CATALOG_ROWS_ROUTE_V1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { darkTheme } from '@/theme';
import type { ApprovalRequest } from '@happier-dev/protocol/approvals/approvalRequestV1';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/actionExecutor';
import type { SettingsMutationServices } from '@/components/settings/catalog/settingDeclarations';
import { createAtmosphereSettingServices } from './atmosphereSettingServices';
import { ProjectAccountRowMutationRequestV1Schema, type ProjectAccountRowV1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import * as systemTaskRuntimeBoundary from '@/components/systemTasks/systemTasksRuntime';
import { createManualSystemTaskRunner } from '@/dev/testkit/harness/manualSystemTaskRunner';
import { publishLocalDaemonStatus, readLocalDaemonSharedState } from '@/components/settings/machines/localControl/localDaemonSharedState';
import type { LocalDaemonStatusData } from '@/components/settings/machines/localControl/useLocalDaemonControl';

describe('Track device-local Settings declaration', () => {
    it('lets an agent read and write Track with SCM writes disabled without changing Account settings', async () => {
        const initialAccount = applySettings(settingsDefaults, { actionsSettingsV1: ActionsSettingsV1Schema.parse({
            ...settingsDefaults.actionsSettingsV1,
            approvalWaivedSurfaces: { 'settings.set': ['agent'] },
        }) });
        // File tracking is independent of SCM write admission; the agent still needs its explicit Settings waiver.
        const owner = createOwner(undefined, false, true, initialAccount);
        const executor = throughActionExecutor(owner.action, () => owner.account().actionsSettingsV1);
        const context = { surface: 'agent', authority: 'account_automation' } as const;
        expect(await executor.execute('settings.get', { anchor: 'files.trackAgentEdits' }, context))
            .toEqual({ ok: true, result: { anchor: 'files.trackAgentEdits', value: false } });
        expect(await executor.execute('settings.set', { anchor: 'files.trackAgentEdits', value: true }, context))
            .toMatchObject({ ok: true, result: { value: true } });
        expect(owner.local().filesTrackAgentEdits).toBe(true);
        expect(owner.account()).toEqual(initialAccount);
        expect(await executor.execute('settings.set', { anchor: 'files.trackAgentEdits', value: 'true' }, context))
            .toMatchObject({ ok: false, errorCode: 'invalid_setting_value' });
        expect(owner.local().filesTrackAgentEdits).toBe(true);
    });
});

describe('image Background device-local Settings declaration', () => {
    it('reads and changes the manual image and SVG preferences through the real Actions owner', async () => {
        const initialAccount = applySettings(settingsDefaults, { actionsSettingsV1: ActionsSettingsV1Schema.parse({
            ...settingsDefaults.actionsSettingsV1,
            approvalWaivedSurfaces: { 'settings.set': ['agent'] },
        }) });
        const owner = createOwner(undefined, false, true, initialAccount);
        const executor = throughActionExecutor(owner.action, () => owner.account().actionsSettingsV1);
        const context = { surface: 'agent', authority: 'account_automation' } as const;
        expect(await executor.execute('settings.get', { anchor: 'files.imageBackground' }, context))
            .toEqual({ ok: true, result: { anchor: 'files.imageBackground', value: {} } });
        expect(await executor.execute('settings.set', {
            anchor: 'files.imageBackground', value: { image: 'dark', svg: 'light' },
        }, context)).toMatchObject({ ok: true, result: { value: { image: 'dark', svg: 'light' } } });
        expect(owner.local().filesImageBackgroundByKind).toEqual({ image: 'dark', svg: 'light' });
        expect(owner.account()).toEqual(initialAccount);
        expect(await executor.execute('settings.set', {
            anchor: 'files.imageBackground', value: { svg: 'automatic' },
        }, context)).toMatchObject({ ok: false, errorCode: 'invalid_setting_value' });
        expect(owner.local().filesImageBackgroundByKind).toEqual({ image: 'dark', svg: 'light' });
    });
});

describe('desktop login-start service-backed Settings declaration', () => {
    const anchor = 'desktop.startOnLogin';
    const status = (mode: 'at-login' | 'on-demand' | null): LocalDaemonStatusData => ({
        serviceInstalled: true, daemonRunning: true, needsAuth: false, machineId: 'desktop-machine',
        serviceAutostart: mode, managedServiceInstalled: true,
    });

    function desktopServiceBoundary(mode: 'at-login' | 'on-demand' | null) {
        const manual = createManualSystemTaskRunner();
        // Substitute the native runner acquisition boundary; task lifecycle and shared status stay real.
        const runnerBoundary = vi.spyOn(systemTaskRuntimeBoundary, 'getSystemTasksRunner').mockReturnValue(manual.runner);
        const desktopBoundary = vi.spyOn(desktopHostBoundary, 'isDesktopHost').mockReturnValue(true);
        onTestFinished(() => { runnerBoundary.mockRestore(); desktopBoundary.mockRestore(); });
        publishLocalDaemonStatus(manual.runner, status(mode));
        return manual;
    }

    it.each([true, false])('reads the service fact and changes every managed service through its native owner: %s', async (enabled) => {
        const manual = desktopServiceBoundary(enabled ? 'on-demand' : 'at-login');
        const owner = createOwner({ os: 'web', desktop: true });
        expect(await owner.action({ actionId: 'settings.get', input: { anchor } })).toEqual({ anchor, value: !enabled });

        const written = owner.action({ actionId: 'settings.set', input: { anchor, value: enabled } });
        await vi.waitFor(() => expect(manual.bridge.start.mock.calls[0]?.[0].kind).toBe('daemon.service.autostart.set.v1'));
        const autostartSpec = manual.bridge.start.mock.calls[0]?.[0];
        expect(autostartSpec?.params).toMatchObject({ target: { kind: 'local' }, mode: 'user', autostart: enabled ? 'at-login' : 'on-demand' });
        expect(autostartSpec?.params).not.toHaveProperty('relayUrl');
        expect(autostartSpec?.params).not.toHaveProperty('serverIdentityId');
        manual.emitResult('personal-home-task-1', { protocolVersion: 1, taskId: 'personal-home-task-1', ok: true, data: {} });
        await vi.waitFor(() => expect(manual.bridge.start.mock.calls[1]?.[0].kind).toBe('daemon.service.status.v1'));
        manual.emitResult('personal-home-task-2', { protocolVersion: 1, taskId: 'personal-home-task-2', ok: true, data: status(enabled ? 'at-login' : 'on-demand') });

        expect(await written).toEqual({ anchor, value: enabled });
        expect(await owner.action({ actionId: 'settings.get', input: { anchor } })).toEqual({ anchor, value: enabled });
        expect(readLocalDaemonSharedState<LocalDaemonStatusData>(manual.runner).status?.serviceAutostart).toBe(enabled ? 'at-login' : 'on-demand');
        expect(owner.local()).toEqual(localSettingsDefaults);
        expect(owner.account()).toEqual(settingsDefaults);
    });

    it('keeps a mixed service mode unavailable and refuses a write instead of inventing a preference', async () => {
        const manual = desktopServiceBoundary(null);
        const owner = createOwner({ os: 'web', desktop: true });
        const executor = throughActionExecutor(owner.action);
        const context = { surface: 'ui', authority: 'present_user', presentUserConfirmation: { actionId: 'settings.set' } } as const;
        expect(await executor.execute('settings.get', { anchor }, context)).toMatchObject({ ok: false, errorCode: 'setting_value_unavailable' });
        expect(await executor.execute('settings.set', { anchor, value: true }, context)).toMatchObject({ ok: false, errorCode: 'setting_value_unavailable' });
        expect(manual.bridge.start).not.toHaveBeenCalled();
        expect(owner.local()).toEqual(localSettingsDefaults);
    });

    it('refuses a stale invocation before starting a native service change', async () => {
        const manual = desktopServiceBoundary('on-demand');
        const owner = createOwner({ os: 'web', desktop: true }, false, true, settingsDefaults,
            undefined, undefined, undefined, { isCurrent: () => false });
        expect(await owner.action({ actionId: 'settings.set', input: { anchor, value: true } }))
            .toMatchObject({ errorCode: 'setting_not_bound' });
        expect(manual.bridge.start).not.toHaveBeenCalled();
    });

    it('cancels its admitted native change and does not refresh after invocation cancellation', async () => {
        const manual = desktopServiceBoundary('on-demand');
        const owner = createOwner({ os: 'web', desktop: true });
        const controller = new AbortController();
        const written = owner.action({ actionId: 'settings.set', input: { anchor, value: true }, context: { signal: controller.signal } });
        void written.catch(() => undefined);
        await vi.waitFor(() => expect(manual.bridge.start.mock.calls[0]?.[0].kind).toBe('daemon.service.autostart.set.v1'));
        controller.abort();
        await expect(written).rejects.toMatchObject({ name: 'AbortError' });
        expect(manual.bridge.cancel).toHaveBeenCalledWith('personal-home-task-1');
        expect(manual.bridge.start.mock.calls.map(([spec]) => spec.kind)).toEqual(['daemon.service.autostart.set.v1']);
        expect(readLocalDaemonSharedState<LocalDaemonStatusData>(manual.runner).status?.serviceAutostart).toBe('on-demand');
    });
});
import { SettingsDeclarationActionOutputSchemasV1 } from '@happier-dev/protocol/actions/settingsDeclarationActionFamily';

describe('exact Account Settings history purge declaration', () => {
    it('requires incumbent approval and refuses execution without an Account history transport', async () => {
        expect(resolveSettingsDeclarationOperationApprovalPolicy('account.settingsHistory', settingsDefaults))
            .toEqual({ requiresApproval: true, uiConfirmationRequired: true });
        const { action } = createOwner();
        const listing = await action({ actionId: 'settings.list', input: { pageId: 'account' } });
        expect(listing).toMatchObject({ items: expect.arrayContaining([expect.objectContaining({
            anchor: 'account.settingsHistory', operation: { actionId: 'settings.invoke', requiresHumanInteraction: false, requiresApproval: true },
        })]) });
        expect(await action({ actionId: 'settings.invoke', input: { anchor: 'account.settingsHistory',
            input: { kind: 'account_settings_history_purge', versions: [3] } } })).toEqual({
            anchor: 'account.settingsHistory', status: 'unavailable', reason: 'history_transport_unavailable',
        });
    });
});

describe('Home atmosphere settings declarations', () => {
    it('discovers and edits every Home control while rebasing nested edits over sibling changes', async () => {
        const owner = createOwner(undefined, false, true, settingsDefaults, undefined, settings => ({
            ...settings, homeAtmosphere: { ...settings.homeAtmosphere, moments: { ...settings.homeAtmosphere.moments, welcome: false } },
        }), undefined, undefined, undefined, {});
        const choices = [
            ['atmosphereSource', 'picture'], ['atmospherePlanetPlacement', 'rise'], ['atmospherePlanetStyle', 'rich'],
            ['atmospherePlanetDigits', false], ['atmospherePictureRef', { kind: 'builtin', id: 'calm-sea' }],
            ['atmospherePictureLayout', 'wallpaper'], ['atmosphereBehindSessions', true],
            ['atmosphereMoments', { send: false, loading: true }],
        ] as const;
        const listing = await owner.action({ actionId: 'settings.list', input: { pageId: 'appearance' } });
        expect(listing).toMatchObject({ items: expect.arrayContaining(choices.map(([id]) => expect.objectContaining({
            anchor: `appearance.${id}`, readable: true, writable: true,
        }))) });
        for (const [id, value] of choices) {
            expect(await owner.action({ actionId: 'settings.set', input: { anchor: `appearance.${id}`, value } }))
                .toEqual({ anchor: `appearance.${id}`, value });
            if (id === 'atmospherePlanetStyle') expect(owner.account().homeAtmosphere.moments.welcome).toBe(false);
        }
        expect(owner.account().homeAtmosphere).toMatchObject({ source: 'picture',
            planet: { placement: 'rise', style: 'rich', digits: false },
            picture: { ref: { kind: 'builtin', id: 'calm-sea' }, layout: 'wallpaper' }, behindSessions: true,
            moments: { send: false, loading: true },
        });
        expect(await owner.action({ actionId: 'settings.reset', input: {
            anchor: 'appearance.atmospherePlanetDigits', expected: { value: false },
        } })).toEqual({ anchor: 'appearance.atmospherePlanetDigits', value: true });
        expect(await owner.action({ actionId: 'settings.reset', input: {
            anchor: 'appearance.atmospherePlanetDigits', expected: { value: false },
        } })).toMatchObject({ errorCode: 'account_settings_mutation_conflict' });
        expect(await owner.action({ actionId: 'settings.reset', input: { anchor: 'appearance.atmospherePlanetStyle' } }))
            .toEqual({ anchor: 'appearance.atmospherePlanetStyle', value: 'balanced' });
        expect(owner.account().homeAtmosphere.planet).toEqual({ placement: 'rise', style: 'balanced', digits: true });
    });

    it('stores only per-picture differences and resets through the same canonical mutation', async () => {
        const owner = createOwner();
        expect(await owner.action({ actionId: 'settings.set', input: { anchor: 'appearance.atmosphereLooks',
            value: { 'white-rocks-open-sea': { look: 'fine', strength: 1, dissolve: 'ordered' },
                'calm-sea': { look: 'halftone', strength: 0.8, dissolve: 'haze' } } } })).toMatchObject({ anchor: 'appearance.atmosphereLooks' });
        expect(owner.account().homeAtmosphere.looks).toEqual({ 'calm-sea': { look: 'halftone', strength: 0.8, dissolve: 'haze' } });
        expect(await owner.action({ actionId: 'settings.reset', input: { anchor: 'appearance.atmosphereLooks' } }))
            .toEqual({ anchor: 'appearance.atmosphereLooks', value: {} });
        expect(owner.account().homeAtmosphere.looks).toEqual({});
    });

    it('refuses the removed numeric fade field without changing remembered choices', async () => {
        const owner = createOwner();
        const before = owner.account().homeAtmosphere;
        const result = await owner.action({ actionId: 'settings.set', input: { anchor: 'appearance.atmosphereLooks',
            value: { 'calm-sea': { fade: 0.55 } } } });
        expect(result).toMatchObject({ ok: false });
        expect(owner.account().homeAtmosphere).toEqual(before);
    });

    it('requires approval by default for local picture removal through real Action admission', async () => {
        expect(resolveSettingsDeclarationOperationApprovalPolicy('appearance.atmospherePictureRemove', settingsDefaults))
            .toEqual({ requiresApproval: true, uiConfirmationRequired: true });
        expect(resolveSettingsDeclarationOperationApprovalPolicy('appearance.atmospherePictureAdd', settingsDefaults))
            .toEqual({ requiresApproval: false, uiConfirmationRequired: false });
        const owner = createOwner();
        const executor = throughActionExecutor(owner.action, () => settingsDefaults.actionsSettingsV1);
        const result = await executor.execute('settings.invoke', { anchor: 'appearance.atmospherePictureRemove',
            input: { kind: 'atmosphere_picture_remove', localId: 'user-1' } }, { surface: 'agent', authority: 'account_automation' });
        expect(result).toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
    });
});

describe('Home atmosphere picture and Project mutations', () => {
    it('edits the captured public-profile draft through Settings Actions without changing Home or glass', async () => {
        const { moments: _moments, behindSessions: _behindSessions, ...initial } = settingsDefaults.homeAtmosphere;
        let draft = initial;
        let current = true;
        const owner = ownerWithServices({ ...services(), publicProfileAtmosphereDraft: {
            serverId: 'home-a', isCurrent: () => current, read: () => ({ ...draft, behindSessions: true, moments: { private: true } }),
            update: edit => { draft = edit(draft); },
        } });
        const executor = throughActionExecutor(owner.action);
        const context = { surface: 'ui', authority: 'present_user', presentUserConfirmation: { actionId: 'settings.set' } } as const;
        const target = { kind: 'public_profile_draft', serverId: 'home-a' };
        expect(await executor.execute('settings.get', { anchor: 'appearance.atmosphereSource', target }, context))
            .toMatchObject({ ok: true, result: { value: initial.source } });
        expect(await executor.execute('settings.set', { anchor: 'appearance.atmosphereSource', target, value: 'none' }, context))
            .toMatchObject({ ok: true, result: { value: 'none' } });
        expect(draft.source).toBe('none');
        expect(await executor.execute('settings.get', { anchor: 'appearance.homeAtmosphere', target }, context))
            .toEqual({ ok: true, result: { anchor: 'appearance.homeAtmosphere', value: { ...initial, source: 'none' } } });
        expect(await executor.execute('settings.set', { anchor: 'appearance.homeAtmosphere', target,
            value: { ...initial, behindSessions: true } }, context)).toMatchObject({ ok: false, errorCode: 'invalid_setting_value' });
        expect(await owner.action({ actionId: 'settings.reset', input: { anchor: 'appearance.atmosphereSource', target } }))
            .toMatchObject({ value: initial.source });
        await executor.execute('settings.set', { anchor: 'appearance.atmosphereSource', target, value: 'none' }, context);
        expect(owner.account()).toEqual(settingsDefaults);
        expect(await executor.execute('settings.set', { anchor: 'appearance.atmosphereBehindSessions', target, value: true }, context))
            .toMatchObject({ ok: false, errorCode: 'setting_target_mismatch' });
        expect(await executor.execute('settings.set', { anchor: 'appearance.atmosphereSource', target: { ...target, serverId: 'home-b' }, value: 'planet' }, context))
            .toMatchObject({ ok: false, errorCode: 'setting_target_mismatch' });
        current = false;
        expect(await executor.execute('settings.set', { anchor: 'appearance.atmosphereSource', target, value: 'planet' }, context))
            .toMatchObject({ ok: false, errorCode: 'setting_not_bound' });
        expect(draft.source).toBe('none');
        expect(owner.account()).toEqual(settingsDefaults);
    });

    function services(request: Parameters<typeof createAtmosphereSettingServices>[0]['request'] = async () => { throw new Error('unexpected_http'); }) {
        return createAtmosphereSettingServices({ serverId: 'home-a', accountId: 'account-a', credentials: { token: 'plain-token' },
            assertCurrent: () => {}, resolveAccountEncryption: async () => ({ accountMode: 'plain', encryption: null }), request });
    }
    function ownerWithServices(mutationServices: SettingsMutationServices) {
        return createOwner(undefined, false, true, settingsDefaults, undefined, undefined, undefined, undefined, undefined, mutationServices);
    }

    it('acquires a picked picture into the captured draft and discovers the same device library without Home writes', async () => {
        const { moments: _moments, behindSessions: _behindSessions, ...initial } = settingsDefaults.homeAtmosphere;
        let draft = initial;
        const picked = new Blob(['picked-picture'], { type: 'image/png' });
        // OS image decode/canvas and picker are platform boundaries; ingress/store/Actions remain real.
        vi.stubGlobal('createImageBitmap', async () => ({ width: 16, height: 8, close() {} }));
        vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0, getContext: () => ({ drawImage() {} }),
            toBlob: (done: (blob: Blob) => void) => done(new Blob(['prepared-picked'], { type: 'image/webp' })) }) });
        onTestFinished(() => { vi.unstubAllGlobals(); });
        const owner = ownerWithServices({ ...services(), pickAtmospherePicture: async () => picked, publicProfileAtmosphereDraft: {
            serverId: 'home-a', isCurrent: () => true, read: () => draft, update: edit => { draft = edit(draft); },
        } });
        const target = { kind: 'public_profile_draft', serverId: 'home-a' };
        const added = await owner.action({ actionId: 'settings.invoke', input: { anchor: 'appearance.atmospherePictureAdd', target,
            input: { kind: 'atmosphere_picture_add', source: { kind: 'picked' } } } });
        expect(added).toMatchObject({ status: 'completed', value: { localId: expect.any(String) } });
        expect(draft.source).toBe('picture');
        const selected = draft.picture.ref;
        if (selected.kind !== 'user') throw new Error('Draft picture not selected');
        const { pictureStore } = await import('@/components/atmosphere/pictureStore.web');
        onTestFinished(() => pictureStore.remove(selected.localId));
        expect((await pictureStore.get(selected.localId))?.kind).toBe('user');
        const library = await owner.action({ actionId: 'settings.get', input: { anchor: 'appearance.atmospherePictureLibrary' } });
        expect(library).toMatchObject({ value: { user: expect.arrayContaining([expect.objectContaining({ localId: selected.localId })]),
            pictures: expect.arrayContaining([expect.objectContaining({ id: initial.picture.ref.kind === 'builtin' ? initial.picture.ref.id : '' })]) } });
        expect(await owner.action({ actionId: 'settings.set', input: { anchor: 'appearance.atmospherePictureLibrary', value: {} } }))
            .toMatchObject({ ok: false, errorCode: 'setting_read_only' });
        expect(owner.account()).toEqual(settingsDefaults);
    });

    it('does not acquire or select picture bytes after the answering Account retires during download', async () => {
        let current = true;
        vi.stubGlobal('fetch', vi.fn(async () => {
            current = false;
            return new Response(new Blob(['retired-account']));
        }));
        onTestFinished(() => { vi.unstubAllGlobals(); });
        const { pictureStore } = await import('@/components/atmosphere/pictureStore.web');
        const before = await pictureStore.list();
        const owner = createOwner(undefined, false, true, settingsDefaults, undefined, undefined, undefined,
            { isCurrent: () => current }, undefined, services());
        expect(await owner.action({ actionId: 'settings.invoke', input: { anchor: 'appearance.atmospherePictureAdd',
            input: { kind: 'atmosphere_picture_add', source: { kind: 'url', url: 'https://example.test/retired.png' } } } }))
            .toMatchObject({ status: 'cancelled' });
        expect(owner.account().homeAtmosphere.picture.ref).toEqual(settingsDefaults.homeAtmosphere.picture.ref);
        expect(await pictureStore.list()).toEqual(before);
    });

    it('does not persist or select decoded pixels after retirement during image preparation', async () => {
        let current = true;
        vi.stubGlobal('createImageBitmap', async () => ({ width: 16, height: 8, close() {} }));
        vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0, getContext: () => ({ drawImage() {} }),
            toBlob: (done: (blob: Blob) => void) => { current = false; done(new Blob(['retired-pixels'], { type: 'image/webp' })); } }) });
        onTestFinished(() => { vi.unstubAllGlobals(); });
        const { pictureStore } = await import('@/components/atmosphere/pictureStore.web');
        const before = await pictureStore.list();
        const owner = createOwner(undefined, false, true, settingsDefaults, undefined, undefined, undefined,
            { isCurrent: () => current }, undefined, { ...services(), pickAtmospherePicture: async () => new Blob(['picked']) });
        expect(await owner.action({ actionId: 'settings.invoke', input: { anchor: 'appearance.atmospherePictureAdd',
            input: { kind: 'atmosphere_picture_add', source: { kind: 'picked' } } } })).toMatchObject({ status: 'cancelled' });
        expect(await pictureStore.list()).toEqual(before);
        expect(owner.account().homeAtmosphere).toEqual(settingsDefaults.homeAtmosphere);
    });

    it('acquires URL and exact Machine binary bytes through their real owners and refuses remove via the add anchor', async () => {
        const encoded = new Blob(['prepared-webp'], { type: 'image/webp' });
        const decode = vi.fn(async (data: Blob) => {
            expect(new Uint8Array(await data.arrayBuffer())).toEqual(new Uint8Array([0, 255, 128, 3]));
            return { width: 5120, height: 2560, close() {} };
        });
        vi.stubGlobal('createImageBitmap', decode);
        vi.stubGlobal('document', { createElement: () => {
            const canvas = { width: 0, height: 0, getContext: () => ({ drawImage() {} }),
                toBlob: (callback: (blob: Blob) => void, mime: string, quality: number) => {
                    expect({ width: canvas.width, height: canvas.height, mime, quality }).toEqual({ width: 2560, height: 1280, mime: 'image/webp', quality: 0.86 });
                    callback(encoded);
                } }; return canvas;
        } });
        const originalFetch = globalThis.fetch;
        vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input).startsWith('data:')
            ? originalFetch(input) : new Response(new Blob([new Uint8Array([0, 255, 128, 3])], { type: 'image/png' }))));
        onTestFinished(() => { vi.unstubAllGlobals(); settingsMachineRpc.mockReset(); });
        const { pictureStore } = await import('@/components/atmosphere/pictureStore.web');
        const owner = ownerWithServices(services());
        const added = await owner.action({ actionId: 'settings.invoke', input: { anchor: 'appearance.atmospherePictureAdd',
            input: { kind: 'atmosphere_picture_add', source: { kind: 'url', url: 'https://example.test/photo.png' } } } });
        expect(added).toMatchObject({ status: 'completed', value: { localId: expect.any(String) } });
        const selected = owner.account().homeAtmosphere.picture.ref;
        if (selected.kind !== 'user') throw new Error('User picture was not selected');
        onTestFinished(() => pictureStore.remove(selected.localId));
        const fromUrl = await pictureStore.get(selected.localId);
        expect(fromUrl?.data).toBeInstanceOf(Blob);
        if (!(fromUrl?.data instanceof Blob)) throw new Error('Browser store did not return bytes');
        expect(fromUrl.data.type).toBe('image/webp');
        expect(await fromUrl.data.text()).toBe('prepared-webp');
        expect(await owner.action({ actionId: 'settings.invoke', input: { anchor: 'appearance.atmospherePictureAdd',
            input: { kind: 'atmosphere_picture_remove', localId: selected.localId } } })).toMatchObject({ status: 'unavailable' });
        expect(await pictureStore.get(selected.localId)).toBeDefined();
        settingsMachineRpc.mockResolvedValue({ success: true, content: 'AP+AAw==' });
        expect(await owner.action({ actionId: 'settings.invoke', input: { anchor: 'appearance.atmospherePictureAdd',
            input: { kind: 'atmosphere_picture_add', source: { kind: 'machine_file', machineId: 'machine-a', path: '/pictures/photo.png' } } } }))
            .toMatchObject({ status: 'completed' });
        expect(settingsMachineRpc.mock.calls.at(-1)?.[0]).toMatchObject({ serverId: 'home-a', accountId: 'account-a', machineId: 'machine-a',
            method: 'readFile', payload: { path: '/pictures/photo.png' } });
        const remote = owner.account().homeAtmosphere.picture.ref;
        if (remote.kind !== 'user') throw new Error('Remote user picture was not selected');
        onTestFinished(() => pictureStore.remove(remote.localId));
        const fromFile = await pictureStore.get(remote.localId);
        if (!(fromFile?.data instanceof Blob)) throw new Error('Remote file did not become browser bytes');
        expect(fromFile.data.type).toBe('image/webp');
        expect(await fromFile.data.text()).toBe('prepared-webp');
        expect(decode).toHaveBeenCalledTimes(2);
        expect(await owner.action({ actionId: 'settings.invoke', input: { anchor: 'appearance.atmospherePictureRemove',
            input: { kind: 'atmosphere_picture_remove', localId: selected.localId } } })).toMatchObject({ status: 'completed' });
        expect(await pictureStore.get(selected.localId)).toBeUndefined();
        expect(await pictureStore.get(remote.localId)).toBeDefined();
        await pictureStore.put({ localId: 'test-builtin-remove-guard', kind: 'builtin', data: new Blob(['builtin']) });
        onTestFinished(() => pictureStore.remove('test-builtin-remove-guard'));
        expect(await owner.action({ actionId: 'settings.invoke', input: { anchor: 'appearance.atmospherePictureRemove',
            input: { kind: 'atmosphere_picture_remove', localId: 'test-builtin-remove-guard' } } }))
            .toMatchObject({ status: 'unavailable', reason: 'user_picture_not_found' });
        expect(await pictureStore.get('test-builtin-remove-guard')).toBeDefined();
    });

    it('reads, writes and resets exact Project rows through real HTTP/CAS while preserving neighbors and refusing stale writes', async () => {
        const previous = storage.getState();
        onTestFinished(() => storage.setState(previous, true));
        storage.getState().activateProjectAccountRowsScope({ serverId: 'home-a', accountId: 'account-a' });
        const key = { kind: 'project-organization' as const, serverId: 'home-a', projectKey: 'project-a' };
        let row: ProjectAccountRowV1 = { key, revision: 4, content: { t: 'plain', v: { key, value: { pinned: true, label: 'Keep me' } } } };
        let conflict = false;
        const requests: ReturnType<typeof ProjectAccountRowMutationRequestV1Schema.parse>[] = [];
        const owner = ownerWithServices(services(async (path, init) => {
            if (path.endsWith('/list')) return new Response(JSON.stringify({ status: 'listed', coverage: 'complete', rows: [row] }));
            const request = ProjectAccountRowMutationRequestV1Schema.parse(JSON.parse(String(init?.body)));
            requests.push(request);
            const mutation = request.mutations[0]!;
            if (conflict) return new Response(JSON.stringify({ status: 'conflict', key, revision: 9 }));
            expect(mutation.expectedRevision).toBe(row.revision);
            row = { key, revision: row.revision + 1, content: mutation.content };
            return new Response(JSON.stringify({ status: 'updated', rows: [row], cursor: row.revision }));
        }));
        const target = { kind: 'project', serverId: 'home-a', projectKey: 'project-a' };
        expect(await owner.action({ actionId: 'settings.get', input: { anchor: 'appearance.projectAtmosphere', target } }))
            .toEqual({ anchor: 'appearance.projectAtmosphere', value: 'home' });
        const { moments: _moments, ...atmosphere } = settingsDefaults.homeAtmosphere;
        const { projectAtmosphereEdit } = await import('@/components/atmosphere/look/projectAtmosphereEdit');
        expect(await owner.action({ actionId: 'settings.set', input: { anchor: 'appearance.projectAtmosphere', target,
            value: projectAtmosphereEdit(settingsDefaults.homeAtmosphere, undefined, current => ({ ...current, source: 'none' })) } })).toMatchObject({ value: { source: 'none' } });
        expect(row.content).toMatchObject({ t: 'plain', v: { value: { pinned: true, label: 'Keep me', atmosphere: { source: 'none' } } } });
        expect(await owner.action({ actionId: 'settings.reset', input: { anchor: 'appearance.projectAtmosphere', target } }))
            .toEqual({ anchor: 'appearance.projectAtmosphere', value: 'home' });
        // The same Project row/CAS owner selects acquired bytes; it must never select them in Home.
        vi.stubGlobal('createImageBitmap', async () => ({ width: 16, height: 8, close() {} }));
        vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0, getContext: () => ({ drawImage() {} }),
            toBlob: (done: (blob: Blob) => void) => done(new Blob(['project-picture'], { type: 'image/webp' })) }) });
        vi.stubGlobal('fetch', async () => new Response(new Blob(['source-picture'], { type: 'image/png' })));
        onTestFinished(() => { vi.unstubAllGlobals(); });
        expect(await owner.action({ actionId: 'settings.invoke', input: { anchor: 'appearance.atmospherePictureAdd', target,
            input: { kind: 'atmosphere_picture_add', source: { kind: 'url', url: 'https://example.test/project.png' } } } }))
            .toMatchObject({ status: 'completed' });
        expect(row.content).toMatchObject({ t: 'plain', v: { value: { pinned: true, label: 'Keep me', atmosphere: {
            source: 'picture', picture: { ref: { kind: 'user', localId: expect.any(String) } },
        } } } });
        expect(owner.account().homeAtmosphere).toEqual(settingsDefaults.homeAtmosphere);
        const { pictureStore } = await import('@/components/atmosphere/pictureStore.web');
        const acquired = (await pictureStore.list()).filter(picture => picture.kind === 'user');
        onTestFinished(async () => { for (const picture of acquired) await pictureStore.remove(picture.localId); });
        await owner.action({ actionId: 'settings.reset', input: { anchor: 'appearance.projectAtmosphere', target } });
        const writes = requests.length;
        expect(await owner.action({ actionId: 'settings.set', input: { anchor: 'appearance.projectAtmosphere', target: { ...target, serverId: 'other-home' }, value: 'home' } }))
            .toMatchObject({ errorCode: 'setting_target_mismatch' });
        expect(requests).toHaveLength(writes);
        conflict = true;
        expect(await owner.action({ actionId: 'settings.set', input: { anchor: 'appearance.projectAtmosphere', target, value: atmosphere } }))
            .toMatchObject({ ok: false, errorCode: 'project_account_mutation_conflict' });
        expect(row.content).toMatchObject({ t: 'plain', v: { value: { pinned: true, label: 'Keep me', atmosphere: 'home' } } });
    });
});

// Preload the real scope/consent owners after the declaration graph is initialized.
const { storage } = await import('@/sync/domains/state/storage');
async function installVoiceMachineFixture(machines: Readonly<Record<string, Machine>>) {
    const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
    const serverId = getActiveServerSnapshot().serverId;
    const scope = await activateStorageAccountScope({ serverId, accountId: 'test-account' });
    onTestFinished(() => { scope.dispose(); });
    storage.setState({ machines: { ...machines }, machineListByServerId: {
        ...storage.getState().machineListByServerId, [serverId]: Object.values(machines),
    } });
}
await import('@/voice/settings/panels/realtime/confirmRealtimeProviderSettingChange');
const { voiceSettingsDeclarationRegistry } = await import('@/voice/settings/voiceContributedSettingsDeclarations');
const { prepareSpeechEndpointSettingChange } = await import('@/voice/settings/panels/bundledSpeech/prepareEndpointSettingChange');

function throughActionExecutor(settingsDeclarationAction: ReturnType<typeof createSettingsDeclarationAction>,
    readActionsSettings?: () => ActionsSettingsV1,
    approvalTransport?: Pick<ActionExecutorDeps, 'approvalsCreate' | 'approvalsGet' | 'approvalsUpdate' | 'approvalsWaitForDecision' | 'isApprovalExecutionOriginCurrent'>) {
    const approvalPolicy: Pick<Parameters<typeof createActionExecutor>[0], 'isActionApprovalRequired'> = readActionsSettings
        ? { isActionApprovalRequired: (actionId, context, input) => {
            const anchor = input && typeof input === 'object' && 'anchor' in input && typeof input.anchor === 'string' ? input.anchor : '';
            const operationPolicy = actionId === 'settings.invoke'
                ? resolveSettingsDeclarationOperationApprovalPolicy(anchor, settingsDefaults) : undefined;
            const safety = operationPolicy ? operationPolicy.requiresApproval ? 'danger' : 'safe' : undefined;
            return isApprovalRequiredByActionsSettings(actionId, readActionsSettings(), context, safety, undefined, input,
                operationPolicy?.uiConfirmationRequired);
        } }
        : {};
    // These unrelated outward ports must remain unused; Protocol admission and the declaration owner stay real.
    const unusedTransport = async () => { throw new Error('unexpected_unrelated_transport'); };
    return createActionExecutor({ settingsDeclarationAction,
        ...approvalPolicy,
        ...approvalTransport,
        executionRunStart: unusedTransport, executionRunList: unusedTransport, executionRunGet: unusedTransport,
        detachedExecutionRunSend: unusedTransport, executionRunStop: unusedTransport, executionRunAction: unusedTransport,
        executionRunWait: unusedTransport, sessionOpen: unusedTransport, sessionFork: unusedTransport,
        sessionRollback: unusedTransport, sessionSpawnNew: unusedTransport, pathsListRecent: unusedTransport,
        machinesList: unusedTransport, serversList: unusedTransport, reviewEnginesList: unusedTransport,
        agentsBackendsList: unusedTransport, agentsModelsList: unusedTransport, sessionSendMessage: unusedTransport,
        sessionModeSet: unusedTransport, sessionModesList: unusedTransport, sessionList: unusedTransport,
        sessionActivityGet: unusedTransport, sessionRecentMessagesGet: unusedTransport, resetGlobalVoiceAgent: unusedTransport,
        daemonMemorySearch: unusedTransport, daemonMemoryGetWindow: unusedTransport, daemonMemoryEnsureUpToDate: unusedTransport,
    });
}

function createOwner(host: { os: 'web' | 'ios'; desktop: boolean } = { os: 'web', desktop: false }, featuresEnabled = false, runtimeContributions = true, initialAccount = settingsDefaults,
    navigation?: (href: string, signal?: AbortSignal) => Promise<boolean>, rebase?: (settings: Settings) => Settings,
    automationSettings?: Readonly<{ read(): Promise<AutomationV3Settings>; write(settings: AutomationV3Settings): Promise<AutomationV3Settings> }>,
    lifetime?: Readonly<{ isCurrent(): boolean; onReadAccount?(): void }>,
    featureSnapshot?: ServerFeaturesSnapshot, atmosphereServices?: SettingsMutationServices) {
    let account = { ...initialAccount };
    let rawAccount: Record<string, unknown> = { ...initialAccount };
    let local = { ...localSettingsDefaults };
    const openedInteractions: string[] = [];
    const readScmDiffSummaryCatalog: ReturnType<typeof createScmDiffSummarySettingsCatalogReader> = async (settings, storedValue) => {
        const captured = await readSummaryCatalogAccount();
        return createScmDiffSummarySettingsCatalogReader(captured)(settings, storedValue);
    };
    // These ports substitute only the persisted Account and device storage boundaries.
    const action = createSettingsDeclarationAction({
        ...(atmosphereServices ? { serverId: 'home-a', accountScope: { serverId: 'home-a', accountId: 'account-a' } } : {}),
        host,
        tauriDesktop: host.desktop,
        readPageGate: readSettingsPageGate,
        isFeatureEnabled: async (featureId) => featureSnapshot
            ? resolveRuntimeFeatureDecisionFromSnapshot({ featureId, settings: account, snapshot: featureSnapshot })?.state === 'enabled'
            : featuresEnabled,
        canUseRuntimeContributions: () => runtimeContributions,
        isCurrent: lifetime?.isCurrent,
        openHumanInteraction: navigation ?? (async (href) => { openedInteractions.push(href); return true; }),
        mutationServices: { ...atmosphereServices, readScmDiffSummaryCatalog, readAgentCatalog: async (settings) => {
            const captured = await readSummaryCatalogAccount();
            const { catalog } = await readAcpCatalogInContext(captured);
            return { entries: getResolvedAgentCatalogEntries({
                enabledAgentIds: getEnabledAgentIds({ backendEnabledByTargetKey: settings.backendEnabledByTargetKey }),
                backendEnabledByTargetKey: settings.backendEnabledByTargetKey,
                acpCatalogSnapshot: catalog,
            }),
            isCurrent: captured.accountLifetime.isCurrent };
        } },
        readAccountSettings: async () => { lifetime?.onReadAccount?.(); return account; },
        writeAccountSettings: async (delta) => { rawAccount = { ...rawAccount, ...delta }; account = applySettings(account, delta); },
        mutateAccountSettings: async (mutate, options) => {
            const before = rawAccount;
            rawAccount = mutate(rebase ? rebase(account) : account);
            account = settingsParse(rawAccount);
            if (options?.observeOutcome) return { status: 'applied' as const, settingsVersion: 2, value: undefined,
                ...(options.capture ? { captured: options.capture({ before, applied: rawAccount, beforeVersion: 1 }) } : {}) };
        },
        readLocalSettings: () => local,
        writeLocalSettings: (delta) => { local = applyLocalSettings(local, delta); },
        automationSettings,
    });
    return { action, account: () => account, rawAccount: () => rawAccount, local: () => local, openedInteractions };
}

describe('Voice public privacy policy destination', () => {
    it('discovers and opens the fixed public policy on the answering client without a Voice machine', async () => {
        const before = storage.getState();
        const open = vi.fn();
        vi.stubGlobal('open', open);
        onTestFinished(() => { storage.setState(before, true); vi.unstubAllGlobals(); });
        storage.setState({ machines: {} });
        const owner = createOwner(undefined, true);
        const executor = throughActionExecutor(owner.action, () => owner.account().actionsSettingsV1);
        const context = { surface: 'agent', authority: 'account_automation' } as const;
        expect(await executor.execute('settings.list', { pageId: 'voicePrivacy' }, context)).toMatchObject({ ok: true, result: {
            items: expect.arrayContaining([expect.objectContaining({ anchor: 'voicePrivacy.privacyPolicy',
                operation: { actionId: 'settings.invoke', requiresHumanInteraction: false, requiresApproval: false } })]),
        } });
        expect(await executor.execute('settings.invoke', { anchor: 'voicePrivacy.privacyPolicy' }, context))
            .toEqual({ ok: true, result: { anchor: 'voicePrivacy.privacyPolicy', status: 'completed' } });
        const { HAPPIER_PRIVACY_POLICY_URL } = await import('@/constants/legalUrls');
        expect(open.mock.calls).toEqual([[HAPPIER_PRIVACY_POLICY_URL, '_blank', 'noopener,noreferrer']]);
        expect(owner.openedInteractions).toEqual([]);
    });

    it('refuses retired Account and arbitrary operation input before opening the policy', async () => {
        const open = vi.fn();
        vi.stubGlobal('open', open);
        onTestFinished(() => { vi.unstubAllGlobals(); });
        let current = true;
        const owner = createOwner(undefined, true, true, settingsDefaults, undefined, undefined, undefined,
            { isCurrent: () => current });
        const executor = throughActionExecutor(owner.action, () => owner.account().actionsSettingsV1);
        const context = { surface: 'agent', authority: 'account_automation' } as const;
        expect(await executor.execute('settings.invoke', { anchor: 'voicePrivacy.privacyPolicy',
            input: { kind: 'voice_preview', voiceId: 'unrelated' } }, context))
            .toMatchObject({ ok: true, result: { status: 'unavailable', reason: 'operation_input_invalid' } });
        current = false;
        expect(await executor.execute('settings.invoke', { anchor: 'voicePrivacy.privacyPolicy' }, context))
            .toMatchObject({ ok: false, errorCode: 'setting_not_bound' });
        expect(open).not.toHaveBeenCalled();
    });
});

describe('keyed machine offline Account consent', () => {
    it('admits the offline Ask prompt through the registered Settings Action and publishes only its machine to the strict remote-alert consumer', async () => {
        const { deriveMachineResourceSuggestions } = await import('@/components/machines/resources/ask/machineResourceSuggestions');
        const { SettingsDeclarationActionInputSchemasV1 } = await import('@happier-dev/protocol/actions/settingsDeclarationActionFamily');
        const { deriveAccountRemoteAlertPolicyV1 } = await import('@happier-dev/protocol/account/settings/accountRemoteAlertPolicy');
        const { AccountRemoteAlertPolicyV1Schema } = await import('@happier-dev/protocol');
        const machine = { serverId: 'home-a', machineId: 'studio-"quoted', name: 'Studio', directory: '' };
        const suggestion = deriveMachineResourceSuggestions({ machine, online: false }).find(entry => entry.kind === 'notifyWhenBack')!;
        const input = SettingsDeclarationActionInputSchemasV1['settings.set'].parse(JSON.parse(suggestion.fill.text.split('\nsettings.set ')[1]!));
        const owner = createOwner(undefined, false, true, settingsParse({ machineOfflineAlertsV1: { machineIds: ['peer'] } }));
        const executor = throughActionExecutor(owner.action, () => owner.account().actionsSettingsV1);
        const context = { surface: 'ui', authority: 'present_user', presentUserConfirmation: { actionId: 'settings.set' } } as const;
        expect(await executor.execute('settings.set', input, context)).toMatchObject({ ok: true, result: {
            anchor: 'notifications.machineOffline', value: true,
        } });
        const policy = AccountRemoteAlertPolicyV1Schema.parse(deriveAccountRemoteAlertPolicyV1(owner.account()));
        expect(policy).toMatchObject({ machineOffline: { machineIds: ['peer', machine.machineId] },
            events: { machine_offline: { enabled: true } } });
        expect(await executor.execute('settings.get', { anchor: input.anchor, key: machine.machineId }, context))
            .toMatchObject({ ok: true, result: { value: true } });
        expect(owner.openedInteractions).toEqual([]);
    });

    it('changes only the selected machine and preserves concurrently added consent without a session feature gate', async () => {
        const owner = createOwner(undefined, false, true, settingsParse({ machineOfflineAlertsV1: { machineIds: ['peer'] } }),
            undefined, current => settingsParse({ ...current, machineOfflineAlertsV1: { machineIds: [...new Set([...current.machineOfflineAlertsV1.machineIds, 'concurrent'])] } }));
        const anchor = 'notifications.machineOffline';
        expect(await owner.action({ actionId: 'settings.get', input: { anchor, key: 'machine' } })).toEqual({ anchor, value: false });
        expect(await owner.action({ actionId: 'settings.set', input: { anchor, key: 'machine', value: true } })).toEqual({ anchor, value: true });
        expect(owner.account().machineOfflineAlertsV1.machineIds).toEqual(['peer', 'concurrent', 'machine']);
        expect(await owner.action({ actionId: 'settings.set', input: { anchor, key: 'machine', value: false } })).toEqual({ anchor, value: false });
        expect(owner.account().machineOfflineAlertsV1.machineIds).toEqual(['peer', 'concurrent']);
        expect(await owner.action({ actionId: 'settings.set', input: { anchor, value: true } })).toMatchObject({ ok: false, errorCode: 'setting_key_required' });
        expect(await owner.action({ actionId: 'settings.set', input: { anchor, key: 'machine', value: 'true' } })).toMatchObject({ ok: false, errorCode: 'invalid_setting_value' });
    });
});

describe('Agent HTML network Account setting', () => {
    const anchor = 'transcript.agentHtmlNetworkPolicy';

    it('discovers and reads the policy and applies only valid present-user choices through the Account writer', async () => {
        const owner = createOwner();
        const executor = throughActionExecutor(owner.action);
        const context = { surface: 'ui', authority: 'present_user', presentUserConfirmation: { actionId: 'settings.set' } } as const;
        expect(await executor.execute('settings.list', { pageId: 'transcript' }, context)).toMatchObject({ ok: true, result: {
            items: expect.arrayContaining([expect.objectContaining({ anchor, readable: true, writable: true,
                storageScope: 'account', allowedValues: ['allowed', 'ask', 'off'] })]),
        } });
        expect(await executor.execute('settings.get', { anchor }, context)).toMatchObject({ ok: true, result: { anchor, value: 'allowed' } });
        for (const value of ['ask', 'off', 'allowed']) {
            expect(await executor.execute('settings.set', { anchor, value }, context)).toMatchObject({ ok: true, result: { anchor, value } });
            expect(owner.account()).toHaveProperty('agentHtmlNetworkPolicy', value);
        }
        expect(await executor.execute('settings.set', { anchor, value: 'open' }, context))
            .toMatchObject({ ok: false, errorCode: 'invalid_setting_value' });
        expect(owner.account()).toHaveProperty('agentHtmlNetworkPolicy', 'allowed');
    });

    it('asks Agent and MCP callers before changing the network default and honors an explicit Action waiver', async () => {
        const requests = new Map<string, ApprovalRequest>();
        const owner = createOwner(undefined, false, true, settingsParse({ agentHtmlNetworkPolicy: 'off',
        }));
        // Approval Artifacts are the persistence boundary; both declaration admission and policy stay real.
        const executor = throughActionExecutor(owner.action, () => owner.account().actionsSettingsV1, {
            approvalsGet: async ({ artifactId }) => requests.get(artifactId) ?? null,
            approvalsUpdate: async ({ artifactId, request }) => { requests.set(artifactId, request); return { ok: true }; },
            approvalsWaitForDecision: async ({ request }) => ({ decision: 'reject', request }),
            approvalsCreate: async ({ request }) => {
                const artifactId = `network-approval-${requests.size}`;
                requests.set(artifactId, request);
                return { artifactId };
            },
        });
        for (const surface of ['agent', 'mcp'] as const) {
            const context = { surface, serverId: 'home-a', runtimeAccountId: 'account-a',
                actionRequestId: `network-${surface}`, actionsSettings: owner.account().actionsSettingsV1 };
            expect(await executor.execute('settings.get', { anchor }, context)).toMatchObject({ ok: true, result: { anchor, value: 'off' } });
            const setResult = await executor.execute('settings.set', { anchor, value: 'allowed' }, context);
            expect(setResult, JSON.stringify(setResult)).toMatchObject({ ok: false, errorCode: 'approval_rejected' });
            expect(await executor.execute('settings.reset', { anchor }, context))
                .toMatchObject({ ok: false, errorCode: 'approval_rejected' });
        }
        expect(owner.account()).toHaveProperty('agentHtmlNetworkPolicy', 'off');
        expect([...requests.values()]).toEqual(expect.arrayContaining([
            expect.objectContaining({ status: 'rejected', actionId: 'settings.set', actionArgs: { anchor, value: 'allowed' } }),
            expect.objectContaining({ status: 'rejected', actionId: 'settings.reset', actionArgs: { anchor } }),
        ]));
        const waived = createOwner(undefined, false, true, settingsParse({ agentHtmlNetworkPolicy: 'off',
            actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'settings.set': ['agent', 'mcp'], 'settings.reset': ['agent', 'mcp'] } },
        }));
        const waivedExecutor = throughActionExecutor(waived.action, () => waived.account().actionsSettingsV1);
        for (const surface of ['agent', 'mcp'] as const) {
            const context = { surface, actionsSettings: waived.account().actionsSettingsV1 };
            expect(await waivedExecutor.execute('settings.set', { anchor, value: 'off' }, context))
                .toMatchObject({ ok: true, result: { anchor, value: 'off' } });
            expect(waived.account()).toHaveProperty('agentHtmlNetworkPolicy', 'off');
            expect(await waivedExecutor.execute('settings.reset', { anchor }, context))
                .toMatchObject({ ok: true, result: { anchor, value: 'allowed' } });
            expect(waived.account()).toHaveProperty('agentHtmlNetworkPolicy', 'allowed');
        }
    });
});

describe('Instructions Agent edits policy declaration', () => {
    const anchor = 'actions.promptDocAgentEdits';

    it('edits only the Agent prompt-document mode through human admission and the latest Account snapshot', async () => {
        const owner = createOwner(undefined, true, true, settingsDefaults, undefined, settings => ({
            ...settings,
            actionsSettingsV1: ActionsSettingsV1Schema.parse({ ...settings.actionsSettingsV1,
                actions: { ...settings.actionsSettingsV1.actions,
                    'prompt_doc.create': { disabledSurfaces: ['mcp'] },
                    'prompt_doc.update': { ...settings.actionsSettingsV1.actions['prompt_doc.update'], disabledSurfaces: ['agent', 'cli'] },
                },
            }),
        }));
        const executor = throughActionExecutor(owner.action);
        const context = { surface: 'ui', authority: 'present_user', presentUserConfirmation: { actionId: 'settings.set' } } as const;
        expect(await executor.execute('settings.set', { anchor, value: 'allowed' }, context)).toMatchObject({ ok: true, result: { anchor, value: 'allowed' } });
        expect(owner.account().actionsSettingsV1.actions['prompt_doc.update'].disabledSurfaces).toEqual(['cli']);
        expect(owner.account().actionsSettingsV1.approvalWaivedSurfaces?.['prompt_doc.update']).toEqual(['agent']);
        expect(owner.account().actionsSettingsV1.actions['prompt_doc.create'].disabledSurfaces).toEqual(['mcp']);
        expect(await executor.execute('settings.set', { anchor, value: { approvalWaivedSurfaces: { 'settings.set': ['agent'] } } }, context))
            .toMatchObject({ ok: false, errorCode: 'invalid_setting_value' });
    });

    it('never lets automation grant itself a waiver, even when settings.set is waived', async () => {
        const owner = createOwner(undefined, true, true, settingsParse({ actionsSettingsV1: { v: 1,
            actions: {}, approvalWaivedSurfaces: { 'settings.set': ['agent', 'mcp'] },
        } }));
        const executor = throughActionExecutor(owner.action, () => owner.account().actionsSettingsV1);
        for (const surface of ['agent', 'mcp'] as const) {
            expect(await executor.execute('settings.set', { anchor, value: 'allowed' }, { surface,
                actionsSettings: owner.account().actionsSettingsV1 }))
                .toMatchObject({ ok: false, errorCode: 'present_user_required' });
        }
        expect(owner.account().actionsSettingsV1.approvalWaivedSurfaces?.['prompt_doc.update']).toBeUndefined();
    });

    it('lets an Agent request the exact mode and applies it only after a human decision', async () => {
        const owner = createOwner(undefined, true);
        const requests = new Map<string, ApprovalRequest>();
        // Approval Artifacts are the persistence boundary; admission, review and replay remain real.
        const executor = throughActionExecutor(owner.action, () => owner.account().actionsSettingsV1, {
            approvalsCreate: async ({ request }) => { requests.set('policy-approval', request); return { artifactId: 'policy-approval' }; },
            approvalsGet: async ({ artifactId }) => requests.get(artifactId) ?? null,
            approvalsUpdate: async ({ artifactId, request }) => { requests.set(artifactId, request); return { ok: true }; },
            isApprovalExecutionOriginCurrent: async () => true,
        });
        const agent = { surface: 'agent', serverId: 'home-a', defaultSessionId: 'worker', actionRequestId: 'policy-request' } as const;
        expect(await executor.execute('settings.set', { anchor, value: 'allowed' }, agent)).toMatchObject({ ok: true });
        expect(requests.get('policy-approval')).toMatchObject({ status: 'open', actionId: 'settings.set', actionArgs: { anchor, value: 'allowed' } });
        expect(owner.account().actionsSettingsV1.approvalWaivedSurfaces?.['prompt_doc.update']).toBeUndefined();
        expect(await executor.execute('approval.request.decide', { artifactId: 'policy-approval', decision: 'approve' }, agent))
            .toMatchObject({ ok: false });
        expect(requests.get('policy-approval')?.status).toBe('open');
        expect(await executor.execute('approval.request.decide', { artifactId: 'policy-approval', decision: 'approve' }, {
            surface: 'ui', authority: 'present_user', serverId: 'home-a',
        })).toMatchObject({ ok: true });
        expect(owner.account().actionsSettingsV1.approvalWaivedSurfaces?.['prompt_doc.update']).toEqual(['agent']);
        expect(requests.get('policy-approval')?.status).toBe('executed');
    });
});

describe('exact Action audience policy', () => {
    it('changes and resets one audience through the current Account writer without re-enabling a globally Off Action', async () => {
        const policy = ActionsSettingsV1Schema.parse({ v: 1, actions: {
            'prompt_doc.update': { enabled: false, disabledSurfaces: ['agent', 'cli'], approvalRequiredSurfaces: ['mcp'],
                disabledPlacements: ['command_palette'], toolExposureModes: { agent: 'discoverable_only' } },
            'future.action': { enabled: false, futurePreference: 'retained' },
        } });
        const owner = createOwner(undefined, true, true, { ...settingsDefaults, actionsSettingsV1: policy }, undefined, settings => ({ ...settings, actionsSettingsV1: ActionsSettingsV1Schema.parse({
            ...settings.actionsSettingsV1, actions: { ...settings.actionsSettingsV1.actions,
                'future.action': policy.actions['future.action'],
                'prompt_doc.create': { disabledSurfaces: ['mcp'] } },
        }) }));
        const executor = throughActionExecutor(owner.action, () => owner.account().actionsSettingsV1);
        const target = { actionId: 'prompt_doc.update', audience: 'agent' } as const;
        const context = { surface: 'ui', authority: 'present_user' } as const;
        for (const mode of ['allowed', 'ask_first', 'off', 'default'] as const) {
            const result = await executor.execute('actions.policy.set', { ...target, mode }, context);
            expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { ...target, mode, actionEnabled: false, enabled: false } });
            expect(await executor.execute('actions.policy.get', target, context))
                .toMatchObject({ ok: true, result: { ...target, mode, actionEnabled: false, enabled: false } });
            const policy = ActionsSettingsV1Schema.parse(owner.rawAccount().actionsSettingsV1);
            expect(policy.actions['prompt_doc.update']).toMatchObject({ enabled: false,
                disabledPlacements: ['command_palette'], approvalRequiredSurfaces: mode === 'ask_first' ? ['mcp', 'agent'] : ['mcp'],
                toolExposureModes: { agent: 'discoverable_only' } });
            expect(policy.actions['prompt_doc.update'].disabledSurfaces).toEqual(mode === 'off' ? ['cli', 'agent'] : ['cli']);
            expect(policy.actions['prompt_doc.create'].disabledSurfaces).toEqual(['mcp']);
            expect(policy.actions['future.action']).toMatchObject({ enabled: false, futurePreference: 'retained' });
        }
        expect(owner.account().actionsSettingsV1.approvalWaivedSurfaces?.['prompt_doc.update']).toBeUndefined();
        expect(await executor.execute('actions.policy.set', { ...target, mode: 'allowed', actionsSettingsV1: { v: 1, actions: {} } }, context))
            .toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
        expect(await executor.execute('actions.policy.set', { ...target, mode: 'allowed' }, context)).toMatchObject({ ok: true });
        expect(await executor.execute('actions.policy.reset', target, context))
            .toMatchObject({ ok: true, result: { ...target, mode: 'default', actionEnabled: false, enabled: false } });
        expect(owner.account().actionsSettingsV1.approvalWaivedSurfaces?.['prompt_doc.update']).toBeUndefined();
        expect(owner.account().actionsSettingsV1.actions['prompt_doc.update'].approvalRequiredSurfaces).toEqual(['mcp']);
    });

    it('keeps exact Agent/MCP policy requests inert until a human approves and refuses self-approval even with a waiver', async () => {
        for (const surface of ['agent', 'mcp'] as const) {
            const owner = createOwner(undefined, true);
            const requests = new Map<string, ApprovalRequest>();
            const executor = throughActionExecutor(owner.action, () => owner.account().actionsSettingsV1, {
                approvalsCreate: async ({ request }) => { requests.set('audience-policy', request); return { artifactId: 'audience-policy' }; },
                approvalsGet: async ({ artifactId }) => requests.get(artifactId) ?? null,
                approvalsUpdate: async ({ artifactId, request }) => { requests.set(artifactId, request); return { ok: true }; },
                isApprovalExecutionOriginCurrent: async () => true,
            });
            const input = { actionId: 'prompt_doc.update', audience: 'mcp', mode: 'allowed' } as const;
            const context = { surface, serverId: 'home-a', defaultSessionId: 'worker', actionRequestId: `audience-${surface}` };
            expect(await executor.execute('actions.policy.set', input, context)).toMatchObject({ ok: true });
            expect(requests.get('audience-policy')).toMatchObject({ status: 'open', actionId: 'actions.policy.set', actionArgs: input });
            expect(owner.account().actionsSettingsV1.approvalWaivedSurfaces?.['prompt_doc.update']).toBeUndefined();
            expect(await executor.execute('approval.request.decide', { artifactId: 'audience-policy', decision: 'approve' }, context))
                .toMatchObject({ ok: false });
            expect(await executor.execute('approval.request.decide', { artifactId: 'audience-policy', decision: 'approve' }, {
                surface: 'ui', authority: 'present_user', serverId: 'home-a',
            })).toMatchObject({ ok: true });
            expect(owner.account().actionsSettingsV1.approvalWaivedSurfaces?.['prompt_doc.update']).toEqual(['mcp']);
            expect(requests.get('audience-policy')?.status).toBe('executed');
            const waived = createOwner(undefined, true, true, settingsParse({ actionsSettingsV1: { v: 1,
                approvalWaivedSurfaces: { 'actions.policy.set': [surface] },
            } }));
            expect(await throughActionExecutor(waived.action, () => waived.account().actionsSettingsV1)
                .execute('actions.policy.set', input, { surface, actionsSettings: waived.account().actionsSettingsV1 }))
                .toMatchObject({ ok: false, errorCode: 'present_user_required' });
            expect(waived.account().actionsSettingsV1.approvalWaivedSurfaces?.['prompt_doc.update']).toBeUndefined();
        }
    });
});

describe('Usage model-price Account Settings declaration parity', () => {
    it('round-trips rates and mappings through ordinary Actions and rejects cycles without replacing persisted settings', async () => {
        const owner = createOwner(undefined, true);
        const executor = throughActionExecutor(owner.action);
        const context = { surface: 'ui', authority: 'present_user', presentUserConfirmation: { actionId: 'settings.set' } } as const;
        const rates = { private: { kind: 'rates', inputUsdPerMillion: 2, outputUsdPerMillion: 4 } };
        expect(await executor.execute('settings.set', { anchor: 'usage.modelPrices', value: rates }, context))
            .toMatchObject({ ok: true, result: { anchor: 'usage.modelPrices', value: rates } });
        expect(await executor.execute('settings.get', { anchor: 'usage.modelPrices' }, context))
            .toMatchObject({ ok: true, result: { value: rates } });
        const mapped = { ...rates, other: { kind: 'map', modelId: 'private' } };
        expect(await executor.execute('settings.set', { anchor: 'usage.modelPrices', value: mapped }, context))
            .toMatchObject({ ok: true, result: { value: mapped } });
        expect(owner.account().usageModelPriceOverridesV1).toEqual(mapped);
        expect(await executor.execute('settings.set', { anchor: 'usage.modelPrices', value: {
            private: { kind: 'map', modelId: 'other' }, other: { kind: 'map', modelId: 'private' },
        } }, context)).toMatchObject({ ok: false, errorCode: 'invalid_setting_value' });
        expect(await executor.execute('settings.get', { anchor: 'usage.modelPrices' }, context))
            .toMatchObject({ ok: true, result: { value: mapped } });
    });
});

describe('notification Settings declaration parity', () => {
    it('reads and toggles focus mute through the existing Account notification policy', async () => {
        const owner = createOwner(undefined, true, true, settingsParse({ ...settingsDefaults,
            attentionDeliveryPolicyV1: { ...settingsDefaults.attentionDeliveryPolicyV1, mutePhoneWhenComputerFocused: true },
        }));
        const anchor = 'notifications.mutePhoneWhenComputerFocused';
        const before = owner.account().attentionDeliveryPolicyV1;
        expect(await owner.action({ actionId: 'settings.get', input: { anchor } }))
            .toEqual({ anchor, value: before.mutePhoneWhenComputerFocused });
        const value = !before.mutePhoneWhenComputerFocused;
        expect(await owner.action({ actionId: 'settings.set', input: { anchor, value } }))
            .toEqual({ anchor, value });
        expect(owner.account().attentionDeliveryPolicyV1).toEqual({ ...before, mutePhoneWhenComputerFocused: value });
    });
    it('rebases coupled push-event policy edits and preserves sibling Account policy', async () => {
        const owner = createOwner(undefined, true, true, settingsDefaults, undefined, (settings) => ({
            ...settings, attentionDeliveryPolicyV1: { ...settings.attentionDeliveryPolicyV1, mutePhoneWhenComputerFocused: true },
        }));
        const set = (anchor: string, value: boolean | string | { mode: 'disabled' }) => owner.action({ actionId: 'settings.set', input: { anchor, value } });
        expect(await set('notifications.typesPermissionRequests', false)).toEqual({ anchor: 'notifications.typesPermissionRequests', value: false });
        const policy = owner.account().attentionDeliveryPolicyV1;
        expect(policy.events.permission_request.enabled).toBe(false);
        expect(policy.channels.expo_push.events.permission_request.enabled).toBe(false);
        expect(policy.mutePhoneWhenComputerFocused).toBe(true);
        expect(await set('notifications.typesRequestPreview', false)).toMatchObject({ value: false });
        expect(owner.account().attentionDeliveryPolicyV1.channels.expo_push.events.permission_request.previewBehavior).toBe('status_only');
        expect(owner.account().attentionDeliveryPolicyV1.channels.expo_push.events.user_action_request.previewBehavior).toBe('status_only');
        expect(await set('notifications.soundPreset', 'silent')).toMatchObject({ value: 'silent' });
        expect(await set('notifications.soundPreset', 'custom')).toMatchObject({ ok: false, errorCode: 'invalid_setting_value' });
        expect(await set('notifications.quietHoursAccount', 'nightly')).toMatchObject({ value: 'nightly' });
        expect(owner.account().attentionDeliveryPolicyV1.quietHours).toMatchObject({ enabled: true, windows: [{ startLocalTime: '22:00', endLocalTime: '07:00' }] });
    });

    it('writes device badge, sounds, quiet-hours and remote consent without clobbering nested siblings', async () => {
        const owner = createOwner({ os: 'ios', desktop: false }, true);
        const set = (anchor: string, value: boolean | string) => owner.action({ actionId: 'settings.set', input: { anchor, value } });
        expect(await set('notifications.unread', false)).toMatchObject({ value: false });
        expect(await set('notifications.deviceEnabled', false)).toMatchObject({ value: false });
        expect(await owner.action({ actionId: 'settings.set', input: { anchor: 'notifications.quietHoursDevice', value: { mode: 'disabled' } } })).toMatchObject({ value: { mode: 'disabled' } });
        expect(owner.local().attentionDeviceOverridesV1).toMatchObject({ badge: { enabled: true, includeUnread: false }, sounds: { enabled: false }, quietHoursOverride: { mode: 'disabled' } });
        expect(await set('notifications.account', true)).toMatchObject({ value: true });
        expect(await set('notifications.device', true)).toMatchObject({ value: true });
        expect(owner.account().sessionRemoteAlertsEnabled).toBe(true);
        expect(owner.local().deviceRemoteAlertsEnabled).toBe(true);
    });

    it('discovers every editable control and keeps push OS consent on its human-interaction path', async () => {
        const owner = createOwner({ os: 'ios', desktop: false }, true);
        const result = await owner.action({ actionId: 'settings.list', input: { pageId: 'notifications' } });
        expect(result).toMatchObject({ items: expect.arrayContaining([
            ...['badgesEnabled', 'unread', 'permissionRequests', 'userActions', 'queued', 'friendRequests', 'desktopDot',
                'mutePhoneWhenComputerFocused', 'account', 'device', 'quietHoursAccount', 'quietHoursDevice',
                'soundPreset', 'deviceEnabled', 'typesReady', 'typesReadyPreview', 'typesRequestPreview',
                'typesPermissionRequests', 'typesUserActions', 'following'].map(id => expect.objectContaining({ anchor: `notifications.${id}`, readable: true, writable: true })),
            ...['pushEnabled', 'addWebhook'].map(id => expect.objectContaining({ anchor: `notifications.${id}`, operation: { actionId: 'settings.invoke', requiresHumanInteraction: true } })),
        ]) });
        expect(await owner.action({ actionId: 'settings.set', input: { anchor: 'notifications.pushEnabled', value: true } })).toMatchObject({ ok: false, errorCode: 'setting_read_only' });
        expect(await owner.action({ actionId: 'settings.invoke', input: { anchor: 'notifications.pushEnabled' } })).toMatchObject({ status: 'interaction_opened' });
        expect(owner.openedInteractions).toEqual(['/settings/notifications?setting=notifications.pushEnabled']);
    });
});

describe('keyboard and desktop Settings Actions', () => {
    it('reads and changes the device Home connection preference with its rendered boolean meaning', async () => {
        const owner = createOwner();
        expect(await owner.action({ actionId: 'settings.get', input: { anchor: 'servers.standardOnly' } }))
            .toEqual({ anchor: 'servers.standardOnly', value: false });
        expect(await owner.action({ actionId: 'settings.set', input: { anchor: 'servers.standardOnly', value: true } }))
            .toEqual({ anchor: 'servers.standardOnly', value: true });
        expect(owner.local().homeApplicationCarrierEligibility).toBe('standard_only');
        expect(await owner.action({ actionId: 'settings.set', input: { anchor: 'servers.standardOnly', value: false } }))
            .toEqual({ anchor: 'servers.standardOnly', value: false });
        expect(owner.local().homeApplicationCarrierEligibility).toBe('automatic');
    });
    it('discovers command bindings and preserves competing command changes on Account rebase', async () => {
        const owner = createOwner(undefined, false, true, settingsDefaults, undefined, settings => applySettings(settings, {
            keyboardShortcutDisabledCommandIdsV1: ['session.next'],
            keyboardShortcutOverridesV1: { 'session.next': [{ binding: 'Alt+N' }] },
        }));
        expect(await owner.action({ actionId: 'settings.list', input: { pageId: 'keyboard' } }))
            .toMatchObject({ items: expect.arrayContaining([expect.objectContaining({
                anchor: 'keyboard.commandPalette.open', readable: true, writable: true,
            })]) });
        const value = { enabled: false, binding: 'Mod+Shift+P' };
        expect(await owner.action({ actionId: 'settings.set', input: { anchor: 'keyboard.commandPalette.open', value } }))
            .toEqual({ anchor: 'keyboard.commandPalette.open', value });
        expect(await owner.action({ actionId: 'settings.get', input: { anchor: 'keyboard.commandPalette.open' } }))
            .toEqual({ anchor: 'keyboard.commandPalette.open', value });
        expect(owner.account().commandPaletteEnabled).toBe(false);
        expect(owner.account().keyboardShortcutDisabledCommandIdsV1).toEqual(['session.next', 'commandPalette.open']);
        expect(owner.account().keyboardShortcutOverridesV1['session.next']).toEqual([{ binding: 'Alt+N' }]);
        expect(await owner.action({ actionId: 'settings.set', input: { anchor: 'keyboard.commandPalette.open', value: { enabled: true, binding: null } } }))
            .toMatchObject({ value: { enabled: true, binding: null } });
        expect(owner.account().commandPaletteEnabled).toBe(true);
        expect(owner.account().keyboardShortcutOverridesV1['commandPalette.open']).toBeUndefined();
        const before = owner.account();
        expect(await owner.action({ actionId: 'settings.set', input: { anchor: 'keyboard.commandPalette.open', value: { enabled: true, binding: ' ' } } }))
            .toMatchObject({ ok: false, errorCode: 'invalid_setting_value' });
        expect(owner.account()).toEqual(before);
    });

    it('uses the desktop placement owner for native repositioning and rejects other hosts', async () => {
        const invoke = vi.spyOn(desktopHostBoundary, 'invokeDesktopHost').mockResolvedValue(undefined);
        onTestFinished(() => invoke.mockRestore());
        const owner = createOwner({ os: 'web', desktop: true });
        expect(await owner.action({ actionId: 'settings.set', input: { anchor: 'desktop.placementMode', value: 'custom' } }))
            .toEqual({ anchor: 'desktop.placementMode', value: 'custom' });
        expect(await owner.action({ actionId: 'settings.set', input: { anchor: 'desktop.anchorPreset', value: 'bottom_left' } }))
            .toEqual({ anchor: 'desktop.anchorPreset', value: 'bottom_left' });
        expect(owner.local().desktopOverlayAnchor).toBe('bottom_left');
        expect(await owner.action({ actionId: 'settings.set', input: { anchor: 'desktop.placementMode', value: 'anchored' } }))
            .toEqual({ anchor: 'desktop.placementMode', value: 'anchored' });
        expect(owner.local()).toMatchObject({ desktopOverlayPlacementMode: 'anchored', desktopOverlayAnchor: 'top_center',
            desktopOverlayOffsetX: 0, desktopOverlayOffsetY: 0 });
        expect(invoke).toHaveBeenCalledWith('desktop_activity_overlay_reset_position');
        expect(await owner.action({ actionId: 'settings.set', input: { anchor: 'desktop.anchorPreset', value: 'random' } }))
            .toMatchObject({ ok: false, errorCode: 'invalid_setting_value' });
        const web = createOwner();
        expect(await web.action({ actionId: 'settings.get', input: { anchor: 'desktop.anchorPreset' } }))
            .toMatchObject({ ok: false, errorCode: 'setting_unsupported_host' });
    });
});

describe('navigation placement Settings Actions', () => {
    it.each([
        ['session.composer.enterToSend', false],
        ['session.providerLimits.autoWait', true],
        ['session.providerLimits.resumePrompt', 'off'],
        ['session.providerLimits.customResumePrompt', 'Continue after the limit resets.'],
        ['session.providerLimits.gaugeWindow', ['weekly']],
        ['externalSessions.keepFollowingAfterRestart', false],
        ['sourceControl.confirmBeforePulling', false],
        ['sourceControl.confirmBeforePushing', false],
        ['sourceControl.commitMessageAgent', 'codex'],
        ['handoff.workspaceMode', 'copy_once'],
        ['handoff.includeIgnoredMode', 'include_selected'],
        ['handoff.ignoredIncludeGlobs', ['build/**']],
        ['handoff.directTargetMode', 'convert_to_persisted'],
        ['features.automations', false],
        ['session.wizard.profiles', 'dropdown'],
        ['session.runtime.host', 'tmux'],
        ['session.runtime.sessionName', 'agents'],
        ['session.runtime.isolated', true],
        ['session.runtime.tmpDir', '/tmp/agents'],
        ['profiles.defaultEnvironment.showFirst', true],
        ['account.directConnections', false],
        ['connectedServicesAgentSignIn.sharingConfig', 'isolated'],
        ['appearance.tabBarGitBadge', 'off'],
        ['appearance.tabBarFriendsBadge', false],
        ['appearance.tabBarSessionsBadge', false],
        ['appearance.tabBarInboxBadge', false],
        ['appearance.tabBarOpenTabsBadge', false],
    ] as const)('reads and writes the rendered ordinary preference %s through its declared owner', async (anchor, value) => {
        const owner = createOwner(undefined, true, true, settingsParse({ ...settingsDefaults, useProfiles: true }));
        expect(await owner.action({ actionId: 'settings.set', input: { anchor, value } }))
            .toMatchObject({ anchor, value });
        expect(await owner.action({ actionId: 'settings.get', input: { anchor } }))
            .toMatchObject({ anchor, value });
    });
    it('preserves the coupled rendered preference semantics and other owners on rebase', async () => {
        const owner = createOwner(undefined, true, true, settingsParse({
            ...settingsDefaults,
            useProfiles: true,
            favoriteProfiles: ['other-profile'],
            featureToggles: { 'files.editor': true, 'files.markdownRichEditor': true, automations: true },
            newSessionWizardSectionPresentationV1: { models: 'list' },
            connectedServicesProviderStateSharingSettingsV1: {
                ...settingsDefaults.connectedServicesProviderStateSharingSettingsV1,
                defaults: { configMode: 'linked', stateMode: 'shared' },
            },
        }));
        await owner.action({ actionId: 'settings.set', input: { anchor: 'profiles.defaultEnvironment.showFirst', value: true } });
        expect(owner.account().favoriteProfiles).toEqual(['other-profile', '']);
        await owner.action({ actionId: 'settings.set', input: { anchor: 'session.wizard.profiles', value: 'list' } });
        await owner.action({ actionId: 'settings.set', input: { anchor: 'session.wizard.profiles', value: 'auto' } });
        expect(owner.account().newSessionWizardSectionPresentationV1).toEqual({ models: 'list' });
        await owner.action({ actionId: 'settings.set', input: { anchor: 'session.runtime.host', value: 'tmux' } });
        expect(owner.account().sessionUseTmux).toBe(true);
        await owner.action({ actionId: 'settings.set', input: { anchor: 'session.runtime.host', value: 'none' } });
        expect(owner.account().sessionUseTmux).toBe(false);
        await owner.action({ actionId: 'settings.set', input: { anchor: 'connectedServicesAgentSignIn.sharingConfig', value: 'isolated' } });
        expect(owner.account().connectedServicesProviderStateSharingSettingsV1.defaults.stateMode).toBe('shared');
    });
    it('discovers and rebases Machine connection set/get through real Settings Action schemas', async () => {
        const anchor = 'machines.connection.direct';
        const baseline = settingsParse({ peerMediationPreferencesV1: {
            v: 1, flows: { machine_rpc: { direct: 'disabled' } }, byMachineId: {},
        }, actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'settings.set': ['agent'] } } });
        let current = true;
        const owner = createOwner(undefined, true, true, baseline, undefined, settings => settingsParse({ ...settings,
            peerMediationPreferencesV1: { ...settings.peerMediationPreferencesV1,
                byMachineId: { ...settings.peerMediationPreferencesV1.byMachineId, sibling: { flows: { machine_rpc: { direct: 'enabled' } } } } },
        }), undefined, { isCurrent: () => current });
        const executor = throughActionExecutor(owner.action, () => owner.account().actionsSettingsV1);
        const agent = { surface: 'agent', authority: 'account_automation' } as const;
        expect(await executor.execute('settings.list', { pageId: 'machines' }, agent)).toMatchObject({ ok: true, result: {
            items: expect.arrayContaining([expect.objectContaining({ anchor, allowedValues: ['default', 'direct', 'relay'] })]),
        } });
        for (const value of ['direct', 'relay', 'default'] as const) {
            const set = await executor.execute('settings.set', { anchor, key: 'machine', value }, agent);
            expect(set).toMatchObject({ ok: true, result: { anchor, value } });
            if (set.ok) SettingsDeclarationActionOutputSchemasV1['settings.set'].parse(set.result);
            const get = await executor.execute('settings.get', { anchor, key: 'machine' }, agent);
            expect(get).toMatchObject({ ok: true, result: { anchor, value } });
            if (get.ok) SettingsDeclarationActionOutputSchemasV1['settings.get'].parse(get.result);
            expect(owner.account().peerMediationPreferencesV1.flows).toEqual(baseline.peerMediationPreferencesV1.flows);
            expect(owner.account().peerMediationPreferencesV1.byMachineId.sibling?.flows.machine_rpc?.direct).toBe('enabled');
        }
        expect(Object.hasOwn(owner.account().peerMediationPreferencesV1.byMachineId, 'machine')).toBe(false);
        for (const input of [{ anchor, value: 'direct' }, { anchor, key: '__proto__', value: 'direct' },
            { anchor, key: 'machine', value: { direct: true } }, { anchor, key: 'machine', value: 'direct', target: { kind: 'home', serverId: 'wrong' } }]) {
            expect(await executor.execute('settings.set', input, agent)).toMatchObject({ ok: false });
        }
        current = false;
        expect(await executor.execute('settings.set', { anchor, key: 'machine', value: 'direct' }, agent)).toMatchObject({ ok: false });
        expect(await executor.execute('settings.get', { anchor, key: 'sibling' }, agent)).toMatchObject({ ok: false });
        expect(Object.hasOwn(owner.account().peerMediationPreferencesV1.byMachineId, 'machine')).toBe(false);
    });
    it('changes one machine terminal host and tmux option through the keyed Account setting', async () => {
        const owner = createOwner(undefined, true, true, settingsParse({ ...settingsDefaults,
            sessionTerminalHost: 'herdr',
            sessionTmuxByMachineId: { other: { useTmux: true, sessionName: 'other', isolated: false, tmpDir: null } },
        }));
        const anchor = 'machines.terminal.host';
        expect(await owner.action({ actionId: 'settings.set', input: { anchor, key: 'machine', value: { host: 'tmux' } } }))
            .toMatchObject({ anchor, value: { host: 'tmux' } });
        expect(await owner.action({ actionId: 'settings.set', input: { anchor, key: 'machine', value: { tmux: { isolated: true } } } }))
            .toMatchObject({ anchor, value: { tmux: { isolated: true } } });
        expect(await owner.action({ actionId: 'settings.get', input: { anchor, key: 'machine' } }))
            .toMatchObject({ value: { host: 'tmux', tmux: { isolated: true } } });
        expect(owner.account().sessionTmuxByMachineId.other?.sessionName).toBe('other');
        expect(await owner.action({ actionId: 'settings.set', input: { anchor, key: 'machine', value: { host: null } } }))
            .toMatchObject({ anchor, value: { host: null } });
        expect(await owner.action({ actionId: 'settings.get', input: { anchor, key: 'machine' } }))
            .toMatchObject({ value: { host: null, tmux: null } });
        expect(await owner.action({ actionId: 'settings.set', input: { anchor, value: { host: 'tmux' } } }))
            .toMatchObject({ ok: false, errorCode: 'setting_key_required' });
    });
    it('rejects the prototype setter key before mutating machine terminal settings', async () => {
        const owner = createOwner(undefined, true, true);
        const anchor = 'machines.terminal.host';
        const initialPrototype = Object.getPrototypeOf(owner.account().sessionTmuxByMachineId);
        expect(await owner.action({ actionId: 'settings.set', input: { anchor, key: '__proto__', value: { host: 'tmux' } } }))
            .toMatchObject({ ok: false, errorCode: 'setting_key_required' });
        const map = owner.account().sessionTmuxByMachineId;
        expect(Object.hasOwn(map, '__proto__')).toBe(false);
        expect(Object.getPrototypeOf(map)).toBe(initialPrototype);
    });
    it('changes one installable policy through a keyed Account setting without replacing siblings', async () => {
        const owner = createOwner(undefined, true, true, settingsParse({ ...settingsDefaults,
            installablesPolicyByMachineId: { machine: { other: { autoUpdateMode: 'notify' } }, peer: { tool: { autoInstallWhenNeeded: true } } },
        }), undefined, current => settingsParse({ ...current,
            installablesPolicyByMachineId: { ...current.installablesPolicyByMachineId,
                machine: { ...current.installablesPolicyByMachineId.machine, concurrent: { autoUpdateMode: 'off' } } },
        }));
        const anchor = 'machines.installables.policy';
        expect(await owner.action({ actionId: 'settings.set', input: { anchor, key: 'machine', value: {
            installableKey: 'tool', patch: { autoInstallWhenNeeded: false },
        } } })).toMatchObject({ anchor });
        expect(await owner.action({ actionId: 'settings.get', input: { anchor, key: 'machine' } }))
            .toMatchObject({ value: { other: { autoUpdateMode: 'notify' }, concurrent: { autoUpdateMode: 'off' }, tool: { autoInstallWhenNeeded: false } } });
        expect(owner.account().installablesPolicyByMachineId.peer).toEqual({ tool: { autoInstallWhenNeeded: true } });
        expect(await owner.action({ actionId: 'settings.set', input: { anchor, value: {
            installableKey: 'tool', patch: { autoInstallWhenNeeded: true },
        } } })).toMatchObject({ ok: false, errorCode: 'setting_key_required' });
    });
    it('refuses a native undefined installable policy member as invalid Action output', async () => {
        const owner = createOwner(undefined, true, true, settingsParse({ ...settingsDefaults,
            installablesPolicyByMachineId: { machine: { tool: { autoInstallWhenNeeded: undefined } } },
        }));
        expect(await owner.action({ actionId: 'settings.get', input: {
            anchor: 'machines.installables.policy', key: 'machine',
        } })).toEqual({ ok: false, errorCode: 'invalid_action_output', error: 'invalid_action_output' });
    });
    it('refuses an unrepresentable prototype-named installable policy key without claiming a saved override', async () => {
        const owner = createOwner();
        const anchor = 'machines.installables.policy';
        const initialPrototype = Object.getPrototypeOf(owner.account().installablesPolicyByMachineId);
        expect(await owner.action({ actionId: 'settings.set', input: { anchor, key: '__proto__', value: {
            installableKey: 'constructor', patch: { autoUpdateMode: 'notify' },
        } } })).toMatchObject({ ok: false, errorCode: 'invalid_setting_value' });
        const map = owner.account().installablesPolicyByMachineId;
        expect(Object.getPrototypeOf(map)).toBe(initialPrototype);
        expect(Object.hasOwn(map, '__proto__')).toBe(false);
        expect(await owner.action({ actionId: 'settings.get', input: { anchor, key: '__proto__' } }))
            .toMatchObject({ value: {} });
    });
    it('records sharing acknowledgement from the admitted Action without a second confirmation', async () => {
        const owner = createOwner(undefined, true, true, settingsParse({ ...settingsDefaults,
            connectedServicesProviderStateSharingSettingsV1: {
                ...settingsDefaults.connectedServicesProviderStateSharingSettingsV1,
                defaults: { configMode: 'linked', stateMode: 'isolated' }, acknowledgedRisksByAgentId: {},
            },
        }));
        const input = { anchor: 'connectedServicesAgentSignIn.sharingState', value: true };
        expect(await owner.action({ actionId: 'settings.set', input }))
            .toMatchObject({ ok: false, errorCode: 'setting_value_unavailable' });
        await admitSettingsSharingCatalog();
        expect(await owner.action({ actionId: 'settings.set', input: {
            anchor: 'connectedServicesAgentSignIn.sharingState', value: true,
        } })).toMatchObject({ value: true });
        expect(owner.account().connectedServicesProviderStateSharingSettingsV1.acknowledgedRisksByAgentId)
            .toMatchObject({ codex: { sharedStatePrivacy: true } });
        expect(humanConfirmation.confirm).not.toHaveBeenCalled();
    });
    it('rejects malformed nested defaults and preserves concurrent sibling fields', async () => {
        const owner = createOwner(undefined, true, true, settingsDefaults, undefined, current => settingsParse({
            ...current,
            sessionHandoffDefaultsV1: { ...current.sessionHandoffDefaultsV1, directTargetMode: 'convert_to_persisted' },
        }));
        for (const [anchor, value] of [
            ['handoff.workspaceMode', 'invalid'],
            ['handoff.ignoredIncludeGlobs', ['../escape']],
            ['externalSessions.keepFollowingAfterRestart', 'false'],
        ]) expect(await owner.action({ actionId: 'settings.set', input: { anchor, value } }))
            .toMatchObject({ ok: false, errorCode: 'invalid_setting_value' });
        expect(await owner.action({ actionId: 'settings.set', input: { anchor: 'handoff.workspaceMode', value: 'copy_once' } }))
            .toMatchObject({ value: 'copy_once' });
        expect(owner.account().sessionHandoffDefaultsV1).toMatchObject({ workspaceSyncMode: 'copy_once', directTargetMode: 'convert_to_persisted' });
    });
    it('discovers and edits the Actions page nested policy without replacing other restrictions', async () => {
        const owner = createOwner();
        await owner.action({ actionId: 'settings.set', input: { anchor: 'actions.createSession.allowCrossMachine', value: false } });
        expect(await owner.action({ actionId: 'settings.list', input: { pageId: 'actions' } }))
            .toMatchObject({ items: expect.arrayContaining([expect.objectContaining({
                anchor: 'actions.createSession.allowEnvironmentVariables', readable: true, writable: true, storageScope: 'account',
            })]) });
        expect(await owner.action({ actionId: 'settings.set', input: { anchor: 'actions.createSession.allowEnvironmentVariables', value: false } }))
            .toMatchObject({ value: false });
        expect(await owner.action({ actionId: 'settings.get', input: { anchor: 'actions.createSession.allowEnvironmentVariables' } }))
            .toMatchObject({ value: false });
        expect(owner.account().sessionAgentSpawnPolicyV1).toMatchObject({ allowCrossMachine: false, allowEnvironmentVariables: false });
    });
    it('reads and changes machine creation through the canonical Account setting', async () => {
        const owner = createOwner();
        expect(await owner.action({ actionId: 'settings.get', input: { anchor: 'machines.defaults.creationEnabled' } }))
            .toMatchObject({ value: true });
        expect(await owner.action({ actionId: 'settings.set', input: { anchor: 'machines.defaults.creationEnabled', value: false } }))
            .toMatchObject({ value: false });
        expect(owner.account().managedMachineCreationEnabled).toBe(false);
        expect(owner.account().machineRetentionDefaultsV1).toEqual({ v: 1 });
        expect(await owner.action({ actionId: 'settings.set', input: { anchor: 'machines.defaults.creationEnabled', value: 'false' } }))
            .toMatchObject({ ok: false, errorCode: 'invalid_setting_value' });
    });
    it('reads the effective device-local placement map and writes strict current preferences', async () => {
        const owner = createOwner();
        expect(await owner.action({ actionId: 'settings.get', input: { anchor: 'appearance.navigationPlacements' } }))
            .toMatchObject({ anchor: 'appearance.navigationPlacements', value: { sessionTabBar: { orderedIds: ['browse', 'git', 'companion', 'terminal'] } } });
        const value = { appRail: { orderedIds: ['plugin:removed', 'sessions'], placements: { 'plugin:removed': 'hidden', sessions: 'overflow' } }, sessionTabBar: { orderedIds: [], placements: { git: 'hidden' } } };
        expect(await owner.action({ actionId: 'settings.set', input: { anchor: 'appearance.navigationPlacements', value } }))
            .toMatchObject({ anchor: 'appearance.navigationPlacements', value });
        expect(owner.local().navigationSurfacePlacementsV1).toEqual(value);
        expect(owner.local().sessionCockpitBarSurfaceIds).toBeNull();
        expect(owner.local().compactAppDestinationPreferencesV1).toEqual({ orderedDestinationIds: [], hiddenDestinationIds: [] });
        const before = owner.local();
        for (const bad of [{ ...value, futureSurface: {} }, { appRail: { ...value.appRail, future: true } }, { appRail: { orderedIds: [], placements: { sessions: 'visible' } } }]) {
            expect(await owner.action({ actionId: 'settings.set', input: { anchor: 'appearance.navigationPlacements', value: bad } })).toMatchObject({ ok: false, errorCode: 'invalid_setting_value' });
        }
        expect(owner.local()).toEqual(before);
    });
});

let summaryCatalogAccount: Promise<Awaited<ReturnType<typeof captureLazyActionAccountContext>>> | null = null;

/** Serve Account rows at HTTP/credential boundaries; capture, catalog parsing and admission stay real. */
function readSummaryCatalogAccount() {
    if (!summaryCatalogAccount) {
        const capture = (async () => {
            const network = await installSessionOpsNetworkBoundary();
            let account: Awaited<ReturnType<typeof captureLazyActionAccountContext>> | null = null;
            onTestFinished(async () => { account?.dispose(); await network.dispose(); summaryCatalogAccount = null; });
            const serverUrl = 'https://settings-summary.example.test';
            const accountId = 'settings-summary-account';
            const token = `test.${Buffer.from(JSON.stringify({ sub: accountId, tokenEpoch: 1,
                provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.test`;
            const home = await network.addHome(serverUrl, accountId, { credentials: { token } });
            await setServerProfileIdentityForUrl(serverUrl, 'srv_settings_summary');
            const machineCatalog = await createExternalActionAccountHttpBoundary({ serverUrl, serverIdentityId: 'srv_settings_summary',
                accountId, machineId: 'settings-summary-machine', actionId: 'agents.models.list', tokenEpoch: 1, execute(input) {
                    expect(input).toMatchObject({ purpose: 'scm_diff_summary', machineId: 'settings-summary-machine' });
                    const profiles = getResolvedBackendCatalogEntries({ enabledAgentIds: getEnabledAgentIds(settingsDefaults),
                        backendEnabledByTargetKey: settingsDefaults.backendEnabledByTargetKey }).flatMap(entry => buildScmDiffSummaryModelProfiles({
                        backendTarget: readBackendTargetRefV2(entry.backendTarget), models: getAgentStaticModels(entry.agentId, { catalogOnly: true }),
                        agentFormats: getAgentCore(entry.agentId)?.structuredOutput?.formats }));
                    return { items: [], scmDiffSummaryCatalog: { profiles, automaticProfiles: profiles,
                        discoveryTargetKeys: profiles.flatMap(profile => profile.modelSelector?.backendTargetKey ?? []) } };
                } });
            network.setHttpResponder(async (url, init) => {
                const external = await machineCatalog.handle(new URL(String(url)), init);
                if (external) return external;
                expect(init?.method ?? 'GET').toBe('GET');
                const path = new URL(String(url)).pathname;
                if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
                if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
                if (path === ACP_CATALOG_ROWS_ROUTE_V1) return Response.json({ status: 'present', revision: 1,
                    content: { t: 'plain', v: { v: 1, definitions: [] } } });
                return null;
            });
            account = await captureLazyActionAccountContext(home.id);
            return account;
        })();
        summaryCatalogAccount = capture;
    }
    return summaryCatalogAccount;
}

/** Publish the Account inventory at its real writer; sharing admission and consent stay real. */
async function admitSettingsSharingCatalog() {
    const account = await readSummaryCatalogAccount();
    const scope = await activateStorageAccountScope(account.accountLifetime.scope);
    const { replacePluginAccountAvailabilityProjection, clearPluginAccountAvailabilityProjection } =
        await import('@/sync/domains/plugins/availability/projection');
    const dispose = () => {
        clearPluginAccountAvailabilityProjection();
        scope.dispose();
    };
    onTestFinished(dispose);
    replacePluginAccountAvailabilityProjection({ scope: account.accountLifetime.scope, snapshot: {
        availabilityCursor: 1, intentReads: [], materializations: [], snapshots: [], inventoryComplete: true,
    } });
    return dispose;
}

/** Seed only device storage; model descriptors, catalog projection and admission stay real. */
async function offeredSummaryProfiles() {
    const before = storage.getState();
    onTestFinished(() => storage.setState(before, true));
    storage.setState({ settings: settingsDefaults });
    const account = await readSummaryCatalogAccount();
    const machine = createMachineFixture({ id: 'settings-summary-machine', activeAt: Date.now() });
    storage.setState({ settings: { ...settingsDefaults, machineAdministrationTargetsLocalV1: {
        [MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.sourceControl]: { serverIdentityId: 'srv_settings_summary', machineId: machine.id } } },
        profileScope: account.accountLifetime.scope, machines: { [machine.id]: machine },
        machineListByServerId: { [account.serverId]: [machine] }, machineListStatusByServerId: { [account.serverId]: 'idle' } });
    const { catalog } = await readAcpCatalogInContext(account);
    return getResolvedBackendCatalogEntries({
        enabledAgentIds: getEnabledAgentIds({ backendEnabledByTargetKey: settingsDefaults.backendEnabledByTargetKey }),
        backendEnabledByTargetKey: settingsDefaults.backendEnabledByTargetKey,
        acpCatalogSnapshot: catalog,
    }).flatMap(entry => buildScmDiffSummaryModelProfiles({
        backendTarget: readBackendTargetRefV2(entry.backendTarget),
        models: getAgentStaticModels(entry.agentId, { catalogOnly: true }),
        agentFormats: entry.kind === 'builtInAgent' ? getAgentCore(entry.agentId)?.structuredOutput?.formats : null,
    }));
}

async function supportedSummaryPreference() {
    const profile = (await offeredSummaryProfiles()).find(candidate => candidate.structuredOutput === 'supported');
    if (!profile) throw new Error('Expected a genuinely supported offered Summary model');
    return profile.catalogId;
}

describe('declared settings owner', () => {
    it('discovers and changes new-Bot upkeep through the real Account settings front door', async () => {
        const anchor = 'prompts.context.memoryUpkeepInNewBots';
        // The Account explicitly permits these settings mutations; admission and approval policy stay real.
        const actionsSettings = ActionsSettingsV1Schema.parse({ v: 1,
            actions: { 'settings.set': { enabled: true } },
            approvalWaivedSurfaces: {
                'settings.set': ['ui', 'agent', 'mcp', 'cli'],
            },
        });
        // Supply validated Account policy and HTTP features; both canonical decisions stay real.
        const owner = createOwner(undefined, false, true, { ...settingsDefaults, actionsSettingsV1: actionsSettings },
            undefined, undefined, undefined, undefined, {
                status: 'ready', features: FeaturesResponseSchema.parse(createRootLayoutFeaturesResponse()),
            });
        const executor = throughActionExecutor(owner.action, () => owner.account().actionsSettingsV1);
        for (const surface of ['ui', 'agent', 'mcp', 'cli'] as const) {
            expect(await executor.execute('settings.list', { pageId: 'prompts' }, { surface }))
                .toMatchObject({ ok: true, result: { items: expect.arrayContaining([
                    expect.objectContaining({ anchor, readable: true, writable: true, storageScope: 'account' }),
                ]) } });
            expect(await executor.execute('settings.get', { anchor }, { surface }))
                .toEqual({ ok: true, result: { anchor, value: true } });
            expect(await executor.execute('settings.set', { anchor, value: false }, { surface, actionsSettings }))
                .toEqual({ ok: true, result: { anchor, value: false } });
            expect(owner.account().memoryUpkeepInNewBots).toBe(false);
            expect(await executor.execute('settings.set', { anchor, value: true }, { surface, actionsSettings }))
                .toEqual({ ok: true, result: { anchor, value: true } });
            expect(owner.account().memoryUpkeepInNewBots).toBe(true);
        }
        const context = { surface: 'ui', authority: 'present_user',
            presentUserConfirmation: { actionId: 'settings.set' } } as const;
        expect(await executor.execute('settings.set', { anchor, value: false }, context))
            .toEqual({ ok: true, result: { anchor, value: false } });
        expect(owner.account().memoryUpkeepInNewBots).toBe(false);
        const saved = owner.account();
        expect(await executor.execute('settings.set', { anchor, value: 'true' }, context))
            .toMatchObject({ ok: false, errorCode: 'invalid_setting_value' });
        expect(owner.account()).toEqual(saved);
        expect(await executor.execute('settings.get', { anchor }, { surface: 'agent' }))
            .toEqual({ ok: true, result: { anchor, value: false } });
    });

    it('lists, edits and resets machine category defaults through the real settings Actions', async () => {
        const owner = createOwner();
        const discovered = await owner.action({ actionId: 'settings.list', input: { pageId: 'machines' } });
        expect(discovered).toMatchObject({ items: expect.arrayContaining([
            expect.objectContaining({ anchor: 'machines.defaults.local', writable: true }),
            expect.objectContaining({ anchor: 'machines.defaults.runningOnly', writable: true }),
            expect.objectContaining({ anchor: 'machines.defaults.stoppedBilled', writable: true }),
            expect.objectContaining({ anchor: 'machines.defaults.unknown', writable: true }),
        ]) });
        const value = { retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false };
        const executor = throughActionExecutor(owner.action);
        const context = { surface: 'ui', authority: 'present_user',
            presentUserConfirmation: { actionId: 'settings.set' } } as const;
        expect(await executor.execute('settings.set', { anchor: 'machines.defaults.local', value }, context))
            .toMatchObject({ ok: true, result: { value } });
        expect(await owner.action({ actionId: 'settings.get', input: { anchor: 'machines.defaults.local' } }))
            .toEqual({ anchor: 'machines.defaults.local', value });
        expect(await executor.execute('settings.set', { anchor: 'machines.defaults.unknown', value }, context))
            .toMatchObject({ ok: true });
        expect(await executor.execute('settings.set', { anchor: 'machines.defaults.local', value: null }, context))
            .toMatchObject({ ok: true, result: { value: null } });
        expect(owner.account().machineRetentionDefaultsV1).toEqual({ v: 1, unknown: value });
        expect(await executor.execute('settings.set', { anchor: 'machines.defaults.local', value: { ...value, managedId: 'no' } }, context))
            .toMatchObject({ ok: false });
    });
    it('executes catalog Preview and Stop through the real Action front door and contribution-owned catalog', async () => {
        const before = storage.getState();
        vi.stubGlobal('navigator', { userActivation: { isActive: true } });
        onTestFinished(() => { vi.unstubAllGlobals(); });
        const { PLUGIN_MANIFEST } = await import('../../../../../../packages/plugins/elevenlabs/src/manifest');
        const { VOICE_PROVIDER_PRESENTATIONS } = await import('../../../../../../packages/plugins/elevenlabs/src/ui/voice/entries');
        const registry = createVoiceProviderRegistry({ bundledContributions: projectBundledVoiceManifestContributions(PluginManifestV2Schema.parse(PLUGIN_MANIFEST)), bundledPresentations: VOICE_PROVIDER_PRESENTATIONS });
        const providerId = 'happier.voice.elevenlabs/realtime-elevenlabs';
        const entry = registry.get(providerId);
        if (!entry?.providerSettings) throw new Error('Missing real catalog provider');
        const token = {};
        const { listElevenLabsVoicesWithAccountOperations } = await import('../../../../../../packages/plugins/elevenlabs/src/ui/voice/operations');
        // Only the mediated provider HTTP boundary is substituted, not the provider catalog parser.
        const accountOperations = { request: async () => ({ status: 200, finalUrl: 'https://api.elevenlabs.io/v1/voices', headers: {},
            body: new TextEncoder().encode(JSON.stringify({ voices: [{ voice_id: 'voice_a', name: 'Voice A', preview_url: 'https://example.test/a.mp3' }] })) }) };
        const catalog = async ({ signal }: Readonly<{ signal: AbortSignal }>) => listElevenLabsVoicesWithAccountOperations({ accountOperations, signal });
        commitExternalVoiceProviderRegistration({ token, pluginId: entry.pluginId, localId: 'realtime-elevenlabs', providerId, descriptor: entry, adapter: null,
            settingsOperations: { listCatalog: catalog } });
        catalogAudio.play.mockClear(); catalogAudio.remove.mockClear();
        onTestFinished(async () => {
            const { stopRealtimeCatalogPreview } = await import('@/voice/settings/panels/realtime/catalogPreview');
            stopRealtimeCatalogPreview(providerId);
            removeExternalVoiceProviderRegistration(token); storage.setState(before, true);
        });
        const account = applySettings(settingsDefaults, normalizeVoiceSettingsLocalDelta({ voice: { ...settingsDefaults.voice, providerId } }, settingsDefaults));
        storage.setState({ settings: account, settingsScope: { serverId: 'test-home', accountId: 'test-account' } });
        const owner = createOwner(undefined, true, true, account);
        const executor = throughActionExecutor(owner.action, () => owner.account().actionsSettingsV1);
        const discovered = await owner.action({ actionId: 'settings.list', input: { pageId: 'voiceConversations' } });
        if (!('items' in discovered) || !discovered.items) throw new Error('Missing operation discovery');
        const preview = discovered.items.find(item => item.anchor.includes(providerId) && item.anchor.endsWith('.preview'));
        const stop = discovered.items.find(item => item.anchor.includes(providerId) && item.anchor.endsWith('.stopPreview'));
        if (!preview || !stop) throw new Error('Missing declared catalog operations');
        const list = discovered.items.find(item => item.anchor.includes(providerId) && item.anchor.endsWith('.listCatalog'));
        const retry = discovered.items.find(item => item.anchor.includes(providerId) && item.anchor.endsWith('.retryCatalog'));
        expect(list, 'Agent catalog inspection must be declared').toBeDefined();
        expect(retry, 'Agent catalog retry must be declared').toBeDefined();
        for (const operation of [list!, retry!]) {
            expect(operation.operation).toMatchObject({ requiresHumanInteraction: false, requiresApproval: false });
            const result = await executor.execute('settings.invoke', { anchor: operation.anchor }, { surface: 'agent', authority: 'account_automation' });
            expect(result).toEqual({ ok: true, result: { anchor: operation.anchor, status: 'completed', value: { rows: [
                { id: 'voice_a', name: 'Voice A', previewAvailable: true },
            ] } } });
            expect(catalogAudio.play).not.toHaveBeenCalled();
        }
        const ctx = { surface: 'ui' as const, authority: 'present_user' as const };
        expect(await executor.execute('settings.invoke', { anchor: preview.anchor, input: { kind: 'voice_preview', voiceId: 'voice_a' } }, ctx))
            .toEqual({ ok: true, result: { anchor: preview.anchor, status: 'completed', value: { voiceId: 'voice_a', started: true } } });
        expect(catalogAudio.play).toHaveBeenCalled();
        expect(await executor.execute('settings.invoke', { anchor: stop.anchor }, ctx))
            .toEqual({ ok: true, result: { anchor: stop.anchor, status: 'completed', value: { stopped: true } } });
        expect(catalogAudio.remove).toHaveBeenCalled();
        expect(preview.operation?.requiresApproval).toBe(true);
        expect(stop.operation?.requiresApproval).toBe(false);
        expect(isApprovalRequiredByActionsSettings('settings.invoke', ActionsSettingsV1Schema.parse({ v: 1 }), { surface: 'agent', authority: 'account_automation' },
            resolveSettingsDeclarationOperationApprovalPolicy(stop.anchor, account).requiresApproval ? 'danger' : 'safe')).toBe(false);
        await executor.execute('settings.invoke', { anchor: preview.anchor, input: { kind: 'voice_preview', voiceId: 'voice_a' } }, ctx);
        storage.setState({ settingsScope: { serverId: 'different-home', accountId: 'test-account' } });
        const { readRealtimeCatalogPreview } = await import('@/voice/settings/panels/realtime/catalogPreview');
        expect(readRealtimeCatalogPreview()).toBeNull();
        expect(owner.openedInteractions).toEqual([]);
    });
    it('lists and retries a speech-engine voice catalog through its selected daemon without playback', async () => {
        const before = storage.getState();
        onTestFinished(() => { storage.setState(before, true); settingsMachineRpc.mockReset(); });
        const providerId = 'happier.voice.google/google-cloud-tts';
        const account = applySettings(settingsDefaults, normalizeVoiceSettingsLocalDelta({ voice: { ...settingsDefaults.voice,
            providerId: 'local_conversation', executionMachine: { mode: 'fixed', machineId: 'voice-catalog-machine' },
            providers: { local_conversation: { schemaVersion: 1, config: { tts: { provider: providerId } } } },
        } }, settingsDefaults));
        storage.setState({ settings: account, machines: { 'voice-catalog-machine': createMachineFixture({ id: 'voice-catalog-machine', activeAt: Date.now() }) } });
        await installVoiceMachineFixture(storage.getState().machines);
        // The machine fixture activates the profile lifetime; the Settings owner also
        // requires the matching loaded Account settings scope, as the mounted app does.
        storage.setState({ settings: account, settingsScope: storage.getState().profileScope });
        const owner = createOwner(undefined, true, true, account);
        const executor = throughActionExecutor(owner.action, () => owner.account().actionsSettingsV1);
        const discovered = await owner.action({ actionId: 'settings.list', input: { pageId: 'voiceConversations' } });
        if (!('items' in discovered) || !discovered.items) throw new Error('Missing settings discovery');
        const operations = ['listCatalog', 'retryCatalog'].map(operation => discovered.items!.find(item =>
            item.anchor.includes(providerId) && item.anchor.endsWith(`.${operation}`)));
        expect(operations.every(Boolean), 'Speech catalog operations must use the declared voices field').toBe(true);
        settingsMachineRpc.mockResolvedValue({ ok: true, items: [{ id: 'en-US-Studio-O', name: 'Studio O' }] });
        for (const operation of operations) {
            const result = await executor.execute('settings.invoke', { anchor: operation!.anchor }, { surface: 'agent', authority: 'account_automation' });
            expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { status: 'completed', value: {
                rows: [{ id: 'en-US-Studio-O', name: 'Studio O' }],
            } } });
        }
        expect(settingsMachineRpc.mock.calls.every(([request]) => request.method === 'daemon.voice.speech.catalog')).toBe(true);
    });
    it('executes model installation from the real Action front door through the selected daemon owner', async () => {
        const before = storage.getState();
        const { primeServerFeaturesSnapshot, resetServerFeaturesClientForTests } = await import('@/sync/api/capabilities/serverFeaturesClient');
        const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
        vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('unexpected_network_request'); }));
        onTestFinished(() => { storage.setState(before, true); settingsMachineRpc.mockReset(); resetServerFeaturesClientForTests(); vi.unstubAllGlobals(); });
        const account = applySettings(settingsDefaults, normalizeVoiceSettingsLocalDelta({ experiments: true,
            featureToggles: { voice: true, 'voice.agent': true, 'voice.daemonInference': true, 'execution.runs': true },
            voice: { ...settingsDefaults.voice, executionMachine: { mode: 'fixed' as const, machineId: 'voice-machine' } } }, settingsDefaults));
        storage.setState({ settings: account, machines: { 'voice-machine': createMachineFixture({ id: 'voice-machine', activeAt: Date.now() }) } });
        await installVoiceMachineFixture(storage.getState().machines);
        primeServerFeaturesSnapshot({ serverId: getActiveServerSnapshot().serverId,
            snapshot: { status: 'ready', features: FeaturesResponseSchema.parse({ features: { voice: { enabled: true }, execution: { runs: { enabled: true } } }, capabilities: {} }) } });
        const packId = 'sherpa-onnx-streaming-zipformer-en-20M-2023-02-17';
        const entry = getModelPackCatalogEntry(packId);
        if (!entry) throw new Error('missing canonical fixture model');
        const status = { packId, pluginIdentity: null, kind: entry.kind, model: entry.model, version: null,
            executionSupport: ['daemon'], runtimeFamily: entry.runtimeFamily, runtimeSupported: true, installState: 'not_installed',
            progress: null, lastError: null, updatedAtMs: 0 };
        settingsMachineRpc.mockImplementation(async request => {
            if (request.machineId !== 'voice-machine') throw new Error('wrong_machine');
            if (request.method === 'daemon.voiceInference.models.status') return { ok: true, models: [status] };
            if (request.method === 'daemon.voiceInference.models.install') return { ok: true, model: { ...status, installState: 'installed' } };
            throw new Error('unexpected_machine_operation');
        });
        let current = true;
        const owner = createOwner(undefined, true, true, account, undefined, undefined, undefined, { isCurrent: () => current });
        const executor = throughActionExecutor(owner.action);
        const result = await executor.execute('settings.invoke', { anchor: 'voiceAdvanced.installSpeechModel', input: { kind: 'model_pack', packId, machineId: 'voice-machine' } }, { surface: 'ui', authority: 'present_user' });
        expect(settingsMachineRpc.mock.calls.map(([request]) => request.method))
            .toEqual(['daemon.voiceInference.models.status', 'daemon.voiceInference.models.install']);
        expect(result).toEqual({ ok: true, result: { anchor: 'voiceAdvanced.installSpeechModel', status: 'completed', value: { packId } } });
        settingsMachineRpc.mockImplementation(async request => {
            if (request.method === 'daemon.voiceInference.models.status') return { ok: true, models: [status] };
            current = false;
            return { ok: true, model: { ...status, installState: 'installed' } };
        });
        expect(await executor.execute('settings.invoke', { anchor: 'voiceAdvanced.installSpeechModel', input: { kind: 'model_pack', packId, machineId: 'voice-machine' } }, { surface: 'ui', authority: 'present_user' }))
            .toEqual({ ok: true, result: { anchor: 'voiceAdvanced.installSpeechModel', status: 'cancelled' } });
        expect(owner.openedInteractions).toEqual([]);
    });
    it('executes Voice operations with typed missing-target results instead of opening a settings row', async () => {
        const owner = createOwner(undefined, true);
        for (const anchor of ['voiceAdvanced.installSpeechModel', 'voiceAdvanced.removeSpeechModel', 'voiceAdvanced.defaultSpeechModel', 'voicePrivacy.diagnosticsExport', 'voicePrivacy.diagnosticsSessionOptOut', 'voicePrivacy.diagnosticsRetryShutdown']) {
            expect(await owner.action({ actionId: 'settings.invoke', input: { anchor } }))
                .toEqual({ anchor, status: 'unavailable', reason: 'operation_input_required' });
        }
        expect(owner.openedInteractions).toEqual([]);
    });
    it.each([null, 'voice-machine'])('reads semantic Voice roles without probing a computer for device speech and the current session (%s)', async (machineId) => {
        const before = storage.getState();
        vi.stubGlobal('SpeechRecognition', function SpeechRecognition() {});
        onTestFinished(() => { storage.setState(before, true); vi.unstubAllGlobals(); settingsMachineRpc.mockReset(); });
        const local = readLocalConversationVoiceSettings(settingsDefaults.voice);
        const voice = writeLocalConversationVoiceSettings(settingsDefaults.voice, { ...local, conversationMode: 'direct_session',
            stt: { ...local.stt, provider: 'device' }, tts: { ...local.tts, provider: 'device' } });
        const account = applySettings(settingsDefaults, normalizeVoiceSettingsLocalDelta({ voice: { ...voice, providerId: 'local_conversation',
            executionMachine: { mode: 'fixed' as const, machineId } } }, settingsDefaults));
        storage.setState({ settings: account, machines: machineId ? { [machineId]: createMachineFixture({ id: machineId, activeAt: Date.now() }) } : {} });
        await installVoiceMachineFixture(storage.getState().machines);
        const owner = createOwner(undefined, true, true, account);
        expect(await throughActionExecutor(owner.action).execute('settings.invoke', { anchor: 'voiceConversations.readiness' }, { surface: 'agent', authority: 'account_automation' }))
            .toMatchObject({ ok: true, result: { status: 'completed', value: { providerId: 'local_conversation', machineId,
                roles: { hear: { status: 'ready', recoveryAction: 'none' }, think: { status: 'ready', recoveryAction: 'none' }, speak: { status: 'ready', recoveryAction: 'none' } } } } });
        expect(settingsMachineRpc).not.toHaveBeenCalled();
    });
    it.each([
        { agentId: '', feature: true, machineId: null, code: 'settings_missing_required_setting', recoveryAction: 'open_provider_settings' },
        { agentId: 'codex', feature: false, machineId: null, code: 'server_feature_disabled', recoveryAction: 'switch_provider' },
        { agentId: 'codex', feature: true, machineId: 'offline-machine', code: 'execution_machine_incompatible', recoveryAction: 'select_execution_machine' },
    ])('reads the canonical Think recovery for $code', async ({ agentId, feature, machineId, code, recoveryAction }) => {
        const before = storage.getState();
        onTestFinished(() => { storage.setState(before, true); settingsMachineRpc.mockReset(); });
        const local = readLocalConversationVoiceSettings(settingsDefaults.voice);
        const voice = writeLocalConversationVoiceSettings(settingsDefaults.voice, { ...local, conversationMode: 'agent',
            agent: { ...local.agent, agentSource: 'agent', agentId },
            stt: { ...local.stt, provider: 'device' }, tts: { ...local.tts, provider: 'device' } });
        const account = applySettings(settingsDefaults, normalizeVoiceSettingsLocalDelta({ experiments: true,
            featureToggles: { voice: true, 'voice.agent': feature, 'execution.runs': true },
            voice: { ...voice, providerId: 'local_conversation',
            executionMachine: { mode: 'fixed' as const, machineId } } }, settingsDefaults));
        storage.setState({ settings: account, machines: {} });
        // The Home payload and Account preferences feed the real feature decision owner.
        const featureSnapshot: ServerFeaturesSnapshot = { status: 'ready',
            features: FeaturesResponseSchema.parse({ features: { voice: { enabled: true }, execution: { runs: { enabled: true } } }, capabilities: {} }) };
        const owner = createOwner(undefined, true, true, account, undefined, undefined, undefined, undefined, featureSnapshot);
        const executor = throughActionExecutor(owner.action);
        expect(await executor.execute('settings.invoke', { anchor: 'voiceConversations.readiness' }, { surface: 'agent', authority: 'account_automation' }))
            .toMatchObject({ ok: true, result: { status: 'completed', value: { roles: { think: { code, recoveryAction } } } } });
        expect(settingsMachineRpc).not.toHaveBeenCalled();
    });
    it('reads a machine-free contributed cloud service and independent Dictation readiness', async () => {
        const before = storage.getState();
        vi.stubGlobal('SpeechRecognition', function SpeechRecognition() {});
        const pluginId = 'fixture.voice.readiness';
        const providerId = `${pluginId}/cloud`;
        const declaration = VoiceProviderContributionSchema.parse({ id: 'cloud', title: 'Cloud conversation', kind: 'conversation',
            roles: ['realtime_conversation'], platforms: ['web'],
            capabilities: { turn: { cancelResponse: true, bargeIn: true }, tools: { effectCalls: 'none' } },
            client: { artifactId: 'voice', exportName: 'activate' },
            settings: { schemaVersion: 1, fields: [{ id: 'model', title: 'Model', schema: { type: 'string', maxLength: 128 },
                default: 'fixture-model', presentation: { control: 'text' } }] } });
        const registry = createVoiceProviderRegistry({ bundledContributions: [{ pluginId, providerId, declaration }],
            bundledPresentations: [{ providerId, settingsSectionId: 'fixture.cloud', createSettingsSpec: () => null }] });
        const token = {};
        commitExternalVoiceProviderRegistration({ token, pluginId, localId: 'cloud', providerId, descriptor: registry.get(providerId), adapter: null });
        onTestFinished(() => { removeExternalVoiceProviderRegistration(token); storage.setState(before, true); vi.unstubAllGlobals(); settingsMachineRpc.mockReset(); });
        const voice = writeVoiceProviderSettingsConfig({ ...settingsDefaults.voice, providerId,
            executionMachine: { mode: 'fixed', machineId: null } }, providerId, { model: 'fixture-model' });
        const account = applySettings(settingsDefaults, normalizeVoiceSettingsLocalDelta({ voice }, settingsDefaults));
        storage.setState({ settings: account, machines: {} });
        const owner = createOwner(undefined, true, true, account);
        const executor = throughActionExecutor(owner.action);
        const context = { surface: 'agent' as const, authority: 'account_automation' as const };
        expect(await executor.execute('settings.invoke', { anchor: 'voiceConversations.readiness' }, context))
            .toMatchObject({ ok: true, result: { status: 'completed', value: { providerId, machineId: null,
                readiness: { status: 'ready', recoveryAction: 'none' }, roles: { hear: { status: 'ready' }, think: { status: 'ready' }, speak: { status: 'ready' } } } } });
        expect(await executor.execute('settings.invoke', { anchor: 'voiceDictation.readiness' }, context))
            .toMatchObject({ ok: true, result: { status: 'completed', value: { providerId: 'device', readiness: { status: 'ready', recoveryAction: 'none' } } } });
        expect(settingsMachineRpc).not.toHaveBeenCalled();
    });
    it('checks only the selected daemon speech model and preserves the canonical model recovery', async () => {
        const before = storage.getState();
        const { primeServerFeaturesSnapshot, resetServerFeaturesClientForTests } = await import('@/sync/api/capabilities/serverFeaturesClient');
        const { getAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
        onTestFinished(() => { storage.setState(before, true); settingsMachineRpc.mockReset(); resetServerFeaturesClientForTests(); });
        const serverId = getAppliedActiveServerSnapshot().serverId;
        const packId = 'sherpa-onnx-streaming-zipformer-en-20M-2023-02-17';
        const entry = getModelPackCatalogEntry(packId);
        if (!entry) throw new Error('Missing canonical speech model');
        const local = readLocalConversationVoiceSettings(settingsDefaults.voice);
        const voice = writeLocalConversationVoiceSettings(settingsDefaults.voice, { ...local, conversationMode: 'direct_session',
            stt: { ...local.stt, provider: 'local_neural', localNeural: { ...local.stt.localNeural, assetId: packId, execution: 'daemon' } },
            tts: { ...local.tts, provider: 'device' } });
        const account = applySettings(settingsDefaults, normalizeVoiceSettingsLocalDelta({ experiments: true,
            featureToggles: { voice: true, 'voice.agent': true, 'voice.daemonInference': true, 'execution.runs': true },
            voice: { ...voice, providerId: 'local_conversation', executionMachine: { mode: 'fixed' as const, machineId: 'voice-machine' } },
        }, settingsDefaults));
        storage.setState({ settings: account, settingsScope: { serverId, accountId: 'test-account' },
            machines: { 'voice-machine': createMachineFixture({ id: 'voice-machine', activeAt: Date.now() }) } });
        await installVoiceMachineFixture(storage.getState().machines);
        // The page prioritizes the selected missing model before a missing heavy-audio route.
        const featureSnapshot: ServerFeaturesSnapshot = { status: 'ready', features: FeaturesResponseSchema.parse({
            features: { voice: { enabled: true }, execution: { runs: { enabled: true } },
                machines: { enabled: true, liveStream: { enabled: true, serverRouted: { enabled: false } } } }, capabilities: {},
        }) };
        primeServerFeaturesSnapshot({ serverId, snapshot: featureSnapshot });
        settingsMachineRpc.mockImplementation(async request => {
            if (request.method !== 'daemon.voiceInference.models.status') throw new Error('Unexpected readiness operation');
            expect(request).toMatchObject({ machineId: 'voice-machine', payload: { packIds: [packId] } });
            return { ok: true, models: [{ packId, pluginIdentity: null, kind: entry.kind, model: entry.model, version: null,
                executionSupport: ['daemon'], runtimeFamily: entry.runtimeFamily, runtimeSupported: true,
                installState: 'not_installed', progress: null, lastError: null, updatedAtMs: 0 }] };
        });
        const owner = createOwner(undefined, true, true, account, undefined, undefined, undefined, undefined, featureSnapshot);
        expect(await throughActionExecutor(owner.action).execute('settings.invoke', { anchor: 'voiceConversations.readiness' }, { surface: 'agent', authority: 'account_automation' }))
            .toMatchObject({ ok: true, result: { status: 'completed', value: {
                readiness: { code: 'model_missing', recoveryAction: 'install_model' },
                models: [expect.objectContaining({ packId, installState: 'not_installed' })], roles: { think: { status: 'ready' } },
            } } });
        expect(settingsMachineRpc).toHaveBeenCalled();
    });
    it('cancels semantic readiness after Account retirement or selection replacement during its final read', async () => {
        const before = storage.getState();
        onTestFinished(() => { storage.setState(before, true); settingsMachineRpc.mockReset(); });
        const local = readLocalConversationVoiceSettings(settingsDefaults.voice);
        const voice = writeLocalConversationVoiceSettings(settingsDefaults.voice, { ...local, conversationMode: 'direct_session',
            stt: { ...local.stt, provider: 'device' }, tts: { ...local.tts, provider: 'device' } });
        const account = applySettings(settingsDefaults, normalizeVoiceSettingsLocalDelta({ voice: { ...voice, providerId: 'local_conversation',
            executionMachine: { mode: 'fixed' as const, machineId: null } } }, settingsDefaults));
        for (const retireAccount of [true, false]) {
            storage.setState({ settings: account, machines: {} });
            let reads = 0;
            let current = true;
            const owner = createOwner(undefined, true, true, account, undefined, undefined, undefined, {
                isCurrent: () => current,
                onReadAccount: () => { if (++reads >= 3) { if (retireAccount) current = false;
                    else storage.setState({ settings: applySettings(account, normalizeVoiceSettingsLocalDelta({
                        voice: { ...account.voice, executionMachine: { mode: 'fixed', machineId: 'changed' } },
                    }, account)) }); } },
            });
            expect(await throughActionExecutor(owner.action).execute('settings.invoke', { anchor: 'voiceConversations.readiness' }, { surface: 'agent', authority: 'account_automation' }))
                .toMatchObject({ ok: true, result: { status: 'cancelled' } });
        }
    });
    it('reports the unselected conversation provider honestly before readiness inspection', async () => {
        const before = storage.getState();
        onTestFinished(() => storage.setState(before, true));
        const account = applySettings(settingsDefaults, normalizeVoiceSettingsLocalDelta({ voice: { ...settingsDefaults.voice, providerId: null,
            executionMachine: { mode: 'fixed' as const, machineId: 'voice-machine' } } }, settingsDefaults));
        storage.setState({ settings: account, machines: { 'voice-machine': createMachineFixture({ id: 'voice-machine', activeAt: Date.now() }) } });
        const owner = createOwner(undefined, true, true, account);
        const declarations = await owner.action({ actionId: 'settings.list', input: { pageId: 'voiceConversations' } });
        if (!('items' in declarations) || !Array.isArray(declarations.items)) throw new Error('Missing readiness declaration');
        const readiness = declarations.items.find(item => item.anchor.endsWith('.readiness'));
        if (!readiness) throw new Error('Missing readiness declaration');
        expect(await throughActionExecutor(owner.action).execute('settings.invoke', { anchor: readiness.anchor }, { surface: 'ui', authority: 'present_user' }))
            .toMatchObject({ ok: true, result: { status: 'unavailable', reason: 'provider_unselected' } });
    });
    it('reads actual diagnostics through the declared operation and refuses a different machine or missing artifact', async () => {
        const before = storage.getState();
        onTestFinished(() => { storage.setState(before, true); settingsMachineRpc.mockReset(); });
        const account = applySettings(settingsDefaults, { voiceSettingsV1: { ...settingsDefaults.voice, executionMachine: { mode: 'fixed', machineId: 'voice-machine' } } });
        storage.setState({ settings: account, machines: { 'voice-machine': createMachineFixture({ id: 'voice-machine', activeAt: Date.now() }) } });
        await installVoiceMachineFixture(storage.getState().machines);
        const owner = createOwner(undefined, true, true, account);
        const status = { ok: true, root: '/private/voice/diagnostics', settings: readVoiceDiagnosticsSettings(account.voice), artifacts: [],
            health: { captureFailure: false, cleanup: { status: 'healthy', code: null, ownedEntryCount: 0 } },
            backupPolicy: { status: 'best_effort', storage: 'private_cache', mechanism: 'cachedir_tag', automaticSync: 'not_implemented' } };
        settingsMachineRpc.mockResolvedValue(status);
        const { readVoiceDiagnosticsRuntimeStatus } = await import('@/voice/diagnostics/runtimeStatus');
        const { projectVoiceProcessingDisclosures } = await import('@/voice/settings/projectVoiceProcessingDisclosures');
        expect(await owner.action({ actionId: 'settings.invoke', input: { anchor: 'voicePrivacy.diagnosticsLocation' } }))
            .toEqual({ anchor: 'voicePrivacy.diagnosticsLocation', status: 'completed', value: {
                daemonStatus: status, clientRuntime: readVoiceDiagnosticsRuntimeStatus(), processingDisclosures: projectVoiceProcessingDisclosures(account.voice),
            } });
        expect(await owner.action({ actionId: 'settings.invoke', input: { anchor: 'voicePrivacy.diagnosticsExport', input: { kind: 'diagnostics_export', artifactId: 'missing', machineId: 'different' } } }))
            .toMatchObject({ status: 'unavailable', reason: 'execution_machine_changed' });
        expect(await owner.action({ actionId: 'settings.invoke', input: { anchor: 'voicePrivacy.diagnosticsExport', input: { kind: 'diagnostics_export', artifactId: 'missing', machineId: 'voice-machine' } } }))
            .toMatchObject({ status: 'unavailable', reason: 'diagnostics_artifact_not_found' });
        expect(settingsMachineRpc.mock.calls.every(([request]) => request.machineId === 'voice-machine' && request.method === 'daemon.voiceDiagnostics.status')).toBe(true);
        expect(owner.openedInteractions).toEqual([]);
        expect(owner.account()).toEqual(account);
    });
    it('reads current client diagnostic retry identities and selected disclosure facts without a selected execution machine', async () => {
        const before = storage.getState();
        const runtime = await import('@/voice/diagnostics/runtimeStatus');
        const { projectVoiceProcessingDisclosures } = await import('@/voice/settings/projectVoiceProcessingDisclosures');
        onTestFinished(() => { runtime.resetVoiceDiagnosticsRuntimeStatusForTests(); storage.setState(before, true); });
        runtime.publishVoiceDiagnosticsRuntimeStatus({ machineId: 'former-machine', phase: 'status_unknown' });
        const obligation = runtime.beginVoiceDiagnosticsRevocationObligation({ kind: 'machine_policy', machineId: 'former-machine' }, 'failed');
        const account = applySettings(settingsDefaults, { voiceSettingsV1: { ...settingsDefaults.voice, executionMachine: { mode: 'fixed', machineId: null } } });
        storage.setState({ settings: account, machines: {} });
        const owner = createOwner(undefined, true, true, account);
        expect(await owner.action({ actionId: 'settings.invoke', input: { anchor: 'voicePrivacy.diagnosticsLocation' } }))
            .toEqual({ anchor: 'voicePrivacy.diagnosticsLocation', status: 'completed', value: {
                daemonStatus: null, clientRuntime: runtime.readVoiceDiagnosticsRuntimeStatus(), processingDisclosures: projectVoiceProcessingDisclosures(owner.account().voice),
            } });
        expect(obligation).toMatchObject({ key: 'machine:former-machine', revision: expect.any(Number) });
        expect(await owner.action({ actionId: 'settings.set', input: { anchor: 'voicePrivacy.diagnosticsLocation', value: {} } }))
            .toMatchObject({ error: 'setting_not_bound' });
        expect(owner.openedInteractions).toEqual([]);
    });
    it('does not disclose owner facts after the captured Account retires during a read', async () => {
        let current = true;
        let reads = 0;
        const owner = createOwner(undefined, true, true, settingsDefaults, undefined, undefined, undefined, {
            isCurrent: () => current,
            onReadAccount: () => { if (++reads === 2) queueMicrotask(() => { current = false; }); },
        });
        expect(await owner.action({ actionId: 'settings.invoke', input: { anchor: 'voicePrivacy.diagnosticsLocation' } }))
            .toMatchObject({ status: 'cancelled' });
    });
    it('does not disclose diagnostics when the Account retires during the final settings reread', async () => {
        const before = storage.getState();
        onTestFinished(() => storage.setState(before, true));
        const account = applySettings(settingsDefaults, { voiceSettingsV1: { ...settingsDefaults.voice,
            executionMachine: { mode: 'fixed', machineId: null } } });
        storage.setState({ settings: account, machines: {} });
        let current = true;
        let reads = 0;
        const owner = createOwner(undefined, true, true, account, undefined, undefined, undefined, {
            isCurrent: () => current,
            onReadAccount: () => { if (++reads === 3) queueMicrotask(() => { current = false; }); },
        });
        expect(await owner.action({ actionId: 'settings.invoke', input: { anchor: 'voicePrivacy.diagnosticsLocation' } }))
            .toMatchObject({ status: 'cancelled' });
    });
    it('stops the incumbent native preview through its declaration, including late playback registration', async () => {
        const before = storage.getState();
        onTestFinished(() => storage.setState(before, true));
        const local = readLocalConversationVoiceSettings(settingsDefaults.voice);
        const account = applySettings(settingsDefaults, { voiceSettingsV1: writeLocalConversationVoiceSettings(
            { ...settingsDefaults.voice, providerId: 'local_conversation' }, { ...local,
                tts: { ...local.tts, provider: 'local_neural', localNeural: { ...local.tts.localNeural, execution: 'device', voiceId: 'af_heart' } },
            }) });
        storage.setState({ settings: account });
        const owner = createOwner({ os: 'ios', desktop: false }, true, true, account);
        expect(await owner.action({ actionId: 'settings.invoke', input: { anchor: 'voiceConversations.ttsPreviewStop' } }))
            .toEqual({ anchor: 'voiceConversations.ttsPreviewStop', status: 'completed', value: { stopped: false } });
        const { localNeuralTtsPreviewController } = await import('@/voice/settings/panels/localTts/providers/localNeural/previewLocalNeuralTts');
        onTestFinished(() => { localNeuralTtsPreviewController.stop(); });
        const attempt = localNeuralTtsPreviewController.begin('af_heart');
        const nativeStop = vi.fn();
        // The native media target is the real controller's system boundary.
        attempt.registerPlaybackStopper(nativeStop);
        expect(await owner.action({ actionId: 'settings.invoke', input: { anchor: 'voiceConversations.ttsPreviewStop' } }))
            .toEqual({ anchor: 'voiceConversations.ttsPreviewStop', status: 'completed', value: { stopped: true } });
        expect(nativeStop).toHaveBeenCalledOnce();
        expect(localNeuralTtsPreviewController.read()).toBeNull();
        expect(attempt.isCurrent()).toBe(false);
        const lateNativeStop = vi.fn();
        attempt.registerPlaybackStopper(lateNativeStop);
        expect(lateNativeStop).toHaveBeenCalledOnce();
    });
    it('keeps human recording consent and destructive confirmation while publishing declaration-owned approval defaults', async () => {
        const owner = createOwner(undefined, true);
        const before = owner.account();
        expect(await owner.action({ actionId: 'settings.invoke', input: { anchor: 'voicePrivacy.diagnosticsEnabled', input: { kind: 'diagnostics_enabled', enabled: true } } }))
            .toMatchObject({ status: 'cancelled' });
        expect(await owner.action({ actionId: 'settings.invoke', input: { anchor: 'voicePrivacy.forgetVoiceAgentMemory' } }))
            .toMatchObject({ status: 'cancelled' });
        expect(owner.account()).toBe(before);
        const policy = ActionsSettingsV1Schema.parse({ v: 1 });
        for (const [anchor, required, uiConfirmationRequired] of [
            ['voiceAdvanced.installSpeechModel', true, false], ['voiceAdvanced.removeSpeechModel', true, false],
            ['voicePrivacy.diagnosticsExport', true, false], ['voicePrivacy.forgetVoiceAgentMemory', true, false],
            ['voicePrivacy.diagnosticsLocation', false, false], ['voicePrivacy.diagnosticsRetryShutdown', false, false], ['unknown', true, true],
        ] as const) {
            const operationPolicy = resolveSettingsDeclarationOperationApprovalPolicy(anchor, before);
            expect(operationPolicy, anchor).toEqual({ requiresApproval: required, uiConfirmationRequired });
            const safety = operationPolicy.requiresApproval ? 'danger' : 'safe';
            expect(isApprovalRequiredByActionsSettings('settings.invoke', policy, { surface: 'agent', authority: 'account_automation' }, safety), anchor).toBe(required);
        }
    });
    it('does not retry a former Account diagnostics obligation after retirement during the storage read', async () => {
        const before = storage.getState();
        const runtime = await import('@/voice/diagnostics/runtimeStatus');
        const revocation = await import('@/voice/diagnostics/runtimeRevocation');
        onTestFinished(() => { storage.setState(before, true); settingsMachineRpc.mockReset(); runtime.resetVoiceDiagnosticsRuntimeStatusForTests(); revocation.resetVoiceDiagnosticsRevocationForTests(); });
        const account = applySettings(settingsDefaults, normalizeVoiceSettingsLocalDelta({ voice: { ...settingsDefaults.voice,
            executionMachine: { mode: 'fixed' as const, machineId: 'voice-machine' } } }, settingsDefaults));
        storage.setState({ settings: account, settingsScope: { serverId: 'test-home', accountId: 'test-account' },
            machines: { 'voice-machine': createMachineFixture({ id: 'voice-machine', activeAt: Date.now() }) } });
        const obligation = runtime.beginVoiceDiagnosticsRevocationObligation({ kind: 'machine_policy', machineId: 'voice-machine' }, 'failed');
        let current = true;
        let reads = 0;
        const owner = createOwner(undefined, true, true, account, undefined, undefined, undefined, {
            isCurrent: () => current,
            onReadAccount: () => { if (++reads === 2) queueMicrotask(() => queueMicrotask(() => {
                current = false;
                storage.setState({ settingsScope: { serverId: 'other-home', accountId: 'other-account' } });
            })); },
        });
        settingsMachineRpc.mockResolvedValue({ ok: true, root: '/private/voice/diagnostics', settings: readVoiceDiagnosticsSettings(account.voice), artifacts: [],
            health: { captureFailure: false, cleanup: { status: 'healthy', code: null, ownedEntryCount: 0 } },
            backupPolicy: { status: 'best_effort', storage: 'private_cache', mechanism: 'cachedir_tag', automaticSync: 'not_implemented' } });
        expect(await throughActionExecutor(owner.action).execute('settings.invoke', { anchor: 'voicePrivacy.diagnosticsRetryShutdown',
            input: { kind: 'diagnostics_revocation', key: obligation.key, revision: obligation.revision } }, { surface: 'ui', authority: 'present_user' }))
            .toEqual({ ok: true, result: { anchor: 'voicePrivacy.diagnosticsRetryShutdown', status: 'cancelled' } });
        expect(settingsMachineRpc).not.toHaveBeenCalled();
    });
    it('reads and writes run settings through the Automation record, preserving the latest sibling value', async () => {
        let record: AutomationV3Settings = { maxActiveRunsPerMachine: 4, runRetention: 'thirtyDays' };
        const owner = createOwner(undefined, true, true, settingsDefaults, undefined, undefined, {
            read: async () => ({ ...record }),
            write: async (next) => { record = next; return next; },
        });
        expect(await owner.action({ actionId: 'settings.get', input: { anchor: 'settings.workflowRuns.maxActiveRunsPerMachine' } }))
            .toEqual({ anchor: 'settings.workflowRuns.maxActiveRunsPerMachine', value: 4 });
        const list = await owner.action({ actionId: 'settings.list', input: { pageId: 'settings' } });
        expect(list).toMatchObject({ items: expect.arrayContaining([
            expect.objectContaining({ anchor: 'settings.workflowRuns.maxActiveRunsPerMachine', readable: true, writable: true }),
            expect.objectContaining({ anchor: 'settings.workflowRuns.runRetention', readable: true, writable: true }),
        ]) });
        // A different writer changed retention since the screen loaded. Set reads the owner afresh.
        record = { ...record, runRetention: 'keepForever' };
        expect(await owner.action({ actionId: 'settings.set', input: { anchor: 'settings.workflowRuns.maxActiveRunsPerMachine', value: 2 } }))
            .toEqual({ anchor: 'settings.workflowRuns.maxActiveRunsPerMachine', value: 2 });
        expect(record).toEqual({ maxActiveRunsPerMachine: 2, runRetention: 'keepForever' });
        await owner.action({ actionId: 'settings.set', input: { anchor: 'settings.workflowRuns.runRetention', value: 'thirtyDays' } });
        expect(record).toEqual({ maxActiveRunsPerMachine: 2, runRetention: 'thirtyDays' });
        for (const value of [0, 1.5, 2_147_483_648, '2']) {
            expect(await owner.action({ actionId: 'settings.set', input: { anchor: 'settings.workflowRuns.maxActiveRunsPerMachine', value } }))
                .toMatchObject({ ok: false, errorCode: 'invalid_setting_value' });
        }
        expect(await owner.action({ actionId: 'settings.set', input: { anchor: 'settings.workflowRuns.runRetention', value: 'forever' } }))
            .toMatchObject({ ok: false, errorCode: 'invalid_setting_value' });
        expect(record).toEqual({ maxActiveRunsPerMachine: 2, runRetention: 'thirtyDays' });
        expect(owner.account()).toEqual(settingsDefaults);
    });

    it('rejects offered Summary models without proven support and unknown choices without changing the scalar preference', async () => {
        const profiles = (await offeredSummaryProfiles()).filter(profile => profile.structuredOutput !== 'supported');
        expect(profiles.length).toBeGreaterThan(0);
        const owner = createOwner(undefined, true);
        for (const value of [...profiles.map(profile => profile.catalogId), 'unknown-summary-model']) {
            expect(await owner.action({ actionId: 'settings.set', input: { anchor: 'sourceControl.summaryModel', value } }))
                .toMatchObject({ ok: false, errorCode: 'setting_value_unavailable' });
            expect(owner.account()['scm.diffSummary.modelProfileOverride']).toBe('');
        }
    });
    it('refuses enabling preparation after turns when no supported Summary model is selected', async () => {
        await offeredSummaryProfiles();
        const owner = createOwner(undefined, true, true, applySettings(settingsDefaults, {
            'scm.diffSummary.modelProfileOverride': 'unavailable-model',
        }));
        expect(await owner.action({ actionId: 'settings.set', input: { anchor: 'sourceControl.prepareAfterTurn', value: true } }))
            .toMatchObject({ ok: false, errorCode: 'setting_value_unavailable' });
        expect(owner.account()['scm.diffSummary.prefetch']).toBe(false);
    });
    it('allows disabling preparation after turns after the selected model becomes unavailable', async () => {
        const owner = createOwner(undefined, true, true, applySettings(settingsDefaults, {
            'scm.diffSummary.prefetch': true, 'scm.diffSummary.modelProfileOverride': 'unavailable-model',
        }));
        expect(await owner.action({ actionId: 'settings.set', input: { anchor: 'sourceControl.prepareAfterTurn', value: false } }))
            .toEqual({ anchor: 'sourceControl.prepareAfterTurn', value: false });
        expect(owner.account()['scm.diffSummary.prefetch']).toBe(false);
    });
    it('admits a proven model through the unchanged codec and rechecks the selected model during a preparation CAS rebase', async () => {
        const value = await supportedSummaryPreference();
        const owner = createOwner(undefined, true);
        expect(await owner.action({ actionId: 'settings.set', input: { anchor: 'sourceControl.summaryModel', value } }))
            .toEqual({ anchor: 'sourceControl.summaryModel', value });
        expect(owner.account()['scm.diffSummary.modelProfileOverride']).toBe(value);
        expect(await owner.action({ actionId: 'settings.set', input: { anchor: 'sourceControl.prepareAfterTurn', value: true } }))
            .toEqual({ anchor: 'sourceControl.prepareAfterTurn', value: true });
        expect(owner.account()['scm.diffSummary.prefetch']).toBe(true);
        const rebased = createOwner(undefined, true, true, applySettings(settingsDefaults, { 'scm.diffSummary.modelProfileOverride': value }),
            undefined, current => applySettings(current, { 'scm.diffSummary.modelProfileOverride': 'retired-model' }));
        expect(await rebased.action({ actionId: 'settings.set', input: { anchor: 'sourceControl.prepareAfterTurn', value: true } }))
            .toMatchObject({ ok: false, errorCode: 'invalid_setting_value' });
        expect(rebased.account()['scm.diffSummary.prefetch']).toBe(false);
    });
    it('changes material presets, surface modes, shared blur/tint and toolbar visibility through existing settings Actions', async () => {
        const owner = createOwner({ os: 'web', desktop: true }, false, true, settingsParse({
            actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'settings.set': ['agent'] } },
        }));
        expect(await owner.action({ actionId: 'settings.set', input: { anchor: 'appearance.glassPreset', value: 'everywhere' } }))
            .toEqual({ anchor: 'appearance.glassPreset', value: 'everywhere' });
        for (const group of ['Chrome', 'Sidebar', 'Window', 'Elements', 'Floating']) {
            const anchor = `appearance.glass${group}`;
            expect(await owner.action({ actionId: 'settings.set', input: { anchor, value: 'solid' } }))
                .toEqual({ anchor, value: 'solid' });
            expect(await owner.action({ actionId: 'settings.get', input: { anchor } }))
                .toEqual({ anchor, value: 'solid' });
            expect(await owner.action({ actionId: 'settings.set', input: { anchor, value: 'glass' } }))
                .toEqual({ anchor, value: 'glass' });
        }
        await owner.action({ actionId: 'settings.set', input: { anchor: 'appearance.glassIntensity', value: 'light' } });
        expect(owner.account().glassSurfaceMaterials).toMatchObject({ chrome: { blur: 'light' },
            sidebar: { blur: 'light' }, content: { blur: 'light' }, card: { blur: 'strong' }, floating: { blur: 'strong' } });
        const executor = throughActionExecutor(owner.action, () => owner.account().actionsSettingsV1);
        const context = { surface: 'agent', authority: 'account_automation' } as const;
        expect(await executor.execute('settings.set', { anchor: 'appearance.glassTint', value: 35 }, context))
            .toEqual({ ok: true, result: { anchor: 'appearance.glassTint', value: 35 } });
        expect(owner.account().glassTintIntensity).toBe(35);
        for (const value of [-1, 101, 35.5, 'strong']) {
            expect(await executor.execute('settings.set', { anchor: 'appearance.glassTint', value }, context))
                .toMatchObject({ ok: false, errorCode: 'invalid_setting_value' });
            expect(owner.account().glassTintIntensity).toBe(35);
        }
        expect(await owner.action({ actionId: 'settings.set', input: { anchor: 'appearance.glassPreset', value: 'custom' } }))
            .toMatchObject({ errorCode: 'invalid_setting_value' });
        await owner.action({ actionId: 'settings.set', input: { anchor: 'appearance.themeToggle', value: false } });
        expect(owner.local().titleStripThemeToggleVisible).toBe(false);
    });
    it('opts into held Voice input on this device through the declared settings owner', async () => {
        const owner = createOwner(undefined, true);
        const anchor = 'voiceAdvanced.holdToTalk';
        expect(owner.local().voiceHoldToTalkEnabled).toBe(false);
        expect(await owner.action({ actionId: 'settings.set', input: { anchor, value: true } }))
            .toEqual({ anchor, value: true });
        expect(owner.local().voiceHoldToTalkEnabled).toBe(true);
        expect(owner.local().voicePresenceContainer).toBe(localSettingsDefaults.voicePresenceContainer);
        expect(owner.account()).toEqual(settingsDefaults);
        expect(await owner.action({ actionId: 'settings.set', input: { anchor, value: 'yes' } }))
            .toMatchObject({ errorCode: 'invalid_setting_value' });
        expect(owner.local().voiceHoldToTalkEnabled).toBe(true);
    });
    it.each([null, 'fixture.unknown/conversation'])('does not advertise or write a reply-language selector for unsupported service %s', async (providerId) => {
        const { voice: _derivedVoice, ...accountDefaults } = settingsDefaults;
        const initial = settingsParse({ ...accountDefaults, voiceSettingsV1: { ...settingsDefaults.voice, providerId, assistantLanguage: 'fr' } });
        const owner = createOwner(undefined, true, true, initial);
        expect(owner.account().voice).toMatchObject({ providerId, assistantLanguage: 'fr' });
        const anchor = 'voiceConversations.assistantLanguage';
        const listed = await owner.action({ actionId: 'settings.list', input: { pageId: 'voiceConversations' } });
        if (!('items' in listed) || !listed.items) throw new Error('Expected settings discovery');
        expect(listed.items.find((item) => item.anchor === anchor)).toMatchObject({ readable: false, writable: false, unavailableReason: 'not_bound' });
        expect(await owner.action({ actionId: 'settings.set', input: { anchor, value: 'de' } }))
            .toMatchObject({ ok: false, errorCode: 'setting_not_bound' });
        expect(owner.account().voice.assistantLanguage).toBe('fr');
        expect(owner.account().voice.providerId).toBe(providerId);
    });

    it('uses one coupled language declaration and canonical state without concealing an unsupported retained choice', async () => {
        const { PLUGIN_MANIFEST } = await import('../../../../../../packages/plugins/elevenlabs/src/manifest');
        const { VOICE_PROVIDER_PRESENTATIONS } = await import('../../../../../../packages/plugins/elevenlabs/src/ui/voice/entries');
        const registry = createVoiceProviderRegistry({ bundledContributions: projectBundledVoiceManifestContributions(PluginManifestV2Schema.parse(PLUGIN_MANIFEST)), bundledPresentations: VOICE_PROVIDER_PRESENTATIONS });
        const providerId = 'happier.voice.elevenlabs/realtime-elevenlabs';
        const entry = registry.get(providerId);
        if (!entry) throw new Error('Missing real coupled provider');
        const token = {};
        commitExternalVoiceProviderRegistration({ token, pluginId: entry.pluginId, localId: 'realtime-elevenlabs', providerId, descriptor: entry, adapter: null });
        onTestFinished(() => removeExternalVoiceProviderRegistration(token));
        const { voice: _derivedVoice, ...accountDefaults } = settingsDefaults;
        const initial = settingsParse({ ...accountDefaults, voiceSettingsV1: { ...settingsDefaults.voice, providerId, assistantLanguage: 'he-IL' } });
        const owner = createOwner(undefined, true, true, initial);
        expect(owner.account().voice).toMatchObject({ providerId, assistantLanguage: 'he-IL' });
        const nullEnvelope = settingsParse({ ...accountDefaults, voiceSettingsV1: { ...initial.voice,
            providers: { ...initial.voice.providers, [providerId]: { schemaVersion: entry.providerSettings?.schemaVersion, config: null } },
        } });
        expect(nullEnvelope.voice.providers[providerId]?.config).toBeNull();
        const nullOwner = createOwner(undefined, true, true, nullEnvelope);
        expect(await nullOwner.action({ actionId: 'settings.set', input: { anchor: 'voiceConversations.assistantLanguage', value: 'fr' } }))
            .toMatchObject({ errorCode: 'setting_not_bound' });
        expect(await nullOwner.action({ actionId: 'settings.get', input: { anchor: 'voiceConversations.assistantLanguage' } }))
            .toMatchObject({ errorCode: 'setting_not_bound' });
        const setting = resolveVoiceConversationLanguageSetting(initial.voice, registry);
        const anchor = setting.anchor;
        const listed = await owner.action({ actionId: 'settings.list', input: { pageId: 'voiceConversations' } });
        if (!('items' in listed) || !listed.items) throw new Error('Expected settings discovery');
        expect(listed.items.find((item) => item.anchor === anchor)).toMatchObject({ title: t(setting.titleKey), writable: true });
        expect(setting.titleKey).toBe('settingsVoice.pages.conversations.iSpeakTitle');
        const unavailableAccount = createOwner(undefined, true, false, initial);
        expect(await unavailableAccount.action({ actionId: 'settings.set', input: { anchor, value: 'fr' } })).toMatchObject({ errorCode: 'setting_not_bound' });
        expect(await owner.action({ actionId: 'settings.get', input: { anchor } })).toMatchObject({ errorCode: 'setting_value_unavailable' });
        expect(owner.account().voice.assistantLanguage).toBe('he-IL');
        expect(await owner.action({ actionId: 'settings.set', input: { anchor, value: 'he' } })).toMatchObject({ errorCode: 'invalid_setting_value' });
        expect(await owner.action({ actionId: 'settings.set', input: { anchor, value: 'PT-BR' } })).toEqual({ anchor, value: 'pt-br' });
        expect(owner.account().voice.assistantLanguage).toBe('pt-br');
        expect(await owner.action({ actionId: 'settings.get', input: { anchor } })).toEqual({ anchor, value: 'pt-br' });
        expect(await owner.action({ actionId: 'settings.set', input: { anchor, value: null } })).toEqual({ anchor, value: null });
        expect(await owner.action({ actionId: 'settings.get', input: { anchor } })).toEqual({ anchor, value: null });
        const retiredOwner = createOwner(undefined, true, true, initial, undefined, (latest) => {
            removeExternalVoiceProviderRegistration(token);
            return latest;
        });
        expect(await retiredOwner.action({ actionId: 'settings.set', input: { anchor, value: 'fr' } })).toMatchObject({ errorCode: 'invalid_setting_value' });
        expect(retiredOwner.account().voice.assistantLanguage).toBe('he-IL');
    });

    it('requires exact speech endpoint and machine consent and rejects a prepared HTTP intent on a different CAS machine', async () => {
        const beforeStorage = storage.getState();
        onTestFinished(() => storage.setState(beforeStorage, true));
        storage.setState({ settingsScope: { serverId: 'fixture-home', accountId: 'fixture-account' }, machines: {
            'machine-a': createMachineFixture({ id: 'machine-a', activeAt: 0 }),
            'machine-b': createMachineFixture({ id: 'machine-b', activeAt: 0 }),
        } });
        await installVoiceMachineFixture(storage.getState().machines);
        const providerId = 'happier.voice.openai-compat/stt';
        const entry = voiceSettingsDeclarationRegistry.get(providerId);
        const descriptor = entry?.providerSettings;
        if (!entry || !descriptor) throw new Error('missing real speech settings owner');
        const voice = { ...writeVoiceProviderSettingsConfig(settingsDefaults.voice, providerId, descriptor.defaultConfig),
            executionMachine: { mode: 'fixed' as const, machineId: 'machine-a' },
        };
        const owner = createOwner(undefined, true, true, applySettings(settingsDefaults, { voiceSettingsV1: voice }));
        const anchor = `voiceDictation.provider.${providerId}.baseUrl`;
        const initial = owner.account().voice;
        humanConfirmation.confirm.mockResolvedValueOnce(false);
        expect(await owner.action({ actionId: 'settings.set', input: { anchor, value: 'http://localhost:11434/v1' } }))
            .toMatchObject({ errorCode: 'setting_value_unavailable' });
        expect(owner.account().voice).toEqual(initial);
        humanConfirmation.confirm.mockResolvedValueOnce(true);
        expect(await owner.action({ actionId: 'settings.set', input: { anchor, value: 'http://localhost:11434/v1' } }))
            .toMatchObject({ anchor });
        expect(owner.account().voice.providers[providerId]?.config).toMatchObject({
            baseUrl: 'http://localhost:11434/v1', insecureLocalOriginConsent: 'http://localhost:11434', insecureLocalConsentMachineId: 'machine-a',
        });
        humanConfirmation.confirm.mockResolvedValueOnce(true);
        const intent = await prepareSpeechEndpointSettingChange({ entry, settings: owner.account(), value: 'http://localhost:11435/v1', isCurrent: () => true });
        if (!intent) throw new Error('expected confirmed endpoint intent');
        const latest = applySettings(owner.account(), { voiceSettingsV1: { ...owner.account().voice,
            executionMachine: { mode: 'fixed', machineId: 'machine-b' },
        } });
        expect(intent(latest)).toBeNull();
    });
    it('normalizes declared speech endpoint writes and clears consent for HTTPS without losing neighboring config', async () => {
        storage.setState({ settingsScope: { serverId: 'fixture-home', accountId: 'fixture-account' } });
        const providerId = 'happier.voice.openai-compat/stt';
        const descriptor = voiceSettingsDeclarationRegistry.get(providerId)?.providerSettings;
        if (!descriptor) throw new Error('missing real speech settings owner');
        const voice = writeVoiceProviderSettingsConfig(settingsDefaults.voice, providerId, {
            ...descriptor.defaultConfig, baseUrl: 'http://old.example:11434/v1',
            insecureLocalOriginConsent: 'http://old.example:11434', insecureLocalConsentMachineId: 'old-machine', model: 'retained-model',
        });
        const owner = createOwner(undefined, true, true, applySettings(settingsDefaults, { voiceSettingsV1: voice }));
        const anchor = `voiceDictation.provider.${providerId}.baseUrl`;
        expect(await owner.action({ actionId: 'settings.set', input: { anchor, value: '  HTTPS://speech.example:443/v1/  ' } }))
            .toMatchObject({ anchor });
        expect(owner.account().voice.providers[providerId]?.config).toMatchObject({
            baseUrl: 'https://speech.example/v1/', insecureLocalOriginConsent: '', insecureLocalConsentMachineId: '', model: 'retained-model',
        });
        expect(await owner.action({ actionId: 'settings.set', input: { anchor, value: 'https://speech.example/v1?secret=query' } }))
            .toMatchObject({ errorCode: 'setting_value_unavailable' });
        expect(owner.account().voice.providers[providerId]?.config).toMatchObject({ baseUrl: 'https://speech.example/v1/' });
    });
    it('declares the saved credential reference operation and refuses missing input without reading or writing secrets', async () => {
        const owner = createOwner(undefined, true);
        const anchor = 'voiceConversations.provider.happier.voice.openai/realtime-openai.credential';
        const before = owner.account();
        expect(await owner.action({ actionId: 'settings.list', input: { pageId: 'voiceConversations' } }))
            .toMatchObject({ items: expect.arrayContaining([expect.objectContaining({
                anchor, sensitive: true, readable: false, writable: false,
                operation: { actionId: 'settings.invoke', requiresHumanInteraction: false, requiresApproval: true },
            })]) });
        expect(await owner.action({ actionId: 'settings.invoke', input: { anchor } }))
            .toEqual({ anchor, status: 'unavailable', reason: 'operation_input_required' });
        expect(owner.openedInteractions).toEqual([]);
        expect(owner.account()).toBe(before);
        expect(await owner.action({ actionId: 'settings.get', input: { anchor } })).toMatchObject({ errorCode: 'setting_sensitive' });
        expect(await owner.action({ actionId: 'settings.set', input: { anchor, value: 'must-not-be-saved' } }))
            .toMatchObject({ errorCode: 'setting_sensitive' });
        expect(owner.account()).toBe(before);
    });
    it('requests real human opt-in for the exact contributed moving-alias mutation', async () => {
        storage.setState({ settingsScope: { serverId: 'fixture-home', accountId: 'fixture-account' } });
        const owner = createOwner(undefined, true);
        const anchor = 'voiceConversations.provider.happier.voice.xai/realtime-grok.model';
        const before = owner.account().voice;
        humanConfirmation.confirm.mockResolvedValueOnce(false);
        expect(await owner.action({ actionId: 'settings.set', input: {
            anchor, value: JSON.stringify({ kind: 'moving_alias', id: 'grok-voice-latest' }),
        } })).toMatchObject({ ok: false, errorCode: 'setting_value_unavailable' });
        expect(humanConfirmation.confirm).toHaveBeenCalled();
        expect(owner.account().voice).toEqual(before);
        humanConfirmation.confirm.mockResolvedValueOnce(true);
        expect(await owner.action({ actionId: 'settings.set', input: {
            anchor, value: JSON.stringify({ kind: 'moving_alias', id: 'grok-voice-latest' }),
        } })).toMatchObject({ anchor });
        expect(owner.account().voice.providers['happier.voice.xai/realtime-grok']?.config).toMatchObject({ model: { kind: 'moving_alias', id: 'grok-voice-latest' } });
    });
    it('edits the rendered neural speech speed without switching the conversation service', async () => {
        const owner = createOwner(undefined, true);
        expect(await owner.action({ actionId: 'settings.set', input: { anchor: 'voiceConversations.ttsSpeed', value: 0.8 } }))
            .toEqual({ anchor: 'voiceConversations.ttsSpeed', value: 0.8 });
        expect(owner.account().voice.providers.local_conversation?.config).toMatchObject({ tts: { localNeural: { speed: 0.8 } } });
        expect(owner.account().voice.providerId).toBe(settingsDefaults.voice.providerId);
        expect(await owner.action({ actionId: 'settings.set', input: { anchor: 'voiceConversations.ttsSpeed', value: 3 } }))
            .toMatchObject({ ok: false, errorCode: 'invalid_setting_value' });
    });
    it('changes the Voice computer as one choice, retaining neighboring preferences', async () => {
        const owner = createOwner(undefined, true);
        expect(await owner.action({ actionId: 'settings.set', input: { anchor: 'voiceAdvanced.executionMachine', value: 'machine-a' } })).toEqual({ anchor: 'voiceAdvanced.executionMachine', value: 'machine-a' });
        expect(owner.account().voice.executionMachine).toMatchObject({ mode: 'fixed', machineId: 'machine-a' });
        expect(await owner.action({ actionId: 'settings.set', input: { anchor: 'voiceAdvanced.executionMachine', value: 'auto' } })).toEqual({ anchor: 'voiceAdvanced.executionMachine', value: 'auto' });
        expect(owner.account().voice.executionMachine).toEqual({ mode: 'auto', machineId: null });
        expect(owner.account().voice.assistantLanguage).toBeNull();
    });
    it('selects a Voice Agent with its catalog routing facts, never a raw-id-only write', async () => {
        const owner = createOwner(undefined, true);
        expect(await owner.action({ actionId: 'settings.set', input: { anchor: 'voiceConversations.agent', value: 'codex' } })).toEqual({ anchor: 'voiceConversations.agent', value: 'codex' });
        expect(owner.account().voice.providers.local_conversation?.config).toMatchObject({ agent: {
            agentId: 'codex', agentTargetKey: expect.any(String), agentIdentity: null,
        } });
        expect(readLocalConversationVoiceSettings(owner.account().voice).agent).not.toHaveProperty('agentProjectionGeneration');
    });
    it('discovers an admitted contribution field before selection and writes only its declared strict config', async () => {
        const pluginId = 'fixture.voice';
        const providerId = `${pluginId}/speech`;
        const declaration = VoiceProviderContributionSchema.parse({
            id: 'speech', title: 'Fixture speech', kind: 'speech', roles: ['dictation_stt'], platforms: ['web'],
            settings: { schemaVersion: 2, fields: [{
                id: 'model', title: 'Fixture model', schema: { type: 'string', minLength: 1, maxLength: 128 },
                default: 'small', presentation: { control: 'text' },
            }] },
        });
        const registry = createVoiceProviderRegistry({ bundledContributions: [{ pluginId, providerId, declaration }], bundledPresentations: [{ providerId, settingsSectionId: 'fixture.speech', createSettingsSpec: () => null }] });
        const token = {};
        commitExternalVoiceProviderRegistration({ token, pluginId, localId: 'speech', providerId, descriptor: registry.get(providerId), adapter: null });
        try {
            const owner = createOwner(undefined, true);
            const anchor = `voiceDictation.provider.${providerId}.model`;
            expect(await owner.action({ actionId: 'settings.list', input: { pageId: 'voiceDictation' } }))
                .toMatchObject({ items: expect.arrayContaining([expect.objectContaining({ anchor, title: 'Fixture model', writable: true })]) });
            expect(await owner.action({ actionId: 'settings.set', input: { anchor, value: 'large' } })).toEqual({ anchor, value: 'large' });
            expect(owner.account().voice.providers[providerId]).toMatchObject({ schemaVersion: 2, config: { model: 'large' } });
            expect(owner.account().voice.dictation.stt.provider).toBe('device');
            expect(await owner.action({ actionId: 'settings.set', input: { anchor: 'voiceDictation.provider', value: providerId } }))
                .toEqual({ anchor: 'voiceDictation.provider', value: providerId });
            expect(owner.account().voice.dictation).toMatchObject({ sttBinding: 'explicit', stt: { provider: providerId } });
            expect(await owner.action({ actionId: 'settings.set', input: { anchor: 'voiceDictation.provider', value: 'same_as_local' } }))
                .toEqual({ anchor: 'voiceDictation.provider', value: 'same_as_local' });
            expect(owner.account().voice.dictation.sttBinding).toBe('same_as_local');
            expect(await owner.action({ actionId: 'settings.set', input: { anchor, value: 5 } })).toMatchObject({ ok: false, errorCode: 'invalid_setting_value' });
            expect(await owner.action({ actionId: 'settings.set', input: { anchor, value: { model: 'other' } } })).toMatchObject({ ok: false, errorCode: 'invalid_setting_value' });
            expect(owner.account().voice.providers[providerId]).toMatchObject({ schemaVersion: 2, config: { model: 'large' } });
            expect(await owner.action({ actionId: 'settings.set', input: { anchor: `voiceDictation.provider.${providerId}.__proto__`, value: 'no' } })).toMatchObject({ ok: false, errorCode: 'setting_not_found' });
        } finally {
            removeExternalVoiceProviderRegistration(token);
        }
    });
    it('mutates nested Voice fields with strict owner schemas and preserves neighboring preferences', async () => {
        const owner = createOwner(undefined, true);
        expect(await owner.action({ actionId: 'settings.set', input: { anchor: 'voicePrivacy.shareRecentMessages', value: false } }))
            .toEqual({ anchor: 'voicePrivacy.shareRecentMessages', value: false });
        expect(await owner.action({ actionId: 'settings.set', input: { anchor: 'voicePrivacy.recentMessagesCount', value: 7 } }))
            .toEqual({ anchor: 'voicePrivacy.recentMessagesCount', value: 7 });
        expect(owner.account().voice.privacy).toMatchObject({ shareRecentMessages: false, recentMessagesCount: 7, shareToolNames: true });
        for (const value of [-1, 1.5, '7']) {
            expect(await owner.action({ actionId: 'settings.set', input: { anchor: 'voicePrivacy.recentMessagesCount', value } }))
                .toMatchObject({ ok: false, errorCode: 'invalid_setting_value' });
        }
        expect(owner.account().voice.privacy.recentMessagesCount).toBe(7);
        expect(await owner.action({ actionId: 'settings.get', input: { anchor: 'voicePrivacy.recentMessagesCount' } }))
            .toEqual({ anchor: 'voicePrivacy.recentMessagesCount', value: 7 });
    });

    it('changes Greeting as one domain choice rather than independently drifting enabled and mode', async () => {
        const owner = createOwner(undefined, true);
        const discovered = await owner.action({ actionId: 'settings.list', input: { pageId: 'voiceConversations' } });
        expect(discovered).toMatchObject({ items: expect.arrayContaining([expect.objectContaining({ anchor: 'voiceConversations.greeting' })]) });
        expect(discovered).not.toMatchObject({ items: expect.arrayContaining([expect.objectContaining({ anchor: expect.stringMatching(/\.welcome$/) })]) });
        expect(await owner.action({ actionId: 'settings.set', input: { anchor: 'voiceConversations.greeting', value: 'on_first_turn' } }))
            .toEqual({ anchor: 'voiceConversations.greeting', value: 'on_first_turn' });
        expect(owner.account().voice.welcome).toMatchObject({ enabled: true, mode: 'on_first_turn' });
        expect(await owner.action({ actionId: 'settings.set', input: { anchor: 'voiceConversations.greeting', value: 'off' } }))
            .toEqual({ anchor: 'voiceConversations.greeting', value: 'off' });
        expect(owner.account().voice.welcome.enabled).toBe(false);
    });
    it('discovers stored, read-only and navigation rows without values or invented write support', async () => {
        const owner = createOwner();
        const result = await owner.action({ actionId: 'settings.list', input: { pageId: 'appearance' } });
        expect(result).toMatchObject({ items: expect.arrayContaining([
            expect.objectContaining({ anchor: 'appearance.density', storageScope: 'local', readable: true, writable: true }),
            expect.objectContaining({ anchor: 'appearance.textSize', readable: true, writable: true, allowedValues: Object.values(UI_FONT_SCALE_PRESETS) }),
            expect.objectContaining({ anchor: 'appearance.themes', readable: false, writable: false, unavailableReason: 'not_bound' }),
        ]) });
        expect(JSON.stringify(result)).not.toContain('"value":');
        expect(await owner.action({ actionId: 'settings.set', input: { anchor: 'appearance.themes', value: 'dark' } }))
            .toMatchObject({ ok: false, errorCode: 'setting_not_bound' });
        expect(await owner.action({ actionId: 'settings.set', input: { anchor: 'language.appLanguage', value: 'fr' } }))
            .toEqual({ anchor: 'language.appLanguage', value: 'fr' });
        expect(owner.account().preferredLanguage).toBe('fr');
        expect(await owner.action({ actionId: 'settings.set', input: { anchor: 'language.appLanguage', value: 'unsupported-language' } }))
            .toMatchObject({ ok: false, errorCode: 'invalid_setting_value' });
        expect(owner.account().preferredLanguage).toBe('fr');
        expect(await owner.action({ actionId: 'settings.get', input: { anchor: 'accountSecurity.recoveryKey' } }))
            .toMatchObject({ ok: false, errorCode: 'setting_sensitive' });
        expect(await owner.action({ actionId: 'settings.list', input: { pageId: 'accountSecurity' } }))
            .toMatchObject({ items: expect.arrayContaining([
                expect.objectContaining({ anchor: 'accountSecurity.recoveryKey', sensitive: true, readable: false, writable: false }),
            ]) });
    });

    it('switches All machines between List and Grid on this device through its declared local setting', async () => {
        const owner = createOwner();
        expect(await owner.action({ actionId: 'settings.get', input: { anchor: 'machines.indexView' } }))
            .toEqual({ anchor: 'machines.indexView', value: 'list' });
        expect(await owner.action({ actionId: 'settings.set', input: { anchor: 'machines.indexView', value: 'grid' } }))
            .toEqual({ anchor: 'machines.indexView', value: 'grid' });
        expect(owner.local().machinesIndexViewV1).toBe('grid');
        expect(await owner.action({ actionId: 'settings.set', input: { anchor: 'machines.indexView', value: 'board' } }))
            .toMatchObject({ ok: false, errorCode: 'invalid_setting_value' });
        expect(owner.local().machinesIndexViewV1).toBe('grid');
    });

    it('discovers and remembers Storage shape and sort for one qualified machine without replacing its peers', async () => {
        const owner = createOwner();
        const anchor = 'machines.storage.view';
        const key = 'home-a\u0000machine';
        const peer = 'home-b\u0000machine';
        const defaults = { shape: 'list', sort: { by: 'size', direction: 'desc' } };
        expect(await owner.action({ actionId: 'settings.list', input: { pageId: 'machines' } }))
            .toMatchObject({ items: expect.arrayContaining([expect.objectContaining({ anchor, storageScope: 'local', readable: true, writable: true })]) });
        expect(await owner.action({ actionId: 'settings.get', input: { anchor, key } })).toEqual({ anchor, value: defaults });
        expect(await owner.action({ actionId: 'settings.set', input: { anchor, key: peer, value: { shape: 'rings' } } }))
            .toEqual({ anchor, value: { shape: 'rings' } });
        expect(await owner.action({ actionId: 'settings.set', input: { anchor, key, value: { shape: 'map' } } }))
            .toEqual({ anchor, value: { shape: 'map' } });
        expect(await owner.action({ actionId: 'settings.set', input: { anchor, key, value: { sort: { by: 'name', direction: 'asc' } } } }))
            .toEqual({ anchor, value: { sort: { by: 'name', direction: 'asc' } } });
        expect(await owner.action({ actionId: 'settings.get', input: { anchor, key } }))
            .toEqual({ anchor, value: { shape: 'map', sort: { by: 'name', direction: 'asc' } } });
        expect(owner.local().machineStorageViewV1[peer]).toEqual({ ...defaults, shape: 'rings' });
        expect(await owner.action({ actionId: 'settings.set', input: { anchor, key, value: { shape: 'pie' } } }))
            .toMatchObject({ ok: false, errorCode: 'invalid_setting_value' });
        expect(await owner.action({ actionId: 'settings.set', input: { anchor, key: 'machine', value: { shape: 'rings' } } }))
            .toMatchObject({ ok: false, errorCode: 'setting_key_required' });
        expect(owner.local().machineStorageViewV1[key]).toEqual({ shape: 'map', sort: { by: 'name', direction: 'asc' } });
    });

    it('changes the Machine summary style and its shown metrics on this device, keeping an empty Show (names only)', async () => {
        const owner = createOwner();
        expect(await owner.action({ actionId: 'settings.get', input: { anchor: 'appearance.machineSummaryStyle' } }))
            .toEqual({ anchor: 'appearance.machineSummaryStyle', value: 'sparklines' });
        expect(await owner.action({ actionId: 'settings.set', input: { anchor: 'appearance.machineSummaryStyle', value: 'rings' } }))
            .toEqual({ anchor: 'appearance.machineSummaryStyle', value: 'rings' });
        expect(owner.local().uiMachineSummaryStyle).toBe('rings');
        expect(await owner.action({ actionId: 'settings.set', input: { anchor: 'appearance.machineSummaryStyle', value: 'pies' } }))
            .toMatchObject({ ok: false, errorCode: 'invalid_setting_value' });
        // Known metrics once each, in canonical order; none at all is a real choice (R42.6).
        expect(await owner.action({ actionId: 'settings.set', input: { anchor: 'appearance.machineSummaryMetrics', value: ['disk', 'cpu', 'disk', 'gpu'] } }))
            .toEqual({ anchor: 'appearance.machineSummaryMetrics', value: ['cpu', 'disk'] });
        expect(owner.local().uiMachineSummaryMetrics).toEqual(['cpu', 'disk']);
        expect(await owner.action({ actionId: 'settings.set', input: { anchor: 'appearance.machineSummaryMetrics', value: [] } }))
            .toEqual({ anchor: 'appearance.machineSummaryMetrics', value: [] });
        expect(owner.local().uiMachineSummaryMetrics).toEqual([]);
    });

    it('uses the Appearance slider presets as the admitted text-size choices', async () => {
        const owner = createOwner();
        expect(await owner.action({ actionId: 'settings.set', input: { anchor: 'appearance.textSize', value: UI_FONT_SCALE_PRESETS.large } }))
            .toEqual({ anchor: 'appearance.textSize', value: UI_FONT_SCALE_PRESETS.large });
        expect(owner.local().uiFontScale).toBe(UI_FONT_SCALE_PRESETS.large);
        expect(await owner.action({ actionId: 'settings.set', input: { anchor: 'appearance.textSize', value: 99 } }))
            .toMatchObject({ ok: false, errorCode: 'invalid_setting_value' });
        expect(owner.local().uiFontScale).toBe(UI_FONT_SCALE_PRESETS.large);
    });

    it('changes every surface finish through Settings Actions and restores inheritance without changing neighboring roles', async () => {
        const owner = createOwner();
        const roles = ['Card', 'Floating', 'Composer', 'PrimaryButton', 'SecondaryButton'] as const;
        expect(await owner.action({ actionId: 'settings.get', input: { anchor: 'appearance.surfaceFinish' } })).toEqual({ anchor: 'appearance.surfaceFinish', value: 'soft' });
        for (const role of roles) {
            const anchor = `appearance.surfaceFinish${role}`;
            expect(await owner.action({ actionId: 'settings.set', input: { anchor, value: 'flat' } })).toEqual({ anchor, value: 'flat' });
        }
        expect(owner.local().uiSurfaceFinishOverrides).toEqual({ card: 'flat', floating: 'flat', composer: 'flat', primaryButton: 'flat', secondaryButton: 'flat' });
        const anchor = 'appearance.surfaceFinishCard';
        expect(await owner.action({ actionId: 'settings.set', input: { anchor, value: 'auto' } })).toEqual({ anchor, value: 'auto' });
        expect(owner.local().uiSurfaceFinishOverrides).toEqual({ floating: 'flat', composer: 'flat', primaryButton: 'flat', secondaryButton: 'flat' });
        expect(await owner.action({ actionId: 'settings.set', input: { anchor: 'appearance.surfaceFinish', value: 'flat' } })).toEqual({ anchor: 'appearance.surfaceFinish', value: 'flat' });
        expect(await owner.action({ actionId: 'settings.set', input: { anchor, value: 'glossy' } })).toMatchObject({ ok: false, errorCode: 'invalid_setting_value' });
        expect(owner.local().uiSurfaceFinish).toBe('flat');
        expect(await owner.action({ actionId: 'settings.get', input: { anchor } })).toEqual({ anchor, value: 'auto' });
    });

    it('changes and reads scalar local and Account settings through their schema and persistence owners', async () => {
        const owner = createOwner();
        expect(await owner.action({ actionId: 'settings.set', input: { anchor: 'appearance.density', value: 'compact' } }))
            .toEqual({ anchor: 'appearance.density', value: 'compact' });
        expect(owner.local().uiItemDensity).toBe('compact');
        expect(await owner.action({ actionId: 'settings.get', input: { anchor: 'appearance.density' } }))
            .toEqual({ anchor: 'appearance.density', value: 'compact' });
        expect(await owner.action({ actionId: 'settings.set', input: { anchor: 'appearance.avatarStyle', value: 'gradient' } }))
            .toEqual({ anchor: 'appearance.avatarStyle', value: 'gradient' });
        expect(owner.account().avatarStyle).toBe('gradient');
        expect(await owner.action({ actionId: 'settings.get', input: { anchor: 'appearance.avatarStyle' } }))
            .toEqual({ anchor: 'appearance.avatarStyle', value: 'gradient' });
        expect(await owner.action({ actionId: 'settings.set', input: { anchor: 'appearance.avatarStyle', value: 'not-a-style' } }))
            .toMatchObject({ ok: false, errorCode: 'invalid_setting_value' });
        expect(owner.account().avatarStyle).toBe('gradient');
        expect(await owner.action({ actionId: 'settings.set', input: { anchor: 'appearance.density', value: 'not-a-density' } }))
            .toMatchObject({ ok: false, errorCode: 'invalid_setting_value' });
        expect(owner.local().uiItemDensity).toBe('compact');
        expect(await owner.action({ actionId: 'settings.get', input: { anchor: 'unknown.key' } }))
            .toMatchObject({ ok: false, errorCode: 'setting_not_found' });
    });

    it('does not write a local preference after cancellation on a native signal without throwIfAborted', async () => {
        const owner = createOwner();
        const before = owner.local().uiItemDensity;
        const controller = new AbortController();
        // Native AbortSignal implementations need not expose the browser's convenience method.
        Object.defineProperty(controller.signal, 'throwIfAborted', { value: undefined });
        controller.abort();
        await expect(owner.action({ actionId: 'settings.set', input: { anchor: 'appearance.density', value: 'compact' }, context: { signal: controller.signal } }))
            .rejects.toMatchObject({ name: 'AbortError' });
        expect(owner.local().uiItemDensity).toBe(before);
    });

    it('does not write a Voice setting after its human opt-in is cancelled', async () => {
        storage.setState({ settingsScope: { serverId: 'fixture-home', accountId: 'fixture-account' } });
        let release!: () => void;
        let entered!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        const entering = new Promise<void>((resolve) => { entered = resolve; });
        // Consent is an external modal boundary; the declared mutation and its
        // cancellation/currentness checks remain the real Voice owners.
        humanConfirmation.confirm.mockImplementationOnce(async () => {
            entered();
            await gate;
            return true;
        });
        const owner = createOwner(undefined, true);
        const before = owner.account();
        const controller = new AbortController();
        const pending = owner.action({ actionId: 'settings.set', input: {
            anchor: 'voiceConversations.provider.happier.voice.xai/realtime-grok.model',
            value: JSON.stringify({ kind: 'moving_alias', id: 'grok-voice-latest' }),
        }, context: { signal: controller.signal } });
        void pending.catch(() => undefined);
        await entering;
        controller.abort();
        release();
        await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
        expect(owner.openedInteractions).toEqual([]);
        expect(owner.account()).toBe(before);
    });

    it('discovers and changes both Delegation defaults through Account settings', async () => {
        const owner = createOwner();
        expect(await owner.action({ actionId: 'settings.list', input: { pageId: 'delegation' } }))
            .toMatchObject({ items: expect.arrayContaining([
                expect.objectContaining({ anchor: 'delegation.workDepthLimit', storageScope: 'account', readable: true, writable: true }),
                expect.objectContaining({ anchor: 'delegation.approvalReviewerEnabled', storageScope: 'account', readable: true, writable: true }),
            ]) });
        expect(await owner.action({ actionId: 'settings.get', input: { anchor: 'delegation.workDepthLimit' } }))
            .toEqual({ anchor: 'delegation.workDepthLimit', value: 4 });
        expect(await owner.action({ actionId: 'settings.get', input: { anchor: 'delegation.approvalReviewerEnabled' } }))
            .toEqual({ anchor: 'delegation.approvalReviewerEnabled', value: false });

        for (const value of [0, 8]) {
            expect(await owner.action({ actionId: 'settings.set', input: { anchor: 'delegation.workDepthLimit', value } }))
                .toEqual({ anchor: 'delegation.workDepthLimit', value });
            expect(owner.account().workDepthLimit).toBe(value);
            expect(await owner.action({ actionId: 'settings.get', input: { anchor: 'delegation.workDepthLimit' } }))
                .toEqual({ anchor: 'delegation.workDepthLimit', value });
        }
        for (const value of [true, false]) {
            expect(await owner.action({ actionId: 'settings.set', input: { anchor: 'delegation.approvalReviewerEnabled', value } }))
                .toEqual({ anchor: 'delegation.approvalReviewerEnabled', value });
            expect(owner.account().approvalReviewerEnabled).toBe(value);
            expect(await owner.action({ actionId: 'settings.get', input: { anchor: 'delegation.approvalReviewerEnabled' } }))
                .toEqual({ anchor: 'delegation.approvalReviewerEnabled', value });
        }
        for (const value of [-1, 1.5, '4']) {
            expect(await owner.action({ actionId: 'settings.set', input: { anchor: 'delegation.workDepthLimit', value } }))
                .toMatchObject({ ok: false, errorCode: 'invalid_setting_value' });
        }
        expect(await owner.action({ actionId: 'settings.set', input: { anchor: 'delegation.approvalReviewerEnabled', value: 'true' } }))
            .toMatchObject({ ok: false, errorCode: 'invalid_setting_value' });
        expect(owner.account().workDepthLimit).toBe(8);
        expect(owner.account().approvalReviewerEnabled).toBe(false);
    });

    it('reads and writes the Personalize choices through their owners, not raw keys', async () => {
        const owner = createOwner();
        const discovered = await owner.action({ actionId: 'settings.list', input: {} });
        if (!('items' in discovered) || !discovered.items) throw new Error('Discovery failed');
        const byAnchor = new Map(discovered.items.map((item) => [item.anchor, item]));
        for (const anchor of [
            'appearance.themeMode', 'transcript.displayMode', 'session.layout', 'session.attentionPromotion', 'session.backgroundWorkAttention',
            'notifications.localEnabled', 'notifications.ready', 'notifications.readyPreview', 'notifications.requestPreview',
            'notifications.localPermissionRequests', 'notifications.localUserActions', 'notifications.foregroundBehavior',
        ]) {
            expect(byAnchor.get(anchor), anchor).toMatchObject({ readable: true, writable: true });
        }
        expect(byAnchor.get('appearance.themeMode')).toMatchObject({ storageScope: 'local', allowedValues: ['adaptive', 'light', 'dark'] });
        expect(byAnchor.get('transcript.displayMode')).toMatchObject({ storageScope: 'account', allowedValues: ['inline_summary', 'inline_full', 'tool', 'hidden'] });

        // Seed the device-storage boundary with an active custom profile: a raw key write cannot
        // repaint its canvas or change the native status bar.
        const profiles = {
            activeProfileIds: { light: null, dark: 'custom-night' },
            profiles: [{ schemaVersion: 1 as const, id: 'custom-night', name: 'Custom night',
                createdAt: '2026-10-04T00:00:00.000Z', updatedAt: '2026-10-04T00:00:00.000Z',
                base: { light: 'light' as const, dark: 'dark' as const },
                overrides: { light: {}, dark: { 'background.canvas': '#123456' } } }],
        };
        owner.local().themeProfiles = profiles;
        themeRuntime.setTheme.mockClear();
        themeRuntime.updateTheme.mockClear();
        themeRuntime.setRootViewBackgroundColor.mockClear();
        themeRuntime.setStatusBarStyle.mockClear();
        expect(await owner.action({ actionId: 'settings.set', input: { anchor: 'appearance.themeMode', value: 'dark' } }))
            .toEqual({ anchor: 'appearance.themeMode', value: 'dark' });
        expect(owner.local().themePreference).toBe('dark');
        expect(owner.local().themeProfiles).toEqual(profiles);
        expect(themeRuntime.setTheme).toHaveBeenLastCalledWith('dark');
        const updateDarkTheme = themeRuntime.updateTheme.mock.calls.filter(([name]) => name === 'dark').at(-1)?.[1];
        expect(updateDarkTheme?.(darkTheme).colors.background.canvas).toBe('#123456');
        // Web roots consume the registered theme; an imperative write would race that mounted owner.
        expect(themeRuntime.setRootViewBackgroundColor).not.toHaveBeenCalled();
        expect(themeRuntime.setStatusBarStyle).toHaveBeenLastCalledWith('light', true);
        expect(await owner.action({ actionId: 'settings.get', input: { anchor: 'appearance.themeMode' } }))
            .toEqual({ anchor: 'appearance.themeMode', value: 'dark' });
        expect(await owner.action({ actionId: 'settings.set', input: { anchor: 'appearance.themeMode', value: 'blue' } }))
            .toMatchObject({ ok: false, errorCode: 'invalid_setting_value' });

        // Thinking: one choice over two Account fields, written together.
        expect(await owner.action({ actionId: 'settings.set', input: { anchor: 'transcript.displayMode', value: 'inline_full' } }))
            .toEqual({ anchor: 'transcript.displayMode', value: 'inline_full' });
        expect(owner.account()).toMatchObject({ sessionThinkingDisplayMode: 'inline', sessionThinkingInlinePresentation: 'full' });
        await owner.action({ actionId: 'settings.set', input: { anchor: 'transcript.displayMode', value: 'tool' } });
        expect(owner.account()).toMatchObject({ sessionThinkingDisplayMode: 'tool', sessionThinkingInlinePresentation: 'full' });
        expect(await owner.action({ actionId: 'settings.get', input: { anchor: 'transcript.displayMode' } }))
            .toEqual({ anchor: 'transcript.displayMode', value: 'tool' });

        // Session list layout: the layout owner's delta, never a raw section key.
        expect(await owner.action({ actionId: 'settings.set', input: { anchor: 'session.layout', value: 'recent_activity' } }))
            .toEqual({ anchor: 'session.layout', value: 'recent_activity' });
        expect(owner.account()).toMatchObject({ sessionListSectionModeV1: 'single', sessionListActiveGroupingV1: 'date' });
        await owner.action({ actionId: 'settings.set', input: { anchor: 'session.layout', value: 'active_inactive' } });
        expect(await owner.action({ actionId: 'settings.get', input: { anchor: 'session.layout' } }))
            .toEqual({ anchor: 'session.layout', value: 'active_inactive' });
        expect(await owner.action({ actionId: 'settings.set', input: { anchor: 'session.layout', value: 'date' } }))
            .toMatchObject({ ok: false, errorCode: 'invalid_setting_value' });

        // Attention placement in the sessions list.
        expect(await owner.action({ actionId: 'settings.set', input: { anchor: 'session.attentionPromotion', value: 'withinGroups' } }))
            .toEqual({ anchor: 'session.attentionPromotion', value: 'withinGroups' });
        expect(owner.account().sessionListAttentionPromotionModeV1).toBe('withinGroups');

        for (const value of ['keepWorkingUnread', 'showUnread', 'keepWorking']) {
            expect(await owner.action({ actionId: 'settings.set', input: { anchor: 'session.backgroundWorkAttention', value } }))
                .toEqual({ anchor: 'session.backgroundWorkAttention', value });
            expect(owner.account()).toHaveProperty('sessionListBackgroundWorkAttentionModeV1', value);
            expect(await owner.action({ actionId: 'settings.get', input: { anchor: 'session.backgroundWorkAttention' } }))
                .toEqual({ anchor: 'session.backgroundWorkAttention', value });
        }

        // This device's notifications keep every sibling field of their nested record.
        const before = owner.local().attentionDeviceOverridesV1;
        expect(await owner.action({ actionId: 'settings.set', input: { anchor: 'notifications.ready', value: false } }))
            .toEqual({ anchor: 'notifications.ready', value: false });
        expect(await owner.action({ actionId: 'settings.set', input: { anchor: 'notifications.readyPreview', value: false } }))
            .toEqual({ anchor: 'notifications.readyPreview', value: false });
        expect(await owner.action({ actionId: 'settings.set', input: { anchor: 'notifications.foregroundBehavior', value: 'silent' } }))
            .toEqual({ anchor: 'notifications.foregroundBehavior', value: 'silent' });
        expect(owner.local().attentionDeviceOverridesV1).toEqual({
            ...before,
            foregroundBehavior: 'silent',
            localNotifications: {
                ...before.localNotifications,
                previewBehavior: 'status_only',
                events: { ...before.localNotifications.events, ready: false },
            },
        });
        expect(await owner.action({ actionId: 'settings.get', input: { anchor: 'notifications.ready' } }))
            .toEqual({ anchor: 'notifications.ready', value: false });
        expect(await owner.action({ actionId: 'settings.set', input: { anchor: 'notifications.ready', value: 'no' } }))
            .toMatchObject({ ok: false, errorCode: 'invalid_setting_value' });
    });

    it('admits direct scalar preferences across the remaining declared settings pages', async () => {
        const owner = createOwner(undefined, true);
        const writes = [
            ['session.composer.nonSteerablePrompt', 'off', 'sessionNonSteerableSendPrompt'],
            ['transcript.selectionEnabled', true, 'transcriptMessageSelectionEnabled'],
            ['transcript.advanced.autoFollow', false, 'transcriptScrollAutoFollowWhenPinned'],
            ['sourceControl.showLineNumbersInDiffs', true, 'showLineNumbers'],
            ['attachments.writeIgnoreRules', false, 'attachmentsUploadsVcsIgnoreWritesEnabled'],
        ] as const;
        for (const [anchor, value, key] of writes) {
            expect(await owner.action({ actionId: 'settings.set', input: { anchor, value } })).toEqual({ anchor, value });
            expect(owner.account()[key]).toBe(value);
        }
    });

    it.each([{ os: 'web', desktop: true }, { os: 'ios', desktop: false }] as const)('round-trips admitted scalar declarations on $os through the canonical schemas', async (host) => {
            // Other declared owners (for example Voice endpoint configuration)
            // still use their existing host trust boundary in this broad fixture.
            humanConfirmation.confirm.mockResolvedValue(true);
            onTestFinished(() => { humanConfirmation.confirm.mockResolvedValue(false); });
            // Desktop setting commits reach the native window, which is the only substituted boundary.
            const invoke = vi.spyOn(desktopHostBoundary, 'invokeDesktopHost').mockResolvedValue(undefined);
            onTestFinished(() => invoke.mockRestore());
            const value = await supportedSummaryPreference();
            // Voice preparation also needs the Account identity of this settings fixture.
            storage.setState({ settingsScope: (await readSummaryCatalogAccount()).accountLifetime.scope });
            const owner = createOwner(host, true, true, applySettings(settingsDefaults, {
                'scm.diffSummary.modelProfileOverride': value,
            }));
            const discovered = await owner.action({ actionId: 'settings.list', input: {} });
            if (!('items' in discovered) || !discovered.items) throw new Error('Discovery failed');
            for (const item of discovered.items.filter((item) => item.writable)) {
                // Earlier Notification controls can retire the mounted Sync Account.
                // Give sharing its real Account inventory at its own read/write boundary.
                const disposeSharing = item.anchor === 'connectedServicesAgentSignIn.sharingState'
                    ? await admitSettingsSharingCatalog() : null;
                try {
                    const current = await owner.action({ actionId: 'settings.get', input: { anchor: item.anchor } });
                    if ('errorCode' in current && current.errorCode === 'setting_key_required') continue;
                    // A native service fact is discoverable, but this scalar fixture has no service inventory.
                    if (item.anchor === 'desktop.startOnLogin' && 'errorCode' in current) {
                        expect(current).toMatchObject({ ok: false, errorCode: 'setting_value_unavailable' });
                        continue;
                    }
                    if ('unset' in current) {
                        expect(current).toEqual({ anchor: item.anchor, unset: true });
                        continue;
                    }
                    if (!('value' in current)) throw new Error(`${item.anchor}: ${'errorCode' in current ? current.errorCode : 'Missing value'}`);
                    // Compound owners expose a read projection, not necessarily their
                    // write intent. Their keyed/CAS contracts have dedicated owner tests.
                    if (current.value !== null && typeof current.value === 'object') continue;
                    expect(await owner.action({ actionId: 'settings.set', input: current })).toEqual(current);
                } finally {
                    disposeSharing?.();
                }
            }
    });

    it('preserves the logical meaning of Account privacy switches and denies unavailable hosts', async () => {
        const owner = createOwner();
        expect(await owner.action({ actionId: 'settings.set', input: { anchor: 'account.analytics', value: false } }))
            .toEqual({ anchor: 'account.analytics', value: false });
        expect(owner.account().analyticsOptOut).toBe(true);
        expect(await owner.action({ actionId: 'settings.get', input: { anchor: 'account.analytics' } }))
            .toEqual({ anchor: 'account.analytics', value: false });
        expect(await owner.action({ actionId: 'settings.set', input: { anchor: 'desktop.enabled', value: true } }))
            .toMatchObject({ ok: false, errorCode: 'setting_unsupported_host' });
    });

    it('preserves SCM-write row admission before reading or writing a declared preference', async () => {
        const owner = createOwner();
        const before = owner.account().showLineNumbers;
        expect(await owner.action({ actionId: 'settings.list', input: { pageId: 'sourceControl' } }))
            .toMatchObject({ items: expect.arrayContaining([
                expect.objectContaining({ anchor: 'sourceControl.showLineNumbersInDiffs', readable: false, writable: false, unavailableReason: 'feature_disabled' }),
            ]) });
        expect(await owner.action({ actionId: 'settings.get', input: { anchor: 'sourceControl.showLineNumbersInDiffs' } }))
            .toMatchObject({ ok: false, errorCode: 'setting_feature_disabled' });
        expect(await owner.action({ actionId: 'settings.set', input: { anchor: 'sourceControl.showLineNumbersInDiffs', value: !before } }))
            .toMatchObject({ ok: false, errorCode: 'setting_feature_disabled' });
        expect(owner.account().showLineNumbers).toBe(before);
    });
});
