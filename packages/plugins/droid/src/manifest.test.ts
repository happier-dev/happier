import { ingestPluginManifestV2 } from '@happier-dev/protocol';
import { projectAgentCapabilitiesV2FromDefinition } from '@happier-dev/plugin-sdk/agents';
import { describe, expect, it } from 'vitest';

import { AGENT_DEFINITION } from './agent/definition.js';
import { PLUGIN_MANIFEST } from './manifest.js';

describe('Factory Droid plugin manifest', () => {
  it('ingests the Provider-capable Droid launch leaf', () => {
    expect(ingestPluginManifestV2(PLUGIN_MANIFEST)).toMatchObject({ ok: true });
    expect(PLUGIN_MANIFEST).toHaveProperty('entrypoints.daemon', './.happier-plugin/daemon.js');
    expect(PLUGIN_MANIFEST.contributes.agents).toEqual([
      expect.objectContaining({
        id: 'droid',
        runtime: { kind: 'custom' },
        providerRequirements: expect.objectContaining({ materialization: 'configFile', applyPolicy: 'restart_session' }),
        primary: 'sessions',
      }),
    ]);
    expect(PLUGIN_MANIFEST.contributes.agents[0]).not.toHaveProperty('factory');
  });

  it('projects capabilities from the agent definition through the canonical owner', () => {
    const [agent] = PLUGIN_MANIFEST.contributes.agents;
    const { skills, ...coreCapabilities } = agent.capabilities;
    // The manifest must equal the canonical projection of its own definition:
    // hand-copied capability blocks (and a session-primary `executionRuns`
    // restatement) drift from the definition and fail manifest ingest.
    expect(coreCapabilities).toEqual(
      projectAgentCapabilitiesV2FromDefinition(AGENT_DEFINITION.core, {
        surfaces: ['externalSessions'],
        sessions: {
          open: ['create', 'resume'],
          delivery: ['newTurn', 'followUp'],
          cancel: true,
          configuration: true,
          executionRunContext: { versions: [1] },
        },
      }),
    );
    expect(skills).toMatchObject({
      delivery: 'none', nativeDisable: 'unsupported', liveReload: 'unsupported',
    });
    // Terminal hosting is derived from `localControl.attachStrategy`, and tool
    // delivery from the definition's tool facts — never restated by hand.
    expect(agent.capabilities).toMatchObject({
      surfaces: expect.arrayContaining(['terminal', 'externalSessions']),
      tools: { delivery: 'native_mcp' },
    });
    expect(agent.capabilities).not.toHaveProperty('executionRuns');
  });
});
