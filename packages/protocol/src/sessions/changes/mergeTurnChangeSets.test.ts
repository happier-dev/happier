import { describe, expect, it, vi } from 'vitest';

import { ScmDiffSummaryMetadataSchema } from '../../scm/diffSummary.js';
import { SessionChangeSetSchema, TurnChangeSetSchema } from './schemas.js';
import { combineChangedFilesAttribution, mergeTurnChangeSets } from './mergeTurnChangeSets.js';
import type { TurnChangeSet } from './types.js';

function makeTurn(
  files: TurnChangeSet['files'],
  overrides: Partial<TurnChangeSet> = {},
): TurnChangeSet {
  return {
    sessionId: 'session-1',
    turnId: 'turn-1',
    seqRange: { startSeqInclusive: 1, endSeqInclusive: 2 },
    status: 'completed',
    files,
    provider: 'codex',
    derivedAt: 1,
    ...overrides,
  };
}

function makeCheckpointMetadata(
  attributionScope: NonNullable<TurnChangeSet['repositoryCheckpoint']>['attributionScope'],
): NonNullable<TurnChangeSet['repositoryCheckpoint']> {
  return {
    version: 1,
    scopeId: 'session-1:repo',
    baseRefSource: 'turn_start',
    contentConfidence: 'exact',
    attributionScope,
    receipts: [],
  };
}

const CHECKPOINT_FILE = {
  filePath: 'src/shared.ts',
  changeKind: 'modified',
  source: 'scm_checkpoint',
  confidence: 'exact',
  provider: 'scm:git',
  unifiedDiff: 'checkpoint diff',
} as const satisfies TurnChangeSet['files'][number];

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

