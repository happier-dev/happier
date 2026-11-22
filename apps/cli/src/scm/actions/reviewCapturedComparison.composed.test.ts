import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions';
import { ScmComparisonCaptureInputSchema, ScmComparisonCaptureOutputSchema } from '@happier-dev/protocol/scm/diffSummary';
import type { ScmComparison } from '@happier-dev/protocol/scm/comparison';
import { WORKSPACE_FILE_RPC_MAX_RESPONSE_UTF8_BYTES } from '@happier-dev/protocol/machines/workspaceFiles';
import { createInMemoryReviewRecordPortV1 } from '../../../../../packages/protocol/src/reviews/reviewArtifactV1.testkit';
import { ReviewPreparedRoundV1Schema } from '@happier-dev/protocol/reviews/reviewRoundActionsV1';
import { runWithScmAccountScope } from '@/scm/accountScope';
import { createLocalScmRepositoryFixture, runScmExecutable } from '@/testkit/scm/scmBackendContractFixtures';
import { executeScmActionOperation } from './executeScmActionOperation';
import { projectCapturedComparison } from '../comparisons/projectCapturedComparison';
import { deleteCapturedScmComparison } from '../comparisons/captureScmComparison';

const reviewer = { kind: 'engine' as const, engineId: 'codex' };

