import { describe, expect, it } from 'vitest';

import { resolveSessionRuntimeSnapshot } from './resolveSessionRuntimeSnapshot';

describe('resolveSessionRuntimeSnapshot connected-services V2', () => {
  it('projects a durable Team model intent into the canonical launch binding on restart', () => {
    const result = resolveSessionRuntimeSnapshot({
      incomingOptions: { directory: '/tmp/repo' },
      persistedMetadata: {
        modelSelectionIntentV2: {
          v: 2, updatedAt: 10,
          ref: {
            source: 'team_resource', resourceId: 'resource-1', teamId: 'team-1',
            expectedResourceRevision: 7, deliveryMode: 'brokered',
            agentTargetKey: 'agent:happier.agent.codex/codex', modelId: 'model-1',
          },
        },
      },
    });
    // The launch binding must carry the Team route and Team identity, not just
    // the resource: a broker-routed resource is not interchangeable with a
    // direct one, and the recipient Team is part of the selection's identity.
    expect(result.spawnOptions.teamCredentialBindings).toEqual([{
      v: 1, slot: { kind: 'provider_model' }, resourceId: 'resource-1', expectedResourceRevision: 7,
      deliveryMode: 'brokered', teamId: 'team-1',
      providerModelSelection: { agentTargetKey: 'agent:happier.agent.codex/codex', modelId: 'model-1' },
    }]);
    expect(result.spawnOptions.modelSelection).toMatchObject({
      ref: { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: null, modelId: 'model-1' },
      updatedAt: 10,
    });
  });
  it('leaves a native persisted model intent out of the Team launch binding', () => {
    const result = resolveSessionRuntimeSnapshot({
      incomingOptions: { directory: '/tmp/repo' },
      persistedMetadata: {
        modelSelectionIntentV2: {
          v: 2, updatedAt: 10,
          ref: { source: 'native', agentTargetKey: 'agent:happier.agent.codex/codex', modelId: 'model-1' },
        },
      },
    });
    expect(result.snapshot.teamModelSelection).toBeNull();
    expect(result.snapshot.teamCredentialBindings).toBeNull();
    expect(result.spawnOptions.teamCredentialBindings).toBeUndefined();
  });
  it('round-trips team-resource identity and keeps the newest persisted authority', () => {
    const teamResourceBindings = {
      v: 2 as const,
      bindingsByServiceId: {
        'happier.agent.claude/claude-subscription': {
          source: 'team_resource' as const,
          resourceId: 'resource-1',
          deliveryMode: 'brokered' as const,
        },
      },
    };

    const result = resolveSessionRuntimeSnapshot({
      incomingOptions: {
        directory: '/tmp/repo',
        connectedServices: { v: 2, bindingsByServiceId: {} },
        connectedServicesUpdatedAt: 100,
      },
      persistedMetadata: {
        connectedServices: teamResourceBindings,
        connectedServicesUpdatedAt: 200,
      },
    });

    expect(result.snapshot.connectedServices).toEqual(teamResourceBindings);
    expect(result.spawnOptions.connectedServices).toEqual(teamResourceBindings);
    expect(result.spawnOptions.connectedServicesUpdatedAt).toBe(200);
  });
});
