import { describe, expect, it } from 'vitest';

import { createVoiceProviderRegistry, type VoiceUiRuntimeContribution } from './providerRegistry';
import { createDefaultVoiceProviderRegistry } from './defaultRegistry';
import {
  isVoiceRoleSelectableForConfiguration,
  projectVoiceProviderRequirements,
  resolveVoicePassiveSetupReadiness,
  resolveVoiceRoleReadiness,
} from './readiness';

const CLOUD_STT = {
  kind: 'voice.speech-engine.v1',
  pluginId: 'happier.voice.fixture',
  providerId: 'cloud_stt',
  role: 'stt',
  settingsSectionId: 'voice.fixture.cloudStt',
  roles: ['dictation_stt', 'conversation_stt'],
  requirements: ['execution_machine', 'credential', 'endpoint', 'runtime', 'model'],
  supportedPlatforms: ['web', 'ios', 'android'],
} as const satisfies VoiceUiRuntimeContribution;

const registry = createVoiceProviderRegistry({ builtIn: [CLOUD_STT] });

const readyFacts = {
  settings: 'ready',
  executionMachine: 'ready',
  credential: 'ready',
  endpoint: 'ready',
  runtime: 'ready',
  model: 'ready',
} as const;

describe('resolveVoiceRoleReadiness', () => {
  it('uses declaration-derived machine, runtime, and Connected Services checks for Codex', () => {
    expect(resolveVoicePassiveSetupReadiness({
      registry: createDefaultVoiceProviderRegistry(),
      role: 'realtime_conversation',
      providerId: 'happier.agent.codex/realtime-codex',
      platform: 'web',
      modeId: 'experimental',
      facts: {
        ...readyFacts,
        executionMachine: 'missing',
      },
    })).toMatchObject({
      status: 'needs_setup',
      code: 'execution_machine_missing',
    });
    expect(resolveVoicePassiveSetupReadiness({
      registry: createDefaultVoiceProviderRegistry(),
      role: 'realtime_conversation',
      providerId: 'happier.agent.codex/realtime-codex',
      platform: 'web',
      modeId: 'experimental',
      facts: readyFacts,
    })).toMatchObject({ status: 'ready', code: 'ready' });
  });

  it('keeps dictation and conversation role support separate', () => {
    expect(resolveVoiceRoleReadiness({
      registry,
      role: 'dictation_stt',
      providerId: 'cloud_stt',
      platform: 'web',
      facts: readyFacts,
    }).status).toBe('ready');

    expect(resolveVoiceRoleReadiness({
      registry,
      role: 'conversation_tts',
      providerId: 'cloud_stt',
      platform: 'web',
      facts: readyFacts,
    })).toMatchObject({ status: 'incompatible', code: 'role_unsupported' });
  });

  it('keeps built-in Device TTS ready without applying the Dictation STT capability fact', () => {
    expect(resolveVoiceRoleReadiness({
      registry: createDefaultVoiceProviderRegistry(),
      role: 'conversation_tts',
      providerId: 'device',
      platform: 'ios',
      facts: { ...readyFacts, runtime: 'unknown' },
    })).toMatchObject({ status: 'ready', code: 'ready' });
  });

  it.each([
    {
      label: 'available web recognition',
      platform: 'web' as const,
      localAvailability: {
        browserSpeech: { support: 'available', onDevice: 'available' },
      } as const,
      expected: { status: 'ready', code: 'ready' },
    },
    {
      label: 'cloud-only web recognition',
      platform: 'web' as const,
      localAvailability: {
        browserSpeech: { support: 'cloud_only', onDevice: 'unsupported' },
      } as const,
      expected: { status: 'ready', code: 'ready' },
    },
    {
      label: 'unsupported web recognition',
      platform: 'web' as const,
      localAvailability: {
        browserSpeech: { support: 'unavailable', onDevice: 'unsupported' },
      } as const,
      expected: { status: 'unavailable', code: 'device_stt_unavailable' },
    },
    {
      label: 'unknown web recognition',
      platform: 'web' as const,
      localAvailability: {
        browserSpeech: { support: 'unknown', onDevice: 'unknown' },
      } as const,
      expected: { status: 'unavailable', code: 'device_stt_availability_unknown' },
    },
    {
      label: 'available native recognition',
      platform: 'ios' as const,
      localAvailability: {
        nativeDevice: { requested: true, speechRecognition: 'available' },
      } as const,
      expected: { status: 'ready', code: 'ready' },
    },
    {
      label: 'unsupported native recognition',
      platform: 'ios' as const,
      localAvailability: {
        nativeDevice: { requested: true, speechRecognition: 'unavailable' },
      } as const,
      expected: { status: 'unavailable', code: 'device_stt_unavailable' },
    },
  ])('projects built-in Device STT from $label', ({ platform, localAvailability, expected }) => {
    expect(resolveVoiceRoleReadiness({
      registry: createDefaultVoiceProviderRegistry(),
      role: 'dictation_stt',
      providerId: 'device',
      platform,
      localAvailability,
      facts: readyFacts,
    })).toMatchObject(expected);
  });

  it('fails Google speech roles closed when required provider facts are unknown', () => {
    const googleRegistry = createDefaultVoiceProviderRegistry();
    expect(resolveVoiceRoleReadiness({
      registry: googleRegistry,
      role: 'conversation_stt',
      providerId: 'happier.voice.google/gemini-stt',
      platform: 'web',
      facts: { ...readyFacts, credential: 'unknown' },
    })).toMatchObject({ status: 'unavailable', code: 'credential_unknown' });
    expect(resolveVoiceRoleReadiness({
      registry: googleRegistry,
      role: 'conversation_tts',
      providerId: 'happier.voice.google/google-cloud-tts',
      platform: 'web',
      facts: { ...readyFacts, executionMachine: 'unknown' },
    })).toMatchObject({ status: 'unavailable', code: 'execution_machine_unknown' });
  });

  it('separates recoverable credential configuration from truthful runnable readiness', () => {
    const credentialUnknown = resolveVoiceRoleReadiness({
      registry: createDefaultVoiceProviderRegistry(),
      role: 'realtime_conversation',
      providerId: 'happier.voice.openai/realtime-openai',
      platform: 'web',
      modeId: 'byo',
      facts: { ...readyFacts, credential: 'unknown' },
    });
    expect(credentialUnknown).toMatchObject({
      status: 'unavailable',
      code: 'credential_unknown',
      recoveryAction: 'configure_credential',
    });
    expect(isVoiceRoleSelectableForConfiguration({
      readiness: credentialUnknown,
      credentialConfigurationAvailable: true,
      passiveRuntimeCheckAvailable: false,
    })).toBe(true);
    expect(isVoiceRoleSelectableForConfiguration({
      readiness: credentialUnknown,
      credentialConfigurationAvailable: false,
      passiveRuntimeCheckAvailable: false,
    })).toBe(false);

    const nativeCredentialUnknown = resolveVoiceRoleReadiness({
      registry: createDefaultVoiceProviderRegistry(),
      role: 'realtime_conversation',
      providerId: 'happier.voice.openai/realtime-openai',
      platform: 'ios',
      modeId: 'byo',
      facts: { ...readyFacts, credential: 'unknown' },
    });
    expect(nativeCredentialUnknown).toMatchObject({
      status: 'unavailable',
      code: 'credential_unknown',
      recoveryAction: 'configure_credential',
    });
    expect(isVoiceRoleSelectableForConfiguration({
      readiness: nativeCredentialUnknown,
      credentialConfigurationAvailable: true,
      passiveRuntimeCheckAvailable: false,
    })).toBe(true);

    const unsupportedDesktop = resolveVoiceRoleReadiness({
      registry: createDefaultVoiceProviderRegistry(),
      role: 'realtime_conversation',
      providerId: 'happier.voice.openai/realtime-openai',
      platform: 'windows',
      modeId: 'byo',
      facts: readyFacts,
    });
    expect(unsupportedDesktop).toMatchObject({ status: 'incompatible', code: 'platform_unsupported' });

    const missingContribution = resolveVoiceRoleReadiness({
      registry,
      role: 'conversation_stt',
      providerId: 'missing',
      platform: 'web',
      facts: readyFacts,
    });
    expect(missingContribution).toMatchObject({ status: 'unavailable', code: 'contribution_unavailable' });
    expect(isVoiceRoleSelectableForConfiguration({
      readiness: missingContribution,
      credentialConfigurationAvailable: true,
      passiveRuntimeCheckAvailable: false,
    })).toBe(false);
  });

  it('keeps a not-yet-checked Agent runtime configurable without making it Start-ready', () => {
    const runtimeUnknown = resolveVoiceRoleReadiness({
      registry: createDefaultVoiceProviderRegistry(),
      role: 'realtime_conversation',
      providerId: 'happier.agent.codex/realtime-codex',
      platform: 'web',
      modeId: 'experimental',
      facts: { ...readyFacts, runtime: 'unknown' },
    });
    expect(runtimeUnknown).toMatchObject({
      status: 'unavailable',
      code: 'runtime_unknown',
    });
    expect(runtimeUnknown.status).not.toBe('ready');
    expect(isVoiceRoleSelectableForConfiguration({
      readiness: runtimeUnknown,
      credentialConfigurationAvailable: false,
      passiveRuntimeCheckAvailable: true,
    })).toBe(true);

    const runtimeIncompatible = resolveVoiceRoleReadiness({
      registry: createDefaultVoiceProviderRegistry(),
      role: 'realtime_conversation',
      providerId: 'happier.agent.codex/realtime-codex',
      platform: 'web',
      modeId: 'experimental',
      facts: { ...readyFacts, runtime: 'incompatible' },
    });
    expect(runtimeIncompatible).toMatchObject({
      status: 'incompatible',
      code: 'runtime_incompatible',
    });
    expect(isVoiceRoleSelectableForConfiguration({
      readiness: runtimeIncompatible,
      credentialConfigurationAvailable: false,
      passiveRuntimeCheckAvailable: true,
    })).toBe(false);
  });

  it('admits the bundled ElevenLabs public leaf on web through the first-party projection', () => {
    expect(resolveVoiceRoleReadiness({
      registry: createDefaultVoiceProviderRegistry(),
      role: 'realtime_conversation',
      providerId: 'happier.voice.elevenlabs/realtime-elevenlabs',
      platform: 'web',
      modeId: 'byo',
      facts: readyFacts,
    })).toMatchObject({ status: 'ready', code: 'ready' });
  });

  it.each(['ios', 'android'] as const)(
    'admits the bundled ElevenLabs public leaf on supported native %s',
    (platform) => {
      expect(resolveVoiceRoleReadiness({
        registry: createDefaultVoiceProviderRegistry(),
        role: 'realtime_conversation',
        providerId: 'happier.voice.elevenlabs/realtime-elevenlabs',
        platform,
        modeId: 'byo',
        facts: readyFacts,
      })).toMatchObject({ status: 'ready', code: 'ready' });
    },
  );

  it('does not advertise undeclared desktop support for bundled ElevenLabs', () => {
    expect(resolveVoiceRoleReadiness({
      registry: createDefaultVoiceProviderRegistry(),
      role: 'realtime_conversation',
      providerId: 'happier.voice.elevenlabs/realtime-elevenlabs',
      platform: 'windows',
      modeId: 'byo',
      facts: readyFacts,
    })).toMatchObject({ status: 'incompatible', code: 'platform_unsupported' });
  });

  it.each([
    ['executionMachine', 'needs_setup', 'execution_machine_missing', 'select_execution_machine'],
    ['credential', 'needs_setup', 'credential_missing', 'configure_credential'],
    ['endpoint', 'needs_setup', 'endpoint_missing', 'configure_endpoint'],
    ['runtime', 'needs_setup', 'runtime_missing', 'switch_provider'],
    ['model', 'needs_setup', 'model_missing', 'install_model'],
  ] as const)('projects missing %s facts with an actionable result', (fact, status, code, recoveryAction) => {
    expect(resolveVoiceRoleReadiness({
      registry,
      role: 'conversation_stt',
      providerId: 'cloud_stt',
      platform: 'web',
      facts: { ...readyFacts, [fact]: 'missing' },
    })).toMatchObject({ status, code, recoveryAction });
  });

  it('distinguishes a retained credential awaiting recipient approval from a missing credential', () => {
    expect(resolveVoiceRoleReadiness({
      registry,
      role: 'conversation_stt',
      providerId: 'cloud_stt',
      platform: 'web',
      facts: { ...readyFacts, credential: 'approval_required' },
    })).toMatchObject({
      status: 'needs_setup',
      code: 'credential_approval_required',
      recoveryAction: 'review_credential_access',
    });
  });

  it('does not conflate a missing installable runtime with an incompatible runtime family', () => {
    expect(resolveVoiceRoleReadiness({
      registry,
      role: 'conversation_stt',
      providerId: 'cloud_stt',
      platform: 'web',
      facts: { ...readyFacts, runtime: 'missing' },
    })).toMatchObject({ status: 'needs_setup', code: 'runtime_missing' });
    expect(resolveVoiceRoleReadiness({
      registry,
      role: 'conversation_stt',
      providerId: 'cloud_stt',
      platform: 'web',
      facts: { ...readyFacts, runtime: 'incompatible' },
    })).toMatchObject({ status: 'incompatible', code: 'runtime_incompatible' });
  });

  it('projects installing models without conflating them with missing credentials', () => {
    expect(resolveVoiceRoleReadiness({
      registry,
      role: 'conversation_stt',
      providerId: 'cloud_stt',
      platform: 'web',
      facts: { ...readyFacts, model: 'installing' },
    })).toMatchObject({ status: 'installing', code: 'model_installing' });
  });

  it('uses mode-specific requirements without a generic provider-id branch', () => {
    const modeRegistry = createVoiceProviderRegistry({
      builtIn: [{
        ...CLOUD_STT,
        requirements: [],
        requirementsByMode: { byo: ['execution_machine', 'credential'] },
      }],
    });
    expect(resolveVoiceRoleReadiness({
      registry: modeRegistry,
      role: 'conversation_stt',
      providerId: 'cloud_stt',
      platform: 'web',
      modeId: 'byo',
      facts: { ...readyFacts, credential: 'missing' },
    })).toMatchObject({ status: 'needs_setup', code: 'credential_missing' });
    expect(resolveVoiceRoleReadiness({
      registry: modeRegistry,
      role: 'conversation_stt',
      providerId: 'cloud_stt',
      platform: 'web',
      modeId: 'unknown_mode',
      facts: readyFacts,
    })).toMatchObject({ status: 'needs_setup', code: 'provider_mode_unknown' });
  });

  it('projects a selected Connected Account machine dependency through the canonical requirement owner', () => {
    const openAi = createDefaultVoiceProviderRegistry().get('happier.voice.openai/realtime-openai');
    if (!openAi) throw new Error('expected_openai_voice_provider');

    expect(projectVoiceProviderRequirements(openAi, 'byo', 'savedSecret'))
      .not.toContain('execution_machine');
    expect(projectVoiceProviderRequirements(openAi, 'byo', 'connectedAccount'))
      .toContain('execution_machine');
    expect(resolveVoiceRoleReadiness({
      registry: createDefaultVoiceProviderRegistry(),
      role: 'realtime_conversation',
      providerId: 'happier.voice.openai/realtime-openai',
      platform: 'web',
      modeId: 'byo',
      credentialSourceKind: 'connectedAccount',
      facts: { ...readyFacts, executionMachine: 'missing' },
    })).toMatchObject({
      status: 'needs_setup',
      code: 'execution_machine_missing',
    });
  });

  it('projects a disabled deployment feature through the same requirement owner', () => {
    const hostedRegistry = createVoiceProviderRegistry({
      builtIn: [{ ...CLOUD_STT, requirements: ['server_feature'] }],
    });
    expect(resolveVoiceRoleReadiness({
      registry: hostedRegistry,
      role: 'conversation_stt',
      providerId: 'cloud_stt',
      platform: 'web',
      facts: { ...readyFacts, serverFeature: 'missing' },
    })).toMatchObject({ status: 'unavailable', code: 'server_feature_disabled' });
  });

  it('fails closed for missing providers, unsupported platforms, malformed settings, and unknown facts', () => {
    expect(resolveVoiceRoleReadiness({
      registry,
      role: 'conversation_stt',
      providerId: 'disabled_or_missing',
      platform: 'web',
      facts: readyFacts,
    })).toMatchObject({ status: 'unavailable', code: 'contribution_unavailable' });

    expect(resolveVoiceRoleReadiness({
      registry,
      role: 'conversation_stt',
      providerId: 'cloud_stt',
      platform: 'windows',
      facts: readyFacts,
    })).toMatchObject({ status: 'incompatible', code: 'platform_unsupported' });

    expect(resolveVoiceRoleReadiness({
      registry,
      role: 'conversation_stt',
      providerId: 'cloud_stt',
      platform: 'web',
      facts: { ...readyFacts, settings: 'invalid' },
    })).toMatchObject({ status: 'needs_setup', code: 'settings_invalid' });

    expect(resolveVoiceRoleReadiness({
      registry,
      role: 'conversation_stt',
      providerId: 'cloud_stt',
      platform: 'web',
      facts: { ...readyFacts, settings: 'missing_required_setting' },
    })).toMatchObject({
      status: 'needs_setup',
      code: 'settings_missing_required_setting',
      recoveryAction: 'open_provider_settings',
    });

    expect(resolveVoiceRoleReadiness({
      registry,
      role: 'conversation_stt',
      providerId: 'cloud_stt',
      platform: 'web',
      facts: { ...readyFacts, credential: 'unknown' },
    })).toMatchObject({ status: 'unavailable', code: 'credential_unknown' });
  });

  it('treats an absent selection as unconfigured without selecting a fallback', () => {
    expect(resolveVoiceRoleReadiness({
      registry,
      role: 'dictation_stt',
      providerId: null,
      platform: 'web',
      facts: readyFacts,
    })).toMatchObject({ status: 'needs_setup', code: 'provider_unselected', recoveryAction: 'select_provider' });
  });
});
