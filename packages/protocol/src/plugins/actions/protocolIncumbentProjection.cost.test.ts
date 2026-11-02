import { expect, it, vi } from 'vitest';
import * as projection from '../../actions/actionInputJsonSchema.js';

// Observe the actual module evaluation; module transformation belongs to collection.
const project = vi.spyOn(projection, 'zodSchemaToJsonSchemaObject');
const provisioners = await import('../contributions/machineProvisioners.js');

it('loads provisioner parser declarations without projecting unused incumbent JSON documents', () => {
  try {
    expect(project).not.toHaveBeenCalled();
    const schema = provisioners.MachineProvisionerPowerResultV1Schema;
    expect(schema.safeParse({ kind: 'confirmed' }).success).toBe(true);
    expect(project).not.toHaveBeenCalled();
    expect(structuredClone(schema.jsonSchema)).toEqual(schema.jsonSchema);
    expect(project.mock.calls.length).toBeGreaterThan(0);
  } finally {
    project.mockRestore();
  }
});
