import { describe, expect, it } from 'vitest';
import { applyRoleOverrideMutationV1, RoleOverrideRecordV1Schema, StoredRoleOverrideRecordV1Schema } from './roleOverrideRecordV1.js';

describe('Role override destination catalog', () => {
  it('retains the complete historical catalog beyond the old Settings collection bound', () => {
    const overrides = Object.fromEntries(Array.from({ length: 257 }, (_, index) => [`role-${index}`, { roleId: `role-${index}`, workspaceWrites: 'deny' }]));
    expect(StoredRoleOverrideRecordV1Schema.safeParse({ v: 1, overrides }).success).toBe(true);
    expect(RoleOverrideRecordV1Schema.safeParse({ v: 1, overrides }).success).toBe(true);
  });

  it('preserves every override field and neighboring deny while set and reset use the same semantic owner', () => {
    const override = { roleId: 'reader', engine: { agentTargetKey: 'agent:happier.agent.codex/codex', modelId: 'model', effort: 'high' },
      runsAs: { kind: 'background_run', intent: 'review' }, profileId: 'profile', workspaceWrites: 'deny', secondOpinion: 'encouraged', instructionsOverride: 'Keep current guidance' } as const;
    const neighbor = { roleId: 'neighbor', workspaceWrites: 'deny' } as const;
    const set = applyRoleOverrideMutationV1({ overrides: { neighbor } }, { kind: 'set', override });
    expect(StoredRoleOverrideRecordV1Schema.parse({ v: 1, ...set, future: true })).toEqual({ v: 1, overrides: { neighbor, reader: override } });
    expect(applyRoleOverrideMutationV1(set, { kind: 'reset', roleId: 'reader' })).toEqual({ overrides: { neighbor } });
    expect(RoleOverrideRecordV1Schema.safeParse({ v: 1, overrides: { different: override } }).success).toBe(false);
    expect(RoleOverrideRecordV1Schema.safeParse({ v: 1, ...set, future: true }).success).toBe(false);
  });
});
