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
      v: 2,
      protocol: 'codex',
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
  it('reads V3 turn evidence while rejecting invalid qualified tool provenance', () => {
    const payload = createEmptyTurnDiffInput();
    const current = { ...payload, _happier: { ...payload._happier, v: 3, protocol: 'native',
      agent: { pluginId: 'acme.agents', localId: 'muse' } } };
    expect(readTurnChangeToolMetadata(current)).toMatchObject({ provider: 'codex', turnId: 'turn-1' });
    expect(isCanonicalTurnDiffPayload({ ...current, _happier: { ...current._happier,
      agent: { ...current._happier.agent, unexpected: true } } })).toBe(false);
    expect(isCanonicalTurnDiffPayload({ _happier: { canonicalToolName: 'Diff' } })).toBe(false);
  });

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
        v: 2,
        protocol: 'codex',
        rawToolName: 'RepositoryCheckpointDiff',
        canonicalToolName: 'Diff',
        sessionChangeScope: 'turn',
        turnId: 'turn-checkpoint-1',
        sessionId: 'session-checkpoint-1',
        provider: 'scm:git',
        source: 'scm_checkpoint',
        confidence: 'exact',
        turnStatus: 'completed',
        seqRange: { startSeqInclusive: 5, endSeqInclusive: 5, retired: true },
        repositoryCheckpoint: {
          retired: true,
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
              retired: true,
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

  it('retains empty canonical Diff tool calls when checkpoint metadata is the evidence', () => {
    const checkpointInput = createEmptyTurnDiffInput();
    Object.assign(checkpointInput._happier, {
      repositoryCheckpoint: {
        version: 1,
        scopeId: 'session-1:/repo',
        baseRefSource: 'unavailable',
        contentConfidence: 'unavailable',
        attributionScope: 'unknown',
        receipts: [],
        unavailableReason: 'not_repo',
      },
    });
    expect(shouldSuppressEmptyCanonicalTurnDiffToolCall({
      toolName: 'Diff',
      input: checkpointInput,
    })).toBe(false);
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
        v: 2,
        protocol: 'codex',
        provider: 'codex',
        rawToolName: 'RepositoryCheckpointDiff',
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
      }),
    ]);

    expect(hasCanonicalTurnDiffEvidence({
      files: [{ path: 'src/other.ts' }],
    })).toBe(true);
    expect(hasCanonicalTurnDiffEvidence({ _raw: { unified_diff: '@@ -1 +1 @@' } })).toBe(true);
    expect(hasCanonicalTurnDiffEvidence({ files: [] })).toBe(false);
  });

  it('reads canonical per-file provider turn correlation before legacy aliases', () => {
    const input = {
      ...createEmptyTurnDiffInput(),
      files: [{
        file_path: 'src/correlated.ts',
        provider_turn_id: 'provider-turn-canonical',
        provider_message_id: 'provider-message-canonical',
        agentTurnId: 'provider-turn-canonical',
        providerTurnId: 'provider-turn-canonical',
      }],
    };
    const metadata = readTurnChangeToolMetadata(input);

    expect(metadata).not.toBeNull();
    expect(extractCanonicalDiffFiles(input, metadata!)).toEqual([
      expect.objectContaining({
        filePath: 'src/correlated.ts',
        agentTurnId: 'provider-turn-canonical',
        providerMessageId: 'provider-message-canonical',
      }),
    ]);
  });

  it('rejects invalid turn envelopes instead of repairing them into valid metadata', () => {
    const invalidValues = [
      { turnStatus: 'finished' },
      { seqRange: { startSeqInclusive: -1, endSeqInclusive: 2 } },
      { seqRange: { startSeqInclusive: 1.5, endSeqInclusive: 2 } },
      { seqRange: { startSeqInclusive: 3, endSeqInclusive: 2 } },
      { seqRange: { startSeqInclusive: Number.POSITIVE_INFINITY, endSeqInclusive: Number.POSITIVE_INFINITY } },
    ];

    for (const override of invalidValues) {
      const payload = createEmptyTurnDiffInput();
      Object.assign(payload._happier, override);
      expect(readTurnChangeToolMetadata(payload)).toBeNull();
    }
  });

  it('rejects conflicting correlation aliases and leaves absent correlation absent', () => {
    const conflicting = {
      ...createEmptyTurnDiffInput(),
      files: [{
        file_path: 'src/conflict.ts',
        change_kind: 'modified',
        provider_turn_id: 'provider-turn-current',
        providerTurnId: 'provider-turn-predecessor',
      }],
    };
    const uncorrelated = {
      ...createEmptyTurnDiffInput(),
      files: [{ file_path: 'src/uncorrelated.ts', change_kind: 'modified' }],
    };

    expect(extractCanonicalDiffFiles(conflicting, readTurnChangeToolMetadata(conflicting)!)).toEqual([]);
    expect(extractCanonicalDiffFiles(uncorrelated, readTurnChangeToolMetadata(uncorrelated)!)).toEqual([
      expect.not.objectContaining({ agentTurnId: expect.anything() }),
    ]);
  });

  it('rejects explicit invalid per-file evidence rather than defaulting it', () => {
    const payload = {
      ...createEmptyTurnDiffInput(),
      files: [{
        file_path: 'src/invalid.ts',
        change_kind: 'invented',
        source: 'invented',
        confidence: 'certain',
      }],
    };

    expect(extractCanonicalDiffFiles(payload, readTurnChangeToolMetadata(payload)!)).toEqual([]);
  });

  it('retains bounded evidence truthfulness and original size statistics', () => {
    const input = {
      ...createEmptyTurnDiffInput(),
      files: [{
        file_path: 'src/huge.ts',
        unified_diff: 'diff --git a/src/huge.ts b/src/huge.ts\n# bounded',
        source: 'scm_checkpoint',
        confidence: 'best_effort',
        provider: 'scm:git',
        truncated: true,
        stats: { unifiedDiffBytes: 900_000, addedLines: 4000, removedLines: 3000, retired: true },
      }],
    };
    const metadata = readTurnChangeToolMetadata(input);

    expect(extractCanonicalDiffFiles(input, metadata!)).toEqual([
      expect.objectContaining({
        filePath: 'src/huge.ts',
        confidence: 'best_effort',
        truncated: true,
        stats: { unifiedDiffBytes: 900_000, addedLines: 4000, removedLines: 3000 },
      }),
    ]);
  });
});
