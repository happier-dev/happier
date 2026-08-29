import { describe, expect, it } from 'vitest';

import { createDefaultVoiceProviderRegistry } from '@/voice/registry/defaultRegistry';
import { createVoiceProviderRegistry } from '@/voice/registry/providerRegistry';
import { settingsParse, type Settings } from '@/sync/domains/settings/settings';
import {
  readLocalConversationVoiceSettings,
  readLocalDirectVoiceSettings,
  voiceSettingsDefaults,
  writeLocalConversationVoiceSettings,
  writeLocalDirectVoiceSettings,
} from '@/sync/domains/settings/voiceSettings';
import { saveAndUseAccountVoiceCredential } from '@/voice/credentials/accountVoiceCredential';
import { resolveVoiceProviderLocalAvailability } from '@/voice/settings/voiceProviderLocalAvailability';

import {
  resolveVoiceDictationExecutionMachineRequirement,
  resolveVoiceDictationNativeLocalNeuralPackId,
  resolveVoiceDictationReadiness,
} from './voiceDictationReadiness';

describe('resolveVoiceDictationReadiness', () => {
  const registry = createDefaultVoiceProviderRegistry();

  function addCredential(
    settings: Settings,
    providerId: string,
    credentialSlotId: string,
    machineId: string,
  ): Settings {
    const contribution = providerId === 'happier.voice.google/gemini-stt'
      ? { pluginId: 'happier.voice.google', localId: 'gemini-stt' }
      : { pluginId: 'happier.voice.openai-compat', localId: 'stt' };
    const entry = registry.get(providerId);
    if (entry?.kind !== 'voice.speech-engine.v1' || entry.declaration?.kind !== 'speech') {
      throw new Error(`Expected current speech declaration ${providerId}`);
    }
    return saveAndUseAccountVoiceCredential({
      settings,
      contribution,
      credentialSlotId: 'api_key',
      expectedSettingsVersion: 0,
      currentDeclaration: entry.declaration,
      machineId,
      value: `${providerId}-${credentialSlotId}`,
      generateId: () => `${providerId}-${credentialSlotId}-${machineId}`,
      now: 1,
      expectedSecretId: null,
      expectedSecretUpdatedAt: null,
    }).settings;
  }

  const GOOGLE_STT_PROVIDER_ID = 'happier.voice.google/gemini-stt';
  const OPENAI_COMPAT_STT_PROVIDER_ID = 'happier.voice.openai-compat/stt';
  const SETTINGS_MODE_DICTATION_PROVIDER_ID = 'happier.voice.fixture/settings-mode-stt';

  function createSettingsModeDictationRegistry() {
    return createVoiceProviderRegistry({
      builtIn: [{
        kind: 'voice.speech-engine.v1',
        pluginId: 'happier.voice.fixture',
        providerId: SETTINGS_MODE_DICTATION_PROVIDER_ID,
        settingsSectionId: 'voice.fixture.settings-mode-stt',
        role: 'stt',
        roles: ['dictation_stt'],
        requirements: [],
        requirementsByMode: {
          daemon: ['execution_machine'],
        },
        supportedPlatforms: ['web'],
        projectSettings: (envelope) => {
          if (!envelope) return { status: 'needs_migration' as const, modeId: null };
          if (envelope.schemaVersion !== 1) {
            return { status: 'unsupported_version' as const, modeId: null };
          }
          const mode = envelope.config !== null
            && typeof envelope.config === 'object'
            && !Array.isArray(envelope.config)
            ? (envelope.config as Readonly<Record<string, unknown>>).mode
            : null;
          return mode === 'daemon'
            ? { status: 'ready' as const, modeId: 'daemon' }
            : { status: 'invalid' as const, modeId: null };
        },
      }],
    });
  }

  const daemonReadyAvailability = resolveVoiceProviderLocalAvailability({
    platformOs: 'web',
    daemonFeatureEnabled: true,
    serverFeatures: null,
    daemonDirectRouteAvailability: 'available',
    daemonModelState: 'ready',
    daemonRuntimeState: 'available',
    daemonPcmCapture: 'available',
  });

  it('projects device Dictation as ready only when native speech recognition is known available', () => {
    expect(resolveVoiceDictationReadiness({
      registry,
      platform: 'ios',
      executionMachineId: null,
      localAvailability: resolveVoiceProviderLocalAvailability({
        platformOs: 'ios',
        daemonFeatureEnabled: false,
        serverFeatures: null,
        nativeDeviceSpeechRecognition: 'available',
      }),
      settings: {
        voice: {
          dictation: {
            sttBinding: 'explicit',
            language: null,
            stt: { provider: 'device' },
          },
        },
      },
    })).toMatchObject({
      providerId: 'device',
      status: 'ready',
      code: 'ready',
    });
  });

  it.each([
    ['unavailable', 'device_stt_unavailable'],
    ['unknown', 'device_stt_availability_unknown'],
  ] as const)(
    'fails native device Dictation closed when speech recognition is %s',
    (nativeDeviceSpeechRecognition, code) => {
      expect(resolveVoiceDictationReadiness({
        registry,
        platform: 'ios',
        executionMachineId: null,
        localAvailability: resolveVoiceProviderLocalAvailability({
          platformOs: 'ios',
          daemonFeatureEnabled: false,
          serverFeatures: null,
          nativeDeviceSpeechRecognition,
        }),
        settings: {
          voice: {
            dictation: {
              sttBinding: 'explicit',
              language: null,
              stt: { provider: 'device' },
            },
          },
        },
      })).toMatchObject({
        providerId: 'device',
        status: 'unavailable',
        code,
      });
    },
  );

  it.each([
    [
      { support: 'available', onDevice: 'available' },
      { status: 'ready', code: 'ready' },
    ],
    [
      { support: 'cloud_only', onDevice: 'unsupported' },
      { status: 'ready', code: 'ready' },
    ],
    [
      { support: 'unavailable', onDevice: 'unsupported' },
      { status: 'unavailable', code: 'device_stt_unavailable' },
    ],
    [
      { support: 'unknown', onDevice: 'unknown' },
      { status: 'unavailable', code: 'device_stt_availability_unknown' },
    ],
  ] as const)(
    'projects web device Dictation from passive browser support %s',
    (browserSpeechCapability, expected) => {
      expect(resolveVoiceDictationReadiness({
        registry,
        platform: 'web',
        executionMachineId: null,
        localAvailability: resolveVoiceProviderLocalAvailability({
          platformOs: 'web',
          daemonFeatureEnabled: false,
          serverFeatures: null,
          browserSpeechCapability,
        }),
        settings: {
          voice: {
            dictation: {
              sttBinding: 'explicit',
              language: null,
              stt: { provider: 'device' },
            },
          },
        },
      })).toMatchObject({
        providerId: 'device',
        ...expected,
      });
    },
  );

  it('fails an explicit OpenAI-compatible selection closed when its machine is missing', () => {
    expect(resolveVoiceDictationReadiness({
      registry,
      platform: 'web',
      executionMachineId: null,
      localAvailability: resolveVoiceProviderLocalAvailability({
        platformOs: 'web',
        daemonFeatureEnabled: false,
        serverFeatures: null,
      }),
      settings: {
        voice: {
          dictation: {
            sttBinding: 'explicit',
            language: 'en-US',
            stt: {
              provider: 'happier.voice.openai-compat/stt',
            },
          },
          providers: {
            'happier.voice.openai-compat/stt': {
              schemaVersion: 2,
              config: {
                baseUrl: 'https://speech.example.test/v1',
                insecureLocalOriginConsent: '',
                insecureLocalConsentMachineId: '',
                model: 'whisper-1',
                language: '',
              },
            },
          },
        },
      },
    })).toMatchObject({
      providerId: 'happier.voice.openai-compat/stt',
      status: 'needs_setup',
      code: 'execution_machine_missing',
    });
  });

  it.each([
    {
      label: 'blank',
      config: {
        baseUrl: '',
        insecureLocalOriginConsent: '',
        insecureLocalConsentMachineId: '',
        model: 'whisper-1',
        language: '',
      },
      expected: { status: 'needs_setup', code: 'settings_missing_required_setting' },
    },
    {
      label: 'valid HTTPS',
      config: {
        baseUrl: 'https://speech.example.test/v1',
        insecureLocalOriginConsent: '',
        insecureLocalConsentMachineId: '',
        model: 'whisper-1',
        language: '',
      },
      expected: { status: 'ready', code: 'ready' },
    },
    {
      label: 'invalid',
      config: {
        baseUrl: 'not-an-endpoint',
        insecureLocalOriginConsent: '',
        insecureLocalConsentMachineId: '',
        model: 'whisper-1',
        language: '',
      },
      expected: { status: 'incompatible', code: 'endpoint_incompatible' },
    },
    {
      label: 'unconfirmed insecure',
      config: {
        baseUrl: 'http://localhost:11434/v1',
        insecureLocalOriginConsent: '',
        insecureLocalConsentMachineId: '',
        model: 'whisper-1',
        language: '',
      },
      expected: { status: 'needs_setup', code: 'endpoint_missing' },
    },
  ])('projects $label OpenAI-compatible Dictation endpoint policy from the qualified root envelope', ({ config, expected }) => {
    const settings = settingsParse({
      voice: {
        providers: {
          [OPENAI_COMPAT_STT_PROVIDER_ID]: {
            schemaVersion: 2,
            config,
          },
        },
        dictation: {
          sttBinding: 'explicit',
          language: 'en-US',
          stt: { provider: OPENAI_COMPAT_STT_PROVIDER_ID },
        },
      },
    });

    expect(resolveVoiceDictationReadiness({
      registry,
      platform: 'web',
      executionMachineId: 'machine-a',
      localAvailability: daemonReadyAvailability,
      settings,
    })).toMatchObject({
      providerId: OPENAI_COMPAT_STT_PROVIDER_ID,
      ...expected,
    });
  });

  it.each([
    {
      label: 'a malformed current envelope',
      envelope: { schemaVersion: 1, config: { mode: 42 } },
      expected: { status: 'needs_setup', code: 'settings_invalid' },
    },
    {
      label: 'an unsupported future envelope',
      envelope: { schemaVersion: 2, config: { mode: 'daemon' } },
      expected: { status: 'incompatible', code: 'settings_unsupported_version' },
    },
  ])('uses the canonical provider-settings projection for $label', ({ envelope, expected }) => {
    const settings = settingsParse({
      voice: {
        providers: {
          [SETTINGS_MODE_DICTATION_PROVIDER_ID]: envelope,
        },
        dictation: {
          sttBinding: 'explicit',
          language: null,
          stt: { provider: SETTINGS_MODE_DICTATION_PROVIDER_ID },
        },
      },
    });
    const settingsModeRegistry = createSettingsModeDictationRegistry();

    expect(resolveVoiceDictationReadiness({
      registry: settingsModeRegistry,
      platform: 'web',
      executionMachineId: 'machine-a',
      localAvailability: daemonReadyAvailability,
      settings,
    })).toMatchObject({
      providerId: SETTINGS_MODE_DICTATION_PROVIDER_ID,
      ...expected,
    });
    expect(resolveVoiceDictationExecutionMachineRequirement({
      registry: settingsModeRegistry,
      platform: 'web',
      settings,
    })).toBe(false);
  });

  it('carries a ready settings mode into Dictation readiness and its execution-machine selector', () => {
    const settings = settingsParse({
      voice: {
        providers: {
          [SETTINGS_MODE_DICTATION_PROVIDER_ID]: { schemaVersion: 1, config: { mode: 'daemon' } },
        },
        dictation: {
          sttBinding: 'explicit',
          language: null,
          stt: { provider: SETTINGS_MODE_DICTATION_PROVIDER_ID },
        },
      },
    });
    const settingsModeRegistry = createSettingsModeDictationRegistry();

    expect(resolveVoiceDictationReadiness({
      registry: settingsModeRegistry,
      platform: 'web',
      executionMachineId: 'machine-a',
      localAvailability: daemonReadyAvailability,
      settings,
    })).toMatchObject({
      providerId: SETTINGS_MODE_DICTATION_PROVIDER_ID,
      status: 'ready',
      code: 'ready',
    });
    expect(resolveVoiceDictationExecutionMachineRequirement({
      registry: settingsModeRegistry,
      platform: 'web',
      settings,
    })).toBe(true);
  });

  it.each(['auto', 'device'] as const)(
    'does not turn daemon facts into native local-neural %s Dictation readiness',
    (execution) => {
      const localAvailability = resolveVoiceProviderLocalAvailability({
        platformOs: 'ios',
        daemonFeatureEnabled: false,
        serverFeatures: null,
        daemonModelState: 'missing',
        daemonRuntimeState: 'unavailable',
        nativeDeviceSpeechRecognition: 'available',
      });
      const settings = settingsParse({
        voice: {
          dictation: {
            sttBinding: 'explicit',
            language: null,
            stt: {
              provider: 'local_neural',
              localNeural: {
                assetId: 'sherpa-streaming-zipformer-bilingual-zh-en',
                execution,
              },
            },
          },
        },
      });

      expect(resolveVoiceDictationReadiness({
        registry,
        platform: 'ios',
        executionMachineId: null,
        localAvailability,
        settings,
      })).toMatchObject({
        providerId: 'local_neural',
        status: 'unavailable',
        code: 'model_unknown',
        recoveryAction: 'install_model',
      });
      expect(resolveVoiceDictationExecutionMachineRequirement({
        registry,
        platform: 'ios',
        settings,
      })).toBe(false);
    },
  );

  it('uses the checked selected native Local Neural model fact instead of reporting it unknown', () => {
    const localAvailability = resolveVoiceProviderLocalAvailability({
      platformOs: 'ios',
      daemonFeatureEnabled: false,
      serverFeatures: null,
      nativeDeviceSpeechRecognition: 'available',
    });
    const settings = settingsParse({
      voice: {
        dictation: {
          sttBinding: 'explicit',
          language: null,
          stt: {
            provider: 'local_neural',
            localNeural: {
              assetId: 'sherpa-streaming-zipformer-bilingual-zh-en',
              execution: 'device',
            },
          },
        },
      },
    });

    expect(resolveVoiceDictationReadiness({
      registry,
      platform: 'ios',
      executionMachineId: null,
      localAvailability,
      settings,
      nativeLocalNeuralModel: 'ready',
    })).toMatchObject({
      providerId: 'local_neural',
      status: 'ready',
      code: 'ready',
    });
  });

  it('uses the Dictation runtime snapshot pack for a same-as-local native Local Neural selection', () => {
    const localDirect = readLocalDirectVoiceSettings(voiceSettingsDefaults);
    const localConversation = readLocalConversationVoiceSettings(voiceSettingsDefaults);
    const withDirectPack = writeLocalDirectVoiceSettings({
      ...voiceSettingsDefaults,
      providerId: 'local_direct',
    }, {
      ...localDirect,
      stt: {
        ...localDirect.stt,
        provider: 'local_neural',
        localNeural: {
          ...localDirect.stt.localNeural,
          assetId: 'selected-direct-pack',
          execution: 'device',
        },
      },
    });
    const voice = writeLocalConversationVoiceSettings(withDirectPack, {
      ...localConversation,
      stt: {
        ...localConversation.stt,
        provider: 'local_neural',
        localNeural: {
          ...localConversation.stt.localNeural,
          assetId: 'unselected-conversation-pack',
          execution: 'device',
        },
      },
    });
    const settings = settingsParse({
      voice: {
        ...voice,
        dictation: {
          ...voice.dictation,
          sttBinding: 'same_as_local',
        },
      },
    });

    expect(resolveVoiceDictationNativeLocalNeuralPackId({
      registry,
      settings,
      platform: 'ios',
    })).toBe('selected-direct-pack');
  });

  it.each([
    [GOOGLE_STT_PROVIDER_ID, 'api_key'],
    [OPENAI_COMPAT_STT_PROVIDER_ID, 'api_key'],
  ] as const)(
    'projects selected-machine %s credential readiness from its current declaration before and after removal',
    (providerId, credentialSlotId) => {
      const voice = {
        ...(providerId === OPENAI_COMPAT_STT_PROVIDER_ID
          ? {
              providers: {
                [OPENAI_COMPAT_STT_PROVIDER_ID]: {
                  schemaVersion: 2,
                  config: {
                    baseUrl: 'https://speech.example.test/v1',
                    insecureLocalOriginConsent: '',
                    insecureLocalConsentMachineId: '',
                    model: 'whisper-1',
                    language: '',
                  },
                },
              },
            }
          : {}),
        dictation: {
          sttBinding: 'explicit' as const,
          language: 'en-US',
          stt: {
            provider: providerId,
          },
        },
      };
      const missing = settingsParse({ voice });
      const project = (settings: Settings, credentialReady = false) => resolveVoiceDictationReadiness({
        registry,
        platform: 'web',
        executionMachineId: 'machine-a',
        localAvailability: daemonReadyAvailability,
        settings,
        ...(credentialReady ? {
          rawCredentialAuthorization: {
            contribution: providerId === GOOGLE_STT_PROVIDER_ID
              ? { pluginId: 'happier.voice.google', localId: 'gemini-stt' }
              : { pluginId: 'happier.voice.openai-compat', localId: 'stt' },
            machineId: 'machine-a',
            realm: 'daemon',
            phase: 'speech',
            status: 'ready',
          },
        } : {}),
      });

      const credentialRequired = providerId === GOOGLE_STT_PROVIDER_ID;
      expect(project(missing)).toMatchObject(credentialRequired
        ? { providerId, status: 'needs_setup', code: 'credential_missing' }
        : { providerId, status: 'ready', code: 'ready' });

      const ready = addCredential(missing, providerId, credentialSlotId, 'machine-a');
      expect(project(ready, true)).toMatchObject({
        providerId,
        status: 'ready',
        code: 'ready',
      });

      expect(project(settingsParse({ ...ready, secrets: [] }), true)).toMatchObject(credentialRequired
        ? { providerId, status: 'needs_setup', code: 'credential_missing' }
        : { providerId, status: 'ready', code: 'ready' });
    },
  );

  it('uses the selected Local STT credential when Dictation follows Local', () => {
    const local = readLocalConversationVoiceSettings(voiceSettingsDefaults);
    const voice = writeLocalConversationVoiceSettings(
      {
        ...voiceSettingsDefaults,
        dictation: {
          ...voiceSettingsDefaults.dictation,
          sttBinding: 'same_as_local',
        },
      },
      {
        ...local,
        stt: { ...local.stt, provider: 'happier.voice.google/gemini-stt' },
      },
    );
    const missing = settingsParse({ voice });
    const project = (settings: Settings, credentialReady = false) => resolveVoiceDictationReadiness({
      registry,
      platform: 'web',
      executionMachineId: 'machine-a',
      localAvailability: daemonReadyAvailability,
      settings,
      ...(credentialReady ? {
        rawCredentialAuthorization: {
          contribution: { pluginId: 'happier.voice.google', localId: 'gemini-stt' },
          machineId: 'machine-a',
          realm: 'daemon',
          phase: 'speech',
          status: 'ready',
        },
      } : {}),
    });

    expect(project(missing)).toMatchObject({
      providerId: 'happier.voice.google/gemini-stt',
      status: 'needs_setup',
      code: 'credential_missing',
    });
    expect(project(addCredential(missing, 'happier.voice.google/gemini-stt', 'api_key', 'machine-a'), true)).toMatchObject({
      providerId: 'happier.voice.google/gemini-stt',
      status: 'ready',
      code: 'ready',
    });
  });

  it('fails daemon-backed Dictation closed when direct heavy audio is unavailable and relay is disabled by policy', () => {
    const localAvailability = resolveVoiceProviderLocalAvailability({
      platformOs: 'web',
      daemonFeatureEnabled: true,
      serverFeatures: null,
      daemonModelState: 'ready',
      daemonRuntimeState: 'available',
      daemonPcmCapture: 'available',
    });

    expect(resolveVoiceDictationReadiness({
      registry,
      platform: 'web',
      executionMachineId: 'machine-online',
      localAvailability,
      settings: {
        voice: {
          dictation: {
            sttBinding: 'explicit',
            language: null,
            stt: {
              provider: 'local_neural',
              localNeural: {
                assetId: 'sherpa-streaming-zipformer-bilingual-zh-en',
                execution: 'daemon',
              },
            },
          },
        },
      },
    })).toMatchObject({
      providerId: 'local_neural',
      status: 'unavailable',
      code: 'daemon_relay_disabled',
      recoveryAction: 'switch_provider',
    });
  });

  it('distinguishes a selected unreachable execution machine from no selection', () => {
    expect(resolveVoiceDictationReadiness({
      registry,
      platform: 'web',
      executionMachineId: null,
      executionMachineSelectionKind: 'selected_unreachable',
      localAvailability: daemonReadyAvailability,
      settings: {
        voice: {
          dictation: {
            sttBinding: 'explicit',
            language: null,
            stt: {
              provider: 'local_neural',
              localNeural: {
                assetId: 'sherpa-streaming-zipformer-bilingual-zh-en',
                execution: 'daemon',
              },
            },
          },
        },
      },
    })).toMatchObject({
      providerId: 'local_neural',
      status: 'incompatible',
      code: 'execution_machine_incompatible',
    });
  });

  it.each(['direct', 'relay'] as const)(
    'keeps daemon-backed Dictation ready when the selected machine heavy-audio route is %s',
    (route) => {
      expect(resolveVoiceDictationReadiness({
        registry,
        platform: 'web',
        executionMachineId: 'machine-online',
        localAvailability: {
          ...daemonReadyAvailability,
          daemon: {
            ...daemonReadyAvailability.daemon!,
            route,
          },
        },
        settings: {
          voice: {
            dictation: {
              sttBinding: 'explicit',
              language: null,
              stt: {
                provider: 'local_neural',
                localNeural: {
                  assetId: 'sherpa-streaming-zipformer-bilingual-zh-en',
                  execution: 'daemon',
                },
              },
            },
          },
        },
      })).toMatchObject({
        providerId: 'local_neural',
        status: 'ready',
        code: 'ready',
      });
    },
  );

  it('fails daemon-backed Dictation closed when Auto has no active execution machine', () => {
    const catalogUnknownAvailability = resolveVoiceProviderLocalAvailability({
      platformOs: 'web',
      daemonFeatureEnabled: true,
      serverFeatures: null,
      daemonDirectRouteAvailability: 'available',
      daemonPcmCapture: 'available',
    });

    expect(resolveVoiceDictationReadiness({
      registry,
      platform: 'web',
      executionMachineId: null,
      localAvailability: catalogUnknownAvailability,
      settings: {
        voice: {
          dictation: {
            sttBinding: 'explicit',
            language: null,
            stt: {
              provider: 'local_neural',
              localNeural: {
                assetId: 'sherpa-streaming-zipformer-bilingual-zh-en',
                execution: 'auto',
              },
            },
          },
        },
      },
    })).toMatchObject({
      providerId: 'local_neural',
      status: 'needs_setup',
      code: 'execution_machine_missing',
    });
  });

  it('reports the exact disabled daemon feature before unknown runtime and model catalog facts', () => {
    const catalogUnknownAvailability = resolveVoiceProviderLocalAvailability({
      platformOs: 'web',
      daemonFeatureEnabled: false,
      serverFeatures: null,
      daemonDirectRouteAvailability: 'available',
      daemonPcmCapture: 'available',
    });

    expect(resolveVoiceDictationReadiness({
      registry,
      platform: 'web',
      executionMachineId: 'machine-online',
      localAvailability: catalogUnknownAvailability,
      settings: {
        voice: {
          dictation: {
            sttBinding: 'explicit',
            language: null,
            stt: {
              provider: 'local_neural',
              localNeural: {
                assetId: 'sherpa-streaming-zipformer-bilingual-zh-en',
                execution: 'daemon',
              },
            },
          },
        },
      },
    })).toMatchObject({
      providerId: 'local_neural',
      status: 'unavailable',
      code: 'server_feature_disabled',
      recoveryAction: 'switch_provider',
    });
  });
});
