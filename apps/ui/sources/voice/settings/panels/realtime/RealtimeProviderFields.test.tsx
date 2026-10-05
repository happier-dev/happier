import React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import { parseRealtimeSettingsDescriptor } from './descriptor';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

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

/** The inline field of a descriptor row (the row is a mocked Item, so its field is its right element). */
function fieldInput(screen: Awaited<ReturnType<typeof renderScreen>>, rowTestID: string) {
  const row = screen.tree.findAll((node) => node.props.testID === rowTestID && node.props.rightElement !== undefined)[0];
  if (!row) throw new Error(`missing field row ${rowTestID}`);
  return row.props.rightElement as React.ReactElement<any>;
}

async function typeIntoField(screen: Awaited<ReturnType<typeof renderScreen>>, rowTestID: string, text: string) {
  await act(async () => { fieldInput(screen, rowTestID).props.onChangeText(text); });
  await act(async () => { fieldInput(screen, rowTestID).props.onBlur(); });
}

function isConfigRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

describe('RealtimeProviderFields', () => {
  it('adjusts a nullable range and restores the service default without overwriting neighboring settings', async () => {
    const { Slider } = await import('@/components/ui/forms/Slider');
    const descriptor = parseRealtimeSettingsDescriptor('acme.range', {
      kind: 'voice.provider-settings.v1', modes: ['byo'], credential: { kind: 'none', catalog: null }, links: {},
      fields: [{ kind: 'range', path: 'speed', min: 0.7, max: 1.2, step: 0.1, nullable: true, defaultValue: 1, titleKey: 'Speed' }],
    });
    if (!descriptor) throw new Error('invalid range descriptor');
    const onConfigChange = vi.fn();
    const config: Record<string, unknown> = { ...owner.defaultConfig, speed: null };
    const render = (next: typeof config) => <RealtimeProviderFields providerId="acme.range" descriptor={descriptor}
      owner={owner} config={next} onConfigChange={onConfigChange} credentialStatus="ready"
      catalog={{ phase: 'idle' }} onRequestCatalog={vi.fn()} />;
    const screen = await renderScreen(render(config));
    const slider = screen.findAllByType(Slider)[0]!;
    expect(slider).toBeDefined();
    expect(slider.props.value).toBe(1);
    await act(async () => slider.props.onValueChange(1.1));
    expect(onConfigChange).toHaveBeenLastCalledWith({ ...config, speed: 1.1 });
    await screen.update(render({ ...config, speed: 1.1 }));
    const reset = screen.tree.findAll((node) => node.props.testID === 'voice-realtime-field-speed.default' && typeof node.props.onPress === 'function')[0]!;
    await act(async () => reset.props.onPress());
    expect(onConfigChange).toHaveBeenLastCalledWith(config);
  });
  it('explains when an immediate native greeting has no Reply in literal without changing the choice', async () => {
    const { ELEVENLABS_SETTINGS_SECTION } = await import('../../../../../../../packages/plugins/elevenlabs/src/voiceSettingsPresentation');
    const descriptor = parseRealtimeSettingsDescriptor('acme.native-greeting', ELEVENLABS_SETTINGS_SECTION);
    if (!descriptor) throw new Error('missing native greeting presentation');
    const onWelcomeSelection = vi.fn();
    const onConfigChange = vi.fn();
    const screen = await renderScreen(React.createElement(RealtimeProviderFields, {
      providerId: 'acme.native-greeting', descriptor: { ...descriptor, fields: descriptor.fields.filter((field) => field.kind === 'welcome') },
      owner, config: owner.defaultConfig, onConfigChange, credentialStatus: 'ready',
      catalog: { phase: 'idle' }, onRequestCatalog: vi.fn(),
      welcomeSelection: 'immediate', assistantLanguage: 'ar-SA', onWelcomeSelection,
    }));
    // The service's Greeting is the same shared choice Local voice shows (one control, one owner).
    const row = screen.tree.findAll((node) => node.props?.testIDPrefix === 'settings.voice.greeting' && Array.isArray(node.props?.options))[0]!;
    expect(row.props.options.map((option: { id: string }) => option.id)).toEqual(['off', 'immediate', 'on_first_turn']);
    expect(row.props.value).toBe('immediate');
    expect(row.props.options.find((option: { id: string }) => option.id === 'immediate').description).toBe('voicePresence.greetingLiteralUnavailable');
    expect(onWelcomeSelection).not.toHaveBeenCalled();
    expect(onConfigChange).not.toHaveBeenCalled();
  });
  it('reveals a contributed VAD subfield from search without changing its provider settings', async () => {
    const { voiceSettingsDeclarationRegistry } = await import('@/voice/settings/voiceContributedSettingsDeclarations');
    const providerId = 'happier.voice.xai/realtime-grok';
    const entry = voiceSettingsDeclarationRegistry.get(providerId);
    const settings = entry?.providerSettings;
    const descriptor = parseRealtimeSettingsDescriptor(providerId, settings?.presentation);
    if (!descriptor || !settings) throw new Error('Missing admitted xAI settings');
    searchRoute.params = { setting: `voiceConversations.provider.${providerId}.turnDetection.threshold` };
    const onConfigChange = vi.fn();
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
        config: settings.defaultConfig, onConfigChange, credentialStatus: 'ready',
        catalog: { phase: 'idle' }, onRequestCatalog: vi.fn(),
      }));
      expect(screen.tree.findAll((node) => node.props.testID === 'voice-realtime-field-turnDetection-threshold').length).toBeGreaterThan(0);
      expect(onConfigChange).not.toHaveBeenCalled();
    } finally { searchRoute.params = {}; }
  });
  it('saves a scalar catalog voice through the provider schema rather than a structured selection', async () => {
    const { OpenAiRealtimeSettingsV1Schema } = await import('../../../../../../../packages/plugins/openai/src/protocol/voice/settings');
    const config = OpenAiRealtimeSettingsV1Schema.parse({});
    const scalarOwner = {
      schemaVersion: 1, defaultConfig: config,
      parseConfig(value: unknown) {
        const result = OpenAiRealtimeSettingsV1Schema.safeParse(value);
        return result.success ? result.data : null;
      },
    };
    const descriptor = parseRealtimeSettingsDescriptor('acme.scalar', {
      kind: 'voice.provider-settings.v1', modes: ['byo'],
      credential: { kind: 'api_key', catalog: 'voices' }, links: {},
      fields: [{ kind: 'voice_catalog', path: 'voice', valueShape: 'string', customIdAllowed: true }],
    });
    expect(descriptor).not.toBeNull();
    if (!descriptor) throw new Error('invalid scalar catalog descriptor');
    const onConfigChange = vi.fn();
    const { RealtimeProviderFields } = await import('./RealtimeProviderFields');
    const screen = await renderScreen(React.createElement(RealtimeProviderFields, {
      providerId: 'acme.scalar', descriptor, owner: scalarOwner, config, onConfigChange,
      credentialStatus: 'ready', catalog: { phase: 'ready', rows: [{ id: 'cedar', name: 'Cedar' }] },
      onRequestCatalog: vi.fn(),
    }));
    await act(async () => screen.tree.findByProps({ testID: 'voice-realtime-field-voice' }).props.onSelect('cedar'));
    expect(onConfigChange).toHaveBeenCalledWith(expect.objectContaining({ voice: 'cedar' }));
  });
  it('keeps a custom pinned model editable through the curated model field', async () => {
    const descriptor = parseRealtimeSettingsDescriptor('acme.model', {
      kind: 'voice.provider-settings.v1', modes: ['byo'],
      credential: { kind: 'none', catalog: null }, links: {},
      fields: [{ kind: 'model', path: 'model', customIdAllowed: true, options: [{ kind: 'pinned', id: 'stable' }] }],
    });
    if (!descriptor) throw new Error('invalid model descriptor');
    const onConfigChange = vi.fn();
    const { RealtimeProviderFields } = await import('./RealtimeProviderFields');
    const screen = await renderScreen(React.createElement(RealtimeProviderFields, {
      providerId: 'acme.model', descriptor, owner, config: owner.defaultConfig, onConfigChange,
      credentialStatus: 'ready', catalog: { phase: 'idle' }, onRequestCatalog: vi.fn(),
    }));
    await act(async () => screen.tree.findByProps({ testID: 'voice-realtime-field-model' }).props.onSelect('__custom__'));
    await typeIntoField(screen, 'voice-realtime-field-model.custom', 'snapshot-specific');
    expect(onConfigChange).toHaveBeenCalledWith(expect.objectContaining({ model: { kind: 'pinned', id: 'snapshot-specific' } }));
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
      config: catalogOwner.defaultConfig, onConfigChange: vi.fn(), credentialStatus: 'ready',
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
    const onConfigChange = vi.fn();
    const { RealtimeProviderFields } = await import('./RealtimeProviderFields');
    const screen = await renderScreen(React.createElement(RealtimeProviderFields, {
      providerId: 'fixture_realtime', descriptor, owner,
      config: owner.defaultConfig, onConfigChange,
      credentialStatus: 'ready', catalog: { phase: 'ready', rows: [] },
      onRequestCatalog: vi.fn(),
    }));

    const model = screen.tree.findByProps({ testID: 'voice-realtime-field-model' });
    await act(async () => model.props.onSelect('moving_alias:latest'));
    expect(onConfigChange).toHaveBeenCalledWith({
      model: { kind: 'moving_alias', id: 'latest' },
      resumptionEnabled: false,
    });

    const privacyItem = screen.tree.findByProps({ testID: 'voice-realtime-field-resumptionEnabled' });
    const privacySwitch = privacyItem.props.rightElement;
    expect(privacyItem.props.title).toBe('fixture.resume');
    expect(privacySwitch.props.accessibilityLabel).toBe(privacyItem.props.title);
    await act(async () => privacySwitch.props.onValueChange(true));
    expect(onConfigChange).toHaveBeenLastCalledWith({
      model: { kind: 'pinned', id: 'stable' },
      resumptionEnabled: true,
    });
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
      onConfigChange: vi.fn(), credentialStatus: 'ready',
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
      onConfigChange: vi.fn(), credentialStatus: 'ready',
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

  it('contains a rejected privacy confirmation instead of returning an unhandled event promise', async () => {
    const { Modal } = await import('@/modal');
    vi.mocked(Modal.confirm).mockRejectedValueOnce(new Error('modal unavailable'));
    vi.mocked(Modal.alertAsync).mockClear();
    const descriptor = parseRealtimeSettingsDescriptor('fixture_realtime', {
      kind: 'voice.provider-settings.v1', modes: ['byo'],
      credential: { kind: 'api_key', catalog: null }, links: {},
      fields: [{ kind: 'privacy_opt_in', path: 'resumptionEnabled', titleKey: 'fixture.resume' }],
    });
    if (!descriptor) throw new Error('invalid fixture descriptor');
    const { RealtimeProviderFields } = await import('./RealtimeProviderFields');
    const onConfigChange = vi.fn();
    const screen = await renderScreen(React.createElement(RealtimeProviderFields, {
      providerId: 'fixture_realtime', descriptor, owner,
      config: owner.defaultConfig, onConfigChange, credentialStatus: 'ready',
      catalog: { phase: 'idle' }, onRequestCatalog: vi.fn(),
    }));
    const toggle = screen.tree.findByProps({ testID: 'voice-realtime-field-resumptionEnabled' }).props.rightElement;
    let eventResult: unknown;
    act(() => { eventResult = toggle.props.onValueChange(true); });
    expect(eventResult).toBeUndefined();
    await vi.waitFor(() => expect(Modal.alertAsync).toHaveBeenCalledWith(
      'common.error',
      'settingsVoice.realtimeProviders.operationFailed',
    ));
    expect(onConfigChange).not.toHaveBeenCalled();
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
      config: catalogOwner.defaultConfig, onConfigChange: vi.fn(), credentialStatus: 'ready',
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
      onConfigChange: vi.fn(), credentialStatus: 'ready', onRequestCatalog: vi.fn(),
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
      config: { voice: 'voice_a' }, onConfigChange: vi.fn(), credentialStatus: 'ready', onRequestCatalog: vi.fn(),
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

  it('merges an inline text value into the latest same-provider config instead of reviving a stale snapshot', async () => {
    const { Modal } = await import('@/modal');
    vi.mocked(Modal.prompt).mockClear();
    const descriptor = parseRealtimeSettingsDescriptor('fixture_realtime', {
      kind: 'voice.provider-settings.v1', modes: ['byo'],
      credential: { kind: 'api_key', catalog: null }, links: {},
      fields: [{ kind: 'instructions', path: 'instructions', titleKey: 'fixture.instructions' }],
    });
    if (!descriptor) throw new Error('invalid fixture descriptor');
    const onConfigChange = vi.fn();
    const { RealtimeProviderFields } = await import('./RealtimeProviderFields');
    const initial = { model: { kind: 'pinned', id: 'stable' }, resumptionEnabled: false, instructions: null };
    const latest = { model: { kind: 'moving_alias', id: 'latest' }, resumptionEnabled: true, instructions: null };
    const render = (config: typeof initial) => React.createElement(RealtimeProviderFields, {
      providerId: 'fixture_realtime', descriptor, owner, config, onConfigChange,
      credentialStatus: 'ready', catalog: { phase: 'idle' as const }, onRequestCatalog: vi.fn(),
    });
    const screen = await renderScreen(render(initial));
    await act(async () => { fieldInput(screen, 'voice-realtime-field-instructions').props.onChangeText('new guidance'); });
    await screen.update(render(latest));
    await act(async () => { fieldInput(screen, 'voice-realtime-field-instructions').props.onBlur(); });
    expect(Modal.prompt).not.toHaveBeenCalled();
    expect(onConfigChange).toHaveBeenLastCalledWith({ ...latest, instructions: 'new guidance' });
  });

  it('edits provider key terms inline and saves them as a de-duplicated list', async () => {
    const termsOwner = {
      schemaVersion: 1,
      defaultConfig: { keyterms: [] as string[] },
      parseConfig(value: unknown) { return value && typeof value === 'object' ? value as any : null; },
    };
    const descriptor = parseRealtimeSettingsDescriptor('fixture_realtime', {
      kind: 'voice.provider-settings.v1', modes: ['byo'],
      credential: { kind: 'api_key', catalog: null }, links: {},
      fields: [{ kind: 'keyterms', path: 'keyterms', titleKey: 'fixture.keyterms' }],
    });
    if (!descriptor) throw new Error('invalid fixture descriptor');
    const onConfigChange = vi.fn();
    const { RealtimeProviderFields } = await import('./RealtimeProviderFields');
    const screen = await renderScreen(React.createElement(RealtimeProviderFields, {
      providerId: 'fixture_realtime', descriptor, owner: termsOwner,
      config: termsOwner.defaultConfig, onConfigChange, credentialStatus: 'ready',
      catalog: { phase: 'idle' }, onRequestCatalog: vi.fn(),
    }));
    await typeIntoField(screen, 'voice-realtime-field-keyterms', 'Happier, daemon ,happier');
    expect(onConfigChange).toHaveBeenLastCalledWith({ keyterms: ['happier', 'daemon'] });
  });

  it('types a custom voice id inline after choosing Custom in the voice menu', async () => {
    const catalogOwner = {
      schemaVersion: 1,
      defaultConfig: { voice: { kind: 'catalog', id: 'voice_a' } },
      parseConfig(value: unknown) { return value && typeof value === 'object' ? value as any : null; },
    };
    const descriptor = parseRealtimeSettingsDescriptor('fixture_realtime', {
      kind: 'voice.provider-settings.v1', modes: ['byo'],
      credential: { kind: 'api_key', catalog: 'voices' }, links: {},
      fields: [{ kind: 'voice_catalog', path: 'voice', titleKey: 'fixture.voice', customIdAllowed: true }],
    });
    if (!descriptor) throw new Error('invalid fixture descriptor');
    const { Modal } = await import('@/modal');
    vi.mocked(Modal.prompt).mockClear();
    const onConfigChange = vi.fn();
    const { RealtimeProviderFields } = await import('./RealtimeProviderFields');
    const screen = await renderScreen(React.createElement(RealtimeProviderFields, {
      providerId: 'fixture_realtime', descriptor, owner: catalogOwner,
      config: catalogOwner.defaultConfig, onConfigChange, credentialStatus: 'ready',
      catalog: { phase: 'ready', rows: [{ id: 'voice_a', name: 'Voice A' }] },
      onRequestCatalog: vi.fn(),
    }));
    act(() => screen.tree.findByProps({ testID: 'voice-realtime-field-voice' }).props.onSelect('__custom__'));
    await typeIntoField(screen, 'voice-realtime-field-voice.custom', 'my-cloned-voice');
    expect(Modal.prompt).not.toHaveBeenCalled();
    expect(onConfigChange).toHaveBeenLastCalledWith({ voice: { kind: 'custom', id: 'my-cloned-voice' } });
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
      config: vadOwner.defaultConfig, onConfigChange: vi.fn(), credentialStatus: 'ready',
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
      config: catalogOwner.defaultConfig, onConfigChange: vi.fn(), credentialStatus: 'ready',
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
      onConfigChange: vi.fn(), credentialStatus: 'ready', catalog: { phase: 'idle' as const }, onRequestCatalog: vi.fn(),
    });
    const screen = await renderScreen(render('fixture_realtime'));
    act(() => screen.tree.findByProps({ testID: 'voice-realtime-forget-provider-conversation' }).props.onPress());
    await screen.update(render('another_provider'));
    await act(async () => resolveAction({ status: 'completed' }));
    expect(Modal.alertAsync).not.toHaveBeenCalled();
  });

  it('enforces provider-declared numeric step metadata on the inline field before persisting', async () => {
    const { Modal } = await import('@/modal');
    vi.mocked(Modal.alert).mockClear();
    const speedOwner = {
      schemaVersion: 1,
      defaultConfig: { speed: 1 },
      parseConfig(value: unknown) { return value && typeof value === 'object' ? value as any : null; },
    };
    const descriptor = parseRealtimeSettingsDescriptor('fixture_realtime', {
      kind: 'voice.provider-settings.v1', modes: ['byo'],
      credential: { kind: 'api_key', catalog: null }, links: {},
      fields: [{ kind: 'number', path: 'speed', min: 0.7, max: 1.5, step: 0.05, titleKey: 'fixture.speed' }],
    });
    if (!descriptor) throw new Error('invalid fixture descriptor');
    const onConfigChange = vi.fn();
    const { RealtimeProviderFields } = await import('./RealtimeProviderFields');
    const screen = await renderScreen(React.createElement(RealtimeProviderFields, {
      providerId: 'fixture_realtime', descriptor, owner: speedOwner,
      config: speedOwner.defaultConfig, onConfigChange, credentialStatus: 'ready',
      catalog: { phase: 'idle' }, onRequestCatalog: vi.fn(),
    }));
    await typeIntoField(screen, 'voice-realtime-field-speed', '1.23');
    expect(Modal.alert).toHaveBeenCalled();
    expect(onConfigChange).not.toHaveBeenCalled();
    expect(fieldInput(screen, 'voice-realtime-field-speed').props.value).toBe('1');

    await typeIntoField(screen, 'voice-realtime-field-speed', '1.25');
    expect(onConfigChange).toHaveBeenLastCalledWith({ speed: 1.25 });
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
      config: languageOwner.defaultConfig, onConfigChange: vi.fn(), credentialStatus: 'ready',
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
