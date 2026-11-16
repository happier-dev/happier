import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('plugin and Triage protocol changes select the browser regression lane', async () => {
  const workflow = await readFile(new URL('../../.github/workflows/tests.yml', import.meta.url), 'utf8');
  const browserJob = workflow.split(/^  ui-e2e:\n/m)[1]?.split(/^  [a-zA-Z][\w-]*:/m)[0];
  assert.ok(browserJob, 'the existing browser lane must remain reachable');
  const filters = browserJob.match(/filters: \|\n[\s\S]*?(?=\n      - name:)/)?.[0];
  assert.ok(filters, 'ordinary CI must select browser tests from changed source paths');
  for (const source of ['packages/plugins/**', 'packages/triage-protocol/**']) {
    assert.ok(filters.includes(`'${source}'`), `${source} changes must exercise the mounted plugin journeys`);
  }
});
