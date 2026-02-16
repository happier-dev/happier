import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { executionRunsCapability } from './toolExecutionRuns';

describe('executionRunsCapability', () => {
  const envSnapshot = { ...process.env };

  function restoreEnv(snapshot: NodeJS.ProcessEnv): void {
    for (const key of Object.keys(process.env)) {
      if (!(key in snapshot)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(snapshot)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  beforeEach(() => {
    restoreEnv(envSnapshot);
    process.env.HAPPIER_CODERABBIT_REVIEW_CMD = 'coderabbit';
  });

  afterEach(() => {
    restoreEnv(envSnapshot);
  });

  it('reports supportsVendorResume per backend for UI gating', async () => {
    const res: any = await executionRunsCapability.detect({
      context: {
        cliSnapshot: {
          path: '',
          clis: {
            claude: { available: true },
            codex: { available: false },
            gemini: { available: false },
            opencode: { available: false },
            auggie: { available: false },
            qwen: { available: false },
            kimi: { available: false },
            kilo: { available: false },
            pi: { available: false },
          },
        },
      },
    } as any);

    expect(res?.available).toBe(true);
    expect(res?.backends?.claude).toBeTruthy();
    expect(typeof res.backends.claude.supportsVendorResume).toBe('boolean');
  });

  it('detects native coderabbit availability from process PATH even when cliSnapshot.path is empty', async () => {
    // Ensure we test PATH detection (not the override).
    delete (process.env as any).HAPPIER_CODERABBIT_REVIEW_CMD;

    const dir = await mkdtemp(join(tmpdir(), 'happier-coderabbit-path-test-'));
    const bin = join(dir, 'coderabbit');
    await writeFile(
      bin,
      '#!/usr/bin/env bash\n' +
        'echo \"coderabbit\"',
      'utf8',
    );
    await chmod(bin, 0o755);

    const prevPath = process.env.PATH ?? '';
    process.env.PATH = `${dir}${prevPath ? `:${prevPath}` : ''}`;

    const res: any = await executionRunsCapability.detect({
      context: {
        cliSnapshot: {
          // Bug repro: some snapshots include an empty path string (should fall back to process.env.PATH too).
          path: '',
          clis: {
            claude: { available: true },
          },
        },
      },
    } as any);

    process.env.PATH = prevPath;

    expect(res?.available).toBe(true);
    expect(res?.backends?.coderabbit?.available).toBe(true);
  });
});
