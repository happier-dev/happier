import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { createDeferred } from '@/dev/testkit';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';

import { parseRealtimeSettingsDescriptor } from './descriptor';
import { VoiceProviderContributionSchema } from '@happier-dev/protocol/plugins/contributions/voice';
import { createVoiceProviderRegistry } from '@/voice/registry/providerRegistry';
import { commitExternalVoiceProviderRegistration, removeExternalVoiceProviderRegistration } from '@/voice/registry/externalVoiceProviderRegistrations';
import type { VoiceAdapterController } from '@/voice/session/types';
import { setPreferredLanguageFromSettings, t, tLoose } from '@/text';

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
  addListener: vi.fn((_event: string, _listener: (status: Readonly<{ didJustFinish?: boolean }>) => void) => ({ remove: vi.fn() })),
}));
const nativeAlert = vi.hoisted(() => vi.fn<typeof import('react-native')['Alert']['alert']>());
const nativeAudio = vi.hoisted(() => ({
  module: null as ReturnType<typeof import('@/dev/testkit/harness/nativeVoicePcmCapture').createNativeVoicePcmCaptureHarness>['nativeModule'] | null,
}));
// Native module discovery is the OS boundary; the shared registry and lease coordinator stay real.
vi.mock('expo-modules-core', async original => ({
  ...await original<typeof import('expo-modules-core')>(),
  requireOptionalNativeModule: (name: string) => name === 'HappierAudioStreamNative' ? nativeAudio.module : null,
}));

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock({ Platform: { OS: 'ios' }, Alert: { alert: nativeAlert },
    Pressable: (props: React.PropsWithChildren<Record<string, unknown>>) => React.createElement('Pressable', props, props.children) });
});
vi.mock('@expo/vector-icons', async () =>
  (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});
vi.mock('expo-audio', () => ({
  createAudioPlayer: audioPreview.create,
}));
// Keep cold owner-graph compilation outside each rendered interaction's timeout.
nativeAudio.module = (await import('@/dev/testkit/harness/nativeVoicePcmCapture')).createNativeVoicePcmCaptureHarness().nativeModule;
const { RealtimeProviderFields } = await import('./RealtimeProviderFields');

