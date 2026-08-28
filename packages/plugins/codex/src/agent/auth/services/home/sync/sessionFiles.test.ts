import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  createCodexSessionImportRoots,
  normalizeCodexVendorResumeId,
  resolveCodexMaterializedSessionsRoot,
  resolveCodexSessionFileMappingDestinationPaths,
  resolveCodexVendorResumeIdFromImportedSessionFile,
} from './sessionFiles.js';

describe('Codex connected-service home sync session files', () => {
  it('declares Codex rollout homes as importable JSONL session roots', () => {
    const roots = createCodexSessionImportRoots({
      destinationCodexHome: '/materialized/codex-home',
      sourceCodexHome: '/user/.codex',
    });

    expect(roots.map((root) => ({
      sourceRoot: root.sourceRoot,
      destinationRoot: root.destinationRoot,
      acceptsJsonl: root.includeFile('2026/06/rollout.jsonl'),
      rejectsOther: root.includeFile('notes.txt'),
    }))).toEqual([
      {
        sourceRoot: join('/materialized/codex-home', 'sessions'),
        destinationRoot: join('/user/.codex', 'sessions'),
        acceptsJsonl: true,
        rejectsOther: false,
      },
      {
        sourceRoot: join('/materialized/codex-home', 'archived_sessions'),
        destinationRoot: join('/user/.codex', 'archived_sessions'),
        acceptsJsonl: true,
        rejectsOther: false,
      },
    ]);
  });

  it('extracts Codex rollout resume ids from imported session file paths', () => {
    const result = resolveCodexVendorResumeIdFromImportedSessionFile({
      sourcePath: '/materialized/sessions/rollout-2026-06-06T00-00-00-11111111-2222-3333-4444-555555555555.jsonl',
      destinationPath: '/user/.codex/sessions/imported.jsonl',
      relativePath: 'imported.jsonl',
    });

    expect(result).toBe('11111111-2222-3333-4444-555555555555');
  });

  it('falls back to destination and relative paths when source basename has no rollout id', () => {
    expect(resolveCodexVendorResumeIdFromImportedSessionFile({
      sourcePath: '/materialized/sessions/imported.jsonl',
      destinationPath: '/user/.codex/sessions/rollout-2026-06-06T00-00-00-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl',
      relativePath: 'other.jsonl',
    })).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');

    expect(resolveCodexVendorResumeIdFromImportedSessionFile({
      sourcePath: '/materialized/sessions/imported.jsonl',
      destinationPath: '/user/.codex/sessions/other.jsonl',
      relativePath: 'archive/rollout-2026-06-06T00-00-00-ffffffff-1111-2222-3333-444444444444.jsonl',
    })).toBe('ffffffff-1111-2222-3333-444444444444');
  });

  it('returns null when imported files do not expose a Codex rollout id', () => {
    expect(resolveCodexVendorResumeIdFromImportedSessionFile({
      sourcePath: '/materialized/sessions/imported.jsonl',
      destinationPath: '/user/.codex/sessions/other.jsonl',
      relativePath: 'archive/manual-export.jsonl',
    })).toBeNull();
  });

  it('normalizes Codex resume ids and resolves materialized session-file mapping paths', () => {
    expect(normalizeCodexVendorResumeId(' vendor-session ')).toBe('vendor-session');
    expect(normalizeCodexVendorResumeId('nested/session')).toBeNull();
    expect(normalizeCodexVendorResumeId('nested\\session')).toBeNull();
    expect(resolveCodexMaterializedSessionsRoot('/materialized/root/codex-home')).toBe(join('/materialized/root/codex-home', 'sessions'));
    expect(resolveCodexSessionFileMappingDestinationPaths({
      targetMaterializedRoot: '/materialized/root/codex-home',
      mapping: {
        destinationPath: '/absolute/session.jsonl',
        relativePath: 'sessions/relative.jsonl',
      },
    })).toEqual([
      '/absolute/session.jsonl',
      join('/materialized/root/codex-home', 'sessions/relative.jsonl'),
    ]);
  });
});
