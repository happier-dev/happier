import { fileURLToPath } from 'node:url';

import { readJsonlFileForward } from '@happier-dev/plugin-sdk/sessions/file-stores';
import { describe, expect, it } from 'vitest';

import { classifyPiAgentEndBoundary } from '../runtime/rpc/lifecycle.js';
import { foldPiV3SessionTree } from './sessionFormat.js';

const fixtureUrl = (name: string) => new URL(`./__fixtures__/${name}`, import.meta.url);

describe('Pi v3 semantic-format fixtures', () => {
  it('folds the active id/parentId branch without flattening abandoned entries', async () => {
    const fixturePath = fixtureUrl('pi-session-v3-tree.jsonl');
    const scanned = await readJsonlFileForward({
      filePath: fileURLToPath(fixturePath),
      offsetBytes: 0,
      maxBytes: 64 * 1024,
      maxItems: 100,
    });

    expect(scanned.reachedEnd).toBe(true);
    const folded = foldPiV3SessionTree(scanned.items.map((item) => item.value));

    expect(folded.header).toEqual({
      version: 3,
      sessionId: 'pi-session-fixture',
      cwd: '/workspace/pi-fixture',
      createdAtMs: Date.parse('2026-07-20T10:00:00.000Z'),
    });
    expect(folded.activeLeafId).toBe('session-name');
    expect(folded.activeBranch.map((entry) => entry.id)).toEqual([
      'user-root',
      'assistant-root',
      'subagent-result',
      'branch-summary',
      'active-user',
      'compaction',
      'active-assistant',
      'future-entry',
      'session-name',
    ]);
    expect(folded.activeBranch.map((entry) => entry.id)).not.toContain('abandoned-user');
    expect(folded.activeBranch.map((entry) => entry.id)).not.toContain('abandoned-assistant');
    expect(folded.activeBranch.find((entry) => entry.id === 'assistant-root')?.record).toMatchObject({
      message: {
        content: [expect.objectContaining({ type: 'toolCall', name: 'subagent' })],
      },
    });
    expect(folded.activeBranch.find((entry) => entry.id === 'compaction')?.record).toMatchObject({
      type: 'compaction',
      firstKeptEntryId: 'active-user',
      summary: expect.any(String),
    });
    expect(folded.activeBranch.find((entry) => entry.id === 'future-entry')).toMatchObject({
      type: 'future_entry',
      knownType: false,
    });
    expect(folded.diagnostics).toEqual({
      duplicateEntryIds: [],
      missingParentIds: [],
      cycleEntryIds: [],
    });
  });

  it('fails closed on malformed tree links instead of inventing append-order ancestry', () => {
    const folded = foldPiV3SessionTree([
      { type: 'session', version: 3, id: 'broken', timestamp: '2026-07-20T10:00:00.000Z', cwd: '/workspace' },
      { type: 'message', id: 'root', parentId: null, timestamp: '2026-07-20T10:00:01.000Z', message: { role: 'user', content: 'root' } },
      { type: 'message', id: 'orphan', parentId: 'missing', timestamp: '2026-07-20T10:00:02.000Z', message: { role: 'assistant', content: [] } },
    ]);

    expect(folded.activeBranch.map((entry) => entry.id)).toEqual(['orphan']);
    expect(folded.diagnostics.missingParentIds).toEqual(['missing']);
  });

  it('classifies only agent_end and keeps retrying ends non-final', async () => {
    const scanned = await readJsonlFileForward({
      filePath: fileURLToPath(fixtureUrl('pi-agent-end-lifecycle.jsonl')),
      offsetBytes: 0,
      maxBytes: 8 * 1024,
      maxItems: 10,
    });

    expect(scanned.reachedEnd).toBe(true);
    expect(scanned.items.map((item) => classifyPiAgentEndBoundary(item.value))).toEqual([
      'retrying',
      null,
      'final',
      'final',
    ]);
  });
});
