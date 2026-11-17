import { describe, expect, it } from 'vitest';
import { projectConnectedAccountActionFormOptions, type ConnectedAccountPurposeTeamResource } from './purposeInventory.js';

describe('Team Connected Account Action-form options', () => {
  it('keeps Direct delivery selectable when the broker allowance is exhausted', () => {
    const service = { pluginId: 'acme.agent', localId: 'account' };
    const direct = { source: 'team_resource' as const, resourceId: 'resource', deliveryMode: 'direct' as const,
      disclosedMember: { service, accountId: 'shared-account' } };
    const brokered = { source: 'team_resource' as const, resourceId: 'resource', deliveryMode: 'brokered' as const };
    const resource: ConnectedAccountPurposeTeamResource = {
      id: 'resource', teamId: 'team', displayName: 'Shared account', sourceOwnerDisplayName: null, resourceRevision: 1,
      readiness: { kind: 'limit_reached', metric: 'inference_requests', resetsAtUtc: '2026-11-18T00:00:00Z' },
      recoveryAction: null, mayBroker: true, mayReceiveDirect: true, directMaterialState: 'current',
      sessionUsePolicy: 'personal_allowed', providerModels: [], connectedServiceSelections: [direct, brokered],
      sourcePresentation: { kind: 'connected_service', service },
    };
    const options = (entry: ConnectedAccountPurposeTeamResource) => projectConnectedAccountActionFormOptions({
      inventory: [], serviceRefs: [service], teamResources: [entry],
    });
    expect(options(resource)).toEqual([{ value: { teamId: resource.teamId, selection: direct }, label: 'Shared account' }]);
    expect(options({ ...resource, readiness: { kind: 'available' } })).toHaveLength(2);
    expect(options({ ...resource, readiness: { kind: 'source_unavailable' } })).toEqual([]);
  });
});
