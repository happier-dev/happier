import { describe, expect, it } from 'vitest';

import { createBundledPluginTimingReporter } from './timing.js';

describe('createBundledPluginTimingReporter', () => {
  it('reports phase and total durations from one monotonic clock', () => {
    const values = [100, 125, 180];
    const resources = [
      { userCPUTime: 1000, systemCPUTime: 500, fsRead: 12, fsWrite: 4 },
      { userCPUTime: 1100, systemCPUTime: 550, fsRead: 15, fsWrite: 4 },
      { userCPUTime: 1120, systemCPUTime: 560, fsRead: 15, fsWrite: 6 },
    ];
    const output: string[] = [];
    const reporter = createBundledPluginTimingReporter({
      now: () => values.shift() ?? 180,
      readResourceUsage: () => resources.shift()!,
      write: (line) => output.push(line),
    });

    reporter.phase('dependencies');
    reporter.phase('projection');

    expect(output[0]).toMatch(/^bundled-plugins: phase=dependencies deltaMs=25 totalMs=25 /);
    expect(output[1]).toMatch(/^bundled-plugins: phase=projection deltaMs=55 totalMs=80 /);
    expect(output.map((line) => JSON.parse(line.split('resourceUsage=')[1]))).toEqual([
      { scope: 'self', pid: process.pid, userCpuMicros: 100, systemCpuMicros: 50, fsRead: 3, fsWrite: 0 },
      { scope: 'self', pid: process.pid, userCpuMicros: 20, systemCpuMicros: 10, fsRead: 0, fsWrite: 2 },
    ]);
  });
});
