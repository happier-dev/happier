import { describe, expect, it } from 'vitest';

import { normalizeOpenCodeSkills } from './skills.js';

describe('normalizeOpenCodeSkills', () => {
  it('retains released V2 native skill identity and path without private content', () => {
    expect(normalizeOpenCodeSkills([{
      id: 'review-directory',
      name: 'security-review',
      path: '/repo/.opencode/skills/review-directory/SKILL.md',
      content: 'private skill instructions',
    }])).toEqual([{
      id: 'review-directory',
      name: 'security-review',
      displayName: 'security-review',
      path: '/repo/.opencode/skills/review-directory/SKILL.md',
      origin: 'opencode_native',
      enabled: true,
    }]);
  });
  it('projects only named native skills without retaining private payload fields', () => {
    expect(normalizeOpenCodeSkills([
      {
        name: '  reviewer  ',
        description: '  Review code  ',
        location: '  /repo/.agents/skills/reviewer/SKILL.md  ',
        content: 'private prompt text',
      },
      { name: '   ', description: 'ignored' },
      null,
    ])).toEqual([{
      name: 'reviewer',
      displayName: 'reviewer',
      description: 'Review code',
      path: '/repo/.agents/skills/reviewer/SKILL.md',
      origin: 'opencode_native',
      enabled: true,
    }]);
  });
});
