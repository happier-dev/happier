import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  createRuntimeSnapshotFixture,
  createStackRuntimeEnv,
  getRepoRootFromMeta,
  runNodeCommand,
  waitForRuntimeHealth,
} from '../../src/testkit/stackRuntimeSnapshot';

async function waitForDaemonRunning({
  repoRoot,
  stackName,
  env,
  timeoutMs = 15_000,
}: {
  repoRoot: string;
  stackName: string;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
}) {
  const startedAt = Date.now();
  let lastStatus = '';
  while (Date.now() - startedAt < timeoutMs) {
    const statusRes = await runNodeCommand(
      [join(repoRoot, 'apps/stack/bin/hstack.mjs'), 'stack', 'daemon', stackName, 'status', '--json'],
      { cwd: repoRoot, env },
    );
    expect(statusRes.code).toBe(0);
    const parsed = JSON.parse(statusRes.stdout.trim()) as { status?: string };
    lastStatus = String(parsed.status ?? '');
    if (/running/i.test(lastStatus)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Daemon did not become running within ${timeoutMs}ms (last status: ${lastStatus || '<empty>'})`);
}

async function assertRuntimeBackedStackServesUi(baseUrl: string) {
  await waitForRuntimeHealth(baseUrl, { timeoutMs: 30_000 });
  const response = await fetch(baseUrl);
  expect(response.status).toBe(200);
  await expect(response.text()).resolves.toContain('RUNTIME SNAPSHOT UI');
}

describe('core e2e: stack runtime snapshot', () => {
  it('starts and restarts a runtime-backed named stack without using source build outputs', async () => {
    const repoRoot = getRepoRootFromMeta(import.meta.url);
    const cleanups: Array<() => void | Promise<void>> = [];
    const fixture = await createRuntimeSnapshotFixture(
      { after: (callback) => cleanups.push(callback) },
      { stackName: 'runtime-slow', serverPort: 4345 },
    );
    const env = createStackRuntimeEnv(fixture);

    try {
      const startRes = await runNodeCommand(
        [join(repoRoot, 'apps/stack/bin/hstack.mjs'), 'stack', 'start', fixture.stackName, '--background', '--runtime', '--no-browser'],
        { cwd: repoRoot, env },
      );
      expect(startRes.code).toBe(0);

      await assertRuntimeBackedStackServesUi(fixture.baseUrl);
      await waitForDaemonRunning({ repoRoot, stackName: fixture.stackName, env });

      await mkdir(join(fixture.root, 'apps', 'cli', 'dist'), { recursive: true });
      await mkdir(join(fixture.root, 'apps', 'server', 'dist', 'runtime'), { recursive: true });
      await writeFile(join(fixture.root, 'apps', 'cli', 'dist', 'index.mjs'), 'throw new Error("source cli should not be used");\n', 'utf8');
      await writeFile(
        join(fixture.root, 'apps', 'server', 'dist', 'runtime', 'main.light.js'),
        'throw new Error("source server should not be used");\n',
        'utf8',
      );

      const stopRes = await runNodeCommand(
        [join(repoRoot, 'apps/stack/bin/hstack.mjs'), 'stack', 'stop', fixture.stackName, '--yes'],
        { cwd: repoRoot, env },
      );
      expect(stopRes.code).toBe(0);

      const restartRes = await runNodeCommand(
        [join(repoRoot, 'apps/stack/bin/hstack.mjs'), 'stack', 'start', fixture.stackName, '--background', '--runtime', '--no-browser'],
        { cwd: repoRoot, env },
      );
      expect(restartRes.code).toBe(0);

      await assertRuntimeBackedStackServesUi(fixture.baseUrl);
      await waitForDaemonRunning({ repoRoot, stackName: fixture.stackName, env });
    } finally {
      await runNodeCommand(
        [join(repoRoot, 'apps/stack/bin/hstack.mjs'), 'stack', 'stop', fixture.stackName, '--yes'],
        { cwd: repoRoot, env },
      ).catch(() => {});
      while (cleanups.length > 0) {
        const cleanup = cleanups.pop();
        await cleanup?.();
      }
      await rm(join(fixture.root, 'apps'), { recursive: true, force: true }).catch(() => {});
    }
  }, 120_000);
});
