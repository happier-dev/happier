import { describe, expect, it, vi, onTestFinished } from 'vitest';
import { mkdtemp, readFile, writeFile, utimes, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScmComparisonSchema, ScmDiffSummaryGenerateOutputSchema, ScmDiffSummaryGenerateSuccessSchema } from '@happier-dev/protocol/scm/diffSummary';
import { ScmDiffSummaryResultEditSchema } from '@happier-dev/protocol/scm/diffSummaryResult';
import { createScmDiffSummaryResultStore, scmDiffSummaryResultStore } from './resultStore';
import { presentReviewFindingCitations } from '@/agent/executionRuns/profiles/review/reviewFindingCitations';
import { configuration } from '@/configuration';
import { runWithScmAccountScope, resolveScmAccountStorageDirectory } from '@/scm/accountScope';
import { executeScmActionOperation } from '@/scm/actions/executeScmActionOperation';
import { ScmDiffSummaryProfile } from '@/agent/runtime/bridges/executionRun/kinds/scmDiffSummary/ScmDiffSummaryProfile';
import type { ExecutionRunProfileStartParams } from '@/agent/executionRuns/profiles/ExecutionRunIntentProfile';
import { retainExecutionRunState } from '@/daemon/executionRunRegistry';

const filesystem = vi.hoisted(() => ({ measuring: false, opens: [] as string[], stats: 0, lstats: 0, directoryReads: 0,
  fileReads: 0, handleStats: 0,
  statPaths: [] as string[], lstatPaths: [] as string[],
  interruptedProjection: null as string | null, projectionWrites: 0,
  measuredProjection: null as string | null, selectionWrites: 0 }));
// Instrument the real filesystem boundary; result parsing, locking and persistence remain real.
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      if (filesystem.measuring) filesystem.opens.push(String(args[0]));
      const handle = await actual.open(...args);
      // Preserve native receivers while counting descriptor operations as well as path APIs.
      return new Proxy(handle, { get(target, key) {
        if (key === 'stat') return (...parameters: Parameters<typeof handle.stat>) => {
          if (filesystem.measuring) { filesystem.handleStats++; filesystem.statPaths.push(String(args[0])); }
          return handle.stat(...parameters);
        };
        if (key === 'readFile') return (...parameters: Parameters<typeof handle.readFile>) => {
          if (filesystem.measuring) filesystem.fileReads++;
          return handle.readFile(...parameters);
        };
        const member: unknown = Reflect.get(target, key, target);
        return typeof member === 'function' ? member.bind(target) : member;
      } });
    },
    readFile: (...args: Parameters<typeof actual.readFile>) => {
      if (filesystem.measuring) {
        filesystem.fileReads++;
        if (typeof args[0] === 'string') filesystem.opens.push(args[0]);
      }
      return actual.readFile(...args);
    },
    stat: (...args: Parameters<typeof actual.stat>) => {
      if (filesystem.measuring) { filesystem.stats++; filesystem.statPaths.push(String(args[0])); }
      return actual.stat(...args);
    },
    lstat: (...args: Parameters<typeof actual.lstat>) => {
      if (filesystem.measuring) { filesystem.lstats++; filesystem.lstatPaths.push(String(args[0])); }
      return actual.lstat(...args);
    },
    readdir: (...args: Parameters<typeof actual.readdir>) => { if (filesystem.measuring) filesystem.directoryReads++; return actual.readdir(...args); },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (String(args[1]) === filesystem.measuredProjection) filesystem.selectionWrites++;
      if (String(args[1]) === filesystem.interruptedProjection && ++filesystem.projectionWrites === 1) {
        throw Object.assign(new Error('Projection publication interrupted'), { code: 'EIO' });
      }
      return actual.rename(...args);
    },
  };
});

const cwd = '/repo';
const comparison = ScmComparisonSchema.parse({
  id: 'comparison-1', source: { kind: 'workingTree' }, repository: { rootPath: cwd }, endpoints: {},
  inventory: { state: 'complete', reasons: [], files: [{ path: 'a.ts', changeKind: 'modified',
    binary: false, generated: false, lockfile: false, evidence: { state: 'available', unifiedDiff: '@@ -1 +1 @@\n-a\n+b' },
    occurrences: [{ id: 'change-1', alias: 'c1', path: 'a.ts', before: { startLine: 1, lineCount: 1 },
      after: { startLine: 1, lineCount: 1 }, position: 0 },
      { id: 'change-2', alias: 'c2', path: 'a.ts', before: { startLine: 3, lineCount: 1 },
        after: { startLine: 3, lineCount: 1 }, position: 1 }],
  }] },
});
const output = ScmDiffSummaryGenerateSuccessSchema.parse({ success: true, sourceKey: comparison.id, comparison,
  metadata: { source: comparison.source, sourceKey: comparison.id }, requestedOutputs: ['summary', 'walkthrough', 'commitPlan'],
  summaryMarkdown: 'Keep the summary', outputs: {
    summary: { state: 'complete', value: { summaryMarkdown: 'Keep the summary' } },
    walkthrough: { state: 'complete', value: { title: 'Original', intro: 'Intro', stops: [
      { id: 's1', title: 'First', explanationMarkdown: 'First explanation', changeRefs: ['change-1'] },
      { id: 's2', title: 'Second', explanationMarkdown: 'Second explanation', changeRefs: ['change-2'] },
    ], otherChangeRefs: [] } },
    commitPlan: { state: 'complete', value: { groups: [{ id: 'g1', message: 'fix: a', rationale: 'Keep plan',
      changeRefs: ['change-1', 'change-2'] }], leftOutChangeRefs: [] } },
  }, analysis: { suppliedChangeRefs: ['change-1', 'change-2'], analysedChangeRefs: ['change-1', 'change-2'], remainingChangeRefs: [] },
});
const modelWalkthrough = { ...output.outputs!.walkthrough!.value!, stops: [
  { ...output.outputs!.walkthrough!.value!.stops[0]!, changeRefs: ['c1'] },
  { ...output.outputs!.walkthrough!.value!.stops[1]!, changeRefs: ['c2'] },
] };

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'happier-scm-results-'));
  const store = createScmDiffSummaryResultStore({ directory });
  const created = await store.create({ cwd, sessionId: 'session-1', output });
  return { directory, store, request: { cwd, sessionId: 'session-1', resultId: created.resultId } };
}

