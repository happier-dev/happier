import { mkdir, mkdtemp, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  filterCodexRolloutCandidatesBySearchTerm,
  resolveCodexRolloutSearchCandidateLimit,
  selectCodexRolloutCandidateEntries,
} from './candidates.js';

function sessionMetaLine(payload: Record<string, unknown>): string {
  return `${JSON.stringify({ type: 'session_meta', payload })}\n`;
}

describe('Codex rollout candidate discovery', () => {
  it('groups rollout files by provider session id and chooses earliest/latest by rollout filename chronology', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-rollout-candidates-'));
    const codexHome = join(root, 'codex-home');
    const sessionsDir = join(codexHome, 'sessions');
    const archivedDir = join(codexHome, 'archived_sessions');
    await mkdir(sessionsDir, { recursive: true });
    await mkdir(archivedDir, { recursive: true });

    const groupedSessionId = '11111111-1111-1111-1111-111111111111';
    const archivedSessionId = '22222222-2222-2222-2222-222222222222';
    const flatSessionMetaId = 'flat-rollout-session-id';
    const earliest = join(sessionsDir, `rollout-2026-01-01T00-00-00-${groupedSessionId}.jsonl`);
    const latest = join(sessionsDir, `rollout-2026-01-02T00-00-00-${groupedSessionId}.jsonl`);
    const archived = join(archivedDir, `rollout-2026-01-03T00-00-00-${archivedSessionId}.jsonl`);
    const flat = join(sessionsDir, 'rollout-2026-01-04T00-00-00-manual-export.jsonl');

    await writeFile(earliest, sessionMetaLine({ id: groupedSessionId, timestamp: '2026-01-01T00:00:00.000Z', cwd: '/repo/old' }), 'utf8');
    await writeFile(latest, sessionMetaLine({ id: groupedSessionId, timestamp: '2026-01-02T00:00:00.000Z', cwd: '/repo/new' }), 'utf8');
    await writeFile(archived, sessionMetaLine({ id: archivedSessionId, timestamp: '2026-01-03T00:00:00.000Z', cwd: '/repo/archive' }), 'utf8');
    await writeFile(flat, sessionMetaLine({ id: flatSessionMetaId, timestamp: '2026-01-04T00:00:00.000Z', cwd: '/repo/flat' }), 'utf8');

    await utimes(earliest, new Date('2026-01-05T00:00:00.000Z'), new Date('2026-01-05T00:00:00.000Z'));
    await utimes(latest, new Date('2026-01-01T00:00:00.000Z'), new Date('2026-01-01T00:00:00.000Z'));
    await utimes(archived, new Date('2026-01-03T00:00:00.000Z'), new Date('2026-01-03T00:00:00.000Z'));
    await utimes(flat, new Date('2026-01-04T00:00:00.000Z'), new Date('2026-01-04T00:00:00.000Z'));

    const selection = await selectCodexRolloutCandidateEntries({
      source: { kind: 'codexHome', home: 'user' },
      activeServerDir: join(root, 'servers', 'cloud'),
      env: { CODEX_HOME: codexHome },
      limit: 10,
    });

    expect(selection.kind).toBe('direct');
    if (selection.kind !== 'direct') throw new Error('expected direct rollout selection');
    expect(selection.totalCount).toBe(3);
    expect(selection.entries.map((entry) => entry.remoteSessionId)).toEqual([
      groupedSessionId,
      'manual-export',
      archivedSessionId,
    ]);
    expect(selection.entries[0]?.group.latestFilePath).toBe(latest);
    expect(selection.entries[0]?.group.earliestFilePath).toBe(earliest);
    expect(selection.entries[0]?.group.updatedAtMs).toBe(Date.parse('2026-01-05T00:00:00.000Z'));
    expect(selection.entries[0]?.group.archived).toBe(false);
    expect(selection.entries.find((entry) => entry.remoteSessionId === archivedSessionId)?.group.archived).toBe(true);
  });

  it('applies provider filename-search policy before falling back to candidate metadata search', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-rollout-candidate-search-'));
    const codexHome = join(root, 'codex-home');
    const sessionsDir = join(codexHome, 'sessions');
    await mkdir(sessionsDir, { recursive: true });

    const sessionId = 'aaaaaaaa-1111-1111-1111-111111111111';
    const rollout = join(sessionsDir, `rollout-2026-02-01T00-00-00-${sessionId}.jsonl`);
    await writeFile(rollout, sessionMetaLine({ id: sessionId, timestamp: '2026-02-01T00:00:00.000Z', cwd: '/repo/search' }), 'utf8');

    const exact = await selectCodexRolloutCandidateEntries({
      source: { kind: 'codexHome', home: 'user' },
      activeServerDir: join(root, 'servers', 'cloud'),
      env: { CODEX_HOME: codexHome },
      limit: 10,
      searchTerm: sessionId,
      searchMode: 'fast',
    });
    expect(exact).toEqual(expect.objectContaining({
      kind: 'direct',
      buildMode: 'knownRolloutFiles',
      totalCount: 1,
    }));

    const filenamePrefix = await selectCodexRolloutCandidateEntries({
      source: { kind: 'codexHome', home: 'user' },
      activeServerDir: join(root, 'servers', 'cloud'),
      env: { CODEX_HOME: codexHome },
      limit: 10,
      searchTerm: '2026-02',
      searchMode: 'fast',
    });
    expect(filenamePrefix).toEqual(expect.objectContaining({
      kind: 'direct',
      buildMode: 'sessionStore',
      searchIncomplete: true,
    }));

    const metadataSearch = await selectCodexRolloutCandidateEntries({
      source: { kind: 'codexHome', home: 'user' },
      activeServerDir: join(root, 'servers', 'cloud'),
      env: { CODEX_HOME: codexHome },
      limit: 10,
      searchTerm: 'repo search',
      searchMode: 'full',
    });
    expect(metadataSearch.kind).toBe('candidateSearch');
  });

  it('filters searchable candidates and clamps provider search limits from env', () => {
    const candidates = filterCodexRolloutCandidatesBySearchTerm({
      searchTerm: 'frontend',
      candidates: [
        { remoteSessionId: 'session-a', title: 'Backend work', details: { cwd: '/workspace/backend' } },
        { remoteSessionId: 'session-b', title: 'Frontend shell', details: { cwd: '/workspace/app' } },
      ],
    });

    expect(candidates.map((candidate) => candidate.remoteSessionId)).toEqual(['session-b']);
    expect(resolveCodexRolloutSearchCandidateLimit({
      env: { HAPPIER_CODEX_EXTERNAL_SESSIONS_FAST_SEARCH_CANDIDATE_LIMIT: '0' },
      searchMode: 'fast',
    })).toBe(200);
    expect(resolveCodexRolloutSearchCandidateLimit({
      env: { HAPPIER_CODEX_EXTERNAL_SESSIONS_FULL_SEARCH_CANDIDATE_LIMIT: '999999' },
      searchMode: 'full',
    })).toBe(25_000);
  });
});
