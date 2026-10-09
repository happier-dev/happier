import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import * as protocol from './managedMachinePresetV1.js';
import { createStoredReadSchema } from '../../json/storedReadSchema.js';

describe('managed preset recipe contracts', () => {
  it('validates contributed choices once and drops stored extras without relaxing mutation admission', () => {
    const factory: unknown = Reflect.get(protocol, 'createManagedMachinePresetV1Schema');
    expect(factory).toBeTypeOf('function');
    if (typeof factory !== 'function') throw new Error('The preset validator is missing');
    // The contribution supplies its launch schema; all surrounding host admission stays real.
    const schema = factory(z.object({ cores: z.number().int().positive() }).strict());
    const preset = {
      id: 'preset-a', homeId: 'home-a', revision: 1, name: 'My VM',
      owner: { kind: 'account', accountId: 'owner' },
      recipe: { provider: { pluginId: 'happier.machine.lima', localId: 'lima' }, schemaVersion: 1,
        name: 'guest', choices: { cores: 2 } },
      controller: { machineId: 'host-a', installationId: 'installation-a' },
    };
    expect(schema.parse(preset)).toEqual(preset);
    const stored = { ...preset, extra: true, recipe: { ...preset.recipe, extra: true,
      choices: { cores: 2, future: true } }, owner: { ...preset.owner, extra: true } };
    expect(schema.safeParse(stored).success).toBe(false);
    expect(createStoredReadSchema(schema).parse(stored)).toEqual(preset);
    expect(schema.safeParse({ ...preset, recipe: { ...preset.recipe, choices: { cores: 0 } } }).success).toBe(false);
    expect(schema.safeParse({ ...preset, owner: { kind: 'group', teamId: 'team', groupId: 'group' } }).success).toBe(false);
    expect(schema.safeParse({ ...preset, owner: { kind: 'team', teamId: 'team' } }).success).toBe(true);
    expect(schema.safeParse({ ...preset, controller: { poolId: 'pool-a' } }).success).toBe(false);
    expect(schema.safeParse({ ...preset, simultaneousLimit: { maximum: 0 } }).success).toBe(false);
    expect(schema.parse({ ...preset, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false }))
      .toMatchObject({ retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false });
    // Absence remains inheritance, rather than a stored false or a copied category default.
    expect(schema.parse(preset)).not.toHaveProperty('wakeOnAcceptedMessage');
    expect(schema.parse(preset)).not.toHaveProperty('retention');
  });
});
