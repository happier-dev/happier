import React from 'react';
import 'fake-indexeddb/auto';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { findAllHostTestInstances, renderScreen, standardCleanup } from '@/dev/testkit';
import { createVoiceSpeechOutputBoundary } from '@/dev/testkit/harness/voiceSpeechOutputBoundary';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { readLocalConversationVoiceSettings, voiceSettingsDefaults, voiceSettingsParse, writeLocalConversationVoiceSettings } from '@/sync/domains/settings/voiceSettings';
import { settingsParse } from '@/sync/domains/settings/settings';
import { createVoiceSettingsAccountTestHarness } from '../voiceSettingsAccountTestHarness';
import { createDeferred } from '@/dev/testkit';
import { t } from '@/text';
import { Modal } from '@/modal';
import { Alert } from 'react-native';
import { LocalVoiceTtsGroup } from './LocalVoiceTtsGroup';
import { parseModelPackManifest } from '@happier-dev/protocol/voice/modelPacks/manifest';
import { KOKORO_DEFAULT_TTS_PACK_ID } from '@happier-dev/protocol/voice/modelPacks/catalog';
const presentModalAlert = Modal.alert.bind(Modal);

// The device speech SDK and authenticated speech/RPC transports are external
// boundaries; provider catalog, settings controls and playback custody stay real.
vi.mock('react-native', async () => {
  const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});

let account: Awaited<ReturnType<typeof createVoiceSettingsAccountTestHarness>>;

function storeVoiceForTest(voice: ReturnType<typeof voiceSettingsParse>) {
  account.replaceVoice(voice);
}

async function renderTtsGroup() {
  const local = readLocalConversationVoiceSettings(voiceSettingsDefaults);
  const cfgTts = { ...local.tts, provider: 'device' as const };
  const voice = writeLocalConversationVoiceSettings(voiceSettingsParse({ providerId: 'local_conversation' }), { ...local, tts: cfgTts });
  storeVoiceForTest(voice);
  return await renderScreen(<LocalVoiceTtsGroup
    cfgTts={cfgTts}
    setTts={vi.fn()}
    voice={voice}
    setVoice={vi.fn()}
    networkTimeoutMs={15000}
    popoverBoundaryRef={null}
  />);
}

const speechBoundary = createVoiceSpeechOutputBoundary({ getAccount: async () => {
  throw new Error('Device sample must not issue daemon RPC');
} });
let speechFilesystem: ReturnType<typeof speechBoundary.reset>['filesystem'];
const { localNeuralTtsPreviewController } = await import('./providers/localNeural/previewLocalNeuralTts');
const { invokeVoiceSettingsOperation } = await import('@/voice/settings/voiceSettingsOperationInvoker');

function neuralSampleFixture() {
  const local = readLocalConversationVoiceSettings(voiceSettingsDefaults);
  const tts = { ...local.tts, provider: 'local_neural' as const,
    localNeural: { ...local.tts.localNeural, voiceId: 'af_heart', execution: 'device' as const } };
  const voice = writeLocalConversationVoiceSettings(voiceSettingsParse({ providerId: 'local_conversation' }), { ...local, tts });
  const manifest = parseModelPackManifest({ packId: KOKORO_DEFAULT_TTS_PACK_ID, kind: 'tts_sherpa', model: 'kokoro', version: '1',
    frontend: { lang: 'en' }, voices: [{ id: 'af_heart', title: 'Heart', sid: 0 }], defaultVoiceId: 'af_heart',
    files: [{ path: 'model.onnx', url: 'https://example.test/model.onnx', sha256: 'a'.repeat(64), sizeBytes: 1 }] });
  speechFilesystem.files.set(`${speechFilesystem.root}/${manifest.packId}/pack.json`, new TextEncoder().encode(JSON.stringify({ manifest })));
  return { cfgTts: tts, voice, settings: settingsParse({ voice }) };
}

