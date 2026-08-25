import { describe, expect, it } from 'vitest';

import { createBundledPluginTimingReporter } from './timing.js';

describe('createBundledPluginTimingReporter', () => {
  it('reports phase and total durations from one monotonic clock', () => {
    const values = [100, 125, 180];
    const output: string[] = [];
    const reporter = createBundledPluginTimingReporter({
      now: () => values.shift() ?? 180,
      write: (line) => output.push(line),
    });

    reporter.phase('dependencies');
    reporter.phase('projection');

    expect(output).toEqual([
      'bundled-plugins: phase=dependencies deltaMs=25 totalMs=25\n',
      'bundled-plugins: phase=projection deltaMs=55 totalMs=80\n',
    ]);
  });
});
