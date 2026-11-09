import React from 'react';
import 'fake-indexeddb/auto';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMachineFixture, createRootLayoutFeaturesResponse, renderSettingsView, standardCleanup } from '@/dev/testkit';
import { createPlainMachineReadHttpResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { installSessionActionRpcBoundary } from '@/dev/testkit/harness/sessionActionRpcBoundary';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { createVoiceSettingsAccountTestHarness } from '@/voice/settings/panels/voiceSettingsAccountTestHarness';
import { storage } from '@/sync/domains/state/storage';
import { settingsParse } from '@/sync/domains/settings/settings';
import { getServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { t, tLoose } from '@/text';
import {
    readLocalConversationVoiceSettings, readLocalDirectVoiceSettings, readVoiceDiagnosticsSettings, voiceSettingsDefaults,
    voiceSettingsParse, writeLocalConversationVoiceSettings, writeLocalDirectVoiceSettings, type VoiceSettings,
} from '@/sync/domains/settings/voiceSettings';
import {
    DaemonVoiceInferenceModelsListResponseSchema, DaemonVoiceInferenceModelsStatusResponseSchema, type DaemonVoiceInferenceModelStatus,
} from '@happier-dev/protocol/daemon/voiceInference';
import {
    getDefaultModelPackId, getModelPackCatalogEntry, listModelPackCatalogEntries} from '@happier-dev/protocol/voice/modelPacks/catalog';
import {
    tryWriteServerEnabledBitInPlace} from '@happier-dev/protocol/features/serverEnabledBit';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { VoiceSpeechDiagnosticsStatusResponseV1Schema, resolveVoiceSpeechDiagnosticsStoragePolicy } from '@happier-dev/protocol/voice/diagnostics';

const device = vi.hoisted(() => ({ os: 'web' as 'web' | 'ios', permission: vi.fn(), start: vi.fn() }));
vi.mock('socket.io-client', async original =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
    Platform: {
        get OS() { return device.os; },
        select: (values: Record<string, unknown>) => values[device.os] ?? values.native ?? values.default ?? values.web,
    },
}));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('expo-speech-recognition', () => ({ ExpoSpeechRecognitionModule: {
    isRecognitionAvailable: () => true, requestPermissionsAsync: device.permission, start: device.start,
} }));

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const DIRECT_STT_PACK_ID = getDefaultModelPackId('stt_sherpa')!;
const DIRECT_TTS_PACK_ID = getDefaultModelPackId('tts_sherpa')!;
let statuses: DaemonVoiceInferenceModelStatus[] = [];
const requests = installSessionActionRpcBoundary(request => {
    const method = request.method.slice(request.method.indexOf(':') + 1);
    if (method === RPC_METHODS.DAEMON_VOICE_INFERENCE_MODELS_LIST) {
        return DaemonVoiceInferenceModelsListResponseSchema.parse({ ok: true, models: statuses });
    }
    if (method === RPC_METHODS.DAEMON_VOICE_INFERENCE_MODELS_STATUS) {
        return DaemonVoiceInferenceModelsStatusResponseSchema.parse({ ok: true, models: statuses });
    }
    if (method === RPC_METHODS.CAPABILITIES_DETECT) return { protocolVersion: 1, results: {} };
    if (method === RPC_METHODS.DAEMON_VOICE_DIAGNOSTICS_STATUS) {
        return VoiceSpeechDiagnosticsStatusResponseV1Schema.parse({ ok: true, root: '/voice-diagnostics',
            settings: readVoiceDiagnosticsSettings(account.settings.voice), artifacts: [],
            health: { captureFailure: false, cleanup: { status: 'healthy', code: null, ownedEntryCount: 0 } },
            backupPolicy: resolveVoiceSpeechDiagnosticsStoragePolicy('daemon_desktop'),
        });
    }
    return { error: 'unavailable' };
});
const originalState = storage.getState();
const { VoiceConversationsSettingsScreen } = await import('@/voice/settings/screens/VoiceConversationsSettingsScreen');
const { VoiceDictationSettingsScreen } = await import('@/voice/settings/screens/VoiceDictationSettingsScreen');
const { VoicePrivacySettingsScreen } = await import('@/voice/settings/screens/VoicePrivacySettingsScreen');
const { VoiceProviderSection } = await import('@/voice/settings/panels/VoiceProviderSection');
const { LocalDirectSection } = await import('@/voice/settings/panels/LocalDirectSection');
const { resolveVoiceProviderAvailability } = await import('@/voice/settings/resolveVoiceProviderAvailability');
let account: Awaited<ReturnType<typeof createVoiceSettingsAccountTestHarness>>;

