import { mkdtempSync } from 'node:fs';
import { appendFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createUiWebExportStartupStallGuard } from './createUiWebExportStartupStallGuard';

const createdDirs: string[] = [];

async function sleep(ms: number): Promise<void> {
  await new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

describe('createUiWebExportStartupStallGuard', () => {
  afterEach(async () => {
    await Promise.all(createdDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it('treats advancing Metro bundle counters as progress before publish files exist', async () => {
    const root = mkdtempSync(join(tmpdir(), 'happier-ui-export-stall-'));
    createdDirs.push(root);
    const stdoutPath = resolve(root, 'stdout.log');
    const stderrPath = resolve(root, 'stderr.log');
    const stagingDir = resolve(root, 'staging');
    await mkdir(resolve(stagingDir, 'monaco'), { recursive: true });
    await writeFile(resolve(stagingDir, 'monaco', 'static.js'), 'static-asset', 'utf8');
    await writeFile(stdoutPath, 'Starting Metro Bundler\n', 'utf8');
    await writeFile(stderrPath, '', 'utf8');

    const abortController = new AbortController();
    const guard = createUiWebExportStartupStallGuard({
      stdoutPath,
      stderrPath,
      stagingDir,
      abortController,
      env: {
        HAPPIER_E2E_UI_WEB_EXPORT_STARTUP_STALL_TIMEOUT_MS: '80',
        HAPPIER_E2E_UI_WEB_EXPORT_STARTUP_STALL_POLL_MS: '5',
      },
    });
    const outcome = guard.promise.then(() => 'stopped', () => 'aborted');

    for (const progress of [
      '\u001b[1mWeb\u001b[22m apps/ui/index.ts 23.0% (157/615)',
      'Web apps/ui/index.ts 23.0% (376/895)',
      'Web apps/ui/index.ts 23.0% (953/2369)',
    ]) {
      await sleep(50);
      await appendFile(stdoutPath, `${progress}\n`, 'utf8');
    }
    await sleep(40);

    expect(abortController.signal.aborted).toBe(false);
    guard.stop();
    await expect(outcome).resolves.toBe('stopped');
  });

  it('still aborts a partial export when unrelated log text changes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'happier-ui-export-stall-'));
    createdDirs.push(root);
    const stdoutPath = resolve(root, 'stdout.log');
    const stderrPath = resolve(root, 'stderr.log');
    const stagingDir = resolve(root, 'staging');
    await mkdir(resolve(stagingDir, 'monaco'), { recursive: true });
    await writeFile(resolve(stagingDir, 'monaco', 'static.js'), 'static-asset', 'utf8');
    await writeFile(stdoutPath, 'Starting Metro Bundler\n', 'utf8');
    await writeFile(stderrPath, '', 'utf8');

    const abortController = new AbortController();
    const guard = createUiWebExportStartupStallGuard({
      stdoutPath,
      stderrPath,
      stagingDir,
      abortController,
      env: {
        HAPPIER_E2E_UI_WEB_EXPORT_STARTUP_STALL_TIMEOUT_MS: '80',
        HAPPIER_E2E_UI_WEB_EXPORT_STARTUP_STALL_POLL_MS: '5',
      },
    });
    const outcome = guard.promise.then(() => 'stopped', () => 'aborted');
    let heartbeat = 0;
    const interval = setInterval(() => {
      heartbeat += 1;
      void appendFile(stdoutPath, `heartbeat-${heartbeat}\n`, 'utf8');
    }, 20);

    try {
      await expect(Promise.race([
        outcome,
        sleep(1_000).then(() => 'timed-out'),
      ])).resolves.toBe('aborted');
      expect(abortController.signal.aborted).toBe(true);
    } finally {
      clearInterval(interval);
      guard.stop();
    }
  });
});
