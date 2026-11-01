import 'fake-indexeddb/auto';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { SettingsDeclarationActionOutputSchemasV1 } from '@happier-dev/protocol/actions/settingsDeclarationActionFamily';
import { AccountSettingsStoredContentEnvelopeSchema } from '@happier-dev/protocol/account/settings/accountSettingsStoredContentEnvelope';
import { createDeferred, renderScreen, standardCleanup } from '@/dev/testkit';
import type { SpeechOptions } from 'expo-speech';
import { createVoiceSpeechOutputBoundary } from '@/dev/testkit/harness/voiceSpeechOutputBoundary';
import * as backgroundTasks from '@/utils/system/fireAndForget';

// Install the canonical transport boundary before the real Sync/Action graph.
vi.mock('socket.io-client', async original =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));

afterEach(() => standardCleanup());
const speech = createVoiceSpeechOutputBoundary({ getAccount: async () => { throw new Error('Device speech must not request daemon speech'); } });
afterAll(() => speech.disposeAudioSession());
// Load the real composition after transport installation, outside the timed
// behavior window; cold graph transformation is not a speech operation.
const { createVoiceSettingsAccountTestHarness } = await import('./panels/voiceSettingsAccountTestHarness');
const { settingsParse } = await import('@/sync/domains/settings/settings');
const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');

async function pressTtsSample(screen: Awaited<ReturnType<typeof renderScreen>>) {
    // Observe the real dispatched operation, preserving its original error sink.
    const dispatched = vi.spyOn(backgroundTasks, 'fireAndForget');
    try {
        await act(async () => {
            screen.findAllByTestId('settings.voice.local.testTts')[0]!.props.onPress();
            const operation = dispatched.mock.calls.find(([, options]) => options?.tag === 'LocalVoiceTtsGroup.testTts')?.[0];
            expect(operation).toBeInstanceOf(Promise);
            await operation;
        });
    } finally { dispatched.mockRestore(); }
}

