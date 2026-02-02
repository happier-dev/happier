import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { projectLogsDir } from './paths';

function safeSegment(value: string): string {
  return value
    .trim()
    .replaceAll(/[^a-zA-Z0-9._-]+/g, '-')
    .replaceAll(/-+/g, '-')
    .replaceAll(/(^-|-$)/g, '')
    .slice(0, 120);
}

export type RunDirs = {
  runId: string;
  runDir: string;
  testDir: (testName: string) => string;
};

export function createRunDirs(opts?: { runLabel?: string }): RunDirs {
  const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
  const label = opts?.runLabel ? safeSegment(opts.runLabel) : 'run';
  const runId = `${stamp}-${label}-${randomUUID().slice(0, 8)}`;
  const runDir = resolve(projectLogsDir(), runId);
  mkdirSync(runDir, { recursive: true });

  return {
    runId,
    runDir,
    testDir: (testName: string) => {
      const dir = resolve(runDir, safeSegment(testName));
      mkdirSync(dir, { recursive: true });
      return dir;
    },
  };
}

