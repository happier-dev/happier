import { test, expect } from '@playwright/test';
import { join } from 'node:path';

import {
  createRuntimeSnapshotFixture,
  createStackRuntimeEnv,
  getRepoRootFromMeta,
  runNodeCommand,
  waitForRuntimeHealth,
  type RuntimeSnapshotFixture,
} from '../../src/testkit/stackRuntimeSnapshot';

test.describe('ui e2e: stack runtime snapshot', () => {
  test.describe.configure({ mode: 'serial' });

  const repoRoot = getRepoRootFromMeta(import.meta.url);
  const cleanups: Array<() => void | Promise<void>> = [];
  let fixture: RuntimeSnapshotFixture | null = null;
  let env: NodeJS.ProcessEnv | null = null;

  test.beforeAll(async () => {
    fixture = await createRuntimeSnapshotFixture(
      { after: (callback) => cleanups.push(callback) },
      { stackName: 'runtime-ui', serverPort: 4355 },
    );
    env = createStackRuntimeEnv(fixture);

    const startRes = await runNodeCommand(
      [join(repoRoot, 'apps/stack/bin/hstack.mjs'), 'stack', 'start', fixture.stackName, '--background', '--runtime', '--no-browser'],
      { cwd: repoRoot, env },
    );
    expect(startRes.code).toBe(0);
    await waitForRuntimeHealth(fixture.baseUrl, { timeoutMs: 30_000 });
  });

  test.afterAll(async () => {
    if (fixture && env) {
      await runNodeCommand(
        [join(repoRoot, 'apps/stack/bin/hstack.mjs'), 'stack', 'stop', fixture.stackName, '--yes'],
        { cwd: repoRoot, env },
      ).catch(() => {});
    }
    while (cleanups.length > 0) {
      const cleanup = cleanups.pop();
      await cleanup?.();
    }
  });

  test('serves the active runtime snapshot UI shell', async ({ page }) => {
    if (!fixture) throw new Error('missing runtime snapshot fixture');
    await page.goto(fixture.baseUrl, { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('runtime-snapshot-ui')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('runtime-snapshot-ui')).toContainText('RUNTIME SNAPSHOT UI');
  });
});
