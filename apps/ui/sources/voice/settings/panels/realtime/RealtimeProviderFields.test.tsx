import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';

import { parseRealtimeSettingsDescriptor } from './descriptor';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(standardCleanup);

const action = vi.hoisted(() => vi.fn(async () => ({ status: 'completed' as const })));
const searchRoute = vi.hoisted(() => ({ params: {} as Record<string, string> }));
vi.mock('expo-router', async () => {
  const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
  return createExpoRouterMock({ params: () => searchRoute.params }).module;
});
const audioPreview = vi.hoisted(() => ({
  create: vi.fn(),
  play: vi.fn(),
  remove: vi.fn(),
  addListener: vi.fn(() => ({ remove: vi.fn() })),
}));
const playbackAudioMode = vi.hoisted(() => {
  const release = vi.fn(async () => undefined);
  return {
    acquire: vi.fn(async () => Object.freeze({ release })),
    release,
  };
});

vi.mock('@/components/ui/lists/Item', () => ({
  Item: (props: any) => React.createElement('Item', props, props.rightElement),
}));
vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
  DropdownMenu: (props: any) => React.createElement('DropdownMenu', props),
}));
vi.mock('@/components/ui/forms/Switch', () => ({
  Switch: (props: any) => React.createElement('Switch', props),
}));
vi.mock('react-native', async () => {
  const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock({ Pressable: (props: any) => React.createElement('Pressable', props, props.children) });
});
vi.mock('@expo/vector-icons', () => ({ Ionicons: (props: any) => React.createElement('Ionicons', props) }));
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});
vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock({
    translate: (key: string, params?: Record<string, unknown>) => params?.voice ? `${key}:${params.voice}` : key,
    translateLoose: (key: string) => key,
  });
});
vi.mock('@/modal', async () => {
  const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
  return createModalModuleMock({ confirmResult: true }).module;
});
vi.mock('@/voice/session/voiceAdapterRegistry', () => ({
  performVoiceAdapterRuntimeAction: action,
}));
vi.mock('expo-audio', () => ({
  createAudioPlayer: audioPreview.create,
}));
vi.mock('@/voice/runtime/voiceAudioMode', () => ({
  acquireVoicePlaybackAudioMode: playbackAudioMode.acquire,
}));

// Keep cold owner-graph compilation outside each rendered interaction's timeout.
const { RealtimeProviderFields } = await import('./RealtimeProviderFields');

const owner = Object.freeze({
  schemaVersion: 1,
  defaultConfig: Object.freeze({
    model: Object.freeze({ kind: 'pinned', id: 'stable' }),
    resumptionEnabled: false,
  }),
  parseConfig(value: unknown) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const input = value as any;
    if (!['pinned', 'moving_alias'].includes(input.model?.kind)) return null;
    if (typeof input.model?.id !== 'string' || typeof input.resumptionEnabled !== 'boolean') return null;
    return input;
  },
});

function isConfigRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

