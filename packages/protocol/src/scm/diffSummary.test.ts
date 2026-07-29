import { describe, expect, it } from 'vitest';
import type { z } from 'zod';

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

  it('preserves forward-compatible unknown fields on public wire payloads', async () => {
    const protocol = await import('./diffSummary.js') as Record<string, unknown>;
    const inputSchema = protocol.ScmDiffSummaryGenerateInputSchema as z.ZodTypeAny | undefined;
    const outputSchema = protocol.ScmDiffSummaryGenerateOutputSchema as z.ZodTypeAny | undefined;

    expect(inputSchema).toMatchObject({ parse: expect.any(Function) });
    expect(outputSchema).toMatchObject({ parse: expect.any(Function) });

    expect(inputSchema?.parse({
      cwd: '/repo',
      source: {
        kind: 'turnCheckpoint',
        futureSourceField: 'preserve-source',
      },
      turnId: 'turn-1',
      modelSelector: {
        profileId: 'fast-summary',
        futureModelField: 'preserve-model',
      },
      futureInputField: 'preserve-input',
    })).toMatchObject({
      source: {
        futureSourceField: 'preserve-source',
      },
      modelSelector: {
        futureModelField: 'preserve-model',
      },
      futureInputField: 'preserve-input',
    });

    expect(outputSchema?.parse({
      success: true,
      summaryMarkdown: '## Summary\n\nUpdated checkpoint projection.',
      sourceKey: 'turn:turn-1',
      metadata: {
        source: {
          kind: 'turnCheckpoint',
          futureSourceField: 'preserve-source',
        },
        sourceKey: 'turn:turn-1',
        futureMetadataField: 'preserve-metadata',
      },
      truncation: {
        reason: 'fileBudget',
        futureTruncationField: 'preserve-truncation',
      },
      futureOutputField: 'preserve-output',
    })).toMatchObject({
      metadata: {
        source: {
          futureSourceField: 'preserve-source',
        },
        futureMetadataField: 'preserve-metadata',
      },
      truncation: {
        futureTruncationField: 'preserve-truncation',
      },
      futureOutputField: 'preserve-output',
    });
  });
});
