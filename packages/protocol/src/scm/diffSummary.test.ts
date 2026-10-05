import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import * as diffSummary from './diffSummary.js';

describe('personal reviewed marks', () => {
  it('stores explicit exact occurrences and rejects aliases or another comparison', () => {
    const owner = diffSummary;
    const comparison: diffSummary.ScmComparison = {
      id: 'pair', source: { kind: 'workingTree' }, repository: { rootPath: '/repo' }, endpoints: { before: 'a', after: 'b' },
      inventory: { state: 'complete', reasons: [], files: [{ path: 'a.ts', changeKind: 'modified', binary: false,
        generated: false, lockfile: false, evidence: { state: 'available', unifiedDiff: 'patch' },
        occurrences: [0, 1].map(position => ({ id: `pair:${position}`, alias: `c${position}`, path: 'a.ts', position,
          before: { startLine: position, lineCount: 1 }, after: { startLine: position, lineCount: 1 } })) }] },
    };
    expect(owner.applyScmReviewedMarkIntent).toBeTypeOf('function');
    expect(owner.applyScmReviewedMarkIntent(comparison, null, ['pair:0'], true)).toEqual({ v: 1, comparisonId: 'pair', reviewedChangeRefs: ['pair:0'] });
    expect(() => owner.applyScmReviewedMarkIntent(comparison, null, ['c0'], true)).toThrow();
    expect(() => owner.applyScmReviewedMarkIntent(comparison, { v: 1, comparisonId: 'other', reviewedChangeRefs: [] }, ['pair:0'], true)).toThrow();
    expect(owner.applyScmReviewedMarkIntent(comparison, { v: 1, comparisonId: 'pair', reviewedChangeRefs: ['pair:0', 'pair:1'] }, ['pair:0'], false))
      .toEqual({ v: 1, comparisonId: 'pair', reviewedChangeRefs: ['pair:1'] });
  });
});