function status(packId: string, installState: DaemonVoiceInferenceModelStatus['installState'] = 'installed'): DaemonVoiceInferenceModelStatus {
    const entry = getModelPackCatalogEntry(packId)!;
    return {
        packId, pluginIdentity: null, kind: entry.kind, model: entry.model, version: null,
        executionSupport: ['daemon'], runtimeFamily: entry.runtimeFamily, runtimeSupported: true,
        installState, ...(installState === 'installed' ? { runtimeState: 'ready' as const } : {}),
        progress: null, lastError: null, updatedAtMs: 0,
    };
}

function createVoice(providerId: VoiceSettings['providerId'] = 'local_direct'): VoiceSettings {
    const direct = readLocalDirectVoiceSettings(voiceSettingsDefaults);
    const conversation = readLocalConversationVoiceSettings(voiceSettingsDefaults);
    const stt = { ...direct.stt, provider: 'local_neural' as const,
        localNeural: { ...direct.stt.localNeural, assetId: DIRECT_STT_PACK_ID, execution: 'daemon' as const } };
    const tts = { ...direct.tts, provider: 'local_neural' as const,
        localNeural: { ...direct.tts.localNeural, assetId: DIRECT_TTS_PACK_ID, execution: 'daemon' as const } };
    return voiceSettingsParse({ ...writeLocalConversationVoiceSettings(
        writeLocalDirectVoiceSettings(voiceSettingsDefaults, { ...direct, stt, tts }), { ...conversation, stt, tts },
    ), providerId, executionMachine: { mode: 'fixed', machineId: 'voice-runtime-machine' } });
}

function hydrateMachines(ids: string[] = ['machine-1', 'voice-runtime-machine']) {
    storage.getState().applyMachines(ids.map(id => createMachineFixture({
        id, access: createPlainMachineRowFixture({ id, accountId: account.scope.accountId }).access,
        metadata: { ...createMachineFixture().metadata!, displayName: id === 'machine-1' ? 'Primary Mac' : 'Voice runtime' },
        daemonState: null, activeAt: Date.now(),
    })), true, { sourceServerId: account.scope.serverId });
}

async function configure(voice = createVoice(), options: { capped?: boolean; machines?: string[] } = {}) {
    account.replaceVoice(voice);
    hydrateMachines(options.machines);
    const features = createRootLayoutFeaturesResponse();
    for (const id of ['voice', 'machines', 'machines.rpc', 'machines.liveStream', 'machines.liveStream.serverRouted'] as const) {
        if (!tryWriteServerEnabledBitInPlace(features, id, true)) throw new Error(`Missing feature fixture: ${id}`);
    }
    features.capabilities.machines.liveStream.serverRouted = {
        caps: { maxBitrateBps: 96_000, maxFramesPerSecond: 50, maxFrameBytes: 16_384, maxDurationMs: 60_000,
            maxTotalBytes: 4_000_000, maxConcurrentStreamsPerAccount: 2, maxConcurrentStreamsPerSocket: 1, maxConcurrentStreamsPerMachine: 1 },
        disabledReason: options.capped ? 'cap_exceeded' : null,
    };
    const baseRequest = account.request.getMockImplementation()!;
    account.request.mockImplementation(async (url, init) => {
        const path = new URL(String(url)).pathname;
        if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(features);
        const machineResponse = createPlainMachineReadHttpResponseFixture(path, init, account.scope.accountId);
        if (machineResponse) return machineResponse;
        return baseRequest(url, init);
    });
    const snapshot = await getServerFeaturesSnapshot({ serverId: account.scope.serverId, force: true });
    expect(snapshot.status).toBe('ready');
    requests.length = 0;
    account.request.mockClear();
}

