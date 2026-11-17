import { describe, expect, it } from 'vitest';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';

import { resolveForkInheritedOverridesFromMetadata } from './resolveForkInheritedOverridesFromMetadata';

describe('fork connected-services V2 inheritance', () => {
  it.each(['canonical', 'retained-backend-key'] as const)('retains the captured Team model source when forking (%s)', targetKey => {
    const target = { kind: 'agent' as const, identity: { pluginId: 'happier.agent.claude', localId: 'claude' } };
    const modelSelection = { v: 2 as const, updatedAt: 5, ref: { source: 'team_resource' as const,
      resourceId: 'resource', teamId: 'team', expectedResourceRevision: 3, deliveryMode: 'direct' as const,
      agentTargetKey: targetKey === 'canonical' ? buildBackendTargetKeyV2(target) : 'backend:claude', modelId: 'shared-model' } };
    const result = resolveForkInheritedOverridesFromMetadata({ modelSelectionIntentV2: modelSelection }, target);
    expect(result.spawn.modelSelection).toEqual(modelSelection);
    expect(result.metadata.modelSelectionIntentV2).toEqual(modelSelection);
    expect(result.metadata.modelSelectionIntentV1).toBeUndefined();
  });

  it('preserves the exact brokered team-resource selection in spawn and metadata', () => {
    const connectedServices = {
      v: 2 as const,
      bindingsByServiceId: {
        'plugin.acme/service': {
          source: 'team_resource' as const,
          resourceId: 'resource-1',
          deliveryMode: 'brokered' as const,
        },
      },
    };
    const result = resolveForkInheritedOverridesFromMetadata({
      connectedServices,
      connectedServicesUpdatedAt: 200,
    }, null);
    expect(result.spawn).toMatchObject({ connectedServices, connectedServicesUpdatedAt: 200 });
    expect(result.metadata).toMatchObject({ connectedServices, connectedServicesUpdatedAt: 200 });
  });
});