const providerId = 'acme.voice/realtime';
const declaration = VoiceProviderContributionSchema.parse({
  id: 'realtime', title: 'Fixture realtime', kind: 'conversation', roles: ['realtime_conversation'],
  platforms: ['web', 'ios', 'android'], capabilities: { turn: { cancelResponse: false, bargeIn: false } },
  client: { artifactId: 'fixture-voice', exportName: 'activate' },
  settings: { schemaVersion: 1, fields: [
    { id: 'model', title: 'Model', schema: { type: 'object', properties: {
      kind: { type: 'string', enum: ['pinned', 'moving_alias'] }, id: { type: 'string', minLength: 1 },
    }, required: ['kind', 'id'], additionalProperties: false }, default: { kind: 'pinned', id: 'stable' }, presentation: { control: 'json' } },
    { id: 'resumptionEnabled', title: 'Resume', schema: { type: 'boolean' }, default: false, presentation: { control: 'switch' } },
    { id: 'voice', title: 'Voice', schema: { type: 'object', properties: { kind: { const: 'catalog' }, id: { type: 'string' } },
      required: ['kind', 'id'], additionalProperties: false }, default: { kind: 'catalog', id: 'voice_a' }, presentation: { control: 'json' } },
    { id: 'turnDetection', title: 'VAD', schema: { type: 'object', properties: { threshold: { anyOf: [{ type: 'number' }, { type: 'null' }] } },
      required: ['threshold'], additionalProperties: false }, default: { threshold: null }, presentation: { control: 'json' } },
    { id: 'language', title: 'Language', schema: { type: 'string', maxLength: 128 }, default: '', presentation: { control: 'text' } },
  ] },
});
const entry = createVoiceProviderRegistry({
  bundledContributions: [{ pluginId: 'acme.voice', providerId, declaration }],
  bundledPresentations: [{ providerId, settingsSectionId: 'voice.fixture.realtime', createSettingsSpec: () => null }],
}).get(providerId);
if (!entry?.providerSettings) throw new Error('Expected the real declared fixture settings owner');
const settingsOwner = entry.providerSettings;
if (!isConfigRecord(settingsOwner.defaultConfig)) throw new Error('Expected declared object settings');
const owner = {
  schemaVersion: settingsOwner.schemaVersion,
  defaultConfig: settingsOwner.defaultConfig,
  parseConfig(value: unknown) {
    const parsed = settingsOwner.parseConfig(value);
    return isConfigRecord(parsed) ? parsed : null;
  },
};
const registrationToken = {};
const refuseConversation = async () => { throw new Error('This fixture exposes only provider privacy actions'); };
beforeEach(async () => {
  const { Platform } = await import('react-native');
  Object.defineProperty(Platform, 'OS', { value: 'ios', configurable: true });
  setPreferredLanguageFromSettings('en');
  // Human dismissal enters through the native dialog SDK; real ModalManager settles it.
  nativeAlert.mockReset().mockImplementation((_title, _message, buttons) => {
    if (buttons?.length === 1) queueMicrotask(() => buttons[0].onPress?.());
  });
  action.mockReset().mockResolvedValue({ status: 'completed' });
  const adapter = {
    id: providerId, engineKind: 'realtime', start: refuseConversation, stop: refuseConversation,
    toggle: refuseConversation, interrupt: refuseConversation, setMuted: refuseConversation,
    sendContextUpdate: () => { throw new Error('This fixture exposes only provider privacy actions'); },
    getSnapshot: () => ({ adapterId: providerId, sessionId: null, status: 'disconnected', mode: 'idle', canStop: false }),
    performRuntimeAction: action,
  } satisfies VoiceAdapterController;
  commitExternalVoiceProviderRegistration({ token: registrationToken, pluginId: 'acme.voice', localId: 'realtime',
    providerId, descriptor: entry, adapter });
});
afterEach(() => removeExternalVoiceProviderRegistration(registrationToken));

function isConfigRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

