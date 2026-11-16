import { describe, expect, it } from 'vitest';
import { qualifiedPurposeKey } from '../connect/connectedAccountPurposeBindings.js';
import { readMachineIsolationV1 } from '../machines/machineIsolationV1.js';
import { ManagedDefaultsV1Schema, projectManagedSessionDefaultsLayers, readManagedDefaultsV1, resolveManagedSessionDefaults } from './managedDefaults.js';

const key = 'agent:example.agent/example';
const mode = (permissionMode: 'read-only' | 'safe-yolo' | 'yolo') => ({ permissionModeByAgentTargetKey: { [key]: permissionMode } });
const isolatedMachine = readMachineIsolationV1({ isolationV1: { environment: 'managed-guest', provisionerId: 'example.machine/guest' } });

describe('managed Session defaults', () => {
  it('defaults an isolated Machine native sandbox off without changing approval intent', () => {
    const result = resolveManagedSessionDefaults({ agentTargetKey: key, nativeSandboxAvailable: true,
      machineIsolation: isolatedMachine,
      memberDefaults: { permissionModeByAgentTargetKey: { [key]: 'default' } },
    });
    expect(result.agentSandbox).toMatchObject({ value: 'off', source: 'machine' });
    expect(result.permissionMode.value).toBe('default');
  });

  it('preserves host defaults and explicit sandbox choices, including Agents without a sandbox', () => {
    const base = { agentTargetKey: key, nativeSandboxAvailable: true };
    expect(resolveManagedSessionDefaults(base).agentSandbox.value).toBeUndefined();
    expect(resolveManagedSessionDefaults({ ...base, machineIsolation: readMachineIsolationV1({ isolationV1: { environment: 'native' } }) }).agentSandbox.value).toBeUndefined();
    expect(resolveManagedSessionDefaults({ ...base, machineIsolation: isolatedMachine, explicitAgentSandbox: 'on' }).agentSandbox)
      .toMatchObject({ value: 'on', source: 'explicit' });
    expect(resolveManagedSessionDefaults({ ...base, explicitAgentSandbox: 'off' }).agentSandbox.value).toBe('off');
    expect(resolveManagedSessionDefaults({ ...base, nativeSandboxAvailable: false, machineIsolation: isolatedMachine }).agentSandbox.value).toBeUndefined();
  });

  it('preserves a retained native profile unless the person explicitly replaces the sandbox choice', () => {
    const input = { agentTargetKey: key, nativeSandboxAvailable: true, retainedNativeProfile: true,
      machineIsolation: isolatedMachine };
    expect(resolveManagedSessionDefaults(input).agentSandbox.value).toBeUndefined();
    expect(resolveManagedSessionDefaults({ ...input, explicitAgentSandbox: 'off' }).agentSandbox)
      .toMatchObject({ value: 'off', source: 'explicit' });
    expect(resolveManagedSessionDefaults({ ...input, explicitAgentSandbox: 'on' }).agentSandbox)
      .toMatchObject({ value: 'on', source: 'explicit' });
  });

  it('reports Machine policy sandbox availability before launch without changing approval intent', () => {
    const base = { agentTargetKey: key, nativeSandboxAvailable: true,
      machineIsolation: isolatedMachine,
      memberDefaults: { permissionModeByAgentTargetKey: { [key]: 'default' as const } },
    };
    expect(resolveManagedSessionDefaults(base).agentSandbox).toMatchObject({
      value: 'off', availability: { status: 'disabled' },
    });
    const enabled = { ...base, machineIsolationPolicy: { agentNativeSandboxEnabled: true },
      sandboxTypeSupportsNativeSandbox: true };
    const capable = resolveManagedSessionDefaults(enabled);
    expect(capable.agentSandbox).toMatchObject({ value: 'on', source: 'machine', availability: { status: 'enabled' } });
    expect(capable.permissionMode.value).toBe('default');
    expect(resolveManagedSessionDefaults({ ...enabled, sandboxTypeSupportsNativeSandbox: false }).agentSandbox)
      .toMatchObject({ value: 'on', availability: { status: 'unavailable', reason: 'not_available_in_sandbox_type' } });
    expect(resolveManagedSessionDefaults({ ...enabled, explicitAgentSandbox: 'off' }).agentSandbox)
      .toMatchObject({ value: 'off', source: 'explicit', availability: { status: 'disabled' } });
    expect(resolveManagedSessionDefaults({ ...base, explicitAgentSandbox: 'on' }).agentSandbox)
      .toMatchObject({ value: 'on', source: 'explicit', availability: { status: 'unavailable', reason: 'not_available_in_sandbox_type' } });
    expect(resolveManagedSessionDefaults({ ...enabled, nativeSandboxAvailable: false }).agentSandbox)
      .toMatchObject({ value: 'on', availability: { status: 'unavailable', reason: 'not_available_in_sandbox_type' } });
    expect(resolveManagedSessionDefaults({ ...enabled, machineIsolation: null }).agentSandbox)
      .toMatchObject({ value: undefined, availability: undefined });
  });

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

  it('preserves explicit Automatic while a locked policy can still select a model', () => {
    const model = { v: 1 as const, updatedAt: 1,
      ref: { agentTargetKey: key, providerConnectionId: null, modelId: 'managed-model' } };
    const input = { agentTargetKey: key, explicitChoices: { modelByAgentTargetKey: { [key]: null } },
      teamDefaults: { team: { modelByAgentTargetKey: { [key]: model } }, groups: {} } };
    expect(resolveManagedSessionDefaults(input).model).toMatchObject({ value: null, source: 'explicit', lock: null });
    expect(resolveManagedSessionDefaults({ ...input,
      policyDefaults: { values: { modelByAgentTargetKey: { [key]: model } }, locked: true, organization: 'Example' },
    }).model).toMatchObject({ value: model, source: 'policy', lock: { organization: 'Example' } });
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