describe('Review captured comparison transport', () => {
  it('admits a branch comparison larger than one socket response and prepares its retained round', async () => runWithScmAccountScope('review-capture-test', async () => {
    const fixture = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'review-large-capture-' });
    const records = createInMemoryReviewRecordPortV1();
    const capturedIds = new Set<string>();
    const bindings: { reviewId: string; roundOrdinal: number }[] = [];
    try {
      const content = 'captured evidence '.repeat(Math.ceil(WORKSPACE_FILE_RPC_MAX_RESPONSE_UTF8_BYTES / 3 / 18)) + '\n';
      for (let index = 0; index < 4; index++) await writeFile(join(fixture.rootPath, `large-${index}.txt`), content);
      runScmExecutable(fixture.rootPath, 'git', ['add', '--', 'large-0.txt', 'large-1.txt', 'large-2.txt', 'large-3.txt']);
      runScmExecutable(fixture.rootPath, 'git', ['commit', '-m', 'large branch comparison']);
      const source = { kind: 'branch' as const, base: fixture.headCommit, head: 'HEAD' };
      const operation = async (input: unknown) => {
        const result = ScmComparisonCaptureOutputSchema.parse(await executeScmActionOperation({
          actionId: 'scm.diffSummary.capture', workingDirectory: fixture.rootPath, input,
          authorizeSession: async sessionId => sessionId === undefined || sessionId === 'capture-session',
        }));
        if (result.success) capturedIds.add(result.comparison.id);
        return result;
      };
      expect(await operation({ cwd: fixture.rootPath, source })).toMatchObject({ success: false,
        errorCode: 'DIFF_UNAVAILABLE', error: expect.stringContaining('socket response limit') });
      const executor = createActionExecutor({ reviewRecords: () => records,
        resolveApiTokenGrantSessionMachineId: async () => 'capture-machine',
        // SCM and execution cross Machine transport; keep real capture/projection beneath that boundary.
        scmActionExecute: async request => {
          expect(request.actionId).toBe('scm.diffSummary.capture');
          return operation(request.input);
        },
        reviewEnginesList: async () => ({ items: [{ value: 'codex', label: 'Codex' }] }),
        executionRunStart: async (_sessionId, input) => {
          const round = input.intentInput?.reviewRound;
          if (!round || typeof round !== 'object' || !('reviewId' in round) || !('roundOrdinal' in round)
            || typeof round.reviewId !== 'string' || typeof round.roundOrdinal !== 'number') throw new Error('Missing admitted Review round');
          bindings.push({ reviewId: round.reviewId, roundOrdinal: round.roundOrdinal });
          return { runId: 'review-run', callId: 'call', sidechainId: 'sidechain' };
        },
      });
      const reviewInput = { sessionId: 'capture-session', cwd: fixture.rootPath, source,
        instructions: 'Review captured branch changes.', reviewers: [reviewer] };
      const started = await executor.execute('review.start', reviewInput, { surface: 'ui' });
      expect(started, JSON.stringify(started)).toMatchObject({ ok: true });
      const binding = bindings[0];
      if (!binding) throw new Error('Expected a started Review');
      const saved = await records.read(binding.reviewId);
      const capture = saved?.rounds[0]?.comparisonCapture?.input;
      expect(capture).toMatchObject({ source });
      expect(capture).not.toHaveProperty('projection');
      const prepared = await executor.execute('review.prepare_round', { reviewRound: binding,
        reviewInput: { ...reviewInput, comparisonId: capture?.comparisonId }, comparisonCapture: capture,
        previousRoundContext: null }, { surface: 'ui' });
      expect(prepared, JSON.stringify(prepared)).toMatchObject({ ok: true });
      if (!prepared.ok) throw new Error(prepared.error);
      const comparison = ReviewPreparedRoundV1Schema.parse(prepared.result).comparison;
      expect(comparison?.inventory).toMatchObject({ state: 'complete', files: expect.any(Array) });
      expect(comparison?.inventory.files).toHaveLength(4);
      expect(comparison?.inventory.files.every(file => file.evidence.state === 'deferred')).toBe(true);
      expect(JSON.stringify(comparison)).not.toContain('unifiedDiff');
    } finally {
      for (const comparisonId of capturedIds) {
        await deleteCapturedScmComparison({ cwd: fixture.rootPath, comparisonId });
        await deleteCapturedScmComparison({ cwd: fixture.rootPath, comparisonId, sessionId: 'capture-session' });
      }
      await rm(fixture.rootPath, { recursive: true, force: true });
    }
  }));

  it.each(['complete', 'incomplete'] as const)('marks a socket-paged %s index incomplete without discarding its retained identity or source reasons', async state => {
    const records = createInMemoryReviewRecordPortV1();
    const comparison: ScmComparison = { id: 'c'.repeat(64), source: { kind: 'workingTree' },
      repository: { rootPath: '/repo' }, endpoints: {}, inventory: { state, reasons: state === 'incomplete' ? ['source_patch_missing'] : [],
        files: ['one.ts', 'two.ts'].map(path => ({ path, changeKind: 'modified', binary: false, generated: false,
          lockfile: false, occurrences: [], evidence: { state: 'available', unifiedDiff: '@@ -1 +1 @@\n-old\n+new\n' } })) } };
    const binding = await records.start({ reviewId: 'paged-review', title: 'Review', subjectKind: 'comparison',
      sourceKind: 'direct', reviewerIds: ['reviewer'], comparisonId: comparison.id, startedAt: 1 });
    const executor = createActionExecutor({ reviewRecords: () => records,
      scmActionExecute: async request => {
        const input = ScmComparisonCaptureInputSchema.parse(request.input);
        // A bounded Machine response supplies one page; the retained source remains pinned.
        return projectCapturedComparison({ comparison, metadata: { source: comparison.source, sourceKey: comparison.id } },
          input.projection ? { ...input.projection, limit: 1 } : undefined);
      },
    });
    const prepared = await executor.execute('review.prepare_round', { reviewRound: binding,
      reviewInput: { sessionId: 'capture-session', cwd: '/repo', source: comparison.source,
        comparisonId: comparison.id, reviewers: [reviewer], instructions: 'Review captured evidence.' },
      comparisonCapture: { cwd: '/repo', source: comparison.source, comparisonId: comparison.id },
      previousRoundContext: null }, { surface: 'ui' });
    expect(prepared).toMatchObject({ ok: true });
    if (!prepared.ok) throw new Error(prepared.error);
    const actual = ReviewPreparedRoundV1Schema.parse(prepared.result).comparison;
    expect(actual).toMatchObject({ id: comparison.id, inventory: { state: 'incomplete' } });
    expect(actual?.inventory.files).toHaveLength(1);
    if (state === 'incomplete') expect(actual?.inventory.reasons).toContain('source_patch_missing');
    expect(actual?.inventory.reasons.some(reason => reason.includes('1 of 2'))).toBe(true);
    expect(comparison.inventory.files).toHaveLength(2);
  });

  it('preserves a typed capture refusal before admitting the Review', async () => {
    const records = createInMemoryReviewRecordPortV1();
    const refusal = ScmComparisonCaptureOutputSchema.parse({ success: false,
      errorCode: 'DIFF_UNAVAILABLE', error: 'Comparison source is unavailable.',
      failureCause: { phase: 'scm.diffSummary.capture', errorClass: 'Error', errorCode: 'DIFF_UNAVAILABLE', httpStatus: null },
      effectAttempted: false });
    const executor = createActionExecutor({ reviewRecords: () => records,
      resolveApiTokenGrantSessionMachineId: async () => 'capture-machine',
      scmActionExecute: async () => refusal,
    });
    expect(await executor.execute('review.start', { sessionId: 'capture-session', cwd: '/repo',
      source: { kind: 'workingTree' }, instructions: 'Review captured evidence.', reviewers: [reviewer] }, { surface: 'ui' }))
      .toMatchObject({ ok: false, errorCode: 'DIFF_UNAVAILABLE', effectAttempted: false,
        failureCause: { phase: 'scm.diffSummary.capture', errorClass: 'Error', errorCode: 'DIFF_UNAVAILABLE', httpStatus: null } });
  });
});