function render(screen: React.ReactElement) {
    return renderSettingsView(<InjectedAuthProvider credentials={account.credentials}>{screen}</InjectedAuthProvider>);
}
function catalogRequests() {
    return requests.filter(request => [RPC_METHODS.DAEMON_VOICE_INFERENCE_MODELS_LIST, RPC_METHODS.DAEMON_VOICE_INFERENCE_MODELS_STATUS]
        .some(method => request.method.endsWith(`:${method}`)));
}
function expectCatalogFor(machineId: string) {
    expect(catalogRequests()).toEqual(expect.arrayContaining([
        { method: `${machineId}:${RPC_METHODS.DAEMON_VOICE_INFERENCE_MODELS_LIST}`, params: {} },
        { method: `${machineId}:${RPC_METHODS.DAEMON_VOICE_INFERENCE_MODELS_STATUS}`, params: { packIds: listModelPackCatalogEntries().map(entry => entry.packId) } },
    ]));
    expect(catalogRequests().every(request => request.method.startsWith(`${machineId}:`))).toBe(true);
}
function pipeline(view: Awaited<ReturnType<typeof render>>, testID: string) {
    const card = view.findAll(node => node.props.testID === testID && Array.isArray(node.props.steps))[0];
    expect(card).toBeTruthy();
    return card!;
}

beforeEach(async () => {
    device.os = 'web'; device.permission.mockClear(); device.start.mockClear();
    statuses = [status(DIRECT_STT_PACK_ID), status(DIRECT_TTS_PACK_ID)];
    account = await createVoiceSettingsAccountTestHarness(settingsParse({
        voice: createVoice(), experiments: true,
        featureToggles: { 'voice.daemonInference': true, 'voice.agent': true, 'execution.runs': true },
    }));
});
afterEach(async () => {
    standardCleanup();
    await account.dispose();
    storage.setState(originalState, true);
});

