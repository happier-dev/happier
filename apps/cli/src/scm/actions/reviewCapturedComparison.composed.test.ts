import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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
import { resolveReviewScmScope } from '@/agent/reviews/scope/resolve';
import { gitCheckpointAdapter, resolveGitCheckpointBackendContext } from '@/scm/checkpoints/gitCheckpointAdapter';
import { buildRepositoryCheckpointRefs } from '@/scm/checkpoints/refs';
import { retainRepositoryCheckpointTurnEvidence } from '@/scm/checkpoints/sessionEvidence';
import { createTriageSourceV1Fixture } from '@happier-dev/triage-protocol/testing/v1';
import { getGithubTriageEntry } from '../../../../../packages/plugins/scm-github/src/triage/operations.js';
import { listGithubChangedFiles } from '../../../../../packages/plugins/scm-github/src/triage/detailOperations.js';
import { encodeGithubTriageConfiguration } from '../../../../../packages/plugins/scm-github/src/triage/configuration.js';
import { GITHUB_CONNECTED_ACCOUNT_PURPOSE, GITHUB_PLUGIN_ID } from '../../../../../packages/plugins/scm-github/src/observations/githubProviderContracts.js';
import { createStubGithubTransport, GITHUB_TEST_ACCOUNT } from '../../../../../packages/plugins/scm-github/src/triage/testkit/githubTriage.test-support.js';
import { GITHUB_FIXTURE_OWNER, GITHUB_FIXTURE_REPOSITORY, GITHUB_FIXTURE_REPOSITORY_ID, GITHUB_PULL_REQUEST_RESPONSE, githubChangedFile } from '../../../../../packages/plugins/scm-github/src/triage/__fixtures__/githubResponses.js';

const reviewer = { kind: 'engine' as const, engineId: 'codex' };