describe('saved SCM requester ownership', () => {
  it('keeps another Account Run cost out of saved-result usage even with full repository access', async () => {
    const accountId = await mkdtemp(join(tmpdir(), 'happier-scm-cost-owner-'));
    onTestFinished(async () => {
      await rm(resolveScmAccountStorageDirectory(join(configuration.activeServerDir, 'runtime', 'scm', 'results'), accountId),
        { recursive: true, force: true });
      await rm(accountId, { recursive: true, force: true });
    });
    const now = Date.now();
    for (const [id, cost] of [[accountId, 1], [`${accountId}-member`, 100]] as const) {
      const runId = `cost-${id.split('/').at(-1)}`;
      await retainExecutionRunState({ runId, callId: runId, sidechainId: runId, sessionId: null, depth: 0,
        requesterWorkAttributionV1: { serverId: 'home', accountId: id, machineId: 'machine', installationId: 'installation' },
        intent: 'scm_diff_summary', backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, backendId: 'codex', instructions: 'Read',
        permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: 'bounded', ioMode: 'request_response',
        launch: { cwd }, status: 'succeeded', startedAtMs: now,
        structuredMeta: { kind: 'scm_diff_summary.v1', payload: { cost: { estimatedUsd: cost } } } });
    }
    expect(await executeScmActionOperation({ actionId: 'scm.diffSummary.result.list', input: { includeUsage: true },
      workingDirectory: cwd, accessPolicy: { kind: 'osUser' }, actionContext: { runtimeAccountId: accountId },
      authorizeSession: async () => true })).toMatchObject({ success: true,
      sevenDayCost: { estimatedUsd: 1, pricedRunCount: 1, unpricedRunCount: 0 } });
  });

  it('publishes retained Run output for its requester when resumed under another Account host scope', async () => {
    const accountId = await mkdtemp(join(tmpdir(), 'happier-scm-publication-owner-'));
    const memberId = `${accountId}-member`;
    onTestFinished(async () => {
      for (const id of [accountId, memberId]) await rm(resolveScmAccountStorageDirectory(
        join(configuration.activeServerDir, 'runtime', 'scm', 'results'), id), { recursive: true, force: true });
      await rm(accountId, { recursive: true, force: true });
    });
    const start: ExecutionRunProfileStartParams = { sessionId: null, runId: 'requester-run', callId: 'call', sidechainId: 'sidechain',
      requesterWorkAttributionV1: { serverId: 'home', accountId, machineId: 'machine', installationId: 'installation' },
      intent: 'scm_diff_summary', backendId: 'claude', backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Summarize', intentInput: { cwd, source: comparison.source, sourceKey: comparison.id, comparison,
        metadata: { source: comparison.source, sourceKey: comparison.id }, outputs: ['summary'] },
      permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'streaming', startedAtMs: 1 };
    const initial = await runWithScmAccountScope(memberId, () => ScmDiffSummaryProfile.onStarted!({ start,
      rawText: '', finishedAtMs: 1 }));
    const pending = ScmDiffSummaryGenerateOutputSchema.parse(initial?.toolResultOutput);
    const resumed = { ...start, intentInput: { ...start.intentInput as Record<string, unknown>, resultId: pending.resultId } };
    const complete = await runWithScmAccountScope(memberId, () => ScmDiffSummaryProfile.onTurnComplete!({ start: resumed,
      previousStructuredMeta: initial?.structuredMeta, turnId: 'turn', rawText: JSON.stringify({ summaryMarkdown: 'Requester Run output' }), finishedAtMs: 2 }));
    expect(complete?.toolResultOutput).toMatchObject({ success: true, summaryMarkdown: 'Requester Run output' });
    const scope = { cwd, resultId: pending.resultId! };
    expect(await runWithScmAccountScope(accountId, () => scmDiffSummaryResultStore.read(scope)))
      .toMatchObject({ success: true, result: { output: { summaryMarkdown: 'Requester Run output' } } });
    expect(await runWithScmAccountScope(memberId, () => scmDiffSummaryResultStore.read(scope)))
      .toMatchObject({ success: false, errorCode: 'result_not_found' });
  });

  it('binds saved result Actions to the admitted Account even when both people can access the repository', async () => {
    const accountId = await mkdtemp(join(tmpdir(), 'happier-scm-action-owner-'));
    const accountDirectory = resolveScmAccountStorageDirectory(join(configuration.activeServerDir, 'runtime', 'scm', 'results'), accountId);
    const memberDirectory = resolveScmAccountStorageDirectory(join(configuration.activeServerDir, 'runtime', 'scm', 'results'), `${accountId}-member`);
    onTestFinished(async () => {
      await rm(accountDirectory, { recursive: true, force: true });
      await rm(memberDirectory, { recursive: true, force: true });
      await rm(accountId, { recursive: true, force: true });
    });
    const saved = await runWithScmAccountScope(accountId, () => scmDiffSummaryResultStore.create({ cwd, output }));
    const read = (principal: string) => executeScmActionOperation({ actionId: 'scm.diffSummary.result.read',
      input: { cwd, resultId: saved.resultId }, workingDirectory: cwd, accessPolicy: { kind: 'osUser' },
      actionContext: { runtimeAccountId: principal }, authorizeSession: async () => true });
    expect(await read(accountId)).toMatchObject({ success: true, result: { resultId: saved.resultId } });
    expect(await read(`${accountId}-member`)).toMatchObject({ success: false });
    expect(await runWithScmAccountScope(`${accountId}-member`, () => read(accountId)))
      .toMatchObject({ success: true, result: { resultId: saved.resultId } });
    expect(await runWithScmAccountScope(accountId, () => read(`${accountId}-member`)))
      .toMatchObject({ success: false });
    expect(await executeScmActionOperation({ actionId: 'scm.diffSummary.result.list', input: {},
      workingDirectory: cwd, accessPolicy: { kind: 'osUser' }, actionContext: { runtimeAccountId: `${accountId}-member` },
      authorizeSession: async () => true })).toMatchObject({ success: true, results: [], count: 0 });
    expect(await executeScmActionOperation({ actionId: 'scm.diffSummary.result.delete',
      input: { cwd, resultId: saved.resultId, expectedRevision: saved.revision },
      workingDirectory: cwd, accessPolicy: { kind: 'osUser' }, actionContext: { runtimeAccountId: `${accountId}-member` },
      authorizeSession: async () => true })).toMatchObject({ success: false });
    expect(await read(accountId)).toMatchObject({ success: true, result: { resultId: saved.resultId } });
    expect(() => scmDiffSummaryResultStore.read({ cwd, resultId: saved.resultId })).toThrow('SCM requester Account is unavailable');
    expect(() => scmDiffSummaryResultStore.list()).toThrow('SCM requester Account is unavailable');
    expect(() => scmDiffSummaryResultStore.delete({ cwd, resultId: saved.resultId, expectedRevision: saved.revision }))
      .toThrow('SCM requester Account is unavailable');
    expect(await executeScmActionOperation({ actionId: 'scm.diffSummary.result.clear',
      input: { results: [{ cwd, resultId: saved.resultId, comparisonId: comparison.id, expectedRevision: saved.revision }] },
      workingDirectory: cwd, accessPolicy: { kind: 'osUser' }, authorizeSession: async () => true }))
      .toMatchObject({ success: false, errorCode: 'result_unavailable' });
    expect(await read(accountId)).toMatchObject({ success: true, result: { resultId: saved.resultId } });
  });

  it('keeps requester results private across creation, publication, inventory and later mutation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-scm-account-results-'));
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const requester = createScmDiffSummaryResultStore({ directory, accountId: 'manage-requester' });
    const member = createScmDiffSummaryResultStore({ directory, accountId: 'folder-member' });
    const result = await requester.create({ cwd, output });
    const scope = { cwd, resultId: result.resultId };
    expect(await member.list()).toMatchObject({ results: [], count: 0 });
    expect(await member.read(scope)).toMatchObject({ success: false, errorCode: 'result_not_found' });
    expect(await member.edit({ ...scope, expectedRevision: result.revision,
      edit: { kind: 'renameWalkthrough', title: 'Foreign change' } })).toMatchObject({ success: false, errorCode: 'result_not_found' });
    expect(await member.delete({ ...scope, expectedRevision: result.revision })).toMatchObject({ success: false, errorCode: 'result_not_found' });
    expect(await requester.beginInput({ ...scope, inputId: 'requester-turn', outputs: ['summary'],
      expectedRevision: result.revision })).toMatchObject({ success: true });
    expect(await member.publish({ ...scope, inputId: 'requester-turn',
      modelOutput: { summaryMarkdown: 'Foreign publication' } })).toMatchObject({ success: false, errorCode: 'result_not_found' });
    expect(await requester.publish({ ...scope, inputId: 'requester-turn',
      modelOutput: { summaryMarkdown: 'Requester publication' } })).toMatchObject({ success: true,
      result: { output: { summaryMarkdown: 'Requester publication' } } });
    const reopened = createScmDiffSummaryResultStore({ directory, accountId: 'manage-requester' });
    expect(await reopened.read(scope)).toMatchObject({ success: true,
      result: { output: { summaryMarkdown: 'Requester publication' } } });
    expect(await member.list()).toMatchObject({ results: [], count: 0 });
    expect(await reopened.list()).toMatchObject({ results: [{ resultId: result.resultId }], count: 1 });
  });
});

async function setupPartialApplication() {
  const { store, request } = await setup();
  const moved = await store.edit({ ...request, expectedRevision: 0, edit: { kind: 'moveCommitChanges',
    changeRefs: ['change-2'], target: { kind: 'newGroup', group: { id: 'g2', message: 'fix: second', rationale: 'Second' } },
  } });
  if (!moved.success) throw new Error('Could not prepare two groups');
  const plan = moved.result.output.outputs!.commitPlan!.value!;
  expect(await store.beginInput({ ...request, expectedRevision: 1, outputs: ['commitPlan'], inputId: 'before-application' }))
    .toMatchObject({ success: true });
  expect(await store.beginApplication({ ...request, expectedRevision: 1, acceptance: {
    ...plan, comparisonId: comparison.id, repositoryRootPath: cwd, expectedHeadOid: 'a'.repeat(40), expectedRef: 'refs/heads/main',
  } })).toMatchObject({ success: true });
  expect(await store.mutateApplication(request, (result) => ({ ...result.application!, status: 'failed', nextGroupIndex: 1,
    steps: [{ groupId: 'g1', state: 'published', commitSha: 'b'.repeat(40), actualMessage: 'Hook-rewritten actual message' },
      { groupId: 'g2', state: 'not_published' }],
  }))).toMatchObject({ success: true, result: { revision: 3 } });
  return { store, request, plan };
}

