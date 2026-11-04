import { describe, expect, it } from 'vitest';
import { preserveSkillCreatorV1 } from './skillCreatorV1.js';

const creator = { kind: 'agent', accountId: 'owner', sessionId: 'maker' } as const;
const editor = { kind: 'person', accountId: 'owner' } as const;
const header = { kind: 'prompt_bundle.v2', bundleSchemaId: 'skills.skill_md_v1' };

describe('private skill record attribution', () => {
  it('retains immutable creator metadata when an update supplies no revision actor', () => {
    const currentProvenance = { savedBy: editor, skillCreator: creator };
    expect(preserveSkillCreatorV1({ header, isCreate: false, currentProvenance })).toEqual(currentProvenance);
    expect(preserveSkillCreatorV1({ header, isCreate: false, currentProvenance: { savedBy: editor } })).toBeUndefined();
  });
  it('keeps legacy absence after an edit rather than claiming the later writer created it', () => {
    expect(preserveSkillCreatorV1({ header, isCreate: false, currentProvenance: { savedBy: creator },
      provenance: { savedBy: editor } })).toEqual({ savedBy: editor });
  });

  it('attributes a new written recipient copy to its admitted creator instead of copied private metadata', () => {
    expect(preserveSkillCreatorV1({ header, isCreate: true,
      provenance: { savedBy: editor, skillCreator: creator } })).toEqual({ savedBy: editor, skillCreator: editor });
  });

  it('preserves the current creator when restoring older metadata with a different creator', () => {
    expect(preserveSkillCreatorV1({ header, isCreate: false,
      currentProvenance: { savedBy: editor, skillCreator: creator },
      provenance: { savedBy: editor, skillCreator: editor, restoredFromBodyVersion: 1 } }))
      .toEqual({ savedBy: editor, skillCreator: creator, restoredFromBodyVersion: 1 });
  });

  it('does not turn installation of uploaded upstream bytes into an authorship claim', () => {
    expect(preserveSkillCreatorV1({ header: { ...header, skillLock: {
      provenance: { kind: 'upload', importedAt: 1 }, updatePolicy: 'manual',
    } }, isCreate: true, provenance: { savedBy: editor, skillCreator: creator } })).toEqual({ savedBy: editor });
  });
});