describe('LocalVoiceTtsGroup', () => {
  beforeEach(async () => {
    account = await createVoiceSettingsAccountTestHarness(settingsParse({
      experiments: true,
      featureToggles: { voice: true, 'execution.runs': true, 'voice.agent': true, 'voice.daemonInference': true },
    }), { features: createRootLayoutFeaturesResponse({ features: { voice: { enabled: true } } }) });
    speechBoundary.expoSpeechSpeak.mockReset();
    speechBoundary.expoSpeechStop.mockReset();
  });
  afterEach(async () => {
    await standardCleanup();
    await act(async () => { localNeuralTtsPreviewController.stop(); });
    await account.dispose();
  });
  afterAll(async () => { await speechBoundary.disposeAudioSession(); });

  it('uses the localized row title as the accessible name of its switch', async () => {
    const screen = await renderTtsGroup();
    const switches = findAllHostTestInstances(screen.tree.root, node => {
      if ((node.props.accessibilityRole ?? node.props.role) !== 'switch') return false;
      for (let parent = node.parent; parent; parent = parent.parent) {
        if (parent.props.importantForAccessibility === 'no-hide-descendants'
          || parent.props.accessibilityElementsHidden === true || parent.props['aria-hidden'] === true) return false;
      }
      return true;
    });
    expect(switches).toHaveLength(1);
    expect(switches[0].props.accessibilityLabel ?? switches[0].props['aria-label']).toBe(t('settingsVoice.local.autoSpeak'));
  });

  it('shows a speaking status until the device speech operation settles', async () => {
    let finishSpeech: (() => void) | undefined;
    const started = createDeferred<void>();
    speechBoundary.expoSpeechSpeak.mockImplementation((_text, options) => {
      finishSpeech = () => options?.onDone?.();
      started.resolve();
    });
    const screen = await renderTtsGroup();
    expect(screen.getTextContent()).toContain(t('settingsVoice.local.testTtsSubtitle'));

    await screen.pressByTestIdAsync('settings.voice.local.testTts');
    await act(async () => {
      await started.promise;
      expect(finishSpeech).toBeTypeOf('function');
    });
    expect(screen.getTextContent()).toContain(t('settingsVoice.local.speaking'));
    expect(screen.getTextContent()).not.toContain(t('settingsVoice.local.testTtsSubtitle'));

    await act(async () => { finishSpeech?.(); });
    expect(screen.getTextContent()).toContain(t('settingsVoice.local.testTtsSubtitle'));
    expect(screen.getTextContent()).not.toContain(t('settingsVoice.local.speaking'));
  });

  it('lets the shared Stop operation cancel the rendered local neural sample without an unavailable alert', async () => {
    ({ filesystem: speechFilesystem } = speechBoundary.reset());
    speechBoundary.platform.value = 'ios';
    const synthesis = createDeferred<{ wavPath: string; sampleRate: number }>();
    const started = createDeferred<void>();
    const cancelled = createDeferred<void>();
    speechBoundary.nativeCancel.mockImplementationOnce(async () => { cancelled.resolve(); });
    let jobId = '';
    speechBoundary.nativeSynthesize.mockImplementationOnce(async (input) => {
      jobId = input.jobId;
      started.resolve();
      return synthesis.promise;
    });
    const fixture = neuralSampleFixture();
    storeVoiceForTest(fixture.voice);
    const alert = vi.spyOn(Modal, 'alert').mockImplementation(presentModalAlert);
    onTestFinished(() => alert.mockRestore());
    const screen = await renderScreen(<LocalVoiceTtsGroup
      cfgTts={fixture.cfgTts}
      setTts={vi.fn()}
      voice={fixture.voice}
      setVoice={vi.fn()}
      networkTimeoutMs={15000}
      popoverBoundaryRef={null}
    />);

    await screen.pressByTestIdAsync('settings.voice.local.testTts');
    await started.promise;
    expect(jobId).not.toBe('');
    expect(localNeuralTtsPreviewController.read()).toBe('af_heart');

    await act(async () => {
      const stopped = await invokeVoiceSettingsOperation('tts_preview_stop', 'conversation', {
        isCurrent: () => true,
        readSettings: async () => fixture.settings,
        mutateSettings: async () => { throw new Error('Stopping a sample must not mutate settings'); },
      });
      expect(stopped).toMatchObject({ status: 'completed', value: { stopped: true } });
    });
    synthesis.resolve({ wavPath: `${speechFilesystem.root}/late.wav`, sampleRate: 24_000 });
    await cancelled.promise;
    expect(speechBoundary.nativeCancel).toHaveBeenCalledWith({ jobId });
    expect(alert).not.toHaveBeenCalled();
    expect([...speechFilesystem.files.keys()]).not.toContain(`${speechFilesystem.root}/late.wav`);
  });
  it('explains an unreachable Voice machine in its own words when a Local neural sample cannot play', async () => {
    const local = readLocalConversationVoiceSettings(voiceSettingsDefaults);
    const tts = { ...local.tts, provider: 'local_neural' as const,
      localNeural: { ...local.tts.localNeural, execution: 'daemon' as const } };
    const voice = writeLocalConversationVoiceSettings(voiceSettingsParse({ providerId: 'local_conversation' }), { ...local, tts });
    storeVoiceForTest(voice);
    const alerted = createDeferred<void>();
    const nativeAlert = vi.spyOn(Alert, 'alert').mockImplementation((_title, _message, buttons) => {
      alerted.resolve();
      buttons?.[0]?.onPress?.();
    });
    const alert = vi.spyOn(Modal, 'alert').mockImplementation(presentModalAlert);
    onTestFinished(() => { nativeAlert.mockRestore(); alert.mockRestore(); });
    const screen = await renderScreen(<LocalVoiceTtsGroup
      cfgTts={tts}
      setTts={vi.fn()}
      voice={voice}
      setVoice={vi.fn()}
      networkTimeoutMs={15000}
      popoverBoundaryRef={null}
    />);

    await screen.pressByTestIdAsync('settings.voice.local.testTts');
    await alerted.promise;
    expect(alert).toHaveBeenCalledTimes(1);
    const body = String(alert.mock.calls[0]?.[1]);
    expect(body.trim().length).toBeGreaterThan(0);
    expect(body).toBe(t('settingsVoice.local.daemonInference.states.machineUnreachable'));
    expect(body).not.toMatch(/_/);
    expect(body).not.toBe(t('settingsVoice.local.testTtsFailed'));
  });
});
