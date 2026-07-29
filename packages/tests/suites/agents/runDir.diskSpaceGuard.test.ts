import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it } from 'vitest';

import { createRunDirs } from '../../src/testkit/runDir';

const createdRoots: string[] = [];

function makeTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'happy-rundir-space-'));
  createdRoots.push(root);
  return root;
}

describe('createRunDirs free-disk preflight guard', () => {
  const originalMinFreeMb = process.env.HAPPIER_E2E_MIN_FREE_DISK_MB;

  afterEach(() => {
    process.env.HAPPIER_E2E_MIN_FREE_DISK_MB = originalMinFreeMb;
    for (const root of createdRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails early when available disk is below configured threshold', () => {
    const root = makeTempRoot();
    process.env.HAPPIER_E2E_MIN_FREE_DISK_MB = '999999999';

    expect(() => createRunDirs({ runLabel: 'providers', logsDir: root })).toThrow(
      /insufficient disk space/i,
    );
  });
});
