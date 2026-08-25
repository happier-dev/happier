import { describe, expect, it } from 'vitest';

import { formatFirstClassSessionCommandHelp } from './sessionCommandUsage';

describe('formatFirstClassSessionCommandHelp', () => {
  it.each([
    [
      'spawn',
      ['create'],
      'Create a session, optionally targeting a machine and sending an initial prompt.',
      'happier spawn "Review this repository" --agent codex --wait',
    ],
    [
      'history',
      ['history'],
      'Read a session transcript once, or follow it as it updates.',
      'happier history <session-id-or-prefix-or-tag> --follow --jsonl',
    ],
    [
      'delegate',
      ['delegate', 'start'],
      'Start a delegated agent task from an existing session.',
      'happier delegate <session-id-or-prefix-or-tag> "Review the latest changes" --agent codex --machine-id <machineId>',
    ],
  ] as const)('adds task-oriented guidance for %s without duplicating canonical usage', (command, sessionPath, description, example) => {
    const help = formatFirstClassSessionCommandHelp({ command, sessionPath });

    expect(help).toContain(description);
    expect(help).toContain('Examples:');
    expect(help).toContain(example);
  });
});