describe('sessionChanges content and attribution axes', () => {
  it('combines ambiguous checkpoint content without allowing a caller-supplied attribution override', () => {
    const result = combineChangedFilesAttribution({
      sessionId: 'session-1',
      turns: [makeTurn([CHECKPOINT_FILE], {
        repositoryCheckpoint: makeCheckpointMetadata('unknown'),
      })],
    });

    expect(result.files[0]).toMatchObject({
      source: 'scm_checkpoint',
      confidence: 'exact',
      attribution: { confidence: 'unknown', reason: 'unavailable' },
      checkpointOverlap: 'unknown',
    });
  });

  it('keeps exact checkpoint content while limiting attribution when overlap was observed', () => {
    const result = mergeTurnChangeSets({
      sessionId: 'session-1',
      turns: [makeTurn([CHECKPOINT_FILE], {
        repositoryCheckpoint: makeCheckpointMetadata('shared_worktree'),
      })],
    });

    expect(result.files[0]).toMatchObject({
      source: 'scm_checkpoint',
      confidence: 'exact',
      checkpointOverlap: 'observed',
      attribution: {
        confidence: 'session_possible',
        reason: 'checkpoint_overlap_observed',
      },
    });
    expect(result.confidenceSummary).toMatchObject({
      source: 'scm_checkpoint',
      confidence: 'exact',
      attribution: {
        confidence: 'session_possible',
        reason: 'checkpoint_overlap_observed',
      },
      checkpointOverlap: 'observed',
    });
  });

  it('reports bounded no-observed-overlap checkpoint attribution without claiming exclusivity', () => {
    const result = mergeTurnChangeSets({
      sessionId: 'session-1',
      turns: [makeTurn([CHECKPOINT_FILE], {
        repositoryCheckpoint: makeCheckpointMetadata('no_happier_checkpoint_overlap_observed'),
      })],
    });

    expect(result.files[0]).toMatchObject({
      confidence: 'exact',
      checkpointOverlap: 'not_observed',
      attribution: {
        confidence: 'session_likely',
        reason: 'checkpoint_no_happier_overlap_observed',
      },
    });
    expect(result.confidenceSummary.checkpointOverlap).toBe('not_observed');
  });

  it('degrades attribution to unknown when checkpoint scope is unknown or missing', () => {
    const unknownScope = mergeTurnChangeSets({
      sessionId: 'session-1',
      turns: [makeTurn([CHECKPOINT_FILE], {
        repositoryCheckpoint: makeCheckpointMetadata('unknown'),
      })],
    });
    const missingMetadata = mergeTurnChangeSets({
      sessionId: 'session-1',
      turns: [makeTurn([CHECKPOINT_FILE])],
    });

    expect(unknownScope.files[0]).toMatchObject({
      confidence: 'exact',
      checkpointOverlap: 'unknown',
      attribution: { confidence: 'unknown', reason: 'unavailable' },
    });
    expect(missingMetadata.files[0]).toMatchObject({
      confidence: 'exact',
      checkpointOverlap: 'unknown',
      attribution: { confidence: 'unknown', reason: 'unavailable' },
    });
  });

  it('preserves provider correlation through a checkpoint merge in either order', () => {
    const providerFirst = mergeTurnChangeSets({
      sessionId: 'session-1',
      turns: [makeTurn([
        {
          filePath: 'src/shared.ts',
          changeKind: 'modified',
          source: 'provider_native',
          confidence: 'strong',
          provider: 'codex',
        },
        CHECKPOINT_FILE,
      ], { repositoryCheckpoint: makeCheckpointMetadata('shared_worktree') })],
    });
    const checkpointFirst = mergeTurnChangeSets({
      sessionId: 'session-1',
      turns: [makeTurn([
        CHECKPOINT_FILE,
        {
          filePath: 'src/shared.ts',
          changeKind: 'modified',
          source: 'provider_native',
          confidence: 'strong',
          provider: 'codex',
          unifiedDiff: 'provider diff',
        },
      ], { repositoryCheckpoint: makeCheckpointMetadata('shared_worktree') })],
    });

    for (const result of [providerFirst, checkpointFirst]) {
      expect(result.confidenceSummary.confidence).toBe('exact');
      expect(result.files[0]).toMatchObject({
        source: 'scm_checkpoint',
        confidence: 'exact',
        unifiedDiff: 'checkpoint diff',
        checkpointOverlap: 'observed',
        attribution: {
          confidence: 'session_exact',
          reason: 'provider_correlated',
        },
      });
    }
  });

  it('does not turn a known checkpoint non-overlap into unknown when provider evidence corroborates the same file', () => {
    const provider = {
      filePath: 'src/shared.ts',
      changeKind: 'modified',
      source: 'provider_native',
      confidence: 'strong',
      provider: 'codex',
    } as const satisfies TurnChangeSet['files'][number];

    for (const files of [[provider, CHECKPOINT_FILE], [CHECKPOINT_FILE, provider]]) {
      const result = mergeTurnChangeSets({
        sessionId: 'session-1',
        turns: [makeTurn(files, {
          repositoryCheckpoint: makeCheckpointMetadata('no_happier_checkpoint_overlap_observed'),
        })],
      });

      expect(result.files[0]).toMatchObject({
        source: 'scm_checkpoint',
        checkpointOverlap: 'not_observed',
        attribution: {
          confidence: 'session_exact',
          reason: 'provider_correlated',
        },
      });
      expect(result.confidenceSummary.checkpointOverlap).toBe('not_observed');
    }
  });

  it('does not count provider-only files as unknown checkpoint observations in the summary', () => {
    const result = mergeTurnChangeSets({
      sessionId: 'session-1',
      turns: [makeTurn([
        CHECKPOINT_FILE,
        {
          filePath: 'src/provider-only.ts',
          changeKind: 'modified',
          source: 'provider_native',
          confidence: 'strong',
          provider: 'codex',
          agentTurnId: 'provider-turn-1',
        },
      ], {
        repositoryCheckpoint: makeCheckpointMetadata('no_happier_checkpoint_overlap_observed'),
      })],
    });

    expect(result.files.find((file) => file.filePath === 'src/provider-only.ts')).toMatchObject({
      attribution: { confidence: 'session_exact', reason: 'provider_correlated' },
      checkpointOverlap: 'unknown',
    });
    expect(result.confidenceSummary.checkpointOverlap).toBe('not_observed');
  });

  it('treats a later provider-only turn on the same file as uncovered, not neutral', () => {
    const result = mergeTurnChangeSets({
      sessionId: 'session-1',
      turns: [
        makeTurn([CHECKPOINT_FILE], {
          repositoryCheckpoint: makeCheckpointMetadata('no_happier_checkpoint_overlap_observed'),
        }),
        makeTurn([{
          ...CHECKPOINT_FILE,
          source: 'provider_native',
          confidence: 'strong',
          provider: 'codex',
          agentTurnId: 'provider-turn-2',
        }], { turnId: 'turn-2' }),
      ],
    });

    expect(result.files[0]).toMatchObject({
      attribution: {
        confidence: 'session_likely',
        reason: 'checkpoint_no_happier_overlap_observed',
      },
      checkpointOverlap: 'unknown',
    });
    expect(result.confidenceSummary.checkpointOverlap).toBe('unknown');
  });

  it('keeps a file checkpointed in every contributing turn observed-negative', () => {
    const result = mergeTurnChangeSets({
      sessionId: 'session-1',
      turns: [
        makeTurn([CHECKPOINT_FILE], {
          repositoryCheckpoint: makeCheckpointMetadata('no_happier_checkpoint_overlap_observed'),
        }),
        makeTurn([CHECKPOINT_FILE], {
          turnId: 'turn-2',
          repositoryCheckpoint: makeCheckpointMetadata('no_happier_checkpoint_overlap_observed'),
        }),
      ],
    });

    expect(result.files[0]?.checkpointOverlap).toBe('not_observed');
    expect(result.confidenceSummary.checkpointOverlap).toBe('not_observed');
  });

  it('never lets workspace-inferred evidence upgrade attribution', () => {
    const result = mergeTurnChangeSets({
      sessionId: 'session-1',
      turns: [makeTurn([
        {
          filePath: 'src/shared.ts',
          changeKind: 'modified',
          source: 'inferred',
          confidence: 'best_effort',
          provider: 'workspace',
        },
        CHECKPOINT_FILE,
      ], { repositoryCheckpoint: makeCheckpointMetadata('shared_worktree') })],
    });

    expect(result.files[0]).toMatchObject({
      confidence: 'exact',
      attribution: {
        confidence: 'session_possible',
        reason: 'checkpoint_overlap_observed',
      },
    });
  });

  it('summarizes the weakest attribution across files without flattening per-file evidence', () => {
    const result = mergeTurnChangeSets({
      sessionId: 'session-1',
      turns: [makeTurn([
        {
          filePath: 'src/provider.ts',
          changeKind: 'modified',
          source: 'provider_tool',
          confidence: 'strong',
          provider: 'codex',
        },
        CHECKPOINT_FILE,
      ], { repositoryCheckpoint: makeCheckpointMetadata('shared_worktree') })],
    });

    expect(result.confidenceSummary.attribution).toEqual({
      confidence: 'session_possible',
      reason: 'checkpoint_overlap_observed',
    });
    expect(result.files.map((file) => file.attribution.confidence)).toEqual([
      'session_exact',
      'session_possible',
    ]);
  });

  it('keeps binary and rename evidence intact alongside the derived axes', () => {
    const result = mergeTurnChangeSets({
      sessionId: 'session-1',
      turns: [makeTurn([
        {
          filePath: 'assets/logo.png',
          previousFilePath: 'assets/old-logo.png',
          changeKind: 'renamed',
          source: 'scm_checkpoint',
          confidence: 'exact',
          provider: 'scm:git',
          binary: true,
        },
      ], { repositoryCheckpoint: makeCheckpointMetadata('shared_worktree') })],
    });

    expect(result.files[0]).toMatchObject({
      filePath: 'assets/logo.png',
      previousFilePath: 'assets/old-logo.png',
      changeKind: 'renamed',
      binary: true,
      attribution: { confidence: 'session_possible' },
    });
  });
});


