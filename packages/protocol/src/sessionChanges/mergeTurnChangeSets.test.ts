import { describe, expect, it } from 'vitest';

import { TurnChangeSetSchema } from './schemas.js';
import { mergeTurnChangeSets } from './mergeTurnChangeSets.js';
import type { TurnChangeSet } from './types.js';

function makeTurn(files: TurnChangeSet['files']): TurnChangeSet {
  return {
    sessionId: 'session-1',
    turnId: 'turn-1',
    seqRange: { startSeqInclusive: 1, endSeqInclusive: 2 },
    status: 'completed',
    files,
    provider: 'codex',
    derivedAt: 1,
  };
}

describe('sessionChanges checkpoint evidence', () => {
  it('accepts scm checkpoint evidence and rejects unknown source ids', () => {
    const accepted = TurnChangeSetSchema.safeParse(makeTurn([{
      filePath: 'src/app.ts',
      changeKind: 'modified',
      source: 'scm_checkpoint',
      confidence: 'exact',
      provider: 'scm:git',
    }]));

    const rejected = TurnChangeSetSchema.safeParse(makeTurn([{
      filePath: 'src/app.ts',
      changeKind: 'modified',
      source: 'checkpoint' as never,
      confidence: 'exact',
      provider: 'scm:git',
    }]));

    expect(accepted.success).toBe(true);
    expect(rejected.success).toBe(false);
  });

  it('preserves checkpoint metadata on turn change sets', () => {
    const parsed = TurnChangeSetSchema.parse({
      ...makeTurn([]),
      repositoryCheckpoint: {
        version: 1,
        scopeId: 'session-1:repo',
        startRef: 'refs/happier/checkpoints/c2Vzc2lvbi0xOnJlcG8/turn-start/turn-1',
        finalRef: 'refs/happier/checkpoints/c2Vzc2lvbi0xOnJlcG8/turn-final/turn-1',
        baseRefSource: 'turn_start',
        contentConfidence: 'exact',
        attributionScope: 'shared_worktree',
        receipts: [{ id: 'checkpoint.diff_computed' }],
      },
    });

    expect(parsed.repositoryCheckpoint).toMatchObject({
      contentConfidence: 'exact',
      attributionScope: 'shared_worktree',
    });
  });

  it('prefers scm checkpoint file evidence without deleting unrelated provider evidence', () => {
    const result = mergeTurnChangeSets({
      sessionId: 'session-1',
      turns: [makeTurn([
        {
          filePath: 'src/shared.ts',
          changeKind: 'modified',
          source: 'provider_native',
          confidence: 'strong',
          provider: 'codex',
          unifiedDiff: 'provider diff',
        },
        {
          filePath: 'src/provider-only.ts',
          changeKind: 'modified',
          source: 'provider_native',
          confidence: 'strong',
          provider: 'codex',
        },
        {
          filePath: 'src/shared.ts',
          changeKind: 'modified',
          source: 'scm_checkpoint',
          confidence: 'exact',
          provider: 'scm:git',
          unifiedDiff: 'checkpoint diff',
        },
      ])],
    });

    expect(result.files).toEqual([
      expect.objectContaining({
        filePath: 'src/provider-only.ts',
        source: 'provider_native',
      }),
      expect.objectContaining({
        filePath: 'src/shared.ts',
        source: 'scm_checkpoint',
        confidence: 'exact',
        unifiedDiff: 'checkpoint diff',
      }),
    ]);
  });
});
