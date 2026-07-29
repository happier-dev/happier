import { describe, expect, it } from 'vitest';

import { createVoiceProviderRegistry, type VoiceUiRuntimeContribution } from './providerRegistry';
import { createDefaultVoiceProviderRegistry } from './defaultRegistry';
import { isVoiceRoleSelectableForConfiguration, resolveVoiceRoleReadiness } from './readiness';

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

const registry = createVoiceProviderRegistry({ bundled: [CLOUD_STT] });

const readyFacts = {
  settings: 'ready',
  executionMachine: 'ready',
  credential: 'ready',
  endpoint: 'ready',
  runtime: 'ready',
  model: 'ready',
} as const;

describe('resolveVoiceRoleReadiness', () => {
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

  it('fails Google speech roles closed when required provider facts are unknown', () => {
    const googleRegistry = createDefaultVoiceProviderRegistry();
    expect(resolveVoiceRoleReadiness({
      registry: googleRegistry,
      role: 'conversation_stt',
      providerId: 'google_gemini',
      platform: 'web',
      facts: { ...readyFacts, credential: 'unknown' },
    })).toMatchObject({ status: 'unavailable', code: 'credential_unknown' });
    expect(resolveVoiceRoleReadiness({
      registry: googleRegistry,
      role: 'conversation_tts',
      providerId: 'google_cloud',
      platform: 'web',
      facts: { ...readyFacts, runtime: 'unknown' },
    })).toMatchObject({ status: 'unavailable', code: 'runtime_unknown' });
  });

  it('separates recoverable credential configuration from truthful runnable readiness', () => {
    const credentialUnknown = resolveVoiceRoleReadiness({
      registry: createDefaultVoiceProviderRegistry(),
      role: 'realtime_conversation',
      providerId: 'realtime_openai',
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
    })).toBe(true);
    expect(isVoiceRoleSelectableForConfiguration({
      readiness: credentialUnknown,
      credentialConfigurationAvailable: false,
    })).toBe(false);

    const unsupportedPlatform = resolveVoiceRoleReadiness({
      registry: createDefaultVoiceProviderRegistry(),
      role: 'realtime_conversation',
      providerId: 'realtime_openai',
      platform: 'ios',
      modeId: 'byo',
      facts: { ...readyFacts, credential: 'unknown' },
    });
    expect(unsupportedPlatform).toMatchObject({ status: 'incompatible', code: 'platform_unsupported' });
    expect(isVoiceRoleSelectableForConfiguration({
      readiness: unsupportedPlatform,
      credentialConfigurationAvailable: true,
    })).toBe(false);

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
    })).toBe(false);
  });

  it('admits the bundled ElevenLabs public leaf on web through the first-party projection', () => {
    expect(resolveVoiceRoleReadiness({
      registry: createDefaultVoiceProviderRegistry(),
      role: 'realtime_conversation',
      providerId: 'realtime_elevenlabs',
      platform: 'web',
      modeId: 'byo',
      facts: readyFacts,
    })).toMatchObject({ status: 'ready', code: 'ready' });
  });

  it.each(['ios', 'android'] as const)(
    'fails the bundled ElevenLabs public leaf closed on unsupported %s',
    (platform) => {
      expect(resolveVoiceRoleReadiness({
        registry: createDefaultVoiceProviderRegistry(),
        role: 'realtime_conversation',
        providerId: 'realtime_elevenlabs',
        platform,
        modeId: 'byo',
        facts: readyFacts,
      })).toMatchObject({ status: 'incompatible', code: 'platform_unsupported' });
    },
  );

  it('does not advertise undeclared desktop support for bundled ElevenLabs', () => {
    expect(resolveVoiceRoleReadiness({
      registry: createDefaultVoiceProviderRegistry(),
      role: 'realtime_conversation',
      providerId: 'realtime_elevenlabs',
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
      bundled: [{
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

  it('projects a disabled deployment feature through the same requirement owner', () => {
    const hostedRegistry = createVoiceProviderRegistry({
      bundled: [{ ...CLOUD_STT, requirements: ['server_feature'] }],
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
