import axios, { AxiosHeaders } from 'axios';
import nacl from 'tweetnacl';
import { API_TOKEN_FULL_GRANT_V1 } from '@happier-dev/protocol/auth/apiTokenGrant';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { bindScmRefineSavedSessionV1, signExternalActionApprovalInputV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { createActionExecutor, type ActionExecutorContext } from '@happier-dev/protocol';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ScmDiffSummaryGenerateOutputSchema, createScmReviewedMarksRecordPort, applyScmReviewedMarkIntent, getActionSpec, type ActionId, type ScmActionId } from '@happier-dev/protocol';
import { scmDiffSummaryResultStore } from '@/agent/executionRuns/tasks/scmDiffSummary/results/resultStore';
import { withTempDir } from '@/testkit/fs/tempDir';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { fetchSessionById } from '@/session/transport/http/sessionsHttp';
import { executeScmActionOperation, type ExecuteScmActionOperationParams } from './executeScmActionOperation';
import { configuration } from '@/configuration';
import { createLocalScmRepositoryFixture } from '@/testkit/scm/scmBackendContractFixtures';
import { captureScmComparison, deleteCapturedScmComparison } from '@/scm/comparisons/captureScmComparison';
import { removeTempDir } from '@/testkit/fs/tempDir';
import { buildReviewUnits, buildScmChangeKeys } from '@happier-dev/protocol/scm/comparisonOccurrences';
import { ScmDiffFileResponseSchema } from '@happier-dev/protocol/scm';
import { createTestGitScmBackendRegistry } from '@/scm/rpc/__tests__/testRpcHarness';
import { retainExecutionRunState } from '@/daemon/executionRunRegistry';

afterEach(() => vi.restoreAllMocks());

