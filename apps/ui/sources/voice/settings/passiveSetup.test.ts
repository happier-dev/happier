import { describe, expect, it } from 'vitest';

import {
  projectVoiceProviderAgentRealtimePassiveSetup,
  projectVoiceProviderConnectedServicesCredentialFact,
  projectVoiceProviderPassiveSetupFacts,
  readVoiceProviderConnectedServicesBinding,
  readVoiceProviderPassiveRealtimeSetupResult,
} from './passiveSetup';

const AGENT_REALTIME_EXECUTION = Object.freeze({
  kind: 'experimental_agent_session_realtime' as const,
  agent: Object.freeze({ pluginId: 'happier.agent.codex', localId: 'codex' }),
  supportedRuntimeVersions: Object.freeze(['0.145.0', '0.146.0']),
});

const AGENT_REALTIME_EXECUTION_WITHOUT_VERSION_POLICY = Object.freeze({
  kind: 'experimental_agent_session_realtime' as const,
  agent: Object.freeze({ pluginId: 'happier.agent.codex', localId: 'codex' }),
});

describe('projectVoiceProviderPassiveSetupFacts', () => {
  it('fails closed on the exact selected machine and supported runtime version', () => {
    expect(projectVoiceProviderPassiveSetupFacts({
      execution: AGENT_REALTIME_EXECUTION,
      executionMachineId: null,
      executionMachineOnline: false,
      runtimeCapabilityResult: null,
    })).toEqual({
      executionMachine: 'missing',
      runtime: 'unknown',
    });

    expect(projectVoiceProviderPassiveSetupFacts({
      execution: AGENT_REALTIME_EXECUTION,
      executionMachineId: 'machine-1',
      executionMachineOnline: false,
      runtimeCapabilityResult: null,
    })).toEqual({
      executionMachine: 'missing',
      runtime: 'unknown',
    });

    expect(projectVoiceProviderPassiveSetupFacts({
      execution: AGENT_REALTIME_EXECUTION,
      executionMachineId: 'machine-1',
      executionMachineOnline: true,
      runtimeCapabilityResult: null,
    })).toEqual({
      executionMachine: 'ready',
      runtime: 'unknown',
    });

    expect(projectVoiceProviderPassiveSetupFacts({
      execution: AGENT_REALTIME_EXECUTION,
      executionMachineId: 'machine-1',
      executionMachineOnline: true,
      runtimeCapabilityResult: {
        ok: true,
        checkedAt: 1,
        data: { available: true, version: '0.146.0' },
      },
    })).toEqual({
      executionMachine: 'ready',
      runtime: 'unknown',
    });

    expect(projectVoiceProviderPassiveSetupFacts({
      execution: AGENT_REALTIME_EXECUTION,
      executionMachineId: 'machine-1',
      executionMachineOnline: true,
      runtimeCapabilityResult: {
        ok: true,
        checkedAt: 1,
        data: { available: true, version: '0.146.0', resolvedPath: '/managed/codex' },
      },
    })).toEqual({
      executionMachine: 'ready',
      runtime: 'unknown',
    });

    expect(projectVoiceProviderPassiveSetupFacts({
      execution: AGENT_REALTIME_EXECUTION,
      executionMachineId: 'machine-1',
      executionMachineOnline: true,
      runtimeCapabilityResult: {
        ok: true,
        checkedAt: 1,
        data: { available: true, version: '0.146.1', resolvedPath: '/managed/codex' },
      },
    })).toEqual({
      executionMachine: 'ready',
      runtime: 'incompatible',
    });

    // The selection remains persisted even when it is currently unreachable.
    // Treating it as no selection would offer the wrong recovery and discard
    // the owner-local distinction the execution-machine selector already made.
    expect(projectVoiceProviderPassiveSetupFacts({
      execution: AGENT_REALTIME_EXECUTION,
      executionMachineId: 'machine-offline',
      executionMachineSelectionKind: 'selected_unreachable',
      executionMachineOnline: false,
      runtimeCapabilityResult: null,
    } as Parameters<typeof projectVoiceProviderPassiveSetupFacts>[0] & {
      executionMachineSelectionKind: 'selected_unreachable';
    })).toEqual({
      executionMachine: 'incompatible',
      runtime: 'unknown',
    });
  });

  it('derives the capability from the declared Agent local id', () => {
    expect(projectVoiceProviderAgentRealtimePassiveSetup(AGENT_REALTIME_EXECUTION)).toEqual({
      capabilityId: 'cli.codex',
      supportedRuntimeVersions: ['0.145.0', '0.146.0'],
    });
    expect(projectVoiceProviderPassiveSetupFacts({
      execution: AGENT_REALTIME_EXECUTION,
      executionMachineId: 'machine-1',
      executionMachineOnline: true,
      runtimeCapabilityResult: {
        ok: true,
        checkedAt: 1,
        data: { available: false },
      },
    })).toMatchObject({
      executionMachine: 'ready',
      runtime: 'missing',
    });
  });

  it('does not invent an exact runtime floor when the provider omits version policy', () => {
    expect(projectVoiceProviderAgentRealtimePassiveSetup(
      AGENT_REALTIME_EXECUTION_WITHOUT_VERSION_POLICY,
    )).toEqual({
      capabilityId: 'cli.codex',
    });
    expect(projectVoiceProviderPassiveSetupFacts({
      execution: AGENT_REALTIME_EXECUTION_WITHOUT_VERSION_POLICY,
      executionMachineId: 'machine-1',
      executionMachineOnline: true,
      runtimeCapabilityResult: {
        ok: true,
        checkedAt: 1,
        data: { available: true, version: '0.149.1', resolvedPath: '/managed/codex' },
      },
    })).toEqual({
      executionMachine: 'ready',
      runtime: 'unknown',
    });
  });

  it('accepts only the strict passive capability DTO and lets it own a checked result', () => {
    expect(readVoiceProviderPassiveRealtimeSetupResult({
      v: 1,
      status: 'ready',
      rawCodexResponse: { account: 'must-not-cross-the-seam' },
    })).toBeNull();

    expect(projectVoiceProviderPassiveSetupFacts({
      execution: AGENT_REALTIME_EXECUTION,
      executionMachineId: 'machine-1',
      executionMachineOnline: true,
      runtimeCapabilityResult: { ok: true, data: { available: false } },
      passiveRealtimeSetupResult: { v: 1, status: 'ready' },
    })).toEqual({
      executionMachine: 'ready',
      runtime: 'ready',
      credential: 'ready',
    });

    expect(projectVoiceProviderPassiveSetupFacts({
      execution: AGENT_REALTIME_EXECUTION,
      executionMachineId: 'machine-1',
      executionMachineOnline: true,
      runtimeCapabilityResult: null,
      passiveRealtimeSetupResult: { v: 1, status: 'authentication_required' },
    })).toEqual({
      executionMachine: 'ready',
      credential: 'missing',
    });

    expect(projectVoiceProviderPassiveSetupFacts({
      execution: AGENT_REALTIME_EXECUTION,
      executionMachineId: 'machine-1',
      executionMachineOnline: true,
      runtimeCapabilityResult: null,
      passiveRealtimeSetupResult: { v: 1, status: 'feature_disabled' },
    })).toEqual({
      executionMachine: 'ready',
      runtime: 'missing',
      credential: 'ready',
    });

    // The strict unavailable result reports no more than the generic
    // runtime-unknown fact. The settings projection decides that this passive
    // result must not offer a provider-switch action.
    expect(projectVoiceProviderPassiveSetupFacts({
      execution: AGENT_REALTIME_EXECUTION,
      executionMachineId: 'machine-1',
      executionMachineOnline: true,
      runtimeCapabilityResult: null,
      passiveRealtimeSetupResult: { v: 1, status: 'unavailable' },
    })).toEqual({
      executionMachine: 'ready',
      runtime: 'unknown',
    });
  });

  it('uses canonical exact-profile health for a declared Connected Services binding', () => {
    const providerSettings = {
      connectedServicesBinding: {
        id: 'globalConnectedServices',
        title: 'Codex account',
        agent: { pluginId: 'happier.agent.codex', localId: 'codex' },
        serviceIds: ['openai-codex'] as const,
      },
    };
    const providerConfig = {
      globalConnectedServices: {
        v: 1,
        bindingsByServiceId: {
          'happier.agent.codex/openai-codex': {
            source: 'connected',
            selection: 'profile',
            profileId: 'codex-profile',
          },
        },
      },
    };

    expect(readVoiceProviderConnectedServicesBinding({
      providerSettings,
      providerConfig,
    })).toEqual(providerConfig.globalConnectedServices);

    expect(projectVoiceProviderConnectedServicesCredentialFact({
      providerSettings,
      providerConfig,
      accountProfileConnectedServicesV2: [{
        serviceId: 'openai-codex',
        profiles: [{ profileId: 'codex-profile', status: 'connected', kind: 'oauth' }],
      }],
      labelsByKey: {},
      accountGroupsEnabled: false,
    })).toBe('ready');
    expect(projectVoiceProviderConnectedServicesCredentialFact({
      providerSettings,
      providerConfig,
      accountProfileConnectedServicesV2: [{
        serviceId: 'openai-codex',
        profiles: [{ profileId: 'codex-profile', status: 'needs_reauth', kind: 'oauth' }],
      }],
      labelsByKey: {},
      accountGroupsEnabled: false,
    })).toBe('missing');
    expect(projectVoiceProviderConnectedServicesCredentialFact({
      providerSettings,
      providerConfig,
      accountProfileConnectedServicesV2: [{
        serviceId: 'openai-codex',
        profiles: [{
          profileId: 'codex-profile',
          status: 'refresh_failed_retryable',
          kind: 'oauth',
        }],
      }],
      labelsByKey: {},
      accountGroupsEnabled: false,
    })).toBe('ready');
  });
});