describe('checkpoint scope schema', () => {
  it('rejects the undeployed exclusive-worktree claim at every Protocol read boundary', () => {
    const turn = TurnChangeSetSchema.safeParse({
      ...makeTurn([CHECKPOINT_FILE]),
      repositoryCheckpoint: { ...makeCheckpointMetadata('unknown'), attributionScope: 'exclusive_worktree' },
    });
    const summary = ScmDiffSummaryMetadataSchema.safeParse({
      source: { kind: 'turnCheckpoint' },
      sourceKey: 'checkpoint:turn-1',
      attributionScope: 'exclusive_worktree',
    });

    expect(turn.success).toBe(false);
    expect(summary.success).toBe(false);
  });
});


describe('predecessor file correlation reader', () => {
  // ../0.2 b23f95ed354e8d49183017e487bdb75f217017de sessionChanges/schemas.ts
  it('normalizes providerTurnId into current agent correlation without widening the strict evidence shape', () => {
    const file = { filePath: 'src/a.ts', changeKind: 'modified', source: 'provider_native',
      confidence: 'strong', provider: 'codex', providerTurnId: 'native-turn-1' } as const;
    const turn = TurnChangeSetSchema.parse(makeTurn([file]));
    expect(turn.files[0]).toMatchObject({ agentTurnId: 'native-turn-1' });
    expect(turn.files[0]).not.toHaveProperty('providerTurnId');
    expect(mergeTurnChangeSets({ sessionId: turn.sessionId, turns: [turn] }).files[0]).toMatchObject({
      agentTurnId: 'native-turn-1', attribution: { confidence: 'session_exact' },
    });
    expect(TurnChangeSetSchema.safeParse({ ...makeTurn([]), files: [{ ...file, unknownEvidence: true }] }).success).toBe(false);
    expect(TurnChangeSetSchema.safeParse({ ...makeTurn([]), files: [{ ...file, providerTurnId: 42 }] }).success).toBe(false);
  });

  it('rejects conflicting predecessor and canonical turn correlation instead of choosing one', () => {
    const file = {
      filePath: 'src/a.ts',
      changeKind: 'modified',
      source: 'provider_native',
      confidence: 'strong',
      provider: 'codex',
      providerTurnId: 'predecessor-turn',
      agentTurnId: 'canonical-turn',
    } as const;

    expect(TurnChangeSetSchema.safeParse({ ...makeTurn([]), files: [file] }).success).toBe(false);
  });
});