describe('Review captured comparison transport', () => {
  it('retains the real forge producer PR endpoints through Review admission instead of ambient Git', async () => runWithScmAccountScope('review-capture-pr-test', async () => {
    const fixture = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'review-forge-pr-' });
    const repository = `${GITHUB_FIXTURE_OWNER}/${GITHUB_FIXTURE_REPOSITORY}`.toLowerCase();
    const mergeBase = 'c'.repeat(40);
    const records = createInMemoryReviewRecordPortV1();
    const captures = new Set<string>();
    const bindings: { reviewId: string; roundOrdinal: number }[] = [];
    // Only GitHub HTTP/credential materialization, Machine transport and native
    // Run are substituted. The forge admission and changed-files producer run.
    const http = createStubGithubTransport({ respond: request => {
      const path = new URL(request.url).pathname;
      if (path.endsWith('/pulls/1284/files')) return { status: 200, body: [{
        ...githubChangedFile({ filename: 'selected.ts', additions: 1, deletions: 1 }),
        patch: '@@ -1 +1 @@\n-before\n+after\n',
      }] };
      if (path.endsWith('/pulls/1284')) return { status: 200, body: { ...GITHUB_PULL_REQUEST_RESPONSE, changed_files: 1 } };
      return undefined;
    } });
    const baseInstance = createTriageSourceV1Fixture().configuredInstance;
    const token = encodeGithubTriageConfiguration({ v: 1, scope: { kind: 'repository', repositoryKey: repository } });
    const instance = { ...baseInstance,
      instance: { ...baseInstance.instance, source: { pluginId: GITHUB_PLUGIN_ID, localId: 'github-forge' } },
      binding: { purpose: GITHUB_CONNECTED_ACCOUNT_PURPOSE, account: GITHUB_TEST_ACCOUNT },
      localInstanceKey: 'github.com', configuration: { v: 1, token },
    };
    try {
      await writeFile(join(fixture.rootPath, 'unrelated.txt'), 'unrelated ambient change\n');
      runScmExecutable(fixture.rootPath, 'git', ['add', '--', 'unrelated.txt']);
      runScmExecutable(fixture.rootPath, 'git', ['commit', '-m', 'unrelated ambient head']);
      const entry = await getGithubTriageEntry({ v: 1, instance,
        localRef: { kindId: 'pull-request', collisionScope: `github:${GITHUB_FIXTURE_REPOSITORY_ID}`, entryId: '1284' },
        lastKnownLocator: { v: 1, webUrl: GITHUB_PULL_REQUEST_RESPONSE.html_url, displayPath: 'PR #1284', routingToken: repository },
      }, http.context);
      if (entry.kind !== 'present' || entry.comparisonSource?.kind !== 'pullRequest') throw new Error('Expected the real forge comparison producer');
      const source = entry.comparisonSource;
      expect(source.locator.sourceAction).toBeDefined();
      expect(runScmExecutable(fixture.rootPath, 'git', ['rev-parse', 'HEAD'])).not.toBe(source.locator.headOid);
      const executor = createActionExecutor({ reviewRecords: () => records,
        resolveApiTokenGrantSessionMachineId: async () => 'capture-machine',
        scmActionExecute: async request => {
          const result = ScmComparisonCaptureOutputSchema.parse(await executeScmActionOperation({
            actionId: request.actionId, workingDirectory: fixture.rootPath, input: request.input,
            authorizeSession: async id => id === 'capture-session',
            readPullRequestComparisonPage: async ({ sourceAction, continuation }) => listGithubChangedFiles({
              ...sourceAction.input, ...(continuation ? { continuation } : {}),
            }, http.context),
          }));
          if (result.success) captures.add(result.comparison.id);
          return result;
        },
        reviewEnginesList: async () => ({ items: [{ value: 'codex', label: 'Codex' }] }),
        executionRunStart: async (_sessionId, input) => {
          bindings.push(ReviewPreparedRoundV1Schema.shape.reviewRound.parse(input.intentInput?.reviewRound));
          return { runId: 'forge-pr-run', callId: 'call', sidechainId: 'sidechain' };
        },
      });
      const reviewInput = { sessionId: 'capture-session', cwd: fixture.rootPath, source,
        instructions: 'Review the selected pull request.', reviewers: [reviewer] };
      expect(await executor.execute('review.start', reviewInput, { surface: 'ui' })).toMatchObject({ ok: true });
      const binding = bindings[0]!;
      const capture = (await records.read(binding.reviewId))?.rounds[0]?.comparisonCapture?.input;
      expect(capture?.source).toEqual(source);
      const prepared = await executor.execute('review.prepare_round', { reviewRound: binding,
        reviewInput: { ...reviewInput, comparisonId: capture?.comparisonId }, comparisonCapture: capture,
        previousRoundContext: null }, { surface: 'ui' });
      expect(prepared, JSON.stringify(prepared)).toMatchObject({ ok: true });
      if (!prepared.ok) throw new Error(prepared.error);
      const comparison = ReviewPreparedRoundV1Schema.parse(prepared.result).comparison;
      expect(comparison, JSON.stringify(comparison)).toMatchObject({ endpoints: { before: mergeBase, after: source.locator.headOid },
        pullRequest: { baseOid: source.locator.baseOid }, inventory: { state: 'complete', files: [{ path: 'selected.ts' }] } });
      expect(await resolveReviewScmScope({ cwd: fixture.rootPath, intentInput: { comparisonId: comparison!.id, comparison,
        selectedPaths: ['selected.ts'] } })).toMatchObject({ status: 'supported', selectedPaths: ['selected.ts'] });
      expect(await resolveReviewScmScope({ cwd: fixture.rootPath, intentInput: { comparisonId: comparison!.id, comparison,
        selectedPaths: ['unrelated.txt'] } })).toMatchObject({ status: 'unsupported', diagnostics: [{ code: 'invalid_path' }] });
    } finally {
      for (const comparisonId of captures) await deleteCapturedScmComparison({ cwd: fixture.rootPath, sessionId: 'capture-session', comparisonId });
      await rm(fixture.rootPath, { recursive: true, force: true });
    }
  }));

  it('admits the selected real turn checkpoints without later worktree changes', async () => runWithScmAccountScope('review-capture-turn-test', async () => {
    const fixture = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'review-selected-turn-' });
    const sessionId = globalThis.crypto.randomUUID();
    const turnId = 'selected-turn';
    const scopeId = `${sessionId}:${fixture.rootPath}`;
    const refs = buildRepositoryCheckpointRefs({ scopeId, turnId });
    const context = await resolveGitCheckpointBackendContext({ cwd: fixture.rootPath });
    const captures = new Set<string>();
    try {
      if (!context || !refs.turnStart || !refs.turnFinal) throw new Error('Real checkpoint fixture unavailable');
      await writeFile(join(fixture.rootPath, 'selected.txt'), 'before selected turn\n');
      const before = await gitCheckpointAdapter.capture({ context, checkpointRef: refs.turnStart });
      await writeFile(join(fixture.rootPath, 'selected.txt'), 'after selected turn\n');
      const after = await gitCheckpointAdapter.capture({ context, checkpointRef: refs.turnFinal });
      if (!before.success || !after.success) throw new Error('Real checkpoint capture failed');
      await retainRepositoryCheckpointTurnEvidence({ cwd: fixture.rootPath, scopeId, turnChangeSet: {
        sessionId, turnId, seqRange: { startSeqInclusive: 1, endSeqInclusive: 2 }, status: 'completed',
        provider: 'agent', derivedAt: 1, files: [], repositoryCheckpoint: {
          version: 1, scopeId, startRef: refs.turnStart.ref, finalRef: refs.turnFinal.ref,
          baseRefSource: 'turn_start', contentConfidence: 'exact', attributionScope: 'shared_worktree',
          receipts: [...before.receipts, ...after.receipts],
        },
      } });
      await writeFile(join(fixture.rootPath, 'unrelated.txt'), 'later worktree change\n');
      const records = createInMemoryReviewRecordPortV1();
      const bindings: { reviewId: string; roundOrdinal: number }[] = [];
      const executor = createActionExecutor({ reviewRecords: () => records,
        resolveApiTokenGrantSessionMachineId: async () => 'capture-machine',
        // Machine transport and native Run are boundaries; checkpoint capture,
        // persisted Review, round preparation and scope enforcement stay real.
        scmActionExecute: async request => {
          const result = ScmComparisonCaptureOutputSchema.parse(await executeScmActionOperation({
            actionId: request.actionId, workingDirectory: fixture.rootPath, input: request.input,
            authorizeSession: async id => id === sessionId,
          }));
          if (result.success) captures.add(result.comparison.id);
          return result;
        },
        reviewEnginesList: async () => ({ items: [{ value: 'codex', label: 'Codex' }] }),
        executionRunStart: async (_sessionId, input) => {
          bindings.push(ReviewPreparedRoundV1Schema.shape.reviewRound.parse(input.intentInput?.reviewRound));
          return { runId: 'selected-turn-run', callId: 'call', sidechainId: 'sidechain' };
        },
      });
      const source = { kind: 'turnCheckpoint' as const, sessionId, turnId, evidenceMode: 'reconciled' as const };
      const reviewInput = { sessionId, cwd: fixture.rootPath, source, instructions: 'Review only the selected turn.', reviewers: [reviewer] };
      expect(await executor.execute('review.start', reviewInput, { surface: 'ui' })).toMatchObject({ ok: true });
      const binding = bindings[0]!;
      const capture = (await records.read(binding.reviewId))?.rounds[0]?.comparisonCapture?.input;
      const prepared = await executor.execute('review.prepare_round', { reviewRound: binding,
        reviewInput: { ...reviewInput, comparisonId: capture?.comparisonId }, comparisonCapture: capture,
        previousRoundContext: null }, { surface: 'ui' });
      expect(prepared, JSON.stringify(prepared)).toMatchObject({ ok: true });
      if (!prepared.ok) throw new Error(prepared.error);
      const comparison = ReviewPreparedRoundV1Schema.parse(prepared.result).comparison;
      expect(comparison).toMatchObject({ source: { kind: 'turnCheckpoint', sessionId, turnId },
        endpoints: { before: before.commitSha, after: after.commitSha }, inventory: { state: 'complete', files: [{ path: 'selected.txt' }] } });
      expect(await resolveReviewScmScope({ cwd: fixture.rootPath, intentInput: { comparisonId: comparison!.id, comparison,
        selectedPaths: ['unrelated.txt'] } })).toMatchObject({ status: 'unsupported', diagnostics: [{ code: 'invalid_path' }] });
    } finally {
      for (const comparisonId of captures) await deleteCapturedScmComparison({ cwd: fixture.rootPath, sessionId, comparisonId });
      await rm(fixture.rootPath, { recursive: true, force: true });
    }
  }));

  it('retains admitted endpoints after ambient HEAD changes and admits the neighboring detached worktree', async () => runWithScmAccountScope('review-capture-worktree-test', async () => {
    const fixture = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'review-capture-worktree-' });
    const worktreeParent = await mkdtemp(join(tmpdir(), 'review-capture-neighbor-'));
    const neighbor = join(worktreeParent, 'reviewer');
    const records = createInMemoryReviewRecordPortV1();
    const captures = new Map<string, { cwd: string; comparisonId: string }>();
    const bindings: { reviewId: string; roundOrdinal: number }[] = [];
    try {
      await writeFile(join(fixture.rootPath, 'selected.txt'), 'selected change\n');
      runScmExecutable(fixture.rootPath, 'git', ['add', '--', 'selected.txt']);
      runScmExecutable(fixture.rootPath, 'git', ['commit', '-m', 'selected review head']);
      const selectedHead = runScmExecutable(fixture.rootPath, 'git', ['rev-parse', 'HEAD']);
      runScmExecutable(fixture.rootPath, 'git', ['worktree', 'add', '--detach', neighbor, selectedHead]);
      const source = { kind: 'branch' as const, base: fixture.headCommit, head: selectedHead };
      const executor = createActionExecutor({ reviewRecords: () => records,
        resolveApiTokenGrantSessionMachineId: async () => 'capture-machine',
        // Only the Machine transport and native Run are substituted; Git capture,
        // admitted Record, round preparation and scope resolution stay real.
        scmActionExecute: async request => {
          const input = ScmComparisonCaptureInputSchema.parse(request.input);
          const result = ScmComparisonCaptureOutputSchema.parse(await executeScmActionOperation({
            actionId: request.actionId, workingDirectory: fixture.rootPath, input,
            authorizeSession: async sessionId => sessionId === 'capture-session',
          }));
          if (result.success) captures.set(result.comparison.id, { cwd: input.cwd!, comparisonId: result.comparison.id });
          return result;
        },
        reviewEnginesList: async () => ({ items: [{ value: 'codex', label: 'Codex' }] }),
        executionRunStart: async (_sessionId, input) => {
          const round = ReviewPreparedRoundV1Schema.shape.reviewRound.parse(input.intentInput?.reviewRound);
          bindings.push(round);
          return { runId: `review-run-${bindings.length}`, callId: 'call', sidechainId: 'sidechain' };
        },
      });
      const inputFor = (cwd: string) => ({ sessionId: 'capture-session', cwd, source,
        instructions: 'Review the selected head only.', reviewers: [reviewer] });
      expect(await executor.execute('review.start', inputFor(fixture.rootPath), { surface: 'ui' })).toMatchObject({ ok: true });
      await writeFile(join(fixture.rootPath, 'unrelated.txt'), 'later ambient change\n');
      runScmExecutable(fixture.rootPath, 'git', ['add', '--', 'unrelated.txt']);
      runScmExecutable(fixture.rootPath, 'git', ['commit', '-m', 'later ambient head']);
      expect(runScmExecutable(fixture.rootPath, 'git', ['rev-parse', 'HEAD'])).not.toBe(selectedHead);
      expect(runScmExecutable(neighbor, 'git', ['rev-parse', 'HEAD'])).toBe(selectedHead);
      expect(await executor.execute('review.start', inputFor(neighbor), { surface: 'ui' })).toMatchObject({ ok: true });
      expect(bindings).toHaveLength(2);
      for (const [index, cwd] of [fixture.rootPath, neighbor].entries()) {
        const binding = bindings[index]!;
        const saved = await records.read(binding.reviewId);
        const capture = saved?.rounds[0]?.comparisonCapture?.input;
        expect(capture).toMatchObject({ source });
        const prepared = await executor.execute('review.prepare_round', { reviewRound: binding,
          reviewInput: { ...inputFor(cwd), comparisonId: capture?.comparisonId }, comparisonCapture: capture,
          previousRoundContext: null }, { surface: 'ui' });
        expect(prepared, JSON.stringify(prepared)).toMatchObject({ ok: true });
        if (!prepared.ok) throw new Error(prepared.error);
        const comparison = ReviewPreparedRoundV1Schema.parse(prepared.result).comparison;
        expect(comparison).toMatchObject({ endpoints: { before: fixture.headCommit, after: selectedHead },
          inventory: { files: [{ path: 'selected.txt' }] } });
        const intentInput = { comparisonId: comparison!.id, comparison, selectedPaths: ['selected.txt'] };
        expect(await resolveReviewScmScope({ cwd, intentInput })).toMatchObject({ status: 'supported',
          selectedPaths: ['selected.txt'], comparison: { endpoints: { before: fixture.headCommit, after: selectedHead } } });
        expect(await resolveReviewScmScope({ cwd, intentInput: { ...intentInput, selectedPaths: ['unrelated.txt'] } }))
          .toMatchObject({ status: 'unsupported', diagnostics: [{ code: 'invalid_path' }] });
      }
    } finally {
      for (const capture of captures.values()) await deleteCapturedScmComparison({ ...capture, sessionId: 'capture-session' });
      await rm(worktreeParent, { recursive: true, force: true });
      await rm(fixture.rootPath, { recursive: true, force: true });
    }
  }));

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
