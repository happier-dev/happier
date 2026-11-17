import { describe, expect, it } from 'vitest';
import { SessionModelSelectionSchema, type SessionModelSelection } from '@happier-dev/protocol/providers/selection/v2';

import { resolveSessionRuntimeSnapshot } from './resolveSessionRuntimeSnapshot';

describe('resolveSessionRuntimeSnapshot connected-services V2', () => {
  const agentTargetKey = 'agent:happier.agent.codex/codex';
  const teamSelection = { v: 2, updatedAt: 20, ref: {
    source: 'team_resource', resourceId: 'resource-new', teamId: 'team-new', expectedResourceRevision: 7,
    deliveryMode: 'brokered', agentTargetKey, modelId: 'requested-model',
  } } satisfies SessionModelSelection;

  it.each([
    { v: 2, updatedAt: 20, ref: { source: 'native', agentTargetKey, modelId: 'requested-model' } },
    { v: 2, updatedAt: 20, ref: { source: 'account_provider_connection', agentTargetKey,
      providerConnectionId: 'provider-new', modelId: 'requested-model' } },
    teamSelection,
  ] satisfies SessionModelSelection[])(
    'keeps incoming $ref.source usable at native resume', selection => {
      const result = resolveSessionRuntimeSnapshot({ incomingOptions: { directory: '/repo', modelSelection: selection } });
      expect(SessionModelSelectionSchema.safeParse(result.spawnOptions.modelSelection).success).toBe(true);
      expect(result.spawnOptions.modelSelection).toEqual(selection);
      if (selection.v === 2 && selection.ref.source === 'team_resource') {
        expect(result.spawnOptions.teamCredentialBindings).toMatchObject([{ resourceId: 'resource-new', teamId: 'team-new',
          deliveryMode: 'brokered', providerModelSelection: { agentTargetKey, modelId: 'requested-model' } }]);
      } else expect(result.spawnOptions.teamCredentialBindings).toBeUndefined();
    },
  );

  it.each([10, 30])('arbitrates the Team route with its model at persisted timestamp %s', updatedAt => {
    const result = resolveSessionRuntimeSnapshot({ incomingOptions: { directory: '/repo',
      modelSelection: { v: 2, updatedAt: 20, ref: { source: 'native', agentTargetKey, modelId: 'incoming-native' } } },
      persistedMetadata: { modelSelectionIntentV2: { ...teamSelection, updatedAt } },
    });
    expect(SessionModelSelectionSchema.safeParse(result.spawnOptions.modelSelection).success).toBe(true);
    expect(result.spawnOptions.modelSelection?.ref.modelId).toBe(updatedAt > 20 ? 'requested-model' : 'incoming-native');
    if (updatedAt > 20) expect(result.spawnOptions.teamCredentialBindings).toMatchObject([{ resourceId: 'resource-new' }]);
    else expect(result.spawnOptions.teamCredentialBindings).toBeUndefined();
  });

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
    expect(result.snapshot.modelSelection).toMatchObject({
      value: { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: null, modelId: 'model-1' },
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
