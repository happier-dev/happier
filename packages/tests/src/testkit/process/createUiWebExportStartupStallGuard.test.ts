import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { appendFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { createUiWebExportStartupStallGuard } from './createUiWebExportStartupStallGuard';

describe('createUiWebExportStartupStallGuard', () => {
  it('aborts early when stderr shows Metro cache corruption during startup', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'happier-uiwebexport-guard-'));
    const stdoutPath = resolve(rootDir, 'stdout.log');
    const stderrPath = resolve(rootDir, 'stderr.log');
    const stagingDir = resolve(rootDir, 'dist-staging');

    await mkdir(stagingDir, { recursive: true });
    await writeFile(stdoutPath, 'Expo Autolinking module resolution enabled\nStarting Metro Bundler\n', 'utf8');
    await writeFile(stderrPath, '', 'utf8');

    const abortController = new AbortController();
    const guard = createUiWebExportStartupStallGuard({
      stdoutPath,
      stderrPath,
      stagingDir,
      env: {
        HAPPIER_E2E_UI_WEB_EXPORT_STARTUP_STALL_TIMEOUT_MS: '1000',
        HAPPIER_E2E_UI_WEB_EXPORT_STARTUP_STALL_POLL_MS: '5',
      },
      abortController,
    });

    const corruptionWrite = (async () => {
      await new Promise((resolveNext) => setTimeout(resolveNext, 20));
      await appendFile(
        stderrPath,
        'Error while reading cache, falling back to a full crawl:\n Error: Unable to deserialize cloned data.\n',
      );
    })();

    try {
      await expect(guard.promise).rejects.toThrow(/deserialize cloned data|cache corruption|--clear/i);
      expect(abortController.signal.aborted).toBe(true);
    } finally {
      guard.stop();
      await corruptionWrite.catch(() => {});
      await rm(rootDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('times out when only partial worker files keep churning before publish-phase files appear', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'happier-uiwebexport-guard-'));
    const stdoutPath = resolve(rootDir, 'stdout.log');
    const stderrPath = resolve(rootDir, 'stderr.log');
    const stagingDir = resolve(rootDir, 'dist-staging');
    const monacoDir = resolve(stagingDir, 'monaco');

    await mkdir(monacoDir, { recursive: true });
    await writeFile(stdoutPath, 'Expo Autolinking module resolution enabled\nStarting Metro Bundler\n', 'utf8');
    await writeFile(stderrPath, '', 'utf8');

    const abortController = new AbortController();
    const guard = createUiWebExportStartupStallGuard({
      stdoutPath,
      stderrPath,
      stagingDir,
      env: {
        HAPPIER_E2E_UI_WEB_EXPORT_STARTUP_STALL_TIMEOUT_MS: '40',
        HAPPIER_E2E_UI_WEB_EXPORT_STARTUP_STALL_POLL_MS: '5',
      },
      abortController,
    });

    let keepRunning = true;
    const churn = (async () => {
      let counter = 0;
      while (keepRunning) {
        counter += 1;
        await writeFile(resolve(monacoDir, `progress-${counter}.js`), `progress-${counter}`, 'utf8');
        await new Promise((resolveNext) => setTimeout(resolveNext, 0));
      }
    })();

    try {
      await expect(Promise.race([
        guard.promise.then(() => 'resolved').catch(() => 'rejected'),
        new Promise<'timed-out'>((resolve) => {
          setTimeout(() => resolve('timed-out'), 200);
        }),
      ])).resolves.toBe('rejected');
    } finally {
      keepRunning = false;
      guard.stop();
      await churn.catch(() => {});
      await rm(rootDir, { recursive: true, force: true }).catch(() => {});
    }
  });
});
