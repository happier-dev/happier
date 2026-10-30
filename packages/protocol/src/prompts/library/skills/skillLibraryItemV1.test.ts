import { describe, expect, it } from 'vitest';
import { readSkillFrontmatterV1, readSkillLockV1, isSkillModifiedV1, SkillRevisionV1Schema, decodeSkillRevisionV1, SkillProvenanceV1Schema } from './skillLibraryItemV1.js';

describe('readSkillFrontmatterV1', () => {
  it.each([
    'name: sample\ndescription: A useful skill',
    "name: 'sample'\ndescription: 'A useful skill'",
    'name: "sample"\ndescription: "A useful skill"',
    'name: sample\ndescription: >-\n  A useful\n  skill\nmetadata:\n  name: nested\n  user-invocable: true',
    'name: sample\ndescription: |-\n  A useful skill\nmetadata: { name: nested }',
  ])('decodes equivalent YAML scalars without treating nested metadata as frontmatter fields: %s', yaml => {
    expect(readSkillFrontmatterV1(`---\n${yaml}\ndisable-model-invocation: true\nuser-invocable: false\n---\nBody`))
      .toEqual({ name: 'sample', description: 'A useful skill', disableModelInvocation: true, userInvocable: false });
  });
  it.each([
    'description: >\n  A useful\n  skill',
    'description: |\n  A useful skill',
    'description: "A useful skill\\n"',
  ])('preserves default block-scalar chomping like the equivalent quoted value: %s', description => {
    expect(readSkillFrontmatterV1(`---\nname: sample\n${description}\n---\nBody`))
      .toEqual({ name: 'sample', description: 'A useful skill\n', disableModelInvocation: false, userInvocable: true });
  });
  it('refuses malformed YAML and non-scalar names instead of reading nested or duplicate keys', () => {
    for (const yaml of ['metadata:\n  name: sample', 'name: { name: sample }', 'name: sample\nname: other', 'name: [sample',
      'name: sample\nuser-invocable: "false"', 'name: sample\ndisable-model-invocation: [true]', 'name: |\n  sample']) {
      expect(readSkillFrontmatterV1(`---\n${yaml}\n---\nBody`).name).toBeUndefined();
    }
  });
  it('rejects folder-escaping skill names and defaults missing invocation flags', () => {
    expect(readSkillFrontmatterV1('---\nname: ../escape\n---\n')).toEqual({ disableModelInvocation: false, userInvocable: true });
    expect(readSkillFrontmatterV1('---\nname: hello-world\n---\n')).toEqual({ name: 'hello-world', disableModelInvocation: false, userInvocable: true });
  });
});

describe('skill provenance', () => {
  it('admits closed plugin provenance only as a host projection, never as an Artifact lock', () => {
    const provenance = { kind: 'plugin', pluginId: 'external.skills', occurrenceId: 'occurrence-1' };
    expect(SkillProvenanceV1Schema.parse(provenance)).toEqual(provenance);
    expect(SkillProvenanceV1Schema.safeParse({ ...provenance, directory: '/untrusted' }).success).toBe(false);
    expect(SkillProvenanceV1Schema.safeParse({ ...provenance, occurrenceId: '' }).success).toBe(false);
    expect(() => readSkillLockV1({ skillLock: { provenance, updatePolicy: 'manual' } })).toThrow('invalid_skill_lock');
  });
  it('refuses corrupted known lock fields and unsafe revisions without reinterpreting the skill as written', () => {
    expect(() => readSkillLockV1({ skillLock: { provenance: { kind: 'registry' }, updatePolicy: 'manual' } })).toThrow('invalid_skill_lock');
    expect(SkillRevisionV1Schema.safeParse('9999999999999999999999999999:1').success).toBe(false);
    expect(SkillRevisionV1Schema.safeParse('0:1').success).toBe(false);
    const bundledRevision = `sha256:${'a'.repeat(64)}`;
    expect(SkillRevisionV1Schema.parse(bundledRevision)).toBe(bundledRevision);
    expect(() => decodeSkillRevisionV1(bundledRevision)).toThrow();
  });
  it('reads old headers as written and drops unknown annotations', () => {
    expect(readSkillLockV1({})).toEqual({ provenance: { kind: 'written' }, updatePolicy: 'manual' });
    expect(readSkillLockV1({ skillLock: { provenance: { kind: 'upload', importedAt: 10, extra: true }, updatePolicy: 'pinned', extra: true } }))
      .toEqual({ provenance: { kind: 'upload', importedAt: 10 }, updatePolicy: 'pinned' });
  });
  it('derives Modified only for content linked to an upstream source', () => {
    const lock = readSkillLockV1({ skillLock: { provenance: { kind: 'link', url: 'https://github.com/a/b', ref: { kind: 'gitTree', repo: 'a/b', path: 'skill', commit: 'abc', treeSha: 'def' } }, importedDigest: 'sha256:old', updatePolicy: 'manual' } });
    expect(isSkillModifiedV1(lock, 'sha256:new')).toBe(true);
    expect(isSkillModifiedV1(lock, 'sha256:old')).toBe(false);
    expect(isSkillModifiedV1(readSkillLockV1({}), 'sha256:new')).toBe(false);
  });
});
