import { describe, expect, it, onTestFinished, vi } from 'vitest';

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
        setRootViewBackgroundColor: themeRuntime.setRootViewBackgroundColor,
    } });
});

import { settingsDefaults, applySettings, settingsParse, type Settings } from '@/sync/domains/settings/settings';
import { localSettingsDefaults, applyLocalSettings } from '@/sync/domains/settings/localSettings';
import { createSettingsDeclarationAction, resolveSettingsDeclarationOperationApprovalRequired } from './settingsDeclarationAction';
import { UI_FONT_SCALE_PRESETS } from '@/components/ui/text/uiFontScale';
import { readSettingsPageGate } from '@/components/settings/catalog/pageCatalog';
import { ActionsSettingsV1Schema, createActionExecutor, FeaturesResponseSchema, getModelPackCatalogEntry, isApprovalRequiredByActionsSettings, VoiceProviderContributionSchema, type AutomationV3Settings } from '@happier-dev/protocol';
import { createVoiceProviderRegistry } from '@/voice/registry/providerRegistry';
import { commitExternalVoiceProviderRegistration, removeExternalVoiceProviderRegistration } from '@/voice/registry/externalVoiceProviderRegistrations';
import { getResolvedAgentCatalogEntries } from '@/agents/backendCatalog/agentCatalogProjection';
import { getEnabledAgentIds } from '@/agents/catalog/enabled';
import { readVoiceDiagnosticsSettings, writeVoiceProviderSettingsConfig } from '@/sync/domains/settings/voiceSettings';
import { normalizeVoiceSettingsLocalDelta } from '@/sync/domains/settings/voiceSettingsPersistence';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { projectBundledVoiceManifestContributions } from '@/voice/registry/bundledVoiceManifestProjection';
import { resolveVoiceConversationLanguageSetting } from '@/voice/settings/voiceSettingsDeclarations';
import { t } from '@/text';
import { buildScmDiffSummaryModelProfiles } from '@/settings/scmDiffSummary/models';
import { getAgentCore, getAgentStaticModels } from '@happier-dev/agents';
import { readBackendTargetRefV2 } from '@happier-dev/protocol';
import { getResolvedBackendCatalogEntries } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { createScmDiffSummarySettingsCatalogReader } from './scmDiffSummarySettingsCatalog';

// Preload the real scope/consent owners after the declaration graph is initialized.
const { storage } = await import('@/sync/domains/state/storage');
await import('@/voice/settings/panels/realtime/confirmRealtimeProviderSettingChange');
const { voiceSettingsDeclarationRegistry } = await import('@/voice/settings/voiceContributedSettingsDeclarations');
const { prepareSpeechEndpointSettingChange } = await import('@/voice/settings/panels/bundledSpeech/prepareEndpointSettingChange');

