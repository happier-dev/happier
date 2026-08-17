import { describe, expect, it } from 'vitest';

import {
  projectVoiceProviderAgentRealtimePassiveSetup,
  projectVoiceProviderConnectedServicesCredentialFact,
  projectVoiceProviderPassiveSetupFacts,
} from './passiveSetup';

const AGENT_REALTIME_EXECUTION = Object.freeze({
  kind: 'experimental_agent_session_realtime' as const,
  agent: Object.freeze({ pluginId: 'happier.agent.codex', localId: 'codex' }),
  supportedRuntimeVersions: Object.freeze(['0.145.0', '0.146.0']),
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
          'openai-codex': {
            source: 'connected',
            selection: 'profile',
            profileId: 'codex-profile',
          },
        },
      },
    };

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
