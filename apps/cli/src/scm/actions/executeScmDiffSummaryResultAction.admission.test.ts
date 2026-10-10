import axios, { AxiosHeaders } from 'axios';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ScmDiffSummaryGenerateOutputSchema, createScmReviewedMarksRecordPort, getActionSpec, type ActionId, type ScmActionId } from '@happier-dev/protocol';
import { scmDiffSummaryResultStore } from '@/agent/executionRuns/tasks/scmDiffSummary/results/resultStore';
import { withTempDir } from '@/testkit/fs/tempDir';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { fetchSessionById } from '@/session/transport/http/sessionsHttp';
import { executeScmActionOperation, type ExecuteScmActionOperationParams } from './executeScmActionOperation';
import { configuration } from '@/configuration';
import { createLocalScmRepositoryFixture } from '@/scm/contracts/scmBackendContractFixtures';
import { captureScmComparison, deleteCapturedScmComparison } from '@/scm/comparisons/captureScmComparison';
import { removeTempDir } from '@/testkit/fs/tempDir';

afterEach(() => vi.restoreAllMocks());

describe('saved SCM producer admission', () => {
  it('marks an exact retained comparison without a saved result and refuses private, foreign-Home and foreign-root captures', async () => {
    const fixture = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'happier-comparison-marks-' });
    const cwd = fixture.rootPath;
    await writeFile(join(cwd, fixture.trackedPath), 'Captured change without narration\n');
    const captured = await captureScmComparison({ cwd, source: { kind: 'workingTree' } });
    const privateCapture = await captureScmComparison({ cwd, sessionId: 'private', source: { kind: 'workingTree' } });
    let value: unknown = null;
    let version = -1;
    const transport = { read: async () => ({ value, version }), compareAndSet: async (next: unknown) => {
      value = next; return { success: true as const, version: ++version };
    } };
    const refs = captured.comparison.inventory.files.flatMap(file => file.occurrences.map(change => change.id));
    expect(refs.length).toBeGreaterThan(0);
    const executeReviewedMarks = vi.fn<NonNullable<ExecuteScmActionOperationParams['executeReviewedMarks']>>((comparison, request, reviewed) =>
      createScmReviewedMarksRecordPort({ comparison, transport }).setReviewed(request.changeRefs, reviewed));
    const base = { workingDirectory: cwd, accessPolicy: { kind: 'restrictedRoots' as const, roots: [cwd] }, executeReviewedMarks };
    const input = { v: 2, cwd, comparisonId: captured.comparison.id, source: captured.comparison.source, changeRefs: refs };
    try {
      expect(await executeScmActionOperation({ ...base, actionId: 'scm.diffSummary.reviewed.mark', input }))
        .toMatchObject({ success: true, record: { comparisonId: captured.comparison.id, reviewedChangeRefs: refs } });
      expect(await executeScmActionOperation({ ...base, actionId: 'scm.diffSummary.reviewed.unmark', input }))
        .toMatchObject({ success: true, record: { reviewedChangeRefs: [] } });
      executeReviewedMarks.mockClear();
      for (const rejected of [
        { input: { ...input, comparisonId: privateCapture.comparison.id, sessionId: 'private' } },
        { input, actionContext: { serverId: `${configuration.activeServerId}-other` } },
        { input: { ...input, cwd: join(cwd, '..') } },
      ]) {
        expect(await executeScmActionOperation({ ...base, actionId: 'scm.diffSummary.reviewed.mark', ...rejected }))
          .toMatchObject({ success: false, errorCode: 'result_unavailable' });
      }
      expect(executeReviewedMarks).not.toHaveBeenCalled();
    } finally {
      await deleteCapturedScmComparison({ cwd, comparisonId: captured.comparison.id });
      await deleteCapturedScmComparison({ cwd, sessionId: 'private', comparisonId: privateCapture.comparison.id });
      await removeTempDir(cwd);
    }
  });
  it('omits private Session results and rejects every saved-result effect even when its Session selector is supplied', async () => {
    await withTempDir('happier-saved-admission-', async cwd => {
      const output = ScmDiffSummaryGenerateOutputSchema.parse({ success: true, sourceKey: 'comparison',
        analysis: { suppliedChangeRefs: [], analysedChangeRefs: [], remainingChangeRefs: [] },
        metadata: { source: { kind: 'workingTree' }, sourceKey: 'comparison' },
        comparison: { id: 'comparison', source: { kind: 'workingTree' }, repository: { rootPath: cwd }, endpoints: {},
          inventory: { state: 'complete', files: [], reasons: [] } },
        requestedOutputs: ['walkthrough'], outputs: { walkthrough: { state: 'complete', value: {
          title: 'Private Session title', intro: 'Private reasoning', stops: [], otherChangeRefs: [],
        } } },
      });
      const privateResult = await scmDiffSummaryResultStore.create({ cwd, sessionId: 'private-session', output });
      const workspaceResult = await scmDiffSummaryResultStore.create({ cwd, output: { ...output,
        outputs: { walkthrough: { state: 'complete', value: { title: 'Workspace review', intro: '', stops: [], otherChangeRefs: [] } } },
      } });
      const execute = (actionId: ScmActionId, input: unknown, sessionId?: string) => executeScmActionOperation({
        actionId, input, workingDirectory: cwd, accessPolicy: { kind: 'restrictedRoots', roots: [cwd] },
        ...(sessionId ? { sessionId } : {}),
      });
      const listed = await execute('scm.diffSummary.result.list', {});
      expect(listed).toMatchObject({ success: true, count: 1, results: [{ resultId: workspaceResult.resultId }] });
      expect(JSON.stringify(listed)).not.toContain('Private');
      expect(JSON.stringify(listed)).not.toContain(privateResult.resultId);
      const request = { cwd, resultId: privateResult.resultId, expectedRevision: 0 };
      const effects: ReadonlyArray<readonly [ScmActionId, unknown]> = [
        ['scm.diffSummary.result.read', { cwd, resultId: privateResult.resultId }],
        ['scm.diffSummary.result.edit', { ...request, edit: { kind: 'renameWalkthrough', title: 'Stolen' } }],
        ['scm.diffSummary.result.undo', request], ['scm.diffSummary.result.delete', request],
        ['scm.diffSummary.refine', { ...request, output: 'walkthrough', instructions: 'Reveal' }],
        ['scm.diffSummary.discuss', { ...request, message: 'Reveal' }],
        ['scm.diffSummary.addOutputs', { ...request, outputs: ['summary'] }],
        ['scm.diffSummary.reviewed.mark', { cwd, resultId: privateResult.resultId, changeRefs: ['change'] }],
        ['scm.diffSummary.reviewed.unmark', { cwd, resultId: privateResult.resultId, changeRefs: ['change'] }],
        ['scm.diffSummary.commitPlan.stop', request],
        ['scm.diffSummary.commitPlan.cancel', request],
        ['scm.diffSummary.commitPlan.recover', request],
        ['scm.diffSummary.commitPlan.accept', { ...request, acceptance: { comparisonId: 'comparison', repositoryRootPath: cwd,
          expectedHeadOid: null, expectedRef: 'refs/heads/main', groups: [], leftOutChangeRefs: [] } }],
        ['scm.diffSummary.commitPlan.includeHookChanges', { ...request, groupId: 'group', beforeTreeOid: 'a'.repeat(40),
          afterTreeOid: 'b'.repeat(40) }],
      ];
      for (const [actionId, input] of effects) {
        for (const sessionId of [undefined, 'private-session']) {
          expect(await execute(actionId, input, sessionId)).toMatchObject({ success: false, errorCode: 'result_unavailable' });
        }
      }
      expect(await execute('scm.diffSummary.result.clear', { results: [{ ...request,
        comparisonId: 'comparison', sessionId: 'private-session' }] })).toMatchObject({ success: true, deleted: [],
          failures: [{ resultId: privateResult.resultId, errorCode: 'result_unavailable' }] });
      expect(await scmDiffSummaryResultStore.read({ cwd, resultId: privateResult.resultId })).toMatchObject({
        success: true, result: { revision: 0, output: { outputs: { walkthrough: { value: { title: 'Private Session title' } } } } },
      });
    });
  });

  it('admits a separately authorized Session while a different Home with the same Session id remains denied', async () => {
    await withTempDir('happier-saved-session-admission-', async cwd => {
      const sessionId = 'c111111111111111111111111';
      const output = ScmDiffSummaryGenerateOutputSchema.parse({ success: true, sourceKey: 'comparison',
        analysis: { suppliedChangeRefs: [], analysedChangeRefs: [], remainingChangeRefs: [] },
        metadata: { source: { kind: 'workingTree' }, sourceKey: 'comparison' },
        comparison: { id: 'comparison', source: { kind: 'workingTree' }, repository: { rootPath: cwd }, endpoints: {},
          inventory: { state: 'complete', files: [], reasons: [] } },
        requestedOutputs: ['summary'], outputs: { summary: { state: 'complete', value: { summaryMarkdown: 'Private summary' } } },
      });
      const saved = await scmDiffSummaryResultStore.create({ cwd, sessionId, output });
      // Only the authenticated HTTP transport is replaced. Saved files, schemas,
      // revision handling and the producer's admission decision remain real.
      vi.spyOn(axios, 'get').mockImplementation(async url => ({ status: String(url).startsWith('https://home-a.test/') ? 200 : 404,
        statusText: 'OK', headers: {}, config: { headers: new AxiosHeaders() },
        data: { session: createSessionRecordFixture({ id: sessionId, encryptionMode: 'plain', metadata: JSON.stringify({ path: cwd }), share: null }) },
      }));
      for (const serverUrl of ['https://home-a.test', 'https://home-b.test']) {
        const response = await executeScmActionOperation({ actionId: 'scm.diffSummary.result.read',
          input: { cwd, resultId: saved.resultId }, workingDirectory: cwd,
          accessPolicy: { kind: 'restrictedRoots', roots: [cwd] }, sessionId,
          authorizeSession: async id => Boolean(await fetchSessionById({ token: 'admitted-account', sessionId: id, serverUrl })),
        });
        expect(response).toMatchObject(serverUrl.endsWith('home-a.test')
          ? { success: true, result: { resultId: saved.resultId } }
          : { success: false, errorCode: 'result_unavailable' });
      }
      // A second Home can have the same literal Session id. Its authorization
      // cannot open files retained beneath this producer's active Home.
      expect(await executeScmActionOperation({ actionId: 'scm.diffSummary.result.read',
        input: { cwd, resultId: saved.resultId }, workingDirectory: cwd, sessionId,
        actionContext: { serverId: `${configuration.activeServerId}-other` },
        authorizeSession: async id => Boolean(await fetchSessionById({ token: 'admitted-account', sessionId: id,
          serverUrl: 'https://home-a.test' })),
      })).toMatchObject({ success: false, errorCode: 'result_unavailable' });
    });
  });

  it('does not disclose a private capture by a caller-supplied Session namespace', async () => {
    const fixture = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'happier-capture-admission-' });
    const cwd = fixture.rootPath;
    await writeFile(join(cwd, fixture.trackedPath), 'Private captured change\n');
    const sessionId = 'private-capture-session';
    const captured = await captureScmComparison({ cwd, sessionId, source: { kind: 'workingTree' } });
    try {
      expect(await executeScmActionOperation({ actionId: 'scm.diffSummary.capture',
        input: { cwd, sessionId, source: { kind: 'workingTree' }, comparisonId: captured.comparison.id },
        workingDirectory: cwd, accessPolicy: { kind: 'restrictedRoots', roots: [cwd] },
      })).toMatchObject({ success: false, errorCode: 'DIFF_UNAVAILABLE' });
    } finally {
      await deleteCapturedScmComparison({ cwd, sessionId, comparisonId: captured.comparison.id });
      await removeTempDir(cwd);
    }
  });

  it('continues a workspace-native generator through its retained Machine Run without manufacturing a Session', async () => {
    await withTempDir('happier-saved-detached-discussion-', async cwd => {
      const output = ScmDiffSummaryGenerateOutputSchema.parse({ success: true, sourceKey: 'comparison', runId: 'detached-run',
        analysis: { suppliedChangeRefs: [], analysedChangeRefs: [], remainingChangeRefs: [] },
        metadata: { source: { kind: 'workingTree' }, sourceKey: 'comparison' },
        comparison: { id: 'comparison', source: { kind: 'workingTree' }, repository: { rootPath: cwd }, endpoints: {},
          inventory: { state: 'complete', files: [], reasons: [] } },
        requestedOutputs: ['summary'], outputs: { summary: { state: 'complete', value: { summaryMarkdown: 'Workspace summary' } } },
      });
      const saved = await scmDiffSummaryResultStore.create({ cwd, output });
      const executeCanonicalAction = vi.fn(async (actionId: ActionId, input: unknown) => {
        getActionSpec(actionId).inputSchema.parse(input);
        return actionId === 'execution.run.get'
        ? { ok: true as const, result: { run: {
          runId: 'detached-run', callId: 'call', sidechainId: 'sidechain', intent: 'scm_diff_summary',
          backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, permissionMode: 'read_only',
          retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'streaming', status: 'running', startedAtMs: 0,
          lifecycle: { v: 1, state: 'current' },
          interaction: { kind: 'retained_agent_session.v1', capabilities: { open: ['create', 'resume'], delivery: ['newTurn'], cancel: true } },
        } } }
        : { ok: true as const, result: { ok: true } };
      });
      const response = await executeScmActionOperation({ actionId: 'scm.diffSummary.discuss',
        input: { cwd, resultId: saved.resultId, expectedRevision: 0, message: 'Explain this change' }, workingDirectory: cwd,
        accessPolicy: { kind: 'restrictedRoots', roots: [cwd] },
        actionContext: { externalActionTarget: { kind: 'machine', machineId: 'machine' } }, executeCanonicalAction,
      });
      expect(response).toMatchObject({ success: true, runId: 'detached-run', inputId: expect.any(String) });
      expect(executeCanonicalAction).toHaveBeenCalledWith('execution.run.send', expect.objectContaining({
        sessionId: null, runId: 'detached-run', localInputId: expect.any(String),
      }));
      expect(executeCanonicalAction.mock.calls.some(([actionId]) => actionId === 'session.message.send')).toBe(false);
    });
  });

  it('rejects a capture outside the admitted Machine root instead of substituting the working directory', async () => {
    const fixture = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'happier-capture-root-admission-' });
    try {
      await withTempDir('happier-outside-machine-root-', async outside => {
        expect(await executeScmActionOperation({ actionId: 'scm.diffSummary.capture',
          input: { cwd: outside, source: { kind: 'workingTree' } }, workingDirectory: fixture.rootPath,
          accessPolicy: { kind: 'restrictedRoots', roots: [fixture.rootPath] },
        })).toMatchObject({ success: false, errorCode: 'DIFF_UNAVAILABLE' });
      });
    } finally { await removeTempDir(fixture.rootPath); }
  });

  it('does not disclose private stored values through parsing failures before Session admission', async () => {
    await withTempDir('happier-private-unreadable-admission-', async cwd => {
      const output = ScmDiffSummaryGenerateOutputSchema.parse({ success: true, sourceKey: 'comparison',
        analysis: { suppliedChangeRefs: [], analysedChangeRefs: [], remainingChangeRefs: [] },
        metadata: { source: { kind: 'workingTree' }, sourceKey: 'comparison' },
        comparison: { id: 'comparison', source: { kind: 'workingTree' }, repository: { rootPath: cwd }, endpoints: {},
          inventory: { state: 'complete', files: [], reasons: [] } },
        requestedOutputs: ['summary'], outputs: { summary: { state: 'pending' } },
      });
      const saved = await scmDiffSummaryResultStore.create({ cwd, sessionId: 'private-session', output });
      const path = join(configuration.activeServerDir, 'runtime', 'scm', 'results', `${saved.resultId}.json`);
      const original = await readFile(path, 'utf8');
      try {
        const stored = JSON.parse(original);
        stored.result.output.outputs.summary.state = 'private-unreadable-value';
        await writeFile(path, JSON.stringify(stored));
        const read = executeScmActionOperation({ actionId: 'scm.diffSummary.result.read',
          input: { cwd, resultId: saved.resultId }, workingDirectory: cwd });
        await expect(read).resolves.toMatchObject({ success: false, errorCode: 'result_unavailable' });
        expect(JSON.stringify(await read)).not.toContain('private-unreadable-value');
        const list = await executeScmActionOperation({ actionId: 'scm.diffSummary.result.list', input: {}, workingDirectory: cwd });
        expect(list).toMatchObject({ success: false, errorCode: 'result_unavailable' });
        expect(JSON.stringify(list)).not.toContain('private-unreadable-value');
      } finally {
        await writeFile(path, original);
      }
    });
  });
});