describe('Voice declarations through the default Settings Action and Account persistence', () => {
    it('reads History through the default Settings Action without mounting Privacy', async () => {
        const account = await createVoiceSettingsAccountTestHarness(settingsParse({ voice: { providerId: 'local_conversation' } }));
        onTestFinished(account.dispose);
        const request = account.request.getMockImplementation()!;
        account.request.mockImplementation(async (input, init) => new URL(String(input)).pathname === '/v2/sessions/lookup-by-tags'
            ? Response.json({ sessions: [] }) : request(input, init));
        const result = await createDefaultActionExecutor().execute('settings.invoke', { anchor: 'voicePrivacy.voiceHistory' }, {
            surface: 'ui', authority: 'present_user', serverId: account.scope.serverId, expectedAccountId: account.scope.accountId,
            presentUserConfirmation: { actionId: 'settings.invoke' },
        });
        expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { status: 'completed', value: { rows: [] } } });
        expect(account.writes).toHaveLength(0);
    });

    it('persists the person-controlled Voice approval preference without replacing unrelated values', async () => {
        const account = await createVoiceSettingsAccountTestHarness(settingsParse({ actionsSettingsV1: {
            v: 1, actions: {}, approvalWaivedSurfaces: { 'settings.set': ['voice'] },
        }, voice: {
            assistantLanguage: 'fr', privacy: { shareToolNames: false },
        } }));
        onTestFinished(account.dispose);
        const executor = createDefaultActionExecutor();
        const context = { surface: 'ui' as const, authority: 'present_user' as const,
            serverId: account.scope.serverId, expectedAccountId: account.scope.accountId };
        const anchor = 'voiceConversations.canApproveRequests';
        expect(await executor.execute('settings.get', { anchor }, context)).toMatchObject({
            ok: true, result: { value: true },
        });
        expect(await executor.execute('settings.set', { anchor, value: false }, context)).toMatchObject({ ok: true });
        expect(account.persistedSettings.voice).toMatchObject({ canApproveRequests: false,
            assistantLanguage: 'fr', privacy: { shareToolNames: false } });
        account.replaceVoice({ ...account.settings.voice, assistantLanguage: 'de' });
        const before = account.persistedSettings;
        const writes = account.writes.length;
        expect(await executor.execute('settings.set', { anchor, value: 'false' }, context)).toMatchObject({ ok: false });
        expect(await executor.execute('settings.set', { anchor, value: true }, {
            ...context, surface: 'voice', authority: 'account_automation',
        })).toMatchObject({ ok: false, errorCode: 'present_user_required' });
        expect(account.writes).toHaveLength(writes);
        expect(account.persistedSettings).toEqual(before);
        expect(await executor.execute('settings.set', { anchor, value: true }, context)).toMatchObject({ ok: true });
        expect(account.persistedSettings.voice).toMatchObject({ canApproveRequests: true,
            assistantLanguage: 'de', privacy: { shareToolNames: false } });
    });
    it('does not prime the browser audio graph for a refused TTS sample', async () => {
        speech.reset();
        const platform = speech.platform.value;
        speech.platform.value = 'web';
        onTestFinished(() => { speech.platform.value = platform; vi.unstubAllGlobals(); });
        const { resetWebAudioContextForTests } = await import('@/voice/output/webAudioContext');
        resetWebAudioContextForTests();
        onTestFinished(resetWebAudioContextForTests);
        const createContext = vi.fn();
        const start = vi.fn();
        vi.stubGlobal('AudioContext', class {
            constructor() { createContext(); }
            resume() {}
            createBuffer() { return {}; }
            createBufferSource() { return { connect() {}, disconnect() {}, start }; }
        });
        const account = await createVoiceSettingsAccountTestHarness(settingsParse({ voice: { providerId: 'local_conversation' },
            actionsSettingsV1: { v: 1, actions: { 'settings.invoke': { disabledSurfaces: ['ui'] } } } }));
        onTestFinished(account.dispose);
        const { readLocalConversationVoiceSettings } = await import('@/sync/domains/settings/voiceSettings');
        const { LocalVoiceTtsGroup } = await import('./panels/localTts/LocalVoiceTtsGroup');
        const cfg = readLocalConversationVoiceSettings(account.settings.voice);
        const screen = await renderScreen(React.createElement(LocalVoiceTtsGroup, { cfgTts: cfg.tts,
            voice: account.settings.voice, setVoice: () => {}, setTts: () => {}, networkTimeoutMs: cfg.networkTimeoutMs }));
        onTestFinished(screen.unmount);
        await pressTtsSample(screen);
        expect(screen.findAllByTestId('settings.voice.local.testTts')[0]!.props.disabled).toBe(false);
        expect(createContext).not.toHaveBeenCalled();
        expect(start).not.toHaveBeenCalled();
    });
    it('refuses the mounted local TTS sample without audio while an adjacent Voice setting remains writable', async () => {
        speech.reset();
        const account = await createVoiceSettingsAccountTestHarness(settingsParse({ voice: { providerId: 'local_conversation',
            providers: { local_conversation: { schemaVersion: 1, config: { tts: { provider: 'device' } } } } },
            actionsSettingsV1: { v: 1, actions: { 'settings.invoke': { disabledSurfaces: ['ui'] } } } }));
        onTestFinished(account.dispose);
        const { readLocalConversationVoiceSettings } = await import('@/sync/domains/settings/voiceSettings');
        const { LocalVoiceTtsGroup } = await import('./panels/localTts/LocalVoiceTtsGroup');
        const cfg = readLocalConversationVoiceSettings(account.settings.voice);
        const screen = await renderScreen(React.createElement(LocalVoiceTtsGroup, { cfgTts: cfg.tts,
            voice: account.settings.voice, setVoice: () => {}, setTts: () => {}, networkTimeoutMs: cfg.networkTimeoutMs }));
        onTestFinished(screen.unmount);
        await pressTtsSample(screen);
        expect(screen.findByTestId('settings.voice.local.testTts')?.props.disabled).toBe(false);
        expect(speech.expoSpeechSpeak).not.toHaveBeenCalled();
        expect(speech.nativeSynthesize).not.toHaveBeenCalled();
        expect(speech.encodedAudio.start).not.toHaveBeenCalled();
        expect(account.writes).toHaveLength(0);
        expect(await createDefaultActionExecutor().execute('settings.set', { anchor: 'voicePrivacy.recentMessagesCount', value: 9 }, {
            surface: 'ui', authority: 'present_user', serverId: account.scope.serverId, expectedAccountId: account.scope.accountId,
        })).toMatchObject({ ok: true });
        expect(account.persistedSettings.voice.privacy.recentMessagesCount).toBe(9);
        account.replaceSettings(settingsParse({ ...account.settings, actionsSettingsV1: { v: 1, actions: {} } }));
        speech.expoSpeechSpeak.mockImplementation((_text, options) => options.onDone?.());
        await pressTtsSample(screen);
        expect(speech.expoSpeechSpeak).toHaveBeenCalledOnce();
        expect(screen.findAllByTestId('settings.voice.local.testTts')[0]!.props.disabled).toBe(false);
    });
    it('lists and retries the selected local-neural voice catalog for Agents without starting playback', async () => {
        const { filesystem } = speech.reset();
        const { parseModelPackManifest } = await import('@happier-dev/protocol/voice/modelPacks/manifest');
        const packId = 'settings-catalog-kokoro';
        const manifest = parseModelPackManifest({ packId, kind: 'tts_sherpa', model: 'kokoro', version: '1', frontend: { lang: 'en' },
            voices: [{ id: 'am_adam', title: 'Adam', sid: 0 }], defaultVoiceId: 'am_adam',
            files: [{ path: 'model.onnx', url: 'https://example.test/model.onnx', sha256: 'a'.repeat(64), sizeBytes: 1 }] });
        filesystem.files.set(`${filesystem.root}/${packId}/pack.json`, new TextEncoder().encode(JSON.stringify({ manifest })));
        const account = await createVoiceSettingsAccountTestHarness(settingsParse({ voice: { providerId: 'local_conversation',
            providers: { local_conversation: { schemaVersion: 1, config: { tts: { provider: 'local_neural',
                localNeural: { execution: 'device', assetId: packId } } } } } } }));
        onTestFinished(account.dispose);
        const executor = createDefaultActionExecutor();
        for (const anchor of ['voiceConversations.ttsCatalog', 'voiceConversations.ttsCatalogRetry']) {
            const result = await executor.execute('settings.invoke', { anchor }, {
                surface: 'agent', authority: 'account_automation', serverId: account.scope.serverId, expectedAccountId: account.scope.accountId,
            });
            expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { status: 'completed', value: { rows: [{ id: 'am_adam', name: 'Adam' }] } } });
        }
        expect(speech.nativeSynthesize).not.toHaveBeenCalled();
        expect(speech.encodedAudio.start).not.toHaveBeenCalled();
        expect(account.writes).toHaveLength(0);
    });
    it('admits web catalog Stop through the existing local-neural Settings Action', async () => {
        const previousPlatform = speech.platform.value;
        speech.platform.value = 'web';
        onTestFinished(() => { speech.platform.value = previousPlatform; });
        const account = await createVoiceSettingsAccountTestHarness(settingsParse({ voice: { providerId: 'local_conversation' } }));
        onTestFinished(account.dispose);
        const { localNeuralTtsPreviewController } = await import('./panels/localTts/providers/localNeural/previewLocalNeuralTts');
        const preview = localNeuralTtsPreviewController.begin('af_maple');
        onTestFinished(() => preview.finish());
        const result = await createDefaultActionExecutor().execute('settings.invoke', { anchor: 'voiceConversations.ttsPreviewStop' }, {
            surface: 'ui', authority: 'present_user', serverId: account.scope.serverId, expectedAccountId: account.scope.accountId,
        });
        expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { status: 'completed', value: { stopped: true } } });
        expect(localNeuralTtsPreviewController.read()).toBeNull();
        expect(account.writes).toHaveLength(0);
    });
    it('cancels Device Test through settings.invoke and releases its playback lease', async () => {
        const account = await createVoiceSettingsAccountTestHarness(settingsParse({ voice: { providerId: 'local_conversation',
            providers: { local_conversation: { schemaVersion: 1, config: { tts: { provider: 'device' } } } } } }));
        onTestFinished(account.dispose);
        const entered = createDeferred<SpeechOptions>();
        speech.expoSpeechSpeak.mockReset().mockImplementation((_text, options) => entered.resolve(options));
        speech.expoSpeechStop.mockReset();
        const controller = new AbortController();
        const pending = createDefaultActionExecutor().execute('settings.invoke', { anchor: 'voiceConversations.testTts' }, {
            surface: 'ui', authority: 'present_user', serverId: account.scope.serverId, expectedAccountId: account.scope.accountId,
            presentUserConfirmation: { actionId: 'settings.invoke' }, signal: controller.signal,
        });
        let playback: SpeechOptions | undefined;
        // Always release the held OS operation if the deciding assertion fails.
        try {
            playback = await Promise.race([entered.promise, pending.then(result => {
                throw new Error('Device sample settled before playback: ' + JSON.stringify(result));
            })]);
            expect(speech.getAudioSessionCoordinator().getSnapshot().leaseCount).toBe(1);
            controller.abort();
            expect(speech.expoSpeechStop).toHaveBeenCalledOnce();
            await pending;
            expect(speech.getAudioSessionCoordinator().getSnapshot().leaseCount).toBe(0);
            expect(account.writes).toHaveLength(0);
        } finally {
            playback?.onDone?.();
            await pending;
        }
    });
    it('persists a nested Voice edit, preserves unrelated preferences, and refuses invalid writes', async () => {
        const account = await createVoiceSettingsAccountTestHarness(settingsParse({ voice: {
            providerId: 'local_conversation', assistantLanguage: 'fr', privacy: { shareToolNames: false },
        } }));
        onTestFinished(account.dispose);
        const executor = createDefaultActionExecutor();
        const context = { surface: 'ui' as const, authority: 'present_user' as const,
            serverId: account.scope.serverId, expectedAccountId: account.scope.accountId };
        const execute = (anchor: string, value: unknown) => executor.execute('settings.set', { anchor, value }, context);
        const changed = await execute('voicePrivacy.recentMessagesCount', 7);
        expect(changed, JSON.stringify(changed)).toMatchObject({ ok: true,
            result: { anchor: 'voicePrivacy.recentMessagesCount', value: 7 } });
        if (!changed.ok) throw new Error('Settings Action failed');
        expect(SettingsDeclarationActionOutputSchemasV1['settings.set'].parse(changed.result))
            .toMatchObject({ anchor: 'voicePrivacy.recentMessagesCount', value: 7 });
        expect(account.persistedSettings.voice).toMatchObject({ assistantLanguage: 'fr',
            privacy: { recentMessagesCount: 7, shareToolNames: false } });
        for (const write of account.writes) {
            if (!write || typeof write !== 'object' || !('content' in write)) throw new Error('Missing Settings envelope');
            expect(AccountSettingsStoredContentEnvelopeSchema.parse(write.content).t).toBe('plain');
        }
        expect(account.writes.length).toBeGreaterThan(0);
        const before = account.persistedSettings;
        const writeCount = account.writes.length;
        expect(await execute('voicePrivacy.recentMessagesCount', -1)).toMatchObject({ ok: false });
        // A missing declaration is the mis-wiring vector: it must neither
        // resolve an arbitrary JSON path nor mutate the persisted Account.
        expect(await execute('voicePrivacy.unregisteredField', 8)).toMatchObject({ ok: false });
        expect(account.writes).toHaveLength(writeCount);
        expect(account.persistedSettings).toEqual(before);
        expect(await executor.execute('settings.get', { anchor: 'voicePrivacy.recentMessagesCount' }, context))
            .toMatchObject({ ok: true, result: { anchor: 'voicePrivacy.recentMessagesCount', value: 7 } });
    });
});