describe('RealtimeProviderFields', () => {
  it('explains when an immediate native greeting has no Reply in literal without changing the choice', async () => {
    const { ELEVENLABS_SETTINGS_SECTION } = await import('../../../../../../../packages/plugins/elevenlabs/src/voiceSettingsPresentation');
    const descriptor = parseRealtimeSettingsDescriptor('acme.native-greeting', ELEVENLABS_SETTINGS_SECTION);
    if (!descriptor) throw new Error('missing native greeting presentation');
    const onWelcomeSelection = vi.fn();
    const screen = await renderScreen(React.createElement(RealtimeProviderFields, {
      providerId: 'acme.native-greeting', descriptor: { ...descriptor, fields: descriptor.fields.filter((field) => field.kind === 'welcome') },
      owner, config: owner.defaultConfig, credentialStatus: 'ready',
      catalog: { phase: 'idle' }, onRequestCatalog: vi.fn(),
      welcomeSelection: 'immediate', assistantLanguage: 'ar-SA', onWelcomeSelection,
    }));
    // The service's Greeting is the same shared choice Local voice shows (one control, one owner).
    const row = screen.tree.findAll((node) => node.props?.testIDPrefix === 'settings.voice.greeting' && Array.isArray(node.props?.options))[0]!;
    expect(row.props.options.map((option: { id: string }) => option.id)).toEqual(['off', 'immediate', 'on_first_turn']);
    expect(row.props.value).toBe('immediate');
    expect(row.props.options.find((option: { id: string }) => option.id === 'immediate').description).toBe('voicePresence.greetingLiteralUnavailable');
    expect(onWelcomeSelection).not.toHaveBeenCalled();
  });
  it('reveals a contributed VAD subfield from search without changing its provider settings', async () => {
    const { voiceSettingsDeclarationRegistry } = await import('@/voice/settings/voiceContributedSettingsDeclarations');
    const providerId = 'happier.voice.xai/realtime-grok';
    const entry = voiceSettingsDeclarationRegistry.get(providerId);
    const settings = entry?.providerSettings;
    const descriptor = parseRealtimeSettingsDescriptor(providerId, settings?.presentation);
    if (!descriptor || !settings) throw new Error('Missing admitted xAI settings');
    searchRoute.params = { setting: `voiceConversations.provider.${providerId}.turnDetection.threshold` };
    try {
      const screen = await renderScreen(React.createElement(RealtimeProviderFields, {
        providerId, descriptor,
        owner: {
          schemaVersion: settings.schemaVersion, defaultConfig: settings.defaultConfig,
          parseConfig(value: unknown) {
            const parsed = settings.parseConfig(value);
            return isConfigRecord(parsed) ? parsed : null;
          },
        },
        config: settings.defaultConfig, credentialStatus: 'ready',
        catalog: { phase: 'idle' }, onRequestCatalog: vi.fn(),
      }));
      expect(screen.tree.findAll((node) => node.props.testID === 'voice-realtime-field-turnDetection-threshold').length).toBeGreaterThan(0);
    } finally { searchRoute.params = {}; }
  });
  it('holds the shared playback lease for a native catalog preview and releases it on completion', async () => {
    audioPreview.create.mockImplementation(() => audioPreview);
    audioPreview.create.mockClear();
    audioPreview.play.mockClear();
    audioPreview.remove.mockClear();
    audioPreview.addListener.mockClear();
    playbackAudioMode.acquire.mockClear();
    playbackAudioMode.release.mockClear();
    let onPlaybackStatusUpdate: ((status: Readonly<{ didJustFinish?: boolean }>) => void) | null = null;
    audioPreview.addListener.mockImplementationOnce(((_event: string, listener: (status: Readonly<{ didJustFinish?: boolean }>) => void) => {
      onPlaybackStatusUpdate = listener;
      return { remove: vi.fn() };
    }) as any);
    const catalogOwner = {
      schemaVersion: 1,
      defaultConfig: { voice: { kind: 'catalog', id: 'voice_a' } },
      parseConfig(value: unknown) { return value && typeof value === 'object' ? value as any : null; },
    };
    const descriptor = parseRealtimeSettingsDescriptor('fixture_realtime', {
      kind: 'voice.provider-settings.v1', modes: ['byo'],
      credential: { kind: 'api_key', catalog: null }, links: {},
      fields: [{ kind: 'voice_catalog', path: 'voice', titleKey: 'fixture.voice' }],
    });
    if (!descriptor) throw new Error('invalid fixture descriptor');
    const { RealtimeProviderFields } = await import('./RealtimeProviderFields');
    const screen = await renderScreen(React.createElement(RealtimeProviderFields, {
      providerId: 'fixture_realtime', descriptor, owner: catalogOwner,
      config: catalogOwner.defaultConfig, credentialStatus: 'ready',
      catalog: { phase: 'ready', rows: [{ id: 'voice_a', name: 'Voice A', previewUrl: 'https://example.test/a.mp3' }] },
      onRequestCatalog: vi.fn(),
    }));

    const preview = screen.tree.findByProps({ testID: 'voice-realtime-field-voice' }).props.items[0].rightElement;
    act(() => preview.props.onPress({ stopPropagation: vi.fn() }));
    await vi.waitFor(() => expect(audioPreview.play).toHaveBeenCalledTimes(1));
    expect(audioPreview.create).toHaveBeenCalledWith(
      'https://example.test/a.mp3',
      { keepAudioSessionActive: true },
    );
    expect(playbackAudioMode.acquire).toHaveBeenCalledWith('realtime-catalog-preview');

    act(() => onPlaybackStatusUpdate?.({ didJustFinish: true }));
    await vi.waitFor(() => expect(playbackAudioMode.release).toHaveBeenCalledTimes(1));
  });

  it('renders provider-owned fields without provider-id or path-specific host branches', async () => {
    const descriptor = parseRealtimeSettingsDescriptor('fixture_realtime', {
      kind: 'voice.provider-settings.v1',
      modes: ['byo'],
      credential: { kind: 'api_key', catalog: null },
      links: {},
      fields: [
        {
          kind: 'model', path: 'model', titleKey: 'fixture.model', subtitleKey: 'fixture.model.help',
          options: [{ kind: 'pinned', id: 'stable' }, { kind: 'moving_alias', id: 'latest' }],
        },
        {
          kind: 'privacy_opt_in', path: 'resumptionEnabled', titleKey: 'fixture.resume',
          subtitleKey: 'fixture.resume.help',
          forgetAction: 'forget_provider_conversation',
        },
      ],
    });
    if (!descriptor) throw new Error('invalid fixture descriptor');
    const { RealtimeProviderFields } = await import('./RealtimeProviderFields');
    const screen = await renderScreen(React.createElement(RealtimeProviderFields, {
      providerId: 'fixture_realtime', descriptor, owner,
      config: owner.defaultConfig,
      credentialStatus: 'ready', catalog: { phase: 'ready', rows: [] },
      onRequestCatalog: vi.fn(),
    }));

    const model = screen.tree.findByProps({ testID: 'voice-realtime-field-model' });
    expect(model.props.items.map((item: { id: string }) => item.id)).toEqual(['pinned:stable', 'moving_alias:latest']);
    const privacyItem = screen.tree.findByProps({ testID: 'voice-realtime-field-resumptionEnabled' });
    const privacySwitch = privacyItem.props.rightElement;
    expect(privacyItem.props.title).toBe('fixture.resume');
    expect(privacySwitch.props.accessibilityLabel).toBe(privacyItem.props.title);
  });

  it('coalesces destructive provider actions while one request is in flight', async () => {
    let release!: () => void;
    action.mockImplementationOnce(async () => await new Promise<any>((resolve) => {
      release = () => resolve({ status: 'completed' });
    }));
    const descriptor = parseRealtimeSettingsDescriptor('fixture_realtime', {
      kind: 'voice.provider-settings.v1', modes: ['byo'],
      credential: { kind: 'api_key', catalog: null }, links: {},
      fields: [{
        kind: 'privacy_opt_in', path: 'resumptionEnabled', titleKey: 'fixture.resume',
        subtitleKey: 'fixture.resume.help',
        forgetAction: 'forget_provider_conversation',
      }],
    });
    if (!descriptor) throw new Error('invalid fixture descriptor');
    const { RealtimeProviderFields } = await import('./RealtimeProviderFields');
    const screen = await renderScreen(React.createElement(RealtimeProviderFields, {
      providerId: 'fixture_realtime', descriptor, owner,
      config: { model: { kind: 'pinned', id: 'stable' }, resumptionEnabled: true },
      credentialStatus: 'ready',
      catalog: { phase: 'ready', rows: [] }, onRequestCatalog: vi.fn(),
    }));
    const forget = screen.tree.findByProps({ testID: 'voice-realtime-forget-provider-conversation' });
    act(() => {
      forget.props.onPress();
      forget.props.onPress();
    });
    expect(action).toHaveBeenCalledTimes(1);
    await act(async () => release());
  });

  it('shows a failure result when a provider privacy action rejects', async () => {
    action.mockRejectedValueOnce(new Error('provider unavailable'));
    const { Modal } = await import('@/modal');
    const descriptor = parseRealtimeSettingsDescriptor('fixture_realtime', {
      kind: 'voice.provider-settings.v1', modes: ['byo'],
      credential: { kind: 'api_key', catalog: null }, links: {},
      fields: [{
        kind: 'privacy_opt_in', path: 'resumptionEnabled', titleKey: 'fixture.resume',
        forgetAction: 'forget_provider_conversation',
      }],
    });
    if (!descriptor) throw new Error('invalid fixture descriptor');
    const { RealtimeProviderFields } = await import('./RealtimeProviderFields');
    const screen = await renderScreen(React.createElement(RealtimeProviderFields, {
      providerId: 'fixture_realtime', descriptor, owner,
      config: { model: { kind: 'pinned', id: 'stable' }, resumptionEnabled: true },
      credentialStatus: 'ready',
      catalog: { phase: 'idle' }, onRequestCatalog: vi.fn(),
    }));
    await act(async () => {
      screen.tree.findByProps({ testID: 'voice-realtime-forget-provider-conversation' }).props.onPress();
      await vi.waitFor(() => expect(Modal.alertAsync).toHaveBeenCalledWith(
        'common.error',
        'settingsVoice.realtimeProviders.resumption.failed',
      ));
    });
  });

  it('keeps catalog preview controls accessible without provider-specific host UI', async () => {
    const catalogOwner = {
      schemaVersion: 1,
      defaultConfig: { voice: { kind: 'catalog', id: 'voice_a' } },
      parseConfig(value: unknown) { return value && typeof value === 'object' ? value as any : null; },
    };
    const descriptor = parseRealtimeSettingsDescriptor('fixture_realtime', {
      kind: 'voice.provider-settings.v1', modes: ['byo'],
      credential: { kind: 'api_key', catalog: 'voices' }, links: {},
      fields: [{ kind: 'voice_catalog', path: 'voice', titleKey: 'fixture.voice', subtitleKey: 'fixture.voice.help' }],
    });
    if (!descriptor) throw new Error('invalid fixture descriptor');
    const { RealtimeProviderFields } = await import('./RealtimeProviderFields');
    const screen = await renderScreen(React.createElement(RealtimeProviderFields, {
      providerId: 'fixture_realtime', descriptor, owner: catalogOwner,
      config: catalogOwner.defaultConfig, credentialStatus: 'ready',
      catalog: { phase: 'ready', rows: [{ id: 'voice_a', name: 'Voice A', previewUrl: 'https://example.test/a.mp3' }] },
      onRequestCatalog: vi.fn(),
    }));
    const dropdown = screen.tree.findByProps({ testID: 'voice-realtime-field-voice' });
    const preview = dropdown.props.items[0].rightElement;
    expect(preview.props.accessibilityRole).toBe('button');
    expect(preview.props.accessibilityLabel).toContain('Voice A');
    expect(preview.props.style).toEqual(expect.objectContaining({ minWidth: 44, minHeight: 44 }));
  });

  it('does not start a stale catalog preview after the selected provider changes', async () => {
    audioPreview.play.mockClear();
    audioPreview.remove.mockClear();
    const catalogOwner = {
      schemaVersion: 1,
      defaultConfig: { voice: { kind: 'catalog', id: 'voice_a' } },
      parseConfig(value: unknown) { return value && typeof value === 'object' ? value as any : null; },
    };
    const descriptor = parseRealtimeSettingsDescriptor('fixture_realtime', {
      kind: 'voice.provider-settings.v1', modes: ['byo'],
      credential: { kind: 'api_key', catalog: 'voices' }, links: {},
      fields: [{ kind: 'voice_catalog', path: 'voice', titleKey: 'fixture.voice' }],
    });
    if (!descriptor) throw new Error('invalid fixture descriptor');
    const { RealtimeProviderFields } = await import('./RealtimeProviderFields');
    const render = (providerId: string) => React.createElement(RealtimeProviderFields, {
      providerId, descriptor, owner: catalogOwner, config: catalogOwner.defaultConfig,
      credentialStatus: 'ready', onRequestCatalog: vi.fn(),
      catalog: { phase: 'ready' as const, rows: [{ id: 'voice_a', name: 'Voice A', previewUrl: 'https://example.test/a.mp3' }] },
    });
    const screen = await renderScreen(render('fixture_realtime'));
    const preview = screen.tree.findByProps({ testID: 'voice-realtime-field-voice' }).props.items[0].rightElement;
    act(() => preview.props.onPress({ stopPropagation: vi.fn() }));
    await screen.update(render('another_provider'));
    await act(async () => undefined);
    expect(audioPreview.play).not.toHaveBeenCalled();
  });

  it('lets the shared scoped Stop operation stop a sample started by the catalog picker', async () => {
    audioPreview.play.mockClear();
    audioPreview.remove.mockClear();
    audioPreview.create.mockReturnValue({ play: audioPreview.play, remove: audioPreview.remove, addListener: audioPreview.addListener });
    const descriptor = parseRealtimeSettingsDescriptor('fixture_realtime', {
      kind: 'voice.provider-settings.v1', modes: ['byo'], credential: { kind: 'api_key', catalog: 'voices' }, links: {},
      fields: [{ kind: 'voice_catalog', path: 'voice', titleKey: 'fixture.voice' }],
    });
    if (!descriptor) throw new Error('invalid fixture descriptor');
    const screen = await renderScreen(React.createElement(RealtimeProviderFields, {
      providerId: 'fixture_realtime', descriptor,
      owner: { schemaVersion: 1, defaultConfig: { voice: 'voice_a' }, parseConfig: value => value && typeof value === 'object' && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : null },
      config: { voice: 'voice_a' }, credentialStatus: 'ready', onRequestCatalog: vi.fn(),
      catalog: { phase: 'ready', rows: [{ id: 'voice_a', name: 'Voice A', previewUrl: 'https://example.test/a.mp3' }] },
    }));
    const preview = screen.tree.findByProps({ testID: 'voice-realtime-field-voice' }).props.items[0].rightElement;
    await act(async () => { preview.props.onPress({ stopPropagation: vi.fn() }); });
    await vi.waitFor(() => expect(audioPreview.play).toHaveBeenCalled());
    const { stopRealtimeCatalogPreview } = await import('./catalogPreview');
    expect(stopRealtimeCatalogPreview('another_provider')).toBe(false);
    expect(audioPreview.remove).not.toHaveBeenCalled();
    await act(async () => { expect(stopRealtimeCatalogPreview('fixture_realtime')).toBe(true); });
    expect(audioPreview.remove).toHaveBeenCalled();
    await screen.unmount();
  });

  it('keeps provider-declared advanced VAD tuning collapsed until explicitly expanded', async () => {
    const vadOwner = {
      schemaVersion: 1,
      defaultConfig: { turnDetection: { threshold: null } },
      parseConfig(value: unknown) { return value && typeof value === 'object' ? value as any : null; },
    };
    const descriptor = parseRealtimeSettingsDescriptor('fixture_realtime', {
      kind: 'voice.provider-settings.v1', modes: ['byo'],
      credential: { kind: 'api_key', catalog: null }, links: {},
      fields: [{
        kind: 'server_vad', path: 'turnDetection', advanced: true,
        titleKey: 'fixture.vad', subtitleKey: 'fixture.vad.help',
        subfields: [{ kind: 'number', path: 'turnDetection.threshold', titleKey: 'fixture.threshold' }],
      }],
    });
    if (!descriptor) throw new Error('invalid fixture descriptor');
    const { RealtimeProviderFields } = await import('./RealtimeProviderFields');
    const screen = await renderScreen(React.createElement(RealtimeProviderFields, {
      providerId: 'fixture_realtime', descriptor, owner: vadOwner,
      config: vadOwner.defaultConfig, credentialStatus: 'ready',
      catalog: { phase: 'idle' }, onRequestCatalog: vi.fn(),
    }));
    expect(screen.tree.findAllByProps({ testID: 'voice-realtime-field-turnDetection-threshold' })).toHaveLength(0);
    const disclosure = screen.tree.findByProps({ testID: 'voice-realtime-advanced-turnDetection' });
    expect(disclosure.props.accessibilityLabel).toContain('settingsVoice.realtimeProviders.advanced.show');
    act(() => disclosure.props.onPress());
    expect(screen.tree.findByProps({ testID: 'voice-realtime-field-turnDetection-threshold' })).toBeTruthy();
  });

  it('keeps nested interactive settings controls outside parent row pressables on web', async () => {
    const catalogOwner = {
      schemaVersion: 1,
      defaultConfig: { voice: { kind: 'catalog', id: 'voice_a' }, resumptionEnabled: false },
      parseConfig(value: unknown) { return value && typeof value === 'object' ? value as any : null; },
    };
    const descriptor = parseRealtimeSettingsDescriptor('fixture_realtime', {
      kind: 'voice.provider-settings.v1', modes: ['byo'],
      credential: { kind: 'api_key', catalog: 'voices' }, links: {},
      fields: [
        { kind: 'voice_catalog', path: 'voice', titleKey: 'fixture.voice' },
        { kind: 'privacy_opt_in', path: 'resumptionEnabled', titleKey: 'fixture.resume' },
      ],
    });
    if (!descriptor) throw new Error('invalid fixture descriptor');
    const { RealtimeProviderFields } = await import('./RealtimeProviderFields');
    const screen = await renderScreen(React.createElement(RealtimeProviderFields, {
      providerId: 'fixture_realtime', descriptor, owner: catalogOwner,
      config: catalogOwner.defaultConfig, credentialStatus: 'ready',
      catalog: { phase: 'ready', rows: [{ id: 'voice_a', name: 'Voice A', previewUrl: 'https://example.test/a.mp3' }] },
      onRequestCatalog: vi.fn(),
    }));
    expect(screen.tree.findByProps({ testID: 'voice-realtime-field-resumptionEnabled' }).props.rightElementOutsidePressable).toBe(true);
    expect(screen.tree.findByProps({ testID: 'voice-realtime-field-voice' }).props.itemRowProps).toEqual(
      expect.objectContaining({ rightElementOutsidePressable: true }),
    );
  });

  it('suppresses a stale provider-action result after the selected provider changes', async () => {
    let resolveAction!: (value: { status: 'completed' }) => void;
    action.mockImplementationOnce(async () => await new Promise((resolve) => { resolveAction = resolve; }));
    const { Modal } = await import('@/modal');
    vi.mocked(Modal.alertAsync).mockClear();
    const descriptor = parseRealtimeSettingsDescriptor('fixture_realtime', {
      kind: 'voice.provider-settings.v1', modes: ['byo'],
      credential: { kind: 'api_key', catalog: null }, links: {},
      fields: [{ kind: 'privacy_opt_in', path: 'resumptionEnabled', titleKey: 'fixture.resume', forgetAction: 'forget_provider_conversation' }],
    });
    if (!descriptor) throw new Error('invalid fixture descriptor');
    const { RealtimeProviderFields } = await import('./RealtimeProviderFields');
    const render = (providerId: string) => React.createElement(RealtimeProviderFields, {
      providerId, descriptor, owner,
      config: { model: { kind: 'pinned', id: 'stable' }, resumptionEnabled: true },
      credentialStatus: 'ready', catalog: { phase: 'idle' as const }, onRequestCatalog: vi.fn(),
    });
    const screen = await renderScreen(render('fixture_realtime'));
    act(() => screen.tree.findByProps({ testID: 'voice-realtime-forget-provider-conversation' }).props.onPress());
    await screen.update(render('another_provider'));
    await act(async () => resolveAction({ status: 'completed' }));
    expect(Modal.alertAsync).not.toHaveBeenCalled();
  });

  it('renders language hints from canonical locale facts instead of raw translation keys', async () => {
    const languageOwner = {
      schemaVersion: 1,
      defaultConfig: { language: null },
      parseConfig(value: unknown) { return value && typeof value === 'object' ? value as any : null; },
    };
    const descriptor = parseRealtimeSettingsDescriptor('fixture_realtime', {
      kind: 'voice.provider-settings.v1', modes: ['byo'],
      credential: { kind: 'api_key', catalog: null }, links: {},
      fields: [{ kind: 'language_hint', path: 'language', titleKey: 'fixture.language', options: ['en', 'ar-EG', 'pt-BR', 'bn'] }],
    });
    if (!descriptor) throw new Error('invalid fixture descriptor');
    const { RealtimeProviderFields } = await import('./RealtimeProviderFields');
    const screen = await renderScreen(React.createElement(RealtimeProviderFields, {
      providerId: 'fixture_realtime', descriptor, owner: languageOwner,
      config: languageOwner.defaultConfig, credentialStatus: 'ready',
      catalog: { phase: 'idle' }, onRequestCatalog: vi.fn(),
    }));
    const rows = screen.tree.findByProps({ testID: 'voice-realtime-field-language' }).props.items;
    expect(rows[0]?.title).toBe('settingsVoice.realtimeProviders.options.automatic');
    for (const row of rows.slice(1)) {
      expect(row.title).not.toBe(row.id);
      expect(String(row.title)).not.toMatch(/^settingsVoice\./u);
    }
  });
});
