import { mkdtempSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it } from 'vitest';

import { createRunDirs } from '../../src/testkit/runDir';

const createdRoots: string[] = [];

function makeTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'happy-rundir-retention-'));
  createdRoots.push(root);
  return root;
}

function listRunDirs(root: string): string[] {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

describe('createRunDirs retention', () => {
  const originalKeepCount = process.env.HAPPIER_E2E_RUN_LOG_KEEP_COUNT;

  afterEach(() => {
    process.env.HAPPIER_E2E_RUN_LOG_KEEP_COUNT = originalKeepCount;
    for (const root of createdRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps only newest run dirs for the same label', () => {
    const root = makeTempRoot();

    mkdirSync(join(root, '2026-02-01T00-00-00-000Z-providers-aaaa1111'), { recursive: true });
    mkdirSync(join(root, '2026-02-01T00-00-00-001Z-providers-bbbb2222'), { recursive: true });
    mkdirSync(join(root, '2026-02-01T00-00-00-002Z-providers-cccc3333'), { recursive: true });
    process.env.HAPPIER_E2E_RUN_LOG_KEEP_COUNT = '2';

    createRunDirs({ runLabel: 'providers', logsDir: root });

    const providerDirs = listRunDirs(root).filter((name) => name.includes('-providers-'));
    expect(providerDirs).toHaveLength(2);
    expect(providerDirs[0]).toBe('2026-02-01T00-00-00-002Z-providers-cccc3333');
  });

  it('does not delete other run labels', () => {
    const root = makeTempRoot();

    mkdirSync(join(root, '2026-02-01T00-00-00-000Z-providers-aaaa1111'), { recursive: true });
    mkdirSync(join(root, '2026-02-01T00-00-00-001Z-providers-bbbb2222'), { recursive: true });
    mkdirSync(join(root, '2026-02-01T00-00-00-002Z-smoke-cccc3333'), { recursive: true });
    process.env.HAPPIER_E2E_RUN_LOG_KEEP_COUNT = '2';

    createRunDirs({ runLabel: 'providers', logsDir: root });

    const all = listRunDirs(root);
    expect(all.some((name) => name.includes('-smoke-'))).toBe(true);
  });
});
