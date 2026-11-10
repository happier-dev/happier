import { derivePluginDaemonContributionRegistrationRights } from '@happier-dev/protocol/plugins/contributions/catalog';
import { ingestPluginManifestV2 } from '@happier-dev/protocol/plugins/manifest/ingest';
import { projectAgentCapabilitiesV2FromDefinition } from '@happier-dev/plugin-sdk/agents';
import { describe, expect, it } from 'vitest';

import { AGENT_DEFINITION } from './agent/definition.js';
import { PLUGIN_MANIFEST } from './manifest.js';

describe('FX plugin manifest', () => {
  it('ingests the plugin runtime that composes the shared ACP owner', () => {
    expect(ingestPluginManifestV2(PLUGIN_MANIFEST)).toMatchObject({ ok: true });
    expect(PLUGIN_MANIFEST).toHaveProperty('entrypoints.daemon', './.happier-plugin/daemon.js');
    expect(PLUGIN_MANIFEST.contributes.agents).toEqual([
      expect.objectContaining({
        id: 'fx',
        runtime: expect.objectContaining({ kind: 'custom' }),
        primary: 'sessions',
      }),
    ]);
    expect(PLUGIN_MANIFEST.contributes.agents[0]).not.toHaveProperty('factory');
  });

  it('projects capabilities from the agent definition through the canonical owner', () => {
    const [agent] = PLUGIN_MANIFEST.contributes.agents;
    const { skills, providerStateSharing, ...coreCapabilities } = agent.capabilities;
    // The manifest must equal the canonical projection of its own definition:
    // hand-copied capability blocks (and a session-primary `executionRuns`
    // restatement) drift from the definition and fail manifest ingest.
    expect(coreCapabilities).toEqual(
      projectAgentCapabilitiesV2FromDefinition(AGENT_DEFINITION.core, {
        surfaces: ['externalSessions'],
        sessions: {
          open: ['create', 'resume'],
          delivery: ['newTurn', 'followUp', 'steer'],
          cancel: true,
          configuration: true,
          executionRunContext: { versions: [1] },
        },
      }),
    );
    expect(skills).toMatchObject({ delivery: 'none', nativeDisable: 'unsupported', liveReload: 'unsupported' });
    expect(providerStateSharing).toMatchObject({ config: { supported: true }, state: { supported: true } });
    // Terminal hosting is derived from `localControl.attachStrategy`, and tool
    // delivery from the definition's tool facts — never restated by hand.
    expect(agent.capabilities).toMatchObject({
      surfaces: ['terminal', 'externalSessions'],
      tools: { delivery: 'native_mcp' },
    });
    expect(agent.capabilities).not.toHaveProperty('executionRuns');
  });

  it('declares one native source with ACP-compatible session identities', () => {
    const [agent] = PLUGIN_MANIFEST.contributes.agents;
    expect(agent.capabilities.surfaces).toContain('externalSessions');
    expect(agent.surfaces?.externalSession).toEqual({
      sources: [{
        sourceKind: 'fxHome',
        contentSearch: true,
        schema: { fields: [{ kind: 'literal', name: 'kind', value: 'fxHome' }] },
        key: { segments: [{ kind: 'literal', value: 'fxHome' }] },
        instances: [{ kind: 'default', constants: {} }],
      }],
    });
    expect(agent.surfaces?.externalSession).not.toHaveProperty('externalLinkedTakeover');
    expect(agent).toMatchObject({ primary: 'sessions', runtime: { kind: 'custom' } });
    expect(agent.capabilities.sessions?.open).toContain('resume');
  });

  it('requires the native External Sessions reader through the public activation ABI', () => {
    expect(derivePluginDaemonContributionRegistrationRights(
      PLUGIN_MANIFEST.contributes as unknown as Readonly<Record<string, unknown>>,
    )).toContainEqual(expect.objectContaining({
      family: 'agents',
      localId: 'fx',
      requiredFields: expect.arrayContaining(['factory', 'externalSessions']),
    }));
  });
});
