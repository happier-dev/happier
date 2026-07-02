import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';

import { parse } from 'yaml';

test('nightly dev schedule avoids top-of-hour GitHub Actions load', () => {
  const workflow = parse(readFileSync('.github/workflows/nightly-dev.yml', 'utf8')) as {
    on?: {
      schedule?: Array<{ cron?: string }>;
    };
  };

  const schedules = workflow.on?.schedule ?? [];
  assert.ok(schedules.length > 0, 'nightly-dev.yml should define a schedule');

  for (const schedule of schedules) {
    const cron = String(schedule.cron ?? '').trim();
    const [minute] = cron.split(/\s+/);
    assert.notEqual(minute, '0', `scheduled workflow cron should avoid minute 0: ${cron}`);
  }
});