describe('VoiceSettingsScreen local_direct daemon readiness', () => {
    it('does not activate provider, daemon catalog, or local readiness work for Privacy & data', async () => {
        await configure();
        const view = await render(<VoicePrivacySettingsScreen />);
        expect(view.findByTestId('settings.voice.section.privacy')).toBeTruthy();
        // Privacy owns a passive diagnostics-status read; it must not mount speech/catalog work.
        expect(requests.filter(request => request.method.includes('voice') || request.method.endsWith(`:${RPC_METHODS.CAPABILITIES_DETECT}`)))
            .toEqual([{ method: `voice-runtime-machine:${RPC_METHODS.DAEMON_VOICE_DIAGNOSTICS_STATUS}`, params: {} }]);
        expect(view.tree.root.findAllByType(LocalDirectSection)).toEqual([]);
        expect(view.tree.root.findAllByType(VoiceProviderSection)).toEqual([]);
        expect(device.permission).not.toHaveBeenCalled();
        expect(device.start).not.toHaveBeenCalled();
        expect(account.request.mock.calls.every(([url]) => new URL(String(url)).hostname.endsWith('.example.test'))).toBe(true);
    });

    it('enables the daemon catalog and derives readiness from local_direct selected model packs', async () => {
        await configure();
        const view = await render(<VoiceConversationsSettingsScreen />);
        expectCatalogFor('voice-runtime-machine');
        // Retained local_direct has no picker tile/pipeline; inspect the real screen's readiness output
        // and the actual installed model controls rather than inventing a selected gallery service.
        expect(view.tree.root.findByType(VoiceProviderSection).props.localAvailability?.daemon)
            .toMatchObject({ modelState: 'ready', runtimeState: 'available' });
        expect(view.findByTestId(`voice-model-remove-${DIRECT_STT_PACK_ID}`)).toBeTruthy();
        expect(view.findByTestId(`voice-model-remove-${DIRECT_TTS_PACK_ID}`)).toBeTruthy();
    });

    it('passes daemon relay-cap diagnostics into the real LocalDirectSection', async () => {
        const voice = createVoice();
        await configure(voiceSettingsParse({ ...voice, dictation: { ...voice.dictation, sttBinding: 'explicit',
            stt: readLocalDirectVoiceSettings(voice).stt } }), { capped: true });
        const view = await render(<VoiceConversationsSettingsScreen />);
        expect(view.tree.root.findByType(LocalDirectSection).props.daemonRouteDiagnosticReason).toBe('daemon_relay_capped');
        expect(view.tree.root.findByType(VoiceProviderSection).props.localAvailability?.daemon?.route).toBe('relay_capped');
        expect(resolveVoiceProviderAvailability({
            happierVoiceSupported: view.tree.root.findByType(VoiceProviderSection).props.happierVoiceSupported, platformOs: 'web',
            local: view.tree.root.findByType(VoiceProviderSection).props.localAvailability,
        }).local.paths.daemon).toMatchObject({ selectable: false, runnable: false, reason: 'daemon_relay_capped' });
        // The retained direct service has no gallery pipeline. Dictation consumes the same
        // canonical route facts and renders the exact failure instead of treating installed packs as ready.
        standardCleanup();
        const dictation = await render(<VoiceDictationSettingsScreen />);
        expect(pipeline(dictation, 'settings.voice.dictation.pipeline').props.steps[0].readiness)
            .toMatchObject({ message: tLoose('voice.readiness.daemon_relay_capped') });
        expect(pipeline(dictation, 'settings.voice.dictation.pipeline').findAll(node =>
            node.children.includes(tLoose('voice.readiness.daemon_relay_capped'))).length).toBeGreaterThan(0);
    });

    it('uses the runtime voice-home machine target for local_direct daemon diagnostics', async () => {
        await configure();
        const view = await render(<VoiceConversationsSettingsScreen />);
        expectCatalogFor('voice-runtime-machine');
        expect(view.tree.root.findByType(VoiceProviderSection).props.executionMachineId).toBe('voice-runtime-machine');
        expect(catalogRequests().some(request => request.method.startsWith('machine-1:'))).toBe(false);
    });

    it('persists the canonical machine selector choice for a Connected Account conversation provider', async () => {
        const { applyAccountVoiceCredentialSourceSelection } = await import('@/voice/credentials/accountVoiceCredential');
        const { createDefaultVoiceProviderRegistry } = await import('@/voice/registry/defaultRegistry');
        const provider = createDefaultVoiceProviderRegistry().get('happier.voice.openai/realtime-openai');
        if (provider?.kind !== 'voice.conversation-provider.v1' || provider.declaration?.kind !== 'conversation') throw new Error('expected_openai_voice_provider');
        const descriptor = provider.providerSettings;
        if (!descriptor) throw new Error('expected_openai_settings_descriptor');
        const voice = createVoice(provider.providerId);
        await configure(voiceSettingsParse({ ...voice, providers: { ...voice.providers,
            [provider.providerId]: { schemaVersion: descriptor.schemaVersion, config: descriptor.defaultConfig },
        } }));
        const selected = applyAccountVoiceCredentialSourceSelection({
            settings: account.settings,
            connectedPurposes: account.purposes.value,
            mutation: { contribution: { pluginId: provider.pluginId, localId: provider.declaration.id },
                credentialSlotId: provider.declaration.credentials!.slot.id,
                selection: { kind: 'connectedAccount', target: { kind: 'account', account: {
                    service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'codex-work',
                } } }, expectedSettingsVersion: 1 }, currentDeclaration: provider.declaration,
        });
        await account.replaceConnectedPurposes(selected.connectedPurposes);
        account.replaceSettings(selected.settings);
        const view = await render(<VoiceConversationsSettingsScreen />);
        const chip = view.findAll(node => node.props?.filter?.id === 'voiceComputer')[0];
        expect(chip?.props.filter.options).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'machine-1', label: 'Primary Mac' })]));
        await act(async () => chip!.props.filter.onChange('machine-1'));
        await vi.waitFor(() => expect(account.persistedSettings.voice.executionMachine).toMatchObject({ mode: 'fixed', machineId: 'machine-1' }));
        expect(account.writes.length).toBeGreaterThan(0);
    });

    it('refreshes daemon catalog and diagnostics when the reactive execution machine hydrates', async () => {
        const voice = voiceSettingsParse({ ...createVoice(), executionMachine: { mode: 'fixed', machineId: 'hydrated-machine' } });
        await configure(voice, { machines: [] });
        const view = await render(<VoiceConversationsSettingsScreen />);
        expect(catalogRequests()).toEqual([]);
        expect(view.tree.root.findByType(VoiceProviderSection).props.executionMachineId).toBeNull();
        await act(async () => hydrateMachines(['hydrated-machine']));
        await vi.waitFor(() => expectCatalogFor('hydrated-machine'));
        await vi.waitFor(() => expect(view.tree.root.findByType(VoiceProviderSection).props.localAvailability?.daemon)
            .toMatchObject({ modelState: 'ready', runtimeState: 'available' }));
    });

    it('projects installed STT readiness to Dictation without requiring the unrelated TTS pack', async () => {
        statuses = [status(DIRECT_STT_PACK_ID), status(DIRECT_TTS_PACK_ID, 'not_installed')];
        const voice = createVoice('local_conversation');
        await configure(voiceSettingsParse({ ...voice, dictation: { ...voice.dictation, sttBinding: 'same_as_local' } }));
        const view = await render(<VoiceDictationSettingsScreen />);
        expectCatalogFor('voice-runtime-machine');
        expect(pipeline(view, 'settings.voice.dictation.pipeline').props.status.tone).toBe('ready');
        expect(pipeline(view, 'settings.voice.dictation.pipeline').props.steps[0].readiness).toBeNull();
    });

    it('loads daemon STT catalog facts for explicit local Dictation under a non-local Voice provider', async () => {
        const voice = createVoice('happier.voice.elevenlabs/realtime-elevenlabs');
        await configure(voiceSettingsParse({ ...voice, dictation: { ...voice.dictation, sttBinding: 'explicit',
            stt: readLocalDirectVoiceSettings(voice).stt } }));
        const view = await render(<VoiceDictationSettingsScreen />);
        expectCatalogFor('voice-runtime-machine');
        expect(pipeline(view, 'settings.voice.dictation.pipeline').props.status.tone).toBe('ready');
    });

    it.each(['auto', 'device'] as const)('does not request daemon work for native local-neural Dictation with %s execution', async execution => {
        device.os = 'ios';
        const voice = createVoice('happier.voice.elevenlabs/realtime-elevenlabs');
        const stt = readLocalDirectVoiceSettings(voice).stt;
        await configure(voiceSettingsParse({ ...voice, dictation: { ...voice.dictation, sttBinding: 'explicit',
            stt: { ...stt, localNeural: { ...stt.localNeural, execution } } } }));
        const view = await render(<VoiceDictationSettingsScreen />);
        expect(catalogRequests()).toEqual([]);
        expect(requests.filter(request => request.method.includes('daemon.voiceInference.'))).toEqual([]);
        expect(pipeline(view, 'settings.voice.dictation.pipeline').props.steps[0].where).toBe(t('settingsVoice.pages.pipeline.onThisDevice'));
        expect(device.permission).not.toHaveBeenCalled();
        expect(device.start).not.toHaveBeenCalled();
    });
});
