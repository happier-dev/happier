import type {
  BundledVoiceConversationUiEntry,
  BundledVoiceSpeechEngineUiEntry,
  BundledVoiceUiEntry,
} from '../src/index.js';

declare const conversationEntry: BundledVoiceConversationUiEntry;
declare const speechEntry: BundledVoiceSpeechEngineUiEntry;

const entries: readonly BundledVoiceUiEntry[] = [conversationEntry, speechEntry];

for (const entry of entries) {
  if (entry.kind === 'voice.conversation-provider.v1') {
    entry.internal.createAccountOperationClient;
    const providerSettings = entry.internal.providerSettings;
    if (providerSettings) providerSettings.parseConfig(providerSettings.defaultConfig);
    // @ts-expect-error Speech-only RPC schemas must not leak into conversation entries.
    entry.internal.schemas;
  } else {
    entry.internal.speechTarget.localId;
    entry.internal.schemas.synthesizeResponse.safeParse({ ok: false, errorCode: 'failed' });
    // @ts-expect-error Conversation client factories must not leak into speech entries.
    entry.internal.createAccountOperationClient;
  }
}

const missingSpeechSchema: BundledVoiceUiEntry = {
  kind: 'voice.speech-engine.v1',
  pluginId: 'happier.voice.invalid',
  providerId: 'invalid',
  role: 'stt',
  settingsSectionId: 'voice.stt.invalid',
  roles: [],
  requirements: [],
  // @ts-expect-error A speech entry must expose response schemas as well as its public target.
  internal: {
    createSettingsSpec: () => null,
    speechTarget: { localId: 'speech' },
  },
};

void missingSpeechSchema;

const crossedConversationFacet: BundledVoiceUiEntry = {
  kind: 'voice.conversation-provider.v1',
  pluginId: 'happier.voice.invalid',
  providerId: 'invalid',
  settingsSectionId: 'voice.provider.invalid',
  roles: [],
  requirements: [],
  supportedPlatforms: [],
  selectionOptions: [],
  projectSettings: () => ({ status: 'invalid', modeId: null }),
  // @ts-expect-error A producer cannot combine conversation and speech internal facets.
  internal: {
    providerSettings: {
      schemaVersion: 1,
      defaultConfig: {},
      parseConfig: () => ({}),
    },
    createSettingsSection: () => ({
      kind: 'voice.internal.conversation-settings.v1',
      providerId: 'invalid',
    }),
    createAccountOperationClient: () => ({}),
    schemas: {},
  },
};

void crossedConversationFacet;

const incompleteSpeechDescriptor: BundledVoiceSpeechEngineUiEntry = {
  kind: 'voice.speech-engine.v1',
  pluginId: 'happier.voice.invalid',
  providerId: 'invalid',
  role: 'tts',
  settingsSectionId: 'voice.tts.invalid',
  roles: [],
  requirements: [],
  internal: {
    // @ts-expect-error The producer declaration must expose the complete host-consumed settings descriptor.
    createSettingsSpec: () => ({
      kind: 'voice.internal.speech-settings.v1',
      providerId: 'invalid',
      role: 'tts',
      defaultConfig: {},
      parseConfig: () => ({}),
    }),
    speechTarget: { localId: 'speech' },
    schemas: {
      transcribeResponse: { safeParse: () => ({ success: false }) },
      synthesizeResponse: { safeParse: () => ({ success: false }) },
    },
  },
};

void incompleteSpeechDescriptor;
