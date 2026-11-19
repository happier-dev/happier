import { describe, expect, it } from 'vitest';
import { createActionExecutor as createCoreActionExecutor, type ActionExecutorDeps } from './actionExecutor';
import { createInMemoryReviewRecordPortV1 } from '../reviews/reviewArtifactV1.testkit';
import { WorkflowRunStartRequestV1Schema } from '../workflows/actionsV1';

function createActionExecutor(deps: ActionExecutorDeps) {
  const records = createInMemoryReviewRecordPortV1();
  return createCoreActionExecutor({ reviewRecords: () => records, ...deps });
}

// Already admitted native leaves keep this test at the source-read owner;
// mixed Workflow composition has its own entry-point acceptance tests.
const reviewRound = { reviewId: 'transcript-review', roundOrdinal: 1 };
const engine = (engineId: string) => ({ value: engineId, engineId, label: engineId, enabled: true,
  capabilities: { structuredNarration: true, sessionTranscript: true } });

describe('review.start selected source transcript', () => {

  it('reads once at admission and supplies ordinary input to engine and Session Workflow reviewers', async () => {
    let reads = 0;
    let request: unknown;
    const executor = createActionExecutor({
      sessionTranscriptGet: async ({ sessionId }) => { reads++; return { ok: true, sessionId, items: [{ id: 'm1', createdAt: 1, semanticRole: 'assistant', role: 'assistant', kind: 'text', text: 'The test command was skipped.' }], nextCursor: null, hasMore: false, diagnostics: { rawRowsScanned: 1, pagesFetched: 1, scanLimitReached: false, payloadTruncations: 0 } }; },
      reviewEnginesList: async () => ({ items: [engine('codex')] }),
      workflowAction: async invocation => {
        if (invocation.actionId !== 'workflow.run.start') throw new Error('Unexpected Workflow operation');
        request = invocation.input;
        return { ok: false, errorCode: 'content_unavailable', error: 'content_unavailable' };
      },
    });
    const reviewer = { kind: 'engine', engineId: 'codex', includeSessionTranscript: true };
    const sourceSession = { serverId: 'home', sessionId: 'source' };
    expect(await executor.execute('review.start', { sessionId: 'review-session', scope: 'repository', instructions: 'Review.',
      sourceSession, reviewers: [reviewer, { kind: 'session', session: { serverId: 'home', sessionId: 'other-reviewer' }, includeSessionTranscript: true }] },
    { surface: 'ui', serverId: 'home' })).toMatchObject({ ok: false, errorCode: 'content_unavailable' });
    expect(reads).toBe(1);
    const admitted = WorkflowRunStartRequestV1Schema.parse(request);
    if (admitted.source.kind !== 'inline') throw new Error('Expected an inline Review Workflow');
    const stage = admitted.source.definition.blocks.find(block => block.kind === 'parallel');
    if (stage?.kind !== 'parallel') throw new Error('Expected the mixed Review stage');
    expect(JSON.stringify(stage.branches[0])).toContain('The test command was skipped.');
    expect(JSON.stringify(stage.branches[1])).toContain('The test command was skipped.');
    expect(JSON.stringify(stage.branches[0])).not.toContain('includeSessionTranscript');
  });

  it('reads no source by default and delivers selected source as ordinary Run instructions', async () => {
    const starts: Array<{ input: unknown; options: unknown }> = [];
    let reads = 0;
    const executor = createActionExecutor({
      reviewEnginesList: async () => ({ items: [engine('codex'), engine('claude')] }),
      sessionTranscriptGet: async ({ sessionId, cursor }) => {
        reads++;
        return { ok: true, sessionId, items: [{ id: cursor ? 'm2' : 'm1', createdAt: 1,
          semanticRole: 'assistant', role: 'assistant', kind: 'text',
          text: cursor ? 'The test command was skipped.' : 'All tests passed.' }],
          nextCursor: cursor ? null : '1', hasMore: !cursor,
          diagnostics: { rawRowsScanned: 1, pagesFetched: 1, scanLimitReached: false, payloadTruncations: 0 } };
      },
      executionRunStart: async (_sessionId, input, options) => {
        starts.push({ input, options });
        return { runId: 'run', callId: 'call', sidechainId: 'call' };
      },
    } as ActionExecutorDeps);
    const input = { sessionId: 'review-session', reviewers: [{ kind: 'engine', engineId: 'codex' }], reviewRound, instructions: 'Review the changes.',
      sourceSession: { serverId: 'home', sessionId: 'source' } };
    expect(await executor.execute('review.start', input, { surface: 'ui', serverId: 'home' })).toMatchObject({ ok: true });
    expect(reads).toBe(0);
    expect(await executor.execute('review.start', { ...input, reviewers: [
      { kind: 'engine', engineId: 'codex', includeSessionTranscript: true },
      { kind: 'engine', engineId: 'claude', includeSessionTranscript: true },
    ] },
      { surface: 'ui', serverId: 'home' })).toMatchObject({ ok: true });
    expect(reads).toBe(2);
    expect(starts[1]?.input).toMatchObject({ instructions: expect.stringContaining('All tests passed.') });
    expect(starts[2]?.input).toMatchObject({ instructions: expect.stringContaining('The test command was skipped.') });
    expect(starts).toHaveLength(3);
  });

  it('returns the source reader denial without starting a reviewer', async () => {
    let starts = 0;
    const executor = createActionExecutor({
      reviewEnginesList: async () => ({ items: [engine('codex')] }),
      sessionTranscriptGet: async () => ({ ok: false, errorCode: 'permission_denied', errorMessage: 'permission_denied' }),
      executionRunStart: async () => { starts++; return {}; },
    } as ActionExecutorDeps);
    expect(await executor.execute('review.start', { sessionId: 'review-session', reviewRound,
      reviewers: [{ kind: 'engine', engineId: 'codex', includeSessionTranscript: true }], instructions: 'Review.',
      sourceSession: { serverId: 'home', sessionId: 'denied-source' } },
    { surface: 'ui', serverId: 'home' })).toMatchObject({ ok: false, errorCode: 'permission_denied' });
    expect(starts).toBe(0);
  });

  it.each(['direct', 'mixed', 'steps'] as const)('refuses an unsupported transcript profile at %s admission before reading the source', async route => {
    let reads = 0;
    let starts = 0;
    let workflowStarts = 0;
    let supportsTranscript = true;
    const profileSourceCustody = { kind: 'managed', immutableGenerationId: 'native-cli-review', installSource: 'archive' } as const;
    const executor = createActionExecutor({
      reviewEnginesList: async () => ({
        items: [{ ...engine('codex'), profileId: 'generic-review' }],
        selectionItems: [{ ...engine('codex'), label: 'Native CLI review', profileId: 'native-cli-review',
          capabilities: { structuredNarration: false, sessionTranscript: supportsTranscript } }],
      }),
      sessionTranscriptGet: async ({ sessionId }) => { reads++; return { ok: true, sessionId, items: [],
        nextCursor: null, hasMore: false,
        diagnostics: { rawRowsScanned: 0, pagesFetched: 1, scanLimitReached: false, payloadTruncations: 0 } }; },
      executionRunStart: async () => { starts++; return { runId: 'run' }; },
      workflowAction: async () => { workflowStarts++; return { ok: false, errorCode: 'content_unavailable', error: 'content_unavailable' }; },
    });
    const reviewer = { kind: 'engine', engineId: 'codex', profileId: 'native-cli-review', profileSourceCustody, includeSessionTranscript: true } as const;
    const session = { kind: 'session', session: { serverId: 'home', sessionId: 'other-reviewer' } } as const;
    const input = { sessionId: 'review-session', scope: 'repository', instructions: 'Review.',
      sourceSession: { serverId: 'home', sessionId: 'source' },
      reviewers: route === 'mixed' ? [reviewer, session] : [reviewer],
      ...(route === 'direct' ? { reviewRound } : route === 'steps'
        ? { steps: [{ kind: 'review', reviewers: [reviewer], instructions: 'Review.' }] } : {}),
    };
    expect(await executor.execute('review.start', input, { surface: 'ui', serverId: 'home' }))
      .toMatchObject(route === 'direct' ? { ok: true } : { ok: false, errorCode: 'content_unavailable' });
    expect(reads).toBe(1);
    expect(starts + workflowStarts).toBe(1);
    supportsTranscript = false;
    reads = 0;
    starts = 0;
    workflowStarts = 0;
    expect(await executor.execute('review.start', input, { surface: 'ui', serverId: 'home' }))
      .toMatchObject({ ok: false, errorCode: 'review_transcript_unsupported' });
    expect(reads).toBe(0);
    expect(starts + workflowStarts).toBe(0);
  });

  it('preserves incomplete reader coverage instead of silently claiming a full source', async () => {
    let instructions: unknown;
    const executor = createActionExecutor({
      reviewEnginesList: async () => ({ items: [engine('codex')] }),
      sessionTranscriptGet: async ({ sessionId }) => ({ ok: true, sessionId,
        items: [{ id: 'm1', createdAt: 1, semanticRole: 'assistant', role: 'assistant', kind: 'text', text: 'Truncated', truncated: true }],
        hasMore: false, nextCursor: null,
        diagnostics: { rawRowsScanned: 1, pagesFetched: 1, scanLimitReached: true, payloadTruncations: 1 } }),
      executionRunStart: async (_sessionId, input) => { instructions = input.instructions; return { runId: 'run' }; },
    } as ActionExecutorDeps);
    expect(await executor.execute('review.start', { sessionId: 'review-session', reviewRound,
      reviewers: [{ kind: 'engine', engineId: 'codex', includeSessionTranscript: true }], instructions: 'Review.',
      sourceSession: { serverId: 'home', sessionId: 'source' } },
    { surface: 'ui', serverId: 'home' })).toMatchObject({ ok: true });
    expect(instructions).toEqual(expect.stringContaining('partial'));
  });

  it('reads once for a mixed roster and supplies evidence only to the selected reviewer', async () => {
    let reads = 0;
    const starts: Array<{ input: unknown; options: unknown }> = [];
    const executor = createActionExecutor({
      reviewEnginesList: async () => ({ items: [engine('codex'), engine('claude')] }),
      sessionTranscriptGet: async ({ sessionId }) => {
        reads++;
        return { ok: true, sessionId, items: [], nextCursor: null, hasMore: false,
          diagnostics: { rawRowsScanned: 0, pagesFetched: 1, scanLimitReached: false, payloadTruncations: 0 } };
      },
      executionRunStart: async (_sessionId, input, options) => {
        starts.push({ input, options });
        return { runId: 'run', callId: 'call', sidechainId: 'call' };
      },
    } as ActionExecutorDeps);
    expect(await executor.execute('review.start', { sessionId: 'review-session', reviewRound,
      reviewers: [{ kind: 'engine', engineId: 'codex', includeSessionTranscript: true },
        { kind: 'engine', engineId: 'claude' }], instructions: 'Review.',
      sourceSession: { serverId: 'home', sessionId: 'source' } },
    { surface: 'ui', serverId: 'home' })).toMatchObject({ ok: true });
    expect(reads).toBe(1);
    expect(starts[0]?.input).toMatchObject({ instructions: expect.stringContaining('Session transcript') });
    expect(starts[1]?.input).toMatchObject({ instructions: 'Review.' });
  });
});
