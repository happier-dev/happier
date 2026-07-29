import React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import { parseRealtimeSettingsDescriptor } from './descriptor';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const action = vi.hoisted(() => vi.fn(async () => ({ status: 'completed' as const })));
const audioPreview = vi.hoisted(() => ({
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
  Item: (props: any) => React.createElement('Item', props),
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
vi.mock('@/text', () => ({
  t: (key: string, params?: { voice?: string }) => params?.voice ? `${key}:${params.voice}` : key,
  tLoose: (key: string) => key,
  getPreferredLanguage: () => 'en',
}));
vi.mock('@/modal', () => ({
  Modal: {
    prompt: vi.fn(async () => null),
    confirm: vi.fn(async () => true),
    alert: vi.fn(),
    alertAsync: vi.fn(async () => undefined),
  },
}));
vi.mock('@/voice/session/voiceAdapterRegistry', () => ({
  performVoiceAdapterRuntimeAction: action,
}));
vi.mock('expo-audio', () => ({
  createAudioPlayer: vi.fn(() => audioPreview),
}));
vi.mock('@/voice/runtime/voiceAudioMode', () => ({
  acquireVoicePlaybackAudioMode: playbackAudioMode.acquire,
}));

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

describe('RealtimeProviderFields', () => {
  it('persists a provider-declared Connected Services binding through the canonical config owner', async () => {
    const binding = {
      v: 1 as const,
      bindingsByServiceId: {
        'openai-codex': {
          source: 'connected' as const,
          selection: 'profile' as const,
          profileId: 'codex-account-a',
        },
      },
    };
    const connectedOwner = {
      schemaVersion: 2,
      defaultConfig: { globalConnectedServices: null },
      parseConfig(value: unknown) {
        return value && typeof value === 'object' && 'globalConnectedServices' in value
          ? value as Readonly<Record<string, unknown>>
          : null;
      },
    };
    const descriptor = parseRealtimeSettingsDescriptor('agent_realtime', {
      kind: 'voice.internal.realtime-settings.v1',
      providerId: 'agent_realtime',
      modes: ['happier'],
      credential: { kind: 'none', catalog: null },
      links: {},
      fields: [{
        kind: 'connected_services_binding',
        path: 'globalConnectedServices',
        agentId: 'codex',
        serviceIds: ['openai-codex'],
      }],
    });
    if (!descriptor) throw new Error('invalid fixture descriptor');
    const onConfigChange = vi.fn();
    const { RealtimeProviderFields } = await import('./RealtimeProviderFields');
    const screen = await renderScreen(React.createElement(RealtimeProviderFields, {
      providerId: 'agent_realtime',
      descriptor,
      owner: connectedOwner,
      config: connectedOwner.defaultConfig,
      onConfigChange,
      credentialExists: false,
      catalog: { phase: 'idle' },
      onRequestCatalog: vi.fn(),
      renderConnectedServicesBinding: (field, value, onChange) => React.createElement(
        'ConnectedServicesBinding',
        { field, value, onChange },
      ),
    }));

    const picker = screen.tree.findByType('ConnectedServicesBinding' as any);
    expect(picker.props.value).toBeNull();
    act(() => picker.props.onChange(binding));
    expect(onConfigChange).toHaveBeenCalledWith({
      globalConnectedServices: binding,
    });
  });

  it('holds the shared playback lease for a native catalog preview and releases it on completion', async () => {
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
      kind: 'voice.internal.realtime-settings.v1', providerId: 'fixture_realtime', mode: 'byo',
      credential: { kind: 'api_key', catalog: null }, links: {},
      fields: [{ kind: 'voice_catalog', path: 'voice', titleKey: 'fixture.voice' }],
    });
    if (!descriptor) throw new Error('invalid fixture descriptor');
    const { RealtimeProviderFields } = await import('./RealtimeProviderFields');
    const screen = await renderScreen(React.createElement(RealtimeProviderFields, {
      providerId: 'fixture_realtime', descriptor, owner: catalogOwner,
      config: catalogOwner.defaultConfig, onConfigChange: vi.fn(), credentialExists: true,
      catalog: { phase: 'ready', rows: [{ id: 'voice_a', name: 'Voice A', previewUrl: 'https://example.test/a.mp3' }] },
      onRequestCatalog: vi.fn(),
    }));

    const preview = screen.tree.findByProps({ testID: 'voice-realtime-field-voice' }).props.items[0].rightElement;
    act(() => preview.props.onPress({ stopPropagation: vi.fn() }));
    await vi.waitFor(() => expect(audioPreview.play).toHaveBeenCalledTimes(1));
    expect(playbackAudioMode.acquire).toHaveBeenCalledWith('realtime-catalog-preview');

    act(() => onPlaybackStatusUpdate?.({ didJustFinish: true }));
    await vi.waitFor(() => expect(playbackAudioMode.release).toHaveBeenCalledTimes(1));
  });

  it('renders provider-owned fields without provider-id or path-specific host branches', async () => {
    const descriptor = parseRealtimeSettingsDescriptor('fixture_realtime', {
      kind: 'voice.internal.realtime-settings.v1',
      providerId: 'fixture_realtime',
      mode: 'byo',
      credential: { kind: 'api_key', catalog: null },
      links: {},
      fields: [
        {
          kind: 'model', path: 'model', titleKey: 'fixture.model', subtitleKey: 'fixture.model.help',
          options: [{ kind: 'pinned', id: 'stable' }, { kind: 'moving_alias', id: 'latest' }],
        },
        {
          kind: 'privacy_opt_in', path: 'resumptionEnabled', titleKey: 'fixture.resume',
          subtitleKey: 'fixture.resume.help', retentionMinutes: 30,
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
      credentialExists: true, catalog: { phase: 'ready', rows: [] },
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
      kind: 'voice.internal.realtime-settings.v1', providerId: 'fixture_realtime', mode: 'byo',
      credential: { kind: 'api_key', catalog: null }, links: {},
      fields: [{
        kind: 'privacy_opt_in', path: 'resumptionEnabled', titleKey: 'fixture.resume',
        subtitleKey: 'fixture.resume.help', retentionMinutes: 30,
        forgetAction: 'forget_provider_conversation',
      }],
    });
    if (!descriptor) throw new Error('invalid fixture descriptor');
    const { RealtimeProviderFields } = await import('./RealtimeProviderFields');
    const screen = await renderScreen(React.createElement(RealtimeProviderFields, {
      providerId: 'fixture_realtime', descriptor, owner,
      config: { model: { kind: 'pinned', id: 'stable' }, resumptionEnabled: true },
      onConfigChange: vi.fn(), credentialExists: true,
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
      kind: 'voice.internal.realtime-settings.v1', providerId: 'fixture_realtime', mode: 'byo',
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
      onConfigChange: vi.fn(), credentialExists: true,
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
      kind: 'voice.internal.realtime-settings.v1', providerId: 'fixture_realtime', mode: 'byo',
      credential: { kind: 'api_key', catalog: null }, links: {},
      fields: [{ kind: 'privacy_opt_in', path: 'resumptionEnabled', titleKey: 'fixture.resume', retentionMinutes: 30 }],
    });
    if (!descriptor) throw new Error('invalid fixture descriptor');
    const { RealtimeProviderFields } = await import('./RealtimeProviderFields');
    const onConfigChange = vi.fn();
    const screen = await renderScreen(React.createElement(RealtimeProviderFields, {
      providerId: 'fixture_realtime', descriptor, owner,
      config: owner.defaultConfig, onConfigChange, credentialExists: true,
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
      kind: 'voice.internal.realtime-settings.v1', providerId: 'fixture_realtime', mode: 'byo',
      credential: { kind: 'api_key', catalog: 'voices' }, links: {},
      fields: [{ kind: 'voice_catalog', path: 'voice', titleKey: 'fixture.voice', subtitleKey: 'fixture.voice.help' }],
    });
    if (!descriptor) throw new Error('invalid fixture descriptor');
    const { RealtimeProviderFields } = await import('./RealtimeProviderFields');
    const screen = await renderScreen(React.createElement(RealtimeProviderFields, {
      providerId: 'fixture_realtime', descriptor, owner: catalogOwner,
      config: catalogOwner.defaultConfig, onConfigChange: vi.fn(), credentialExists: true,
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
      kind: 'voice.internal.realtime-settings.v1', providerId: 'fixture_realtime', mode: 'byo',
      credential: { kind: 'api_key', catalog: 'voices' }, links: {},
      fields: [{ kind: 'voice_catalog', path: 'voice', titleKey: 'fixture.voice' }],
    });
    if (!descriptor) throw new Error('invalid fixture descriptor');
    const { RealtimeProviderFields } = await import('./RealtimeProviderFields');
    const render = (providerId: string) => React.createElement(RealtimeProviderFields, {
      providerId, descriptor, owner: catalogOwner, config: catalogOwner.defaultConfig,
      onConfigChange: vi.fn(), credentialExists: true, onRequestCatalog: vi.fn(),
      catalog: { phase: 'ready' as const, rows: [{ id: 'voice_a', name: 'Voice A', previewUrl: 'https://example.test/a.mp3' }] },
    });
    const screen = await renderScreen(render('fixture_realtime'));
    const preview = screen.tree.findByProps({ testID: 'voice-realtime-field-voice' }).props.items[0].rightElement;
    act(() => preview.props.onPress({ stopPropagation: vi.fn() }));
    await screen.update(render('another_provider'));
    await act(async () => undefined);
    expect(audioPreview.play).not.toHaveBeenCalled();
  });

  it('merges an async prompt result into the latest same-provider config instead of reviving a stale snapshot', async () => {
    let resolvePrompt!: (value: string | null) => void;
    const prompt = new Promise<string | null>((resolve) => { resolvePrompt = resolve; });
    const { Modal } = await import('@/modal');
    vi.mocked(Modal.prompt).mockImplementationOnce(async () => await prompt);
    const descriptor = parseRealtimeSettingsDescriptor('fixture_realtime', {
      kind: 'voice.internal.realtime-settings.v1', providerId: 'fixture_realtime', mode: 'byo',
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
      credentialExists: true, catalog: { phase: 'idle' as const }, onRequestCatalog: vi.fn(),
    });
    const screen = await renderScreen(render(initial));
    act(() => screen.tree.findByProps({ testID: 'voice-realtime-field-instructions' }).props.onPress());
    await vi.waitFor(() => expect(Modal.prompt).toHaveBeenCalled());
    await screen.update(render(latest));
    await act(async () => { resolvePrompt('new guidance'); });
    await vi.waitFor(() => expect(onConfigChange).toHaveBeenCalled());
    expect(onConfigChange).toHaveBeenLastCalledWith({ ...latest, instructions: 'new guidance' });
  });

  it('keeps provider-declared advanced VAD tuning collapsed until explicitly expanded', async () => {
    const vadOwner = {
      schemaVersion: 1,
      defaultConfig: { turnDetection: { threshold: null } },
      parseConfig(value: unknown) { return value && typeof value === 'object' ? value as any : null; },
    };
    const descriptor = parseRealtimeSettingsDescriptor('fixture_realtime', {
      kind: 'voice.internal.realtime-settings.v1', providerId: 'fixture_realtime', mode: 'byo',
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
      config: vadOwner.defaultConfig, onConfigChange: vi.fn(), credentialExists: true,
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
      kind: 'voice.internal.realtime-settings.v1', providerId: 'fixture_realtime', mode: 'byo',
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
      config: catalogOwner.defaultConfig, onConfigChange: vi.fn(), credentialExists: true,
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
      kind: 'voice.internal.realtime-settings.v1', providerId: 'fixture_realtime', mode: 'byo',
      credential: { kind: 'api_key', catalog: null }, links: {},
      fields: [{ kind: 'privacy_opt_in', path: 'resumptionEnabled', titleKey: 'fixture.resume', forgetAction: 'forget_provider_conversation' }],
    });
    if (!descriptor) throw new Error('invalid fixture descriptor');
    const { RealtimeProviderFields } = await import('./RealtimeProviderFields');
    const render = (providerId: string) => React.createElement(RealtimeProviderFields, {
      providerId, descriptor, owner,
      config: { model: { kind: 'pinned', id: 'stable' }, resumptionEnabled: true },
      onConfigChange: vi.fn(), credentialExists: true, catalog: { phase: 'idle' as const }, onRequestCatalog: vi.fn(),
    });
    const screen = await renderScreen(render('fixture_realtime'));
    act(() => screen.tree.findByProps({ testID: 'voice-realtime-forget-provider-conversation' }).props.onPress());
    await screen.update(render('another_provider'));
    await act(async () => resolveAction({ status: 'completed' }));
    expect(Modal.alertAsync).not.toHaveBeenCalled();
  });

  it('enforces provider-declared numeric step metadata before persisting', async () => {
    const { Modal } = await import('@/modal');
    vi.mocked(Modal.prompt).mockResolvedValueOnce('1.23');
    const speedOwner = {
      schemaVersion: 1,
      defaultConfig: { speed: 1 },
      parseConfig(value: unknown) { return value && typeof value === 'object' ? value as any : null; },
    };
    const descriptor = parseRealtimeSettingsDescriptor('fixture_realtime', {
      kind: 'voice.internal.realtime-settings.v1', providerId: 'fixture_realtime', mode: 'byo',
      credential: { kind: 'api_key', catalog: null }, links: {},
      fields: [{ kind: 'range', path: 'speed', min: 0.7, max: 1.5, step: 0.05, titleKey: 'fixture.speed' }],
    });
    if (!descriptor) throw new Error('invalid fixture descriptor');
    const onConfigChange = vi.fn();
    const { RealtimeProviderFields } = await import('./RealtimeProviderFields');
    const screen = await renderScreen(React.createElement(RealtimeProviderFields, {
      providerId: 'fixture_realtime', descriptor, owner: speedOwner,
      config: speedOwner.defaultConfig, onConfigChange, credentialExists: true,
      catalog: { phase: 'idle' }, onRequestCatalog: vi.fn(),
    }));
    act(() => screen.tree.findByProps({ testID: 'voice-realtime-field-speed' }).props.onPress());
    await vi.waitFor(() => expect(Modal.alert).toHaveBeenCalled());
    expect(onConfigChange).not.toHaveBeenCalled();
  });

  it('renders language hints from canonical locale facts instead of raw translation keys', async () => {
    const languageOwner = {
      schemaVersion: 1,
      defaultConfig: { language: null },
      parseConfig(value: unknown) { return value && typeof value === 'object' ? value as any : null; },
    };
    const descriptor = parseRealtimeSettingsDescriptor('fixture_realtime', {
      kind: 'voice.internal.realtime-settings.v1', providerId: 'fixture_realtime', mode: 'byo',
      credential: { kind: 'api_key', catalog: null }, links: {},
      fields: [{ kind: 'language_hint', path: 'language', titleKey: 'fixture.language', options: ['en', 'ar-EG', 'pt-BR', 'bn'] }],
    });
    if (!descriptor) throw new Error('invalid fixture descriptor');
    const { RealtimeProviderFields } = await import('./RealtimeProviderFields');
    const screen = await renderScreen(React.createElement(RealtimeProviderFields, {
      providerId: 'fixture_realtime', descriptor, owner: languageOwner,
      config: languageOwner.defaultConfig, onConfigChange: vi.fn(), credentialExists: true,
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