describe('RealtimeProviderFields', () => {
  it('explains when an immediate native greeting has no Reply in literal without changing the choice', async () => {
    const { ELEVENLABS_SETTINGS_SECTION } = await import('../../../../../../../packages/plugins/elevenlabs/src/voiceSettingsPresentation');
    const descriptor = parseRealtimeSettingsDescriptor('acme.native-greeting', ELEVENLABS_SETTINGS_SECTION);
    if (!descriptor) throw new Error('missing native greeting presentation');
    const screen = await renderScreen(React.createElement(RealtimeProviderFields, {
      providerId: 'acme.native-greeting', descriptor: { ...descriptor, fields: descriptor.fields.filter((field) => field.kind === 'welcome') },
      owner, config: owner.defaultConfig, credentialStatus: 'ready',
      catalog: { phase: 'idle' }, onRequestCatalog: vi.fn(),
      welcomeSelection: 'immediate', assistantLanguage: 'ar-SA',
    }));
    // The service's Greeting is the same shared choice Local voice shows (one control, one owner).
    const row = screen.tree.findAll((node) => node.props?.testIDPrefix === 'settings.voice.greeting' && Array.isArray(node.props?.options))[0]!;
    expect(row.props.options.map((option: { id: string }) => option.id)).toEqual(['off', 'immediate', 'on_first_turn']);
    expect(row.props.value).toBe('immediate');
    expect(row.props.options.find((option: { id: string }) => option.id === 'immediate').description).toBe(t('voicePresence.greetingLiteralUnavailable'));
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
  it('renders provider-owned fields without provider-id or path-specific host branches', async () => {
    const descriptor = parseRealtimeSettingsDescriptor(providerId, {
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
      providerId: providerId, descriptor, owner,
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
    action.mockImplementationOnce(async () => await new Promise<{ status: 'completed' }>((resolve) => {
      release = () => resolve({ status: 'completed' });
    }));
    const descriptor = parseRealtimeSettingsDescriptor(providerId, {
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
      providerId: providerId, descriptor, owner,
      config: { ...owner.defaultConfig, resumptionEnabled: true },
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
    const alertPresented = createDeferred<void>();
    nativeAlert.mockImplementationOnce(() => { alertPresented.resolve(); });
    action.mockRejectedValueOnce(new Error('provider unavailable'));
    const descriptor = parseRealtimeSettingsDescriptor(providerId, {
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
      providerId: providerId, descriptor, owner,
      config: { ...owner.defaultConfig, resumptionEnabled: true },
      credentialStatus: 'ready',
      catalog: { phase: 'idle' }, onRequestCatalog: vi.fn(),
    }));
    await act(async () => {
      screen.tree.findByProps({ testID: 'voice-realtime-forget-provider-conversation' }).props.onPress();
      await alertPresented.promise;
      expect(nativeAlert).toHaveBeenCalledWith(
        t('common.error'),
        tLoose('settingsVoice.realtimeProviders.resumption.failed'),
        expect.arrayContaining([expect.objectContaining({ text: t('common.ok'), onPress: expect.any(Function) })]),
        { cancelable: false },
      );
    });
  });

  it('keeps catalog preview controls accessible without provider-specific host UI', async () => {
    const catalogOwner = owner;
    const descriptor = parseRealtimeSettingsDescriptor(providerId, {
      kind: 'voice.provider-settings.v1', modes: ['byo'],
      credential: { kind: 'api_key', catalog: 'voices' }, links: {},
      fields: [{ kind: 'voice_catalog', path: 'voice', titleKey: 'fixture.voice', subtitleKey: 'fixture.voice.help' }],
    });
    if (!descriptor) throw new Error('invalid fixture descriptor');
    const { RealtimeProviderFields } = await import('./RealtimeProviderFields');
    const screen = await renderScreen(React.createElement(RealtimeProviderFields, {
      providerId: providerId, descriptor, owner: catalogOwner,
      config: catalogOwner.defaultConfig, credentialStatus: 'ready',
      catalog: { phase: 'ready', rows: [{ id: 'voice_a', name: 'Voice A', previewUrl: 'https://example.test/a.mp3' }] },
      onRequestCatalog: vi.fn(),
    }));
    const dropdown = screen.tree.findByProps({ testID: 'voice-realtime-field-voice' });
    const preview = dropdown.props.items[0].icon;
    const painted = await renderScreen(preview);
    const button = painted.tree.findAll(node => typeof node.type === 'string'
      && (node.props.accessibilityRole ?? node.props.role) === 'button')[0];
    expect(button).toBeDefined();
    expect(button!.props.accessibilityLabel).toContain('Voice A');
    const { StyleSheet } = await import('react-native');
    // Native Pressable resolves this callback at the platform boundary.
    const style = StyleSheet.flatten(typeof button!.props.style === 'function'
      ? button!.props.style({ pressed: false }) : button!.props.style);
    expect(style.width).toBeGreaterThanOrEqual(44);
    expect(style.height).toBeGreaterThanOrEqual(44);
  });

  it('does not start a stale catalog preview after the selected provider changes', async () => {
    audioPreview.play.mockClear();
    audioPreview.remove.mockClear();
    const catalogOwner = owner;
    const descriptor = parseRealtimeSettingsDescriptor(providerId, {
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
    const screen = await renderScreen(render(providerId));
    const preview = screen.tree.findByProps({ testID: 'voice-realtime-field-voice' }).props.items[0].icon;
    act(() => preview.props.onPress({ stopPropagation: vi.fn() }));
    await screen.update(render('another_provider'));
    await act(async () => undefined);
    expect(audioPreview.play).not.toHaveBeenCalled();
  });

  it('keeps provider-declared advanced VAD tuning collapsed until explicitly expanded', async () => {
    const vadOwner = owner;
    const descriptor = parseRealtimeSettingsDescriptor(providerId, {
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
      providerId: providerId, descriptor, owner: vadOwner,
      config: vadOwner.defaultConfig, credentialStatus: 'ready',
      catalog: { phase: 'idle' }, onRequestCatalog: vi.fn(),
    }));
    expect(screen.tree.findAllByProps({ testID: 'voice-realtime-field-turnDetection-threshold' })).toHaveLength(0);
    const disclosure = screen.tree.findByProps({ testID: 'voice-realtime-advanced-turnDetection' });
    expect(disclosure.props.accessibilityLabel).toContain(tLoose('settingsVoice.realtimeProviders.advanced.show'));
    act(() => disclosure.props.onPress());
    expect(screen.tree.findByProps({ testID: 'voice-realtime-field-turnDetection-threshold' })).toBeTruthy();
  });

  it('keeps nested interactive settings controls outside parent row pressables on web', async () => {
    const { Platform } = await import('react-native');
    Object.defineProperty(Platform, 'OS', { value: 'web', configurable: true });
    const catalogOwner = owner;
    const descriptor = parseRealtimeSettingsDescriptor(providerId, {
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
      providerId: providerId, descriptor, owner: catalogOwner,
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
    const descriptor = parseRealtimeSettingsDescriptor(providerId, {
      kind: 'voice.provider-settings.v1', modes: ['byo'],
      credential: { kind: 'api_key', catalog: null }, links: {},
      fields: [{ kind: 'privacy_opt_in', path: 'resumptionEnabled', titleKey: 'fixture.resume', forgetAction: 'forget_provider_conversation' }],
    });
    if (!descriptor) throw new Error('invalid fixture descriptor');
    const { RealtimeProviderFields } = await import('./RealtimeProviderFields');
    const render = (providerId: string) => React.createElement(RealtimeProviderFields, {
      providerId, descriptor, owner,
      config: { ...owner.defaultConfig, resumptionEnabled: true },
      credentialStatus: 'ready', catalog: { phase: 'idle' as const }, onRequestCatalog: vi.fn(),
    });
    const screen = await renderScreen(render(providerId));
    act(() => screen.tree.findByProps({ testID: 'voice-realtime-forget-provider-conversation' }).props.onPress());
    await screen.update(render('another_provider'));
    await act(async () => resolveAction({ status: 'completed' }));
    expect(nativeAlert).not.toHaveBeenCalled();
  });

  it('renders language hints from canonical locale facts instead of raw translation keys', async () => {
    const languageOwner = owner;
    const descriptor = parseRealtimeSettingsDescriptor(providerId, {
      kind: 'voice.provider-settings.v1', modes: ['byo'],
      credential: { kind: 'api_key', catalog: null }, links: {},
      fields: [{ kind: 'language_hint', path: 'language', titleKey: 'fixture.language', options: ['en', 'ar-EG', 'pt-BR', 'bn'] }],
    });
    if (!descriptor) throw new Error('invalid fixture descriptor');
    const { RealtimeProviderFields } = await import('./RealtimeProviderFields');
    const screen = await renderScreen(React.createElement(RealtimeProviderFields, {
      providerId: providerId, descriptor, owner: languageOwner,
      config: languageOwner.defaultConfig, credentialStatus: 'ready',
      catalog: { phase: 'idle' }, onRequestCatalog: vi.fn(),
    }));
    const rows = screen.tree.findByProps({ testID: 'voice-realtime-field-language' }).props.items;
    expect(rows[0]?.title).toBe(tLoose('settingsVoice.realtimeProviders.options.automatic'));
    for (const row of rows.slice(1)) {
      expect(row.title).not.toBe(row.id);
      expect(String(row.title)).not.toMatch(/^settingsVoice\./u);
    }
  });
});
