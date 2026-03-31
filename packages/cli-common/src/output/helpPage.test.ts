import chalk from 'chalk';
import { describe, expect, it } from 'vitest';

import { renderHelpPage } from './helpPage.js';

function stripAnsi(value: string): string {
  return value.replace(/\u001B\[[0-9;]*m/g, '');
}

describe('renderHelpPage', () => {
  it('renders a banner, usage rows, and notes with stable structure', () => {
    const noColorChalk = Object.create(chalk) as typeof chalk;
    noColorChalk.level = 0;

    const out = renderHelpPage({
      title: 'happier auth',
      subtitle: 'Authentication management',
      usage: [
        { label: 'happier auth login', description: 'Authenticate with Happier' },
        { label: 'happier auth status', description: 'Show authentication status' },
      ],
      notes: [
        'Use --json for scripting.',
        'Use --force to re-authenticate.',
      ],
    }, { chalkLike: noColorChalk });

    expect(stripAnsi(out)).toBe([
      'happier auth',
      'Authentication management',
      '',
      'Usage:',
      '  happier auth login   Authenticate with Happier',
      '  happier auth status  Show authentication status',
      '',
      'Notes:',
      '- Use --json for scripting.',
      '- Use --force to re-authenticate.',
    ].join('\n'));
  });
});
