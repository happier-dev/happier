import { describe, expect, it } from 'vitest';

import { normalizeOpenCodeSkills } from './skills.js';

describe('normalizeOpenCodeSkills', () => {
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
