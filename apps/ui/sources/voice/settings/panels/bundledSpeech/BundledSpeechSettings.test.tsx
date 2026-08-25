import React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import {
  VoiceProviderContributionSchema,
  type VoiceProviderSettingsJsonValueV1,
} from '@happier-dev/protocol';

import { createDeferred, renderScreen } from '@/dev/testkit';
import { VoiceLocalTtsSchema } from '@/sync/domains/settings/voiceLocalTtsSettings';
import {
  readLocalConversationVoiceSettings,
  readVoiceProviderSettingsConfig,
  voiceSettingsDefaults,
  writeLocalConversationVoiceSettings,
  type VoiceSettings,
} from '@/sync/domains/settings/voiceSettings';
import { installLocalSttProviderCommonModuleMocks } from '../localStt/providers/localSttProviderTestHelpers';
import { createDefaultVoiceProviderRegistry } from '@/voice/registry/defaultRegistry';
import { createVoiceProviderRegistry } from '@/voice/registry/providerRegistry';
import {
  commitExternalVoiceProviderRegistration,
  removeExternalVoiceProviderRegistration,
  type ExternalVoiceProviderRegistration,
} from '@/voice/registry/externalVoiceProviderRegistrations';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const prompt = vi.hoisted(() => vi.fn());
const alert = vi.hoisted(() => vi.fn());
const synthesize = vi.hoisted(() => vi.fn());
const executeSettingsAction = vi.hoisted(() => vi.fn());
const playAudioBytesWithStopper = vi.hoisted(() => vi.fn());
const settingsActionState = vi.hoisted(() => ({
  voice: null as unknown,
  settingsVersion: 4,
  mutationApplied: false,
}));

installLocalSttProviderCommonModuleMocks({
  modal: async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: { alert, prompt } }).module;
  },
});

type CatalogRows = readonly Readonly<{
  id: string;
  name: string;
  metadata: Readonly<Record<string, unknown>>;
}>[];

const GOOGLE_GEMINI_STT_ID = 'happier.voice.google/gemini-stt';
const GOOGLE_CLOUD_TTS_ID = 'happier.voice.google/google-cloud-tts';
const OPENAI_COMPAT_TTS_ID = 'happier.voice.openai-compat/tts';

function voiceWithRootProviderConfig(
  providerId: string,
  config: VoiceProviderSettingsJsonValueV1,
): VoiceSettings {
  return {
    ...voiceSettingsDefaults,
    providers: {
      ...voiceSettingsDefaults.providers,
      [providerId]: { schemaVersion: 2, config },
    },
  };
}

function localConversationVoiceWithSttProvider(
  providerId: string,
  config: VoiceProviderSettingsJsonValueV1,
): VoiceSettings {
  const withSpeechConfig = voiceWithRootProviderConfig(providerId, config);
  const localConversation = readLocalConversationVoiceSettings(withSpeechConfig);
  return writeLocalConversationVoiceSettings({
    ...withSpeechConfig,
    providerId: 'local_conversation',
  }, {
    ...localConversation,
    stt: {
      ...localConversation.stt,
      provider: providerId,
    },
  });
}

function registerExternalSettingsOwner(
  pluginId: string,
  localId: string,
  descriptor: ReturnType<ReturnType<typeof createVoiceProviderRegistry>['get']>,
  settingsActions?: ExternalVoiceProviderRegistration['settingsActions'],
): void {
  if (!descriptor) throw new Error('expected external Voice descriptor');
  const token = {};
  commitExternalVoiceProviderRegistration({
    token,
    pluginId,
    localId,
    providerId: `${pluginId}/${localId}`,
    descriptor,
    adapter: null,
    ...(settingsActions ? { settingsActions } : {}),
  });
  onTestFinished(() => removeExternalVoiceProviderRegistration(token));
}

function parseSpeechDeclaration(input: unknown) {
  const declaration = VoiceProviderContributionSchema.parse(input);
  if (declaration.kind !== 'speech') throw new Error('expected speech declaration');
  return declaration;
}

const openAiCompatTtsEntry = createVoiceProviderRegistry({
  bundledContributions: [{
    pluginId: 'happier.voice.openai-compat',
    providerId: OPENAI_COMPAT_TTS_ID,
    declaration: parseSpeechDeclaration({
      id: 'tts',
      title: 'OpenAI-compatible Text-to-Speech',
      kind: 'speech',
      roles: ['conversation_tts'],
      platforms: ['web', 'ios', 'android'],
      credentials: {
        slot: { id: 'api_key', purpose: 'voice.speech.synthesize', title: 'API key' },
        requirement: { kind: 'optional' },
        sources: [{
          kind: 'savedSecret',
          secretKinds: ['apiKey'],
          rawGrants: [{
            realm: 'daemon',
            phase: 'speech',
            request: { kind: 'environment', keys: ['VOICE_API_KEY'] },
          }],
        }],
      },
      settings: {
        schemaVersion: 2,
        fields: [
          {
            id: 'baseUrl',
            title: 'Endpoint',
            schema: { type: 'string', minLength: 0, maxLength: 2048 },
            default: '',
            presentation: { control: 'text' },
          },
          {
            id: 'insecureLocalOriginConsent',
            title: 'Local endpoint consent',
            schema: { type: 'string', minLength: 0, maxLength: 512 },
            default: '',
            presentation: { control: 'text', hidden: true },
          },
          {
            id: 'insecureLocalConsentMachineId',
            title: 'Local endpoint consent machine',
            schema: { type: 'string', minLength: 0, maxLength: 512 },
            default: '',
            presentation: { control: 'text', hidden: true },
          },
          {
            id: 'model',
            title: 'Model',
            schema: { type: 'string', minLength: 1, maxLength: 256 },
            default: 'tts-1',
            presentation: { control: 'text' },
          },
          {
            id: 'voiceName',
            title: 'Voice',
            schema: { type: 'string', minLength: 1, maxLength: 256 },
            default: 'alloy',
            presentation: { control: 'text' },
          },
          {
            id: 'format',
            title: 'Format',
            schema: { type: 'string', enum: ['mp3', 'wav'] },
            default: 'mp3',
            presentation: {
              control: 'select',
              options: [{ value: 'mp3', title: 'MP3' }, { value: 'wav', title: 'WAV' }],
            },
          },
        ],
        readiness: [{ kind: 'setting_nonempty', settingId: 'baseUrl' }],
      },
    }),
  }],
  bundledPresentations: [{
    providerId: OPENAI_COMPAT_TTS_ID,
    settingsSectionId: 'voice.tts.openai_compat',
    createSettingsSpec: () => ({
        titleKey: 'settingsVoice.local.openaiCompatTts.provider.title',
        subtitleKey: 'settingsVoice.local.openaiCompatTts.provider.subtitle',
        detailKey: 'settingsVoice.local.openaiCompatTts.provider.detail',
        iconName: 'cloud',
        credential: {
          titleKey: 'settingsVoice.local.ttsApiKey',
          promptTitleKey: 'settingsVoice.local.ttsApiKeyTitle',
          promptBodyKey: 'settingsVoice.local.ttsApiKeyDescription',
        },
            fields: [
              {
                fieldId: 'baseUrl',
                titleKey: 'settingsVoice.local.ttsBaseUrl',
                subtitleKey: 'settingsVoice.local.ttsBaseUrlDescription',
              },
              {
                fieldId: 'model',
            titleKey: 'settingsVoice.local.ttsModel',
            subtitleKey: 'settingsVoice.local.ttsModelSubtitle',
          },
          {
            fieldId: 'voiceName',
            titleKey: 'settingsVoice.local.ttsVoice',
            subtitleKey: 'settingsVoice.local.ttsVoiceSubtitle',
          },
          {
            fieldId: 'format',
            titleKey: 'settingsVoice.local.ttsFormat',
            subtitleKey: 'settingsVoice.local.ttsFormatSubtitle',
          },
        ],
        test: { missingValueMessageKey: 'settingsVoice.local.testTtsMissingBaseUrl' },
      }),
  }],
}).get(OPENAI_COMPAT_TTS_ID)!;

