import { describe, expect, it } from 'vitest';
import type { TurnChangeSet } from '@happier-dev/protocol';

import { ScmDiffSummaryProfile } from './ScmDiffSummaryProfile';

function makeTurnChangeSet(): TurnChangeSet {
  return {
    sessionId: 'sess-1',
    turnId: 'turn-1',
    seqRange: { startSeqInclusive: 10, endSeqInclusive: 12 },
    status: 'completed',
    provider: 'codex',
    derivedAt: 1,
    files: [{
      filePath: 'src/a.ts',
      changeKind: 'modified',
      source: 'scm_checkpoint',
      confidence: 'exact',
      provider: 'codex',
      unifiedDiff: '@@ -1 +1 @@\n-old\n+new\n',
    }],
    repositoryCheckpoint: {
      version: 1,
      scopeId: 'scope-1',
      baseRefSource: 'turn_start',
      contentConfidence: 'exact',
      attributionScope: 'shared_worktree',
      receipts: [{ id: 'checkpoint.diff_computed', ref: 'refs/happier/checkpoints/1' }],
    },
  };
}

describe('ScmDiffSummaryProfile', () => {
  it('builds a deterministic prompt from checkpoint TurnChangeSet evidence', async () => {
    const prepared = await ScmDiffSummaryProfile.prepareStartParams?.({
      cwd: '/repo',
      request: {
        kind: 'scm_diff_summary.v1',
        intent: 'scm_diff_summary',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        permissionMode: 'read_only',
        retentionPolicy: 'ephemeral',
        runClass: 'bounded',
        ioMode: 'request_response',
        intentInput: {
          cwd: '/repo',
          source: { kind: 'turnCheckpoint' },
          turnId: 'turn-1',
          checkpointReceiptId: 'checkpoint.diff_computed',
          turnChangeSet: makeTurnChangeSet(),
        },
      },
    });

    expect(prepared?.instructions).toContain('SCM diff summary generator.');
    expect(prepared?.instructions).toContain('src/a.ts');
    expect(prepared?.instructions).toContain('@@ -1 +1 @@');
    expect(prepared?.instructions).toContain('"summaryMarkdown": string');
    expect(prepared?.intentInput).toMatchObject({
      sourceKey: 'turnCheckpoint:turn-1:checkpoint.diff_computed',
      metadata: {
        contentConfidence: 'exact',
        attributionScope: 'shared_worktree',
      },
    });
  });

  it('projects structured model JSON into the buffered ScmDiffSummary result', () => {
    const completed = ScmDiffSummaryProfile.onBoundedComplete({
      start: {
        sessionId: 'sess-1',
        runId: 'run-1',
        callId: 'call-1',
        sidechainId: 'call-1',
        intent: 'scm_diff_summary',
        backendId: 'claude',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        instructions: 'prompt',
        intentInput: {
          source: { kind: 'turnCheckpoint' },
          sourceKey: 'turnCheckpoint:turn-1:checkpoint.diff_computed',
          checkpointReceiptId: 'checkpoint.diff_computed',
          metadata: {
            source: { kind: 'turnCheckpoint' },
            sourceKey: 'turnCheckpoint:turn-1:checkpoint.diff_computed',
            turnId: 'turn-1',
            checkpointReceiptId: 'checkpoint.diff_computed',
            contentConfidence: 'exact',
            attributionScope: 'shared_worktree',
          },
        },
        permissionMode: 'read_only',
        retentionPolicy: 'ephemeral',
        runClass: 'bounded',
        ioMode: 'request_response',
        startedAtMs: 1,
      },
      rawText: JSON.stringify({
        summaryMarkdown: '## Summary\n\nChanged src/a.ts.',
        risks: ['Shared worktree attribution.'],
        testImpact: 'Unit tests.',
        suggestedPrBody: 'Updated source.',
      }),
      finishedAtMs: 2,
    });

    expect(completed.status).toBe('succeeded');
    expect(completed.toolResultOutput).toMatchObject({
      success: true,
      summaryMarkdown: '## Summary\n\nChanged src/a.ts.',
      sourceKey: 'turnCheckpoint:turn-1:checkpoint.diff_computed',
      checkpointReceiptId: 'checkpoint.diff_computed',
      metadata: {
        contentConfidence: 'exact',
        attributionScope: 'shared_worktree',
      },
    });
    expect(completed.structuredMeta).toMatchObject({
      kind: 'scm_diff_summary.v1',
      payload: {
        summaryMarkdown: '## Summary\n\nChanged src/a.ts.',
      },
    });
  });
});
