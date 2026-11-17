import { describe, expect, it } from 'vitest';
import { getActionSpec } from './actionSpecs.js';

describe('Account pet Actions', () => {
  it('accepts a Machine package or registry identity through one import contract', () => {
    const spec = getActionSpec('pet.import');
    expect(spec.inputSchema.parse({ source: { kind: 'machine', machineId: 'machine', packagePath: '/pets/capy' } }))
      .toEqual({ source: { kind: 'machine', machineId: 'machine', packagePath: '/pets/capy' } });
    expect(spec.inputSchema.parse({ source: { kind: 'registry', sourceId: 'catalog', itemId: 'capy' } }))
      .toEqual({ source: { kind: 'registry', sourceId: 'catalog', itemId: 'capy' } });
    expect(spec.inputSchema.parse({ source: { kind: 'machine', machineId: 'machine', sourceKey: 'discovered' } }))
      .toEqual({ source: { kind: 'machine', machineId: 'machine', sourceKey: 'discovered' } });
    expect(spec.inputSchema.safeParse({ source: { kind: 'machine', machineId: 'machine' } }).success).toBe(false);
    expect(spec.inputSchema.safeParse({ source: { kind: 'registry', sourceId: 'catalog', itemId: 'capy', spritesheetUrl: 'https://elsewhere.test/pet' } }).success).toBe(false);
  });
  it('deletes exactly the Account identity returned by import', () => {
    expect(getActionSpec('pet.delete').inputSchema.parse({ accountPetId: 'account-pet' }))
      .toEqual({ accountPetId: 'account-pet' });
  });
});
