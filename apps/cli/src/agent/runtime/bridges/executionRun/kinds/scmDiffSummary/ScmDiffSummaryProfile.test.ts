import { beforeEach, describe, expect, it } from 'vitest';
import type { TurnChangeSet } from '@happier-dev/protocol';

import { ScmDiffSummaryProfile } from './ScmDiffSummaryProfile';
import { scmDiffSummaryCacheStore } from '@/agent/executionRuns/tasks/scmDiffSummary/cache/cacheStore';

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
  beforeEach(() => {
    scmDiffSummaryCacheStore.clear();
  });

  it('builds a deterministic prompt from checkpoint TurnChangeSet evidence', async () => {
    const prepared = await ScmDiffSummaryProfile.prepareStartParams?.({
      cwd: '/repo',
      request: {
        kind: 'scm_diff_summary.v1',
        intent: 'scm_diff_summary',
        backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
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

  it('filters checkpoint TurnChangeSet evidence for agent-reported summaries', async () => {
    const prepared = await ScmDiffSummaryProfile.prepareStartParams?.({
      cwd: '/repo',
      request: {
        kind: 'scm_diff_summary.v1',
        intent: 'scm_diff_summary',
        backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
        permissionMode: 'read_only',
        retentionPolicy: 'ephemeral',
        runClass: 'bounded',
        ioMode: 'request_response',
        intentInput: {
          cwd: '/repo',
          source: { kind: 'turnCheckpoint' },
          turnId: 'turn-1',
          checkpointReceiptId: 'checkpoint.diff_computed',
          turnEvidenceMode: 'agent_reported',
          turnChangeSet: {
            ...makeTurnChangeSet(),
            files: [
              {
                filePath: 'src/agent.ts',
                changeKind: 'modified',
                source: 'provider_tool',
                confidence: 'strong',
                provider: 'codex',
                unifiedDiff: '@@ agent\n',
              },
              {
                filePath: 'src/checkpoint.ts',
                changeKind: 'modified',
                source: 'scm_checkpoint',
                confidence: 'exact',
                provider: 'checkpoint',
                unifiedDiff: '@@ checkpoint\n',
              },
            ],
          },
        },
      },
    });

    expect(prepared?.instructions).toContain('src/agent.ts');
    expect(prepared?.instructions).not.toContain('src/checkpoint.ts');
    expect(prepared?.intentInput).toMatchObject({
      metadata: {
        turnEvidenceMode: 'agent_reported',
      },
    });
  });

  it('does not echo raw modelSelector fields into the resolved cache selector', async () => {
    const prepared = await ScmDiffSummaryProfile.prepareStartParams?.({
      cwd: '/repo',
      request: {
        kind: 'scm_diff_summary.v1',
        intent: 'scm_diff_summary',
        backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
        permissionMode: 'read_only',
        retentionPolicy: 'ephemeral',
        runClass: 'bounded',
        ioMode: 'request_response',
        intentInput: {
          cwd: '/repo',
          source: { kind: 'turnCheckpoint' },
          turnId: 'turn-1',
          checkpointReceiptId: 'checkpoint.diff_computed',
          modelSelector: { profileId: 'raw-user-profile' },
          turnChangeSet: makeTurnChangeSet(),
        },
      },
    });

    expect(prepared?.intentInput).toMatchObject({
      resolvedSelector: { catalogId: 'backend:claude' },
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

  it('writes successful checkpoint summaries to the receipt-keyed cache and reuses them in prepareStartParams', async () => {
    const start = {
      sessionId: 'sess-1',
      runId: 'run-1',
      callId: 'call-1',
      sidechainId: 'sidechain-1',
      intent: 'scm_diff_summary' as const,
      backendId: 'claude',
      backendTarget: { kind: 'builtInAgent' as const, agentId: 'claude' },
      instructions: 'prompt',
      intentInput: {
        source: { kind: 'turnCheckpoint' },
        sourceKey: 'turnCheckpoint:turn-1:checkpoint.diff_computed',
        checkpointReceiptId: 'checkpoint.diff_computed',
        summarySchemaVersion: 1,
        resolvedSelector: { catalogId: 'profile:fast-summary' },
        metadata: {
          source: { kind: 'turnCheckpoint' },
          sourceKey: 'turnCheckpoint:turn-1:checkpoint.diff_computed',
          turnId: 'turn-1',
          checkpointReceiptId: 'checkpoint.diff_computed',
          contentConfidence: 'exact',
          attributionScope: 'shared_worktree',
        },
        checkpointRef: 'refs/happier/checkpoints/1',
      },
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral' as const,
      runClass: 'bounded' as const,
      ioMode: 'request_response' as const,
      startedAtMs: 1,
    };

    ScmDiffSummaryProfile.onBoundedComplete({
      start,
      rawText: JSON.stringify({
        summaryMarkdown: '## Summary\n\nCached checkpoint summary.',
      }),
      finishedAtMs: 2,
    });

    const prepared = await ScmDiffSummaryProfile.prepareStartParams?.({
      cwd: '/repo',
      request: {
        kind: 'scm_diff_summary.v1',
        intent: 'scm_diff_summary',
        backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
        permissionMode: 'read_only',
        retentionPolicy: 'ephemeral',
        runClass: 'bounded',
        ioMode: 'request_response',
        intentInput: {
          cwd: '/repo',
          source: { kind: 'turnCheckpoint' },
          turnId: 'turn-1',
          checkpointReceiptId: 'checkpoint.diff_computed',
          summarySchemaVersion: 1,
          resolvedSelector: { catalogId: 'profile:fast-summary' },
          turnChangeSet: makeTurnChangeSet(),
        },
      },
    });

    expect(prepared?.intentInput).toMatchObject({
      cachedOutput: {
        success: true,
        summaryMarkdown: '## Summary\n\nCached checkpoint summary.',
      },
    });
  });

  it('bypasses the receipt-keyed cache when explicit regenerate requests fresh generation', async () => {
    const start = {
      sessionId: 'sess-1',
      runId: 'run-1',
      callId: 'call-1',
      sidechainId: 'sidechain-1',
      intent: 'scm_diff_summary' as const,
      backendId: 'claude',
      backendTarget: { kind: 'builtInAgent' as const, agentId: 'claude' },
      instructions: 'prompt',
      intentInput: {
        source: { kind: 'turnCheckpoint' },
        sourceKey: 'turnCheckpoint:turn-1:checkpoint.diff_computed',
        checkpointReceiptId: 'checkpoint.diff_computed',
        summarySchemaVersion: 1,
        resolvedSelector: { catalogId: 'profile:fast-summary' },
        metadata: {
          source: { kind: 'turnCheckpoint' },
          sourceKey: 'turnCheckpoint:turn-1:checkpoint.diff_computed',
          turnId: 'turn-1',
          checkpointReceiptId: 'checkpoint.diff_computed',
        },
      },
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral' as const,
      runClass: 'bounded' as const,
      ioMode: 'request_response' as const,
      startedAtMs: 1,
    };

    ScmDiffSummaryProfile.onBoundedComplete({
      start,
      rawText: JSON.stringify({
        summaryMarkdown: '## Summary\n\nCached checkpoint summary.',
      }),
      finishedAtMs: 2,
    });

    const prepared = await ScmDiffSummaryProfile.prepareStartParams?.({
      cwd: '/repo',
      request: {
        kind: 'scm_diff_summary.v1',
        intent: 'scm_diff_summary',
        backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
        permissionMode: 'read_only',
        retentionPolicy: 'ephemeral',
        runClass: 'bounded',
        ioMode: 'request_response',
        intentInput: {
          cwd: '/repo',
          source: { kind: 'turnCheckpoint' },
          turnId: 'turn-1',
          checkpointReceiptId: 'checkpoint.diff_computed',
          summarySchemaVersion: 1,
          resolvedSelector: { catalogId: 'profile:fast-summary' },
          cachePolicy: { mode: 'bypass' },
          turnChangeSet: makeTurnChangeSet(),
        },
      },
    });

    expect(prepared?.instructions).toContain('SCM diff summary generator.');
    expect(prepared?.intentInput).toMatchObject({
      cachePolicy: { mode: 'bypass' },
      resolvedSelector: { catalogId: 'profile:fast-summary' },
    });
    expect(prepared?.intentInput).not.toHaveProperty('cachedOutput');
  });
});