const fetchCatalog = vi.fn(async (_entry: unknown, catalog: string): Promise<CatalogRows> => catalog === 'models'
  ? [{ id: 'gemini-test', name: 'Gemini Test', metadata: {} }]
  : [{ id: 'en-US-Test-A', name: 'English Test', metadata: {} }]);
const executionMachine = {
  machineId: 'machine-a' as string | null,
  machineLabel: 'Machine A' as string | null,
};
const credentialPresentation = {
  exists: true,
  credentialIdentity: 'account-secret-a' as string | null,
};
const credentialSourcePresentation: {
  selection:
    | Readonly<{ kind: 'none' }>
    | Readonly<{ kind: 'savedSecret' }>
    | Readonly<{ kind: 'connectedAccount' }>;
  usable: boolean;
} = {
  selection: { kind: 'connectedAccount' as const },
  usable: true,
};

vi.mock('@/voice/credentials/bundledSpeechClient', () => ({
  bundledSpeechDaemonClient: {
    fetchCatalog,
    synthesize,
    executeSettingsAction,
  },
}));

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
  const {
    createLiveStorageStoreMock,
    createPartialStorageModuleMock,
  } = await import('@/dev/testkit/mocks/storage');
  return await createPartialStorageModuleMock(importOriginal, {
    storage: createLiveStorageStoreMock(() => ({
      settings: { voice: settingsActionState.voice } as never,
      settingsScope: null,
    })),
  });
});

vi.mock('@/sync/runtime/getSyncSingleton', () => ({
  getSyncSingleton: () => ({
    prepareAccountSettingsForDaemonSpawn: async () => ({
      accountSettingsVersionHint: settingsActionState.settingsVersion,
    }),
    mutateAccountSettingsOnce: async (input: Readonly<{
      mutate: (settings: Readonly<{ voiceSettingsV1: unknown }>) => Readonly<{
        settings: Readonly<{ voiceSettingsV1: unknown }>;
        value: undefined;
      }>;
    }>) => {
      const result = input.mutate({ voiceSettingsV1: settingsActionState.voice });
      settingsActionState.voice = result.settings.voiceSettingsV1;
      settingsActionState.mutationApplied = true;
      return { status: 'applied' as const, settingsVersion: settingsActionState.settingsVersion + 1, value: result.value };
    },
  }),
}));

vi.mock('@/voice/output/playAudioBytesWithStopper', () => ({
  playAudioBytesWithStopper,
}));

vi.mock('@/voice/credentials/CredentialItem', () => ({
  VoiceCredentialItem: (props: {
    onStatusChanged?: (status: {
      exists: boolean;
      source: 'account' | null;
      credentialIdentity: string | null;
    }) => void;
  }) => {
    React.useEffect(() => {
      props.onStatusChanged?.({
        exists: credentialPresentation.exists,
        source: credentialPresentation.exists ? 'account' : null,
        credentialIdentity: credentialPresentation.credentialIdentity,
      });
    }, [props.onStatusChanged]);
    return React.createElement('VoiceCredentialItem', props);
  },
}));

vi.mock('../realtime/VoiceCredentialSourceField', () => ({
  VoiceCredentialSourceField: (props: {
    onStatusChanged?: (status: typeof credentialSourcePresentation) => void;
  }) => {
    React.useEffect(() => {
      props.onStatusChanged?.(credentialSourcePresentation);
    }, [props.onStatusChanged]);
    return React.createElement('VoiceCredentialSourceField', props);
  },
}));

vi.mock('@/voice/credentials/useExecutionMachinePresentation', () => ({
  useVoiceExecutionMachinePresentation: () => ({ ...executionMachine }),
}));

vi.mock('@/components/ui/lists/Item', () => ({
  Item: (props: object) => React.createElement('Item', props),
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
  DropdownMenu: (props: object) => React.createElement('DropdownMenu', props),
}));

vi.mock('@/components/ui/forms/Switch', () => ({
  Switch: (props: object) => React.createElement('Switch', props),
}));

vi.mock('@/components/ui/buttons/RoundButton', () => ({
  RoundButton: (props: object) => React.createElement('RoundButton', props),
}));

vi.mock('@/components/ui/text/Text', () => ({
  Text: (props: object) => React.createElement('Text', props),
  TextInput: (props: object) => React.createElement('TextInput', props),
}));

vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));