function throughActionExecutor(settingsDeclarationAction: ReturnType<typeof createSettingsDeclarationAction>) {
    // These unrelated outward ports must remain unused; Protocol admission and the declaration owner stay real.
    const unusedTransport = async () => { throw new Error('unexpected_unrelated_transport'); };
    return createActionExecutor({ settingsDeclarationAction,
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
    lifetime?: Readonly<{ isCurrent(): boolean; onReadAccount?(): void }>) {
    let account = { ...initialAccount };
    let local = { ...localSettingsDefaults };
    const openedInteractions: string[] = [];
    const readScmDiffSummaryCatalog = createScmDiffSummarySettingsCatalogReader({
        serverId: 'test-home',
        accountLifetime: { scope: { serverId: 'test-home', accountId: 'test-account' },
            isCurrent: () => true, onRetire: () => ({ dispose() {} }) },
        assertCurrent() {}, readLiveSettings: () => account,
    });
    // These ports substitute only the persisted Account and device storage boundaries.
    const action = createSettingsDeclarationAction({
        host,
        tauriDesktop: host.desktop,
        readPageGate: readSettingsPageGate,
        isFeatureEnabled: async () => featuresEnabled,
        canUseRuntimeContributions: () => runtimeContributions,
        isCurrent: lifetime?.isCurrent,
        openHumanInteraction: navigation ?? (async (href) => { openedInteractions.push(href); return true; }),
        mutationServices: { readScmDiffSummaryCatalog, readAgentCatalog: async (settings) => ({
            entries: getResolvedAgentCatalogEntries({
                enabledAgentIds: getEnabledAgentIds({ backendEnabledByTargetKey: settings.backendEnabledByTargetKey }),
                backendEnabledByTargetKey: settings.backendEnabledByTargetKey,
                acpCatalogSettingsV1: settings.acpCatalogSettingsV1,
            }),
            isCurrent: () => true,
        }) },
        readAccountSettings: async () => { lifetime?.onReadAccount?.(); return account; },
        writeAccountSettings: async (delta) => { account = applySettings(account, delta); },
        mutateAccountSettings: async (mutate) => { account = settingsParse(mutate(rebase ? rebase(account) : account)); },
        readLocalSettings: () => local,
        writeLocalSettings: (delta) => { local = applyLocalSettings(local, delta); },
        automationSettings,
    });
    return { action, account: () => account, local: () => local, openedInteractions };
}

/** Seed only device storage; model descriptors, catalog projection and admission stay real. */
function offeredSummaryProfiles() {
    const before = storage.getState();
    onTestFinished(() => storage.setState(before, true));
    storage.setState({ settings: settingsDefaults });
    return getResolvedBackendCatalogEntries({
        enabledAgentIds: getEnabledAgentIds({ backendEnabledByTargetKey: settingsDefaults.backendEnabledByTargetKey }),
        backendEnabledByTargetKey: settingsDefaults.backendEnabledByTargetKey,
        acpCatalogSettingsV1: settingsDefaults.acpCatalogSettingsV1,
    }).flatMap(entry => buildScmDiffSummaryModelProfiles({
        backendTarget: readBackendTargetRefV2(entry.backendTarget),
        models: getAgentStaticModels(entry.agentId, { catalogOnly: true }),
        agentFormats: entry.kind === 'builtInAgent' ? getAgentCore(entry.agentId)?.structuredOutput?.formats : null,
    }));
}

function supportedSummaryPreference() {
    const profile = offeredSummaryProfiles().find(candidate => candidate.structuredOutput === 'supported');
    if (!profile) throw new Error('Expected a genuinely supported offered Summary model');
    return profile.catalogId;
}

describe('declared settings owner', () => {
    it('executes catalog Preview and Stop through the real Action front door and contribution-owned catalog', async () => {
        const before = storage.getState();
        vi.stubGlobal('navigator', { userActivation: { isActive: true } });
        onTestFinished(() => { vi.unstubAllGlobals(); });
        const { PLUGIN_MANIFEST } = await import('../../../../../../packages/plugins/elevenlabs/src/manifest');
        const { VOICE_PROVIDER_PRESENTATIONS } = await import('../../../../../../packages/plugins/elevenlabs/src/ui/voice/entries');
        const registry = createVoiceProviderRegistry({ bundledContributions: projectBundledVoiceManifestContributions(PLUGIN_MANIFEST), bundledPresentations: VOICE_PROVIDER_PRESENTATIONS });
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
        const executor = throughActionExecutor(owner.action);
        const discovered = await owner.action({ actionId: 'settings.list', input: { pageId: 'voiceConversations' } });
        if (!('items' in discovered) || !discovered.items) throw new Error('Missing operation discovery');
        const preview = discovered.items.find(item => item.anchor.includes(providerId) && item.anchor.endsWith('.preview'));
        const stop = discovered.items.find(item => item.anchor.includes(providerId) && item.anchor.endsWith('.stopPreview'));
        if (!preview || !stop) throw new Error('Missing declared catalog operations');
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
            resolveSettingsDeclarationOperationApprovalRequired(stop.anchor, account) ? 'danger' : 'safe')).toBe(false);
        await executor.execute('settings.invoke', { anchor: preview.anchor, input: { kind: 'voice_preview', voiceId: 'voice_a' } }, ctx);
        storage.setState({ settingsScope: { serverId: 'different-home', accountId: 'test-account' } });
        const { readRealtimeCatalogPreview } = await import('@/voice/settings/panels/realtime/catalogPreview');
        expect(readRealtimeCatalogPreview()).toBeNull();
        expect(owner.openedInteractions).toEqual([]);
    });
    it('executes model installation from the real Action front door through the selected daemon owner', async () => {
        const before = storage.getState();
        const { primeServerFeaturesSnapshot, resetServerFeaturesClientForTests } = await import('@/sync/api/capabilities/serverFeaturesClient');
        const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
        vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('unexpected_network_request'); }));
        onTestFinished(() => { storage.setState(before, true); settingsMachineRpc.mockReset(); resetServerFeaturesClientForTests(); vi.unstubAllGlobals(); });
        const account = applySettings(settingsDefaults, normalizeVoiceSettingsLocalDelta({ experiments: true,
            featureToggles: { voice: true, 'voice.agent': true, 'voice.daemonInference': true, 'execution.runs': true },
            voice: { ...settingsDefaults.voice, executionMachine: { mode: 'fixed' as const, machineId: 'voice-machine', autoMachineId: null } } }, settingsDefaults));
        storage.setState({ settings: account, machines: { 'voice-machine': createMachineFixture({ id: 'voice-machine', activeAt: Date.now() }) } });
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
    it('reports the unselected conversation provider honestly before readiness inspection', async () => {
        const before = storage.getState();
        onTestFinished(() => storage.setState(before, true));
        const account = applySettings(settingsDefaults, normalizeVoiceSettingsLocalDelta({ voice: { ...settingsDefaults.voice, providerId: null,
            executionMachine: { mode: 'fixed' as const, machineId: 'voice-machine', autoMachineId: null } } }, settingsDefaults));
        storage.setState({ settings: account, machines: { 'voice-machine': createMachineFixture({ id: 'voice-machine', activeAt: Date.now() }) } });
        const owner = createOwner(undefined, true, true, account);
        const declarations = await owner.action({ actionId: 'settings.list', input: { pageId: 'voiceConversations' } });
        if (!('items' in declarations) || !declarations.items) throw new Error('Missing readiness declaration');
        const readiness = declarations.items.find(item => item.anchor.endsWith('.readiness'));
        if (!readiness) throw new Error('Missing readiness declaration');
        expect(await throughActionExecutor(owner.action).execute('settings.invoke', { anchor: readiness.anchor }, { surface: 'ui', authority: 'present_user' }))
            .toMatchObject({ ok: true, result: { status: 'unavailable', reason: 'provider_unselected' } });
    });
    it('reads actual diagnostics through the declared operation and refuses a different machine or missing artifact', async () => {
        const before = storage.getState();
        onTestFinished(() => { storage.setState(before, true); settingsMachineRpc.mockReset(); });
        const account = applySettings(settingsDefaults, { voiceSettingsV1: { ...settingsDefaults.voice, executionMachine: { mode: 'fixed', machineId: 'voice-machine', autoMachineId: null } } });
        storage.setState({ settings: account, machines: { 'voice-machine': createMachineFixture({ id: 'voice-machine', activeAt: Date.now() }) } });
        const owner = createOwner(undefined, true, true, account);
        const status = { ok: true, root: '/private/voice/diagnostics', settings: readVoiceDiagnosticsSettings(account.voice), artifacts: [],
            health: { captureFailure: false, cleanup: { status: 'healthy', code: null, ownedEntryCount: 0 } },
            backupPolicy: { status: 'best_effort', storage: 'private_cache', mechanism: 'cachedir_tag', automaticSync: 'not_implemented' } };
        settingsMachineRpc.mockResolvedValue(status);
        expect(await owner.action({ actionId: 'settings.invoke', input: { anchor: 'voicePrivacy.diagnosticsLocation' } }))
            .toEqual({ anchor: 'voicePrivacy.diagnosticsLocation', status: 'completed', value: status });
        expect(await owner.action({ actionId: 'settings.invoke', input: { anchor: 'voicePrivacy.diagnosticsExport', input: { kind: 'diagnostics_export', artifactId: 'missing', machineId: 'different' } } }))
            .toMatchObject({ status: 'unavailable', reason: 'execution_machine_changed' });
        expect(await owner.action({ actionId: 'settings.invoke', input: { anchor: 'voicePrivacy.diagnosticsExport', input: { kind: 'diagnostics_export', artifactId: 'missing', machineId: 'voice-machine' } } }))
            .toMatchObject({ status: 'unavailable', reason: 'diagnostics_artifact_not_found' });
        expect(settingsMachineRpc.mock.calls.every(([request]) => request.machineId === 'voice-machine' && request.method === 'daemon.voiceDiagnostics.status')).toBe(true);
        expect(owner.openedInteractions).toEqual([]);
        expect(owner.account()).toEqual(account);
    });
    it('keeps human recording consent and destructive confirmation while publishing declaration-owned approval defaults', async () => {
        const owner = createOwner(undefined, true);
        const before = owner.account();
        expect(await owner.action({ actionId: 'settings.invoke', input: { anchor: 'voicePrivacy.diagnosticsEnabled', input: { kind: 'diagnostics_enabled', enabled: true } } }))
            .toMatchObject({ status: 'cancelled' });
        expect(await owner.action({ actionId: 'settings.invoke', input: { anchor: 'voicePrivacy.forgetVoiceAgentMemory' } }))
            .toMatchObject({ status: 'cancelled' });
        expect(owner.account()).toBe(before);
        expect(resolveSettingsDeclarationOperationApprovalRequired('voicePrivacy.diagnosticsExport', before)).toBe(true);
        expect(resolveSettingsDeclarationOperationApprovalRequired('voicePrivacy.forgetVoiceAgentMemory', before)).toBe(true);
        expect(resolveSettingsDeclarationOperationApprovalRequired('voicePrivacy.diagnosticsLocation', before)).toBe(false);
        expect(resolveSettingsDeclarationOperationApprovalRequired('voicePrivacy.diagnosticsRetryShutdown', before)).toBe(false);
        expect(resolveSettingsDeclarationOperationApprovalRequired('unknown', before)).toBe(true);
        const policy = ActionsSettingsV1Schema.parse({ v: 1 });
        for (const [anchor, required] of [
            ['voiceAdvanced.installSpeechModel', true], ['voiceAdvanced.removeSpeechModel', true],
            ['voicePrivacy.diagnosticsExport', true], ['voicePrivacy.forgetVoiceAgentMemory', true],
            ['voicePrivacy.diagnosticsLocation', false], ['voicePrivacy.diagnosticsRetryShutdown', false], ['unknown', true],
        ] as const) {
            const safety = resolveSettingsDeclarationOperationApprovalRequired(anchor, before) ? 'danger' : 'safe';
            expect(isApprovalRequiredByActionsSettings('settings.invoke', policy, { surface: 'agent', authority: 'account_automation' }, safety), anchor).toBe(required);
        }
    });
    it('does not retry a former Account diagnostics obligation after retirement during the storage read', async () => {
        const before = storage.getState();
        const runtime = await import('@/voice/diagnostics/runtimeStatus');
        const revocation = await import('@/voice/diagnostics/runtimeRevocation');
        onTestFinished(() => { storage.setState(before, true); settingsMachineRpc.mockReset(); runtime.resetVoiceDiagnosticsRuntimeStatusForTests(); revocation.resetVoiceDiagnosticsRevocationForTests(); });
        const account = applySettings(settingsDefaults, normalizeVoiceSettingsLocalDelta({ voice: { ...settingsDefaults.voice,
            executionMachine: { mode: 'fixed' as const, machineId: 'voice-machine', autoMachineId: null } } }, settingsDefaults));
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
        const profiles = offeredSummaryProfiles().filter(profile => profile.structuredOutput !== 'supported');
        expect(profiles.length).toBeGreaterThan(0);
        const owner = createOwner(undefined, true);
        for (const value of [...profiles.map(profile => profile.catalogId), 'unknown-summary-model']) {
            expect(await owner.action({ actionId: 'settings.set', input: { anchor: 'sourceControl.summaryModel', value } }))
                .toMatchObject({ ok: false, errorCode: 'setting_value_unavailable' });
            expect(owner.account()['scm.diffSummary.modelProfileOverride']).toBe('');
        }
    });
    it('refuses enabling preparation after turns when no supported Summary model is selected', async () => {
        offeredSummaryProfiles();
        const owner = createOwner(undefined, true);
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
        const value = supportedSummaryPreference();
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
    it('changes material presets, group blur/opacity and toolbar visibility through existing settings Actions', async () => {
        const owner = createOwner();
        expect(await owner.action({ actionId: 'settings.set', input: { anchor: 'appearance.glassPreset', value: 'everywhere' } }))
            .toEqual({ anchor: 'appearance.glassPreset', value: 'everywhere' });
        for (const group of ['Chrome', 'Sidebar', 'Content', 'Floating']) {
            expect(await owner.action({ actionId: 'settings.set', input: { anchor: `appearance.glass${group}Blur`, value: 'strong' } }))
                .toEqual({ anchor: `appearance.glass${group}Blur`, value: 'strong' });
            expect(await owner.action({ actionId: 'settings.set', input: { anchor: `appearance.glass${group}Opacity`, value: 0 } }))
                .toEqual({ anchor: `appearance.glass${group}Opacity`, value: 0 });
        }
        expect(owner.account().glassSurfaceMaterials).toEqual({
            chrome: { blur: 'strong', opacity: 0 }, sidebar: { blur: 'strong', opacity: 0 },
            content: { blur: 'strong', opacity: 0 }, floating: { blur: 'strong', opacity: 0 },
        });
        await owner.action({ actionId: 'settings.set', input: { anchor: 'appearance.glassIntensity', value: 'light' } });
        expect(owner.account().glassSurfaceMaterials?.content).toEqual({ blur: 'light', opacity: 0 });
        expect(owner.account().glassSurfaceMaterials?.floating).toEqual({ blur: 'light', opacity: 0 });
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
        const registry = createVoiceProviderRegistry({ bundledContributions: projectBundledVoiceManifestContributions(PLUGIN_MANIFEST), bundledPresentations: VOICE_PROVIDER_PRESENTATIONS });
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
        const providerId = 'happier.voice.openai-compat/stt';
        const entry = voiceSettingsDeclarationRegistry.get(providerId);
        const descriptor = entry?.providerSettings;
        if (!entry || !descriptor) throw new Error('missing real speech settings owner');
        const voice = { ...writeVoiceProviderSettingsConfig(settingsDefaults.voice, providerId, descriptor.defaultConfig),
            executionMachine: { mode: 'fixed' as const, machineId: 'machine-a', autoMachineId: null },
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
            executionMachine: { mode: 'fixed', machineId: 'machine-b', autoMachineId: null },
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
    it('routes a private credential operation to the incumbent human control without reading or writing secrets', async () => {
        const owner = createOwner(undefined, true);
        const anchor = 'voiceConversations.provider.happier.voice.openai/realtime-openai.credential';
        const before = owner.account();
        expect(await owner.action({ actionId: 'settings.list', input: { pageId: 'voiceConversations' } }))
            .toMatchObject({ items: expect.arrayContaining([expect.objectContaining({
                anchor, sensitive: true, readable: false, writable: false,
                operation: { actionId: 'settings.invoke', requiresHumanInteraction: true },
            })]) });
        expect(await owner.action({ actionId: 'settings.invoke', input: { anchor } }))
            .toEqual({ anchor, status: 'interaction_opened' });
        expect(owner.openedInteractions).toEqual([`/settings/voice/conversations?setting=${encodeURIComponent(anchor)}`]);
        expect(owner.account()).toBe(before);
        expect(await owner.action({ actionId: 'settings.get', input: { anchor } })).toMatchObject({ errorCode: 'setting_sensitive' });
        const unavailableOwner = createOwner(undefined, true, false);
        expect(await unavailableOwner.action({ actionId: 'settings.invoke', input: { anchor } }))
            .toMatchObject({ errorCode: 'setting_not_bound' });
        expect(unavailableOwner.openedInteractions).toEqual([]);
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
        expect(owner.account().voice.executionMachine).toEqual({ mode: 'auto', machineId: null, autoMachineId: null });
        expect(owner.account().voice.assistantLanguage).toBeNull();
    });
    it('selects a Voice Agent with its catalog routing facts, never a raw-id-only write', async () => {
        const owner = createOwner(undefined, true);
        expect(await owner.action({ actionId: 'settings.set', input: { anchor: 'voiceConversations.agent', value: 'codex' } })).toEqual({ anchor: 'voiceConversations.agent', value: 'codex' });
        expect(owner.account().voice.providers.local_conversation?.config).toMatchObject({ agent: {
            agentId: 'codex', agentTargetKey: expect.any(String), agentIdentity: null, agentProjectionGeneration: null,
        } });
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
        expect(await owner.action({ actionId: 'settings.set', input: { anchor: 'voicePrivacy.recentMessagesCount', value: 51 } }))
            .toMatchObject({ ok: false, errorCode: 'invalid_setting_value' });
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
            .toMatchObject({ ok: false, errorCode: 'setting_read_only' });
        expect(await owner.action({ actionId: 'settings.get', input: { anchor: 'accountSecurity.recoveryKey' } }))
            .toMatchObject({ ok: false, errorCode: 'setting_sensitive' });
        expect(await owner.action({ actionId: 'settings.list', input: { pageId: 'accountSecurity' } }))
            .toMatchObject({ items: expect.arrayContaining([
                expect.objectContaining({ anchor: 'accountSecurity.recoveryKey', sensitive: true, readable: false, writable: false }),
            ]) });
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

    it('does not open an incumbent human control after its invocation is cancelled', async () => {
        let release!: () => void;
        let entered!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        const entering = new Promise<void>((resolve) => { entered = resolve; });
        const opened: string[] = [];
        // The external navigation boundary delays readiness, as router module loading can.
        const owner = createOwner(undefined, true, true, settingsDefaults, async (href, signal) => {
            entered();
            await gate;
            signal?.throwIfAborted();
            opened.push(href);
            return true;
        });
        const controller = new AbortController();
        const pending = owner.action({ actionId: 'settings.invoke', input: {
            anchor: 'voiceConversations.provider.happier.voice.openai/realtime-openai.credential',
        }, context: { signal: controller.signal } });
        void pending.catch(() => undefined);
        await entering;
        controller.abort();
        release();
        await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
        expect(opened).toEqual([]);
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
            'appearance.themeMode', 'transcript.displayMode', 'session.layout', 'session.attentionPromotion',
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
        themeRuntime.setRootViewBackgroundColor.mockClear();
        themeRuntime.setStatusBarStyle.mockClear();
        expect(await owner.action({ actionId: 'settings.set', input: { anchor: 'appearance.themeMode', value: 'dark' } }))
            .toEqual({ anchor: 'appearance.themeMode', value: 'dark' });
        expect(owner.local().themePreference).toBe('dark');
        expect(owner.local().themeProfiles).toEqual(profiles);
        expect(themeRuntime.setTheme).toHaveBeenLastCalledWith('dark');
        expect(themeRuntime.setRootViewBackgroundColor).toHaveBeenLastCalledWith('#123456');
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
            const value = supportedSummaryPreference();
            const owner = createOwner(host, true, true, applySettings(settingsDefaults, {
                'scm.diffSummary.modelProfileOverride': value,
            }));
            const discovered = await owner.action({ actionId: 'settings.list', input: {} });
            if (!('items' in discovered) || !discovered.items) throw new Error('Discovery failed');
            for (const item of discovered.items.filter((item) => item.writable)) {
                const current = await owner.action({ actionId: 'settings.get', input: { anchor: item.anchor } });
                if ('unset' in current) {
                    expect(current).toEqual({ anchor: item.anchor, unset: true });
                    continue;
                }
                if (!('value' in current)) throw new Error(`${item.anchor}: ${'errorCode' in current ? current.errorCode : 'Missing value'}`);
                expect(await owner.action({ actionId: 'settings.set', input: current })).toEqual(current);
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

    it('preserves the canonical page-level feature admission before reading or writing a declared preference', async () => {
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