describe('canonical per-turn content selection', () => {
  it('keeps checkpoint content fields together in either evidence order', () => {
    const checkpoint = { ...CHECKPOINT_FILE, changeKind: 'renamed', previousFilePath: 'old.ts',
      binary: true, oldText: 'checkpoint before', newText: 'checkpoint after' } as const;
    const provider = { ...CHECKPOINT_FILE, source: 'provider_tool', confidence: 'strong',
      binary: false, oldText: 'provider before', newText: 'provider after' } as const;
    for (const files of [[provider, checkpoint], [checkpoint, provider]]) {
      expect(mergeTurnChangeSets({ sessionId: 'session-1', turns: [makeTurn(files)] }).files[0]).toMatchObject({
        changeKind: 'renamed', previousFilePath: 'old.ts', binary: true,
        oldText: 'checkpoint before', newText: 'checkpoint after',
      });
    }
  });

  it('selects same-source content confidence independently of evidence order', () => {
    const exact = {
      filePath: 'src/shared.ts',
      changeKind: 'modified',
      source: 'provider_tool',
      confidence: 'exact',
      provider: 'codex',
      agentTurnId: 'provider-turn-1',
      newText: 'z-exact content',
    } as const;
    const strong = {
      ...exact,
      confidence: 'strong',
      newText: 'a-strong content',
    } as const;

    for (const files of [[strong, exact], [exact, strong]]) {
      expect(mergeTurnChangeSets({ sessionId: 'session-1', turns: [makeTurn(files)] }).files[0]).toMatchObject({
        confidence: 'exact',
        newText: 'z-exact content',
      });
    }
  });
});


