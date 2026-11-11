import { describe, expect, it } from 'vitest';
import { qualifiedPurposeKey } from '../connect/connectedAccountPurposeBindings.js';
import { ManagedDefaultsV1Schema, projectManagedSessionDefaultsLayers, readManagedDefaultsV1, resolveManagedSessionDefaults } from './managedDefaults.js';

const key = 'agent:example.agent/example';
const mode = (permissionMode: 'read-only' | 'safe-yolo' | 'yolo') => ({ permissionModeByAgentTargetKey: { [key]: permissionMode } });

describe('managed Session defaults', () => {
  it('selects one precedence, preserves explicit choices and applies policy locks', () => {
    const input = {
      agentTargetKey: key,
      memberDefaults: mode('yolo'),
      teamDefaults: { team: mode('safe-yolo'), groups: { reviewers: mode('read-only') } },
      groupIds: ['reviewers'], homeDefaults: mode('yolo'),
      policyDefaults: { values: mode('yolo'), locked: false, organization: 'Example' },
    };
    expect(resolveManagedSessionDefaults(input).permissionMode).toMatchObject({ value: 'yolo', source: 'member', lock: null });
    expect(resolveManagedSessionDefaults({ ...input, explicitChoices: mode('yolo') }).permissionMode)
      .toMatchObject({ value: 'yolo', source: 'explicit' });
    expect(resolveManagedSessionDefaults({ ...input, explicitChoices: mode('read-only'), policyDefaults: { ...input.policyDefaults, locked: true } }).permissionMode)
      .toMatchObject({ value: 'yolo', source: 'policy', lock: { organization: 'Example' } });
    expect(input.teamDefaults.team).toEqual(mode('safe-yolo'));
  });

  it('lets Team fill an unset member facet while an explicit choice wins', () => {
    const input = { agentTargetKey: key, memberDefaults: {}, teamDefaults: {
      team: mode('safe-yolo'), groups: {},
    } };
    expect(resolveManagedSessionDefaults(input).permissionMode)
      .toMatchObject({ value: 'safe-yolo', source: 'team' });
    expect(resolveManagedSessionDefaults({ ...input, explicitChoices: mode('read-only') }).permissionMode)
      .toMatchObject({ value: 'read-only', source: 'explicit' });
  });

  it('lets a locked policy override the member default', () => {
    const result = resolveManagedSessionDefaults({ agentTargetKey: key, memberDefaults: mode('read-only'),
      policyDefaults: { values: mode('yolo'), locked: true, organization: 'Example' } });
    expect(result.permissionMode).toMatchObject({ value: 'yolo', source: 'policy', lock: { organization: 'Example' } });
  });

  it('falls through conflicting Groups per field, independently of iteration order', () => {
    const input = { agentTargetKey: key, teamDefaults: {
      team: mode('safe-yolo'), groups: { first: mode('read-only'), second: mode('yolo'), third: {} },
    } };
    for (const groupIds of [['first', 'second', 'third'], ['third', 'second', 'first']]) {
      expect(resolveManagedSessionDefaults({ ...input, groupIds }).permissionMode)
        .toMatchObject({ value: 'safe-yolo', source: 'team', groupConflict: true });
    }
    expect(resolveManagedSessionDefaults({ ...input, groupIds: ['first', 'third'] }).permissionMode)
      .toMatchObject({ value: 'read-only', source: 'group', groupConflict: false });
  });

  it('uses Team, then Home, then unlocked policy and never another Agent target', () => {
    const input = { agentTargetKey: key, groupIds: [], policyDefaults: { values: mode('yolo'), locked: false, organization: 'Example' } };
    expect(resolveManagedSessionDefaults({ ...input, homeDefaults: mode('safe-yolo') }).permissionMode)
      .toMatchObject({ value: 'safe-yolo', source: 'home' });
    expect(resolveManagedSessionDefaults(input).permissionMode).toMatchObject({ value: 'yolo', source: 'policy' });
    expect(resolveManagedSessionDefaults({ ...input, agentTargetKey: 'agent:other/agent' }).permissionMode.value).toBeUndefined();
  });

  it('exports the resolver-owned layer order and purpose projection including Home', () => {
    const projection = projectManagedSessionDefaultsLayers({
      agentTargetKey: key,
      teamDefaults: { team: {}, groups: {} },
      groupIds: [],
      homeDefaults: { connectedServicesByAgentTargetKey: { [key]: [{
        purpose: { consumer: { pluginId: 'example.agent', localId: 'agent' }, purpose: 'z-purpose' },
        service: { pluginId: 'example.service', localId: 'service' }, target: null, teamResource: null,
      }, {
        purpose: { consumer: { pluginId: 'example.agent', localId: 'agent' }, purpose: 'a-purpose' },
        service: { pluginId: 'example.service', localId: 'service' }, target: null, teamResource: null,
      }] } },
    });
    expect(projection.layers.map(layer => layer.source)).toEqual(['explicit', 'member', 'team', 'home', 'policy']);
    expect(projection.purposeKeys).toEqual([
      qualifiedPurposeKey({ consumer: { pluginId: 'example.agent', localId: 'agent' }, purpose: 'a-purpose' }),
      qualifiedPurposeKey({ consumer: { pluginId: 'example.agent', localId: 'agent' }, purpose: 'z-purpose' }),
    ]);
  });

  it('compares model identity without mistaking authoring timestamps for Group disagreement', () => {
    const model = { v: 1 as const, ref: { agentTargetKey: key, providerConnectionId: null, modelId: 'model-a' }, updatedAt: 1 };
    const result = resolveManagedSessionDefaults({ agentTargetKey: key, groupIds: ['a', 'b'], teamDefaults: {
      team: {}, groups: { a: { modelByAgentTargetKey: { [key]: model } }, b: { modelByAgentTargetKey: { [key]: { ...model, updatedAt: 2 } } } },
    } });
    expect(result.model).toMatchObject({ source: 'group', groupConflict: false, value: { ref: model.ref } });
  });

  it('keeps distinct qualified purposes independent', () => {
    const binding = { purpose: { consumer: { pluginId: 'example.agent', localId: 'agent' }, purpose: 'main' },
      service: { pluginId: 'example.service', localId: 'service' }, target: null, teamResource: null };
    const result = resolveManagedSessionDefaults({ agentTargetKey: key, groupIds: ['a'], teamDefaults: {
      team: { connectedServicesByAgentTargetKey: { [key]: [binding] } },
      groups: { a: { connectedServicesByAgentTargetKey: { [key]: [{ ...binding, purpose: { ...binding.purpose, purpose: 'review' } }] } } },
    } });
    expect(result.connectedServices.map(entry => [entry.value?.purpose.purpose, entry.source]))
      .toEqual([['main', 'team'], ['review', 'group']]);
  });

  it('treats representable V1 and V2 model carriers as the same Group choice', () => {
    const result = resolveManagedSessionDefaults({ agentTargetKey: key, groupIds: ['a', 'b'], teamDefaults: {
      team: {}, groups: {
        a: { modelByAgentTargetKey: { [key]: { v: 1, ref: { agentTargetKey: key, providerConnectionId: null, modelId: 'model-a' }, updatedAt: 1 } } },
        b: { modelByAgentTargetKey: { [key]: { v: 2, ref: { source: 'native', agentTargetKey: key, modelId: 'model-a' }, updatedAt: 2 } } },
      },
    } });
    expect(result.model).toMatchObject({ source: 'group', groupConflict: false, value: { ref: { modelId: 'model-a' } } });
  });

  it('admits only the shared typed payload and exposes malformed stored data for repair', () => {
    expect(ManagedDefaultsV1Schema.parse({ team: mode('read-only'), groups: {} }).team).toEqual(mode('read-only'));
    expect(readManagedDefaultsV1(null)).toEqual({ status: 'available', defaults: null });
    expect(readManagedDefaultsV1({ team: { permissionModeByAgentTargetKey: { [key]: 'bogus' } }, groups: {} }))
      .toEqual({ status: 'repair_required', defaults: null });
  });

  it.each(['duplicate purpose', 'personal and Team target', 'wrong service'] as const)('rejects %s at the persisted input boundary', (ambiguity) => {
    const binding = { purpose: { consumer: { pluginId: 'example.agent', localId: 'agent' }, purpose: 'main' },
      service: { pluginId: 'example.service', localId: 'service' },
      target: { kind: 'group', service: { pluginId: 'example.service', localId: 'service' }, groupId: 'group-a' },
      teamResource: null };
    const bindings = ambiguity === 'duplicate purpose' ? [binding, binding]
      : ambiguity === 'personal and Team target' ? [{ ...binding, teamResource: {
        teamId: 'team-a', selection: { source: 'team_resource', resourceId: 'resource-a', deliveryMode: 'brokered' },
      } }]
      : [{ ...binding, target: { ...binding.target, service: { ...binding.service, localId: 'other-service' } } }];
    expect(ManagedDefaultsV1Schema.safeParse({ team: { connectedServicesByAgentTargetKey: { [key]: bindings } }, groups: {} }).success).toBe(false);
  });
});
