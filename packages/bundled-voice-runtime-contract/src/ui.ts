/**
 * Private, dependency-neutral contract for trusted first-party voice UI
 * projection. It is a build-time TypeScript seam, never a public plugin or
 * wire-protocol contribution.
 */

import type { PluginVoiceProviderContributionV1 } from '@happier-dev/protocol';
import type { VoiceAdapterSurfaceCapabilities } from './session.js';

export type BundledVoiceConversationCatalogItem = Readonly<{
  id: string;
  name: string;
  metadata?: unknown;
}>;

export type BundledVoiceConversationListedVoice = Readonly<{
  voiceId: string;
  name: string;
  category: string | null;
  previewUrl: string | null;
  labels: Readonly<Record<string, string>> | null;
}>;

export type BundledVoiceConversationClient = Readonly<{
  mintConversationAuth?(params: Readonly<{
    agentId: string;
    textOnly: boolean;
    signal?: AbortSignal | null;
  }>): Promise<Readonly<{ kind: 'token' | 'signed_url'; value: string }>>;
  listVoices?(signal?: AbortSignal | null): Promise<readonly BundledVoiceConversationListedVoice[]>;
  fetchVoiceCatalog?(signal?: AbortSignal | null): Promise<readonly BundledVoiceConversationCatalogItem[]>;
  provision?(request: unknown, signal?: AbortSignal | null): Promise<unknown>;
}>;

export type BundledVoiceAccountOperationService = Readonly<{
  request(input: Readonly<{
    operationId: string;
    parameters: unknown;
    signal: AbortSignal;
  }>): Promise<Readonly<{
    status: number;
    finalUrl: string;
    headers: Readonly<Record<string, string>>;
    body: Uint8Array;
  }>>;
}>;

export type BundledVoiceSettingsConfig = Readonly<{
  readonly [key: string]: unknown;
}>;

export type BundledVoiceProviderSettings = Readonly<{
  schemaVersion: number;
  defaultConfig: BundledVoiceSettingsConfig;
  parseConfig(value: unknown): BundledVoiceSettingsConfig | null;
  readLegacySecret?(value: unknown): unknown | null;
  migrateLegacy?(value: unknown): Readonly<{
    config: BundledVoiceSettingsConfig;
    root?: unknown;
  }> | null;
  projectLegacy?(
    value: unknown,
    context: Readonly<{
      root: unknown;
      resolveCredential(providerId: string, slotId: string): unknown | null;
    }>,
  ): BundledVoiceSettingsConfig | null;
  mergeLegacy?(currentValue: unknown, migratedValue: unknown): BundledVoiceSettingsConfig | null;
}>;

/**
 * Compatibility-only adapter for predecessor settings. Current settings are
 * always derived from the public declaration when this adapter is present.
 */
export type BundledVoiceProviderLegacySettingsMigration = Readonly<{
  defaultLegacyConfig: BundledVoiceSettingsConfig;
  legacyDefaultSelection?: boolean;
  readLegacySecret?(value: unknown): unknown | null;
  preserveLegacyEnvelope?(value: unknown): Readonly<{
    schemaVersion: number;
    config: unknown;
  }> | null;
  migrateLegacy?(value: unknown): Readonly<{
    config: BundledVoiceSettingsConfig;
    root?: unknown;
  }> | null;
  projectLegacy?(
    value: unknown,
    context: Readonly<{
      root: unknown;
      resolveCredential(providerId: string, slotId: string): unknown | null;
    }>,
  ): BundledVoiceSettingsConfig | null;
  mergeLegacy?(currentValue: unknown, migratedValue: unknown): BundledVoiceSettingsConfig | null;
}>;

export type BundledVoiceConversationSettingsDescriptor = Readonly<{
  kind: 'voice.internal.conversation-settings.v1' | 'voice.internal.realtime-settings.v1';
  providerId: string;
}>;

export type BundledVoiceSettingsProjection = Readonly<{
  status: 'ready' | 'needs_migration' | 'invalid' | 'unsupported_version';
  modeId: string | null;
}>;

