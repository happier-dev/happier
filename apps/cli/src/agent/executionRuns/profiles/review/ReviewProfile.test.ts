import { runWithScmAccountScope } from '@/scm/accountScope';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import type { ExecutionRunStartRequest } from '@happier-dev/protocol';
import type { ExecutionRunProfileStartParams } from '../ExecutionRunIntentProfile';
import { resolveScmPullRequestReviewScope, ScmComparisonSchema, ScmDiffSummaryGenerateOutputSchema } from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import { ReviewProfile } from './ReviewProfile';
import { scmDiffSummaryResultStore } from '../../tasks/scmDiffSummary/results/resultStore';
import { createLocalScmRepositoryFixture } from '@/testkit/scm/scmBackendContractFixtures';
import { captureScmComparison, deleteCapturedScmComparison } from '@/scm/comparisons/captureScmComparison';

/**
 * The daemon-applied plugin runtime registry is a different process, and this
 * is a unit process: `runWithScmBackendRegistryLease` therefore refuses with
 * `PLUGIN_DAEMON_RUNTIME_UNAVAILABLE` and every `prepareStartParams` case in
 * this file throws before reaching the behavior under test. Mock exactly that
 * boundary — the same one the scope resolver's own test mocks — and leave
 * `resolveReviewScmScope` and the profile itself real beneath it. With no
 * backend selectable the resolver reaches its genuine `not_repository` arm.
 */
const scmCatalogMock = vi.hoisted(() => ({
  runWithScmBackendRegistryLease: vi.fn(async <T>(
    registry: unknown,
    run: (resolvedRegistry: unknown) => Promise<T>,
  ): Promise<T> => await run(registry ?? { selectBackend: async () => null })),
}));

vi.mock('@/scm/scmBackendCatalog', () => ({
  runWithScmBackendRegistryLease: scmCatalogMock.runWithScmBackendRegistryLease,
}));

