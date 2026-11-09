import { describe, expect, it } from 'vitest';

import { readRoleInstructionsMarkdown } from './roleInstructionsMarkdown';

describe('readRoleInstructionsMarkdown', () => {
  it('reads a line-per-rule text as a list and leaves authored Markdown and short text alone', () => {
    expect(readRoleInstructionsMarkdown('Lead one piece of work.\nReport once per outcome.\n\nNever force-push.'))
      .toBe('- Lead one piece of work.\n- Report once per outcome.\n- Never force-push.');
    const authored = '## Rules\nLead one piece of work.\nReport once per outcome.';
    expect(readRoleInstructionsMarkdown(authored)).toBe(authored);
    expect(readRoleInstructionsMarkdown('Build interfaces.\nKeep copy short.')).toBe('Build interfaces.\nKeep copy short.');
  });
});
