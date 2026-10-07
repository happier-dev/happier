import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { projectLogsDir, repoRootDir } from './paths';
import { createRunDirs } from './runDir';

describe('test artifact log placement', () => {
  let scratchDir: string | undefined;

  afterEach(() => {
    vi.unstubAllEnvs();
    if (scratchDir) rmSync(scratchDir, { recursive: true, force: true });
    scratchDir = undefined;
  });

  it('keeps the repository default when the override is absent or blank', () => {
    vi.stubEnv('HAPPIER_E2E_LOGS_DIR', undefined);
    expect(projectLogsDir()).toBe(resolve(repoRootDir(), '.project', 'logs', 'e2e'));
    vi.stubEnv('HAPPIER_E2E_LOGS_DIR', '   ');
    expect(projectLogsDir()).toBe(resolve(repoRootDir(), '.project', 'logs', 'e2e'));
  });

  it('places canonical run artifacts beneath the configured scratch directory', () => {
    scratchDir = mkdtempSync(join(tmpdir(), 'happier-artifact-placement-'));
    const logsDir = join(scratchDir, 'logs');
    vi.stubEnv('HAPPIER_E2E_LOGS_DIR', ` ${logsDir} `);
    expect(projectLogsDir()).toBe(logsDir);
    const run = createRunDirs({ runLabel: 'placement' });
    expect(run.runDir).toBe(resolve(logsDir, run.runId));
    expect(run.testDir('scenario')).toBe(resolve(logsDir, run.runId, 'scenario'));
  });

  it('preserves explicit caller log-directory precedence', () => {
    scratchDir = mkdtempSync(join(tmpdir(), 'happier-artifact-placement-'));
    const explicitLogsDir = join(scratchDir, 'explicit');
    vi.stubEnv('HAPPIER_E2E_LOGS_DIR', join(scratchDir, 'environment'));
    const run = createRunDirs({ logsDir: explicitLogsDir });
    expect(run.runDir).toBe(resolve(explicitLogsDir, run.runId));
  });
});
