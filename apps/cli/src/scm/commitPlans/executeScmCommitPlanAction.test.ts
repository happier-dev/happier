import { chmodSync, existsSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ScmDiffSummaryGenerateOutputSchema, ScmDiffSummaryResultResponseSchema, ScmCommitResolveOutcomeResponseSchema, type ScmDiffSummaryResultResponse } from '@happier-dev/protocol';
import { captureScmComparison } from '../comparisons/captureScmComparison';
import { createScmDiffSummaryResultStore } from '@/agent/executionRuns/tasks/scmDiffSummary/results/resultStore';
import { createTestGitScmBackendRegistry, runGit as git } from '../rpc/__tests__/testRpcHarness';
import { executeScmCommitPlanAction } from './executeScmCommitPlanAction';
import { executeScmActionOperation } from '../actions/executeScmActionOperation';
import { createScmBackendRegistry } from '../registry';
import { buildCommitPlanAcceptance } from '../../../../ui/sources/components/sessions/files/commits/commitPlanAcceptance';

async function setup(detached = false) {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'happier-u5-apply-')));
  git(cwd, ['init', '-q']); git(cwd, ['config', 'user.name', 'U5 Fixture']); git(cwd, ['config', 'user.email', 'u5@example.test']);
  for (const path of ['a.txt', 'b.txt', 'left.txt']) writeFileSync(join(cwd, path), 'base\n');
  git(cwd, ['add', '.']); git(cwd, ['commit', '-qm', 'base']);
  const expectedHeadOid = git(cwd, ['rev-parse', 'HEAD']);
  if (detached) git(cwd, ['checkout', '--detach', '-q', expectedHeadOid]);
  for (const path of ['a.txt', 'b.txt', 'left.txt']) writeFileSync(join(cwd, path), `${path}\n`);
  git(cwd, ['add', 'left.txt']);
  const registry = createTestGitScmBackendRegistry();
  const captured = await captureScmComparison({ cwd, source: { kind: 'workingTree' }, registry });
  const ref = (path: string) => captured.comparison.inventory.files.find((file) => file.path === path)!.occurrences.map((change) => change.id);
  const groups = ['a.txt', 'b.txt'].map((path, index) => ({ id: `g${index + 1}`, message: `fix: ${path}`, rationale: path, changeRefs: ref(path) }));
  const store = createScmDiffSummaryResultStore({ directory: mkdtempSync(join(tmpdir(), 'happier-u5-results-')) });
  const saved = await store.create({ cwd, output: ScmDiffSummaryGenerateOutputSchema.parse({ success: true,
    sourceKey: captured.comparison.id, comparison: captured.comparison, metadata: captured.metadata,
    requestedOutputs: ['summary', 'commitPlan'], outputs: {
      summary: { state: 'complete', value: { summaryMarkdown: 'Keep this explanation' } },
      commitPlan: { state: 'complete', value: { groups, leftOutChangeRefs: ref('left.txt') } },
    }, analysis: { suppliedChangeRefs: captured.comparison.inventory.files.flatMap((file) => file.occurrences.map((change) => change.id)),
      analysedChangeRefs: [], remainingChangeRefs: captured.comparison.inventory.files.flatMap((file) => file.occurrences.map((change) => change.id)) },
  }) });
  const acceptance = buildCommitPlanAcceptance({ comparison: captured.comparison,
    plan: { groups, leftOutChangeRefs: ref('left.txt') }, application: null });
  if (!acceptance) throw new Error('Captured working comparison did not authorize the fixture commit plan');
  const accept = (expectedRevision = 0, binding = acceptance) => executeScmCommitPlanAction({
    cwd, store, registry, actionId: 'scm.diffSummary.commitPlan.accept', input: { cwd, resultId: saved.resultId, expectedRevision, acceptance: binding },
  });
  const result = (response: ScmDiffSummaryResultResponse) => { if (!response.success) throw new Error(JSON.stringify(response)); return response.result; };
  return { cwd, store, saved, registry, accept, acceptance, result };
}

