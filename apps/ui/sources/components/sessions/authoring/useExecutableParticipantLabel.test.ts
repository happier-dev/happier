import { describe, expect, it } from 'vitest';

import { DiscussionModelParticipantLaunchV1Schema } from '@happier-dev/protocol/discussions/participants';

import { resolveExecutableModelParticipantDisplay } from './useExecutableParticipantLabel';

describe('executable participant display', () => {
  it('names the Team model from a saved recipe whose model is carried by its binding', () => {
    const modelId = 'team-discussion-model';
    const launch = DiscussionModelParticipantLaunchV1Schema.parse({
      executionTarget: { serverId: 'home', machineId: 'machine' },
      directory: { kind: 'path', path: '/workspace' },
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
      teamCredentialBindings: [{
        v: 1, slot: { kind: 'provider_model' }, teamId: 'team', resourceId: 'team-provider',
        expectedResourceRevision: 3, deliveryMode: 'brokered',
        providerModelSelection: { agentTargetKey: 'agent:happier.agent.codex/codex', modelId },
      }],
    });
    const display = resolveExecutableModelParticipantDisplay(launch, []);
    expect(display.modelLabel).toBe(modelId);
    expect(display.displayLabel).toContain(modelId);
  });
});