export type BundledVoiceConversationUiEntry = Readonly<{
  kind: 'voice.conversation-provider.v1';
  pluginId: string;
  providerId: string;
  /**
   * Optional public declaration projection. When present, the app derives the
   * same declarative settings surface used by an installed artifact.
   */
  declaration?: Extract<
    PluginVoiceProviderContributionV1,
    Readonly<{ kind: 'conversation' }>
  >;
  settingsSectionId: string;
  roles: readonly string[];
  requirements: readonly string[];
  requirementsByMode?: Readonly<Record<string, readonly string[]>>;
  supportedPlatforms: readonly string[];
  selectionOptions: readonly Readonly<{
    id: string;
    modeId: string;
    order: number;
    titleKey: string;
    subtitleKey: string;
    configPatch?: BundledVoiceSettingsConfig;
  }>[];
  projectSettings?(
    envelope: Readonly<{ schemaVersion: number; config: unknown }> | null,
  ): BundledVoiceSettingsProjection;
  internal: Readonly<{
    /**
     * Legacy first-party owner for providers whose settings cannot yet be
     * derived from their public declaration.
     */
    providerSettings?: BundledVoiceProviderSettings;
    /** Released predecessor migration only; never the current settings owner. */
    legacySettingsMigration?: BundledVoiceProviderLegacySettingsMigration;
    projectSettingsAnalytics?(
      config: BundledVoiceSettingsConfig,
    ): Readonly<Record<string, boolean | string>>;
    createSettingsSection?(): BundledVoiceConversationSettingsDescriptor;
    createAccountOperationClient?(input: Readonly<{
      createAccountOperations(signal: AbortSignal): BundledVoiceAccountOperationService;
    }>): BundledVoiceConversationClient;
    projectCredentialReadiness?(
      providerConfig: unknown,
      context: Readonly<{
        accountProfile: unknown;
        savedSecret: Readonly<{
          status: 'ready' | 'missing';
        }>;
      }>,
    ): Readonly<{
      status: 'ready' | 'missing' | 'unknown';
      detailKey: string;
    }>;
    resolveAccountOperationTarget?(
      providerConfig: unknown,
    ):
      | Readonly<{ kind: 'savedSecret' }>
      | Readonly<{ kind: 'daemonAction'; actionLocalId: string }>;
    resolveSurfaceCapabilities?(
      providerConfig: unknown,
    ): VoiceAdapterSurfaceCapabilities | null;
  }>;
}>;

export type BundledVoiceSchema<T> = Readonly<{
  safeParse(value: unknown): { success: true; data: T } | { success: false };
}>;

export type BundledSpeechTranscribeResponse =
  | Readonly<{ ok: true; requestId: string; text: string }>
  | Readonly<{ ok: false; errorCode: string }>;

export type BundledSpeechSynthesizeResponse =
  | Readonly<{
      ok: true;
      requestId: string;
      downloadId: string;
      chunkSizeBytes: number;
      sizeBytes: number;
      mimeType: 'audio/mpeg' | 'audio/wav';
    }>
  | Readonly<{ ok: false; errorCode: string }>;

export type BundledVoiceSpeechSettingsField = Readonly<{
  kind: 'remote_select' | 'language' | 'enum' | 'number';
  key: string;
  catalog?: 'models' | 'voices';
  titleKey: string;
  subtitleKey: string;
  searchPlaceholderKey?: string;
  autoTitleKey?: string;
  autoSubtitleKey?: string;
  allowCustom?: boolean;
  nullable?: boolean;
  promptTitleKey?: string;
  promptBodyKey?: string;
  min?: number;
  max?: number;
  options?: readonly Readonly<{ id: string; title: string }>[];
}>;

export type BundledVoiceSpeechSettingsDescriptor = Readonly<{
  kind: 'voice.internal.speech-settings.v1';
  providerId: string;
  role: 'stt' | 'tts';
  schemaVersion: number;
  titleKey: string;
  subtitleKey: string;
  detailKey: string;
  privacyDisclosureKey?: string;
  iconName: string;
  credential: Readonly<{
    kind: 'api_key';
    titleKey: string;
    promptTitleKey: string;
    promptBodyKey: string;
    androidRestricted: boolean;
    androidRestrictedBodyKey: string | null;
  }>;
  fields: readonly BundledVoiceSpeechSettingsField[];
  runtime: Readonly<{ readonly [key: string]: string }>;
  defaultConfig: BundledVoiceSettingsConfig;
  parseConfig(value: unknown): BundledVoiceSettingsConfig | null;
  parseLegacyConfig(value: unknown): BundledVoiceSettingsConfig | null;
  readLegacySecret(value: unknown): unknown | null;
  migrateLegacy(value: unknown): BundledVoiceSettingsConfig | null;
  classifyLegacyCredential(value: unknown): 'importable' | 'needs_machine_credential';
  test: null | Readonly<{
    kind: 'synthesize';
    missingValueKey: string;
    missingValueMessageKey: string;
  }>;
}>;

export type BundledVoiceSpeechEngineUiEntry = Readonly<{
  kind: 'voice.speech-engine.v1';
  pluginId: string;
  providerId: string;
  role: 'stt' | 'tts';
  settingsSectionId: string;
  roles: readonly string[];
  requirements: readonly string[];
  internal: Readonly<{
    createSettingsSpec(providerId: string): BundledVoiceSpeechSettingsDescriptor | null;
    speechTarget: Readonly<{
      localId: string;
    }>;
    schemas: Readonly<{
      transcribeResponse: BundledVoiceSchema<BundledSpeechTranscribeResponse>;
      synthesizeResponse: BundledVoiceSchema<BundledSpeechSynthesizeResponse>;
    }>;
  }>;
}>;

export type BundledVoiceUiEntry =
  | BundledVoiceConversationUiEntry
  | BundledVoiceSpeechEngineUiEntry;
