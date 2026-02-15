import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native-unistyles', () => ({
  useUnistyles: () => ({ theme: { colors: { textSecondary: '#999' } } }),
}));

vi.mock('@expo/vector-icons', () => ({
  Ionicons: 'Ionicons',
}));

vi.mock('@/text', () => ({
  t: (key: string) => key,
}));

const promptSpy = vi.fn();
vi.mock('@/modal', () => ({
  Modal: {
    prompt: (...args: any[]) => promptSpy(...args),
    alert: vi.fn(),
  },
}));

vi.mock('@/sync/sync', () => ({
  sync: {
    decryptSecretValue: (value: any) => (value && typeof value.value === 'string' ? value.value : null),
  },
}));

vi.mock('@/components/ui/lists/Item', () => ({
  Item: (props: any) => React.createElement('Item', props),
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
  DropdownMenu: (props: any) =>
    React.createElement(
      'DropdownMenu',
      props,
      typeof props.trigger === 'function'
        ? props.trigger({ open: false, toggle: () => {}, openMenu: () => {}, closeMenu: () => {} })
        : props.trigger ?? null,
    ),
}));

vi.mock('@/voice/runtime/VoicePlaybackController', () => ({
  createVoicePlaybackController: () => ({
    interrupt: vi.fn(),
    registerStopper: () => () => {},
  }),
}));

vi.mock('@/voice/output/GoogleCloudTtsController', () => ({
  speakGoogleCloudText: vi.fn().mockResolvedValue(undefined),
}));

describe('GoogleCloudTtsSettings', () => {
  it('populates a language dropdown from the voice catalog and updates settings on select', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        voices: [
          { name: 'en-US-Voice-A', languageCodes: ['en-US'], ssmlGender: 'FEMALE', naturalSampleRateHertz: 24000 },
          { name: 'fr-FR-Voice-A', languageCodes: ['fr-FR'], ssmlGender: 'MALE', naturalSampleRateHertz: 24000 },
        ],
      }),
    });
    (globalThis as any).fetch = fetchSpy;

    const setTts = vi.fn();
    const { googleCloudTtsProviderSpec } = await import('./googleCloudTtsProvider');

    let tree: any;
    await act(async () => {
      tree = renderer.create(
        React.createElement(googleCloudTtsProviderSpec.Settings, {
          cfgTts: {
            provider: 'google_cloud',
            openaiCompat: { baseUrl: null, apiKey: null, model: 'tts-1', voice: 'alloy', format: 'mp3' },
            localNeural: { model: 'kokoro', assetId: null, voiceId: null, speed: null },
            googleCloud: {
              apiKey: { _isSecretValue: true, value: 'k' },
              androidCertSha1: null,
              voiceName: null,
              languageCode: null,
              format: 'mp3',
              speakingRate: null,
              pitch: null,
            },
            autoSpeakReplies: true,
            bargeInEnabled: true,
          },
          setTts,
          networkTimeoutMs: 15_000,
          popoverBoundaryRef: null,
        }),
      );
    });
    await act(async () => {
      await Promise.resolve();
    });

    const languageDropdown = tree.root
      .findAllByType('DropdownMenu' as any)
      .find((d: any) => d.props?.searchPlaceholder === 'Search languages');
    expect(languageDropdown).toBeTruthy();
    expect(languageDropdown.props.items.some((it: any) => it.id === 'en-US')).toBe(true);
    expect(languageDropdown.props.items.some((it: any) => it.id === 'fr-FR')).toBe(true);

    await act(async () => {
      languageDropdown.props.onSelect?.('fr-FR');
    });

    expect(setTts).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'google_cloud',
        googleCloud: expect.objectContaining({ languageCode: 'fr-FR' }),
      }),
    );
  });

  it('prompts for speaking rate and pitch and persists numeric values', async () => {
    promptSpy.mockResolvedValueOnce('1.2').mockResolvedValueOnce('-3');

    const setTts = vi.fn();
    const { googleCloudTtsProviderSpec } = await import('./googleCloudTtsProvider');

    let tree: any;
    await act(async () => {
      tree = renderer.create(
        React.createElement(googleCloudTtsProviderSpec.Settings, {
          cfgTts: {
            provider: 'google_cloud',
            openaiCompat: { baseUrl: null, apiKey: null, model: 'tts-1', voice: 'alloy', format: 'mp3' },
            localNeural: { model: 'kokoro', assetId: null, voiceId: null, speed: null },
            googleCloud: {
              apiKey: { _isSecretValue: true, value: 'k' },
              androidCertSha1: null,
              voiceName: null,
              languageCode: null,
              format: 'mp3',
              speakingRate: null,
              pitch: null,
            },
            autoSpeakReplies: true,
            bargeInEnabled: true,
          },
          setTts,
          networkTimeoutMs: 15_000,
          popoverBoundaryRef: null,
        }),
      );
    });

    const speakRateItem = tree.root.findAll((n: any) => n.type === 'Item' && n.props?.title === 'Speaking rate')[0];
    const pitchItem = tree.root.findAll((n: any) => n.type === 'Item' && n.props?.title === 'Pitch')[0];
    expect(speakRateItem).toBeTruthy();
    expect(pitchItem).toBeTruthy();

    await act(async () => {
      await speakRateItem.props.onPress?.();
    });
    await act(async () => {
      await pitchItem.props.onPress?.();
    });

    expect(setTts).toHaveBeenCalledWith(
      expect.objectContaining({
        googleCloud: expect.objectContaining({ speakingRate: 1.2 }),
      }),
    );
    expect(setTts).toHaveBeenCalledWith(
      expect.objectContaining({
        googleCloud: expect.objectContaining({ pitch: -3 }),
      }),
    );
  });
});