describe('chronological content provenance', () => {
  it('qualifies continuous recorded text spans without claiming complete file content', () => {
    const result = mergeTurnChangeSets({ sessionId: 'session-1', turns: [
      makeTurn([{ ...CHECKPOINT_FILE, source: 'provider_tool', oldText: 'start', newText: 'middle' }]),
      makeTurn([{ ...CHECKPOINT_FILE, source: 'provider_tool', oldText: 'middle', newText: 'end' }], { turnId: 'turn-2' }),
    ] });
    expect(result.files[0]).toMatchObject({ oldText: 'start', newText: 'end', confidence: 'best_effort' });
  });

  it('does not call equal fragment endpoints a clean Session file', () => {
    const result = mergeTurnChangeSets({ sessionId: 'session-1', turns: [
      makeTurn([{ ...CHECKPOINT_FILE, source: 'provider_tool', oldText: 'start', newText: 'middle' }]),
      makeTurn([{ ...CHECKPOINT_FILE, source: 'provider_tool', oldText: 'middle', newText: 'start' }], { turnId: 'turn-2' }),
    ] });
    expect(result.files[0]).toMatchObject({ oldText: null, newText: null, unifiedDiff: null, confidence: 'best_effort' });
    expect(result.turns).toHaveLength(2);
  });

  it('normalizes aggregate-only paths at the root owner', () => {
    const aggregate = mergeTurnChangeSets({ sessionId: 'session-1', turns: [makeTurn([
      { ...CHECKPOINT_FILE, filePath: '/repo/src/shared.ts' },
    ])] });
    const legacy = combineChangedFilesAttribution({ sessionId: 'session-1', repoRootPath: '/repo',
      canonicalChangeSet: { ...aggregate, turns: [] } });
    expect(legacy.files[0]?.filePath).toBe('src/shared.ts');
  });

  it('does not present a last-turn patch or statistics as the net Session change', () => {
    const result = mergeTurnChangeSets({ sessionId: 'session-1', turns: [
      makeTurn([{ ...CHECKPOINT_FILE, oldText: 'one\ntwo\n', newText: 'ONE\ntwo\n' }]),
      makeTurn([{ ...CHECKPOINT_FILE, oldText: 'ONE\ntwo\n', newText: 'ONE\nTWO\n',
        unifiedDiff: 'last turn only', stats: { addedLines: 1, removedLines: 1 } }], { turnId: 'turn-2' }),
    ] });
    expect(result.files[0]).toMatchObject({ oldText: 'one\ntwo\n', newText: 'ONE\nTWO\n', unifiedDiff: null });
    expect(result.files[0]?.stats).toBeUndefined();
  });

  it.each([
    { oldText: null, newText: 'middle' },
    { oldText: 'before', newText: 'unrelated fragment' },
    { oldText: 'before', newText: 'middle', truncated: true as const },
  ])('does not fabricate net content from missing or discontinuous evidence: %j', (first) => {
    const result = mergeTurnChangeSets({ sessionId: 'session-1', turns: [
      makeTurn([{ ...CHECKPOINT_FILE, ...first }]),
      makeTurn([{ ...CHECKPOINT_FILE, oldText: 'middle', newText: 'after' }], { turnId: 'turn-2' }),
    ] });
    expect(result.files[0]).toMatchObject({ oldText: null, newText: null, unifiedDiff: null, confidence: 'best_effort' });
    expect(result.turns[1]?.files[0]?.oldText).toBe('middle');
  });

  it('combines absolute tool paths and relative checkpoint paths using the repository root', () => {
    const provider = { ...CHECKPOINT_FILE, filePath: '/repo/src/shared.ts', source: 'provider_tool' as const,
      provider: 'codex', agentTurnId: 'native-turn' };
    const result = combineChangedFilesAttribution({ sessionId: 'session-1', repoRootPath: '/repo', turns: [
      makeTurn([provider, CHECKPOINT_FILE], { repositoryCheckpoint: makeCheckpointMetadata('shared_worktree') }),
    ] });
    expect(result.files).toEqual([expect.objectContaining({ filePath: 'src/shared.ts', source: 'scm_checkpoint',
      confidence: 'exact', attribution: { confidence: 'session_exact', reason: 'provider_correlated' },
      agentTurnId: 'native-turn', checkpointOverlap: 'observed' })]);
    expect(result.turns[0]?.files[0]?.filePath).toBe('/repo/src/shared.ts');
  });

  it.each([
    ['C:\\Users\\Alice\\repo', 'c:/users/alice/repo/src/shared.ts'],
    ['\\\\server\\share', '//server/share/src/shared.ts'],
  ])('combines platform path aliases through the existing SCM root owner: %s', (repoRootPath, filePath) => {
    const result = combineChangedFilesAttribution({ sessionId: 'session-1', repoRootPath, turns: [
      makeTurn([{ ...CHECKPOINT_FILE, filePath, source: 'provider_tool' }, CHECKPOINT_FILE]),
    ] });
    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.filePath).toBe('src/shared.ts');
  });

  it('does not label a later provider delta as an earlier exact checkpoint', () => {
    const turns = [
      makeTurn([{ ...CHECKPOINT_FILE, oldText: 'start', newText: 'checkpoint' }]),
      makeTurn([{ ...CHECKPOINT_FILE, source: 'provider_tool', confidence: 'strong',
        unifiedDiff: 'later provider diff', oldText: 'checkpoint', newText: 'latest' }], { turnId: 'turn-2' }),
    ];
    const result = mergeTurnChangeSets({ sessionId: 'session-1', turns });
    expect(result.files[0]).toMatchObject({ source: 'provider_tool', confidence: 'best_effort',
      oldText: 'start', newText: 'latest', unifiedDiff: null });
    expect(result.confidenceSummary).toMatchObject({ source: 'provider_tool', confidence: 'best_effort' });
  });

  it('does not fill absent checkpoint content from weaker evidence in either order', () => {
    const checkpoint = { ...CHECKPOINT_FILE, unifiedDiff: null };
    const provider = { ...CHECKPOINT_FILE, source: 'provider_tool', confidence: 'strong',
      unifiedDiff: 'obsolete diff', newText: 'obsolete text' } as const;
    for (const files of [[provider, checkpoint], [checkpoint, provider]]) {
      const file = mergeTurnChangeSets({ sessionId: 'session-1', turns: [makeTurn(files)] }).files[0];
      expect(file.unifiedDiff).toBeNull();
      expect(file.newText ?? null).toBeNull();
    }
  });

  it('preserves the earliest before text when a later turn supplies several evidence sources', () => {
    const result = mergeTurnChangeSets({ sessionId: 'session-1', turns: [
      makeTurn([{ ...CHECKPOINT_FILE, oldText: 'start', newText: 'middle' }]),
      makeTurn([
        { ...CHECKPOINT_FILE, source: 'provider_tool', confidence: 'strong', oldText: 'middle', newText: 'interim' },
        { ...CHECKPOINT_FILE, oldText: 'middle', newText: 'final' },
      ], { turnId: 'turn-2' }),
    ] });
    expect(result.files[0]).toMatchObject({ oldText: 'start', newText: 'final' });
  });

  it('uses sequence chronology rather than caller iteration order', () => {
    const earlier = makeTurn([{ ...CHECKPOINT_FILE, oldText: 'start', newText: 'middle' }], {
      turnId: 'turn-1',
      seqRange: { startSeqInclusive: 1, endSeqInclusive: 2 },
      derivedAt: 10,
    });
    const later = makeTurn([{
      ...CHECKPOINT_FILE,
      source: 'provider_tool',
      confidence: 'strong',
      provider: 'codex',
      agentTurnId: 'provider-turn-2',
      oldText: 'middle',
      newText: 'latest',
      unifiedDiff: 'later provider diff',
    }], {
      turnId: 'turn-2',
      seqRange: { startSeqInclusive: 3, endSeqInclusive: 4 },
      derivedAt: 20,
    });

    const result = mergeTurnChangeSets({ sessionId: 'session-1', turns: [later, earlier] });

    expect(result.files[0]).toMatchObject({
      source: 'provider_tool',
      oldText: 'start',
      newText: 'latest',
      unifiedDiff: null,
    });
    expect(result.files[0]?.turns).toEqual(['turn-1', 'turn-2']);
  });

  it('carries an edited path into its later rename destination', () => {
    const result = mergeTurnChangeSets({
      sessionId: 'session-1',
      turns: [
        makeTurn([{
          ...CHECKPOINT_FILE,
          filePath: 'src/old.ts',
          oldText: 'start',
          newText: 'middle',
        }]),
        makeTurn([{
          ...CHECKPOINT_FILE,
          filePath: 'src/new.ts',
          previousFilePath: 'src/old.ts',
          changeKind: 'renamed',
          oldText: 'middle',
          newText: 'latest',
        }], {
          turnId: 'turn-2',
          seqRange: { startSeqInclusive: 3, endSeqInclusive: 4 },
        }),
      ],
    });

    expect(result.files).toEqual([
      expect.objectContaining({
        filePath: 'src/new.ts',
        previousFilePath: 'src/old.ts',
        changeKind: 'renamed',
        oldText: 'start',
        newText: 'latest',
        turns: ['turn-1', 'turn-2'],
      }),
    ]);
  });

  it('carries same-turn edit evidence into a rename independently of evidence order', () => {
    const edit = {
      ...CHECKPOINT_FILE,
      filePath: 'src/old.ts',
      oldText: 'start',
      newText: 'middle',
    } as const;
    const rename = {
      ...CHECKPOINT_FILE,
      filePath: 'src/new.ts',
      previousFilePath: 'src/old.ts',
      changeKind: 'renamed',
      oldText: 'middle',
      newText: 'latest',
    } as const;

    for (const files of [[edit, rename], [rename, edit]]) {
      expect(mergeTurnChangeSets({ sessionId: 'session-1', turns: [makeTurn(files)] }).files).toEqual([
        expect.objectContaining({
          filePath: 'src/new.ts',
          previousFilePath: 'src/old.ts',
          oldText: 'start',
          newText: 'latest',
          turns: ['turn-1'],
        }),
      ]);
    }
  });

  it('collapses a chronological rename chain while retaining its original path and every turn', () => {
    const result = mergeTurnChangeSets({
      sessionId: 'session-1',
      turns: [
        makeTurn([{ ...CHECKPOINT_FILE, filePath: 'src/old.ts' }]),
        makeTurn([{
          ...CHECKPOINT_FILE,
          filePath: 'src/middle.ts',
          previousFilePath: 'src/old.ts',
          changeKind: 'renamed',
        }], {
          turnId: 'turn-2',
          seqRange: { startSeqInclusive: 3, endSeqInclusive: 4 },
        }),
        makeTurn([{
          ...CHECKPOINT_FILE,
          filePath: 'src/new.ts',
          previousFilePath: 'src/middle.ts',
          changeKind: 'renamed',
        }], {
          turnId: 'turn-3',
          seqRange: { startSeqInclusive: 5, endSeqInclusive: 6 },
        }),
      ],
    });

    expect(result.files).toEqual([
      expect.objectContaining({
        filePath: 'src/new.ts',
        previousFilePath: 'src/old.ts',
        changeKind: 'renamed',
        turns: ['turn-1', 'turn-2', 'turn-3'],
      }),
    ]);
  });

  it('keeps a copied destination separate from its source lineage', () => {
    const result = mergeTurnChangeSets({
      sessionId: 'session-1',
      turns: [
        makeTurn([{ ...CHECKPOINT_FILE, filePath: 'src/original.ts' }]),
        makeTurn([{
          ...CHECKPOINT_FILE,
          filePath: 'src/copy.ts',
          previousFilePath: 'src/original.ts',
          changeKind: 'copied',
        }], {
          turnId: 'turn-2',
          seqRange: { startSeqInclusive: 3, endSeqInclusive: 4 },
        }),
      ],
    });

    expect(result.files.map((file) => ({
      filePath: file.filePath,
      previousFilePath: file.previousFilePath ?? null,
      turns: file.turns,
    }))).toEqual([
      { filePath: 'src/copy.ts', previousFilePath: 'src/original.ts', turns: ['turn-2'] },
      { filePath: 'src/original.ts', previousFilePath: null, turns: ['turn-1'] },
    ]);
  });
});

