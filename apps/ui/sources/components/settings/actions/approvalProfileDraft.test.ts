import { describe, expect, it } from 'vitest';

import {
  approvalProfileFromDraft,
  draftFromApprovalProfile,
} from './approvalProfileDraft';

describe('approval profile draft', () => {
  it('stores only the category overlays that differ from the default', () => {
    expect(
      approvalProfileFromDraft({
        id: 'p1',
        name: ' Deploys only ',
        defaultMode: 'ask',
        safe: 'ask',
        danger: 'require',
      }),
    ).toEqual({
      id: 'p1',
      name: 'Deploys only',
      defaultMode: 'ask',
      categories: { danger: 'require' },
    });
    expect(
      approvalProfileFromDraft({
        id: 'p1',
        name: 'Calm',
        defaultMode: 'allow',
        safe: 'allow',
        danger: 'allow',
      }),
    ).toEqual({ id: 'p1', name: 'Calm', defaultMode: 'allow' });
  });

  it('refuses a draft without a name', () => {
    expect(
      approvalProfileFromDraft({
        id: 'p1',
        name: '   ',
        defaultMode: 'ask',
        safe: 'ask',
        danger: 'ask',
      }),
    ).toBeNull();
  });

  it('reads an existing profile back, keeping per-Action overrides it does not edit', () => {
    const profile = {
      id: 'p2',
      name: 'Ops',
      defaultMode: 'allow' as const,
      actions: { 'deploy.run': 'require' as const },
      categories: { danger: 'ask' as const },
    };
    const draft = draftFromApprovalProfile(profile);
    expect(draft).toMatchObject({
      id: 'p2',
      name: 'Ops',
      defaultMode: 'allow',
      safe: 'allow',
      danger: 'ask',
    });
    expect(approvalProfileFromDraft(draft)).toEqual(profile);
  });

  it('gives a new profile a fresh custom id', () => {
    const a = draftFromApprovalProfile(null);
    const b = draftFromApprovalProfile(null);
    expect(a.id).not.toBe(b.id);
    expect(a.id.startsWith('builtin:')).toBe(false);
    expect(a).toMatchObject({
      name: '',
      defaultMode: 'ask',
      safe: 'ask',
      danger: 'ask',
    });
  });
});