describe('BundledSpeechSettings', () => {
  beforeEach(() => {
    executionMachine.machineId = 'machine-a';
    executionMachine.machineLabel = 'Machine A';
    credentialPresentation.exists = true;
    credentialPresentation.credentialIdentity = 'account-secret-a';
    credentialSourcePresentation.selection = { kind: 'connectedAccount' };
    credentialSourcePresentation.usable = true;
    fetchCatalog.mockReset();
    fetchCatalog.mockImplementation(async (_entry: unknown, catalog: string): Promise<CatalogRows> => catalog === 'models'
      ? [{ id: 'gemini-test', name: 'Gemini Test', metadata: {} }]
      : [{ id: 'en-US-Test-A', name: 'English Test', metadata: {} }]);
    prompt.mockReset();
    alert.mockReset();
    synthesize.mockReset();
    synthesize.mockResolvedValue({ bytes: new Uint8Array([1, 2, 3]), mimeType: 'audio/mpeg' });
    executeSettingsAction.mockReset();
    settingsActionState.voice = voiceSettingsDefaults;
    settingsActionState.settingsVersion = 4;
    settingsActionState.mutationApplied = false;
    playAudioBytesWithStopper.mockReset();
    playAudioBytesWithStopper.mockResolvedValue(undefined);
  });

  it('renders package-owned STT fields and writes the provider envelope', async () => {
    const { createBundledLocalSttProviderSpec } = await import('./BundledSpeechSettings');
    const spec = createBundledLocalSttProviderSpec(createDefaultVoiceProviderRegistry().get(GOOGLE_GEMINI_STT_ID)!);
    expect(spec).not.toBeNull();
    const setStt = vi.fn();
    const setVoice = vi.fn();
    const voiceSettings = voiceWithRootProviderConfig(
      GOOGLE_GEMINI_STT_ID,
      { model: 'gemini-2.5-flash', language: '' },
    );
    const rendered = await renderScreen(React.createElement(spec!.Settings, {
      cfgStt: {
        provider: GOOGLE_GEMINI_STT_ID,
        providers: { [GOOGLE_GEMINI_STT_ID]: { schemaVersion: 2, config: { model: 'gemini-2.5-flash', language: null } } },
      },
      setStt,
      voice: voiceSettings,
      setVoice,
      popoverBoundaryRef: null,
    }));
    await act(async () => undefined);
    const model = rendered.tree.root.findAllByType('DropdownMenu' as never)
      .find((row) => row.props.searchPlaceholder === 'settingsVoice.local.googleGeminiStt.model.searchPlaceholder');
    expect(model).toBeTruthy();
    await act(async () => model!.props.onSelect('gemini-test'));
    expect(setVoice).toHaveBeenCalledWith(expect.objectContaining({
      providers: {
        ...voiceSettings.providers,
        [GOOGLE_GEMINI_STT_ID]: {
          schemaVersion: 2,
          config: expect.objectContaining({ model: 'gemini-test' }),
        },
      },
    }));
  });

  it('invokes a declared speech settings action from the real bundled STT panel and persists its patch', async () => {
    const providerId = 'acme.external/action-stt';
    const declaration = parseSpeechDeclaration({
      id: 'action-stt',
      title: 'Action Speech-to-Text',
      kind: 'speech',
      roles: ['conversation_stt'],
      platforms: ['web'],
      settings: {
        schemaVersion: 2,
        fields: [{
          id: 'model',
          title: 'Model',
          schema: { type: 'string', minLength: 1, maxLength: 256 },
          default: 'speech-1',
          presentation: { control: 'text' },
        }],
        actions: [{
          id: 'refresh-model',
          title: 'Refresh model',
          placement: { kind: 'contributionFooter' },
          confirmation: { kind: 'none' },
          patchFieldIds: ['model'],
        }],
      },
    });
    const entry = createVoiceProviderRegistry({
      bundledContributions: [{
        pluginId: 'acme.external',
        providerId,
        declaration,
      }],
      bundledPresentations: [{
        providerId,
        settingsSectionId: providerId,
        createSettingsSpec: () => ({
          titleKey: 'Action Speech-to-Text',
          subtitleKey: 'Action Speech-to-Text',
          detailKey: 'Action Speech-to-Text',
          iconName: 'extension',
          fields: [{
            fieldId: 'model',
            titleKey: 'Model',
            subtitleKey: 'Model',
          }],
          test: null,
        }),
      }],
    }).get(providerId)!;
    registerExternalSettingsOwner('acme.external', 'action-stt', entry, {
      execute: async ({ actionId, signal }) => await executeSettingsAction({
        entry,
        actionId,
        signal,
      }),
    });
    const { createBundledLocalSttProviderSpec } = await import('./BundledSpeechSettings');
    const spec = createBundledLocalSttProviderSpec(entry);
    if (!spec) throw new Error('speech settings spec is required');
    const voice = localConversationVoiceWithSttProvider(providerId, { model: 'speech-1' });
    settingsActionState.voice = voice;
    executeSettingsAction.mockResolvedValueOnce({ patch: { model: 'speech-2' } });
    const rendered = await renderScreen(React.createElement(spec.Settings, {
      cfgStt: {
        provider: providerId,
        providers: {
          [providerId]: {
            schemaVersion: 2,
            config: { model: 'speech-1' },
          },
        },
      },
      setStt: vi.fn(),
      voice,
      setVoice: vi.fn(),
      popoverBoundaryRef: null,
    }));
    const action = rendered.tree.root.findByProps({
      testID: 'voice-settings-action-refresh-model',
    });

    await act(async () => {
      action.props.onPress();
      await vi.waitFor(() => expect(executeSettingsAction).toHaveBeenCalledWith({
        entry,
        actionId: 'refresh-model',
        signal: expect.any(AbortSignal),
      }));
    });
    await vi.waitFor(() => expect(settingsActionState.mutationApplied).toBe(true));
    expect(readVoiceProviderSettingsConfig(settingsActionState.voice as VoiceSettings, providerId))
      .toEqual({ model: 'speech-2' });
  });

  it.each([
    ['missing', undefined],
    ['invalid', { schemaVersion: 2 as const, config: { model: 42 } }],
  ])('keeps %s canonical root settings inert instead of loading a remote catalog', async (_case, envelope) => {
    const { createBundledLocalSttProviderSpec } = await import('./BundledSpeechSettings');
    const spec = createBundledLocalSttProviderSpec(
      createDefaultVoiceProviderRegistry().get(GOOGLE_GEMINI_STT_ID)!,
    );
    const { [GOOGLE_GEMINI_STT_ID]: _current, ...providers } = voiceSettingsDefaults.providers;
    const voice = {
      ...voiceSettingsDefaults,
      providers: {
        ...providers,
        ...(envelope ? { [GOOGLE_GEMINI_STT_ID]: envelope } : {}),
      },
    } as VoiceSettings;

    const setVoice = vi.fn();
    const rendered = await renderScreen(React.createElement(spec!.Settings, {
      cfgStt: {
        provider: GOOGLE_GEMINI_STT_ID,
        providers: {},
      },
      setStt: vi.fn(),
      voice,
      setVoice,
      popoverBoundaryRef: null,
    }));
    await act(async () => undefined);

    expect(fetchCatalog).not.toHaveBeenCalled();
    const model = rendered.tree.root.findAllByType('DropdownMenu' as never)
      .find((row) => row.props.searchPlaceholder === 'settingsVoice.local.googleGeminiStt.model.searchPlaceholder');
    expect(model).toBeTruthy();
    act(() => model!.props.onSelect('gemini-test'));
    expect(setVoice).not.toHaveBeenCalled();
  });

  it('prompts for a bounded manifest text field and writes its canonical provider envelope', async () => {
    const declaration = parseSpeechDeclaration({
      id: 'stt-text',
      title: 'OpenAI-compatible Speech-to-Text',
      kind: 'speech',
      roles: ['dictation_stt', 'conversation_stt'],
      platforms: ['web', 'ios', 'android'],
      credentials: {
        slot: { id: 'api_key', purpose: 'voice.speech.transcribe', title: 'API key' },
        requirement: { kind: 'optional' },
        sources: [{
          kind: 'savedSecret',
          secretKinds: ['apiKey'],
          rawGrants: [{
            realm: 'daemon',
            phase: 'speech',
            request: { kind: 'environment', keys: ['VOICE_API_KEY'] },
          }],
        }],
      },
      settings: {
        schemaVersion: 2,
        fields: [
          {
            id: 'endpointUrl',
            title: 'Endpoint',
            schema: { type: 'string', minLength: 0, maxLength: 2048 },
            default: '',
            presentation: { control: 'text' },
          },
          {
            id: 'model',
            title: 'Model',
            schema: { type: 'string', minLength: 1, maxLength: 256 },
            default: 'whisper-1',
            presentation: { control: 'text' },
          },
        ],
      },
    });
    const providerId = 'acme.external/stt-text';
    const entry = createVoiceProviderRegistry({
      bundledContributions: [{
        pluginId: 'acme.external',
        providerId,
        declaration,
      }],
      bundledPresentations: [{
        providerId,
        settingsSectionId: 'voice.stt.openai_compat',
        createSettingsSpec: () => ({
            titleKey: 'settingsVoice.local.openaiCompatStt.provider.title',
            subtitleKey: 'settingsVoice.local.openaiCompatStt.provider.subtitle',
            detailKey: 'settingsVoice.local.openaiCompatStt.provider.detail',
            iconName: 'cloud',
            credential: {
              titleKey: 'settingsVoice.local.sttApiKey',
              promptTitleKey: 'settingsVoice.local.sttApiKeyTitle',
              promptBodyKey: 'settingsVoice.local.sttApiKeyDescription',
            },
            fields: [
              {
                fieldId: 'endpointUrl',
                titleKey: 'settingsVoice.local.sttBaseUrl',
                subtitleKey: 'settingsVoice.local.sttBaseUrlDescription',
                promptTitleKey: 'settingsVoice.local.sttBaseUrlTitle',
                promptBodyKey: 'settingsVoice.local.sttBaseUrlDescription',
              },
              {
                fieldId: 'model',
                titleKey: 'settingsVoice.local.sttModel',
                subtitleKey: 'settingsVoice.local.sttModelSubtitle',
              },
            ],
            test: null,
          }),
      }],
    }).get(providerId)!;
    registerExternalSettingsOwner('acme.external', 'stt-text', entry);
    const { createBundledLocalSttProviderSpec } = await import('./BundledSpeechSettings');
    const spec = createBundledLocalSttProviderSpec(entry);
    const setStt = vi.fn();
    const setVoice = vi.fn();
    const voiceSettings = voiceWithRootProviderConfig(providerId, { endpointUrl: '', model: 'whisper-1' });
    prompt.mockResolvedValueOnce(' https://speech.example/v1 ');
    const rendered = await renderScreen(React.createElement(spec!.Settings, {
      cfgStt: {
        provider: providerId,
        providers: { [providerId]: { schemaVersion: 2, config: { endpointUrl: '' } } },
      },
      setStt,
      voice: voiceSettings,
      setVoice,
      popoverBoundaryRef: null,
    }));
    const endpoint = rendered.tree.root.findAllByType('Item' as never)
      .find((row) => row.props.title === 'settingsVoice.local.sttBaseUrl');

    await act(async () => endpoint!.props.onPress());
    await vi.waitFor(() => expect(setVoice).toHaveBeenCalledWith(expect.objectContaining({
      providers: {
        ...voiceSettings.providers,
        [providerId]: {
          schemaVersion: 2,
          config: { endpointUrl: 'https://speech.example/v1', model: 'whisper-1' },
        },
      },
    })));

    prompt.mockResolvedValueOnce('');
    const model = rendered.tree.root.findAllByType('Item' as never)
      .find((row) => row.props.title === 'settingsVoice.local.sttModel');
    await act(async () => model!.props.onPress());
    expect(alert).toHaveBeenCalledWith('common.error');
    expect(setVoice).toHaveBeenCalledTimes(1);
  });

  it('renders package-owned TTS fields and writes voice selection without a vendor panel', async () => {
    const { createBundledLocalTtsProviderSpec } = await import('./BundledSpeechSettings');
    const spec = createBundledLocalTtsProviderSpec(createDefaultVoiceProviderRegistry().get(GOOGLE_CLOUD_TTS_ID)!);
    expect(spec).not.toBeNull();
    const setTts = vi.fn();
    const setVoice = vi.fn();
    const voiceSettings = voiceWithRootProviderConfig(GOOGLE_CLOUD_TTS_ID, {
      voiceName: '', languageCode: '', format: 'mp3', speakingRate: 1, pitch: 0,
    });
    const rendered = await renderScreen(React.createElement(spec!.Settings, {
      cfgTts: {
        provider: GOOGLE_CLOUD_TTS_ID,
        providers: { [GOOGLE_CLOUD_TTS_ID]: { schemaVersion: 2, config: { voiceName: null, languageCode: null, format: 'mp3', speakingRate: null, pitch: null } } },
      },
      setTts,
      voice: voiceSettings,
      setVoice,
      networkTimeoutMs: 15_000,
      popoverBoundaryRef: null,
    } as never));
    await act(async () => undefined);
    const voice = rendered.tree.root.findAllByType('DropdownMenu' as never)
      .find((row) => row.props.searchPlaceholder === 'settingsVoice.local.googleCloudTts.voice.searchPlaceholder');
    expect(voice).toBeTruthy();
    await act(async () => voice!.props.onSelect('en-US-Test-A'));
    expect(setVoice).toHaveBeenCalledWith(expect.objectContaining({
      providers: {
        ...voiceSettings.providers,
        [GOOGLE_CLOUD_TTS_ID]: {
          schemaVersion: 2,
          config: expect.objectContaining({ voiceName: 'en-US-Test-A' }),
        },
      },
    }));
  });

  it('renders and persists textarea, switch, and JSON controls without a credential placeholder', async () => {
    const declaration = parseSpeechDeclaration({
      id: 'speech',
      title: 'External Speech',
      kind: 'speech',
      roles: ['dictation_stt', 'conversation_stt'],
      platforms: ['web'],
      settings: {
        schemaVersion: 2,
        fields: [
          {
            id: 'model',
            title: 'Model',
            schema: { type: 'string', minLength: 1, maxLength: 256 },
            default: 'whisper-1',
            presentation: { control: 'text' },
          },
          {
            id: 'instructions',
            title: 'Instructions',
            schema: { type: 'string', minLength: 0, maxLength: 10_000 },
            default: '',
            presentation: { control: 'textarea' },
          },
          {
            id: 'enhance',
            title: 'Enhance speech',
            schema: { type: 'boolean' },
            default: false,
            presentation: { control: 'switch' },
          },
          {
            id: 'metadata',
            title: 'Metadata',
            schema: { type: 'object', additionalProperties: true },
            default: {},
            presentation: { control: 'json' },
          },
        ],
      },
    });
    const providerId = 'acme.external/speech';
    const entry = createVoiceProviderRegistry({
      bundledContributions: [{ pluginId: 'acme.external', providerId, declaration }],
      bundledPresentations: [{
        providerId,
        settingsSectionId: providerId,
        createSettingsSpec: () => ({
          titleKey: 'External Speech',
          subtitleKey: 'External Speech',
          detailKey: 'External Speech',
          iconName: 'extension',
          fields: declaration.settings!.fields.map((field) => ({
            fieldId: field.id,
            titleKey: typeof field.title === 'string' ? field.title : field.title.key,
            subtitleKey: typeof field.title === 'string' ? field.title : field.title.key,
          })),
          test: null,
        }),
      }],
    }).get(providerId)!;
    registerExternalSettingsOwner('acme.external', 'speech', entry);
    const { createBundledLocalSttProviderSpec } = await import('./BundledSpeechSettings');
    const spec = createBundledLocalSttProviderSpec(entry);
    expect(spec).not.toBeNull();
    const setStt = vi.fn();
    const setVoice = vi.fn();
    const voiceSettings = voiceWithRootProviderConfig(providerId, {
      model: 'whisper-1', instructions: '', enhance: false, metadata: {},
    });
    const rendered = await renderScreen(React.createElement(spec!.Settings, {
      cfgStt: {
        provider: providerId,
        providers: {
          [providerId]: {
            schemaVersion: 2,
            config: { instructions: '', enhance: false, metadata: {} },
          },
        },
      },
      setStt,
      voice: voiceSettings,
      setVoice,
      popoverBoundaryRef: null,
    }));

    expect(rendered.tree.root.findAllByType('VoiceCredentialItem' as never)).toHaveLength(0);
    const instructions = rendered.tree.root.findByProps({
      testID: 'voice-speech-setting:instructions.input',
    });
    const instructionsSave = rendered.tree.root.findByProps({
      testID: 'voice-speech-setting:instructions.save',
    });
    const enhance = rendered.tree.root.findAllByType('Item' as never)
      .find((row) => row.props.title === 'Enhance speech')!;
    const metadata = rendered.tree.root.findByProps({
      testID: 'voice-speech-setting:metadata.input',
    });
    const metadataSave = rendered.tree.root.findByProps({
      testID: 'voice-speech-setting:metadata.save',
    });

    act(() => instructions.props.onChangeText('Keep punctuation.'));
    await act(async () => instructionsSave.props.onPress());
    expect(setVoice).toHaveBeenCalledWith(expect.objectContaining({
      providers: {
        ...voiceSettings.providers,
        [providerId]: {
          schemaVersion: 2,
          config: { model: 'whisper-1', instructions: 'Keep punctuation.', enhance: false, metadata: {} },
        },
      },
    }));

    expect(enhance.props.rightElement.props.testID).toBe('voice-speech-setting:enhance.switch');
    act(() => enhance.props.rightElement.props.onValueChange(true));
    expect(setVoice).toHaveBeenCalledWith(expect.objectContaining({
      providers: {
        ...voiceSettings.providers,
        [providerId]: {
          schemaVersion: 2,
          config: { model: 'whisper-1', instructions: '', enhance: true, metadata: {} },
        },
      },
    }));

    act(() => metadata.props.onChangeText('{"locale":"en"}'));
    await act(async () => metadataSave.props.onPress());
    expect(setVoice).toHaveBeenCalledWith(expect.objectContaining({
      providers: {
        ...voiceSettings.providers,
        [providerId]: {
          schemaVersion: 2,
          config: { model: 'whisper-1', instructions: '', enhance: false, metadata: { locale: 'en' } },
        },
      },
    }));
  });

  it('passes the trimmed descriptor-configured model when testing OpenAI-compatible TTS', async () => {
    const { createBundledLocalTtsProviderSpec } = await import('./BundledSpeechSettings');
    const spec = createBundledLocalTtsProviderSpec(openAiCompatTtsEntry);

    const voiceSettings = voiceWithRootProviderConfig(OPENAI_COMPAT_TTS_ID, {
      baseUrl: 'https://speech.example/v1',
      insecureLocalOriginConsent: '',
      insecureLocalConsentMachineId: '',
      model: '  tts-1-hd  ',
      voiceName: 'alloy',
      format: 'mp3',
    });
    await spec!.test({
      cfgTts: VoiceLocalTtsSchema.parse({
        provider: OPENAI_COMPAT_TTS_ID,
        providers: {
          [OPENAI_COMPAT_TTS_ID]: {
            schemaVersion: 2,
            config: {
              baseUrl: 'https://speech.example/v1',
              model: '  tts-1-hd  ',
              voiceName: 'alloy',
              format: 'mp3',
            },
          },
        },
      }),
      voice: voiceSettings,
      networkTimeoutMs: 15_000,
      sample: 'Hello',
    });

    expect(synthesize).toHaveBeenCalledWith(expect.objectContaining({
      entry: openAiCompatTtsEntry,
      input: 'Hello',
      model: 'tts-1-hd',
      voiceName: 'alloy',
    }));
    expect(playAudioBytesWithStopper).toHaveBeenCalledTimes(1);
  });

  it('derives TTS test request fields from the contribution catalog correspondence', async () => {
    const providerId = 'acme.external/catalog-tts';
    const entry = createVoiceProviderRegistry({
      bundledContributions: [{
        pluginId: 'acme.external',
        providerId,
        declaration: parseSpeechDeclaration({
          id: 'catalog-tts',
          title: 'Catalog Text-to-Speech',
          kind: 'speech',
          roles: ['conversation_tts'],
          platforms: ['web', 'ios', 'android'],
          settings: {
            schemaVersion: 2,
            fields: [
              {
                id: 'selectedModel',
                title: 'Model',
                schema: { type: 'string', minLength: 1, maxLength: 256 },
                default: 'model-default',
                presentation: { control: 'select' },
              },
              {
                id: 'selectedVoice',
                title: 'Voice',
                schema: { type: 'string', minLength: 1, maxLength: 256 },
                default: 'voice-default',
                presentation: { control: 'select' },
              },
            ],
          },
          catalogs: [
            { kind: 'models', settingFieldId: 'selectedModel', allowCustom: true },
            { kind: 'voices', settingFieldId: 'selectedVoice', allowCustom: true },
          ],
        }),
      }],
      bundledPresentations: [{
        providerId,
        settingsSectionId: 'voice.tts.catalog',
        createSettingsSpec: () => ({
          titleKey: 'settingsVoice.local.openaiCompatTts.provider.title',
          subtitleKey: 'settingsVoice.local.openaiCompatTts.provider.subtitle',
          detailKey: 'settingsVoice.local.openaiCompatTts.provider.detail',
          iconName: 'cloud',
          fields: [
            {
              fieldId: 'selectedModel',
              titleKey: 'settingsVoice.local.ttsModel',
              subtitleKey: 'settingsVoice.local.ttsModelSubtitle',
            },
            {
              fieldId: 'selectedVoice',
              titleKey: 'settingsVoice.local.ttsVoice',
              subtitleKey: 'settingsVoice.local.ttsVoiceSubtitle',
            },
          ],
          test: { missingValueMessageKey: 'settingsVoice.local.testTtsMissingVoice' },
        }),
      }],
    }).get(providerId)!;
    registerExternalSettingsOwner('acme.external', 'catalog-tts', entry);
    const { createBundledLocalTtsProviderSpec } = await import('./BundledSpeechSettings');
    const spec = createBundledLocalTtsProviderSpec(entry);
    const voice = voiceWithRootProviderConfig(providerId, {
      selectedModel: '  catalog-model  ',
      selectedVoice: '  catalog-voice  ',
    });

    await spec!.test({
      cfgTts: VoiceLocalTtsSchema.parse({ provider: providerId }),
      voice,
      networkTimeoutMs: 15_000,
      sample: 'Hello',
    });

    expect(synthesize).toHaveBeenCalledWith(expect.objectContaining({
      entry,
      input: 'Hello',
      model: 'catalog-model',
      voiceName: 'catalog-voice',
    }));
  });

  it('uses the descriptor-owned field as the TTS test prerequisite', async () => {
    const { createBundledLocalTtsProviderSpec } = await import('./BundledSpeechSettings');
    const spec = createBundledLocalTtsProviderSpec(openAiCompatTtsEntry);

    const voiceSettings = voiceWithRootProviderConfig(OPENAI_COMPAT_TTS_ID, {
      baseUrl: '   ', insecureLocalOriginConsent: '', model: 'tts-1', voiceName: 'alloy', format: 'mp3',
    });
    await spec!.test({
      cfgTts: VoiceLocalTtsSchema.parse({
        provider: OPENAI_COMPAT_TTS_ID,
        providers: {
          [OPENAI_COMPAT_TTS_ID]: {
            schemaVersion: 2,
            config: {
              baseUrl: '   ',
              model: 'tts-1',
              voiceName: 'alloy',
              format: 'mp3',
            },
          },
        },
      }),
      voice: voiceSettings,
      networkTimeoutMs: 15_000,
      sample: 'Hello',
    });

    expect(alert).toHaveBeenCalledWith('common.error', 'settingsVoice.local.testTtsMissingBaseUrl');
    expect(synthesize).not.toHaveBeenCalled();
  });

  it('does not test TTS from descriptor defaults when the canonical root envelope is absent', async () => {
    const { createBundledLocalTtsProviderSpec } = await import('./BundledSpeechSettings');
    const spec = createBundledLocalTtsProviderSpec(openAiCompatTtsEntry);
    const { [OPENAI_COMPAT_TTS_ID]: _missing, ...providers } = voiceSettingsDefaults.providers;

    await spec!.test({
      cfgTts: VoiceLocalTtsSchema.parse({ provider: OPENAI_COMPAT_TTS_ID }),
      voice: { ...voiceSettingsDefaults, providers },
      networkTimeoutMs: 15_000,
      sample: 'Hello',
    });

    expect(alert).toHaveBeenCalledWith('common.error', 'settingsVoice.local.testTtsMissingBaseUrl');
    expect(synthesize).not.toHaveBeenCalled();
  });

  it('marks selected-machine Google STT credentials for plain-account disclosure', async () => {
    const { createBundledLocalSttProviderSpec } = await import('./BundledSpeechSettings');
    const spec = createBundledLocalSttProviderSpec(createDefaultVoiceProviderRegistry().get(GOOGLE_GEMINI_STT_ID)!);
    const voiceSettings = voiceWithRootProviderConfig(
      GOOGLE_GEMINI_STT_ID,
      { model: 'gemini-2.5-flash', language: '' },
    );
    const rendered = await renderScreen(React.createElement(spec!.Settings, {
      cfgStt: {
        provider: GOOGLE_GEMINI_STT_ID,
        providers: {
          [GOOGLE_GEMINI_STT_ID]: {
            schemaVersion: 2,
            config: { model: 'gemini-2.5-flash', language: null },
          },
        },
      },
      setStt: vi.fn(),
      voice: voiceSettings,
      setVoice: vi.fn(),
      popoverBoundaryRef: null,
    }));
    const credential = rendered.tree.root.findByType('VoiceCredentialItem' as never);
    expect(credential.props).toMatchObject({
      contribution: { pluginId: 'happier.voice.google', localId: 'gemini-stt' },
      credentialSlotId: 'api_key',
      credentialSourcePurpose: 'voice.speech.transcribe',
      disclosePlainStorage: true,
    });
    expect(credential.props).toHaveProperty('machineId');
    expect(credential.props).not.toHaveProperty('operations');
  });

  it.each([
    ['a definitively selected Connected Account', { kind: 'connectedAccount' } as const, undefined],
    ['an unresolved source selection', { kind: 'none' } as const, 'voice.speech.transcribe'],
  ])('routes multi-source speech SavedSecret edits through the source owner except for %s', async (
    _caseName,
    sourceSelection,
    expectedPurpose,
  ) => {
    credentialSourcePresentation.selection = sourceSelection;
    credentialSourcePresentation.usable = sourceSelection.kind === 'connectedAccount';
    const { createBundledLocalSttProviderSpec } = await import('./BundledSpeechSettings');
    const declaration = parseSpeechDeclaration({
      id: 'multi-source-stt',
      title: 'Multi-source STT',
      kind: 'speech',
      roles: ['dictation_stt', 'conversation_stt'],
      platforms: ['web'],
      credentials: {
        slot: { id: 'api_key', purpose: 'voice.speech.transcribe', title: 'API key' },
        requirement: { kind: 'always' },
        sources: [{
          kind: 'savedSecret',
          secretKinds: ['apiKey'],
          rawGrants: [{
            realm: 'daemon',
            phase: 'speech',
            request: { kind: 'environment', keys: ['SPEECH_API_KEY'] },
          }],
        }, {
          kind: 'connectedAccount',
          service: { pluginId: 'acme.speech', localId: 'account' },
          rawGrants: [{
            realm: 'daemon',
            phase: 'speech',
            request: { kind: 'environment', keys: ['SPEECH_API_KEY'] },
          }],
        }],
      },
      settings: {
        schemaVersion: 1,
        fields: [{
          id: 'model',
          title: 'Model',
          schema: { type: 'string', minLength: 1, maxLength: 64 },
          default: 'speech-1',
          presentation: { control: 'text' },
        }],
      },
    });
    const providerId = 'acme.speech/multi-source-stt';
    const entry = createVoiceProviderRegistry({
      bundledContributions: [{ pluginId: 'acme.speech', providerId, declaration }],
      bundledPresentations: [{
        providerId,
        settingsSectionId: 'voice.stt.acme',
        createSettingsSpec: () => ({
          titleKey: 'Acme STT',
          subtitleKey: 'Acme STT subtitle',
          detailKey: 'Acme STT detail',
          iconName: 'cloud',
          credential: {
            titleKey: 'API key',
            promptTitleKey: 'Connect',
            promptBodyKey: 'Paste key',
          },
          fields: [{
            fieldId: 'model',
            titleKey: 'Model',
            subtitleKey: 'Speech model',
          }],
          test: null,
        }),
      }],
    }).get(providerId)!;
    const spec = createBundledLocalSttProviderSpec(entry);
    const rendered = await renderScreen(React.createElement(spec!.Settings, {
      cfgStt: { provider: providerId, providers: {} },
      setStt: vi.fn(),
      voice: voiceWithRootProviderConfig(providerId, { model: 'speech-1' }),
      setVoice: vi.fn(),
      popoverBoundaryRef: null,
    }));

    expect(rendered.tree.root.findByType('VoiceCredentialSourceField' as never).props)
      .toMatchObject({
        contribution: { pluginId: 'acme.speech', localId: 'multi-source-stt' },
        credentials: { slot: { id: 'api_key', purpose: 'voice.speech.transcribe' } },
    });
    expect(rendered.tree.root.findByType('VoiceCredentialItem' as never).props.credentialSourcePurpose)
      .toBe(expectedPurpose);
  });

  it('renders only the canonical source selector for Connected Account-only speech', async () => {
    const { createBundledLocalSttProviderSpec } = await import('./BundledSpeechSettings');
    const declaration = parseSpeechDeclaration({
      id: 'connected-stt',
      title: 'Connected STT',
      kind: 'speech',
      roles: ['dictation_stt', 'conversation_stt'],
      platforms: ['web'],
      credentials: {
        slot: { id: 'api_key', purpose: 'voice.speech.transcribe', title: 'Connected account' },
        requirement: { kind: 'always' },
        sources: [{
          kind: 'connectedAccount',
          service: { pluginId: 'acme.speech', localId: 'account' },
          rawGrants: [{
            realm: 'daemon',
            phase: 'speech',
            request: { kind: 'environment', keys: ['SPEECH_API_KEY'] },
          }],
        }],
      },
      settings: {
        schemaVersion: 1,
        fields: [{
          id: 'model',
          title: 'Model',
          schema: { type: 'string', minLength: 1, maxLength: 64 },
          default: 'speech-1',
          presentation: { control: 'text' },
        }],
      },
    });
    const providerId = 'acme.speech/connected-stt';
    const entry = createVoiceProviderRegistry({
      bundledContributions: [{ pluginId: 'acme.speech', providerId, declaration }],
      bundledPresentations: [{
        providerId,
        settingsSectionId: 'voice.stt.acme-connected',
        createSettingsSpec: () => ({
          titleKey: 'Connected STT',
          subtitleKey: 'Connected STT subtitle',
          detailKey: 'Connected STT detail',
          iconName: 'cloud',
          credential: {
            titleKey: 'API key',
            promptTitleKey: 'Connect',
            promptBodyKey: 'Paste key',
          },
          fields: [{
            fieldId: 'model',
            titleKey: 'Model',
            subtitleKey: 'Speech model',
          }],
          test: null,
        }),
      }],
    }).get(providerId)!;
    const spec = createBundledLocalSttProviderSpec(entry);
    const rendered = await renderScreen(React.createElement(spec!.Settings, {
      cfgStt: { provider: providerId, providers: {} },
      setStt: vi.fn(),
      voice: voiceWithRootProviderConfig(providerId, { model: 'speech-1' }),
      setVoice: vi.fn(),
      popoverBoundaryRef: null,
    }));

    expect({
      sourceSelectors: rendered.tree.root.findAllByType('VoiceCredentialSourceField' as never).length,
      savedSecretEditors: rendered.tree.root.findAllByType('VoiceCredentialItem' as never).length,
    }).toEqual({ sourceSelectors: 1, savedSecretEditors: 0 });
  });

  it('refreshes the Google catalog for credential and execution-machine changes without publishing stale results', async () => {
    const firstRequest = createDeferred<CatalogRows>();
    const credentialRequest = createDeferred<CatalogRows>();
    const machineRequest = createDeferred<CatalogRows>();
    const accountRequest = createDeferred<CatalogRows>();
    fetchCatalog
      .mockImplementationOnce(async () => await firstRequest.promise)
      .mockImplementationOnce(async () => await credentialRequest.promise)
      .mockImplementationOnce(async () => await accountRequest.promise)
      .mockImplementationOnce(async () => await machineRequest.promise);
    const { createBundledLocalSttProviderSpec } = await import('./BundledSpeechSettings');
    const spec = createBundledLocalSttProviderSpec(createDefaultVoiceProviderRegistry().get(GOOGLE_GEMINI_STT_ID)!);
    const voiceSettings = voiceWithRootProviderConfig(
      GOOGLE_GEMINI_STT_ID,
      { model: 'gemini-2.5-flash', language: '' },
    );
    const renderSettings = () => React.createElement(spec!.Settings, {
      cfgStt: {
        provider: GOOGLE_GEMINI_STT_ID,
        providers: {
          [GOOGLE_GEMINI_STT_ID]: {
            schemaVersion: 2,
            config: { model: 'gemini-2.5-flash', language: null },
          },
        },
      },
      setStt: vi.fn(),
      voice: voiceSettings,
      setVoice: vi.fn(),
      popoverBoundaryRef: null,
    });
    const rendered = await renderScreen(renderSettings());
    await vi.waitFor(() => expect(fetchCatalog).toHaveBeenCalledTimes(1));

    const credential = rendered.tree.root.findByType('VoiceCredentialItem' as never);
    act(() => credential.props.onChanged());
    await vi.waitFor(() => expect(fetchCatalog).toHaveBeenCalledTimes(2));
    await act(async () => credentialRequest.resolve([
      { id: 'credential-model', name: 'Credential model', metadata: {} },
    ]));

    credentialPresentation.credentialIdentity = 'account-secret-b';
    act(() => credential.props.onStatusChanged({
      exists: true,
      source: 'account',
      credentialIdentity: credentialPresentation.credentialIdentity,
    }));
    await vi.waitFor(() => expect(fetchCatalog).toHaveBeenCalledTimes(3));
    await act(async () => accountRequest.resolve([
      { id: 'account-model', name: 'Account model', metadata: {} },
    ]));

    executionMachine.machineId = 'machine-b';
    executionMachine.machineLabel = 'Machine B';
    await rendered.update(renderSettings());
    await vi.waitFor(() => expect(fetchCatalog).toHaveBeenCalledTimes(4));
    await act(async () => machineRequest.resolve([
      { id: 'machine-model', name: 'Machine model', metadata: {} },
    ]));
    await act(async () => firstRequest.resolve([
      { id: 'stale-model', name: 'Stale model', metadata: {} },
    ]));

    const model = rendered.tree.root.findAllByType('DropdownMenu' as never)
      .find((row) => row.props.searchPlaceholder === 'settingsVoice.local.googleGeminiStt.model.searchPlaceholder');
    expect(model?.props.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'machine-model' }),
    ]));
    expect(model?.props.items).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'stale-model' }),
      expect.objectContaining({ id: 'credential-model' }),
      expect.objectContaining({ id: 'account-model' }),
    ]));
  });

  it('keeps a failed Google catalog visible and retryable instead of presenting an empty list', async () => {
    fetchCatalog
      .mockRejectedValueOnce(new Error('catalog unavailable'))
      .mockResolvedValueOnce([{ id: 'retry-model', name: 'Retry model', metadata: {} }]);
    const { createBundledLocalSttProviderSpec } = await import('./BundledSpeechSettings');
    const spec = createBundledLocalSttProviderSpec(createDefaultVoiceProviderRegistry().get(GOOGLE_GEMINI_STT_ID)!);
    const rendered = await renderScreen(React.createElement(spec!.Settings, {
      cfgStt: { provider: GOOGLE_GEMINI_STT_ID, providers: {} },
      setStt: vi.fn(),
      voice: voiceWithRootProviderConfig(GOOGLE_GEMINI_STT_ID, { model: 'gemini-2.5-flash', language: '' }),
      setVoice: vi.fn(),
      popoverBoundaryRef: null,
    }));

    await vi.waitFor(() => {
      const model = rendered.tree.root.findAllByType('DropdownMenu' as never)
        .find((row) => row.props.searchPlaceholder === 'settingsVoice.local.googleGeminiStt.model.searchPlaceholder');
      expect(model?.props.items).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: '__retry__' }),
      ]));
    });
    const model = rendered.tree.root.findAllByType('DropdownMenu' as never)
      .find((row) => row.props.searchPlaceholder === 'settingsVoice.local.googleGeminiStt.model.searchPlaceholder');
    await act(async () => model?.props.onSelect('__retry__'));

    await vi.waitFor(() => {
      const refreshed = rendered.tree.root.findAllByType('DropdownMenu' as never)
        .find((row) => row.props.searchPlaceholder === 'settingsVoice.local.googleGeminiStt.model.searchPlaceholder');
      expect(refreshed?.props.items).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'retry-model' }),
      ]));
    });
  });
});
