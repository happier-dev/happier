import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  findCodexRolloutFileById,
  isMatchingCodexRolloutFileName,
  resolveCodexNativeSessionsRoot,
} from './codexSessionFiles';

describe('isMatchingCodexRolloutFileName', () => {
  it('matches a rollout file whose name ends with the vendor resume id', () => {
    expect(isMatchingCodexRolloutFileName(
      'rollout-2026-04-16T08-20-49-019d94f3-0a6f-7c41-bb18-d26425384658.jsonl',
      '019d94f3-0a6f-7c41-bb18-d26425384658',
    )).toBe(true);
  });

  it('matches a continuation rollout with a thread id and appended turn id', () => {
    expect(isMatchingCodexRolloutFileName(
      'rollout-2026-09-25T11-50-33-019d94f3-0a6f-7c41-bb18-d26425384658_019d94f4-0a6f-7c41-bb18-d26425384659.jsonl',
      '019d94f3-0a6f-7c41-bb18-d26425384658',
    )).toBe(true);
  });

  it('does not match a different id sharing a suffix substring', () => {
    expect(isMatchingCodexRolloutFileName(
      'rollout-2026-04-16T08-20-49-aaaaaaaa-0a6f-7c41-bb18-d26425384658.jsonl',
      '6425384658',
    )).toBe(false);
  });

  it('does not match a non-rollout jsonl file', () => {
    expect(isMatchingCodexRolloutFileName(
      'session-019d94f3-0a6f-7c41-bb18-d26425384658.jsonl',
      '019d94f3-0a6f-7c41-bb18-d26425384658',
    )).toBe(false);
  });

  it('does not match a continuation with a different thread id', () => {
    expect(isMatchingCodexRolloutFileName(
      'rollout-2026-09-25T11-50-33-aaaaaaaa-0a6f-7c41-bb18-d26425384658_019d94f4-0a6f-7c41-bb18-d26425384659.jsonl',
      '019d94f3-0a6f-7c41-bb18-d26425384658',
    )).toBe(false);
  });
});

describe('resolveCodexNativeSessionsRoot', () => {
  it('defaults to ~/.codex/sessions using HOME', () => {
    expect(resolveCodexNativeSessionsRoot({ HOME: '/home/me' })).toBe('/home/me/.codex/sessions');
  });

  it('honors an explicit CODEX_HOME override', () => {
    expect(resolveCodexNativeSessionsRoot({ HOME: '/home/me', CODEX_HOME: '/custom/codex' }))
      .toBe('/custom/codex/sessions');
  });
});

describe('findCodexRolloutFileById', () => {
  it('finds the date-partitioned native rollout by exact id suffix without reading file contents', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-find-'));
    try {
      const sessionsRoot = join(root, 'sessions');
      const dir = join(sessionsRoot, '2026', '04', '16');
      await mkdir(dir, { recursive: true });
      const target = join(dir, 'rollout-2026-04-16T08-20-49-019d94f3-0a6f-7c41-bb18-d26425384658.jsonl');
      await writeFile(target, '{}\n');
      // A decoy with a different id in the same dir must be ignored.
      await writeFile(join(dir, 'rollout-2026-04-16T00-00-00-aaaaaaaa-0a6f-7c41-bb18-d26425384658.jsonl'), '{}\n');

      await expect(findCodexRolloutFileById({
        sessionsRoot,
        vendorResumeId: '019d94f3-0a6f-7c41-bb18-d26425384658',
      })).resolves.toBe(target);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns null when no rollout matches the id', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-find-miss-'));
    try {
      const sessionsRoot = join(root, 'sessions');
      const dir = join(sessionsRoot, '2026', '04', '16');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'rollout-2026-04-16T08-20-49-aaaaaaaa-0a6f-7c41-bb18-d26425384658.jsonl'), '{}\n');

      await expect(findCodexRolloutFileById({
        sessionsRoot,
        vendorResumeId: '019d94f3-0a6f-7c41-bb18-d26425384658',
      })).resolves.toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('finds a matching rollout even when more than the legacy 5000-file cap precedes it (id-targeted, name-only)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-find-cap-'));
    try {
      const sessionsRoot = join(root, 'sessions');
      // Place decoys in an OLDER date partition and the target in a NEWER partition so the
      // newest-first walk reaches the target without exhausting any per-call file budget.
      const olderDir = join(sessionsRoot, '2025', '01', '01');
      const newerDir = join(sessionsRoot, '2026', '04', '16');
      await mkdir(olderDir, { recursive: true });
      await mkdir(newerDir, { recursive: true });
      for (let index = 0; index < 20; index += 1) {
        const padded = String(index).padStart(2, '0');
        await writeFile(
          join(olderDir, `rollout-2025-01-01T00-00-${padded}-decoy${padded}-0a6f-7c41-bb18-d26425384658.jsonl`),
          '{}\n',
        );
      }
      const target = join(newerDir, 'rollout-2026-04-16T08-20-49-019d94f3-0a6f-7c41-bb18-d26425384658.jsonl');
      await writeFile(target, '{}\n');

      await expect(findCodexRolloutFileById({
        sessionsRoot,
        vendorResumeId: '019d94f3-0a6f-7c41-bb18-d26425384658',
      })).resolves.toBe(target);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