describe('saved SCM result owner', () => {
  it('writes the selection index once per save and restores the changed title after restart', async () => {
    const { directory, store, request } = await setup();
    filesystem.measuredProjection = join(directory, 'selection.json');
    filesystem.selectionWrites = 0;
    try {
      expect(await store.edit({ ...request, expectedRevision: 0, edit: { kind: 'renameWalkthrough', title: 'One indexed write' } }))
        .toMatchObject({ success: true, result: { revision: 1 } });
      expect(filesystem.selectionWrites).toBe(1);
    } finally { filesystem.measuredProjection = null; }
    expect(await createScmDiffSummaryResultStore({ directory }).list()).toMatchObject({ results: [{ revision: 1, title: 'One indexed write' }] });
  });
  it('keeps revision, Undo and publication unchanged when renaming to the current title', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-scm-rename-noop-'));
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const onChanged = vi.fn();
    const store = createScmDiffSummaryResultStore({ directory, onChanged });
    const saved = await store.create({ cwd, output });
    const scope = { cwd, resultId: saved.resultId };
    const renamed = await store.edit({ ...scope, expectedRevision: 0, edit: { kind: 'renameWalkthrough', title: 'Renamed' } });
    expect(renamed).toMatchObject({ success: true, result: { revision: 1, canUndo: true } });
    onChanged.mockClear();
    expect(await store.edit({ ...scope, expectedRevision: 1, edit: { kind: 'renameWalkthrough', title: 'Renamed' } })).toEqual(renamed);
    expect(onChanged).not.toHaveBeenCalled();
    expect(await store.undo({ ...scope, expectedRevision: 1 })).toMatchObject({ success: true,
      result: { revision: 2, output: { outputs: { walkthrough: { value: { title: 'Original' } } } } } });
  });

  it('publishes each persisted apply and Stop revision, and publishes nothing for reads or refused edits', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-scm-result-push-'));
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const onChanged = vi.fn();
    const store = createScmDiffSummaryResultStore({ directory, ...{ onChanged } });
    const saved = await store.create({ cwd, output });
    const scope = { cwd, resultId: saved.resultId };
    onChanged.mockClear();
    const plan = saved.output.outputs!.commitPlan!.value!;
    await store.beginApplication({ ...scope, expectedRevision: 0, acceptance: { ...plan,
      comparisonId: comparison.id, repositoryRootPath: cwd, expectedHeadOid: 'a'.repeat(40), expectedRef: 'refs/heads/main' } });
    await store.mutateApplication(scope, result => ({ ...result.application!, steps: [{ groupId: 'g1', state: 'writing' }] }));
    await store.mutateApplication(scope, async result => ({ ...result.application!, stopAfterCurrent: true }));
    expect(onChanged.mock.calls.map(([change]) => change)).toEqual([1, 2, 3].map(revision => ({ resultId: saved.resultId, revision })));
    const reread = await createScmDiffSummaryResultStore({ directory }).read(scope);
    expect(reread).toMatchObject({ success: true, result: { revision: 3, application: { stopAfterCurrent: true } } });
    await store.read(scope);
    await store.mutateApplication(scope, result => result.application!);
    await store.edit({ ...scope, expectedRevision: 0, edit: { kind: 'renameWalkthrough', title: 'Stale' } });
    expect(onChanged).toHaveBeenCalledTimes(3);
  });

  it('selects one comparison from retained metadata without parsing unrelated bodies, including after restart', async () => {
    const { directory, store, request } = await setup();
    for (let index = 0; index < 128; index++) {
      await store.create({ cwd: `/unrelated/${index}`, output });
    }
    const reopened = createScmDiffSummaryResultStore({ directory });
    const parse = JSON.parse;
    let bodyParses = 0;
    let projectionParses = 0;
    Object.assign(filesystem, { measuring: true, opens: [], stats: 0, lstats: 0, directoryReads: 0,
      fileReads: 0, handleStats: 0, statPaths: [], lstatPaths: [] });
    const spy = vi.spyOn(JSON, 'parse').mockImplementation((text, reviver) => {
      if (typeof text === 'string' && text.startsWith('{"result":')) bodyParses++;
      if (typeof text === 'string' && text.startsWith('{"v":1,"entries":')) projectionParses++;
      return parse(text, reviver);
    });
    try {
      const selected = await reopened.list({ query: { cwd, sessionId: 'session-1', comparisons: [
        { comparisonId: comparison.id, source: comparison.source, outputs: ['walkthrough'] },
      ] } });
      console.info('saved-result selection cost', { retainedResults: 129, bodyParses, projectionParses, fileOpens: filesystem.opens.length,
        fileReads: filesystem.fileReads, stats: filesystem.stats, handleStats: filesystem.handleStats,
        lstats: filesystem.lstats, directoryReads: filesystem.directoryReads });
      expect(bodyParses).toBe(0);
      expect(projectionParses).toBe(1);
      expect(selected.results.map(item => item.resultId)).toEqual([request.resultId]);
      expect(filesystem.opens.filter(path => path === join(directory, 'selection.json'))).toHaveLength(1);
      expect(filesystem.opens.filter(path => /[a-f0-9-]{36}\.json$/.test(path))).toHaveLength(0);
      expect(filesystem.statPaths.filter(path => /[a-f0-9-]{36}\.json$/.test(path))).toHaveLength(0);
      expect(filesystem.lstatPaths.filter(path => /[a-f0-9-]{36}\.json$/.test(path))).toHaveLength(0);
      expect(await reopened.read(request)).toMatchObject({ success: true, result: { resultId: request.resultId } });
      expect(bodyParses).toBe(1);
      bodyParses = 0;
      expect((await reopened.list()).count).toBe(129);
      expect(bodyParses).toBe(0);
      await rm(join(directory, 'selection.json'));
      bodyParses = 0;
      projectionParses = 0;
      Object.assign(filesystem, { opens: [], stats: 0, lstats: 0, directoryReads: 0,
        fileReads: 0, handleStats: 0, statPaths: [], lstatPaths: [] });
      const repaired = await createScmDiffSummaryResultStore({ directory }).list({ query: { cwd, sessionId: 'session-1',
        comparisons: [{ comparisonId: comparison.id, source: comparison.source, outputs: ['walkthrough'] }] } });
      console.info('saved-result cold repair cost', { retainedResults: 129, bodyParses, projectionParses,
        fileOpens: filesystem.opens.length, fileReads: filesystem.fileReads, stats: filesystem.stats,
        handleStats: filesystem.handleStats, lstats: filesystem.lstats,
        directoryReads: filesystem.directoryReads });
      expect(repaired.results.map(item => item.resultId)).toEqual([request.resultId]);
      expect(bodyParses).toBe(129);
    } finally { spy.mockRestore(); filesystem.measuring = false; }
  });
  it('recovers missing projections, isolates malformed unrelated bodies, and keeps edits, Undo and deletion current', async () => {
    const { directory, store, request } = await setup();
    const unrelated = await store.create({ cwd: '/other', output });
    await rm(join(directory, 'selection.json'), { force: true });
    await writeFile(join(directory, `${unrelated.resultId}.json`), '{broken');
    const reopened = createScmDiffSummaryResultStore({ directory });
    expect((await reopened.list()).results.map(item => item.resultId)).toEqual([request.resultId]);
    expect(await reopened.edit({ ...request, expectedRevision: 0, edit: { kind: 'renameWalkthrough', title: 'Current title' } }))
      .toMatchObject({ success: true });
    expect(await reopened.list()).toMatchObject({ results: [{ revision: 1, title: 'Current title' }] });
    expect(await reopened.undo({ ...request, expectedRevision: 1 })).toMatchObject({ success: true });
    expect(await createScmDiffSummaryResultStore({ directory }).list()).toMatchObject({ results: [{ revision: 2, title: 'Original' }] });
    expect(await reopened.delete({ ...request, expectedRevision: 2 })).toMatchObject({ success: true });
    expect(await reopened.list()).toMatchObject({ count: 0 });
  });
  it('recovers a missing projection when its first publication fails without losing the committed body', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-scm-result-missing-projection-'));
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const store = createScmDiffSummaryResultStore({ directory });
    filesystem.interruptedProjection = join(directory, 'selection.json');
    filesystem.projectionWrites = 0;
    let resultId: string;
    try {
      const saved = await store.create({ cwd, output });
      resultId = saved.resultId;
      expect(saved).toMatchObject({ revision: 0 });
      expect(filesystem.projectionWrites).toBe(1);
    } finally { filesystem.interruptedProjection = null; }
    let deadPid = 999_999;
    for (;; deadPid++) {
      try { process.kill(deadPid, 0); }
      catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ESRCH') break;
        if (!(error instanceof Error && 'code' in error && (error.code === 'EPERM' || error.code === 'EACCES'))) throw error;
      }
    }
    // Canonical current-owner vector with an OS-verified unused PID.
    // Fresh wall-clock timestamps ensure the shelf's Infinity stale age cannot reclaim it.
    await writeFile(join(directory, 'selection.json.lock'), JSON.stringify({ pid: deadPid,
      ownerToken: 'interrupted-shelf-writer', processStartedAtMs: 1, createdAtMs: Date.now(), updatedAtMs: Date.now() }));
    const reopened = createScmDiffSummaryResultStore({ directory });
    expect(await reopened.list()).toMatchObject({ count: 1, results: [{ resultId, revision: 0, title: 'Original' }] });
    expect(await reopened.read({ cwd, resultId })).toMatchObject({ success: true, result: { revision: 0 } });
  });
  it('keeps concurrent writers on different results in the same rebuildable shelf', async () => {
    const { directory, store, request } = await setup();
    const second = await store.create({ cwd, sessionId: request.sessionId, output });
    const other = createScmDiffSummaryResultStore({ directory });
    await Promise.all([
      store.edit({ ...request, expectedRevision: 0, edit: { kind: 'renameWalkthrough', title: 'First edit' } }),
      other.edit({ ...request, resultId: second.resultId, expectedRevision: 0, edit: { kind: 'renameWalkthrough', title: 'Second edit' } }),
    ]);
    const inventory = await createScmDiffSummaryResultStore({ directory }).list();
    expect(inventory.results.map(item => item.title).sort()).toEqual(['First edit', 'Second edit']);
    expect(inventory.results.map(item => item.revision)).toEqual([1, 1]);
  });
  it('selects outputs independently and restores an older published value behind a newer failed attempt', async () => {
    const { store, request } = await setup();
    const failed = await store.create({ cwd, sessionId: request.sessionId, output: ScmDiffSummaryGenerateOutputSchema.parse({
      ...output, requestedOutputs: ['walkthrough'], outputs: { walkthrough: { state: 'failed', reasonCode: 'SUMMARY_FAILED', reason: 'Failed attempt' } },
    }) });
    const proposal = await store.create({ cwd, sessionId: request.sessionId, output: ScmDiffSummaryGenerateOutputSchema.parse({
      ...output, requestedOutputs: ['commitPlan'], outputs: { commitPlan: output.outputs!.commitPlan },
    }) });
    const query = { cwd, sessionId: request.sessionId, comparisons: [{ comparisonId: comparison.id,
      source: comparison.source, outputs: ['walkthrough', 'commitPlan'] satisfies Array<'walkthrough' | 'commitPlan'> }] };
    const selected = await store.list({ query });
    expect(new Set(selected.results.map(item => item.resultId))).toEqual(new Set([request.resultId, proposal.resultId]));
    expect(selected.results.map(item => item.resultId)).not.toContain(failed.resultId);
  });
  it.each([false, true])('persists a PR draft generation receipt independently of cache reuse (unknown: %s)', async unknown => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-scm-draft-receipt-'));
    const store = createScmDiffSummaryResultStore({ directory });
    const pending = ScmDiffSummaryGenerateOutputSchema.parse({ ...output, requestedOutputs: ['summary'], outputs: { summary: { state: 'pending' } } });
    const saved = await store.create({ cwd, output: pending, pullRequestDraftEvidence: '{}' });
    const receipt = { ...saved.output, inputId: 'draft-input', ...(unknown ? { admission: 'outcomeUnknown' as const } : { runId: 'draft-run' }) };
    await store.admitGeneration({ cwd, key: 'draft-key', outputs: ['summary'], bypass: true }, async () => receipt);
    const reopened = createScmDiffSummaryResultStore({ directory });
    expect(await reopened.read({ cwd, resultId: saved.resultId })).toMatchObject({ success: true, result: { output: receipt } });
    expect(await reopened.readStoredScope({ cwd, resultId: saved.resultId })).toMatchObject({ pullRequestDraftEvidence: '{}' });
    const ordinary = await reopened.admitGeneration({ cwd, key: 'draft-key', outputs: ['summary'] }, async () => (await store.create({ cwd, output: pending })).output);
    expect(ordinary.resultId).not.toBe(saved.resultId);
  });
  it('retains a discussion input without granting any result publication', async () => {
    const { directory, store, request } = await setup();
    const before = await store.read(request);
    expect(await store.beginInput({ ...request, inputId: 'discussion', expectedRevision: 0, outputs: [], stopIds: ['s1'] }))
      .toMatchObject({ success: true });
    const reopened = createScmDiffSummaryResultStore({ directory });
    expect(await reopened.readInput({ ...request, inputIds: ['discussion'] })).toMatchObject({ outputs: [], stopIds: ['s1'] });
    expect(await reopened.publish({ ...request, inputId: 'discussion', modelOutput: { walkthrough: modelWalkthrough } }))
      .toMatchObject({ success: false, errorCode: 'invalid_output' });
    expect(await reopened.publishProgress({ ...request, inputId: 'discussion', expectedRevision: 0, output }))
      .toMatchObject({ success: false, errorCode: 'invalid_output' });
    expect(await reopened.read(request)).toEqual(before);
  });
  it('keeps PR drafting evidence private and requires the requested body before publishing a complete summary', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-scm-pr-draft-'));
    const store = createScmDiffSummaryResultStore({ directory });
    const saved = await store.create({ cwd, output, pullRequestDraftEvidence: '{"testing":{"state":"unavailable"}}' });
    const scope = { cwd, resultId: saved.resultId };
    const admission = { cwd, key: 'same-comparison-and-model', outputs: ['summary'] as const };
    await store.admitGeneration({ ...admission, bypass: true }, async () => saved.output);
    const ordinary = await store.admitGeneration(admission, async () => (await store.create({ cwd, output })).output);
    expect(ordinary.resultId).not.toBe(saved.resultId);
    expect(await store.readStoredScope(scope)).toMatchObject({ pullRequestDraftEvidence: '{"testing":{"state":"unavailable"}}' });
    expect(await store.read(scope)).not.toHaveProperty('result.pullRequestDraftEvidence');
    await store.beginInput({ ...scope, inputId: 'draft', expectedRevision: 0, outputs: ['summary'] });
    expect(await store.publish({ ...scope, inputId: 'draft', modelOutput: { summaryMarkdown: 'No body' } }))
      .toMatchObject({ success: false, errorCode: 'invalid_output' });
    expect(await store.publishProgress({ ...scope, expectedRevision: 0, output }))
      .toMatchObject({ success: false, errorCode: 'invalid_output' });
    const body = '## Changes\nCaptured change\n## Testing\nTesting evidence is unavailable.';
    expect(await store.publish({ ...scope, inputId: 'draft', modelOutput: { summaryMarkdown: 'Summary', suggestedPrBody: body } }))
      .toMatchObject({ success: true, result: { revision: 1, output: { outputs: { summary: { value: { suggestedPrBody: body } } } } } });
    expect(await store.edit({ ...scope, expectedRevision: 1, edit: { kind: 'replaceSummary',
      value: { summaryMarkdown: 'Edited', suggestedPrBody: `${body}\nHuman edit` } } })).toMatchObject({ success: true });
    expect(await store.undo({ ...scope, expectedRevision: 2 })).toMatchObject({ success: true,
      result: { output: { outputs: { summary: { value: { suggestedPrBody: body } } } } } });
    expect(await createScmDiffSummaryResultStore({ directory }).readStoredScope(scope))
      .toMatchObject({ pullRequestDraftEvidence: '{"testing":{"state":"unavailable"}}' });
  });
  it('carries suggested questions through publication, revisioned edits, merge and Undo', async () => {
    const { directory, store, request } = await setup();
    const questions = ['Why keep the selected change?', 'Which test covers the second change?'];
    await store.beginInput({ ...request, expectedRevision: 0, inputId: 'questions', outputs: ['walkthrough'] });
    const published = await store.publish({ ...request, inputId: 'questions', modelOutput: { walkthrough: {
      ...modelWalkthrough, stops: modelWalkthrough.stops.map((stop, index) => ({ ...stop, suggestedQuestions: [questions[index]!] })),
    } } });
    expect(published).toMatchObject({ success: true, result: { revision: 1 } });
    const reloaded = createScmDiffSummaryResultStore({ directory });
    expect(await reloaded.read(request)).toMatchObject({ success: true, result: { output: { outputs: {
      walkthrough: { value: { stops: questions.map(question => ({ suggestedQuestions: [question] })) } },
      summary: output.outputs?.summary, commitPlan: output.outputs?.commitPlan,
    } } } });
    await reloaded.edit({ ...request, expectedRevision: 1, edit: { kind: 'renameStop', stopId: 's2', title: 'My title' } });
    expect(await reloaded.edit({ ...request, expectedRevision: 2, edit: { kind: 'mergeStops', stopIds: ['s1', 's2'],
      targetStopId: 's2', explanationMarkdown: 'Both changes' } })).toMatchObject({ success: true, result: { revision: 3,
      output: { outputs: { walkthrough: { value: { stops: [{ title: 'My title', suggestedQuestions: questions }] } } } },
    } });
    expect(await reloaded.undo({ ...request, expectedRevision: 2 })).toMatchObject({ success: false, errorCode: 'revision_conflict' });
    expect(await reloaded.undo({ ...request, expectedRevision: 3 })).toMatchObject({ success: true, result: { revision: 4,
      output: { outputs: { walkthrough: { value: { stops: questions.map(question => ({ suggestedQuestions: [question] })) } } } },
    } });
  });
  it('publishes a refined walkthrough with omitted changes reachable in Other changes without changing analysis or other outputs', async () => {
    const { store, request } = await setup();
    await store.beginInput({ ...request, expectedRevision: 0, inputId: 'refinement', outputs: ['walkthrough'] });
    const published = await store.publish({ ...request, inputId: 'refinement', modelOutput: { walkthrough: {
      ...modelWalkthrough, title: 'Refined', stops: [modelWalkthrough.stops[0]], otherChangeRefs: [],
    } } });
    expect(published).toMatchObject({ success: true, result: { revision: 1, output: {
      analysis: output.analysis,
      outputs: { summary: output.outputs?.summary, commitPlan: output.outputs?.commitPlan,
        walkthrough: { state: 'complete', value: { title: 'Refined', stops: [output.outputs!.walkthrough!.value!.stops[0]],
          otherChangeRefs: ['change-2'] } } },
    } } });
    expect(await store.read(request)).toEqual(published);
    if (!published.success) throw new Error(published.error);
    expect(ScmDiffSummaryGenerateOutputSchema.safeParse(published.result.output).success).toBe(true);
  });
  it('normalizes additive stored fields across read, inventory and canonical edit writes without relaxing known fields or model inputs', async () => {
    const { directory, store, request } = await setup();
    const file = join(directory, `${request.resultId}.json`);
    const renamed = await store.edit({ ...request, expectedRevision: 0, edit: { kind: 'renameWalkthrough', title: 'Stored title' } });
    if (!renamed.success) throw new Error(renamed.error);
    await store.beginInput({ ...request, inputId: 'pending', expectedRevision: 1, outputs: ['summary'] });
    const canonical = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    const withExtras = { ...canonical, future: true,
      result: { ...renamed.result, future: true, output: { ...renamed.result.output, future: true,
        comparison: { ...comparison, future: true, repository: { ...comparison.repository, future: true },
          inventory: { ...comparison.inventory, future: true, files: comparison.inventory.files.map(file => ({ ...file,
            future: true, evidence: { ...file.evidence, future: true },
            occurrences: file.occurrences.map(occurrence => ({ ...occurrence, future: true, before: { ...occurrence.before, future: true } })),
          })) } },
      }, walkthroughProvenance: { ...renamed.result.walkthroughProvenance, future: true } },
      undoOutput: { ...output, future: true },
      inputs: [{ inputId: 'pending', baseRevision: 1, outputs: ['summary'], future: true }],
      generation: { key: 'stored-key', future: true },
    };
    await writeFile(file, JSON.stringify(withExtras));
    expect(await store.read(request)).toEqual(renamed);
    expect(await store.list()).toMatchObject({ count: 1, results: [{ resultId: request.resultId, title: 'Stored title', revision: 1 }] });
    expect(await store.readInput({ ...request, inputIds: ['pending'] })).toEqual({ inputId: 'pending', baseRevision: 1, outputs: ['summary'] });
    expect(await store.read({ ...request, cwd: '/another-repo' })).toMatchObject({ success: false, errorCode: 'result_not_found' });
    expect(await store.read({ ...request, sessionId: 'another-session' })).toMatchObject({ success: false, errorCode: 'result_not_found' });
    expect(await store.edit({ ...request, expectedRevision: 0, edit: { kind: 'renameWalkthrough', title: 'Stale' } }))
      .toMatchObject({ success: false, errorCode: 'revision_conflict' });
    expect(await store.publish({ ...request, inputId: 'pending', modelOutput: { summaryMarkdown: 'Invalid', future: true } }))
      .toMatchObject({ success: false, errorCode: 'invalid_output' });
    expect(await store.edit({ ...request, expectedRevision: 1, edit: { kind: 'renameWalkthrough', title: 'Current' } }))
      .toMatchObject({ success: true, result: { revision: 2 } });
    expect(await readFile(file, 'utf8')).not.toContain('"future"');
    await writeFile(file, JSON.stringify({ ...withExtras, result: { ...withExtras.result, revision: -1 } }));
    await rm(join(directory, 'selection.json'), { force: true });
    await expect(store.read(request)).rejects.toThrow();
    await expect(store.list()).resolves.toMatchObject({ count: 0 });
  });
  it('keeps the admitted revision basis across same-input completion progress, manual edits and Undo', async () => {
    const store = createScmDiffSummaryResultStore({ directory: await mkdtemp(join(tmpdir(), 'scm-part-admission-')) });
    const created = await store.create({ cwd: '/repo', output });
    const scope = { cwd: '/repo', resultId: created.resultId };
    await store.beginInput({ ...scope, inputId: 'part', expectedRevision: created.revision, outputs: ['summary'] });
    const progress = await store.publishProgress({ ...scope, inputId: 'part', expectedRevision: created.revision, preserveUndo: true,
      output: ScmDiffSummaryGenerateOutputSchema.parse({ ...created.output, analysis: { ...created.output.analysis,
        parts: { completed: 1, total: 3, phase: 'evidence' } } }) });
    expect(progress).toMatchObject({ success: true });
    const published = await store.publish({ ...scope, inputId: 'part', modelOutput: { summaryMarkdown: 'Completed part' } });
    expect(published).toMatchObject({ success: true, result: { output: { outputs: { summary: { value: { summaryMarkdown: 'Completed part' } } } } } });
    if (!published.success) throw new Error(published.error);
    await store.beginInput({ ...scope, inputId: 'next-part', expectedRevision: published.result.revision, outputs: ['summary'] });
    const nextProgress = await store.publishProgress({ ...scope, inputId: 'next-part', expectedRevision: published.result.revision,
      preserveUndo: true, output: ScmDiffSummaryGenerateOutputSchema.parse({ ...published.result.output,
        analysis: { ...published.result.output.analysis, parts: { completed: 2, total: 3, phase: 'evidence' } } }) });
    if (!nextProgress.success) throw new Error(nextProgress.error);
    await store.edit({ ...scope, expectedRevision: nextProgress.result.revision,
      edit: { kind: 'replaceSummary', value: { summaryMarkdown: 'Manual intervening edit' } } });
    expect(await store.publish({ ...scope, inputId: 'next-part', modelOutput: { summaryMarkdown: 'Late model output' } }))
      .toMatchObject({ success: false, errorCode: 'revision_conflict' });
    const current = await store.read(scope);
    if (!current.success) throw new Error(current.error);
    const later = await store.publishProgress({ ...scope, expectedRevision: current.result.revision,
      output: ScmDiffSummaryGenerateOutputSchema.parse({ ...current.result.output, summaryMarkdown: 'Later native part', outputs: { ...current.result.output.outputs,
        summary: { state: 'writing', value: { summaryMarkdown: 'Later native part' } } },
        analysis: { ...current.result.output.analysis, parts: { completed: 3, total: 4, phase: 'merge' } } }) });
    if (!later.success) throw new Error(later.error);
    expect(await store.undo({ ...scope, expectedRevision: later.result.revision })).toMatchObject({ success: true, result: {
      output: { outputs: { summary: { value: { summaryMarkdown: 'Manual intervening edit' } } },
        analysis: { parts: { completed: 3, total: 4, phase: 'merge' } } },
    } });
  });
  it('projects edited titles, moved/changed stops and the immediate update notice across reload and Undo', async () => {
    const { directory, store, request } = await setup();
    const renamed = await store.edit({ ...request, expectedRevision: 0, edit: { kind: 'renameStop', stopId: 's2', title: 'My title' } });
    expect(renamed).toMatchObject({ success: true, result: { walkthroughProvenance: { stops: [
      { stopId: 's1', titleEdited: false }, { stopId: 's2', titleEdited: true, changedAtRevision: 1 },
    ] }, updateNotice: { kind: 'edit', revision: 1, affectedStopIds: ['s2'] } } });
    const moved = await store.edit({ ...request, expectedRevision: 1, edit: { kind: 'reorderStops', stopIds: ['s2', 's1'] } });
    expect(moved).toMatchObject({ success: true, result: { walkthroughProvenance: { stops: [
      { stopId: 's2', titleEdited: true, movedAtRevision: 2 }, { stopId: 's1', movedAtRevision: 2 },
    ] } } });
    const merged = await store.edit({ ...request, expectedRevision: 2, edit: { kind: 'mergeStops', stopIds: ['s1', 's2'],
      targetStopId: 's2', explanationMarkdown: 'Together' } });
    expect(merged).toMatchObject({ success: true, result: { updateNotice: { kind: 'edit', revision: 3,
      mergedStopIds: ['s1', 's2'] }, walkthroughProvenance: { stops: [{ stopId: 's2', titleEdited: true,
      changedAtRevision: 3 }] } } });
    const reloaded = createScmDiffSummaryResultStore({ directory });
    expect(await reloaded.read(request)).toEqual(merged);
    const undone = await reloaded.undo({ ...request, expectedRevision: 3 });
    expect(undone).toMatchObject({ success: true, result: { canUndo: false, updateNotice: { kind: 'undo', revision: 4 },
      walkthroughProvenance: { stops: [{ stopId: 's2', titleEdited: true, movedAtRevision: 2 }, { stopId: 's1', titleEdited: false }] } } });
  });
  it('joins generation from another host owner, returns current edits, and honors explicit bypass', async () => {
    const { directory, store } = await setup();
    const anotherHost = createScmDiffSummaryResultStore({ directory });
    const input = { cwd, sessionId: 'session-1', key: 'comparison-and-selection', outputs: output.requestedOutputs! };
    const generate = async () => {
      const saved = await store.create({ cwd, sessionId: input.sessionId, output });
      return { ...saved.output, runId: `run-${saved.resultId}` };
    };
    const [first, second] = await Promise.all([
      store.admitGeneration(input, generate), anotherHost.admitGeneration(input, generate),
    ]);
    expect(second).toMatchObject({ resultId: first.resultId, runId: first.runId });
    const scope = { cwd, sessionId: input.sessionId, resultId: first.resultId! };
    await store.edit({ ...scope, expectedRevision: first.revision!, edit: { kind: 'renameWalkthrough', title: 'Manual title' } });
    const reuse = await anotherHost.admitGeneration(input, async () => { throw new Error('Must reuse saved edits'); });
    expect(reuse).toMatchObject({ resultId: first.resultId, revision: first.revision! + 1,
      outputs: { walkthrough: { value: { title: 'Manual title' } } } });
    const bypassed = await anotherHost.admitGeneration({ ...input, bypass: true }, generate);
    expect(bypassed.resultId).not.toBe(first.resultId);
    await store.edit({ ...scope, expectedRevision: reuse.revision!, edit: { kind: 'removeOutput', output: 'walkthrough' } });
    await anotherHost.delete({ cwd, sessionId: input.sessionId, resultId: bypassed.resultId!, expectedRevision: bypassed.revision! });
    const afterDiscard = await anotherHost.admitGeneration(input, generate);
    expect(afterDiscard.resultId).not.toBe(first.resultId);
    expect(afterDiscard.outputs?.walkthrough?.state).toBe('complete');
  });

  it('retains ambiguous admission failure without retrying until an explicit bypass', async () => {
    const { store } = await setup();
    const input = { cwd, sessionId: 'session-1', key: 'ambiguous-admission', outputs: ['summary'] as const };
    const failed = await store.admitGeneration(input, async () => {
      const saved = await store.create({ cwd, sessionId: input.sessionId, output: { ...output, requestedOutputs: ['summary'],
        outputs: { summary: { state: 'failed', reason: 'Diff-summary execution run start outcome is unknown' } } } });
      return saved.output;
    });
    expect(await store.admitGeneration(input, async () => { throw new Error('Unsafe automatic retry'); }))
      .toMatchObject({ resultId: failed.resultId, outputs: { summary: { state: 'failed' } } });
    const retry = await store.admitGeneration({ ...input, bypass: true }, async () => (await store.create({ cwd,
      sessionId: input.sessionId, output })).output);
    expect(retry.resultId).not.toBe(failed.resultId);
  });

  it('encodes genuine special finding identities without permitting delimiter injection or encoded canonical spoofing', async () => {
    const { store, request } = await setup();
    const citations = [
      { alias: 'F1', runId: 'review', findingId: 'same (id)' },
      { alias: 'F2', runId: 'review', findingId: 'bad) [spoof](finding:other)' },
      { alias: 'F3', runId: 'review', findingId: '\ud800' },
      { alias: 'F4', runId: 'review', findingId: 'literal%20id' },
    ];
    await store.beginInput({ ...request, inputId: 'special-ids', outputs: ['walkthrough'], reviewFindingCitations: citations });
    const published = await store.publish({ ...request, inputId: 'special-ids', modelOutput: { walkthrough: {
      ...modelWalkthrough, stops: [
        { ...modelWalkthrough.stops[0], findingRefs: citations.map(item => item.alias), explanationMarkdown:
          '[spaced](finding:F1) [delimiter](finding:F2) [invalid](finding:F3) [literal](finding:F4) [spoof](finding:review:same%20%28id%29)' },
        modelWalkthrough.stops[1],
      ],
    } } });
    const markdown = '[spaced](finding:review:same%20%28id%29) [delimiter](finding:review:bad%29%20%5Bspoof%5D%28finding:other%29) invalid [literal](finding:review:literal%2520id) spoof';
    expect(published).toMatchObject({ success: true, result: { output: { outputs: { walkthrough: { value: { stops: [
      { findingRefs: citations.map(item => `${item.runId}:${item.findingId}`), explanationMarkdown: markdown },
      output.outputs!.walkthrough!.value!.stops[1],
    ] } } } } } });
    if (!published.success) throw new Error('Special identities did not publish');
    const presented = presentReviewFindingCitations(published.result.output.outputs!.walkthrough!.value!.stops[0], citations);
    expect(presented).toMatchObject({ findingRefs: ['F1', 'F2', 'F3', 'F4'],
      explanationMarkdown: '[spaced](finding:F1) [delimiter](finding:F2) invalid [literal](finding:F4) spoof' });
    expect(presentReviewFindingCitations('[invalid](finding:review:%ZZ)', citations)).toBe('invalid');
    const carried = await store.publishProgress({ ...request, expectedRevision: published.result.revision, output: published.result.output });
    expect(carried).toMatchObject({ success: true, result: { output: { outputs: { walkthrough: { value: { stops: [
      { explanationMarkdown: markdown }, output.outputs!.walkthrough!.value!.stops[1],
    ] } } } } } });
  });
  it('publishes only admitted stop-scoped finding aliases and strips canonical spoof links', async () => {
    const { store, request } = await setup();
    const admission = { ...request, inputId: 'citations', expectedRevision: 0, outputs: ['walkthrough'] as const,
      reviewFindingCitations: [
        { alias: 'F1', runId: 'review-a', findingId: 'same-id' },
        { alias: 'F2', runId: 'review-b', findingId: 'same-id' },
      ] };
    await store.beginInput(admission);
    const published = await store.publish({ ...request, inputId: 'citations', modelOutput: { walkthrough: {
      ...modelWalkthrough, stops: [
        { ...modelWalkthrough.stops[0], findingRefs: ['F1', 'F99'], explanationMarkdown:
          '[first](finding:F1) [outside](finding:F2) [missing](finding:F99) [spoof](finding:review-a:same-id) [titled](finding:review-a:same-id "title") [wrapped](<finding:review-a:same-id>)' },
        { ...modelWalkthrough.stops[1], findingRefs: ['F2'], explanationMarkdown: '[second](finding:F2)' },
      ],
    } } });
    expect(published).toMatchObject({ success: true, result: { output: { outputs: { walkthrough: { value: { stops: [
      { findingRefs: ['review-a:same-id'], explanationMarkdown: '[first](finding:review-a:same-id) outside missing spoof titled wrapped' },
      { findingRefs: ['review-b:same-id'], explanationMarkdown: '[second](finding:review-b:same-id)' },
    ] } } } } } });
  });
  it('does not preserve old unvalidated canonical citations through progressive carryforward', async () => {
    const { store, request } = await setup();
    const walkthrough = output.outputs!.walkthrough!.value!;
    const oldOutput = { ...output, outputs: { ...output.outputs, walkthrough: { state: 'complete' as const,
      value: { ...walkthrough, stops: walkthrough.stops.map(stop => ({ ...stop, findingRefs: ['spoof:unpublished'],
        explanationMarkdown: '[old](finding:spoof:unpublished)' })) } } } };
    const old = await store.create({ cwd, sessionId: request.sessionId, output: oldOutput });
    const published = await store.publishProgress({ cwd, sessionId: request.sessionId, resultId: old.resultId,
      expectedRevision: 0, output: oldOutput });
    expect(published).toMatchObject({ success: true, result: { output: { outputs: { walkthrough: { value: { stops: [
      { findingRefs: [], explanationMarkdown: 'old' }, { findingRefs: [], explanationMarkdown: 'old' },
    ] } } } } } });
  });
  it('uses the exact admitted input finding identity for progressive publication, not another pending alias map', async () => {
    const { store, request } = await setup();
    await store.beginInput({ ...request, inputId: 'earlier', expectedRevision: 0, outputs: ['walkthrough'],
      reviewFindingCitations: [{ alias: 'F1', runId: 'review-a', findingId: 'same-id' }] });
    await store.beginInput({ ...request, inputId: 'current', expectedRevision: 0, outputs: ['walkthrough'],
      reviewFindingCitations: [{ alias: 'F1', runId: 'review-b', findingId: 'same-id' }] });
    const publication = { ...request, expectedRevision: 0, inputId: 'current', output: { ...output,
      outputs: { ...output.outputs, walkthrough: { state: 'writing' as const, value: { ...output.outputs!.walkthrough!.value!,
        stops: output.outputs!.walkthrough!.value!.stops.map(stop => ({ ...stop, findingRefs: ['F1'], explanationMarkdown: '[current](finding:F1)' })) } } } } };
    expect(await store.publishProgress(publication)).toMatchObject({ success: true, result: { output: { outputs: { walkthrough: { value: { stops: [
      { findingRefs: ['review-b:same-id'], explanationMarkdown: '[current](finding:review-b:same-id)' },
      { findingRefs: ['review-b:same-id'], explanationMarkdown: '[current](finding:review-b:same-id)' },
    ] } } } } } });
  });
  it('publishes a separate host-attributed finding explanation without rewriting prose and supports stale-safe Undo', async () => {
    const { store, request } = await setup();
    const targets = [{ stopId: 's1', findingRefs: [{ runId: 'review-1', findingId: 'finding-1' }] }];
    const askedBy = { kind: 'user' as const };
    const begun = await store.beginInput({ ...request, inputId: 'explain', expectedRevision: 0,
      outputs: ['walkthrough'], stopIds: ['s1'], reviewExplanation: { targets, requestedBy: askedBy } });
    expect(begun).toMatchObject({ success: true });
    expect(await store.publish({ ...request, inputId: 'explain', modelOutput: { walkthrough: output.outputs!.walkthrough!.value } }))
      .toMatchObject({ success: false, errorCode: 'invalid_output' });
    expect(await store.publish({ ...request, inputId: 'explain', modelOutput: { reviewExplanations: [
      { stopId: 's2', markdown: 'Wrong target' },
    ] } })).toMatchObject({ success: false, errorCode: 'invalid_output' });
    const published = await store.publish({ ...request, inputId: 'explain',
      modelId: 'selected-model', runId: 'narrator-1', generatedAtMs: 1234,
      modelOutput: { reviewExplanations: [{ stopId: 's1', markdown: 'Why this finding matters.' }] } });
    expect(published).toMatchObject({ success: true, result: { revision: 1, canUndo: true, output: {
      outputs: { summary: output.outputs?.summary, commitPlan: output.outputs?.commitPlan, walkthrough: { value: {
        stops: [{ ...output.outputs!.walkthrough!.value!.stops[0], reviewExplanations: [{ markdown: 'Why this finding matters.',
          findingRefs: targets[0]!.findingRefs, provenance: { requestedBy: askedBy,
            requestedAtMs: expect.any(Number), generatedAtMs: 1234, modelId: 'selected-model', runId: 'narrator-1' } }] }, output.outputs!.walkthrough!.value!.stops[1]],
      } } },
    } } });
    if (!published.success) throw new Error('Explanation did not publish');
    const explained = published.result.output.outputs!.walkthrough!.value!;
    expect(await store.edit({ ...request, expectedRevision: 1, edit: { kind: 'replaceWalkthrough', value: {
      ...explained, stops: explained.stops.map(stop => stop.reviewExplanations ? { ...stop,
        reviewExplanations: stop.reviewExplanations.map(block => ({ ...block, provenance: { ...block.provenance, modelId: 'forged' } })),
      } : stop),
    } } })).toMatchObject({ success: false, errorCode: 'invalid_edit' });
    await store.beginInput({ ...request, inputId: 'stale-explain', expectedRevision: 1,
      outputs: ['walkthrough'], stopIds: ['s1'], reviewExplanation: { targets, requestedBy: askedBy } });
    await store.edit({ ...request, expectedRevision: 1, edit: { kind: 'renameStop', stopId: 's2', title: 'My edit' } });
    expect(await store.publish({ ...request, inputId: 'stale-explain',
      modelOutput: { reviewExplanations: [{ stopId: 's1', markdown: 'Stale explanation' }] } }))
      .toMatchObject({ success: false, errorCode: 'revision_conflict' });
    const undoneRename = await store.undo({ ...request, expectedRevision: 2 });
    expect(undoneRename).toMatchObject({ success: true, result: { output: { outputs: { walkthrough: { value: {
      stops: [{ reviewExplanations: [{ markdown: 'Why this finding matters.' }] }, { title: 'Second' }],
    } } } } } });
    const fresh = await setup();
    await fresh.store.beginInput({ ...fresh.request, inputId: 'explain', expectedRevision: 0,
      outputs: ['walkthrough'], stopIds: ['s1'], reviewExplanation: { targets, requestedBy: askedBy } });
    await fresh.store.publish({ ...fresh.request, inputId: 'explain', modelOutput: { reviewExplanations: [{ stopId: 's1', markdown: 'Explanation' }] } });
    expect(await fresh.store.undo({ ...fresh.request, expectedRevision: 1 }))
      .toMatchObject({ success: true, result: { revision: 2, output: { outputs: output.outputs } } });
  });
  it('preserves host explanations through whole refinement only for unchanged stop selections', async () => {
    const { store, request } = await setup();
    await store.beginInput({ ...request, inputId: 'explain', outputs: ['walkthrough'], stopIds: ['s1'],
      reviewExplanation: { targets: [{ stopId: 's1', findingRefs: [{ runId: 'review', findingId: 'finding' }] }],
        requestedBy: { kind: 'user' } } });
    const explained = await store.publish({ ...request, inputId: 'explain', modelId: 'model', runId: 'run',
      modelOutput: { reviewExplanations: [{ stopId: 's1', markdown: 'Separate explanation' }] } });
    if (!explained.success) throw new Error(explained.error);
    const blocks = explained.result.output.outputs!.walkthrough!.value!.stops[0]!.reviewExplanations;
    const refine = async (inputId: string, revision: number, swap: boolean) => {
      await store.beginInput({ ...request, inputId, expectedRevision: revision, outputs: ['walkthrough'] });
      return store.publish({ ...request, inputId, modelOutput: { walkthrough: {
        ...output.outputs!.walkthrough!.value!, stops: output.outputs!.walkthrough!.value!.stops.map((stop, index) => ({
          ...stop, explanationMarkdown: 'Refined prose', changeRefs: [swap ? `c${2 - index}` : `c${index + 1}`],
        })),
      } } });
    };
    const refined = await refine('whole', 1, false);
    expect(refined).toMatchObject({ success: true, result: { revision: 2, output: { outputs: { walkthrough: { value: {
      stops: [{ explanationMarkdown: 'Refined prose', reviewExplanations: blocks }, {}],
    } } } } } });
    if (!refined.success) throw new Error(refined.error);
    // An explicit user replacement can remove the separate block.
    const withoutBlocks = { ...refined.result.output.outputs!.walkthrough!.value!,
      stops: refined.result.output.outputs!.walkthrough!.value!.stops.map(({ reviewExplanations: _blocks, ...stop }) => stop) };
    const removed = await store.edit({ ...request, expectedRevision: 2, edit: { kind: 'replaceWalkthrough', value: withoutBlocks } });
    expect(removed.success && removed.result.output.outputs!.walkthrough!.value!.stops[0]!.reviewExplanations).toBeUndefined();
    await store.undo({ ...request, expectedRevision: 3 });
    const changed = await refine('changed-selection', 4, true);
    expect(changed.success && changed.result.output.outputs!.walkthrough!.value!.stops[0]!.reviewExplanations).toBeUndefined();
    const forged = await store.beginInput({ ...request, inputId: 'forged', expectedRevision: 5, outputs: ['walkthrough'] });
    expect(forged.success).toBe(true);
    expect(await store.publish({ ...request, inputId: 'forged', modelOutput: { walkthrough: {
      ...output.outputs!.walkthrough!.value!, stops: [{ ...output.outputs!.walkthrough!.value!.stops[0]!, reviewExplanations: blocks },
        output.outputs!.walkthrough!.value!.stops[1]!],
    } } })).toMatchObject({ success: false, errorCode: 'invalid_output' });
  });
  it('keeps separate finding explanation attribution when the user merges stops', async () => {
    const { store, request } = await setup();
    const targets = ['s1', 's2'].map(stopId => ({ stopId, findingRefs: [{ runId: 'review', findingId: stopId }] }));
    await store.beginInput({ ...request, inputId: 'explain', expectedRevision: 0, outputs: ['walkthrough'], stopIds: ['s1', 's2'],
      reviewExplanation: { targets, requestedBy: { kind: 'agent', id: 'session' } } });
    expect(await store.publish({ ...request, inputId: 'explain', modelOutput: { reviewExplanations: targets.map(target => ({ stopId: target.stopId, markdown: target.stopId })) } }))
      .toMatchObject({ success: true });
    expect(await store.edit({ ...request, expectedRevision: 1, edit: { kind: 'mergeStops', stopIds: ['s1', 's2'], targetStopId: 's1', explanationMarkdown: 'Merged prose' } }))
      .toMatchObject({ success: true, result: { output: { outputs: { walkthrough: { value: { stops: [{ explanationMarkdown: 'Merged prose',
        reviewExplanations: [{ markdown: 's1', findingRefs: targets[0]!.findingRefs }, { markdown: 's2', findingRefs: targets[1]!.findingRefs }],
      }] } } } } } });
  });
  it('lists every saved machine result from protected disk with exact revisions, scopes and byte totals', async () => {
    const { directory, store, request } = await setup();
    const another = await store.create({ cwd: '/other', output });
    await store.edit({ ...request, expectedRevision: 0, edit: { kind: 'renameWalkthrough', title: 'My saved title' } });
    await utimes(join(directory, `${request.resultId}.json`), 2, 2);
    await utimes(join(directory, `${another.resultId}.json`), 1, 1);
    await writeFile(join(directory, 'unrelated.tmp'), 'unrelated');
    // A missing rebuildable projection recovers canonical file metadata from disk.
    await rm(join(directory, 'selection.json'), { force: true });
    const reopened = createScmDiffSummaryResultStore({ directory });
    const listed = await reopened.list();
    expect(listed.count).toBe(2);
    expect(listed.results.map(item => ({ resultId: item.resultId, updatedAtMs: item.updatedAtMs })))
      .toEqual([{ resultId: request.resultId, updatedAtMs: 2000 }, { resultId: another.resultId, updatedAtMs: 1000 }]);
    expect(listed.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ ...request, revision: 1, comparisonId: comparison.id, title: 'My saved title', source: comparison.source }),
      expect.objectContaining({ cwd: '/other', resultId: another.resultId, revision: 0 }),
    ]));
    const bytes = (await readFile(join(directory, `${request.resultId}.json`))).byteLength
      + (await readFile(join(directory, `${another.resultId}.json`))).byteLength;
    expect(listed.bytes).toBe(bytes);
    expect(listed.results.reduce((total, item) => total + item.bytes, 0)).toBe(bytes);
    expect(await reopened.delete({ ...request, expectedRevision: 0 })).toMatchObject({ success: false, errorCode: 'revision_conflict' });
    expect(await reopened.delete({ ...request, expectedRevision: 1 })).toMatchObject({ success: true });
    expect((await reopened.list()).results.map(item => item.resultId)).toEqual([another.resultId]);
  });
  it('moves exact commit selections to new groups, left out and existing groups without changing other outputs', async () => {
    const { store, request } = await setup();
    const edit = (expectedRevision: number, command: unknown) => store.edit({ ...request, expectedRevision,
      edit: ScmDiffSummaryResultEditSchema.parse(command) });
    expect(await edit(0, { kind: 'moveCommitChanges', changeRefs: ['change-2'], target: { kind: 'newGroup',
      group: { id: 'g2', message: 'fix: second', rationale: 'Separate second occurrence' } } }))
      .toMatchObject({ success: true, result: { revision: 1, output: { outputs: { commitPlan: { value: {
        groups: [{ id: 'g1', changeRefs: ['change-1'] }, { id: 'g2', changeRefs: ['change-2'] }], leftOutChangeRefs: [],
      } } } } } });
    expect(await edit(1, { kind: 'moveCommitChanges', changeRefs: ['change-1'], target: { kind: 'leftOut' } }))
      .toMatchObject({ success: true, result: { revision: 2, output: { outputs: { commitPlan: { value: {
        groups: [{ id: 'g1', changeRefs: [] }, { id: 'g2', changeRefs: ['change-2'] }], leftOutChangeRefs: ['change-1'],
      } } } } } });
    const moved = await edit(2, { kind: 'moveCommitChanges', changeRefs: ['change-1'], target: { kind: 'group', groupId: 'g2' } });
    expect(moved).toMatchObject({ success: true, result: { revision: 3, canUndo: true, output: {
      summaryMarkdown: output.summaryMarkdown, analysis: output.analysis, outputs: { summary: output.outputs?.summary,
        walkthrough: output.outputs?.walkthrough, commitPlan: { value: {
          groups: [{ id: 'g1', changeRefs: [] }, { id: 'g2', changeRefs: ['change-2', 'change-1'] }], leftOutChangeRefs: [],
        } } },
    } } });
    expect(await edit(2, { kind: 'editCommitGroup', groupId: 'g2', message: 'stale' }))
      .toMatchObject({ success: false, errorCode: 'revision_conflict', latestRevision: 3 });
    expect(await store.undo({ ...request, expectedRevision: 2 })).toMatchObject({ success: false, errorCode: 'revision_conflict' });
    expect(await store.undo({ ...request, expectedRevision: 3 })).toMatchObject({ success: true, result: { revision: 4,
      output: { outputs: { commitPlan: { value: { leftOutChangeRefs: ['change-1'], groups: [
        { id: 'g1', changeRefs: [] }, { id: 'g2', changeRefs: ['change-2'] },
      ] } } } } } });
  });

  it('discards one output as a revisioned edit that Undo restores, never the last output or a landed proposal', async () => {
    const { store, request } = await setup();
    const edit = (expectedRevision: number, command: unknown) => store.edit({ ...request, expectedRevision,
      edit: ScmDiffSummaryResultEditSchema.parse(command) });
    const removed = await edit(0, { kind: 'removeOutput', output: 'commitPlan' });
    expect(removed).toMatchObject({ success: true, result: { revision: 1, canUndo: true,
      output: { requestedOutputs: ['summary', 'walkthrough'], outputs: { summary: output.outputs?.summary, walkthrough: output.outputs?.walkthrough } } } });
    expect(removed.success && removed.result.output.outputs?.commitPlan).toBeUndefined();
    expect(await edit(0, { kind: 'removeOutput', output: 'walkthrough' })).toMatchObject({ success: false, errorCode: 'revision_conflict' });
    expect(await store.undo({ ...request, expectedRevision: 1 })).toMatchObject({ success: true, result: { revision: 2,
      output: { outputs: { commitPlan: output.outputs?.commitPlan } } } });
    expect(await edit(2, { kind: 'removeOutput', output: 'summary' })).toMatchObject({ success: true, result: { revision: 3 } });
    expect(await edit(3, { kind: 'removeOutput', output: 'walkthrough' })).toMatchObject({ success: true, result: { revision: 4 } });
    // The last output is the result itself: delete it instead.
    expect(await edit(4, { kind: 'removeOutput', output: 'commitPlan' })).toMatchObject({ success: false, errorCode: 'invalid_edit' });
    const partial = await setupPartialApplication();
    expect(await partial.store.edit({ ...partial.request, expectedRevision: 3, edit: { kind: 'removeOutput', output: 'commitPlan' } }))
      .toMatchObject({ success: false, errorCode: 'invalid_edit' });
  });

  it('reorders and merges commit groups while retaining the edited target unless explicitly replaced', async () => {
    const { store, request } = await setup();
    const edit = (expectedRevision: number, command: unknown) => store.edit({ ...request, expectedRevision,
      edit: ScmDiffSummaryResultEditSchema.parse(command) });
    await edit(0, { kind: 'moveCommitChanges', changeRefs: ['change-2'], target: { kind: 'newGroup',
      group: { id: 'g2', message: 'fix: second', rationale: 'Second' } } });
    await edit(1, { kind: 'editCommitGroup', groupId: 'g2', message: 'My message', rationale: 'My rationale' });
    expect(await edit(2, { kind: 'reorderCommitGroups', groupIds: ['g2', 'g1'] })).toMatchObject({ success: true,
      result: { revision: 3, output: { outputs: { commitPlan: { value: { groups: [{ id: 'g2' }, { id: 'g1' }] } } } } } });
    expect(await edit(3, { kind: 'mergeCommitGroups', groupIds: ['g1', 'g2'], targetGroupId: 'g2' }))
      .toMatchObject({ success: true, result: { revision: 4, output: { outputs: { commitPlan: { value: { groups: [
        { id: 'g2', message: 'My message', rationale: 'My rationale', changeRefs: ['change-2', 'change-1'] },
      ] } } } } } });
    await store.undo({ ...request, expectedRevision: 4 });
    expect(await edit(5, { kind: 'mergeCommitGroups', groupIds: ['g1', 'g2'], targetGroupId: 'g2',
      message: 'Explicit merged message', rationale: '' })).toMatchObject({ success: true,
      result: { revision: 6, output: { outputs: { commitPlan: { value: { groups: [
        { id: 'g2', message: 'Explicit merged message', rationale: '', changeRefs: ['change-2', 'change-1'] },
      ] } } } } } });
  });

  it('rejects invalid commit edits without changing revision, coverage or Undo', async () => {
    const { store, request } = await setup();
    for (const command of [
      { kind: 'moveCommitChanges', changeRefs: ['c1'], target: { kind: 'leftOut' } },
      { kind: 'moveCommitChanges', changeRefs: ['foreign-change'], target: { kind: 'leftOut' } },
      { kind: 'moveCommitChanges', changeRefs: ['change-1'], target: { kind: 'group', groupId: 'missing' } },
      { kind: 'moveCommitChanges', changeRefs: ['change-1'], target: { kind: 'newGroup', group: { id: 'g1', message: 'Duplicate', rationale: '' } } },
      { kind: 'reorderCommitGroups', groupIds: ['missing'] },
      { kind: 'mergeCommitGroups', groupIds: ['g1', 'missing'], targetGroupId: 'g1' },
      { kind: 'editCommitGroup', groupId: 'missing', rationale: '' },
    ]) {
      expect(await store.edit({ ...request, expectedRevision: 0, edit: ScmDiffSummaryResultEditSchema.parse(command) }))
        .toMatchObject({ success: false, errorCode: 'invalid_edit' });
    }
    expect(await store.read(request)).toMatchObject({ success: true, result: { revision: 0, canUndo: false,
      output: { outputs: output.outputs } } });
  });

  it('refuses a commit-plan replacement on historical comparison evidence', async () => {
    const { store } = await setup();
    const historical = { ...comparison, source: { kind: 'commit' as const, commit: 'abc' } };
    const created = await store.create({ cwd, output: ScmDiffSummaryGenerateOutputSchema.parse({ ...output,
      comparison: historical, metadata: { ...output.metadata, source: historical.source }, requestedOutputs: ['summary', 'walkthrough'],
      outputs: { summary: output.outputs?.summary, walkthrough: output.outputs?.walkthrough },
    }) });
    expect(await store.edit({ cwd, resultId: created.resultId, expectedRevision: 0,
      edit: { kind: 'replaceCommitPlan', value: output.outputs!.commitPlan!.value! } }))
      .toMatchObject({ success: false, errorCode: 'invalid_edit' });
    expect(await store.read({ cwd, resultId: created.resultId })).toMatchObject({ success: true, result: { revision: 0, canUndo: false } });
  });

  it('allows remaining edits after a partial application but preserves the landed prefix and its original proposal', async () => {
    const { store, request, plan } = await setupPartialApplication();
    for (const command of [
      { kind: 'editCommitGroup', groupId: 'g1', message: 'Rewritten landed proposal' },
      { kind: 'moveCommitChanges', changeRefs: ['change-1'], target: { kind: 'leftOut' } },
      { kind: 'moveCommitChanges', changeRefs: ['change-2'], target: { kind: 'group', groupId: 'g1' } },
      { kind: 'mergeCommitGroups', groupIds: ['g1', 'g2'], targetGroupId: 'g1' },
      { kind: 'reorderCommitGroups', groupIds: ['g2', 'g1'] },
      { kind: 'replaceCommitPlan', value: { ...plan, groups: plan.groups.slice(1), leftOutChangeRefs: ['change-1'] } },
    ]) {
      expect(await store.edit({ ...request, expectedRevision: 3, edit: ScmDiffSummaryResultEditSchema.parse(command) }))
        .toMatchObject({ success: false, errorCode: 'invalid_edit' });
    }
    expect(await store.edit({ ...request, expectedRevision: 3, edit: ScmDiffSummaryResultEditSchema.parse({
      kind: 'editCommitGroup', groupId: 'g2', message: 'Fresh remaining proposal',
    }) })).toMatchObject({ success: true, result: { revision: 4, output: { outputs: { commitPlan: { value: { groups: [
      plan.groups[0], { id: 'g2', message: 'Fresh remaining proposal', changeRefs: ['change-2'] },
    ] } } } } } });
  });

  it('rejects Undo that resurrects landed selections while allowing remaining and unrelated summary Undo', async () => {
    const { store, request, plan } = await setupPartialApplication();
    // The pre-application Undo contains one group with both changes, so applying it would steal the remaining selection.
    expect(await store.undo({ ...request, expectedRevision: 3 })).toMatchObject({ success: false, errorCode: 'invalid_edit' });
    expect(await store.edit({ ...request, expectedRevision: 3, edit: { kind: 'editCommitGroup', groupId: 'g2', message: 'Remaining edit' } }))
      .toMatchObject({ success: true, result: { revision: 4 } });
    expect(await store.undo({ ...request, expectedRevision: 4 })).toMatchObject({ success: true, result: { revision: 5,
      output: { outputs: { commitPlan: { value: plan } } }, application: { steps: [
        { groupId: 'g1', state: 'published', commitSha: 'b'.repeat(40) }, { groupId: 'g2', state: 'not_published' },
      ] },
    } });
    expect(await store.edit({ ...request, expectedRevision: 5, edit: { kind: 'replaceSummary', value: { summaryMarkdown: 'New summary' } } }))
      .toMatchObject({ success: true, result: { revision: 6 } });
    expect(await store.undo({ ...request, expectedRevision: 6 })).toMatchObject({ success: true, result: { revision: 7,
      output: { summaryMarkdown: output.summaryMarkdown, outputs: { commitPlan: { value: plan } } },
    } });
  });

  it('rejects stale or prefix-changing refinement publication after a partial application', async () => {
    const { store, request, plan } = await setupPartialApplication();
    expect(await store.publish({ ...request, inputId: 'before-application', modelOutput: { commitPlan: output.outputs!.commitPlan!.value } }))
      .toMatchObject({ success: false, errorCode: 'revision_conflict', latestRevision: 3 });
    expect(await store.beginInput({ ...request, expectedRevision: 3, outputs: ['commitPlan'], inputId: 'after-application' }))
      .toMatchObject({ success: true });
    expect(await store.publish({ ...request, inputId: 'after-application', modelOutput: { commitPlan: {
      groups: plan.groups.slice(1).map(group => ({ ...group, changeRefs: ['c2'] })), leftOutChangeRefs: ['c1'],
    } } })).toMatchObject({ success: false, errorCode: 'invalid_output' });
    expect(await store.read(request)).toMatchObject({ success: true, result: { revision: 3, output: { outputs: { commitPlan: { value: plan } } } } });
    expect(await store.beginInput({ ...request, expectedRevision: 3, outputs: ['summary'], inputId: 'summary-after-application' }))
      .toMatchObject({ success: true });
    expect(await store.publish({ ...request, inputId: 'summary-after-application', modelOutput: { summaryMarkdown: 'Updated analysis' } }))
      .toMatchObject({ success: true, result: { revision: 4, output: { summaryMarkdown: 'Updated analysis', outputs: { commitPlan: { value: plan } } } } });
  });

  it('rejects a terminal progress envelope that removes or changes the landed proposal', async () => {
    const { store, request, plan } = await setupPartialApplication();
    for (const next of [
      { ...output, requestedOutputs: ['summary', 'walkthrough'], outputs: { summary: output.outputs?.summary, walkthrough: output.outputs?.walkthrough } },
      output,
    ]) {
      expect(await store.publishProgress({ ...request, expectedRevision: 3, output: ScmDiffSummaryGenerateOutputSchema.parse(next) }))
        .toMatchObject({ success: false, errorCode: 'invalid_output' });
    }
    const current = await store.read(request);
    if (!current.success) throw new Error('Saved result is unavailable');
    expect(await store.publishProgress({ ...request, expectedRevision: 3, output: current.result.output }))
      .toMatchObject({ success: true, result: { revision: 4, output: { outputs: { commitPlan: { value: plan } } } } });
  });

  it('keeps the last manual Undo when conversation provenance changes without undoing the new run linkage', async () => {
    const { store, request } = await setup();
    await store.edit({ ...request, expectedRevision: 0, edit: { kind: 'renameWalkthrough', title: 'Manual title' } });
    expect(await store.bindRun({ ...request, expectedRevision: 1, runId: 'replacement-run', seededFromRunId: 'previous-run' }))
      .toMatchObject({ success: true, result: { revision: 2, canUndo: true } });
    expect(await store.undo({ ...request, expectedRevision: 2 })).toMatchObject({ success: true,
      result: { revision: 3, canUndo: false, output: { runId: 'replacement-run', producer: { runId: 'replacement-run', seededFromRunId: 'previous-run' },
        outputs: { walkthrough: { value: { title: 'Original' } } } } } });
  });
  it('persists edits independently of runs/cache and rejects stale device writes across owner instances', async () => {
    const { store, directory, request } = await setup();
    const secondDevice = createScmDiffSummaryResultStore({ directory });
    const edited = await store.edit({ ...request, expectedRevision: 0, edit: { kind: 'renameWalkthrough', title: 'My title' } });
    expect(edited).toMatchObject({ success: true, result: { revision: 1, canUndo: true } });
    const stale = await secondDevice.edit({ ...request, expectedRevision: 0, edit: { kind: 'renameStop', stopId: 's1', title: 'Stale' } });
    expect(stale).toMatchObject({ success: false, errorCode: 'revision_conflict', latestRevision: 1 });
    const read = await secondDevice.read(request);
    expect(read).toMatchObject({ success: true, result: { output: { summaryMarkdown: 'Keep the summary',
      outputs: { walkthrough: { value: { title: 'My title' } }, commitPlan: output.outputs?.commitPlan } } } });
    expect(await store.read({ ...request, sessionId: 'another-session' })).toMatchObject({ success: false, errorCode: 'result_not_found' });
  });

  it('serializes two simultaneous revisions at the filesystem owner', async () => {
    const { directory, store, request } = await setup();
    const second = createScmDiffSummaryResultStore({ directory });
    const outcomes = await Promise.all([store.edit({ ...request, expectedRevision: 0, edit: { kind: 'renameWalkthrough', title: 'A' } }),
      second.edit({ ...request, expectedRevision: 0, edit: { kind: 'renameWalkthrough', title: 'B' } })]);
    expect(outcomes.filter((result) => result.success)).toHaveLength(1);
    expect(outcomes.filter((result) => !result.success)).toMatchObject([{ errorCode: 'revision_conflict', latestRevision: 1 }]);
  });

  it('merges exact coverage with the explicit title and supports revision-checked immediate Undo', async () => {
    const { store, request } = await setup();
    await store.edit({ ...request, expectedRevision: 0, edit: { kind: 'renameStop', stopId: 's1', title: 'Edited title' } });
    const merged = await store.edit({ ...request, expectedRevision: 1, edit: { kind: 'mergeStops', stopIds: ['s1', 's2'],
      targetStopId: 's1', explanationMarkdown: 'Merged explanation' } });
    expect(merged).toMatchObject({ success: true, result: { revision: 2, output: { outputs: { walkthrough: { value: {
      stops: [{ id: 's1', title: 'Edited title', explanationMarkdown: 'Merged explanation', changeRefs: ['change-1', 'change-2'] }],
    } } } } } });
    expect(await store.undo({ ...request, expectedRevision: 1 })).toMatchObject({ success: false, errorCode: 'revision_conflict' });
    const undone = await store.undo({ ...request, expectedRevision: 2 });
    expect(undone).toMatchObject({ success: true, result: { revision: 3, canUndo: false, output: { outputs: { walkthrough: { value: {
      stops: [{ id: 's1', title: 'Edited title', changeRefs: ['change-1'] }, { id: 's2', changeRefs: ['change-2'] }],
    } } } } } });
  });

  it('binds refinement before dispatch, refuses stale publication and validates aliases without losing outputs', async () => {
    const { store, request } = await setup();
    const begun = await store.beginInput({ ...request, expectedRevision: 0, outputs: ['walkthrough'], stopIds: ['s1'], inputId: 'refine-1' });
    expect(begun).toMatchObject({ success: true });
    await store.edit({ ...request, expectedRevision: 0, edit: { kind: 'renameWalkthrough', title: 'Device A' } });
    const stale = await store.publish({ ...request, inputId: 'refine-1', modelOutput: { walkthrough: {
      title: 'Ignored generated title', intro: '', stops: [{ id: 's1', title: 'First', explanationMarkdown: 'Updated', changeRefs: ['c1'] }], otherChangeRefs: [],
    } } });
    expect(stale).toMatchObject({ success: false, errorCode: 'revision_conflict', latestRevision: 1 });
    await store.beginInput({ ...request, expectedRevision: 1, outputs: ['walkthrough'], stopIds: ['s1'], inputId: 'refine-2' });
    for (const ref of ['other-comparison:c1', 'change-1']) {
      expect(await store.publish({ ...request, inputId: 'refine-2', modelOutput: { walkthrough: {
        title: 'Wrong', intro: '', stops: [{ id: 's1', title: 'First', explanationMarkdown: 'Updated', changeRefs: [ref] }], otherChangeRefs: [],
      } } })).toMatchObject({ success: false, errorCode: 'invalid_output' });
    }
    const latest = await store.read(request);
    expect(latest).toMatchObject({ success: true, result: { revision: 1, output: { outputs: { walkthrough: { value: { title: 'Device A' } } } } } });
  });

  it.each([false, true])('publishes targeted prose and generated titles, preserving manual titles (%s) and unselected output', async (manualTitle) => {
    const { store, request } = await setup();
    if (manualTitle) await store.edit({ ...request, expectedRevision: 0, edit: { kind: 'renameStop', stopId: 's1', title: 'Personal title' } });
    await store.beginInput({ ...request, expectedRevision: manualTitle ? 1 : 0, outputs: ['walkthrough'], stopIds: ['s1'], inputId: 'refine' });
    const updated = await store.publish({ ...request, inputId: 'refine', modelOutput: { walkthrough: {
      title: 'Parcours', intro: 'Modifications', stops: [{ id: 's1', title: 'Préserver l’état', explanationMarkdown: 'Explication affinée', changeRefs: ['c1'] }], otherChangeRefs: [],
    } } });
    expect(updated).toMatchObject({ success: true, result: { revision: manualTitle ? 2 : 1, output: { summaryMarkdown: 'Keep the summary', outputs: {
      summary: output.outputs?.summary, commitPlan: output.outputs?.commitPlan,
      walkthrough: { value: { title: 'Original', intro: 'Intro', stops: [
        { id: 's1', title: manualTitle ? 'Personal title' : 'Préserver l’état', explanationMarkdown: 'Explication affinée', changeRefs: ['change-1'] }, output.outputs?.walkthrough?.value?.stops[1],
      ] } },
    } } } });
  });
});
