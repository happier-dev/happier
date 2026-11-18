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
  it('defers source admission to concrete reviewer leaves of a mixed Workflow', async () => {
    let reads = 0;
    let request: unknown;
    const executor = createActionExecutor({
      sessionTranscriptGet: async () => { reads++; throw new Error('Only the concrete reviewer reads the source'); },
      reviewEnginesList: async () => { throw new Error('Only the concrete reviewer resolves its engine'); },
      workflowAction: async invocation => {
        if (invocation.actionId !== 'workflow.run.start') throw new Error('Unexpected Workflow operation');
        request = invocation.input;
        return { ok: false, errorCode: 'content_unavailable', error: 'content_unavailable' };
      },
    });
    const reviewer = { kind: 'engine', engineId: 'codex', includeSessionTranscript: true };
    const sourceSession = { serverId: 'home', sessionId: 'source' };
    expect(await executor.execute('review.start', { sessionId: 'review-session', instructions: 'Review.',
      sourceSession, reviewers: [reviewer, { kind: 'session', session: { serverId: 'home', sessionId: 'other-reviewer' } }] },
    { surface: 'ui', serverId: 'home' })).toMatchObject({ ok: false, errorCode: 'content_unavailable' });
    expect(reads).toBe(0);
    const admitted = WorkflowRunStartRequestV1Schema.parse(request);
    if (admitted.source.kind !== 'inline') throw new Error('Expected an inline Review Workflow');
    const stage = admitted.source.definition.blocks.find(block => block.kind === 'parallel');
    if (stage?.kind !== 'parallel') throw new Error('Expected the mixed Review stage');
    expect(stage.branches[0]?.blocks[0]).toMatchObject({ kind: 'action', actionId: 'review.start', input: {
      reviewers: { kind: 'literal', value: [reviewer] }, sourceSession: { kind: 'literal', value: sourceSession },
    } });
  });

  it('reads no source by default and keeps selected source evidence outside the Run input', async () => {
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
    expect(starts[1]?.options).toMatchObject({ reviewTranscriptEvidence: { coverage: 'complete',
      sourceSession: input.sourceSession, items: [{ text: 'All tests passed.' }, { text: 'The test command was skipped.' }] } });
    expect(JSON.stringify(starts[1]?.input)).not.toContain('All tests passed.');
    expect(starts).toHaveLength(3);
    expect(starts[2]?.options).toMatchObject({ reviewTranscriptEvidence: { coverage: 'complete' } });
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

  it('refuses an explicitly selected profile that cannot consume transcript input before reading the source', async () => {
    let reads = 0;
    let starts = 0;
    const profileSourceCustody = { kind: 'managed', immutableGenerationId: 'native-cli-review', installSource: 'archive' } as const;
    const executor = createActionExecutor({
      reviewEnginesList: async () => ({
        items: [{ value: 'codex', engineId: 'codex', label: 'Codex', enabled: true, profileId: 'generic-review',
          capabilities: { structuredNarration: true, sessionTranscript: true } }],
        selectionItems: [{ value: 'codex', engineId: 'codex', label: 'Native CLI review', enabled: true, profileId: 'native-cli-review',
          capabilities: { structuredNarration: false, sessionTranscript: false } }],
      }),
      sessionTranscriptGet: async () => { reads++; return {}; },
      executionRunStart: async () => { starts++; return { runId: 'run' }; },
    } as ActionExecutorDeps);
    expect(await executor.execute('review.start', { sessionId: 'review-session', reviewRound,
      reviewers: [{ kind: 'engine', engineId: 'codex', profileId: 'native-cli-review', profileSourceCustody, includeSessionTranscript: true }],
      instructions: 'Review.', sourceSession: { serverId: 'home', sessionId: 'source' } },
    { surface: 'ui', serverId: 'home' })).toMatchObject({ ok: false, errorCode: 'review_transcript_unsupported' });
    expect(reads).toBe(0);
    expect(starts).toBe(0);
  });

  it('preserves incomplete reader coverage instead of silently claiming a full source', async () => {
    let evidence: unknown;
    const executor = createActionExecutor({
      reviewEnginesList: async () => ({ items: [engine('codex')] }),
      sessionTranscriptGet: async ({ sessionId }) => ({ ok: true, sessionId,
        items: [{ id: 'm1', createdAt: 1, semanticRole: 'assistant', role: 'assistant', kind: 'text', text: 'Truncated', truncated: true }],
        hasMore: false, nextCursor: null,
        diagnostics: { rawRowsScanned: 1, pagesFetched: 1, scanLimitReached: true, payloadTruncations: 1 } }),
      executionRunStart: async (_sessionId, _input, options) => { evidence = options; return { runId: 'run' }; },
    } as ActionExecutorDeps);
    expect(await executor.execute('review.start', { sessionId: 'review-session', reviewRound,
      reviewers: [{ kind: 'engine', engineId: 'codex', includeSessionTranscript: true }], instructions: 'Review.',
      sourceSession: { serverId: 'home', sessionId: 'source' } },
    { surface: 'ui', serverId: 'home' })).toMatchObject({ ok: true });
    expect(evidence).toMatchObject({ reviewTranscriptEvidence: { coverage: 'partial' } });
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
    expect(starts).toEqual(expect.arrayContaining([
      { input: expect.objectContaining({ intentInput: expect.objectContaining({ engineId: 'codex' }) }),
        options: expect.objectContaining({ reviewTranscriptEvidence: { sourceSession: { serverId: 'home', sessionId: 'source' },
          items: [], coverage: 'complete' } }) },
      { input: expect.objectContaining({ intentInput: expect.objectContaining({ engineId: 'claude' }) }),
        options: expect.not.objectContaining({ reviewTranscriptEvidence: expect.anything() }) },
    ]));
  });
});
