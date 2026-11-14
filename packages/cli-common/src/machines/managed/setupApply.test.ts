import { describe, expect, it } from 'vitest';
import { MachineSetupPlanResultV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { prepareManagedMachineSetupApplyInput } from './setupApply.js';

describe('managed creation setup Apply', () => {
  it('keeps a saved preset setup local while carrying its opaque reference through signed Plan and Apply', async () => {
    const opaqueSource = { kind: 'accountPresetOpaque' as const, presetId: 'saved-preset', presetRevision: 4,
      contentEncryptionMode: 'e2ee' as const };
    const direct = { kind: 'direct' as const, setup: {} };
    const plan = MachineSetupPlanResultV1Schema.parse({ desiredRevision: 9,
      sources: [opaqueSource, direct], exclusions: [], support: [], recipePlans: [] });
    const requests: unknown[] = [];
    const result = await prepareManagedMachineSetupApplyInput({
      target: { homeId: 'home', machineId: 'machine' },
      creation: { preset: { id: 'saved-preset', revision: 4, contentEncryptionMode: 'e2ee' as const }, setup: {
        scripts: [{ body: 'private preset setup', affects: 'none' }],
      } },
      readPlan: async input => {
        requests.push(input);
        return { ok: true as const, result: plan };
      },
    });

    expect(result).toMatchObject({ targets: [{ homeId: 'home', machineId: 'machine',
      sources: [opaqueSource, direct], desiredRevision: 9 }] });
    expect(requests).toEqual([
      { homeId: 'home', machineId: 'machine' },
      { homeId: 'home', machineId: 'machine', sources: [opaqueSource, direct], mode: 'effects' },
    ]);
    expect(JSON.stringify({ result, requests })).not.toContain('private preset setup');
  });
});