describe('saved SCM producer admission', () => {
  it('admits usage scope only for in-window SCM runs and still excludes private costs', async () => {
    await withTempDir('happier-usage-scope-', async cwd => {
      const now = Date.now();
      const day = 24 * 60 * 60 * 1000;
      const records = [
        { sessionId: 'usage-allowed', intent: 'scm_diff_summary', startedAtMs: now - 100, cost: 1 },
        { sessionId: 'usage-private', intent: 'scm_diff_summary', startedAtMs: now - 100, cost: 100 },
        { sessionId: 'usage-finished', intent: 'scm_diff_summary', startedAtMs: now - 8 * day, finishedAtMs: now - 100, cost: 0.5 },
        { sessionId: 'usage-review', intent: 'review', startedAtMs: now - 100, cost: 100 },
        { sessionId: 'usage-old', intent: 'scm_diff_summary', startedAtMs: now - 8 * day, cost: 100 },
        { sessionId: 'usage-future', intent: 'scm_diff_summary', startedAtMs: now + day, cost: 100 },
      ] as const;
      for (const record of records) {
        await retainExecutionRunState({ runId: record.sessionId, callId: record.sessionId, sidechainId: record.sessionId,
          sessionId: record.sessionId, depth: 0, intent: record.intent,
          backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, backendId: 'codex', instructions: 'Read',
          permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: 'bounded', ioMode: 'request_response',
          launch: { cwd }, status: 'succeeded', startedAtMs: record.startedAtMs,
          ...('finishedAtMs' in record ? { finishedAtMs: record.finishedAtMs } : {}),
          structuredMeta: { kind: 'scm_diff_summary.v1', payload: ScmDiffSummaryGenerateOutputSchema.parse({
            success: true, summaryMarkdown: 'Retained', sourceKey: 'usage',
            metadata: { source: { kind: 'workingTree' }, sourceKey: 'usage' }, cost: { estimatedUsd: record.cost } }) },
        });
      }
      const admitted: (string | undefined)[] = [];
      const response = await executeScmActionOperation({ actionId: 'scm.diffSummary.result.list', input: { includeUsage: true },
        workingDirectory: cwd, accessPolicy: { kind: 'restrictedRoots', roots: [cwd] },
        // This is the real caller's Session authorization boundary, not a substituted scope owner.
        authorizeSession: async id => { admitted.push(id); return id !== 'usage-private'; } });
      expect(response).toMatchObject({ success: true, sevenDayCost: {
        status: 'partial', estimatedUsd: 1.5, pricedRunCount: 2, unpricedRunCount: 0 } });
      expect(admitted.sort()).toEqual(['usage-allowed', 'usage-finished', 'usage-private']);
    });
  });

  it('spends a restricted Refine grant on its own child, never on direct Session send', async () => {
    await withTempDir('happier-refine-root-', async cwd => {
      const sessionId = 'session';
      const output = ScmDiffSummaryGenerateOutputSchema.parse({ success: true, sourceKey: 'comparison',
        metadata: { source: { kind: 'workingTree' }, sourceKey: 'comparison' },
        comparison: { id: 'comparison', source: { kind: 'workingTree' }, repository: { rootPath: cwd }, endpoints: {},
          inventory: { state: 'complete', files: [], reasons: [] } },
        requestedOutputs: ['walkthrough'], outputs: { walkthrough: { state: 'complete', value: {
          title: 'Saved', intro: '', stops: [], otherChangeRefs: [] } } },
        analysis: { suppliedChangeRefs: [], analysedChangeRefs: [], remainingChangeRefs: [] }, runId: 'saved-generator' });
      const saved = await scmDiffSummaryResultStore.create({ cwd, sessionId, output });
      const grant = { ...API_TOKEN_FULL_GRANT_V1, actions: { families: [], ids: [
        'scm.diffSummary.refine', 'execution.run.get', 'execution.run.ensure',
      ] }, targets: { sessions: [sessionId], machines: ['machine'] } };
      const credential = { accountId: 'account', principalId: 'principal', credentialId: 'pat', grant };
      const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-issued-refine', binding: {
        serverIdentityId: 'home', accountId: 'account', custodianAccountId: 'account', principalId: credential.principalId,
        credentialId: credential.credentialId, grant, machineId: 'machine', installationId: 'installation',
        actionId: 'scm.diffSummary.refine', requestId: 'refine-input', requestEnvelopeDigest: 'A'.repeat(43),
        target: { kind: 'machine', machineId: 'machine' },
      } });
      const keys = nacl.sign.keyPair();
      const context: ActionExecutorContext = { surface: 'api', authority: 'account_automation',
        actionCaller: { kind: 'host' }, externalActionCredential: credential, externalActionExecutionAuthorization: authorization,
        externalActionTarget: authorization.binding.target, defaultSessionId: sessionId, defaultSessionMachineId: 'machine',
        signExternalActionApprovalInput: args => signExternalActionApprovalInputV1({ authorizationToken: args.authorization.token,
          actionId: args.actionId, target: args.target, input: args.input, privateKey: keys.secretKey }),
      };
      const sends: string[] = [];
      vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, statusText: 'OK', headers: {},
        config: { headers: new AxiosHeaders() }, data: { session: createSessionRecordFixture({ id: sessionId,
          encryptionMode: 'plain', metadata: JSON.stringify({ path: cwd }), share: null }) } });
      // Only daemon Run/message transport is replaced; saved-scope admission and child policy stay real.
      const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(),
        scmActionExecute: async args => executeScmActionOperation({ actionId: args.actionId,
          input: args.input, workingDirectory: cwd, sessionId, actionContext: args.context, executeCanonicalAction: args.executeCanonicalAction,
          authorizeSession: async id => Boolean(id && await fetchSessionById({ reason: 'session-control', token: 'fixture-account', sessionId: id })) }),
        executionRunGet: async () => ({ run: { runId: 'saved-generator', callId: 'call', sidechainId: 'sidechain',
          intent: 'scm_diff_summary', backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
          permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'streaming',
          status: 'running', startedAtMs: 0, lifecycle: { v: 1, state: 'current' },
          interaction: { kind: 'retained_agent_session.v1', capabilities: { open: ['create', 'resume'], delivery: ['newTurn'], cancel: true } } } }),
        sessionSendMessage: async request => { sends.push(request.localId!); return { status: 'accepted', localId: request.localId! }; },
      });
      const input = { cwd, resultId: saved.resultId, expectedRevision: saved.revision, output: 'walkthrough', instructions: 'Clarify.' };
      const refined = await executor.execute('scm.diffSummary.refine', input, context);
      expect(refined, JSON.stringify(refined)).toMatchObject({ ok: true,
        result: { success: true, inputId: 'refine-input' } });
      expect(sends).toEqual(['refine-input']);
      // Even the real bound fact and matching input id cannot turn a direct call into a private child.
      const bound = bindScmRefineSavedSessionV1({ authorization, sessionId, sign: context.signExternalActionApprovalInput! });
      expect(await executor.execute('session.message.send', { sessionId, message: 'Not a Refine child', localId: 'refine-input',
        recipient: { kind: 'execution_run', runId: 'saved-generator' }, requestedAction: { v: 1, kind: 'send_now' } },
        { ...context, externalActionExecutionAuthorization: bound }))
        .toMatchObject({ ok: false, errorCode: 'credential_scope_denied' });
      expect(sends).toHaveLength(1);
      expect(await executor.execute('scm.diffSummary.refine', input, { ...context,
        externalActionCredential: { ...credential, grant: { ...grant,
          actions: { families: [], ids: ['execution.run.get', 'execution.run.ensure'] } } } }))
        .toMatchObject({ ok: false, errorCode: 'credential_scope_denied' });
      expect(sends).toHaveLength(1);
    });
  });

  it('keeps comparison selection body-free and reads an admitted exact id once, without disclosing denied scopes', async () => {
    await withTempDir('happier-saved-selection-', async cwd => {
      const output = ScmDiffSummaryGenerateOutputSchema.parse({ success: true, sourceKey: 'selected-comparison',
        metadata: { source: { kind: 'workingTree' }, sourceKey: 'selected-comparison' },
        comparison: { id: 'selected-comparison', source: { kind: 'workingTree' }, repository: { rootPath: cwd }, endpoints: {},
          inventory: { state: 'complete', files: [], reasons: [] } }, requestedOutputs: ['walkthrough'],
        outputs: { walkthrough: { state: 'complete', value: { title: 'Allowed', intro: '', stops: [], otherChangeRefs: [] } } },
        analysis: { suppliedChangeRefs: [], analysedChangeRefs: [], remainingChangeRefs: [] } });
      const allowed = await scmDiffSummaryResultStore.create({ cwd, output });
      const denied = await scmDiffSummaryResultStore.create({ cwd, sessionId: 'private', output });
      const parse = JSON.parse;
      let bodies = 0;
      const spy = vi.spyOn(JSON, 'parse').mockImplementation((text, reviver) => {
        if (typeof text === 'string' && text.startsWith('{"result":')) bodies++;
        return parse(text, reviver);
      });
      try {
        const base = { workingDirectory: cwd, accessPolicy: { kind: 'restrictedRoots' as const, roots: [cwd] } };
        const selected = await executeScmActionOperation({ ...base, actionId: 'scm.diffSummary.result.list',
          input: { query: { cwd, sessionId: null, comparisons: [{ source: { kind: 'workingTree' }, outputs: ['walkthrough'] }] } } });
        expect(selected).toMatchObject({ success: true, count: 1, results: [{ resultId: allowed.resultId }] });
        expect(selected).not.toHaveProperty('sevenDayCost');
        expect(bodies).toBe(0);
        expect(await executeScmActionOperation({ ...base, actionId: 'scm.diffSummary.result.list',
          input: { query: { cwd, sessionId: 'private', comparisons: [{ source: { kind: 'workingTree' }, outputs: ['walkthrough'] }] } } }))
          .toMatchObject({ success: true, count: 0, bytes: 0, results: [] });
        bodies = 0;
        expect(await executeScmActionOperation({ ...base, actionId: 'scm.diffSummary.result.read', input: { cwd, resultId: allowed.resultId } }))
          .toMatchObject({ success: true });
        expect(bodies).toBe(1);
        bodies = 0;
        const refused = await executeScmActionOperation({ ...base, actionId: 'scm.diffSummary.result.read', input: { cwd, resultId: denied.resultId } });
        expect(refused).toMatchObject({ success: false, errorCode: 'result_unavailable' });
        expect(refused).not.toHaveProperty('result');
        expect(bodies).toBe(1);
        bodies = 0;
        const settings = await executeScmActionOperation({ ...base, actionId: 'scm.diffSummary.result.list', input: { includeUsage: true } });
        expect(settings).toMatchObject({ success: true, count: 1, sevenDayCost: { status: 'unavailable' } });
        expect(bodies).toBe(0);
        expect(JSON.stringify(settings)).not.toContain(denied.resultId);
      } finally {
        spy.mockRestore();
        await scmDiffSummaryResultStore.delete({ cwd, resultId: allowed.resultId, expectedRevision: 0 });
        await scmDiffSummaryResultStore.delete({ cwd, sessionId: 'private', resultId: denied.resultId, expectedRevision: 0 });
      }
    });
  });
  it('marks the live working-tree diff by content key without capturing it, and rejects stale keys', async () => {
    const fixture = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'happier-live-marks-' });
    const cwd = fixture.rootPath;
    let value: unknown = null; let version = -1;
    const transport = { read: async () => ({ value, version }), compareAndSet: async (next: unknown) => {
      value = next; return { success: true as const, version: ++version };
    } };
    const executeReviewedMarks: NonNullable<ExecuteScmActionOperationParams['executeReviewedMarks']> = (evidence, request, reviewed) => {
      const port = createScmReviewedMarksRecordPort('id' in evidence ? { comparison: evidence, transport } : { source: evidence, transport });
      return 'reset' in request ? port.clear() : 'changeKeys' in request ? port.setReviewedKeys(request.changeKeys, reviewed) : port.setReviewed(request.changeRefs, reviewed);
    };
    const base = { workingDirectory: cwd, accessPolicy: { kind: 'restrictedRoots' as const, roots: [cwd] },
      registry: createTestGitScmBackendRegistry(), executeReviewedMarks };
    try {
      await writeFile(join(cwd, fixture.trackedPath), 'Live change without a capture\n');
      await writeFile(join(cwd, 'untracked.txt'), 'Another live file\n');
      const diff = ScmDiffFileResponseSchema.parse(await executeScmActionOperation({ ...base, actionId: 'scm.diff.file', input: { cwd, path: fixture.trackedPath, area: 'both' } }));
      expect(diff.success, JSON.stringify(diff)).toBe(true);
      const changeKeys = buildReviewUnits(fixture.trackedPath, 'combined', diff.diff ?? '').map(unit => unit.key);
      expect(changeKeys.length).toBeGreaterThan(0);
      const input = { v: 2, cwd, source: { kind: 'workingTree' }, changeKeys };
      expect(await executeScmActionOperation({ ...base, actionId: 'scm.diffSummary.reviewed.mark', input }))
        .toMatchObject({ success: true, record: { reviewedChangeKeys: changeKeys } });
      if (!value || typeof value !== 'object') throw new Error('Mark did not produce a record');
      value = { ...value, reviewedChangeKeys: [...changeKeys, 'obsolete-key'] };
      expect(await executeScmActionOperation({ ...base, actionId: 'scm.diffSummary.reviewed.unmark',
        input: { v: 2, cwd, source: { kind: 'workingTree' }, reset: true } }))
        .toMatchObject({ success: true, record: { reviewedChangeKeys: [] } });
      expect(await executeScmActionOperation({ ...base, actionId: 'scm.diffSummary.reviewed.mark', input }))
        .toMatchObject({ success: true, record: { reviewedChangeKeys: changeKeys } });
      await writeFile(join(cwd, fixture.trackedPath), 'Rewritten after display\n');
      expect(await executeScmActionOperation({ ...base, actionId: 'scm.diffSummary.reviewed.unmark', input }))
        .toMatchObject({ success: false, errorCode: 'reviewed_marks_invalid_selection' });
      expect(value).toMatchObject({ reviewedChangeKeys: changeKeys });
    } finally { await removeTempDir(cwd); }
  });
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
    const executeReviewedMarks = vi.fn<NonNullable<ExecuteScmActionOperationParams['executeReviewedMarks']>>((evidence, request, reviewed) => {
      const port = createScmReviewedMarksRecordPort('id' in evidence ? { comparison: evidence, transport } : { source: evidence, transport });
      return 'reset' in request ? port.clear() : 'changeKeys' in request ? port.setReviewedKeys(request.changeKeys, reviewed) : port.setReviewed(request.changeRefs, reviewed);
    });
    const base = { workingDirectory: cwd, accessPolicy: { kind: 'restrictedRoots' as const, roots: [cwd] }, executeReviewedMarks };
    const input = { v: 2, cwd, comparisonId: captured.comparison.id, source: captured.comparison.source, changeRefs: refs };
    try {
      expect(await executeScmActionOperation({ ...base, actionId: 'scm.diffSummary.reviewed.mark', input }))
        .toMatchObject({ success: true, record: applyScmReviewedMarkIntent(captured.comparison, null, refs, true) });
      expect(await executeScmActionOperation({ ...base, actionId: 'scm.diffSummary.reviewed.unmark', input }))
        .toMatchObject({ success: true, record: { reviewedChangeKeys: [] } });
      const changeKeys = [...buildScmChangeKeys(captured.comparison).values()].flat();
      const { changeRefs: _refs, ...capturedSelector } = input;
      expect(await executeScmActionOperation({ ...base, actionId: 'scm.diffSummary.reviewed.mark',
        input: { ...capturedSelector, changeKeys: [changeKeys[0]] } }))
        .toMatchObject({ success: true, record: { reviewedChangeKeys: [changeKeys[0]] } });
      expect(await executeScmActionOperation({ ...base, actionId: 'scm.diffSummary.reviewed.mark',
        input: { ...capturedSelector, changeKeys: ['forged'] } }))
        .toMatchObject({ success: false });
      expect(value).toMatchObject({ reviewedChangeKeys: [changeKeys[0]] });
      value = { ...applyScmReviewedMarkIntent(captured.comparison, null, refs, true), reviewedChangeKeys: [...changeKeys, 'obsolete-key'] };
      const reset = { ...capturedSelector, reset: true };
      await expect(executeScmActionOperation({ ...base, actionId: 'scm.diffSummary.reviewed.mark', input: reset }))
        .rejects.toBeInstanceOf(Error);
      expect(await executeScmActionOperation({ ...base, actionId: 'scm.diffSummary.reviewed.unmark', input: reset }))
        .toMatchObject({ success: true, record: { reviewedChangeKeys: [] } });
      executeReviewedMarks.mockClear();
      for (const rejected of [
        { input: { ...input, comparisonId: privateCapture.comparison.id, sessionId: 'private' } },
        { input, actionContext: { serverId: `${configuration.activeServerId}-other` } },
        { input: { ...input, cwd: join(cwd, '..') } },
      ]) {
        expect(await executeScmActionOperation({ ...base, actionId: 'scm.diffSummary.reviewed.mark', ...rejected }))
          .toMatchObject({ success: false, errorCode: 'result_unavailable' });
        const { changeRefs: _selection, ...resetInput } = rejected.input;
        expect(await executeScmActionOperation({ ...base, actionId: 'scm.diffSummary.reviewed.unmark', ...rejected,
          input: { ...resetInput, reset: true } }))
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
          authorizeSession: async id => id !== undefined && Boolean(await fetchSessionById({ reason: 'session-control', token: 'admitted-account', sessionId: id, serverUrl })),
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
        authorizeSession: async id => id !== undefined && Boolean(await fetchSessionById({ reason: 'session-control', token: 'admitted-account', sessionId: id,
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
        expect(list).toMatchObject({ success: true });
        expect(JSON.stringify(list)).not.toContain(saved.resultId);
        expect(JSON.stringify(list)).not.toContain('private-unreadable-value');
      } finally {
        await writeFile(path, original);
      }
    });
  });
});