describe('ReviewProfile', () => {
  it('retains native questions and assumptions whose absent optional finding references are null', () => {
    const completed = ReviewProfile.onBoundedComplete({ start: { sessionId: null, runId: 'native', callId: 'native',
      sidechainId: 'native', intent: 'review', backendId: 'codex', backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      instructions: 'Review', permissionMode: 'read_only', retentionPolicy: 'ephemeral', runClass: 'bounded',
      ioMode: 'request_response', startedAtMs: 1 }, finishedAtMs: 2, rawText: JSON.stringify({
      reviewOutcome: 'complete', summary: 'Review', overviewMarkdown: 'Review', findings: [],
      questions: [{ id: 'question', text: 'Which invariant applies?', status: 'open', findingIds: null }],
      assumptions: [{ id: 'assumption', text: 'The external contract is current.', findingIds: null }],
    }) });
    expect(completed.structuredMeta?.payload).toMatchObject({
      questions: [{ id: 'question' }], assumptions: [{ id: 'assumption' }],
    });
  });
  it('prepares scope from the retained selected comparison even after checkout HEAD moves', async () => runWithScmAccountScope('review-captured-scope', async () => {
    const fixture = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'review-captured-scope-' });
    const git = (...args: string[]) => execFileSync('git', args, { cwd: fixture.rootPath, encoding: 'utf8' }).trim();
    let comparisonId: string | undefined;
    try {
      await writeFile(join(fixture.rootPath, 'selected.ts'), 'selectedIssue();\n');
      await writeFile(join(fixture.rootPath, 'other-selected.ts'), 'otherIssue();\n');
      git('add', 'selected.ts', 'other-selected.ts'); git('commit', '-m', 'Selected head');
      const head = git('rev-parse', 'HEAD');
      const captured = await captureScmComparison({ cwd: fixture.rootPath,
        source: { kind: 'revisionRange', baseOid: fixture.headCommit, headOid: head } });
      comparisonId = captured.comparison.id;
      expect(captured.comparison.inventory.state).toBe('complete');
      await writeFile(join(fixture.rootPath, 'unrelated.ts'), 'ambientIssue();\n');
      git('add', 'unrelated.ts'); git('commit', '-m', 'Unrelated later head');
      const patch = await ReviewProfile.prepareStartParams!({ cwd: fixture.rootPath, request: {
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, intent: 'review', instructions: 'Review',
        permissionMode: 'read_only', runClass: 'bounded', retentionPolicy: 'ephemeral', ioMode: 'request_response',
        intentInput: { comparisonId, engineIds: ['claude'], instructions: 'Review', changeType: 'uncommitted', base: { kind: 'none' },
          selectedPaths: ['selected.ts'], comparison: { forged: true }, scmReviewScope: { forged: true } },
      } });
      expect(patch?.intentInput).toMatchObject({ comparison: { ...captured.comparison,
        inventory: { ...captured.comparison.inventory, files: captured.comparison.inventory.files.filter(file => file.path === 'selected.ts') } },
        scmReviewScope: { status: 'supported', selectedPaths: ['selected.ts'],
          baseRef: { source: 'explicit', ref: fixture.headCommit }, comparison: { endpoints: { after: head } } } });
      const prompt = ReviewProfile.buildPrompt({ sessionId: null, runId: 'captured', callId: 'captured', sidechainId: 'captured',
        intent: 'review', backendId: 'claude', backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        permissionMode: 'read_only', retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'request_response',
        startedAtMs: 1, instructions: 'Review the selected file.', intentInput: patch?.intentInput });
      expect(prompt).toContain('selectedIssue();');
      expect(prompt).not.toContain('otherIssue();');
      expect(prompt).not.toContain('ambientIssue();');
      expect(prompt).not.toContain('infer the repository');
      expect(prompt).not.toContain('current uncommitted');
      const contradictory = ReviewProfile.prepareStartParams!({ cwd: fixture.rootPath, request: {
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, intent: 'review', instructions: 'Review the repository.',
        permissionMode: 'read_only', runClass: 'bounded', retentionPolicy: 'ephemeral', ioMode: 'request_response',
        intentInput: { scope: 'repository', comparisonId },
      } });
      await expect(contradictory).rejects.toMatchObject({ code: 'scm_status_unavailable' });
    } finally {
      if (comparisonId) await deleteCapturedScmComparison({ cwd: fixture.rootPath, comparisonId });
      await rm(fixture.rootPath, { recursive: true, force: true });
    }
  }));
  it('does not demand native budget for findings-only review', async () => {
    return runWithScmAccountScope('account', async () => {
    let budgetDemands = 0;
    expect(await ReviewProfile.finalizeStartParams?.({ cwd: '/repo', request: {
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, intent: 'review', instructions: 'Review the changes',
      permissionMode: 'read_only', runClass: 'long_lived', retentionPolicy: 'resumable', ioMode: 'streaming',
    }, resolveMaxInputUnicodeCharacters: async () => { budgetDemands++; return 1; } })).toBeUndefined();
    expect(budgetDemands).toBe(0);
    });
  });
  it('presents only occurrence aliases to the reviewer before continuing into narration', () => {
    return runWithScmAccountScope('account', () => {
    const comparison = ScmComparisonSchema.parse({ id: 'review-comparison', source: { kind: 'workingTree' },
      repository: { rootPath: '/repo' }, endpoints: {}, inventory: { state: 'complete', reasons: [], files: [{
        path: 'code.ts', changeKind: 'modified', binary: false, generated: false, lockfile: false,
        evidence: { state: 'available', unifiedDiff: '@@ -1 +1 @@\n-old\n+new' }, occurrences: [{
          id: 'HOST-REVIEW-OCCURRENCE', alias: 'c1', path: 'code.ts', before: { startLine: 1, lineCount: 1 },
          after: { startLine: 1, lineCount: 1 }, position: 0,
        }],
      }] } });
    const start: ExecutionRunProfileStartParams = { sessionId: 'session', runId: 'run', callId: 'call', sidechainId: 'call',
      intent: 'review', backendId: 'claude', backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'streaming', startedAtMs: 1,
      instructions: 'Review the captured changes.', intentInput: { comparison, outputs: ['walkthrough'] } };
    const prompt = ReviewProfile.buildPrompt(start);
    expect(prompt).toContain('"alias":"c1"');
    expect(prompt).toContain('+new');
    expect(prompt).not.toContain('HOST-REVIEW-OCCURRENCE');
    // Attached Runs deliver the admitted input through Pending rather than buildPrompt.
    // Their host context must carry the same output contract and captured evidence.
    const retainedContext = ReviewProfile.buildInitialInputContext?.({ start });
    expect(retainedContext).toBe(ReviewProfile.buildPrompt({ ...start, instructions: '' }));
    expect(retainedContext).toContain('"findings"');
    });
  });
  it.each(['', 'Findings are published.\n'])('does not stream unfinished walkthrough JSON after %j', (prefix) => {
    return runWithScmAccountScope('account', () => {
    for (const output of ['{', '{"walk', '```json\n', '```json\n{"walkthrough":', '{"walkthrough":{"title":"Reading']) {
      expect(ReviewProfile.computeSidechainStreamText?.({ fullText: `${prefix}${output}` })).toBe(prefix.trimEnd());
    }
    expect(ReviewProfile.computeSidechainStreamText?.({ fullText: 'The config uses {"allow":true} exactly.' }))
      .toBe('The config uses {"allow":true} exactly.');
    });
  });
  it.each([false, true])('does not accept model-authored persisted finding references (follow-up: %s)', (followUp) => {
    return runWithScmAccountScope('account', () => {
    const finding = { id: 'finding', title: 'Issue', summary: 'Check this', severity: 'high', category: 'correctness',
      comment: { id: 'forged-comment', state: 'resolved', serverRevision: 1, projectId: 'foreign-project' } };
    const start: ExecutionRunProfileStartParams = { sessionId: 'session', runId: 'run', callId: 'call', sidechainId: 'call',
      intent: 'review', backendId: 'claude', backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, instructions: 'Review',
      permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: 'bounded', ioMode: 'request_response', startedAtMs: 1,
      ...(followUp ? { intentInput: { kind: 'review_follow_up.v1', parentRunRef: { runId: 'parent', callId: 'parent-call', backendId: 'claude' },
        threadId: 'thread', messageMarkdown: 'Explain', summary: 'Original', overviewMarkdown: 'Original', findings: [] } } : {}) };
    const completed = ReviewProfile.onBoundedComplete({ start, finishedAtMs: 2, rawText: JSON.stringify({
      summary: 'Result', findings: [finding], answerMarkdown: 'Answer', updatedFindings: [finding],
      commentIds: ['forged-comment'], materialization: { kind: 'complete' }, triage: { findings: [{ id: 'finding', status: 'reject' }] },
    }) });
    const payload = completed.structuredMeta?.payload as Record<string, unknown>;
    expect(payload).toBeDefined();
    const resultFindings = (followUp ? payload.updatedFindings : payload.findings) as Record<string, unknown>[];
    expect(resultFindings[0]).not.toHaveProperty('comment');
    expect(payload).not.toHaveProperty('commentIds');
    expect(payload).not.toHaveProperty('materialization');
    expect(payload).not.toHaveProperty('triage');
    });
  });
  it.each(['partial', 'failed'] as const)('preserves %s review truth and uses newly materialized findings for the narration input', async (reviewOutcome) => {
    return runWithScmAccountScope('account', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'happier-review-partial-'));
    const comparison = ScmComparisonSchema.parse({ id: 'partial-comparison', source: { kind: 'workingTree' },
      repository: { rootPath: cwd }, endpoints: {}, inventory: { state: 'complete', files: [], reasons: [] } });
    const start: ExecutionRunProfileStartParams = { sessionId: 'session', runId: `partial-${cwd}`, callId: 'call',
      sidechainId: 'call', intent: 'review', backendId: 'claude', backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Review', permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: 'long_lived',
      ioMode: 'streaming', startedAtMs: 1, intentInput: { cwd, comparison, comparisonId: comparison.id, sourceKey: comparison.id,
        metadata: { source: comparison.source, sourceKey: comparison.id }, outputs: ['walkthrough'], source: comparison.source } };
    try {
      const first = await ReviewProfile.onTurnComplete?.({ start, turnId: 'review', finishedAtMs: 2,
        rawText: JSON.stringify({ reviewOutcome, summary: 'Review incomplete', findings: [] }) });
      expect(first?.structuredMeta?.payload).toMatchObject({ reviewOutcome });
      expect(first?.status).toBe(reviewOutcome === 'failed' ? 'failed' : 'succeeded');
      const input = first!.nextInput!.intentInput as Record<string, unknown>;
      const narration = input.reviewNarration as Record<string, unknown>;
      const current = { ...input, reviewNarration: { ...narration, reviewFindings: [{ commentIds: ['persisted-comment'] }] } };
      expect(ReviewProfile.buildInitialInputContext?.({ start: { ...start, intentInput: current } })).toContain('persisted-comment');
      expect(narration.provenance).toMatchObject({ reviewedRuns: [{ reviewOutcome }] });
    } finally { await rm(cwd, { recursive: true, force: true }); }
    });
  });
  it.each([false, true])('publishes findings before narration, including when its saved generator is replaced (%s)', async (replaced) => {
    return runWithScmAccountScope('account', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'happier-review-walkthrough-'));
    const comparison = ScmComparisonSchema.parse({ id: 'review-comparison', source: { kind: 'workingTree' },
      repository: { rootPath: cwd }, endpoints: {}, inventory: { state: 'complete', files: [], reasons: [] } });
    const start: ExecutionRunProfileStartParams = { sessionId: 'review-session', runId: `review-${cwd}`, callId: 'review-call',
      sidechainId: 'review-call', intent: 'review', backendId: 'claude', modelId: 'selected-review-model',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, instructions: 'Review the captured changes.',
      permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'streaming', startedAtMs: 1,
      intentInput: { cwd, comparison, comparisonId: comparison.id, sourceKey: comparison.id, metadata: { source: comparison.source, sourceKey: comparison.id },
        outputs: ['walkthrough'], source: comparison.source, reviewRound: { reviewId: 'review-with-walkthrough', roundOrdinal: 1 } } };
    try {
      const started = await ReviewProfile.onStarted?.({ start, rawText: '', finishedAtMs: 1 });
      const pending = ScmDiffSummaryGenerateOutputSchema.parse(started?.toolResultOutput);
      const profileStart = { ...start, intentInput: { ...start.intentInput as Record<string, unknown>, resultId: pending.resultId } };
      const scope = { cwd, sessionId: start.sessionId!, resultId: pending.resultId! };
      if (replaced) {
        const replacement = await scmDiffSummaryResultStore.bindRun({ ...scope, expectedRevision: pending.revision!, runId: 'replacement-narrator' });
        if (!replacement.success) throw new Error(replacement.error);
      }
      const first = await ReviewProfile.onTurnComplete?.({ start: profileStart, turnId: 'findings-turn',
        inputIds: [`execution-run-initial:${start.runId}`], rawText: JSON.stringify({
        summary: 'No findings in this captured comparison.', findings: [], overviewMarkdown: 'Review completed.' }), finishedAtMs: 2 });
      expect(first?.structuredMeta?.kind).toBe('review_findings.v2');
      if (replaced) {
        expect(first?.structuredMeta?.payload).toMatchObject({ summary: 'No findings in this captured comparison.', findings: [] });
        expect(first?.nextInput).toBeUndefined();
        expect(first?.toolResultMeta).toMatchObject({ reviewNarration: { phase: 'failed', errorCode: 'review_narration_failed' } });
        expect(await scmDiffSummaryResultStore.read(scope)).toMatchObject({ success: true,
          result: { output: { runId: 'replacement-narrator', outputs: { walkthrough: { state: 'pending' } } } } });
        return;
      }
      expect(first?.nextInput).toBeDefined();
      expect(first?.nextInput?.instructions).toContain('walkthrough');
      expect(await scmDiffSummaryResultStore.readInput({ cwd, sessionId: start.sessionId!, resultId: pending.resultId!,
        inputIds: [`execution-run-initial:${start.runId}`] })).toBeNull();
      const writingStart = { ...profileStart, intentInput: first!.nextInput!.intentInput };
      const second = await ReviewProfile.onTurnComplete?.({ start: writingStart, turnId: 'narration-turn',
        inputIds: [first!.nextInput!.localId], previousStructuredMeta: first!.structuredMeta,
        rawText: JSON.stringify({ walkthrough: { title: 'Captured changes', intro: 'No changes.', stops: [], otherChangeRefs: [] } }), finishedAtMs: 3 });
      const output = ScmDiffSummaryGenerateOutputSchema.parse(second?.toolResultOutput);
      expect(output).toMatchObject({ runId: start.runId, comparison, outputs: { walkthrough: { state: 'complete' } },
        producer: { kind: 'review', runId: start.runId, modelId: 'selected-review-model', narrationMode: 'continued_review' } });
      expect(output.resultId).toBeTruthy();
      expect(ReviewProfile.listAvailableActionIds?.({ start: writingStart, structuredMeta: second?.structuredMeta })).toEqual(
        expect.arrayContaining(['review.triage', 'review.walkthrough', 'review.explain_findings', 'review.new_round']));
      const saved = await scmDiffSummaryResultStore.read({ cwd, sessionId: start.sessionId!, resultId: output.resultId! });
      expect(saved.success && saved.result.output).toEqual(output);
    } finally { await rm(cwd, { recursive: true, force: true }); }
    });
  });

  it('keeps published review findings and a failed narration state when the walkthrough turn fails', async () => {
    return runWithScmAccountScope('account', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'happier-review-narration-failed-'));
    const comparison = ScmComparisonSchema.parse({ id: 'review-failure-comparison', source: { kind: 'workingTree' },
      repository: { rootPath: cwd }, endpoints: {}, inventory: { state: 'complete', files: [], reasons: [] } });
    const start: ExecutionRunProfileStartParams = { sessionId: 'review-session', runId: `review-${cwd}`, callId: 'review-call',
      sidechainId: 'review-call', intent: 'review', backendId: 'claude', backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Review.', permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'streaming', startedAtMs: 1,
      intentInput: { cwd, comparison, comparisonId: comparison.id, sourceKey: comparison.id, metadata: { source: comparison.source, sourceKey: comparison.id }, outputs: ['walkthrough'], source: comparison.source } };
    try {
      const first = await ReviewProfile.onTurnComplete?.({ start, turnId: 'findings-turn', rawText: JSON.stringify({
        summary: 'Retained findings', overviewMarkdown: 'Review completed.', findings: [] }), finishedAtMs: 2 });
      expect(first?.structuredMeta?.kind).toBe('review_findings.v2');
      const second = await ReviewProfile.onTurnFailed?.({ start: { ...start, intentInput: first!.nextInput!.intentInput },
        turnId: 'narration-turn', inputIds: [first!.nextInput!.localId], previousStructuredMeta: first!.structuredMeta,
        rawText: '', finishedAtMs: 3, diagnostic: { code: 'model_failed' } });
      expect(ScmDiffSummaryGenerateOutputSchema.parse(second?.toolResultOutput).outputs?.walkthrough?.state).toBe('failed');
      expect(first?.structuredMeta?.payload).toMatchObject({ summary: 'Retained findings' });
    } finally { await rm(cwd, { recursive: true, force: true }); }
    });
  });
  it('keeps findings and settles saved narration when its lazy runtime budget is exhausted', async () => {
    return runWithScmAccountScope('account', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'happier-review-budget-'));
    const comparison = ScmComparisonSchema.parse({ id: 'review-budget-comparison', source: { kind: 'workingTree' },
      repository: { rootPath: cwd }, endpoints: {}, inventory: { state: 'complete', files: [], reasons: [] } });
    const start: ExecutionRunProfileStartParams = { sessionId: 'review-session', runId: `review-${cwd}`, callId: 'review-call',
      sidechainId: 'review-call', intent: 'review', backendId: 'claude', backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Review.', permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'streaming', startedAtMs: 1,
      intentInput: { cwd, comparison, metadata: { source: comparison.source, sourceKey: comparison.id }, outputs: ['walkthrough'] } };
    try {
      const finalized = await ReviewProfile.finalizeStartParams!({ cwd, request: start,
        resolveMaxInputUnicodeCharacters: async () => 0 });
      const prepared = { ...start, ...finalized };
      const started = await ReviewProfile.onStarted!({ start: prepared, rawText: '', finishedAtMs: 1 });
      const pending = ScmDiffSummaryGenerateOutputSchema.parse(started?.toolResultOutput);
      const first = await ReviewProfile.onTurnComplete!({ start: { ...prepared,
        intentInput: { ...prepared.intentInput as Record<string, unknown>, resultId: pending.resultId } },
        turnId: 'findings-turn', rawText: JSON.stringify({ summary: 'Retained findings', findings: [], overviewMarkdown: 'Reviewed.' }), finishedAtMs: 2 });
      expect(first?.structuredMeta).toMatchObject({ kind: 'review_findings.v2', payload: { summary: 'Retained findings' } });
      expect(first?.nextInput).toBeUndefined();
      expect(await scmDiffSummaryResultStore.read({ cwd, sessionId: start.sessionId!, resultId: pending.resultId! }))
        .toMatchObject({ success: true, result: { output: { comparison, outputs: { walkthrough: {
          state: 'failed', reason: expect.stringContaining('capacity'), reasonCode: 'provider_input_too_large',
        } } } } });
    } finally { await rm(cwd, { recursive: true, force: true }); }
    });
  });
  it('adds unsupported host-resolved SCM scope for non-repository review starts', async () => {
    return runWithScmAccountScope('account', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'happier-review-non-repo-'));
    const request = {
      intent: 'review',
      backendTarget: { kind: 'backend', backendId: 'coderabbit' },
      instructions: 'Review.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
      intentInput: {
        engineIds: ['coderabbit'],
        instructions: 'Review.',
        changeType: 'uncommitted',
        base: { kind: 'none' },
      },
    } satisfies ExecutionRunStartRequest;

    try {
      expect(ReviewProfile.prepareStartParams).toEqual(expect.any(Function));
      const patch = await ReviewProfile.prepareStartParams!({ request, cwd });
      expect(patch).toMatchObject({
        intentInput: {
          scmReviewScope: {
            kind: 'review_scm_scope.v1',
            status: 'unsupported',
            diagnostics: [
              expect.objectContaining({
                code: 'not_repository',
              }),
            ],
          },
        },
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
    });
  });

  it('preserves SCM_PULL_REQUEST_REVIEW_SCOPE_INPUT_KEY while re-deriving scmReviewScope', async () => {
    return runWithScmAccountScope('account', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'happier-review-pr-scope-'));
    const scmPullRequestReviewScope = {
      kind: 'scm_pull_request_review_scope.v1',
      account: {
        service: { pluginId: 'happier.scm-github', localId: 'github' },
        accountId: 'account-7',
      },
      pullRequest: { number: 42 },
      observed: {
        baseSha: '1111111111111111111111111111111111111111',
        headSha: '2222222222222222222222222222222222222222',
        nativeRevision: 'PR_kwDOABCD',
        observedAtMs: 1_700_000_000_000,
      },
    } as const;
    const request = {
      intent: 'review',
      backendTarget: { kind: 'backend', backendId: 'coderabbit' },
      instructions: 'Review the selected pull request.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
      intentInput: {
        engineIds: ['coderabbit'],
        instructions: 'Review the selected pull request.',
        changeType: 'uncommitted',
        base: { kind: 'none' },
        // The scope a source review was started with, and a stale worktree
        // scope from the caller. Only the second may be replaced.
        scmPullRequestReviewScope,
        scmReviewScope: { kind: 'review_scm_scope.v1', status: 'supported' },
      },
    } satisfies ExecutionRunStartRequest;

    try {
      const patch = await ReviewProfile.prepareStartParams!({ request, cwd });
      // The profile contract lets a profile decline to patch; this one must not,
      // because declining is exactly how the re-derived scope would be lost.
      if (!patch) {
        throw new Error('ReviewProfile.prepareStartParams returned no start-params patch');
      }
      const intentInput = patch.intentInput as Record<string, unknown>;

      // The selected source remains the authority for pinned PR endpoints.
      // U7 consumes those facts without ambient checkout inference.
      expect(intentInput.scmPullRequestReviewScope).toEqual(scmPullRequestReviewScope);
      expect(intentInput.scmReviewScope).toMatchObject({
        kind: 'review_scm_scope.v1',
        status: 'supported',
        revisionRange: { kind: 'revisionRange', baseOid: scmPullRequestReviewScope.observed.baseSha,
          headOid: scmPullRequestReviewScope.observed.headSha },
      });
      expect(intentInput.engineIds).toEqual(['coderabbit']);
      expect(resolveScmPullRequestReviewScope(intentInput)).toEqual({
        status: 'scope_present',
        scope: scmPullRequestReviewScope,
      });
      const contradictory = ReviewProfile.prepareStartParams!({ cwd, request: {
        ...request, intentInput: { ...request.intentInput, scope: 'repository' },
      } });
      await expect(contradictory).rejects.toMatchObject({ code: 'scm_status_unavailable' });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
    });
  });

  it('parses trailing JSON when model output includes preamble text', () => {
    return runWithScmAccountScope('account', () => {
    const start = {
      sessionId: 'sess_1',
      runId: 'run_1',
      callId: 'call_1',
      sidechainId: 'call_1',
      intent: 'review',
      backendId: 'claude',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'review this',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
      startedAtMs: 1,
    } as const;

    const res = ReviewProfile.onBoundedComplete({
      start,
      rawText: [
        'Sure, here are the findings.',
        '{',
        '  "summary": "Ok",',
        '  "overviewMarkdown": "## Overview\\n\\nLooks good.",',
        '  "findings": [],',
        '  "questions": [],',
        '  "assumptions": []',
        '}',
      ].join('\n'),
      finishedAtMs: 2,
    });

    expect(res.status).toBe('succeeded');
    expect(res.structuredMeta?.kind).toBe('review_findings.v2');
    expect((res.structuredMeta as any).payload?.summary).toBe('Ok');
    expect((res.structuredMeta as any).payload?.overviewMarkdown).toContain('Overview');
    });
  });

  it('validates and retains bounded proposed comments in structured output', () => {
    return runWithScmAccountScope('account', () => {
    const start = {
      sessionId: 'sess_1', runId: 'run_1', callId: 'call_1', sidechainId: 'call_1',
      intent: 'review', backendId: 'coderabbit',
      backendTarget: { kind: 'builtInAgent', agentId: 'coderabbit' },
      instructions: 'review this', permissionMode: 'read_only', retentionPolicy: 'ephemeral',
      runClass: 'bounded', ioMode: 'request_response', startedAtMs: 1,
    } as const;
    const res = ReviewProfile.onBoundedComplete({
      start,
      rawText: JSON.stringify({
        summary: 'One finding', overviewMarkdown: 'One finding', findings: [], questions: [], assumptions: [],
        proposedComments: [{
          findingId: 'finding-1', body: 'Validate the redirect.',
          anchor: { kind: 'line', filePath: 'src/auth.ts', line: 12 },
          severity: 'error', taxonomyIds: ['security.redirect'], tags: ['coderabbit'],
        }],
      }),
      finishedAtMs: 2,
    });

    expect(res.status).toBe('succeeded');
    expect((res.structuredMeta?.payload as any).proposedComments).toEqual([
      expect.objectContaining({ findingId: 'finding-1', body: 'Validate the redirect.' }),
    ]);
    });
  });

  it('leaves every review action to the runtime, so no action rewrites the review result', () => {
    return runWithScmAccountScope('account', () => {
    // A finding's decision lives in its ReviewComment and host comments are materialized by the
    // host bridge; the profile has no reducer that could write a second copy into the result.
    expect(ReviewProfile.applyAction).toBeUndefined();
    });
  });

  it('fails deterministically when model output is not strict JSON', () => {
    return runWithScmAccountScope('account', () => {
    const start = {
      sessionId: 'sess_1',
      runId: 'run_1',
      callId: 'call_1',
      sidechainId: 'call_1',
      intent: 'review',
      backendId: 'claude',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'review this',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
      startedAtMs: 1,
    } as const;

    const res = ReviewProfile.onBoundedComplete({
      start,
      rawText: 'not json',
      finishedAtMs: 2,
    });

    expect(res.status).toBe('failed');
    expect((res.toolResultOutput as any)?.error?.code).toBe('invalid_output');
    });
  });

  it('treats provider-specific plain text as invalid generic review output', () => {
    return runWithScmAccountScope('account', () => {
    const start = {
      sessionId: 'sess_1',
      runId: 'run_1',
      callId: 'call_1',
      sidechainId: 'call_1',
      intent: 'review',
      backendId: ['code', 'rabbit'].join(''),
      backendTarget: { kind: 'builtInAgent', agentId: ['code', 'rabbit'].join('') },
      instructions: 'review this',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
      startedAtMs: 1,
    } as const;

    const rawText = [
      'File: src/foo.ts',
      'Line: 10 to 12',
      'Type: Bug',
      'Comment:',
      'Null deref risk when value is missing.',
      '',
      'Prompt for AI Agent:',
      'Add a guard and unit test.',
      '============================================================================',
    ].join('\n');

    const res = ReviewProfile.onBoundedComplete({
      start,
      rawText,
      finishedAtMs: 2,
    });

    expect(res.status).toBe('failed');
    expect((res.toolResultOutput as any)?.error?.code).toBe('invalid_output');
    });
  });

  it.each([false, true])('exposes native New round only when the review has an admitted round (bound: %s)', (bound) => {
    return runWithScmAccountScope('account', () => {
    const actionIds = ReviewProfile.listAvailableActionIds?.({
      start: {
        sessionId: 'sess_1',
        runId: 'run_1',
        callId: 'call_1',
        sidechainId: 'call_1',
        intent: 'review',
        backendId: 'claude',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        instructions: 'review this',
        permissionMode: 'read_only',
        retentionPolicy: 'resumable',
        runClass: 'bounded',
        ioMode: 'streaming',
        startedAtMs: 1,
        ...(bound ? { intentInput: { reviewRound: { reviewId: 'review-1', roundOrdinal: 1 } } } : {}),
      },
      structuredMeta: {
        kind: 'review_findings.v2',
        payload: {
          runRef: {
            runId: 'run_1',
            callId: 'call_1',
            backendId: 'claude',
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
          },
          summary: 'Ok',
          overviewMarkdown: 'Ok',
          findings: [],
          questions: [],
          assumptions: [],
          generatedAtMs: 1,
        },
      },
    });

    expect(actionIds).toEqual(['review.triage', 'review.follow_up', ...(bound ? ['review.new_round'] : [])]);
    });
  });

  it('hides review.follow_up for ephemeral review findings payloads', () => {
    return runWithScmAccountScope('account', () => {
    const actionIds = ReviewProfile.listAvailableActionIds?.({
      start: {
        sessionId: 'sess_1',
        runId: 'run_1',
        callId: 'call_1',
        sidechainId: 'call_1',
        intent: 'review',
        backendId: 'review-cli',
        backendTarget: { kind: 'builtInAgent', agentId: 'review-cli' },
        instructions: 'review this',
        permissionMode: 'read_only',
        retentionPolicy: 'ephemeral',
        runClass: 'bounded',
        ioMode: 'streaming',
        startedAtMs: 1,
      },
      structuredMeta: {
        kind: 'review_findings.v2',
        payload: {
          runRef: {
            runId: 'run_1',
            callId: 'call_1',
            backendId: 'review-cli',
            backendTarget: { kind: 'builtInAgent', agentId: 'review-cli' },
          },
          summary: 'Ok',
          overviewMarkdown: 'Ok',
          findings: [],
          questions: [],
          assumptions: [],
          generatedAtMs: 1,
        },
      },
    });

    expect(actionIds).toEqual(['review.triage']);
    });
  });

  it('builds a review-specific repair prompt and normalizes review sidechain text', () => {
    return runWithScmAccountScope('account', () => {
    expect(ReviewProfile.emitFinalSidechainMessageWhenStreamed).toBe(true);
    const prompt = ReviewProfile.buildInvalidOutputRepairPrompt?.({
      rawText: 'not json',
      start: {
        sessionId: 'sess_1',
        runId: 'run_1',
        callId: 'call_1',
        sidechainId: 'call_1',
        intent: 'review',
        backendId: 'claude',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        instructions: 'review this',
        permissionMode: 'read_only',
        retentionPolicy: 'ephemeral',
        runClass: 'bounded',
        ioMode: 'request_response',
        startedAtMs: 1,
      },
    });

    expect(prompt).toContain('Your previous response did not include the required final JSON object.');
    expect(prompt).toContain('continue the review first using the available read-only tools');
    expect(prompt).toContain('not json');

    expect(
      ReviewProfile.computeSidechainStreamText?.({ fullText: 'Review prose\n{"summary":"Ok","findings":[]}' }),
    ).toBe('Review prose');
    });
  });
});
