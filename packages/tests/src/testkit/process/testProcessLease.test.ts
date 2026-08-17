import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  readTestProcessLeaseSnapshot,
  reclaimTestProcessLeaseSnapshot,
} from './testProcessLease';

describe('testProcessLease', () => {
  it('preserves a successor owner when stale reclaim observes a different raw owner', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'happier-json-owner-lock-'));
    const lockPath = join(rootDir, 'shared.lock');
    const staleRaw = JSON.stringify({ pid: 999_999, createdAtMs: 1 });
    const successorRaw = JSON.stringify({ pid: process.pid, createdAtMs: Date.now(), owner: 'successor' });

    try {
      writeFileSync(lockPath, staleRaw, 'utf8');
      const snapshot = readTestProcessLeaseSnapshot(lockPath);
      expect(snapshot.raw).toBe(staleRaw);

      writeFileSync(lockPath, successorRaw, 'utf8');
      expect(reclaimTestProcessLeaseSnapshot(lockPath, snapshot.raw)).toBe(false);
      expect(readFileSync(lockPath, 'utf8')).toBe(successorRaw);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
