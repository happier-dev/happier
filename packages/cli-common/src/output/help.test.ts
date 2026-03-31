import chalk from 'chalk';
import { describe, expect, it } from 'vitest';

import { createHelpFormatter } from './help.js';

describe('cli-common/output help formatter', () => {
  it('avoids ANSI escapes when color is disabled', () => {
    const noColorChalk = Object.create(chalk) as typeof chalk;
    noColorChalk.level = 0;
    const help = createHelpFormatter(noColorChalk);
    const out = help.renderRows([
      { label: 'happier auth', description: 'Authenticate' },
      { label: 'happier relay', description: 'Relay management' },
    ]);
    expect(out).not.toMatch(/\u001b\[/u);
  });

  it('keeps column alignment stable even when ANSI is enabled', () => {
    const colorChalk = Object.create(chalk) as typeof chalk;
    colorChalk.level = 1;
    const help = createHelpFormatter(colorChalk);
    const out = help.renderRows([
      { label: 'short', description: 'One' },
      { label: 'a-bit-longer', description: 'Two' },
    ]);
    const stripped = out.replace(/\u001b\[[0-9;]*m/gu, '');
    const lines = stripped.split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);
    const secondColumnOffsets = lines.map((line: string) =>
      line.includes('One') ? line.indexOf('  One') : line.indexOf('  Two')
    );
    expect(secondColumnOffsets[0]).toBeGreaterThanOrEqual(2);
    expect(secondColumnOffsets[0]).toBe(secondColumnOffsets[1]);
  });
});
