import { describe, expect, it } from 'vitest';
import * as provisioners from '../../plugins/contributions/machineProvisioners.js';
import { ProviderObservationV1Schema } from './providerFactsV1.js';
import { getActionSpec } from '../../actions/actionSpecs.js';

describe('managed resize capability', () => {
  it('exposes resize through the ordinary approval-required Action surface', () => {
    expect(getActionSpec('machines.managed.resize')).toMatchObject({ safety: 'danger', executionPlacement: 'account', surfaces: { cli: true, ui: true, agent: true } });
  });
  it('reports an absent native resize capability with the requested dimension', () => {
    expect(provisioners.readMachineProvisionerResizeCapabilityV1({}, 'diskBytes')).toEqual({ kind: 'unsupported', dimension: 'diskBytes', code: 'resize_unsupported' });
  });
  it('retains observed resource sizes independently of creation choices', () => {
    expect(ProviderObservationV1Schema.parse({ observedAt: 1, availability: 'present', power: 'running', size: { cpuCores: 2, memoryBytes: 4 * 1024 ** 3 } }).size)
      .toEqual({ cpuCores: 2, memoryBytes: 4 * 1024 ** 3 });
  });
  it('exposes a closed native resize input and a dimension-specific refusal', () => {
    const schemas = provisioners.defineMachineProvisionerSchemas({ launch: provisioners.MachineProvisionerCheckInputV1Schema, resource: provisioners.MachineProvisionerCheckInputV1Schema });
    expect(schemas.resizeInput.parse({ resource: {}, size: { cpuCores: 4 } })).toEqual({ resource: {}, size: { cpuCores: 4 } });
    expect(() => schemas.resizeInput.parse({ resource: {}, size: {} })).toThrow();
    expect(provisioners.MachineProvisionerResizeResultV1Schema.parse({ kind: 'unsupported', dimension: 'diskBytes', code: 'disk_immutable' }))
      .toEqual({ kind: 'unsupported', dimension: 'diskBytes', code: 'disk_immutable' });
  });
});