describe('deterministic attribution aggregation', () => {
  it('orders chained rename evidence without quadratic path rescans', () => {
    const countPendingCandidateReads = (fileCount: number): number => {
      let candidateReads = 0;
      const originalSome = Array.prototype.some;
      const someSpy = vi.spyOn(Array.prototype, 'some').mockImplementation(function (
        predicate: (value: unknown, index: number, array: unknown[]) => unknown,
        thisArg?: unknown,
      ) {
        return originalSome.call(this, (value, index, array) => {
          candidateReads += 1;
          return predicate.call(thisArg, value, index, array);
        });
      });
      const files = Array.from({ length: fileCount }, (_, index) => {
        const filePath = `src/file-${String(index).padStart(4, '0')}.ts`;
        return {
          filePath,
          previousFilePath: index === 0
            ? null
            : `src/file-${String(index - 1).padStart(4, '0')}.ts`,
          changeKind: index === 0 ? 'modified' as const : 'renamed' as const,
          source: 'scm_checkpoint' as const,
          confidence: 'exact' as const,
          provider: 'scm:git',
        };
      });

      try {
        const result = mergeTurnChangeSets({
          sessionId: 'session-1',
          turns: [makeTurn(files)],
        });
        expect(result.files).toHaveLength(1);
        expect(result.files[0]?.filePath).toBe(`src/file-${String(fileCount - 1).padStart(4, '0')}.ts`);
        return candidateReads;
      } finally {
        someSpy.mockRestore();
      }
    };

    const smallCandidateReads = countPendingCandidateReads(128);
    const doubledCandidateReads = countPendingCandidateReads(256);

    // Doubling input must not approach the 4x candidate growth of a nested
    // pending-array scan. Linear dependency traversal performs no such scan.
    expect(doubledCandidateReads).toBeLessThan(Math.max(1, smallCandidateReads * 3));
  });

  it('keeps the weakest chronological attribution even when a later write is provider-correlated', () => {
    const result = mergeTurnChangeSets({
      sessionId: 'session-1',
      turns: [
        makeTurn([CHECKPOINT_FILE], {
          repositoryCheckpoint: makeCheckpointMetadata('shared_worktree'),
        }),
        makeTurn([{
          ...CHECKPOINT_FILE,
          source: 'provider_tool',
          confidence: 'strong',
          provider: 'codex',
          agentTurnId: 'provider-turn-2',
          oldText: 'middle',
          newText: 'latest',
        }], { turnId: 'turn-2' }),
      ],
    });

    expect(result.files[0]).toMatchObject({
      source: 'provider_tool',
      attribution: {
        confidence: 'session_possible',
        reason: 'checkpoint_overlap_observed',
      },
      checkpointOverlap: 'observed',
    });
  });

  it('keeps unknown overlap when another contributing turn only observed no Happier overlap', () => {
    const result = mergeTurnChangeSets({
      sessionId: 'session-1',
      turns: [
        makeTurn([CHECKPOINT_FILE], {
          repositoryCheckpoint: makeCheckpointMetadata('unknown'),
        }),
        makeTurn([CHECKPOINT_FILE], {
          turnId: 'turn-2',
          repositoryCheckpoint: makeCheckpointMetadata('no_happier_checkpoint_overlap_observed'),
        }),
      ],
    });

    expect(result.files[0]).toMatchObject({
      checkpointOverlap: 'unknown',
      attribution: { confidence: 'unknown', reason: 'unavailable' },
    });
    expect(result.confidenceSummary.checkpointOverlap).toBe('unknown');
  });

  it('selects provider and correlation metadata deterministically with the winning attribution evidence', () => {
    const alpha = {
      filePath: 'src/shared.ts',
      changeKind: 'modified',
      source: 'provider_tool',
      confidence: 'strong',
      provider: 'alpha',
      agentTurnId: 'turn-alpha',
      providerMessageId: 'message-alpha',
    } as const;
    const zeta = {
      ...alpha,
      provider: 'zeta',
      agentTurnId: 'turn-zeta',
      providerMessageId: 'message-zeta',
    } as const;

    const forward = mergeTurnChangeSets({ sessionId: 'session-1', turns: [makeTurn([zeta, alpha])] });
    const reverse = mergeTurnChangeSets({ sessionId: 'session-1', turns: [makeTurn([alpha, zeta])] });

    for (const result of [forward, reverse]) {
      expect(result.files[0]).toMatchObject({
        provider: 'alpha',
        agentTurnId: 'turn-alpha',
        providerMessageId: 'message-alpha',
        attribution: { confidence: 'session_exact', reason: 'provider_correlated' },
      });
    }
  });

  it('reports unavailable summary evidence for an empty change set', () => {
    const result = mergeTurnChangeSets({ sessionId: 'session-1', turns: [] });

    expect(result.confidenceSummary).toEqual({
      source: 'unavailable',
      confidence: 'unavailable',
      attribution: { confidence: 'unknown', reason: 'unavailable' },
      checkpointOverlap: 'unknown',
    });
  });

  it('normalizes a supported predecessor Session change set without fabricating checkpoint evidence', () => {
    const parsed = SessionChangeSetSchema.parse({
      sessionId: 'session-1',
      turns: [makeTurn([{
        filePath: 'src/a.ts',
        changeKind: 'modified',
        source: 'provider_native',
        confidence: 'strong',
        provider: 'codex',
        providerTurnId: 'provider-turn-1',
      }])],
      files: [{
        filePath: 'src/a.ts',
        changeKind: 'modified',
        source: 'provider_native',
        confidence: 'strong',
        provider: 'codex',
        providerTurnId: 'provider-turn-1',
        turns: ['turn-1'],
      }],
      rolledBackTurnIds: [],
      confidenceSummary: { source: 'provider_native', confidence: 'strong' },
    });

    expect(parsed.files[0]).toMatchObject({
      agentTurnId: 'provider-turn-1',
      attribution: { confidence: 'session_exact', reason: 'provider_correlated' },
      checkpointOverlap: 'unknown',
    });
    expect(parsed.confidenceSummary).toMatchObject({
      source: 'provider_native',
      confidence: 'strong',
      attribution: { confidence: 'session_exact', reason: 'provider_correlated' },
      checkpointOverlap: 'unknown',
    });
  });

  it('normalizes a supported predecessor empty summary to explicit unavailable evidence', () => {
    const parsed = SessionChangeSetSchema.parse({
      sessionId: 'session-1',
      turns: [],
      files: [],
      rolledBackTurnIds: [],
      confidenceSummary: { source: 'provider_native', confidence: 'exact' },
    });

    expect(parsed.confidenceSummary).toEqual({
      source: 'unavailable',
      confidence: 'unavailable',
      attribution: { confidence: 'unknown', reason: 'unavailable' },
      checkpointOverlap: 'unknown',
    });
  });

  it('classifies agent-reported and checkpoint Changed Files scopes at the Protocol owner', () => {
    const turn = makeTurn([
      {
        filePath: 'src/provider.ts',
        changeKind: 'modified',
        source: 'provider_tool',
        confidence: 'exact',
        provider: 'codex',
      },
      {
        ...CHECKPOINT_FILE,
        filePath: 'src/checkpoint.ts',
      },
    ], {
      repositoryCheckpoint: makeCheckpointMetadata('shared_worktree'),
    });

    const agentReported = combineChangedFilesAttribution({
      sessionId: 'session-1',
      turns: [turn],
      evidenceScope: 'agent_reported',
    });
    const checkpoint = combineChangedFilesAttribution({
      sessionId: 'session-1',
      turns: [turn],
      evidenceScope: 'checkpoint',
    });

    expect(agentReported.files).toEqual([
      expect.objectContaining({
        filePath: 'src/provider.ts',
        source: 'provider_tool',
        attribution: { confidence: 'session_exact', reason: 'provider_correlated' },
      }),
    ]);
    expect(checkpoint.files).toEqual([
      expect.objectContaining({
        filePath: 'src/checkpoint.ts',
        source: 'scm_checkpoint',
        attribution: { confidence: 'session_possible', reason: 'checkpoint_overlap_observed' },
      }),
    ]);
  });
});
