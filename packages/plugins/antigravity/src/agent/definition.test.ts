import { describe, expect, it } from 'vitest';

import { AGENT_DEFINITION } from './definition.js';
import { PLUGIN_MANIFEST } from '../manifest.js';

describe('Antigravity agent definition', () => {
  it('keeps provider identity and backend ownership as definition data', () => {
    expect(JSON.parse(JSON.stringify(AGENT_DEFINITION))).toEqual(AGENT_DEFINITION);
    expect(AGENT_DEFINITION).toMatchObject({
      id: 'antigravity',
      core: {
        id: 'antigravity',
        backendDefinition: false,
        cliSubcommand: 'antigravity',
        detectKey: 'agy',
        flavorAliases: ['agy'],
        connectedServices: {
          supportedServiceIds: ['gemini'],
          supportedKindsByServiceId: { gemini: ['token'] },
        },
        sessionStorage: { direct: false, persisted: true },
        resume: { vendorResume: 'supported', vendorResumeIdField: 'antigravitySessionId' },
        handoff: { vendorStateTransfer: 'unsupported' },
        localControl: {
          supported: true,
          topology: 'exclusive',
          attachStrategy: 'terminal_host',
        },
        tools: { delivery: 'unsupported', support: 'unsupported' },
      },
      settingsBackendId: 'antigravity',
      ownedBackendIds: ['antigravity'],
      modelConfig: {
        supportsSelection: true,
        supportsFreeform: false,
        nonAcpApplyScope: 'next_prompt',
        acpApplyBehavior: 'restart_session',
        acpModelConfigOptionId: null,
        dynamicProbe: 'auto',
        defaultMode: 'Gemini 3.5 Flash (Medium)',
        allowedModes: ['Gemini 3.5 Flash (Medium)'],
        staticModels: [{
          id: 'Gemini 3.5 Flash (Medium)',
          name: 'Gemini 3.5 Flash (Medium)',
          description: expect.any(String),
        }],
      },
      runtimeContributions: {
        agentCatalogEntry: {
          importName: 'ANTIGRAVITY_AGENT_RUNTIME_CONTRIBUTION',
          source: './agent/contributions/runtime',
        },
      },
    });
    expect(AGENT_DEFINITION.core.connectedServices?.supportedKindsByServiceId?.gemini).toEqual(['token']);
    expect(AGENT_DEFINITION.core.connectedServices?.supportedKindsByServiceId?.gemini).not.toContain('oauth');
    expect(AGENT_DEFINITION).not.toHaveProperty('agentCliRuntime');
    expect(PLUGIN_MANIFEST.contributes.agents[0]?.cli).toMatchObject({
      executable: { binaryName: 'agy', sourcePreference: 'system-first' },
      install: { manual: { kind: 'vendor_recipe' } },
      auth: { support: 'login_terminal', machineLoginKey: 'antigravity-cli' },
    });
  });
});
