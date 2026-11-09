import { describe, expect, it } from 'vitest';
import { renderWorkerUpdatePromptBlockV1 } from '@happier-dev/protocol/sessions/messages/sessionInputPromptContextV1';

import {
  applySessionFollowContextBudgetV1,
  measureSessionFollowUtf8Bytes,
  resolveSessionFollowContextUtf8AllowanceV1,
} from './sessionFollowContextBudget';

function candidate(input: Readonly<{
  sourceSessionId: string;
  sourceRecencyMs: number;
  actionableAttention?: boolean;
  recentMessages: readonly Readonly<{ seq: number; text: string }>[];
  renderedOverhead?: string;
  messageSelection?: 'oldest_pending_prefix' | 'latest_current_suffix';
}>) {
  return {
    ...input,
    actionableAttention: input.actionableAttention ?? false,
    truncated: false,
    render: ({ keptMessageSeqs, truncated }: Readonly<{ keptMessageSeqs: readonly number[]; truncated: boolean }>) => [
      input.renderedOverhead ?? '',
      ...input.recentMessages.filter((message) => keptMessageSeqs.includes(message.seq)).map((message) => message.text),
      truncated ? 'truncated' : '',
    ].join(''),
  };
}

describe('Session Follow UTF-8 budget', () => {
  it('keeps complete Follow originals when current usage evidence is unavailable', () => {
    const allowance = resolveSessionFollowContextUtf8AllowanceV1({
      requiredPrompt: 'the admitted user input always wins',
      activeModelId: 'claude-sonnet-4-6',
      contextUsage: null,
    });
    const decision = applySessionFollowContextBudgetV1({
      candidates: [candidate({ sourceSessionId: 'source', sourceRecencyMs: 1,
        recentMessages: [{ seq: 1, text: 'Full original'.repeat(1_000) }] })],
      maxUtf8Bytes: allowance.maxUtf8Bytes,
    });
    expect(decision.keptBySource.get('source')).toEqual([1]);
    expect(decision.truncatedBySource.size).toBe(0);
    expect(decision.omittedSources).toEqual([]);
  });

  it('derives conservative remaining capacity only from matching authoritative provider usage', () => {
    expect(resolveSessionFollowContextUtf8AllowanceV1({
      requiredPrompt: 'four',
      activeModelId: 'model-a',
      contextUsage: {
        v: 1,
        modelId: 'model-a',
        usedTokens: 90,
        windowTokens: 100,
        totalProcessedTokens: null,
        baselineTokens: null,
        isAutoCompactEnabled: null,
        categories: null,
        observedAtMs: 1,
        source: 'provider_live',
      },
    })).toEqual({ maxUtf8Bytes: 6, basis: 'authoritative_remaining' });

    expect(resolveSessionFollowContextUtf8AllowanceV1({
      requiredPrompt: 'four',
      activeModelId: 'model-b',
      contextUsage: {
        v: 1,
        modelId: 'model-a',
        usedTokens: 90,
        windowTokens: 100,
        totalProcessedTokens: null,
        baselineTokens: null,
        isAutoCompactEnabled: null,
        categories: null,
        observedAtMs: 1,
        source: 'provider_live',
      },
    })).toEqual({
      maxUtf8Bytes: Number.POSITIVE_INFINITY,
      basis: 'unknown_window',
    });
  });

  it('measures multibyte sequences exactly and never splits them', () => {
    expect(measureSessionFollowUtf8Bytes('a')).toBe(1);
    expect(measureSessionFollowUtf8Bytes('é')).toBe(2);
    expect(measureSessionFollowUtf8Bytes('😀')).toBe(4);
  });

  it('admits no optional Follow context when no authoritative allowance is available', () => {
    const decision = applySessionFollowContextBudgetV1({
      candidates: [candidate({ sourceSessionId: 'a', sourceRecencyMs: 1, recentMessages: [{ seq: 1, text: 'a' }] })],
      maxUtf8Bytes: null,
    });
    expect(decision.omittedSources).toEqual(['a']);
    expect(decision.keptBySource.size).toBe(0);
  });

  it('keeps an older fitting prefix while deferring an overlarge newer message, then admits later sources', () => {
    const decision = applySessionFollowContextBudgetV1({
      candidates: [
        candidate({
          sourceSessionId: 'a',
          sourceRecencyMs: 10,
          recentMessages: [
            { seq: 8, text: 'old' },
            { seq: 9, text: 'x'.repeat(9_000) },
          ],
        }),
        candidate({
          sourceSessionId: 'b',
          sourceRecencyMs: 9,
          recentMessages: [{ seq: 9, text: 'small' }],
        }),
      ],
      maxUtf8Bytes: 8_192,
    });
    expect(decision.omittedSources).toEqual([]);
    expect(decision.keptBySource.get('a')).toEqual([8]);
    expect(decision.keptBySource.get('b')).toEqual([9]);
    expect(decision.truncatedBySource.get('a')).toBe(true);
  });

  it('keeps the oldest contiguous complete prefix when only part of a source fits', () => {
    const decision = applySessionFollowContextBudgetV1({
      candidates: [candidate({
        sourceSessionId: 'source',
        sourceRecencyMs: 1,
        recentMessages: [
          { seq: 2, text: 'old'.repeat(4) },
          { seq: 3, text: 'newer'.repeat(2) },
          { seq: 4, text: 'latest' },
        ],
      })],
      maxUtf8Bytes: 25,
    });

    expect(decision.keptBySource.get('source')).toEqual([2]);
    expect(decision.truncatedBySource.get('source')).toBe(true);
  });

  it('defers later originals of the same source after one original exceeds the remaining allowance', () => {
    const originals = [
      { seq: 7, text: 'Quiet' },
      { seq: 8, text: 'a'.repeat(2479) },
      { seq: 9, text: 'b'.repeat(2479) },
      { seq: 10, text: 'Report A: artifact reference' },
      { seq: 11, text: 'Report B' },
    ];
    const candidates = originals.map(message => ({
      ...candidate({ sourceSessionId: 'worker', sourceRecencyMs: 1, recentMessages: [message] }),
      candidateId: `original-${message.seq}`, sourceOriginalSeq: message.seq,
    }));
    const decision = applySessionFollowContextBudgetV1({
      candidates: [...candidates, candidate({ sourceSessionId: 'other-worker', sourceRecencyMs: 0,
        recentMessages: [{ seq: 1, text: 'Other worker' }] })],
      maxUtf8Bytes: 4096,
    });
    expect([...decision.keptBySource.keys()]).toEqual(['original-7', 'original-8', 'original-9', 'other-worker']);
    // The partial candidate represents no original at seq 9. A shorter later
    // report must not consume its place, even when that report would fit.
    expect(decision.keptBySource.get('original-9')).toEqual([]);
    expect(decision.omittedSources).toEqual(['original-10', 'original-11']);
    const recovered = applySessionFollowContextBudgetV1({ candidates: candidates.slice(2), maxUtf8Bytes: 4096 });
    expect([...recovered.keptBySource.keys()]).toEqual(['original-9', 'original-10', 'original-11']);
    expect(recovered.omittedSources).toEqual([]);
    // Published WorkerUpdates have no snippet rows to shrink. Exercise the
    // complete-block omission arm as well as the partial transcript arm above.
    const reports = candidates.map((entry, index) => ({ ...entry, recentMessages: [],
      render: () => renderWorkerUpdatePromptBlockV1({ v: 1, workerKind: 'session', workerId: 'worker',
        ownerState: 'published', wake: 'published', headline: 'Worker report', result: originals[index]!.text,
        transcriptPointer: { kind: 'session', sessionId: 'worker', seq: originals[index]!.seq }, canInspect: true }),
    }));
    const reportDecision = applySessionFollowContextBudgetV1({ candidates: reports, maxUtf8Bytes: 4096 });
    expect([...reportDecision.keptBySource.keys()]).toEqual(['original-7', 'original-8']);
    expect(reportDecision.omittedSources).toEqual(['original-9', 'original-10', 'original-11']);
  });

  it('keeps the latest contiguous complete suffix for a current snapshot', () => {
    const decision = applySessionFollowContextBudgetV1({
      candidates: [candidate({
        sourceSessionId: 'source',
        sourceRecencyMs: 1,
        messageSelection: 'latest_current_suffix',
        recentMessages: [
          { seq: 598, text: 'old'.repeat(4) },
          { seq: 599, text: 'newer'.repeat(2) },
          { seq: 600, text: 'latest' },
        ],
      })],
      maxUtf8Bytes: 25,
    });

    expect(decision.keptBySource.get('source')).toEqual([599, 600]);
    expect(decision.truncatedBySource.get('source')).toBe(true);
  });

  it('orders actionable attention before recency and sourceSessionId', () => {
    const decision = applySessionFollowContextBudgetV1({
      candidates: [
        candidate({ sourceSessionId: 'newer', sourceRecencyMs: 9, recentMessages: [{ seq: 9, text: 'n' }] }),
        candidate({ sourceSessionId: 'b', sourceRecencyMs: 5, actionableAttention: true, recentMessages: [{ seq: 5, text: 'b' }] }),
        candidate({ sourceSessionId: 'a', sourceRecencyMs: 5, actionableAttention: true, recentMessages: [{ seq: 5, text: 'a' }] }),
      ],
      maxUtf8Bytes: 1,
    });
    // Only one byte fits: actionable sources beat a newer ordinary source, then `a` wins the tie.
    expect(decision.keptBySource.has('a')).toBe(true);
    expect(decision.omittedSources).toEqual(['b', 'newer']);

    const allFit = applySessionFollowContextBudgetV1({
      candidates: [
        candidate({ sourceSessionId: 'newer', sourceRecencyMs: 9, recentMessages: [{ seq: 9, text: 'n' }] }),
        candidate({ sourceSessionId: 'actionable', sourceRecencyMs: 1, actionableAttention: true, recentMessages: [{ seq: 1, text: 'a' }] }),
      ],
      maxUtf8Bytes: 100,
    });
    expect([...allFit.keptBySource.keys()]).toEqual(['actionable', 'newer']);
  });

  it('charges the fully rendered Follow block, including awareness and framing overhead', () => {
    const decision = applySessionFollowContextBudgetV1({
      candidates: [candidate({
        sourceSessionId: 'a',
        sourceRecencyMs: 1,
        recentMessages: [{ seq: 1, text: 'x' }],
        renderedOverhead: '1234567890',
      })],
      maxUtf8Bytes: 10,
    });
    expect(decision.omittedSources).toEqual(['a']);
    expect(decision.keptBySource.size).toBe(0);
  });
});