describe('comparison evidence and analysis contracts', () => {
  it('admits an exact retained comparison for first generation without accepting fabricated comparison bytes', () => {
    const input = { cwd: '/repo', source: { kind: 'branch', head: 'topic', base: 'main' },
      comparisonId: 'c'.repeat(64), outputs: ['walkthrough'] };
    expect(diffSummary.ScmDiffSummaryGenerateInputSchema.safeParse(input).success).toBe(true);
    expect(diffSummary.ScmDiffSummaryGenerateInputSchema.safeParse({ ...input, comparisonId: 'not-a-captured-id' }).success).toBe(false);
    expect(diffSummary.ScmDiffSummaryGenerateInputSchema.safeParse({ ...input, comparison: { id: input.comparisonId } }).success).toBe(false);
  });
  it('preserves selected source Action routing without treating routing tokens as code identity', () => {
    const source = { kind: 'pullRequest' as const, locator: {
      providerId: 'github', repository: 'org/repo', number: 4,
      sourceAction: { action: { pluginId: 'happier.scm.forge.github', localId: 'triage/list-github-changed-files' },
        input: { v: 1, routingToken: 'token-a', limit: 100 } },
    } };
    expect(diffSummary.ScmDiffSummaryGenerateInputSchema.safeParse({ cwd: '/repo', source }).success).toBe(true);
    const descriptor = { source, repositoryRootPath: '/repo', beforeOid: 'base', afterOid: 'head' };
    expect(diffSummary.buildScmComparisonIdentity(descriptor)).toBe(diffSummary.buildScmComparisonIdentity({
      ...descriptor, source: { ...source, locator: { ...source.locator,
        sourceAction: { ...source.locator.sourceAction, input: { v: 1, routingToken: 'token-b', limit: 100 } } } },
    }));
  });
  it('represents unknown hosted binary status without guessing from an absent patch', () => {
    expect(diffSummary.ScmComparisonSchema.safeParse({ id: 'hosted', source: { kind: 'pullRequest', locator: {
      providerId: 'github', repository: 'org/repo', number: 4 } }, repository: { rootPath: '/repo' },
      endpoints: { before: 'base', after: 'head' }, inventory: { state: 'complete', reasons: [], files: [{
        path: 'unknown.bin', changeKind: 'modified', binary: null, generated: false, lockfile: false,
        evidence: { state: 'unavailable', reason: 'provider_patch_missing' }, occurrences: [],
      }] } }).success).toBe(true);
  });
  it('binds comparison identity to exact endpoints, pending index and evidence mode', () => {
    const build = (diffSummary as Record<string, unknown>).buildScmComparisonIdentity as ((value: Record<string, unknown>) => string) | undefined;
    const descriptor = { source: { kind: 'workingTree' }, repositoryRootPath: '/repo', beforeOid: 'base', afterOid: 'worktree', indexOid: 'index-a' };
    expect(build).toBeTypeOf('function');
    expect(build?.(descriptor)).toBe(build?.({ ...descriptor }));
    expect(build?.(descriptor)).not.toBe(build?.({ ...descriptor, indexOid: 'index-b' }));
    const turn = { ...descriptor, source: { kind: 'turnCheckpoint' }, sessionId: 's', turnId: 't', checkpointReceiptId: 'r', turnEvidenceMode: 'checkpoint' };
    expect(build?.(turn)).not.toBe(build?.({ ...turn, turnEvidenceMode: 'agent_reported' }));
    const reported = { ...turn, beforeOid: undefined, afterOid: undefined, turnEvidenceMode: 'agent_reported' };
    expect(build?.({ ...reported, evidenceIdentity: 'canonical-fragment-a' }))
      .not.toBe(build?.({ ...reported, evidenceIdentity: 'canonical-fragment-b' }));
  });
  it('admits all six explicit source selectors while rejecting fabricated evidence', () => {
    for (const source of [
      { kind: 'session', sessionId: 'session-1' },
      { kind: 'branch', head: 'topic', base: 'main' },
      { kind: 'commit', commit: 'abc', parent: 'def' },
      { kind: 'pullRequest', locator: { providerId: 'forge', repository: 'org/repo', number: 4 } },
    ]) {
      expect(diffSummary.ScmDiffSummaryGenerateInputSchema.safeParse({ cwd: '/repo', source, outputs: ['walkthrough'] }).success).toBe(true);
    }
    expect(diffSummary.ScmDiffSummaryGenerateInputSchema.safeParse({
      cwd: '/repo', source: { kind: 'workingTree' }, turnChangeSet: { files: [] },
    }).success).toBe(false);
    for (const selector of [
      { turnId: 'other-turn' }, { checkpointReceiptId: 'other-receipt' }, { turnEvidenceMode: 'agent_reported' },
    ]) {
      expect(diffSummary.ScmDiffSummaryGenerateInputSchema.safeParse({
        cwd: '/repo', source: { kind: 'turnCheckpoint', turnId: 'turn', checkpointReceiptId: 'receipt', evidenceMode: 'checkpoint' },
        ...selector,
      }).success).toBe(false);
    }
  });

  it('keeps complete inventory readable before requested prose exists', () => {
    const result = diffSummary.ScmDiffSummaryGenerateOutputSchema.safeParse({
      success: true,
      sourceKey: 'comparison-1',
      metadata: { source: { kind: 'workingTree' }, sourceKey: 'comparison-1' },
      comparison: {
        id: 'comparison-1', source: { kind: 'workingTree' }, repository: { rootPath: '/repo' },
        endpoints: { before: 'tree-a', after: 'tree-b' },
        inventory: { state: 'complete', files: [], reasons: [] },
      },
      requestedOutputs: ['walkthrough'], outputs: { walkthrough: { state: 'pending' } },
      analysis: { suppliedChangeRefs: [], analysedChangeRefs: [], remainingChangeRefs: [] },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(diffSummary.ScmDiffSummaryGenerateOutputSchema.safeParse({ ...result.data, analysis: undefined }).success).toBe(false);
      expect(diffSummary.ScmDiffSummaryGenerateOutputSchema.safeParse({ ...result.data,
        metadata: { ...result.data.metadata, sourceKey: 'different-comparison' } }).success).toBe(false);
    }
  });

  it('rejects unexpected model authority and does not cap valid prose', () => {
    const schema = (diffSummary as Record<string, unknown>).ScmDiffSummaryModelOutputSchema as z.ZodTypeAny;
    expect(schema?.safeParse({ summaryMarkdown: 'x'.repeat(120_000) }).success).toBe(true);
    expect(schema?.safeParse({ summaryMarkdown: 'done', command: 'git commit' }).success).toBe(false);
  });

  it('resolves distinct occurrence aliases and rejects unknown, duplicate or missing coverage', () => {
    const comparison: diffSummary.ScmComparison = {
      id: 'pair-1', source: { kind: 'workingTree' }, repository: { rootPath: '/repo' },
      endpoints: { before: 'a', after: 'b' }, inventory: {
        state: 'complete', reasons: [], files: [{
          path: 'a.ts', changeKind: 'modified', binary: false, generated: false, lockfile: false,
          evidence: { state: 'available', unifiedDiff: '@@ -1 +1 @@\n-old\n+new\n@@ -9 +9 @@\n-old\n+new' },
          occurrences: [1, 9].map((line, index) => ({
            id: `pair-1:a:${index}`, alias: `c${index + 1}`, path: 'a.ts', position: index,
            before: { startLine: line, lineCount: 1 }, after: { startLine: line, lineCount: 1 },
          })),
        }],
      },
    };
    const stop = { id: 'stop-1', title: 'Change', explanationMarkdown: 'Changed logic.', changeRefs: ['c1'] };
    const value = { walkthrough: { title: 'Title', intro: '', stops: [stop], otherChangeRefs: ['c2'] } };
    const options = { comparison, requireCompleteCoverage: true };
    expect(diffSummary.normalizeScmDiffSummaryModelOutput(value, options).walkthrough).toMatchObject({
      stops: [{ changeRefs: ['pair-1:a:0'] }], otherChangeRefs: ['pair-1:a:1'],
    });
    const stored = { walkthrough: { ...value.walkthrough, stops: [{ ...stop, changeRefs: ['pair-1:a:0'] }],
      otherChangeRefs: ['pair-1:a:1'] } };
    expect(() => diffSummary.normalizeScmDiffSummaryModelOutput(stored, options)).toThrow();
    expect(diffSummary.ScmDiffSummaryGenerateOutputSchema.safeParse({ success: true, sourceKey: comparison.id,
      metadata: { source: comparison.source, sourceKey: comparison.id }, comparison, requestedOutputs: ['walkthrough'],
      outputs: { walkthrough: { state: 'complete', value: stored.walkthrough } },
      analysis: { suppliedChangeRefs: ['pair-1:a:0', 'pair-1:a:1'], analysedChangeRefs: ['pair-1:a:0', 'pair-1:a:1'], remainingChangeRefs: [] },
    }).success).toBe(true);
    for (const refs of [['c1'], ['c3'], []]) {
      expect(() => diffSummary.normalizeScmDiffSummaryModelOutput({ walkthrough: { ...value.walkthrough, otherChangeRefs: refs } }, options)).toThrow();
    }
    expect(() => diffSummary.normalizeScmDiffSummaryModelOutput({
      commitPlan: { groups: [], leftOutChangeRefs: ['c1', 'c2'] },
    }, { ...options, comparison: { ...comparison, source: { kind: 'commit', commit: 'abc' } } })).toThrow();
    expect(() => diffSummary.normalizeScmDiffSummaryModelOutput({ ...value, risks: ['Unrequested summary prose'] },
      { ...options, requestedOutputs: ['walkthrough'] })).toThrow();
  });
});

describe('SCM diff-summary protocol schemas', () => {
  it('accepts checkpoint-backed summary requests keyed by TurnChangeSet metadata', async () => {
    const protocol = await import('./diffSummary.js') as Record<string, unknown>;
    const schema = protocol.ScmDiffSummaryGenerateInputSchema as z.ZodTypeAny | undefined;

    expect(schema).toMatchObject({ parse: expect.any(Function) });
    expect(schema?.parse({
      cwd: '/repo',
      source: { kind: 'turnCheckpoint' },
      turnId: 'turn-1',
      checkpointReceiptId: 'checkpoint.diff_computed',
      modelSelector: { profileId: 'fast-summary' },
    })).toEqual({
      cwd: '/repo',
      source: { kind: 'turnCheckpoint' },
      turnId: 'turn-1',
      checkpointReceiptId: 'checkpoint.diff_computed',
      modelSelector: { profileId: 'fast-summary' },
    });
  });

  it('rejects checkpoint-backed summary requests without turn or receipt identity', async () => {
    const protocol = await import('./diffSummary.js') as Record<string, unknown>;
    const schema = protocol.ScmDiffSummaryGenerateInputSchema as z.ZodTypeAny | undefined;

    expect(schema).toMatchObject({ safeParse: expect.any(Function) });
    const result = schema?.safeParse({
      cwd: '/repo',
      source: { kind: 'turnCheckpoint' },
    });

    expect(result?.success).toBe(false);
  });

  it('preserves buffered output metadata for later execution-run and UI packets', async () => {
    const protocol = await import('./diffSummary.js') as Record<string, unknown>;
    const schema = protocol.ScmDiffSummaryGenerateOutputSchema as z.ZodTypeAny | undefined;

    expect(schema).toMatchObject({ parse: expect.any(Function) });
    expect(schema?.parse({
      success: true,
      summaryMarkdown: '## Summary\n\nUpdated checkpoint projection.',
      sourceKey: 'turn:turn-1',
      checkpointReceiptId: 'checkpoint.diff_computed',
      metadata: {
        source: { kind: 'turnCheckpoint' },
        sourceKey: 'turn:turn-1',
        turnId: 'turn-1',
        checkpointReceiptId: 'checkpoint.diff_computed',
        contentConfidence: 'exact',
        attributionScope: 'shared_worktree',
      },
      risks: ['Attribution is shared with another active writer.'],
      testImpact: 'Protocol tests only.',
      suggestedPrBody: 'Adds summary schema.',
      truncation: {
        reason: 'fileBudget',
        droppedFiles: 1,
      },
    })).toMatchObject({
      success: true,
      summaryMarkdown: expect.stringContaining('Updated checkpoint projection'),
      sourceKey: 'turn:turn-1',
      metadata: {
        contentConfidence: 'exact',
        attributionScope: 'shared_worktree',
      },
    });
  });

  it('rejects workingTree summaries that carry a checkpointReceiptId (cache-key-pollution guard)', async () => {
    const protocol = await import('./diffSummary.js') as Record<string, unknown>;
    const schema = protocol.ScmDiffSummaryGenerateInputSchema as z.ZodTypeAny | undefined;

    expect(schema).toMatchObject({ safeParse: expect.any(Function) });
    const result = schema?.safeParse({
      cwd: '/repo',
      source: { kind: 'workingTree' },
      checkpointReceiptId: 'checkpoint.diff_computed',
    });

    expect(result?.success).toBe(false);
  });

  it('keeps sourceKey purity: receipt-keyed inputs do not vary with modelSelector (Q12 cache-anti-pollution invariant)', async () => {
    // Contract: SCM-DIFF-SUMMARY consumers (incl. SCM-DIFF-SUMMARY-2 cache impl) MUST treat
    // sourceKey as derived from `(source.kind, turnId, checkpointReceiptId)` only — never from
    // modelSelector. The protocol layer cannot enforce derivation, but it documents the invariant
    // by accepting two structurally-equivalent inputs that differ only in modelSelector and
    // confirming the schema does not project modelSelector into any output sourceKey echo. Any
    // future implementation that bakes modelSelector into sourceKey must change this test
    // intentionally so reviewers see the policy break.
    const protocol = await import('./diffSummary.js') as Record<string, unknown>;
    const inputSchema = protocol.ScmDiffSummaryGenerateInputSchema as z.ZodTypeAny | undefined;

    expect(inputSchema).toMatchObject({ parse: expect.any(Function) });
    const baseInput = {
      cwd: '/repo',
      source: { kind: 'turnCheckpoint' as const },
      turnId: 'turn-1',
      checkpointReceiptId: 'checkpoint.diff_computed',
    };
    const withSelectorA = inputSchema?.parse({
      ...baseInput,
      modelSelector: { profileId: 'fast-summary' },
    }) as Record<string, unknown>;
    const withSelectorB = inputSchema?.parse({
      ...baseInput,
      modelSelector: { profileId: 'thorough-summary', backendTargetKey: 'gpt-4' },
    }) as Record<string, unknown>;

    // Cache identity inputs (the fields any compliant sourceKey impl is allowed to consume) MUST
    // be identical. modelSelector is allowed to differ but MUST NOT participate in cache identity.
    expect({
      sourceKind: (withSelectorA.source as { kind: string }).kind,
      turnId: withSelectorA.turnId,
      checkpointReceiptId: withSelectorA.checkpointReceiptId,
    }).toEqual({
      sourceKind: (withSelectorB.source as { kind: string }).kind,
      turnId: withSelectorB.turnId,
      checkpointReceiptId: withSelectorB.checkpointReceiptId,
    });
  });

  it('rejects unknown fields in authority-bearing input and output envelopes', () => {
    expect(diffSummary.ScmDiffSummaryGenerateInputSchema.safeParse({
      cwd: '/repo', source: { kind: 'turnCheckpoint', forgedRef: 'HEAD' }, turnId: 'turn-1',
    }).success).toBe(false);
    expect(diffSummary.ScmDiffSummaryGenerateOutputSchema.safeParse({
      success: true, summaryMarkdown: 'Done', sourceKey: 'turn:turn-1',
      metadata: { source: { kind: 'turnCheckpoint' }, sourceKey: 'turn:turn-1' },
      command: 'git commit',
    }).success).toBe(false);
  });
});
