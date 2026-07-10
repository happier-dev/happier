import { describe, expect, it } from 'vitest';

import {
  extractCanonicalDiffFiles,
  hasCanonicalTurnDiffEvidence,
  isCanonicalTurnDiffPayload,
  readEmptyCanonicalTurnDiffToolCallId,
  readTurnChangeToolMetadata,
  readTurnChangeToolMetadataFromToolCall,
  shouldSuppressEmptyCanonicalTurnDiffToolCall,
} from './canonicalTurnDiffTool.js';

function createEmptyTurnDiffInput() {
  return {
    files: [],
    _happier: {
      sessionChangeScope: 'turn',
      workspaceMutationSignal: 'turn-change-set',
      turnId: 'turn-1',
      sessionId: 'session-1',
      provider: 'codex',
      rawToolName: 'RepositoryCheckpointDiff',
      canonicalToolName: 'Diff',
      source: 'scm_checkpoint',
      confidence: 'exact',
      turnStatus: 'completed',
      seqRange: {
        startSeqInclusive: 1,
        endSeqInclusive: 2,
      },
    },
  };
}

describe('canonical turn diff transcript helpers', () => {
  it('reads turn-change metadata from JSON strings and wrapper fields', () => {
    const payload = createEmptyTurnDiffInput();

    expect(readTurnChangeToolMetadata(JSON.stringify(payload))).toMatchObject({
      turnId: 'turn-1',
      sessionId: 'session-1',
      provider: 'codex',
      source: 'scm_checkpoint',
      confidence: 'exact',
      turnStatus: 'completed',
      seqRange: { startSeqInclusive: 1, endSeqInclusive: 2 },
    });
    expect(readTurnChangeToolMetadataFromToolCall({ input: JSON.stringify(payload) }))
      .toEqual(readTurnChangeToolMetadata(payload));
    expect(readTurnChangeToolMetadata({ tool_use_result: JSON.stringify({ result: payload }) }))
      .toEqual(readTurnChangeToolMetadata(payload));
    expect(readTurnChangeToolMetadata({ output: payload }))
      .toEqual(readTurnChangeToolMetadata(payload));
  });

  it('reads repository checkpoint metadata from turn-scoped tool envelopes', () => {
    const payload = {
      _happier: {
        sessionChangeScope: 'turn',
        turnId: 'turn-checkpoint-1',
        sessionId: 'session-checkpoint-1',
        provider: 'scm:git',
        source: 'scm_checkpoint',
        confidence: 'exact',
        turnStatus: 'completed',
        seqRange: { startSeqInclusive: 5, endSeqInclusive: 5 },
        repositoryCheckpoint: {
          version: 1,
          scopeId: 'session-checkpoint-1:/repo',
          startRef: 'refs/happier/checkpoints/scope/turn-start/turn-checkpoint-1',
          finalRef: 'refs/happier/checkpoints/scope/turn-final/turn-checkpoint-1',
          baseRefSource: 'turn_start',
          contentConfidence: 'exact',
          attributionScope: 'shared_worktree',
          receipts: [
            {
              id: 'checkpoint.diff_computed',
              ref: 'refs/happier/checkpoints/scope/turn-final/turn-checkpoint-1',
            },
          ],
        },
      },
    };

    expect(readTurnChangeToolMetadata(payload)).toEqual({
      turnId: 'turn-checkpoint-1',
      sessionId: 'session-checkpoint-1',
      provider: 'scm:git',
      source: 'scm_checkpoint',
      confidence: 'exact',
      turnStatus: 'completed',
      seqRange: { startSeqInclusive: 5, endSeqInclusive: 5 },
      repositoryCheckpoint: expect.objectContaining({
        contentConfidence: 'exact',
        attributionScope: 'shared_worktree',
        receipts: [expect.objectContaining({ id: 'checkpoint.diff_computed' })],
      }),
    });
  });

  it('suppresses only empty canonical Diff tool calls with turn metadata', () => {
    expect(shouldSuppressEmptyCanonicalTurnDiffToolCall({
      toolName: 'Diff',
      input: createEmptyTurnDiffInput(),
    })).toBe(true);
    expect(shouldSuppressEmptyCanonicalTurnDiffToolCall({
      toolName: 'Read',
      input: createEmptyTurnDiffInput(),
    })).toBe(false);
    expect(shouldSuppressEmptyCanonicalTurnDiffToolCall({
      toolName: 'Diff',
      input: { files: [] },
    })).toBe(false);
  });

  it('extracts empty canonical Diff call ids from ACP and Codex transcript rows', () => {
    const input = JSON.stringify(createEmptyTurnDiffInput());

    expect(readEmptyCanonicalTurnDiffToolCallId({
      role: 'agent',
      content: {
        type: 'acp',
        agentId: 'codex',
        data: {
          type: 'tool-call',
          callId: 'diff-acp',
          name: 'Diff',
          input,
        },
      },
    })).toBe('diff-acp');

    expect(readEmptyCanonicalTurnDiffToolCallId({
      role: 'agent',
      content: {
        type: 'codex',
        provider: 'codex',
        data: {
          type: 'tool-call',
          call_id: 'diff-codex',
          toolName: 'Diff',
          input,
        },
      },
    })).toBe('diff-codex');
  });

  it('recognizes standalone v2 canonical Diff envelopes without full turn metadata', () => {
    const input = {
      files: [],
      _happier: {
        canonicalToolName: 'Diff',
      },
    };

    expect(isCanonicalTurnDiffPayload(input)).toBe(true);
    expect(shouldSuppressEmptyCanonicalTurnDiffToolCall({
      toolName: 'Diff',
      input,
    })).toBe(true);
    expect(readEmptyCanonicalTurnDiffToolCallId({
      role: 'agent',
      content: {
        type: 'codex',
        data: {
          type: 'tool-call',
          call_id: 'standalone-diff',
          toolName: 'Diff',
          input,
        },
      },
    })).toBe('standalone-diff');
  });

  it('detects file and unified-diff evidence in marked and unmarked payloads', () => {
    const marked = {
      ...createEmptyTurnDiffInput(),
      files: [{
        file_path: 'src/app.ts',
        change_kind: 'modified',
        unified_diff: '@@ -1 +1 @@\n-old\n+new',
      }],
    };
    const metadata = readTurnChangeToolMetadata(marked);
    expect(metadata).not.toBeNull();
    expect(hasCanonicalTurnDiffEvidence(marked)).toBe(true);
    expect(extractCanonicalDiffFiles(marked, metadata!)).toEqual([
      expect.objectContaining({
        filePath: 'src/app.ts',
        changeKind: 'modified',
        unifiedDiff: '@@ -1 +1 @@\n-old\n+new',
        source: 'scm_checkpoint',
        confidence: 'exact',
        provider: 'codex',
        agentTurnId: 'turn-1',
      }),
    ]);

    expect(hasCanonicalTurnDiffEvidence({
      files: [{ path: 'src/other.ts' }],
    })).toBe(true);
    expect(hasCanonicalTurnDiffEvidence({ _raw: { unified_diff: '@@ -1 +1 @@' } })).toBe(true);
    expect(hasCanonicalTurnDiffEvidence({ files: [] })).toBe(false);
  });
});
