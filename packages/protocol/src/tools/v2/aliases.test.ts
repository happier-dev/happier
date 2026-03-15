import { describe, expect, it } from 'vitest';

import { isChangeTitleToolNameAlias } from './aliases.js';

describe('tools/v2 aliases', () => {
  it('treats opencode-style happier_change_title as a change_title alias', () => {
    expect(isChangeTitleToolNameAlias('happier_change_title')).toBe(true);
  });
});

