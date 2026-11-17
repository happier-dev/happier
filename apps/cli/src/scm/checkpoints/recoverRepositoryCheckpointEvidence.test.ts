import { describe, expect, it } from 'vitest';
import { projectRepositoryCheckpointTranscriptPage, readRepositoryCheckpointTranscriptEvidence } from './recoverRepositoryCheckpointEvidence';
import type { RepositoryCheckpointTranscriptPage } from './readRepositoryCheckpointTranscriptPage';

describe('checkpoint transcript evidence projection', () => {
  it('retains canonical Diff files and prompt identity without disclosing unrelated requester content', () => {
    const page = transcriptPage();
    const projected = projectRepositoryCheckpointTranscriptPage({ page, sessionId: 'session', scopeId: 'session:/repo' });
    expect(projected).toMatchObject({ evidence: { earliestUserPrompt: { seq: 1, localId: 'prompt' },
      turns: [{ turnId: 'requested-turn', files: [{ filePath: 'changed.txt', unifiedDiff: '+allowed-diff' }] }] },
      hasMore: true, nextAfterSeq: 4 });
    expect(JSON.stringify(projected)).not.toMatch(/private-prose|private-tool|private-diff-field|foreign-session/);
  });

  it('projects only the requested turn and receipt while preserving the page continuation', () => {
    const page = transcriptPage();
    expect(projectRepositoryCheckpointTranscriptPage({ page, sessionId: 'session', scopeId: 'session:/repo',
      turnId: 'different-turn' })).toEqual({ evidence: { turns: [] }, hasMore: true, nextAfterSeq: 4 });
    expect(projectRepositoryCheckpointTranscriptPage({ page, sessionId: 'session', scopeId: 'session:/elsewhere' }))
      .toMatchObject({ evidence: { turns: [] } });
  });

  it('resolves a receipt across pages without losing earlier Diff fragments from the selected turn', async () => {
    const page = transcriptPage();
    if (!('messages' in page)) throw new Error('Expected raw transport fixture');
    const selected = page.messages[2]!;
    const projected = await readRepositoryCheckpointTranscriptEvidence({ sessionId: 'session', scopeId: 'session:/repo',
      checkpointReceiptId: 'requested-receipt', readTranscriptPage: async ({ afterSeq }) => afterSeq ? {
        messages: [selected], hasMore: false, nextAfterSeq: null,
      } : { messages: [{ ...selected, seq: 2, content: { role: 'agent', content: { type: 'codex', data: {
        type: 'tool-call', callId: 'early', name: 'Diff', input: { files: [{ file_path: 'earlier.txt', unified_diff: '+earlier' }],
          _happier: { v: 2, protocol: 'codex', sessionChangeScope: 'turn', turnId: 'requested-turn', sessionId: 'session',
            provider: 'codex', rawToolName: 'Diff', canonicalToolName: 'Diff', source: 'canonical_diff_tool', confidence: 'exact',
            turnStatus: 'completed', seqRange: { startSeqInclusive: 1, endSeqInclusive: 4 } } },
      } } } }], hasMore: true, nextAfterSeq: 2 } });
    expect(projected.evidence.turns.flatMap(turn => turn.files.map(file => file.filePath))).toEqual(['earlier.txt', 'changed.txt']);
    expect(projected.hasMore).toBe(false);
    expect(JSON.stringify(projected)).not.toMatch(/private-/);
  });
});

function transcriptPage(): RepositoryCheckpointTranscriptPage {
  const diff = (sessionId: string) => ({ role: 'agent', content: { type: 'codex', data: {
    type: 'tool-call', callId: 'diff', name: 'Diff', input: {
      private: 'private-diff-field', files: [{ file_path: 'changed.txt', unified_diff: '+allowed-diff' }],
      _happier: { v: 2, protocol: 'codex', sessionChangeScope: 'turn', turnId: 'requested-turn', sessionId,
        provider: 'codex', rawToolName: 'RepositoryCheckpointDiff', canonicalToolName: 'Diff', source: 'canonical_diff_tool',
        confidence: 'exact', turnStatus: 'completed', seqRange: { startSeqInclusive: 1, endSeqInclusive: 4 },
        repositoryCheckpoint: { version: 1, scopeId: 'session:/repo', baseRefSource: 'turn_start',
          contentConfidence: 'exact', attributionScope: 'shared_worktree', receipts: [{ id: 'checkpoint.diff_computed', ref: 'requested-receipt' }] } },
    },
  } } });
  return { messages: [
    { seq: 1, createdAt: 1, localId: 'prompt', content: { role: 'user', content: { type: 'text', text: 'private-prose' } } },
    { seq: 2, createdAt: 2, content: { role: 'agent', content: { type: 'codex', data: { type: 'tool-call', callId: 'bash', name: 'Bash', input: 'private-tool' } } } },
    { seq: 3, createdAt: 3, content: diff('session') },
    { seq: 4, createdAt: 4, content: diff('foreign-session') },
  ], hasMore: true, nextAfterSeq: 4 };
}
