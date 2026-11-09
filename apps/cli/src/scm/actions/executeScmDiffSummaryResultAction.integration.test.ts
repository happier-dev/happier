import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import axios, { AxiosHeaders } from 'axios';
import { createActionExecutor, getActionSpec, ScmDiffSummaryGenerateOutputSchema, ExecutionRunGetResponseSchema, ExecutionRunStartRequestSchema, ProviderBoundModelRefSchema, type ActionExecutorContext, type ActionExecutorDeps, type ScmActionExecute } from '@happier-dev/protocol';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { scmDiffSummaryResultStore } from '@/agent/executionRuns/tasks/scmDiffSummary/results/resultStore';
import { executeScmActionOperation as executeScmOperation } from './executeScmActionOperation';
import { fetchSessionById } from '@/session/transport/http/sessionsHttp';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { configuration } from '@/configuration';
import { buildBackendTargetKeyV2, readBackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { TeamCredentialProviderModelSelectionV1Schema } from '@happier-dev/protocol/teams/credentials/resourceV1';
import { readMessageDisplayText } from '@happier-dev/session-core/messages';
import { SessionMessageMetaSchema } from '@happier-dev/protocol/sessions/messages/sessionMessageMeta';
import { deriveWorkflowReplacementId } from '@happier-dev/protocol/workflows/workflowInvocationIdentityV1';
import { publishSavedScmDiffSummaryTurn } from '@/agent/runtime/bridges/executionRun/kinds/scmDiffSummary/publishSavedScmDiffSummaryTurn';

const cwd = '/saved/repository';
beforeEach(() => {
  vi.spyOn(axios, 'get').mockImplementation(async url => ({ status: 200, statusText: 'OK', headers: {},
    config: { headers: new AxiosHeaders() }, data: { session: createSessionRecordFixture({
      id: decodeURIComponent(String(url).split('/').at(-1)!.split('?')[0]), encryptionMode: 'plain',
      metadata: JSON.stringify({ path: cwd }), share: null,
    }) },
  }));
});
afterEach(() => vi.restoreAllMocks());
const executeScmActionOperation = (params: Parameters<typeof executeScmOperation>[0]) => executeScmOperation({ ...params,
  // The authenticated Home network is replaced; the Session parser and admission are real.
  authorizeSession: async sessionId => sessionId === undefined || Boolean(await fetchSessionById({ reason: 'session-control', token: 'authorized-account', sessionId })),
});
const output = ScmDiffSummaryGenerateOutputSchema.parse({ success: true, sourceKey: 'comparison',
  metadata: { source: { kind: 'workingTree' }, sourceKey: 'comparison' },
  comparison: { id: 'comparison', source: { kind: 'workingTree' }, repository: { rootPath: cwd }, endpoints: {},
    inventory: { state: 'complete', files: [], reasons: [] } },
  requestedOutputs: ['summary', 'walkthrough'], outputs: {
    summary: { state: 'complete', value: { summaryMarkdown: 'Preserved summary' } },
    walkthrough: { state: 'complete', value: { title: 'Original', intro: 'Intro', stops: [], otherChangeRefs: [] } },
  }, analysis: { suppliedChangeRefs: [], analysedChangeRefs: [], remainingChangeRefs: [] }, runId: 'saved-generator',
});
const run = {
  runId: 'saved-generator', callId: 'call', sidechainId: 'sidechain', intent: 'scm_diff_summary',
  backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
  permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'streaming',
  status: 'running', startedAtMs: 0, lifecycle: { v: 1, state: 'current' },
  interaction: { kind: 'retained_agent_session.v1', capabilities: { open: ['create', 'resume'], delivery: ['newTurn'], cancel: true } },
} as const;

function createScmResultActionExecutor(scmActionExecute: NonNullable<ActionExecutorDeps['scmActionExecute']>,
  transports: Partial<Pick<ActionExecutorDeps, 'executionRunGet' | 'executionRunEnsure' | 'sessionSendMessage'>> = {}) {
  // This machine-transport fixture supplies the real SCM route; unrelated transport boundaries are not exercised.
  return createActionExecutor({ ...createUnavailableActionTransportDeps(), scmActionExecute, ...transports });
}

describe('saved SCM result Action boundary', () => {
  it('records the Add outputs request separately from its saved generator context', async () => {
    const saved = await scmDiffSummaryResultStore.create({ cwd, sessionId: 'session', output });
    const messages: Array<{ message: string; displayText?: string }> = [];
    const executor = createScmResultActionExecutor(({ actionId, input, context, executeCanonicalAction }) =>
      executeScmActionOperation({ actionId, input, actionContext: context, executeCanonicalAction,
        workingDirectory: cwd, accessPolicy: { kind: 'restrictedRoots', roots: [cwd] } }), {
      executionRunGet: async () => ({ run }),
      sessionSendMessage: async request => {
        messages.push({ message: request.message, displayText: request.displayText });
        return { status: 'accepted', localId: request.localId };
      },
    });
    try {
      expect(await executor.execute('scm.diffSummary.addOutputs', { cwd, resultId: saved.resultId,
        expectedRevision: saved.revision, outputs: ['commitPlan'] }, { surface: 'cli', bypassApprovals: true }))
        .toMatchObject({ ok: true, result: { success: true } });
      expect(messages).toHaveLength(1);
      const sent = messages[0]!;
      expect(typeof sent.displayText === 'string' && sent.displayText.includes('commitPlan')).toBe(true);
      expect(sent.displayText?.includes(saved.resultId)).toBe(false);
      expect(sent.message.includes(saved.resultId)).toBe(true);
      expect(readMessageDisplayText({ text: sent.message, displayText: sent.displayText }) === sent.message).toBe(false);
    } finally {
      await scmDiffSummaryResultStore.delete({ cwd, resultId: saved.resultId, expectedRevision: saved.revision });
    }
  });

  it('records only the supplied refinement instructions while delivering the full task to the generator', async () => {
    const instructions = 'Clarify the selection explanation.';
    const reading = { title: 'Selection', intro: 'Saved introduction', stops: [{ id: 'selection', title: 'Keep selection',
      explanationMarkdown: 'The selected change survives refresh.', changeRefs: [] }], otherChangeRefs: [] };
    const saved = await scmDiffSummaryResultStore.create({ cwd, sessionId: 'session', output: ScmDiffSummaryGenerateOutputSchema.parse({
      ...output, outputs: { ...output.outputs, walkthrough: { state: 'complete', value: reading } },
    }) });
    const messages: Array<{ message: string; displayText?: string }> = [];
    const executor = createScmResultActionExecutor(({ actionId, input, context, executeCanonicalAction }) =>
      executeScmActionOperation({ actionId, input, actionContext: context, executeCanonicalAction,
        workingDirectory: cwd, accessPolicy: { kind: 'restrictedRoots', roots: [cwd] } }), {
      executionRunGet: async () => ({ run }),
      // Replace only the remote Session transport. The public Action executor,
      // saved-result admission, prompt builder and transcript display reader are real.
      sessionSendMessage: async request => {
        messages.push({ message: request.message, displayText: request.displayText });
        return { status: 'accepted', localId: request.localId };
      },
    });
    try {
      expect(await executor.execute('scm.diffSummary.refine', { cwd, resultId: saved.resultId,
        expectedRevision: saved.revision, output: 'walkthrough', stopIds: ['selection'], instructions },
      { surface: 'cli', bypassApprovals: true })).toMatchObject({ ok: true, result: { success: true } });
      expect(messages).toHaveLength(1);
      const message = messages[0]!;
      const meta = SessionMessageMetaSchema.parse({ displayText: message.displayText });
      // Compare without dumping the internal task if the privacy assertion fails.
      expect(readMessageDisplayText({ text: message.message, displayText: meta.displayText }) === instructions).toBe(true);
      expect(message.message.includes(instructions)).toBe(true);
      expect(message.message.includes(saved.resultId)).toBe(true);
      expect(message.message.includes(reading.stops[0]!.explanationMarkdown)).toBe(true);
      expect(message.message === instructions).toBe(false);
    } finally {
      await scmDiffSummaryResultStore.delete({ cwd, resultId: saved.resultId, expectedRevision: saved.revision });
    }
  });
  it('refines the full current reading from a stop conversation and publishes an update receipt', async () => {
    const stops = ['one', 'two', 'three', 'four'].map(id => ({ id, title: id,
      explanationMarkdown: `Explanation ${id}`, changeRefs: [] }));
    const saved = await scmDiffSummaryResultStore.create({ cwd, sessionId: 'session', output: ScmDiffSummaryGenerateOutputSchema.parse({
      ...output, outputs: { ...output.outputs, walkthrough: { state: 'complete', value: {
        title: 'Original', intro: 'Intro', stops, otherChangeRefs: [],
      } } },
    }) });
    const edited = await scmDiffSummaryResultStore.edit({ cwd, resultId: saved.resultId, expectedRevision: saved.revision,
      edit: { kind: 'renameWalkthrough', title: 'My title' } });
    if (!edited.success) throw new Error(edited.error);
    let inputId = '';
    let prompt = '';
    const executor = createScmResultActionExecutor(({ actionId, input, context, executeCanonicalAction }) =>
      executeScmActionOperation({ actionId, input, actionContext: context, executeCanonicalAction,
        workingDirectory: cwd, accessPolicy: { kind: 'restrictedRoots', roots: [cwd] } }), {
      executionRunGet: async () => ({ run }),
      sessionSendMessage: async request => {
        inputId = request.localId!; prompt = request.message;
        return { status: 'accepted', localId: inputId };
      },
    });
    expect(await executor.execute('scm.diffSummary.discuss', { cwd, resultId: saved.resultId,
      expectedRevision: edited.result.revision, stopIds: ['one'], message: 'Merge stops two and three.' },
    { surface: 'cli', bypassApprovals: true })).toMatchObject({ ok: true, result: { success: true } });
    for (const stop of stops) expect(prompt).toContain(stop.explanationMarkdown);
    expect(prompt).not.toContain('not a request to regenerate or edit saved outputs');
    const pending = await scmDiffSummaryResultStore.readInput({ cwd, resultId: saved.resultId, inputIds: [inputId] });
    expect(pending).toMatchObject({ baseRevision: edited.result.revision, outputs: ['summary', 'walkthrough'] });
    expect(pending?.stopIds).toBeUndefined();
    const merged = { title: 'Model title', intro: 'Intro', stops: [stops[0], {
      id: 'two', title: 'Merged', explanationMarkdown: 'Combined explanation', changeRefs: [],
    }, stops[3]], otherChangeRefs: [] };
    const complete = await publishSavedScmDiffSummaryTurn({ start: { ...run, sessionId: 'session', backendId: 'codex',
      instructions: '', intentInput: { cwd, comparison: output.comparison, resultId: saved.resultId, outputs: ['walkthrough'] } },
      turnId: 'conversation-refinement', inputIds: [inputId], previousStructuredMeta: { kind: 'scm_diff_summary.v1', payload: edited.result.output },
      rawText: JSON.stringify({ walkthrough: merged }), finishedAtMs: 10,
    }, () => null);
    expect(complete?.toolResultMeta).toMatchObject({ scmResultUpdate: { status: 'published', canUndo: true,
      outputs: [{ kind: 'walkthrough', change: 'updated' }] } });
    expect(await scmDiffSummaryResultStore.read({ cwd, resultId: saved.resultId })).toMatchObject({ success: true,
      result: { revision: edited.result.revision + 1, output: { outputs: { summary: output.outputs?.summary,
        walkthrough: { value: { title: 'My title', stops: merged.stops } } } } } });
    const latest = await scmDiffSummaryResultStore.read({ cwd, resultId: saved.resultId });
    if (!latest.success) throw new Error(latest.error);
    expect(await executor.execute('scm.diffSummary.discuss', { cwd, resultId: saved.resultId,
      expectedRevision: latest.result.revision, message: 'Why were these grouped?' },
    { surface: 'cli', bypassApprovals: true })).toMatchObject({ ok: true, result: { success: true } });
    expect(await publishSavedScmDiffSummaryTurn({ start: { ...run, sessionId: 'session', backendId: 'codex', instructions: '',
      intentInput: { cwd, comparison: output.comparison, resultId: saved.resultId, outputs: ['walkthrough'] } },
      turnId: 'conversation-question', inputIds: [inputId], previousStructuredMeta: { kind: 'scm_diff_summary.v1', payload: latest.result.output },
      rawText: 'They describe one change in behavior.', finishedAtMs: 11,
    }, () => null)).toBeNull();
    expect(await scmDiffSummaryResultStore.read({ cwd, resultId: saved.resultId })).toEqual(latest);
  });
  it('sends a suggested stop question to the retained Ask recipient without rewriting the reading', async () => {
    const question = 'Why keep the selection across refresh?';
    const reading = { title: 'Selection', intro: '', stops: [{ id: 'selection', title: 'Keep selection',
      explanationMarkdown: 'The selected change survives refresh.', changeRefs: [], suggestedQuestions: [question] }], otherChangeRefs: [] };
    const saved = await scmDiffSummaryResultStore.create({ cwd, sessionId: 'session', output: ScmDiffSummaryGenerateOutputSchema.parse({
      ...output, outputs: { ...output.outputs, walkthrough: { state: 'complete', value: reading } },
    }) });
    const messages: Array<{ recipient: unknown; message: string; displayText?: string }> = [];
    const metas: unknown[] = [];
    const executor = createScmResultActionExecutor(({ actionId, input, context, executeCanonicalAction }) =>
      executeScmActionOperation({ actionId, input, actionContext: context, executeCanonicalAction,
        workingDirectory: cwd, accessPolicy: { kind: 'restrictedRoots', roots: [cwd] } }), {
      executionRunGet: async () => ({ run }),
      sessionSendMessage: async request => {
        messages.push({ recipient: request.recipient, message: request.message, displayText: request.displayText });
        metas.push(request.messageMeta);
        return { status: 'accepted', localId: request.localId };
      },
    });
    expect(await executor.execute('scm.diffSummary.discuss', { cwd, resultId: saved.resultId, expectedRevision: saved.revision,
      stopIds: ['selection'], message: question }, { surface: 'cli', bypassApprovals: true }))
      .toMatchObject({ ok: true, result: { success: true, runId: run.runId } });
    expect(messages).toEqual([{ recipient: { kind: 'execution_run', runId: run.runId },
      message: expect.stringContaining(question), displayText: question }]);
    const displayedMeta = SessionMessageMetaSchema.parse({ displayText: messages[0]!.displayText });
    expect(readMessageDisplayText({ text: messages[0]!.message, displayText: displayedMeta.displayText })).toBe(question);
    // The question names the stop it was asked about on its own transcript row, so the walkthrough can project it.
    expect(SessionMessageMetaSchema.parse(metas[0]).scmWalkthroughQuestionV1)
      .toEqual({ resultId: saved.resultId, revision: saved.revision, stopIds: ['selection'] });
    expect(messages[0]!.message).toContain('The selected change survives refresh.');
    expect(messages[0]!.message).toContain('Answer the user in prose');
    expect(messages[0]!.message).not.toContain('For each finding');
    expect(messages[0]!.message).not.toContain('verdict');
    expect(await scmDiffSummaryResultStore.read({ cwd, resultId: saved.resultId })).toMatchObject({ success: true,
      result: { revision: saved.revision, output: { outputs: { walkthrough: { value: reading } } } } });
    expect(await executor.execute('session.message.send', { sessionId: 'session', message: 'A separate question',
      localId: 'separate-input' }, { surface: 'cli', bypassApprovals: true })).toMatchObject({ ok: true });
    expect(messages.at(-1)).toEqual({ recipient: undefined, message: 'A separate question', displayText: undefined });
    expect(metas.at(-1)).toBeUndefined();
    expect(await executor.execute('session.message.send', { sessionId: 'session', message: 'Agent-only text',
      displayText: 'Caller-supplied display' }, { surface: 'cli', bypassApprovals: true }))
      .toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    expect(messages).toHaveLength(2);
  });
  it.each([
    ['scm.diffSummary.refine', 'failed'], ['scm.diffSummary.refine', 'cancelled'],
    ['scm.diffSummary.discuss', 'failed'], ['scm.diffSummary.discuss', 'cancelled'],
    ['scm.diffSummary.addOutputs', 'running'],
  ] as const)(
    'admits %s to its %s original only after explicit recovery when required', async (actionId, status) => {
      const saved = await scmDiffSummaryResultStore.create({ cwd, sessionId: 'session', output });
      const admissions: string[] = [];
      let recoveryAccepted = status === 'running';
      const executor = createScmResultActionExecutor(({ actionId, input, context, executeCanonicalAction }) =>
        executeScmActionOperation({ actionId, input, actionContext: context, executeCanonicalAction,
          workingDirectory: cwd, accessPolicy: { kind: 'restrictedRoots', roots: [cwd] } }), {
        // These are the remote Run and Session transport boundaries. The Action executor,
        // saved-result owner, lifecycle projection and input bookkeeping remain real.
        executionRunGet: async () => ({ run: { ...run, status, ...(status === 'running' ? {} : { interaction: undefined,
          lifecycle: { v: 1 as const, state: 'recoverable' as const }, error: { code: 'execution_run_host_lost', message: 'Host lost' } }) } }),
        executionRunEnsure: async (_sessionId, request) => {
          expect(status).not.toBe('running');
          expect(request).toMatchObject({ runId: run.runId, resume: true });
          recoveryAccepted = true;
          return { ok: true };
        },
        sessionSendMessage: async request => {
          expect(recoveryAccepted).toBe(true);
          expect(request.recipient).toEqual({ kind: 'execution_run', runId: run.runId });
          admissions.push(request.localId!);
          return { status: 'accepted', localId: request.localId };
        },
      });
      const response = await executor.execute(actionId, { cwd, resultId: saved.resultId, expectedRevision: 0,
        ...(actionId === 'scm.diffSummary.refine' ? { output: 'walkthrough', instructions: 'Shorten it.' }
          : actionId === 'scm.diffSummary.addOutputs' ? { outputs: ['summary'] } : { message: 'Explain it.' }),
      }, { surface: 'cli', bypassApprovals: true });
      expect(response).toMatchObject({ ok: true, result: { success: true, runId: run.runId } });
      expect(admissions).toHaveLength(1);
      expect(await scmDiffSummaryResultStore.readInput({ cwd, resultId: saved.resultId, inputIds: admissions })).not.toBeNull();
    });

  it.each(['refused', 'transportFailure', 'typedTransportFailure'] as const)('preserves %s explicit recovery failure without admitting Refine input', async outcome => {
    const saved = await scmDiffSummaryResultStore.create({ cwd, sessionId: 'session', output });
    const send = vi.fn<NonNullable<ActionExecutorDeps['sessionSendMessage']>>(async request => ({ status: 'accepted', localId: request.localId }));
    const executor = createScmResultActionExecutor(({ actionId, input, context, executeCanonicalAction }) =>
      executeScmActionOperation({ actionId, input, actionContext: context, executeCanonicalAction,
        workingDirectory: cwd, accessPolicy: { kind: 'restrictedRoots', roots: [cwd] } }), {
      executionRunGet: async () => ({ run: { ...run, status: 'failed', interaction: undefined, lifecycle: { v: 1, state: 'recoverable' } } }),
      executionRunEnsure: async () => {
        if (outcome === 'transportFailure') throw new Error('Recovery transport unavailable');
        if (outcome === 'typedTransportFailure') throw Object.assign(new Error('Recovery connection lost'), { code: 'ECONNRESET' });
        return { ok: false, errorCode: 'execution_run_not_allowed', error: 'Explicit recovery refused' };
      },
      sessionSendMessage: send,
    });
    expect(await executor.execute('scm.diffSummary.refine', { cwd, resultId: saved.resultId, expectedRevision: 0,
      output: 'walkthrough', instructions: 'Shorten it.' }, { surface: 'cli', bypassApprovals: true }))
      .toMatchObject(outcome === 'refused'
        ? { ok: false, errorCode: 'execution_run_not_allowed', error: 'Explicit recovery refused' }
        : outcome === 'typedTransportFailure'
          ? { ok: false, errorCode: 'server_unreachable', error: 'Recovery connection lost' }
          : { ok: false, errorCode: 'action_failed', error: 'Recovery transport unavailable' });
    expect(send).not.toHaveBeenCalled();
    expect(await scmDiffSummaryResultStore.read({ cwd, resultId: saved.resultId })).toMatchObject({ success: true,
      result: { revision: saved.revision, output: saved.output } });
  });

  it.each(['rejected', 'outcomeUnknown', 'transportFailure', 'invalidParameters'] as const)('preserves the actual %s follow-up admission outcome', async outcome => {
    const saved = await scmDiffSummaryResultStore.create({ cwd, sessionId: 'session', output });
    let attemptedInputId = '';
    const response = await executeScmActionOperation({ actionId: 'scm.diffSummary.refine',
      input: { cwd, resultId: saved.resultId, expectedRevision: 0, output: 'walkthrough', instructions: 'Shorten the explanation.' },
      workingDirectory: cwd, accessPolicy: { kind: 'restrictedRoots', roots: [cwd] },
      executeCanonicalAction: async (actionId, request) => {
        if (actionId === 'execution.run.get') return { ok: true, result: { run: { ...run, status: 'failed',
          interaction: undefined, lifecycle: { v: 1, state: 'recoverable' } } } };
        if (actionId === 'execution.run.ensure') return { ok: true, result: { ok: true } };
        attemptedInputId = String((request as { localId: string }).localId);
        return outcome === 'invalidParameters' ? { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' }
        : outcome === 'transportFailure'
          ? { ok: false, errorCode: 'execution_run_target_unavailable', error: 'Execution Run executable snapshot is unavailable' }
          : { ok: true, result: outcome === 'rejected' ? { status: outcome, code: 'session_input_target_unavailable' }
            : { status: outcome, localId: 'uncertain-input', code: 'machine_admission_pending_custody_unconfirmed' } };
      },
    });
    const outputSchema = getActionSpec('scm.diffSummary.refine').outputSchema;
    if (!outputSchema) throw new Error('Missing SCM refinement output schema');
    outputSchema.parse(response);
    expect(response).toMatchObject({ success: false, errorCode: outcome === 'rejected' ? 'session_input_target_unavailable'
      : outcome === 'invalidParameters' ? 'invalid_parameters' : 'admission_unknown',
      error: outcome === 'transportFailure' ? expect.stringContaining('execution_run_target_unavailable')
        : outcome === 'outcomeUnknown' ? expect.stringContaining('machine_admission_pending_custody_unconfirmed')
        : outcome === 'invalidParameters' ? 'invalid_parameters'
        : 'session_input_target_unavailable' });
    expect(await scmDiffSummaryResultStore.read({ cwd, resultId: saved.resultId })).toMatchObject({ success: true,
      result: { output: { outputs: output.outputs } } });
    const pending = await scmDiffSummaryResultStore.readInput({ cwd, resultId: saved.resultId, inputIds: [attemptedInputId] });
    if (outcome === 'rejected' || outcome === 'invalidParameters') expect(pending).toBeNull();
    else expect(pending).not.toBeNull();
  });
  it('admits an RPC parent’s canonical child with its requester and approval context while refusing direct closed RPC', async () => {
    const saved = await scmDiffSummaryResultStore.create({ cwd, sessionId: 'session', output });
    const context: ActionExecutorContext = {
      surface: 'rpc', authority: 'account_automation', actionCaller: { kind: 'host' },
      runtimeAccountId: 'requester-account', serverId: configuration.activeServerId, actionRequestId: 'requester-attempt',
      bypassApprovals: true, callerPermissionMode: 'read-only',
      externalActionTarget: { kind: 'machine', machineId: 'machine' },
      rpcSessionAuthorization: { kind: 'session.write', sessionId: 'session' },
    };
    const accepted: string[] = [];
    const sent: Parameters<NonNullable<ActionExecutorDeps['sessionSendMessage']>>[0][] = [];
    const executor = createScmResultActionExecutor(({ actionId, input, context, executeCanonicalAction }) =>
      executeScmActionOperation({ actionId, input, actionContext: context, executeCanonicalAction,
        workingDirectory: cwd, accessPolicy: { kind: 'restrictedRoots', roots: [cwd] } }), {
      executionRunGet: async () => ({ run }),
      sessionSendMessage: async request => {
        sent.push(request);
        accepted.push(request.sessionId);
        return { status: 'accepted', localId: request.localId };
      },
    });
    expect(await executor.execute('session.message.send', { sessionId: 'session', message: 'Direct RPC' }, context))
      .toMatchObject({ ok: false, errorCode: 'action_disabled' });
    expect(accepted).toEqual([]);
    const discussed = await executor.execute('scm.diffSummary.discuss', {
      cwd, resultId: saved.resultId, expectedRevision: 0, message: 'Explain the saved review',
    }, context);
    expect(discussed, JSON.stringify(discussed)).toMatchObject({ ok: true, result: {
      success: true, runId: run.runId, inputId: expect.any(String),
    } });
    expect(accepted).toEqual(['session']);
    expect(sent[0]?.context).toMatchObject({ ...context,
      actionRequestId: deriveWorkflowReplacementId(['action.child', context.actionRequestId,
        'scm.diffSummary.discuss', 'session.message.send', 0]),
    });
    expect(sent[0]?.actionCaller).toEqual(context.actionCaller);
  });
  it('preserves separately admitted Session continuation behind a Machine saved-result host', async () => {
    const saved = await scmDiffSummaryResultStore.create({ cwd, sessionId: 'session', output });
    const seen: string[] = [];
    const executor = createScmResultActionExecutor(({ actionId, input, context, executeCanonicalAction }) =>
      executeScmActionOperation({ actionId, input, actionContext: context, executeCanonicalAction,
        workingDirectory: cwd, accessPolicy: { kind: 'restrictedRoots', roots: [cwd] } }), {
      // These two leaves are the external Run and Session-input transports.
      // The actual Action executor, admission, persisted result and revision owner stay real.
      executionRunGet: async (sessionId, _request, options) => {
        expect(sessionId).toBe('session');
        expect(options?.targetMachineId).toBeUndefined();
        seen.push('session-run');
        return { run };
      },
      sessionSendMessage: async request => {
        expect(request.sessionId).toBe('session');
        seen.push('session-input');
        return { status: 'accepted', localId: request.localId };
      },
    });
    const discussed = await executor.execute('scm.diffSummary.discuss', { cwd, resultId: saved.resultId,
      expectedRevision: 0, message: 'Explain the admitted private result' }, {
      surface: 'rpc', authority: 'account_automation',
      externalActionTarget: { kind: 'machine', machineId: 'machine' },
      rpcSessionAuthorization: { kind: 'session.write', sessionId: 'session' },
    });
    expect(discussed, JSON.stringify(discussed)).toMatchObject({ ok: true, result: { success: true, runId: run.runId, inputId: expect.any(String) } });
    expect(seen).toEqual(['session-run', 'session-input']);
  });
  it('lists only permitted machine results and clears exactly confirmed revisions without erasing a newer edit', async () => {
    const saved = await scmDiffSummaryResultStore.create({ cwd, sessionId: 'saved-session', output });
    const excluded = await scmDiffSummaryResultStore.create({ cwd: '/private', output });
    const execute = (actionId: 'scm.diffSummary.result.list' | 'scm.diffSummary.result.clear', input: unknown) => executeScmActionOperation({
      actionId, input, workingDirectory: cwd, accessPolicy: { kind: 'restrictedRoots', roots: [cwd] },
    });
    const listed = await execute('scm.diffSummary.result.list', {});
    expect(listed).toMatchObject({ success: true, results: expect.arrayContaining([expect.objectContaining({
      cwd, sessionId: 'saved-session', resultId: saved.resultId, revision: 0, comparisonId: 'comparison',
    })]) });
    expect(JSON.stringify(listed)).not.toContain(excluded.resultId);
    await scmDiffSummaryResultStore.edit({ cwd, resultId: saved.resultId, expectedRevision: 0, edit: { kind: 'renameWalkthrough', title: 'New manual edit' } });
    expect(await execute('scm.diffSummary.result.clear', { results: [
      { cwd, sessionId: 'saved-session', resultId: saved.resultId, expectedRevision: 0, comparisonId: 'comparison' },
      { cwd: '/private', resultId: excluded.resultId, expectedRevision: 0, comparisonId: 'comparison' },
    ] })).toMatchObject({ success: true, deleted: [], failures: [
      { resultId: saved.resultId, errorCode: 'revision_conflict', latestRevision: 1 },
      { resultId: excluded.resultId, errorCode: 'result_unavailable' },
    ] });
    expect(await execute('scm.diffSummary.result.clear', { results: [{ cwd, sessionId: 'saved-session',
      resultId: saved.resultId, expectedRevision: 1, comparisonId: 'comparison' }] }))
      .toMatchObject({ success: true, deleted: [{ resultId: saved.resultId, comparisonId: 'comparison' }], failures: [{
        resultId: saved.resultId, comparisonId: 'comparison', errorCode: 'reviewed_marks_cleanup_failed', resultDeleted: true,
        retry: { actionId: 'scm.diffSummary.reviewed.unmark', input: { comparisonId: 'comparison', reset: true } },
      }] });
    expect(await scmDiffSummaryResultStore.read({ cwd: '/private', resultId: excluded.resultId })).toMatchObject({ success: true });
    const applying = await scmDiffSummaryResultStore.create({ cwd, output: ScmDiffSummaryGenerateOutputSchema.parse({ ...output,
      requestedOutputs: ['summary', 'walkthrough', 'commitPlan'], outputs: { ...output.outputs,
        commitPlan: { state: 'complete', value: { groups: [], leftOutChangeRefs: [] } } },
    }) });
    expect(await scmDiffSummaryResultStore.beginApplication({ cwd, resultId: applying.resultId, expectedRevision: 0,
      acceptance: { comparisonId: 'comparison', repositoryRootPath: cwd, expectedHeadOid: null,
        expectedRef: 'refs/heads/main', groups: [], leftOutChangeRefs: [] },
    })).toMatchObject({ success: true, result: { revision: 1 } });
    expect(await execute('scm.diffSummary.result.clear', { results: [{ cwd, resultId: applying.resultId,
      expectedRevision: 1, comparisonId: 'comparison' }] })).toMatchObject({ success: true, deleted: [],
        failures: [{ resultId: applying.resultId, errorCode: 'application_locked' }] });
    expect(await scmDiffSummaryResultStore.read({ cwd, resultId: applying.resultId })).toMatchObject({ success: true });
  });
  it('refuses historical comparison acceptance through the public Action without invoking a Git writer', async () => {
    const historical = ScmDiffSummaryGenerateOutputSchema.parse({ ...output,
      metadata: { source: { kind: 'commit', commit: 'a'.repeat(40) }, sourceKey: 'comparison' },
      comparison: { ...output.comparison, source: { kind: 'commit', commit: 'a'.repeat(40) } },
    });
    const saved = await scmDiffSummaryResultStore.create({ cwd, output: historical });
    const executor = createScmResultActionExecutor(({ actionId, input }) => executeScmActionOperation({
      actionId, input, workingDirectory: cwd,
      accessPolicy: { kind: 'restrictedRoots', roots: [cwd] },
    }));
    expect(await executor.execute('scm.diffSummary.commitPlan.accept', {
      cwd, resultId: saved.resultId, expectedRevision: 0,
      acceptance: { comparisonId: 'comparison', repositoryRootPath: cwd, expectedHeadOid: 'a'.repeat(40),
        expectedRef: 'refs/heads/main', groups: [], leftOutChangeRefs: [] },
    }, { surface: 'rpc', authority: 'account_automation' }))
      .toMatchObject({ ok: true, result: { success: false, errorCode: 'source_not_pending' } });
  });
  it.each(['discuss', 'refine', 'explain', 'seedExplain'] as const)('materializes selected current stop evidence and preserves the separate %s output contract', async (operation) => {
    const selected = ScmDiffSummaryGenerateOutputSchema.parse({ ...output, comparison: { ...output.comparison,
      inventory: { state: 'complete', reasons: [], files: [{ path: 'code.ts', changeKind: 'modified', binary: false, generated: false, lockfile: false,
        evidence: { state: 'available', unifiedDiff: '@@ -2 +2 @@\n-old\n+saved code\n' },
        occurrences: [{ id: 'HOST-OCCURRENCE-SELECTED', alias: 'c1', path: 'code.ts', before: { startLine: 2, lineCount: 1 },
          after: { startLine: 2, lineCount: 1 }, position: 0, evidence: { state: 'available' } }] }] } },
      outputs: { ...output.outputs, walkthrough: { state: 'complete', value: { title: 'Manual title', intro: '', otherChangeRefs: [],
        stops: [{ id: 'stop', title: 'Current stop title', explanationMarkdown: 'Current manual reasoning', changeRefs: ['HOST-OCCURRENCE-SELECTED'] }] } } },
      analysis: { suppliedChangeRefs: ['HOST-OCCURRENCE-SELECTED'], analysedChangeRefs: ['HOST-OCCURRENCE-SELECTED'], remainingChangeRefs: [] },
    });
    const created = await scmDiffSummaryResultStore.create({ cwd, sessionId: 'session', output: selected,
      generator: { backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' }, modelId: 'selected-model' } });
    let sent: { message: string; localId?: string } | undefined;
    // The Session transport alone is replaced. Targeted refine must pass the
    // real Action parser, participant admission and Session send dispatcher.
    const messageExecutor = createScmResultActionExecutor(async () => { throw new Error('Unexpected SCM recursion'); }, {
      sessionSendMessage: async request => {
        sent = request;
        return { status: 'accepted', localId: request.localId! };
      },
    });
    let seededInput: Record<string, unknown> | undefined;
    const executeCanonicalAction: Parameters<ScmActionExecute>[0]['executeCanonicalAction'] = async (id, input) => {
      if (id === 'execution.run.get') return operation === 'seedExplain' ? { ok: false, errorCode: 'execution_run_not_found', error: 'Unavailable' } : { ok: true, result: { run } };
      if (id === 'execution.run.start') {
        seededInput = (input as { intentInput: Record<string, unknown> }).intentInput;
        return { ok: true, result: { runId: 'seeded', callId: 'call', sidechainId: 'side', status: 'running' } };
      }
      if (id !== 'session.message.send') throw new Error('Discussion must target saved generator');
      return messageExecutor.execute(id, input, { surface: 'ui', bypassApprovals: true });
    };
    const targets = [{ stopId: 'stop', findingRefs: [{ runId: 'review-1', findingId: 'finding-1' }] }];
    expect(await executeScmActionOperation({ actionId: operation === 'discuss' ? 'scm.diffSummary.discuss' : 'scm.diffSummary.refine', input: {
      cwd, resultId: created.resultId, expectedRevision: 0, stopIds: ['stop'],
      ...(operation === 'discuss' ? { message: 'Explain this stop' } : { output: 'walkthrough', instructions: 'Explain finding',
        outputLanguage: 'fr',
        ...(operation !== 'refine' ? { reviewExplanation: { targets } } : {}) }),
    }, workingDirectory: cwd, executeCanonicalAction, actionContext: { surface: 'rpc', authority: 'present_user' } }))
      .toMatchObject({ success: true, runId: operation === 'seedExplain' ? 'seeded' : run.runId });
    if (operation === 'seedExplain') {
      expect(seededInput?.instructions).toBe('Explain finding');
      expect(seededInput?.reviewExplanation).toBeUndefined();
      expect(seededInput?.reviewExplanationInputId).toEqual(expect.any(String));
      const pending = await scmDiffSummaryResultStore.readInput({ cwd, resultId: created.resultId,
        inputIds: [String(seededInput?.reviewExplanationInputId)] });
      expect(pending?.reviewExplanation).toMatchObject({ targets, requestedBy: { kind: 'user' } });
      return;
    }
    expect(sent?.message).toContain('Current manual reasoning');
    expect(sent?.message).toContain('+saved code');
    expect(sent?.message).not.toContain('HOST-OCCURRENCE-SELECTED');
    expect(sent?.message).toContain('"changeRefs":["c1"]');
    if (operation === 'explain') {
      expect(sent?.message).toContain('"reviewExplanations"');
      if (!sent?.localId) throw new Error('Expected a retained explanation input');
      const pending = await scmDiffSummaryResultStore.readInput({ cwd, resultId: created.resultId, inputIds: [sent.localId] });
      expect(pending?.reviewExplanation).toMatchObject({ targets, requestedBy: { kind: 'user' }, requestedAtMs: expect.any(Number) });
      expect(await scmDiffSummaryResultStore.publish({ cwd, resultId: created.resultId, inputId: sent.localId,
        modelOutput: { reviewExplanations: [{ stopId: 'stop', markdown: 'Separate explanation' }] } }))
        .toMatchObject({ success: true, result: { output: { outputs: { walkthrough: { value: { stops: [{
          explanationMarkdown: 'Current manual reasoning', reviewExplanations: [{ markdown: 'Separate explanation' }],
        }] } } } } } });
    } else if (operation === 'discuss') {
      expect(sent?.message).toContain('code.ts');
      expect(sent?.message).toContain('"after":{"startLine":2,"lineCount":1}');
    } else if (operation === 'refine') {
      expect(sent?.message).toContain('Prose language: fr');
      if (!sent?.localId) throw new Error('Expected a retained refinement input');
      expect(await scmDiffSummaryResultStore.publish({ cwd, resultId: created.resultId, inputId: sent.localId,
        modelOutput: { walkthrough: { title: 'Parcours', intro: '', otherChangeRefs: [], stops: [{ id: 'stop',
          title: 'Préserver l’état', explanationMarkdown: 'Explication affinée', changeRefs: ['c1'] }] } } }))
        .toMatchObject({ success: true, result: { output: { outputs: { summary: output.outputs?.summary,
          walkthrough: { value: { stops: [{ title: 'Préserver l’état' }] } } } } } });
    }
  });
  it.each([false, true])('starts one labelled seeded generator preserving saved provider selection (original available=%s)', async (originalAvailable) => {
    const backendTarget = { kind: 'backend' as const, backendId: 'codex', sourceKind: 'built_in' as const };
    const modelSelection = ProviderBoundModelRefSchema.parse({ agentTargetKey: buildBackendTargetKeyV2(backendTarget), providerConnectionId: 'chosen-provider', modelId: 'chosen-model' });
    const generator = { backendTarget, modelId: 'chosen-model', modelSelection,
      investigateSurroundingFiles: true };
    const comparisonId = 'a'.repeat(64);
    const seededOutput = ScmDiffSummaryGenerateOutputSchema.parse({ ...output, sourceKey: comparisonId,
      metadata: { ...output.metadata, sourceKey: comparisonId }, comparison: { ...output.comparison, id: comparisonId } });
    const created = await scmDiffSummaryResultStore.create({ cwd, sessionId: 'session', output: seededOutput, generator });
    const starts: Array<{ localInputId?: string } & Record<string, unknown>> = [];
    let startParseIssues: unknown;
    const response = await executeScmActionOperation({ actionId: 'scm.diffSummary.discuss',
      input: { cwd, resultId: created.resultId, expectedRevision: 0, message: 'Why this change?', startNew: true }, workingDirectory: cwd,
      executeCanonicalAction: async (id, input) => {
        if (id === 'execution.run.get') return originalAvailable ? { ok: true, result: { run } } : { ok: false, errorCode: 'execution_run_not_found', error: 'Gone' };
        if (id !== 'execution.run.start') throw new Error('Fallback must admit one canonical generator');
        const parsed = ExecutionRunStartRequestSchema.safeParse(input);
        if (!parsed.success) { startParseIssues = parsed.error.issues; throw parsed.error; }
        starts.push(parsed.data);
        await scmDiffSummaryResultStore.bindRun({ cwd, resultId: created.resultId, expectedRevision: 0, runId: 'replacement', seededFromRunId: 'saved-generator' });
        return { ok: true, result: { runId: 'replacement', callId: 'call', sidechainId: 'sidechain' } };
      },
    });
    expect(response, JSON.stringify({ response, startParseIssues })).toMatchObject({ success: true, runId: 'replacement', inputId: expect.any(String),
      seededFromRunId: 'saved-generator', result: { revision: 1 } });
    expect(starts[0]?.localInputId).toBe((response as { inputId: string }).inputId);
    expect(starts).toEqual([expect.objectContaining({ kind: 'scm_diff_summary.v1', backendTarget: generator.backendTarget, modelId: 'chosen-model', modelSelection,
      intentInput: expect.objectContaining({ resultId: created.resultId, comparisonId, expectedRevision: 0, investigateSurroundingFiles: true }) })]);
  });
  it.each(['matching', 'differentModel', 'differentProvider', 'differentAgent', 'missingGenerator', 'missingGeneratorTeam', 'legacyGeneratorTeam'] as const)(
    'preserves legacy retained Connected Services only for the same saved route (%s)', async route => {
      const backendTarget = { kind: 'backend' as const, backendId: 'codex', sourceKind: 'built_in' as const };
      const modelSelection = ProviderBoundModelRefSchema.parse({ agentTargetKey: buildBackendTargetKeyV2(backendTarget),
        providerConnectionId: route === 'missingGenerator' ? 'original-provider' : null, modelId: 'chosen-model' });
      const connectedServices = { v: 2 as const, bindingsByServiceId: {
        'happier.agent.codex/openai-codex': { source: 'connected' as const, selection: 'profile' as const, profileId: 'original-profile' },
      } };
      const originalTarget = route === 'differentAgent' ? { kind: 'builtInAgent' as const, agentId: 'claude' } : run.backendTarget;
      const originalModel = route === 'differentModel' ? 'other-model' : 'chosen-model';
      const original = ExecutionRunGetResponseSchema.parse({ run: { ...run, backendTarget: originalTarget,
        resolvedSelection: { source: 'inherited', modelId: originalModel, connectedServices,
          ...(route === 'missingGeneratorTeam' || route === 'legacyGeneratorTeam' ? { teamCredentialModel: TeamCredentialProviderModelSelectionV1Schema.parse({
            kind: 'team_credential_provider_model', resourceId: 'resource', teamId: 'team', expectedResourceRevision: 2,
            agentTargetKey: modelSelection.agentTargetKey, modelId: originalModel, deliveryMode: 'brokered',
          }) } : { modelSelection: { agentTargetKey: buildBackendTargetKeyV2(readBackendTargetRefV2(originalTarget)), modelId: originalModel,
            providerConnectionId: route === 'differentProvider' ? 'other-provider' : modelSelection.providerConnectionId } }) },
      } }).run;
      const comparisonId = 'b'.repeat(64);
      const saved = await scmDiffSummaryResultStore.create({ cwd, sessionId: 'session',
        output: ScmDiffSummaryGenerateOutputSchema.parse({ ...output, sourceKey: comparisonId,
          metadata: { ...output.metadata, sourceKey: comparisonId }, comparison: { ...output.comparison, id: comparisonId } }),
        ...(route === 'missingGenerator' || route === 'missingGeneratorTeam' ? {} : { generator: { backendTarget, modelId: 'chosen-model',
          ...(route === 'legacyGeneratorTeam' ? {} : { modelSelection }) } }) });
      const starts: Record<string, unknown>[] = [];
      const response = await executeScmActionOperation({ actionId: 'scm.diffSummary.discuss',
        input: { cwd, resultId: saved.resultId, expectedRevision: 0, message: 'Explain this change', startNew: true }, workingDirectory: cwd,
        executeCanonicalAction: async (id, input) => {
          if (id === 'execution.run.get') return { ok: true, result: { run: original } };
          if (id !== 'execution.run.start') throw new Error('Expected canonical replacement admission');
          starts.push(ExecutionRunStartRequestSchema.parse(input));
          await scmDiffSummaryResultStore.bindRun({ cwd, resultId: saved.resultId, expectedRevision: 0, runId: 'replacement' });
          return { ok: true, result: { runId: 'replacement', callId: 'call', sidechainId: 'sidechain' } };
        },
      });
      if (route === 'missingGeneratorTeam' || route === 'legacyGeneratorTeam') {
        expect(response).toMatchObject({ success: false, errorCode: 'discussion_unavailable' });
        expect(starts).toEqual([]);
        return;
      }
      expect(response).toMatchObject({ success: true, runId: 'replacement' });
      expect(starts).toHaveLength(1);
      expect(starts[0]?.modelSelection).toEqual(modelSelection);
      expect(starts[0]?.connectedServices).toEqual(route === 'matching' || route === 'missingGenerator' ? connectedServices : undefined);
    });
  it.each([['connected', true], ['native', true], ['connected', false]] as const)(
    'keeps the saved %s credential choice over the original Run selection (available=%s)', async (choice, originalAvailable) => {
    const backendTarget = { kind: 'backend' as const, backendId: 'codex', sourceKind: 'built_in' as const };
    const modelSelection = ProviderBoundModelRefSchema.parse({ agentTargetKey: buildBackendTargetKeyV2(backendTarget),
      providerConnectionId: null, modelId: 'chosen-model' });
    const originalBindings = { v: 2 as const, bindingsByServiceId: {
      'happier.agent.codex/openai-codex': { source: 'connected' as const, selection: 'profile' as const, profileId: 'original-profile' },
    } };
    const savedBindings = choice === 'native' ? null : { ...originalBindings, bindingsByServiceId: {
      'happier.agent.codex/openai-codex': { ...originalBindings.bindingsByServiceId['happier.agent.codex/openai-codex'], profileId: 'saved-profile' },
    } };
    const comparisonId = 'c'.repeat(64);
    const saved = await scmDiffSummaryResultStore.create({ cwd, sessionId: 'session',
      output: ScmDiffSummaryGenerateOutputSchema.parse({ ...output, sourceKey: comparisonId,
        metadata: { ...output.metadata, sourceKey: comparisonId }, comparison: { ...output.comparison, id: comparisonId } }),
      generator: { backendTarget, modelId: 'chosen-model', modelSelection, connectedServices: savedBindings } });
    const starts: Record<string, unknown>[] = [];
    const response = await executeScmActionOperation({ actionId: 'scm.diffSummary.discuss',
      input: { cwd, resultId: saved.resultId, expectedRevision: 0, message: 'Explain this change', startNew: true }, workingDirectory: cwd,
      executeCanonicalAction: async (id, input) => {
        if (id === 'execution.run.get') return originalAvailable ? { ok: true, result: { run: { ...run,
          resolvedSelection: { source: 'inherited', modelId: 'chosen-model', modelSelection, connectedServices: originalBindings },
        } } } : { ok: false, errorCode: 'execution_run_not_found', error: 'Gone' };
        if (id !== 'execution.run.start') throw new Error('Expected canonical replacement admission');
        starts.push(ExecutionRunStartRequestSchema.parse(input));
        await scmDiffSummaryResultStore.bindRun({ cwd, resultId: saved.resultId, expectedRevision: 0, runId: 'replacement' });
        return { ok: true, result: { runId: 'replacement', callId: 'call', sidechainId: 'sidechain' } };
      },
    });
    expect(response).toMatchObject({ success: true, runId: 'replacement' });
    expect(starts).toHaveLength(1);
    expect(starts[0]?.connectedServices).toEqual(savedBindings);
  });
  it('reads and edits a retained result without a live generator and preserves strict revision failures', async () => {
    const created = await scmDiffSummaryResultStore.create({ cwd, sessionId: 'session', output });
    const base = { workingDirectory: cwd, accessPolicy: { kind: 'restrictedRoots' as const, roots: [cwd] } };
    const executor = createScmResultActionExecutor(({ actionId, input, executeCanonicalAction }) =>
      executeScmActionOperation({ ...base, actionId, input, executeCanonicalAction }));
    expect(await executor.execute('scm.diffSummary.result.read', { cwd, resultId: created.resultId }, { surface: 'rpc', authority: 'account_automation' }))
      .toMatchObject({ ok: true, result: { success: true, result: { revision: 0 } } });
    const input = { cwd, resultId: created.resultId, expectedRevision: 0, edit: { kind: 'renameWalkthrough', title: 'Manual title' } };
    expect(await executeScmActionOperation({ ...base, actionId: 'scm.diffSummary.result.edit', input }))
      .toMatchObject({ success: true, result: { revision: 1, output: { outputs: { summary: output.outputs?.summary } } } });
    const stale = await executeScmActionOperation({ ...base, actionId: 'scm.diffSummary.result.edit', input, rpcCompatibility: true });
    expect(stale).toEqual({ success: false, errorCode: 'revision_conflict', error: expect.any(String), latestRevision: 1 });
    expect(await executeScmActionOperation({ ...base, actionId: 'scm.diffSummary.result.read', input: { cwd: '/outside', resultId: created.resultId } }))
      .toMatchObject({ success: false, errorCode: 'result_unavailable' });
  });

  it('binds revision before sending a targeted retained input to the generator participant', async () => {
    ExecutionRunGetResponseSchema.parse({ run });
    const created = await scmDiffSummaryResultStore.create({ cwd, sessionId: 'session', output });
    const executeCanonicalAction: Parameters<ScmActionExecute>[0]['executeCanonicalAction'] = async (id, input) => {
      if (id === 'execution.run.get') return { ok: true, result: { run } };
      if (id !== 'session.message.send') throw new Error('Detached or replacement dispatch is incorrect');
      expect(input).toMatchObject({ sessionId: 'session', recipient: { kind: 'execution_run', runId: run.runId },
        localId: expect.any(String) });
      const message = input as { localId: string };
      await scmDiffSummaryResultStore.edit({ cwd, resultId: created.resultId, expectedRevision: 0,
        edit: { kind: 'renameWalkthrough', title: 'Other device title' } });
      expect(await scmDiffSummaryResultStore.publish({ cwd, resultId: created.resultId, inputId: message.localId,
        modelOutput: { walkthrough: { title: 'Stale', intro: '', stops: [], otherChangeRefs: [] } } }))
        .toMatchObject({ success: false, errorCode: 'revision_conflict', latestRevision: 1 });
      return { ok: true, result: { status: 'accepted', localId: message.localId } };
    };
    const response = await executeScmActionOperation({ actionId: 'scm.diffSummary.refine',
      input: { cwd, resultId: created.resultId, expectedRevision: 0, output: 'walkthrough', instructions: 'Clarify the rationale' },
      workingDirectory: cwd, executeCanonicalAction });
    expect(response).toEqual(expect.objectContaining({ success: true, runId: run.runId, inputId: expect.any(String) }));
  });
});