describe('accepted commit plan through registered canonical writer', () => {
  it('creates an exact zero-parent first commit from UI acceptance with retained comparison refs', async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'happier-u5-unborn-')));
    git(cwd, ['init', '-q']); git(cwd, ['config', 'user.name', 'U5 Fixture']); git(cwd, ['config', 'user.email', 'u5@example.test']);
    writeFileSync(join(cwd, 'selected.txt'), 'first selected content\n');
    writeFileSync(join(cwd, 'left.txt'), 'leave pending\n');
    const registry = createTestGitScmBackendRegistry();
    const captured = await captureScmComparison({ cwd, source: { kind: 'workingTree' }, registry });
    expect(git(cwd, ['for-each-ref', '--format=%(refname)', 'refs/happier/comparisons'])).not.toBe('');
    const refs = (path: string) => captured.comparison.inventory.files.find((file) => file.path === path)!.occurrences.map((change) => change.id);
    const plan = { groups: [{ id: 'first', message: 'feat: first selected file', rationale: 'First commit', changeRefs: refs('selected.txt') }], leftOutChangeRefs: refs('left.txt') };
    const store = createScmDiffSummaryResultStore({ directory: mkdtempSync(join(tmpdir(), 'happier-u5-unborn-results-')) });
    const allRefs = captured.comparison.inventory.files.flatMap((file) => file.occurrences.map((change) => change.id));
    const saved = await store.create({ cwd, output: ScmDiffSummaryGenerateOutputSchema.parse({ success: true,
      sourceKey: captured.comparison.id, comparison: captured.comparison, metadata: captured.metadata,
      requestedOutputs: ['commitPlan'], outputs: { commitPlan: { state: 'complete', value: plan } },
      analysis: { suppliedChangeRefs: allRefs, analysedChangeRefs: [], remainingChangeRefs: allRefs },
    }) });
    const branch = git(cwd, ['symbolic-ref', '--short', 'HEAD']);
    const acceptance = buildCommitPlanAcceptance({ comparison: captured.comparison, plan, application: null });
    const response = await executeScmCommitPlanAction({ cwd, store, registry, actionId: 'scm.diffSummary.commitPlan.accept',
      input: { cwd, resultId: saved.resultId, expectedRevision: 0, acceptance } });
    expect(response, JSON.stringify(response)).toMatchObject({ success: true, result: { application: { status: 'complete', nextGroupIndex: 1 } } });
    const sha = git(cwd, ['rev-parse', 'HEAD']);
    expect(git(cwd, ['rev-list', '--parents', '-n', '1', sha])).toBe(sha);
    expect(git(cwd, ['ls-tree', '-r', '--name-only', sha])).toBe('selected.txt');
    expect(git(cwd, ['show', `${sha}:selected.txt`])).toBe('first selected content');
    expect(git(cwd, ['status', '--porcelain'])).toBe('?? left.txt');
    expect(acceptance).toMatchObject({ expectedHeadOid: null, expectedRef: `refs/heads/${branch}` });
  });
  it.each([false, true])('preserves UI-captured parent CAS when detached=%s', async (detached) => {
    const { cwd, saved, acceptance, accept } = await setup(detached);
    const comparison = saved.output.comparison!;
    const plan = saved.output.outputs!.commitPlan!.value!;
    const binding = buildCommitPlanAcceptance({ comparison, plan, application: null });
    expect(binding).toMatchObject({ expectedHeadOid: acceptance.expectedHeadOid, expectedRef: acceptance.expectedRef });
    git(cwd, ['commit', '--allow-empty', '-qm', 'actor advanced parent']);
    const actor = git(cwd, ['rev-parse', 'HEAD']);
    expect(await accept(0, binding!)).toMatchObject({ success: false, errorCode: 'head_moved' });
    expect(git(cwd, ['rev-parse', 'HEAD'])).toBe(actor);
  });
  it('keeps evidence readable but refuses acceptance when the backend cannot capture mutation authority', async () => {
    const { cwd, store, saved, registry, acceptance } = await setup();
    const unsupported = createScmBackendRegistry([{ ...registry.listBackends()[0]!, commitCaptureTarget: undefined }]);
    const captured = await captureScmComparison({ cwd, source: { kind: 'workingTree' }, registry: unsupported });
    expect(captured.comparison.inventory.state).toBe('complete');
    expect(captured.comparison.commitTarget).toBeUndefined();
    expect(buildCommitPlanAcceptance({ comparison: captured.comparison, plan: saved.output.outputs!.commitPlan!.value!, application: null })).toBeNull();
    expect(await executeScmCommitPlanAction({ cwd, store, registry: unsupported, actionId: 'scm.diffSummary.commitPlan.accept',
      input: { cwd, resultId: saved.resultId, expectedRevision: 0, acceptance } })).toMatchObject({ success: false, errorCode: 'backend_unsupported' });
    expect(git(cwd, ['rev-parse', 'HEAD'])).toBe(acceptance.expectedHeadOid);
  });
  it('reports unknown publication when resolver checkout authorization is refused', async () => {
    const { cwd, registry, acceptance } = await setup();
    const response = await executeScmActionOperation({ actionId: 'scm.commit.resolveOutcome',
      workingDirectory: cwd, registry, accessPolicy: { kind: 'restrictedRoots', roots: [cwd] },
      input: { cwd: `${cwd}-outside`, candidateOid: acceptance.expectedHeadOid!, expectedHeadOid: acceptance.expectedHeadOid,
        expectedRef: acceptance.expectedRef },
    });
    expect(ScmCommitResolveOutcomeResponseSchema.safeParse(response).success).toBe(true);
    expect(response).toMatchObject({ success: false, errorCode: 'INVALID_PATH', publication: { state: 'unknown', indexReconciliation: 'pending' } });
  });
  it('keeps a cancelled route admission inside the published saved-result response contract', async () => {
    const { cwd, store, registry, saved, acceptance } = await setup();
    const response = await executeScmCommitPlanAction({ cwd, store, registry, signal: AbortSignal.abort(),
      actionId: 'scm.diffSummary.commitPlan.accept', input: { cwd, resultId: saved.resultId, expectedRevision: 0, acceptance },
    });
    expect(ScmDiffSummaryResultResponseSchema.safeParse(response).success).toBe(true);
    expect(response).toMatchObject({ success: false, errorCode: 'result_unavailable' });
    expect(git(cwd, ['rev-parse', 'HEAD'])).toBe(acceptance.expectedHeadOid);
  });
  it('refuses staging-only source divergence even when selected worktree bytes are unchanged', async () => {
    const { cwd, accept, result, acceptance } = await setup();
    git(cwd, ['add', 'a.txt']);
    const refused = result(await accept());
    expect(refused.application).toMatchObject({ status: 'failed', reason: 'source_changed', nextGroupIndex: 0 });
    expect(git(cwd, ['rev-parse', 'HEAD'])).toBe(acceptance.expectedHeadOid);
    expect(git(cwd, ['diff', '--cached', '--name-only'])).toBe('a.txt\nleft.txt');
  });
  it.skipIf(process.platform === 'win32')('stops after a landed step when another actor changes only live staging', async () => {
    const { cwd, accept, result } = await setup();
    const hook = join(cwd, '.git', 'hooks', 'post-commit');
    writeFileSync(hook, '#!/bin/sh\ngit add b.txt\n'); chmodSync(hook, 0o755);
    const refused = result(await accept());
    expect(refused.application).toMatchObject({ status: 'failed', reason: 'source_changed', nextGroupIndex: 1 });
    expect(git(cwd, ['rev-parse', 'HEAD'])).toBe(refused.application!.steps[0].commitSha);
    expect(git(cwd, ['show', 'HEAD:b.txt'])).toBe('base');
    expect(git(cwd, ['diff', '--cached', '--name-only'])).toBe('b.txt\nleft.txt');
  });
  it.skipIf(process.platform === 'win32')('refuses hook inclusion that would publish a later accepted group early', async () => {
    const { cwd, accept, result, registry, store, saved, acceptance } = await setup();
    const hook = join(cwd, '.git', 'hooks', 'pre-commit');
    writeFileSync(hook, '#!/bin/sh\ngit add b.txt\n'); chmodSync(hook, 0o755);
    const paused = result(await accept());
    expect(paused.application?.status).toBe('paused');
    const changes = paused.application!.steps[0].hookContentChanges!;
    const included = result(await executeScmCommitPlanAction({ cwd, store, registry, actionId: 'scm.diffSummary.commitPlan.includeHookChanges', input: {
      cwd, resultId: saved.resultId, expectedRevision: paused.revision, groupId: 'g1',
      beforeTreeOid: changes.beforeTreeOid, afterTreeOid: changes.afterTreeOid,
    } }));
    expect(included.application).toMatchObject({ status: 'failed', reason: 'selection_conflict', nextGroupIndex: 0 });
    expect(git(cwd, ['rev-parse', 'HEAD'])).toBe(acceptance.expectedHeadOid);
    expect(git(cwd, ['show', 'HEAD:b.txt'])).toBe('base');
  });
  it('fails first-step signing before any commit can land', async () => {
    const { cwd, accept, acceptance, result } = await setup();
    git(cwd, ['config', 'commit.gpgSign', 'true']);
    git(cwd, ['config', 'gpg.program', join(cwd, 'missing-signer')]);
    const failed = result(await accept());
    expect(failed.application).toMatchObject({ status: 'failed', reason: 'signing_failed', nextGroupIndex: 0 });
    expect(git(cwd, ['rev-parse', 'HEAD'])).toBe(acceptance.expectedHeadOid);
  });
  it.skipIf(process.platform === 'win32')('retains reference-transaction veto identity for the commit proposal outcome', async () => {
    const { cwd, accept, acceptance, result } = await setup();
    const hook = join(cwd, '.git', 'hooks', 'reference-transaction');
    // Permit evidence/checkpoint refs; veto only the writer's live branch publication.
    writeFileSync(hook, '#!/bin/sh\nwhile read old new ref; do\ncase "$ref" in HEAD|refs/heads/*) if test "$1" = prepared; then echo rejected-reference >&2; exit 1; fi;; esac\ndone\n'); chmodSync(hook, 0o755);
    const failed = result(await accept());
    expect(failed.application).toMatchObject({ status: 'failed', reason: 'hook_failed', nextGroupIndex: 0,
      steps: [{ state: 'not_published', errorCode: 'COMMIT_HOOK_FAILED', publication: { state: 'not_published', hookName: 'reference-transaction' } }, { state: 'pending' }] });
    expect(git(cwd, ['rev-parse', 'HEAD'])).toBe(acceptance.expectedHeadOid);
    expect(git(cwd, ['diff', '--cached', '--name-only'])).toBe('left.txt');
  });
  it.skipIf(process.platform === 'win32').each(['stop', 'cancel'] as const)('handles %s after an active atomic commit and admits no next group', async (control) => {
    const { cwd, accept, store, saved, registry, result } = await setup();
    const hook = join(cwd, '.git', 'hooks', 'pre-commit');
    writeFileSync(hook, '#!/bin/sh\ntouch entered-hook\nwhile [ ! -f release-hook ]; do sleep 0.01; done\n'); chmodSync(hook, 0o755);
    const applying = accept();
    await vi.waitFor(() => expect(existsSync(join(cwd, 'entered-hook'))).toBe(true), { timeout: 15000 });
    const current = result(await store.read({ cwd, resultId: saved.resultId }));
    expect(current.application?.steps[0].state).toBe('writing');
    expect(await executeScmCommitPlanAction({ cwd, store, registry, actionId: `scm.diffSummary.commitPlan.${control}`, input: {
      cwd, resultId: saved.resultId, expectedRevision: current.revision,
    } })).toMatchObject({ success: true, result: { application: { status: 'applying', stopAfterCurrent: true } } });
    writeFileSync(join(cwd, 'release-hook'), 'continue');
    const stopped = result(await applying);
    expect(stopped.application).toMatchObject({ status: 'stopped', nextGroupIndex: 1, steps: [{ state: 'published' }, { state: 'pending' }] });
    expect(git(cwd, ['show', 'HEAD:b.txt'])).toBe('base');
  }, 20000);
  it.skipIf(process.platform === 'win32')('recovery during an unresolved active call never admits a later group automatically', async () => {
    const { cwd, accept, store, saved, registry, result } = await setup();
    const hook = join(cwd, '.git', 'hooks', 'pre-commit');
    writeFileSync(hook, '#!/bin/sh\ntouch entered-hook\nwhile [ ! -f release-hook ]; do sleep 0.01; done\n'); chmodSync(hook, 0o755);
    const applying = accept();
    await vi.waitFor(() => expect(existsSync(join(cwd, 'entered-hook'))).toBe(true), { timeout: 15000 });
    const current = result(await store.read({ cwd, resultId: saved.resultId }));
    const recovery = await executeScmCommitPlanAction({ cwd, store, registry, actionId: 'scm.diffSummary.commitPlan.recover', input: {
      cwd, resultId: saved.resultId, expectedRevision: current.revision,
    } });
    expect(recovery).toMatchObject({ success: true, result: { application: { status: 'unknown' } } });
    writeFileSync(join(cwd, 'release-hook'), 'continue');
    const stopped = result(await applying);
    expect(stopped.application).toMatchObject({ status: 'stopped', nextGroupIndex: 1 });
    expect(git(cwd, ['show', 'HEAD:b.txt'])).toBe('base');
    expect(git(cwd, ['rev-list', '--count', 'HEAD'])).toBe('2');
  }, 20000);
  it.skipIf(process.platform === 'win32')('stops on a moved HEAD after a landed step and preserves the actual actor commit', async () => {
    const { cwd, accept, result } = await setup();
    const hook = join(cwd, '.git', 'hooks', 'post-commit');
    writeFileSync(hook, '#!/bin/sh\nif [ ! -f actor-done ]; then\ntouch actor-done\nactor=$(git commit-tree HEAD^{tree} -p HEAD -m actor)\ngit update-ref HEAD "$actor"\nfi\n'); chmodSync(hook, 0o755);
    const failed = result(await accept());
    expect(failed.application).toMatchObject({ status: 'failed', reason: 'head_moved', nextGroupIndex: 1 });
    expect(git(cwd, ['log', '-1', '--format=%s'])).toBe('actor');
    expect(git(cwd, ['rev-parse', 'HEAD^'])).toBe(failed.application!.steps[0].commitSha);
    expect(git(cwd, ['show', 'HEAD:b.txt'])).toBe('base');
  });
  it('reconciles a recorded lost response through the writer without retrying the landed candidate', async () => {
    const { cwd, accept, store, saved, registry, result, acceptance } = await setup();
    const applied = result(await accept());
    const last = applied.application!.steps[1];
    const lost = result(await store.mutateApplication({ cwd, resultId: saved.resultId }, (current) => ({ ...current.application!,
      status: 'unknown', reason: 'outcome_unknown', nextGroupIndex: 1,
      steps: current.application!.steps.map((step, index) => index === 1 ? { ...step, state: 'unknown', commitSha: undefined } : step),
    })));
    expect(await accept(lost.revision, { ...acceptance, expectedHeadOid: last.commitSha!, groups: [] }))
      .toMatchObject({ success: false, errorCode: 'application_locked' });
    const recovered = result(await executeScmCommitPlanAction({ cwd, store, registry, actionId: 'scm.diffSummary.commitPlan.recover', input: {
      cwd, resultId: saved.resultId, expectedRevision: lost.revision,
    } }));
    expect(recovered.application).toMatchObject({ status: 'stopped', nextGroupIndex: 2, steps: [{ state: 'published' }, { state: 'published', commitSha: last.commitSha }] });
    expect(git(cwd, ['rev-list', '--count', 'HEAD'])).toBe('3');
    expect(git(cwd, ['rev-parse', 'HEAD'])).toBe(last.commitSha);
  });
  it('creates exact sequential trees, preserves excluded staged intent and records actual hook-rewritten messages', async () => {
    const { cwd, accept, acceptance, result } = await setup();
    if (process.platform !== 'win32') {
      const hook = join(cwd, '.git', 'hooks', 'commit-msg');
      writeFileSync(hook, '#!/bin/sh\nprintf "\\nReviewed\\n" >> "$1"\n'); chmodSync(hook, 0o755);
    }
    const applied = result(await accept());
    expect(applied.application).toMatchObject({ status: 'complete', nextGroupIndex: 2, steps: [
      { groupId: 'g1', state: 'published', commitSha: expect.any(String) }, { groupId: 'g2', state: 'published', commitSha: expect.any(String) },
    ] });
    const [first, second] = applied.application!.steps;
    expect(git(cwd, ['rev-parse', `${first.commitSha}^`])).toBe(acceptance.expectedHeadOid);
    expect(git(cwd, ['rev-parse', `${second.commitSha}^`])).toBe(first.commitSha);
    expect(git(cwd, ['show', `${first.commitSha}:a.txt`])).toBe('a.txt');
    expect(git(cwd, ['show', `${first.commitSha}:b.txt`])).toBe('base');
    expect(git(cwd, ['show', `${second.commitSha}:b.txt`])).toBe('b.txt');
    expect(git(cwd, ['show', 'HEAD:left.txt'])).toBe('base');
    expect(git(cwd, ['diff', '--cached', '--name-only'])).toBe('left.txt');
    if (process.platform !== 'win32') expect(first.actualMessage).toContain('Reviewed');
  });
  it('refuses altered ordered messages, stale revisions, moved ref and changed selected bytes without publishing', async () => {
    const { cwd, accept, acceptance, store, saved } = await setup();
    expect(await accept(0, { ...acceptance, groups: [...acceptance.groups].reverse() })).toMatchObject({ success: false, errorCode: 'acceptance_mismatch' });
    expect(await accept(1)).toMatchObject({ success: false, errorCode: 'revision_conflict' });
    writeFileSync(join(cwd, 'b.txt'), 'externally changed\n');
    expect(await accept()).toMatchObject({ success: true, result: { application: { status: 'failed', reason: 'source_changed' } } });
    expect(git(cwd, ['rev-parse', 'HEAD'])).toBe(acceptance.expectedHeadOid);
    const latest = await store.read({ cwd, resultId: saved.resultId });
    expect(latest).toMatchObject({ success: true, result: { output: { outputs: { summary: { value: { summaryMarkdown: 'Keep this explanation' } } } } } });
  });
  it.skipIf(process.platform === 'win32')('preserves the landed prefix after group-two hook failure and resumes only through renewed acceptance', async () => {
    const { cwd, accept, result, registry, store, saved, acceptance } = await setup();
    const hook = join(cwd, '.git', 'hooks', 'pre-commit');
    writeFileSync(hook, '#!/bin/sh\nif git show HEAD:a.txt | grep -q a.txt; then exit 1; fi\n'); chmodSync(hook, 0o755);
    const failed = result(await accept());
    expect(failed.application).toMatchObject({ status: 'failed', reason: 'hook_failed', nextGroupIndex: 1,
      steps: [{ state: 'published' }, { state: 'not_published' }] });
    expect(git(cwd, ['rev-parse', 'HEAD'])).toBe(failed.application!.steps[0].commitSha);
    writeFileSync(hook, '#!/bin/sh\nexit 0\n');
    const resumed = await executeScmCommitPlanAction({ cwd, store, registry, actionId: 'scm.diffSummary.commitPlan.accept', input: {
      cwd, resultId: saved.resultId, expectedRevision: failed.revision, acceptance: { ...acceptance,
        expectedHeadOid: failed.application!.steps[0].commitSha!, groups: acceptance.groups.slice(1) },
    } });
    expect(result(resumed).application).toMatchObject({ status: 'complete', steps: [{ state: 'published' }, { state: 'published' }] });
    expect(git(cwd, ['rev-list', '--count', 'HEAD'])).toBe('3');
  });
  it.skipIf(process.platform === 'win32')('pauses before a hook expansion, revision-checks inclusion and retains additions in later commits', async () => {
    const { cwd, accept, result, registry, store, saved } = await setup();
    const hook = join(cwd, '.git', 'hooks', 'pre-commit');
    writeFileSync(hook, '#!/bin/sh\nprintf "hook\\n" > hook.txt\ngit add hook.txt\n'); chmodSync(hook, 0o755);
    const paused = result(await accept());
    expect(paused.application).toMatchObject({ status: 'paused', nextGroupIndex: 0, steps: [{ state: 'not_published' }, { state: 'pending' }] });
    expect(await store.edit({ cwd, resultId: saved.resultId, expectedRevision: paused.revision,
      edit: { kind: 'replaceSummary', value: { summaryMarkdown: 'Wrong' } } })).toMatchObject({ success: false, errorCode: 'application_locked' });
    const changes = paused.application!.steps[0].hookContentChanges!;
    expect(await executeScmCommitPlanAction({ cwd, store, registry, actionId: 'scm.diffSummary.commitPlan.includeHookChanges', input: {
      cwd, resultId: saved.resultId, expectedRevision: paused.revision - 1, groupId: 'g1',
      beforeTreeOid: changes.beforeTreeOid, afterTreeOid: changes.afterTreeOid,
    } })).toMatchObject({ success: false, errorCode: 'revision_conflict' });
    const include = await executeScmCommitPlanAction({ cwd, store, registry, actionId: 'scm.diffSummary.commitPlan.includeHookChanges', input: {
      cwd, resultId: saved.resultId, expectedRevision: paused.revision, groupId: 'g1',
      beforeTreeOid: changes.beforeTreeOid, afterTreeOid: changes.afterTreeOid,
    } });
    expect(result(include).application).toMatchObject({ status: 'complete', nextGroupIndex: 2 });
    expect(git(cwd, ['show', 'HEAD:hook.txt'])).toBe('hook');
    expect(git(cwd, ['rev-list', '--count', 'HEAD'])).toBe('3');
  });
});
