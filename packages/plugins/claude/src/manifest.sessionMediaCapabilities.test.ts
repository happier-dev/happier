import { describe, expect, it } from 'vitest';

import { PluginAgentCapabilitiesV1Schema as PluginBackendCapabilitiesV1Schema } from '@happier-dev/plugin-sdk/agents';

import { PLUGIN_MANIFEST } from './manifest.js';

function capabilitiesForBackend(id: string) {
  const backend = PLUGIN_MANIFEST.contributes?.agents?.find((entry) => entry.id === id);
  if (!backend) throw new Error(`Missing backend declaration: ${id}`);
  return PluginBackendCapabilitiesV1Schema.parse(backend.capabilities ?? {});
}

describe('Claude plugin AgentRuntime capabilities', () => {
  it('declares Claude as a native custom Agent contribution', () => {
    const agent = PLUGIN_MANIFEST.contributes?.agents?.find((entry) => entry.id === 'claude');

    expect(agent).toEqual(expect.objectContaining({
      id: 'claude',
      runtime: { kind: 'custom' },
      primary: 'sessions',
      capabilities: expect.objectContaining({
        surfaces: ['terminal', 'externalSessions'],
      }),
    }));
    expect(agent && 'ownedBackendIds' in agent).toBe(false);
    expect(agent && 'agentCliRuntime' in agent).toBe(false);
  });

  it('declares native Session operations and leaves finite Runs host-derived', () => {
    const agent = PLUGIN_MANIFEST.contributes?.agents?.find((entry) => entry.id === 'claude');

    expect(agent?.capabilities?.sessions).toEqual({
      open: ['create', 'resume'],
      delivery: ['newTurn', 'steer', 'followUp'],
      cancel: true,
      configuration: true,
      goals: {
        active: {
          clear: true,
          set: { fields: ['objective'] },
        },
        inactive: {
          get: true,
          clear: true,
          set: { fields: ['objective'] },
        },
        source: 'goals',
      },
      runtimeActivitySnapshots: true,
      workStateSources: [{ id: 'goals', itemKinds: ['goal'] }],
    });
    expect(agent?.capabilities).not.toHaveProperty('executionRuns');
  });

  it('declares terminal and current-session host access through V2 hostAccess grants', () => {
    expect(PLUGIN_MANIFEST.hostAccess.required).toEqual(expect.arrayContaining([
      expect.objectContaining({ capability: 'terminal' }),
      expect.objectContaining({ capability: 'sessions' }),
    ]));
    expect(PLUGIN_MANIFEST.hostAccess.required.find((entry) => entry.capability === 'process')?.scope).toMatchObject({
      envKeys: expect.arrayContaining([
        'ANTHROPIC_API_KEY',
        'ANTHROPIC_AUTH_TOKEN',
        'CLAUDE_CONFIG_DIR',
        'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS',
        'CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH',
        'HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON',
        'USER',
      ]),
    });
  });

  it('does not claim media emission or native image generation', () => {
    const capabilities = capabilitiesForBackend('claude');

    expect(capabilities.session.media.emitsSessionMedia.supported).toBe(false);
    expect(capabilities.session.media.nativeImageGeneration.supported).toBe(false);
  });
});
