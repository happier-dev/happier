import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExecutionRunScmDiffSummaryInputV1Schema, ExecutionRunStartRequestSchema } from '@happier-dev/protocol/execution/runs/startRequest';
import { createActionExecutor, ExecutionRunSendRequestSchema } from '@happier-dev/protocol';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { readExecutionRunProtocolV2Support } from '@happier-dev/protocol/execution/runs/protocolSupport';
import { ProviderBoundModelRefSchema } from '@happier-dev/protocol/providers/model-selection';
import { ScmDiffSummaryGenerateOutputSchema } from '@happier-dev/protocol/scm/diffSummary';
import * as diffSummaryProtocol from '@happier-dev/protocol/scm/diffSummary';
import { ScmComparisonSchema, type ScmComparisonSource } from '@happier-dev/protocol/scm/comparison';
import type { ExecutionRunProfilePrepareStartParams, ExecutionRunProfileStartParams } from '@/agent/executionRuns/profiles/ExecutionRunIntentProfile';
import { captureScmComparison, deleteCapturedScmComparison } from '@/scm/comparisons/captureScmComparison';
import { ScmDiffSummaryProfile } from './ScmDiffSummaryProfile';
import { scmDiffSummaryResultStore } from '@/agent/executionRuns/tasks/scmDiffSummary/results/resultStore';
import { buildDiffSummaryPrompt } from './buildDiffSummaryPrompt';
import { parseDiffSummaryModelOutput } from './parseDiffSummaryModelOutput';
import { advanceDiffSummaryAnalysis, planDiffSummaryAnalysis } from './advanceDiffSummaryAnalysis';
import { prepareSavedReviewWalkthroughInput } from '@/agent/executionRuns/profiles/review/reviewWalkthroughTurn';
import { withTempDir } from '@/testkit/fs/tempDir';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { clearActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshot, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { executeScmActionOperation } from '@/scm/actions/executeScmActionOperation';
import { ScmDiffSummaryResultResponseSchema } from '@happier-dev/protocol/scm/diffSummaryResult';
import type { ScmActionExecute } from '@happier-dev/protocol';
import { createCapabilitiesService } from '@/capabilities/service';
import { executionRunsCapability } from '@/capabilities/registry/toolExecutionRuns';
import { CHECKLIST_IDS } from '@/capabilities/checklistIds';
import { createEnvKeyScope } from '@/testkit/env/envScope';

// The loose request's extension index must not erase its named public fields.
expectTypeOf<ExecutionRunProfilePrepareStartParams['request']['instructions']>().toEqualTypeOf<string | undefined>();
expectTypeOf<ExecutionRunProfilePrepareStartParams['request']['externalPluginExtension']>().toEqualTypeOf<unknown>();

const comparison = ScmComparisonSchema.parse({
  id: 'comparison-1', source: { kind: 'workingTree' }, repository: { rootPath: '/repo' }, endpoints: {},
  inventory: { state: 'complete', reasons: [], files: [{ path: 'a.ts', changeKind: 'modified',
    binary: false, generated: false, lockfile: false,
    evidence: { state: 'available', unifiedDiff: '@@ -1 +1 @@\n-old\n+new\n' },
    occurrences: [{ id: 'change-1', alias: 'c1', path: 'a.ts', before: { startLine: 1, lineCount: 1 },
      after: { startLine: 1, lineCount: 1 }, position: 0 }],
  }] },
});
function start(intentInput: unknown, effectiveModelId?: string): ExecutionRunProfileStartParams {
  return { sessionId: 'sess-1', runId: 'run-1', callId: 'call-1', sidechainId: 'sidechain-1',
    intent: 'scm_diff_summary', backendId: 'claude', backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
    instructions: 'prompt', intentInput, permissionMode: 'read_only', retentionPolicy: 'resumable',
    runClass: 'long_lived', ioMode: 'streaming', startedAtMs: 1,
    ...(effectiveModelId ? { effectiveEngine: { agentId: 'claude', modelId: effectiveModelId } } : {}) };
}
function input(outputs: string[] = ['summary']) {
  return { source: comparison.source, sourceKey: comparison.id, comparison, outputs,
    metadata: { source: comparison.source, sourceKey: comparison.id } };
}
async function admitInitial(params: ExecutionRunProfileStartParams) {
  const initial = await ScmDiffSummaryProfile.onStarted?.({ start: params, rawText: '', finishedAtMs: params.startedAtMs });
  const saved = ScmDiffSummaryGenerateOutputSchema.parse(initial?.toolResultOutput);
  return { start: { ...params, intentInput: { ...(params.intentInput as Record<string, unknown>), resultId: saved.resultId } },
    previousStructuredMeta: initial?.structuredMeta };
}
async function prepareAnalysis(params: ExecutionRunProfilePrepareStartParams): Promise<Readonly<Record<string, unknown>>> {
  const early = await ScmDiffSummaryProfile.prepareStartParams!(params);
  const finalized = await ScmDiffSummaryProfile.finalizeStartParams?.({ ...params,
    request: { ...params.request, ...early } });
  return { ...early, ...finalized };
}

describe('initial generation context', () => {
  it('parses one model response once through saved publication and its completed envelope', async () => {
    const admitted = await admitInitial(start(input(['walkthrough'])));
    const rawText = JSON.stringify({ walkthrough: { title: 'Parsed once', intro: '', stops: [], otherChangeRefs: ['c1'] } });
    // Call through the JSON boundary: the profile, parser and saved owner all remain real.
    const parser = vi.spyOn(JSON, 'parse');
    try {
      const completed = await ScmDiffSummaryProfile.onTurnComplete!({ ...admitted,
        turnId: 'parse-once', finishedAtMs: 2, rawText });
      expect(completed?.toolResultOutput).toMatchObject({ success: true,
        outputs: { walkthrough: { state: 'complete', value: { title: 'Parsed once', otherChangeRefs: ['change-1'] } } } });
      expect(parser.mock.calls.filter(([text]) => text === rawText)).toHaveLength(1);
    } finally { parser.mockRestore(); }
  });

  it('reads a retained preparation body once and still refuses publication after an intervening edit', async () => {
    await withTempDir('happier-scm-prepare-read-', async cwd => {
    execFileSync('git', ['init', '-q'], { cwd });
    writeFileSync(join(cwd, 'a.ts'), 'const changed = true;\n');
    const captured = await captureScmComparison({ cwd, source: { kind: 'workingTree' }, sessionId: 'sess-1' });
    const ref = captured.comparison.inventory.files[0]!.occurrences[0]!.id;
    const saved = await scmDiffSummaryResultStore.create({ cwd, sessionId: 'sess-1',
      output: ScmDiffSummaryGenerateOutputSchema.parse({ success: true, sourceKey: captured.comparison.id,
        comparison: captured.comparison, metadata: captured.metadata,
        analysis: { suppliedChangeRefs: [ref], analysedChangeRefs: [ref], remainingChangeRefs: [] },
        requestedOutputs: ['walkthrough'], outputs: { walkthrough: { state: 'complete', value: {
          title: 'Original', intro: 'Intro', stops: [{ id: 's1', title: 'Stop', explanationMarkdown: 'Before',
            changeRefs: [ref] }], otherChangeRefs: [],
        } } } }) });
    const parse = JSON.parse;
    let bodies = 0;
    const spy = vi.spyOn(JSON, 'parse').mockImplementation((text, reviver) => {
      if (typeof text === 'string' && text.startsWith('{"result":') && text.includes(saved.resultId)) bodies++;
      return parse(text, reviver);
    });
    try {
      await ScmDiffSummaryProfile.prepareStartParams!({ cwd, sessionId: 'sess-1', request: {
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, modelId: 'test-model', instructions: '', intent: 'scm_diff_summary',
        permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'streaming',
        intentInput: { cwd, source: captured.comparison.source, comparisonId: captured.comparison.id,
          outputs: ['walkthrough'], resultId: saved.resultId, expectedRevision: 0 },
      } });
    } finally { spy.mockRestore(); }
    expect(bodies).toBe(1);
    const scope = { cwd, sessionId: 'sess-1', resultId: saved.resultId };
    await scmDiffSummaryResultStore.beginInput({ ...scope, inputId: 'refine-once', expectedRevision: 0, outputs: ['walkthrough'] });
    await scmDiffSummaryResultStore.edit({ ...scope, expectedRevision: 0, edit: { kind: 'renameWalkthrough', title: 'My title' } });
    expect(await scmDiffSummaryResultStore.publish({ ...scope, inputId: 'refine-once', modelOutput: { walkthrough: {
      title: 'Stale', intro: 'Intro', stops: [{ id: 's1', title: 'Stop', explanationMarkdown: 'After', changeRefs: ['c1'] }], otherChangeRefs: [],
    } } })).toMatchObject({ success: false, errorCode: 'revision_conflict', latestRevision: 1 });
    });
  });

  it('withholds incomplete structured output from the first streamed character while retaining prose discussion', () => {
    const project = (fullText: string) => ScmDiffSummaryProfile.computeSidechainStreamText!({ fullText });
    for (const text of ['{', '{\n  "', '{\n  "walkthrough"', '`', '``', '```j', '```json\n', '```json\n{', '{"walkthrough":{"title":"Saved"}}']) {
      expect(project(text)).toBe('');
    }
    expect(project('The before side retains the deleted code.')).toBe('The before side retains the deleted code.');
    expect(project('The config uses {"allow":true} exactly.')).toBe('The config uses {"allow":true} exactly.');
    expect(project('I updated the explanation: {"walkthrough":')).toBe('I updated the explanation:');
    expect(project('```typescript\nconst retained = true;\n```')).toBe('```typescript\nconst retained = true;\n```');
    expect(project('I updated the explanation.\n{"walkthrough":')).toBe('I updated the explanation.');
  });
  it('keeps seeded stop discussion prose-only and preserves the edited story even when the model returns JSON', async () => {
    await withTempDir('happier-scm-seeded-discussion-', async cwd => {
      execFileSync('git', ['init', '-q'], { cwd });
      writeFileSync(join(cwd, 'a.ts'), 'const allowed = true;\n');
      const captured = await captureScmComparison({ cwd, source: { kind: 'workingTree' } });
      const refs = captured.comparison.inventory.files.flatMap(file => file.occurrences.map(change => change.id));
      const saved = await scmDiffSummaryResultStore.create({ cwd, output: ScmDiffSummaryGenerateOutputSchema.parse({
        success: true, sourceKey: captured.comparison.id, comparison: captured.comparison, metadata: captured.metadata,
        analysis: { suppliedChangeRefs: refs, analysedChangeRefs: refs, remainingChangeRefs: [] },
        requestedOutputs: ['summary', 'walkthrough'], outputs: {
          summary: { state: 'partial', value: { summaryMarkdown: 'Saved summary' }, reason: 'Earlier analysis was incomplete' },
          walkthrough: { state: 'complete', value: { title: 'Generated title', intro: 'Saved intro', otherChangeRefs: [],
            stops: [{ id: 'authorization', title: 'Permission', explanationMarkdown: 'Saved explanation', changeRefs: refs },
              { id: 'editorial', title: 'Editorial context', explanationMarkdown: 'Retain this stop', changeRefs: [] }] } },
        }, runId: 'retired-generator',
      }), generator: { backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' }, modelId: 'test-model' } });
      const scope = { cwd, resultId: saved.resultId };
      const edited = await scmDiffSummaryResultStore.edit({ ...scope, expectedRevision: 0,
        edit: { kind: 'renameWalkthrough', title: 'My saved title' } });
      if (!edited.success) throw new Error(edited.error);
      let prompt = '';
      let initialSummary: string | undefined;
      let beforeTurn: unknown;
      let completion: unknown;
      const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(),
        scmActionExecute: ({ actionId, input, context, executeCanonicalAction }) => executeScmActionOperation({
          actionId, input, actionContext: context, executeCanonicalAction, workingDirectory: cwd,
        }),
        // Only the remote Run transport/model is replaced. Both Actions pass
        // through the production executor and their actual strict schemas.
        executionRunCheckProtocolV2: async (_sessionId, requirement, options) => {
          const env = createEnvKeyScope(['HAPPIER_FEATURE_EXECUTION_RUNS__ENABLED']);
          env.patch({ HAPPIER_FEATURE_EXECUTION_RUNS__ENABLED: '1' });
          try {
            // Use the real producer's describe facts, without native discovery.
            const capabilities = createCapabilitiesService({ capabilities: [executionRunsCapability],
              checklists: { [CHECKLIST_IDS.NEW_SESSION]: [], [CHECKLIST_IDS.MACHINE_DETAILS]: [] },
              buildContext: async () => { throw new Error('Protocol description must not discover native agents'); } });
            return readExecutionRunProtocolV2Support({ supported: true, response: capabilities.describe() }, requirement, options?.signal);
          } finally { env.restore(); }
        },
        executionRunGet: async () => { throw new Error('Retired Run transport is unavailable'); },
        executionRunStart: async (_sessionId, value) => {
          const request = ExecutionRunStartRequestSchema.parse(value);
          const prepared = await ScmDiffSummaryProfile.prepareStartParams!({ cwd, sessionId: null, request });
          const admitted = ExecutionRunStartRequestSchema.parse({ ...request, ...prepared });
          prompt = admitted.instructions ?? '';
          const current = { ...start(admitted.intentInput), sessionId: null, runId: 'seeded-discussion', instructions: prompt };
          const initial = await ScmDiffSummaryProfile.onStarted!({ start: current, rawText: '', finishedAtMs: 2 });
          // Binding the saved result prepares context; only a changed saved revision emits a receipt.
          initialSummary = initial?.summary;
          if (!request.localInputId) throw new Error('Seeded discussion must carry its admitted input identity');
          await ScmDiffSummaryProfile.onBeforeRetainedInput!({ start: current, localId: request.localInputId });
          beforeTurn = await scmDiffSummaryResultStore.read(scope);
          completion = await ScmDiffSummaryProfile.onTurnComplete!({ start: current, previousStructuredMeta: initial?.structuredMeta,
            turnId: 'native-answer', inputIds: [request.localInputId], finishedAtMs: 3, rawText: JSON.stringify({ walkthrough: { title: 'Unrequested replacement',
              intro: '', stops: [{ id: 'authorization', title: 'Replacement', explanationMarkdown: 'Replace', changeRefs: ['c1'] }], otherChangeRefs: [] } }) });
          expect(await ScmDiffSummaryProfile.onTerminal!({ start: current, status: 'failed', finishedAtMs: 4,
            structuredMeta: initial?.structuredMeta })).toBeNull();
          return { runId: current.runId, callId: current.callId, sidechainId: current.sidechainId };
        } });
      const response = await executor.execute('scm.diffSummary.discuss', { ...scope, expectedRevision: edited.result.revision,
        stopIds: ['authorization'], message: 'Why is this allowed?', startNew: true },
      { surface: 'cli', bypassApprovals: true, executionRunTargetMachineId: 'machine' });
      expect(response, JSON.stringify(response)).toMatchObject({ ok: true, result: { success: true, runId: 'seeded-discussion', seededFromRunId: 'retired-generator' } });
      expect(initialSummary ?? '').toBe('');
      expect(await scmDiffSummaryResultStore.read(scope)).toEqual(beforeTurn);
      expect(completion).toBeNull();
      expect(prompt).toContain('Answer the user in prose');
      expect(prompt).not.toContain('MUST return ONLY valid JSON');
      expect(prompt).not.toContain('Publish only the requested structured outputs');
      expect(prompt).toContain('Saved explanation');
      expect(prompt).toContain('Why is this allowed?');
    });
  });
  it('does not turn fresh pending generation into discussion of an empty saved result', async () => {
    const admitted = await admitInitial(start(input(['walkthrough', 'commitPlan'])));
    expect(ScmDiffSummaryProfile.buildInitialInputContext?.({
      start: admitted.start, structuredMeta: admitted.previousStructuredMeta,
    })).toBe('');
  });
});

async function exerciseSavedContinuation(operation: 'refine' | 'addOutputs' | 'replacement' | 'explicitChoice',
  assertContinuation: (observed: { prompt: string; admittedInstructions?: unknown; savedLanguage?: unknown; replacementLanguage?: unknown;
    savedConnectedServices?: unknown; replacementConnectedServices?: unknown }) => void,
  connectedRouteAtStartOnly = false) {
  const previous = getActiveAccountSettingsSnapshot();
  setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({ 'scm.diffSummary.outputLanguage': 'de' }),
    settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: 'saved-language-account' });
  try {
    await withTempDir('happier-scm-continuation-', async cwd => {
      execFileSync('git', ['init', '-q'], { cwd });
      const captured = await captureScmComparison({ cwd, source: { kind: 'workingTree' } });
      const connectedServices = { v: 2 as const, bindingsByServiceId: { 'happier.agent.claude/claude-subscription': {
          source: 'connected' as const, selection: 'profile' as const, profileId: 'saved-subscription',
        } } };
      const request = { kind: 'scm_diff_summary.v1' as const, backendTarget: { kind: 'builtInAgent' as const, agentId: 'claude' }, intent: 'scm_diff_summary' as const,
        ...(!connectedRouteAtStartOnly ? { connectedServices } : {}),
        permissionMode: 'read_only', retentionPolicy: 'resumable' as const, runClass: 'long_lived' as const, ioMode: 'streaming' as const,
        intentInput: { cwd, source: captured.comparison.source, comparisonId: captured.comparison.id, outputs: ['summary'], outputLanguage: 'fr' } };
      const initial = await ScmDiffSummaryProfile.prepareStartParams!({ cwd, sessionId: null, request });
      const preparedInitial = ExecutionRunStartRequestSchema.parse({ ...request, ...initial });
      const params = { ...start(preparedInitial.intentInput), sessionId: null, instructions: preparedInitial.instructions ?? '', connectedServices };
      const begun = await ScmDiffSummaryProfile.onStarted!({ start: params, rawText: '', finishedAtMs: 1 });
      const generated = await ScmDiffSummaryProfile.onTurnComplete!({ start: params, rawText: JSON.stringify({ summaryMarkdown: 'UNTRUSTED_PRIOR_OUTPUT_DIRECTIVE' }),
        turnId: 'initial-turn', inputIds: ['execution-run-initial:run-1'], previousStructuredMeta: begun?.structuredMeta, finishedAtMs: 2 });
      const produced = ScmDiffSummaryGenerateOutputSchema.parse(generated?.toolResultOutput);
      const savedResponse = ScmDiffSummaryResultResponseSchema.parse(await scmDiffSummaryResultStore.read({ cwd, resultId: produced.resultId! }));
      if (!savedResponse.success) throw new Error(savedResponse.error);
      const saved = savedResponse.result;
      let prompt = '';
      let admittedInstructions: unknown;
      let replacementLanguage: unknown;
      let replacementConnectedServices: unknown;
      // Only Run transport is substituted; profile admission, capture, persistence, Action routing and strict readers are real.
      const executeCanonicalAction: Parameters<ScmActionExecute>[0]['executeCanonicalAction'] = async (id, input) => {
        if (id === 'execution.run.get') return operation === 'replacement' || operation === 'explicitChoice'
          ? { ok: false, errorCode: 'execution_run_not_found', error: 'Gone' }
          : { ok: true, result: { run: { runId: 'run-1', callId: 'call', sidechainId: 'sidechain', intent: 'scm_diff_summary',
            backendTarget: request.backendTarget, permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'streaming',
            status: 'running', startedAtMs: 1, lifecycle: { v: 1, state: 'current' }, interaction: { kind: 'retained_agent_session.v1',
              capabilities: { open: ['create', 'resume'], delivery: ['newTurn'], cancel: true } } } } };
        if (id === 'execution.run.send') {
          const sent = ExecutionRunSendRequestSchema.parse(input);
          prompt = sent.message;
          return { ok: true, result: { ok: true } };
        }
        if (id === 'execution.run.start') {
          const admitted = ExecutionRunStartRequestSchema.parse(input);
          admittedInstructions = (admitted.intentInput as { instructions?: unknown }).instructions;
          replacementLanguage = (admitted.intentInput as { outputLanguage?: unknown }).outputLanguage;
          replacementConnectedServices = admitted.connectedServices;
          const prepared = await ScmDiffSummaryProfile.prepareStartParams!({ cwd, sessionId: null, request: admitted });
          prompt = ExecutionRunStartRequestSchema.parse({ ...admitted, ...prepared }).instructions ?? '';
          return { ok: true, result: { runId: 'replacement', callId: 'call', sidechainId: 'sidechain', status: 'running' } };
        }
        throw new Error(`Unexpected transport ${id}`);
      };
      const result = await executeScmActionOperation({ actionId: operation === 'addOutputs' ? 'scm.diffSummary.addOutputs' : 'scm.diffSummary.refine',
        input: { cwd, resultId: saved.resultId, expectedRevision: saved.revision,
          ...(operation === 'addOutputs' ? { outputs: ['walkthrough'] } : { output: 'summary', instructions: 'Explain the causal reason' }),
          ...(operation === 'explicitChoice' ? { outputLanguage: 'it' } : {}) },
        workingDirectory: cwd, accessPolicy: { kind: 'restrictedRoots', roots: [cwd] }, executeCanonicalAction,
        actionContext: { surface: 'rpc', authority: 'present_user', externalActionTarget: { kind: 'machine', machineId: 'machine' } } });
      expect(result, JSON.stringify(result)).toMatchObject({ success: true });
      assertContinuation({ prompt, admittedInstructions, replacementLanguage, savedLanguage: saved.generator?.outputLanguage,
        savedConnectedServices: saved.generator?.connectedServices, replacementConnectedServices });
    });
  } finally {
    if (previous) setActiveAccountSettingsSnapshot(previous); else clearActiveAccountSettingsSnapshot();
  }
}

const fence = '`'.repeat(3);

describe('ScmDiffSummaryProfile', () => {

  it.each([false, true])('persists the generator Connected Services and reuses them when refinement replaces a lost Run (resolved at start=%s)', async connectedRouteAtStartOnly => {
    await exerciseSavedContinuation('replacement', ({ savedConnectedServices, replacementConnectedServices }) => {
      const expected = { v: 2, bindingsByServiceId: { 'happier.agent.claude/claude-subscription': {
        source: 'connected', selection: 'profile', profileId: 'saved-subscription',
      } } };
      expect(savedConnectedServices).toEqual(expected);
      expect(replacementConnectedServices).toEqual(expected);
    }, connectedRouteAtStartOnly);
  });

  it.each(['refine', 'addOutputs', 'replacement'] as const)('keeps saved evidence separate from user instructions through the real %s continuation', async operation => {
    await exerciseSavedContinuation(operation, ({ prompt, admittedInstructions }) => {
      const [evidence, user] = prompt.split('User instructions:\n');
      expect(evidence).toContain('UNTRUSTED_PRIOR_OUTPUT_DIRECTIVE');
      expect(user ?? '').not.toContain('UNTRUSTED_PRIOR_OUTPUT_DIRECTIVE');
      expect(user ?? '').not.toContain('Publish only');
      if (operation !== 'addOutputs') expect(user?.trim()).toBe('Explain the causal reason');
      if (operation === 'replacement') expect(admittedInstructions).toBe('Explain the causal reason');
    });
  });

  it.each(['refine', 'addOutputs', 'replacement', 'explicitChoice'] as const)('retains admitted French over the German Account preference for %s', async operation => {
    await exerciseSavedContinuation(operation, ({ prompt, savedLanguage, replacementLanguage }) => {
      expect(savedLanguage).toBe('fr');
      expect(prompt).toContain(`Prose language: ${operation === 'explicitChoice' ? 'it' : 'fr'}`);
      if (operation === 'replacement' || operation === 'explicitChoice') expect(replacementLanguage).toBe(operation === 'explicitChoice' ? 'it' : 'fr');
    });
  });

  it('uses the shared Account prose preference for direct Run preparation without overriding explicit language', async () => {
    const previous = getActiveAccountSettingsSnapshot();
    setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({
      'scm.diffSummary.outputLanguage': 'fr', preferredLanguage: 'nl',
    }), settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: 'language-account' });
    try {
      await withTempDir('happier-scm-language-', async cwd => {
        execFileSync('git', ['init', '-q'], { cwd });
        const captured = await captureScmComparison({ cwd, source: { kind: 'workingTree' } });
        const request = { backendTarget: { kind: 'builtInAgent' as const, agentId: 'claude' }, intent: 'scm_diff_summary' as const,
          instructions: 'Explain', permissionMode: 'read_only', retentionPolicy: 'resumable' as const,
          runClass: 'long_lived' as const, ioMode: 'streaming' as const,
          intentInput: { cwd, source: { kind: 'workingTree' as const }, comparisonId: captured.comparison.id, outputs: ['summary'] } };
        const preferred = await ScmDiffSummaryProfile.prepareStartParams!({ cwd, sessionId: null, request });
        expect(ExecutionRunScmDiffSummaryInputV1Schema.parse(preferred!.intentInput).outputLanguage).toBe('fr');
        expect(preferred?.instructions).toContain('fr');
        const explicit = await ScmDiffSummaryProfile.prepareStartParams!({ cwd, sessionId: null, request: {
          ...request, intentInput: { ...request.intentInput, outputLanguage: 'it' },
        } });
        expect(ExecutionRunScmDiffSummaryInputV1Schema.parse(explicit!.intentInput).outputLanguage).toBe('it');
      });
    } finally {
      if (previous) setActiveAccountSettingsSnapshot(previous); else clearActiveAccountSettingsSnapshot();
    }
  });

  it('prepares surrounding files from both captured endpoints, independently of later live changes', async () => {
    await withTempDir('happier-scm-investigation-', async cwd => {
      execFileSync('git', ['init', '-q'], { cwd });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd });
      writeFileSync(join(cwd, 'surrounding.txt'), 'Before context\n');
      writeFileSync(join(cwd, 'binary.dat'), Buffer.from([0, 255, 13, 10, 128]));
      writeFileSync(join(cwd, '.gitattributes'), 'surrounding.txt export-ignore\nsurrounding.txt filter=fixture\n');
      execFileSync('git', ['config', 'filter.fixture.smudge', 'printf transformed'], { cwd });
      symlinkSync('surrounding.txt', join(cwd, 'link.txt'));
      execFileSync('git', ['add', '.'], { cwd });
      execFileSync('git', ['commit', '-qm', 'initial'], { cwd });
      writeFileSync(join(cwd, 'surrounding.txt'), 'Captured context\n');
      const captured = await captureScmComparison({ cwd, source: { kind: 'workingTree' } });
      const scope = { cwd, comparisonId: captured.comparison.id };
      const request = { backendTarget: { kind: 'builtInAgent' as const, agentId: 'claude' }, intent: 'scm_diff_summary' as const,
        instructions: 'Explain', permissionMode: 'yolo', retentionPolicy: 'resumable' as const,
        runClass: 'long_lived' as const, ioMode: 'streaming' as const,
        intentInput: { cwd, source: { kind: 'workingTree' as const }, comparisonId: captured.comparison.id,
          investigateSurroundingFiles: true, outputs: ['summary'] } };
      writeFileSync(join(cwd, 'surrounding.txt'), 'Later live context\n');
      const prepared = await ScmDiffSummaryProfile.prepareStartParams!({ cwd, sessionId: null, request });
      try {
        expect(prepared?.cwd).toEqual(expect.any(String));
        const after = String(prepared!.cwd);
        expect(after).not.toBe(cwd);
        expect(readFileSync(join(after, 'surrounding.txt'), 'utf8')).toBe('Captured context\n');
        expect(readFileSync(join(after, '..', 'before', 'surrounding.txt'), 'utf8')).toBe('Before context\n');
        expect(readFileSync(join(after, 'link.txt'), 'utf8')).toBe('Captured context\n');
        expect(readFileSync(join(after, 'binary.dat'))).toEqual(Buffer.from([0, 255, 13, 10, 128]));
        expect(prepared?.permissionMode).toBe('read_only');
        expect(prepared?.workspaceWrites).toBe('deny');
        expect(ExecutionRunScmDiffSummaryInputV1Schema.parse(prepared!.intentInput).comparison).toEqual(captured.comparison);
        const disabled = await ScmDiffSummaryProfile.prepareStartParams!({ cwd, sessionId: null, request: { ...request,
          intentInput: { ...request.intentInput, investigateSurroundingFiles: false } } });
        expect(disabled?.permissionMode).toBe('no_tools');
        const savedInput = ExecutionRunScmDiffSummaryInputV1Schema.parse(prepared!.intentInput);
        const savedScope = { cwd, resultId: savedInput.resultId! };
        expect(await scmDiffSummaryResultStore.prepareInvestigation(savedScope)).toEqual({
          beforeDirectory: join(after, '..', 'before'), afterDirectory: after,
        });
        expect(await scmDiffSummaryResultStore.delete({ ...savedScope, expectedRevision: 0 })).toMatchObject({ success: true });
        expect(existsSync(after)).toBe(false);
      } finally { await deleteCapturedScmComparison(scope); }
    });
  });

  it('rejects a private retained result from a detached preparation even when its comparison has a workspace copy', async () => {
    await withTempDir('happier-scm-private-preparation-', async directory => {
    execFileSync('git', ['init', '-q'], { cwd: directory });
    const captured = await captureScmComparison({ cwd: directory, source: { kind: 'workingTree' } });
    const saved = await scmDiffSummaryResultStore.create({ cwd: directory, sessionId: 'private-session',
      output: ScmDiffSummaryGenerateOutputSchema.parse({ success: true, sourceKey: captured.comparison.id,
        metadata: captured.metadata, comparison: captured.comparison, requestedOutputs: ['summary'],
        outputs: { summary: { state: 'pending' } }, analysis: { suppliedChangeRefs: [], analysedChangeRefs: [], remainingChangeRefs: [] } }) });
    const request = { backendTarget: { kind: 'builtInAgent' as const, agentId: 'claude' }, intent: 'scm_diff_summary' as const,
      instructions: 'Explain', permissionMode: 'read_only', retentionPolicy: 'resumable' as const,
      runClass: 'long_lived' as const, ioMode: 'streaming' as const,
      intentInput: { cwd: directory, source: { kind: 'workingTree' as const }, comparisonId: captured.comparison.id,
        resultId: saved.resultId, expectedRevision: 0, outputs: ['summary'] } };
    await expect(ScmDiffSummaryProfile.prepareStartParams!({ cwd: directory, sessionId: null, request }))
      .rejects.toMatchObject({ code: 'DIFF_UNAVAILABLE' });
    await expect(scmDiffSummaryResultStore.read({ cwd: directory, resultId: saved.resultId }))
      .resolves.toMatchObject({ success: true, result: { revision: 0 } });
    });
  });

  it.each(['missing hosted objects', 'escaping symlink'])('refuses surrounding-file investigation for %s without using live files', async reason => {
    await withTempDir('happier-scm-unavailable-investigation-', async cwd => {
      execFileSync('git', ['init', '-q'], { cwd });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd });
      writeFileSync(join(cwd, 'context.txt'), 'Live context must not substitute for endpoints\n');
      if (reason === 'escaping symlink') symlinkSync('../outside.txt', join(cwd, 'escape.txt'));
      execFileSync('git', ['add', '.'], { cwd });
      execFileSync('git', ['commit', '-qm', 'initial'], { cwd });
      const source: ScmComparisonSource = reason === 'missing hosted objects' ? { kind: 'pullRequest', locator: {
        providerId: 'github', repository: 'owner/repository', number: 1,
        sourceAction: { action: { pluginId: 'test.hosting', localId: 'changed-files' }, input: {} },
      } } : { kind: 'workingTree' };
      // The hosting page is an external source boundary. Its endpoint identities
      // are intentionally absent from this local repository.
      const captured = await captureScmComparison({ cwd, source,
        ...(reason === 'missing hosted objects' ? { readPullRequestComparisonPage: async () => ({
          kind: 'changedFiles', rows: [], omittedRowCount: 0, projectionTruncated: false,
          comparison: { beforeOid: 'a'.repeat(40), baseOid: 'a'.repeat(40), headOid: 'b'.repeat(40),
            locator: { providerId: 'github', repository: 'owner/repository', number: 1 },
            totalFileCount: 0, enumeratedFileCount: 0, freshness: 'current', inventory: 'complete', content: 'complete', reasons: [] },
        }) } : {}) });
      try {
        expect(captured.comparison.inventory.state).toBe('complete');
        await expect(ScmDiffSummaryProfile.prepareStartParams!({ cwd, sessionId: null, request: {
          backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, intent: 'scm_diff_summary',
          instructions: 'Explain', permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'streaming',
          intentInput: { cwd, source, comparisonId: captured.comparison.id, investigateSurroundingFiles: true, outputs: ['summary'] },
        } })).rejects.toMatchObject({ code: 'DIFF_UNAVAILABLE' });
        expect(readFileSync(join(cwd, 'context.txt'), 'utf8')).toBe('Live context must not substitute for endpoints\n');
      } finally { await deleteCapturedScmComparison({ cwd, comparisonId: captured.comparison.id }); }
    });
  });

  it('counts Unicode scalars and retains usable parts when integration exceeds the reported input capacity', () => {
    const metadata = input().metadata;
    const prompt = '😀'.repeat(4000);
    expect(planDiffSummaryAnalysis({ comparison, metadata, outputs: ['summary'], prompt,
      maxInputUnicodeCharacters: 4000 })).toBeNull();
    expect(() => planDiffSummaryAnalysis({ comparison, metadata, outputs: ['summary'], prompt: 'Explain',
      maxInputUnicodeCharacters: 0 })).toThrow(/capacity/);
    const maxInputUnicodeCharacters = [...buildDiffSummaryPrompt({ comparison, metadata, outputs: ['summary'], files: [] })].length;
    const summaryMarkdown = 'x'.repeat(maxInputUnicodeCharacters + 1);
    const result = advanceDiffSummaryAnalysis({ start: start({ ...input(), scmMaxInputUnicodeCharacters: maxInputUnicodeCharacters,
      scmAnalysis: { phase: 'evidence', current: ['change-1'], pending: [], parts: [], supplied: [], analysed: [], failures: [], failedRefs: [] } }),
      turnId: 'part', rawText: JSON.stringify({ summaryMarkdown }), finishedAtMs: 2 });
    expect(result?.nextInput).toBeUndefined();
    expect(result?.toolResultOutput).toMatchObject({ comparison, outputs: { summary: { state: 'partial',
      value: { summaryMarkdown }, reason: expect.stringContaining('capacity') } } });
    expect(result?.toolResultOutput).toMatchObject({ outputs: { summary: { reasonCode: 'provider_input_too_large' } } });
    const modelWindowResult = advanceDiffSummaryAnalysis({ start: start({ ...input(), scmContextWindowTokens: maxInputUnicodeCharacters,
      scmAnalysis: { phase: 'evidence', current: ['change-1'], pending: [], parts: [], supplied: [], analysed: [], failures: [], failedRefs: [] } }),
      turnId: 'part', rawText: JSON.stringify({ summaryMarkdown }), finishedAtMs: 2 });
    expect(modelWindowResult?.nextInput).toBeUndefined();
    expect(modelWindowResult?.toolResultOutput).toMatchObject({ outputs: { summary: {
      state: 'partial', reasonCode: 'agent_context_window_exceeded',
    } } });
  });

  it('does not demand native budget without prepared generation work', async () => {
    let budgetDemands = 0;
    expect(await ScmDiffSummaryProfile.finalizeStartParams?.({ cwd: '/repo', request: start(input()),
      resolveMaxInputUnicodeCharacters: async () => { budgetDemands++; return 1; } })).toBeUndefined();
    expect(budgetDemands).toBe(0);
  });

  it('partitions 215 files by the runtime Unicode input capacity and integrates on the same run', async () => {
    await withTempDir('happier-scm-runtime-capacity-', async cwd => {
      execFileSync('git', ['init', '-q'], { cwd });
      for (let file = 0; file < 215; file++) writeFileSync(join(cwd, `fixture-${file}.js`),
        Array.from({ length: 60 }, (_, line) => `export const value${line} = '${'x'.repeat(80)}';`).join('\n') + '\n');
      const captured = await captureScmComparison({ cwd, sessionId: 'sess-1', source: { kind: 'workingTree' } });
      const maxInputUnicodeCharacters = 1 << 20; // Codex rust-v0.163.0 protocol/user_input.rs.
      const preparation: ExecutionRunProfilePrepareStartParams = { cwd, sessionId: 'sess-1',
        resolveMaxInputUnicodeCharacters: async () => maxInputUnicodeCharacters,
        request: { backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, intent: 'scm_diff_summary',
          instructions: 'Explain the changes', permissionMode: 'read_only', retentionPolicy: 'resumable',
          runClass: 'long_lived', ioMode: 'streaming', intentInput: { cwd, source: { kind: 'workingTree' },
            comparisonId: captured.comparison.id, outputs: ['walkthrough'] } } };
      const early = await ScmDiffSummaryProfile.prepareStartParams!(preparation);
      expect(early!.intentInput).not.toHaveProperty('scmAnalysis');
      const roleGuidance = 'Preserve the admitted role and execution descriptor guidance.\n\n';
      const prepared = await ScmDiffSummaryProfile.finalizeStartParams?.({ ...preparation,
        request: { ...preparation.request, ...early, instructions: roleGuidance + String(early!.instructions) } });
      expect(prepared).toBeDefined();
      let intentInput = prepared!.intentInput;
      expect(intentInput).toHaveProperty('scmAnalysis');
      let instructions = String(prepared!.instructions);
      let localId: string | undefined;
      let evidenceParts = 0;
      let completion;
      do {
        expect(instructions.startsWith(roleGuidance)).toBe(true);
        expect(Array.from(instructions).length).toBeLessThanOrEqual(maxInputUnicodeCharacters);
        const state = (intentInput as { scmAnalysis: { phase: string; current: string[] } }).scmAnalysis;
        if (state.phase === 'evidence') evidenceParts++;
        const refs = state.phase === 'evidence' ? state.current
          : captured.comparison.inventory.files.flatMap(file => file.occurrences.map(change => change.id));
        const aliases = captured.comparison.inventory.files.flatMap(file => file.occurrences)
          .filter(change => refs.includes(change.id)).map(change => change.alias);
        completion = advanceDiffSummaryAnalysis({ start: start(intentInput), turnId: `part-${evidenceParts}-${state.phase}`,
          ...(localId ? { inputIds: [localId] } : {}), finishedAtMs: 2,
          rawText: JSON.stringify({ walkthrough: { title: 'Reading', intro: '', stops: [], otherChangeRefs: aliases } }) });
        if (!completion?.nextInput) break;
        ({ instructions, intentInput, localId } = completion.nextInput);
      } while (completion.nextInput);
      expect(evidenceParts).toBeGreaterThanOrEqual(2);
      expect(completion?.toolResultOutput).toMatchObject({ runId: 'run-1',
        outputs: { walkthrough: { state: 'complete' } }, analysis: { remainingChangeRefs: [] } });
      await deleteCapturedScmComparison({ cwd, sessionId: 'sess-1', comparisonId: captured.comparison.id });
    });
  });

  it.each([
    { prior: false, code: 'provider_input_too_large', message: 'The provider rejected input that exceeds its character limit.' },
    { prior: true, code: 'provider_request_rejected', message: 'The provider rejected the start request.' },
  ])('keeps inventory and prior prose on a typed input refusal ($code, prior output: $prior)', async ({ prior, code, message }) => {
    await withTempDir('happier-scm-refused-', async cwd => {
      const scoped = { ...comparison, repository: { rootPath: cwd }, inventory: { ...comparison.inventory,
        files: [...comparison.inventory.files, { ...comparison.inventory.files[0]!, path: 'b.ts',
          occurrences: [{ ...comparison.inventory.files[0]!.occurrences[0]!, id: 'change-2', alias: 'c2', path: 'b.ts' }] }] } };
      const admitted = await admitInitial(start({ ...input(['walkthrough']), cwd, comparison: scoped,
        ...(prior ? { scmAnalysis: { phase: 'evidence', current: ['change-1'], pending: [{ refs: ['change-2'] }],
          parts: [], supplied: [], analysed: [], failures: [], failedRefs: [] } } : {}) }));
      const published = prior ? await ScmDiffSummaryProfile.onTurnComplete!({ ...admitted, turnId: 'completed', finishedAtMs: 2,
        rawText: JSON.stringify({ walkthrough: { title: 'Published', intro: '', stops: [], otherChangeRefs: ['c1'] } }) }) : null;
      const settled = await ScmDiffSummaryProfile.onTerminal!({ start: admitted.start, status: 'failed', finishedAtMs: 3,
        structuredMeta: published?.structuredMeta ?? admitted.previousStructuredMeta,
        diagnostic: { code, message } });
      expect(settled?.toolResultOutput).toMatchObject({ comparison: scoped, outputs: { walkthrough: {
        state: prior ? 'partial' : 'failed', reason: message, reasonCode: code,
        ...(prior ? { value: { title: 'Published' } } : {}),
      } } });
    });
  });

  it.each([false, true])('plans a known-capacity single hunk before admission with exact fragments and same-run part progress (single line: %s)', async (singleLine) => {
    // This fixture must fit the canonical instructions and exact fragment headers
    // (now about 3.6 KB), while still forcing this hunk to arrive in parts.
    const contextWindowTokens = singleLine ? 6000 : 4500;
    const directory = mkdtempSync(join(tmpdir(), 'happier-scm-capacity-'));
    execFileSync('git', ['init', '-q'], { cwd: directory });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: directory });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: directory });
    writeFileSync(join(directory, 'large.txt'), 'old\n');
    execFileSync('git', ['add', '.'], { cwd: directory });
    execFileSync('git', ['commit', '-qm', 'initial'], { cwd: directory });
    writeFileSync(join(directory, 'large.txt'), singleLine ? 'line-😀'.repeat(500) + '\n'
      : Array.from({ length: 200 }, (_, i) => `line-${i} 😀`).join('\n') + '\n');
    const captured = await captureScmComparison({ cwd: directory, sessionId: 'sess-1', source: { kind: 'workingTree' } });
    const prepare = await prepareAnalysis({ cwd: directory, sessionId: 'sess-1',
      contextWindowTokens, request: { backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, intent: 'scm_diff_summary',
        instructions: 'Explain carefully', permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'streaming',
        intentInput: { cwd: directory, comparisonId: captured.comparison.id, source: { kind: 'workingTree' }, outputs: ['summary'],
          investigateSurroundingFiles: singleLine } } });
    const preparedInput = prepare!.intentInput as Record<string, unknown>;
    expect(preparedInput.scmAnalysis).toMatchObject({ phase: 'evidence', currentFragment: {
      path: 'large.txt', startOffset: expect.any(Number), endOffset: expect.any(Number),
    } });
    expect(new TextEncoder().encode(String(prepare!.instructions)).byteLength).toBeLessThanOrEqual(contextWindowTokens);
    const active = preparedInput.scmAnalysis as { currentDiff: string; currentFragment: { startOffset: number; endOffset: number };
      pending: { diff: string; fragment: { startOffset: number; endOffset: number } }[] };
    expect(active.pending.length).toBeGreaterThan(0);
    const source = captured.comparison.inventory.files[0]!.evidence.unifiedDiff!;
    const fragments = [{ diff: active.currentDiff, fragment: active.currentFragment }, ...active.pending];
    let offset = source.indexOf('@@ ');
    for (const part of fragments) {
      expect(part.fragment.startOffset).toBe(offset);
      expect(part.diff).toBe(source.slice(part.fragment.startOffset, part.fragment.endOffset));
      expect(part.diff).not.toMatch(/[\uD800-\uDBFF]$|^[\uDC00-\uDFFF]/u);
      offset = part.fragment.endOffset;
    }
    expect(offset).toBe(source.length);
    expect(ScmDiffSummaryProfile.buildInitialInputContext?.({ start: start(preparedInput) })).toBe('');
    const completion = advanceDiffSummaryAnalysis({ start: start(preparedInput), turnId: 'known-part', finishedAtMs: 2,
      rawText: JSON.stringify({ summaryMarkdown: 'Part' }) });
    expect(completion?.toolResultOutput).toMatchObject({ analysis: { parts: { completed: 1,
      total: active.pending.length + 1, phase: 'evidence' } } });
    expect(completion?.nextInput?.instructions).toContain('Fragment offsets');
    expect(completion?.nextInput?.instructions).toContain('Context before');
    if (singleLine) {
      expect(completion?.nextInput?.instructions).toContain(JSON.stringify(String(prepare!.cwd)));
      expect(completion?.nextInput?.instructions).toContain(JSON.stringify(join(String(prepare!.cwd), '..', 'before')));
    }
    let next = completion?.nextInput;
    let turn = 0;
    while (next && (next.intentInput as { scmAnalysis: { phase: string } }).scmAnalysis.phase === 'evidence') {
      expect(new TextEncoder().encode(next.instructions).byteLength).toBeLessThanOrEqual(contextWindowTokens);
      const advanced = advanceDiffSummaryAnalysis({ start: start(next.intentInput), turnId: `checked-${turn++}`,
        inputIds: [next.localId], finishedAtMs: 3, rawText: JSON.stringify({ summaryMarkdown: 'Part' }) });
      next = advanced?.nextInput;
    }
  });

  it('retains the original request through unknown-capacity native rejection and final integration', () => {
    const instruction = 'Keep the requested behavioral explanation, not only a file list.';
    const rejected = advanceDiffSummaryAnalysis({ start: start({ ...input(), instructions: instruction, outputLanguage: 'fr',
      reviewNarration: { phase: 'writing', provenance: {
        reviewedRuns: [{ runId: 'review-run', callId: 'review-call', backendId: 'review-agent', status: 'succeeded',
          hasOutput: true, reviewOutcome: 'complete', comparisonId: comparison.id }],
        narrationMode: 'seeded_narrator', comparisonFreshness: 'unchanged',
      }, findingsContext: JSON.stringify({ reviewDecision: 'Keep the existing contract' }) },
    }),
      turnId: 'rejected', finishedAtMs: 2, rawText: '', diagnostic: { code: 'agent_context_window_exceeded' } });
    expect(rejected?.nextInput?.instructions).toContain(instruction);
    expect(rejected?.nextInput?.instructions).toContain('Prose language: fr');
    expect(rejected?.nextInput?.instructions).toContain('Additional evidence context:');
    expect(rejected?.nextInput?.instructions).toContain('Keep the existing contract');
    let next = rejected?.nextInput;
    let index = 0;
    let progress = rejected?.toolResultOutput;
    while (next && (next.intentInput as { scmAnalysis: { phase: string } }).scmAnalysis.phase === 'evidence') {
      const advanced = advanceDiffSummaryAnalysis({ start: start(next.intentInput), inputIds: [next.localId],
        turnId: `fallback-${index++}`, finishedAtMs: 3, rawText: JSON.stringify({ summaryMarkdown: 'Part' }) });
      progress = advanced?.toolResultOutput;
      next = advanced?.nextInput;
    }
    expect(progress).toMatchObject({ analysis: { parts: { completed: index, total: index, phase: 'merge' } } });
    expect(next?.instructions).toContain(instruction);
    expect(next?.instructions).toContain('Prose language: fr');
    expect(next?.instructions).toContain('Keep the existing contract');
  });

  it('publishes no revision for part admission and retains completion progress and the publication basis', async () => {
    const active = { ...input(), scmAnalysis: { phase: 'evidence', current: ['change-1'],
      pending: [{ refs: ['change-1'] }], parts: [], supplied: [], analysed: [], failures: [], failedRefs: [] } };
    const selectedStart = (intentInput: unknown) => ({ ...start(intentInput), modelId: 'selected-parts-model' });
    const admitted = await admitInitial(selectedStart(active));
    const first = await ScmDiffSummaryProfile.onTurnComplete?.({ ...admitted, turnId: 'first-part', finishedAtMs: 2,
      rawText: JSON.stringify({ summaryMarkdown: 'First part' }) });
    expect(first?.toolResultOutput).toMatchObject({ analysis: { parts: { completed: 1, total: 2 } },
      producer: { modelId: 'selected-parts-model' } });
    const nextStart = selectedStart(first!.nextInput!.intentInput);
    const output = ScmDiffSummaryGenerateOutputSchema.parse(first?.toolResultOutput);
    const scope = { cwd: '/repo', sessionId: 'sess-1', resultId: output.resultId! };
    const beforeAdmission = await scmDiffSummaryResultStore.read(scope);
    await ScmDiffSummaryProfile.onBeforeRetainedInput?.({ start: nextStart, localId: first!.nextInput!.localId });
    expect(await scmDiffSummaryResultStore.read(scope)).toEqual(beforeAdmission);
    const second = await ScmDiffSummaryProfile.onTurnComplete?.({ start: nextStart, turnId: 'second-part',
      inputIds: [first!.nextInput!.localId], finishedAtMs: 3, rawText: JSON.stringify({ summaryMarkdown: 'Second part' }) });
    expect(second?.toolResultOutput).toMatchObject({ analysis: { parts: { completed: 2, total: 2, phase: 'merge' } },
      producer: { modelId: 'selected-parts-model' } });
  });

  it('presents aliases in retained multipart integration and resolves the final aliases to host references', () => {
    const twoParts = { ...comparison, inventory: { ...comparison.inventory, files: [comparison.inventory.files[0]!,
      { ...comparison.inventory.files[0]!, path: 'b.ts', occurrences: [{ ...comparison.inventory.files[0]!.occurrences[0]!,
        id: 'change-2', alias: 'c2', path: 'b.ts' }] }] } };
    const active = { ...input(['walkthrough']), comparison: twoParts,
      scmAnalysis: { phase: 'evidence', current: ['change-1'], pending: [{ refs: ['change-2'] }],
      parts: [], supplied: [], analysed: [], failures: [], failedRefs: [] } };
    const first = advanceDiffSummaryAnalysis({ start: start(active), turnId: 'part', finishedAtMs: 2,
      rawText: JSON.stringify({ walkthrough: { title: 'Read', intro: '', stops: [], otherChangeRefs: ['c1'] } }) });
    expect(first?.nextInput?.instructions).toContain('c2');
    expect(first?.nextInput?.instructions).not.toContain('change-2');
    const second = advanceDiffSummaryAnalysis({ start: start(first!.nextInput!.intentInput), turnId: 'part-2',
      inputIds: [first!.nextInput!.localId], finishedAtMs: 3,
      rawText: JSON.stringify({ walkthrough: { title: 'Read', intro: '', stops: [], otherChangeRefs: ['c2'] } }) });
    expect(second?.nextInput?.instructions).toContain('"otherChangeRefs":["c1","c2"]');
    expect(second?.nextInput?.instructions).not.toMatch(/change-[12]/);
    const final = advanceDiffSummaryAnalysis({ start: start(second!.nextInput!.intentInput), turnId: 'merge',
      inputIds: [second!.nextInput!.localId], finishedAtMs: 4,
      rawText: JSON.stringify({ walkthrough: { title: 'Read', intro: '', stops: [], otherChangeRefs: ['c1', 'c2'] } }) });
    expect(final?.toolResultOutput).toMatchObject({ outputs: { walkthrough: { state: 'complete', value: { otherChangeRefs: ['change-1', 'change-2'] } } } });
  });

  it('presents aliases in saved discussion context while keeping the saved envelope canonical', () => {
    const payload = ScmDiffSummaryGenerateOutputSchema.parse({ success: true, sourceKey: comparison.id, comparison,
      metadata: input().metadata, requestedOutputs: ['walkthrough'], outputs: { walkthrough: { state: 'complete', value: {
        title: 'Read', intro: '', stops: [], otherChangeRefs: ['change-1'],
      } } }, analysis: { suppliedChangeRefs: ['change-1'], analysedChangeRefs: ['change-1'], remainingChangeRefs: [] } });
    const context = ScmDiffSummaryProfile.buildInitialInputContext?.({ start: start({ ...input(), resultId: 'saved' }),
      structuredMeta: { kind: 'scm_diff_summary.v1', payload } });
    expect(context).toContain('"otherChangeRefs":["c1"]');
    expect(context).not.toContain('change-1');
    expect(payload.outputs?.walkthrough?.value?.otherChangeRefs).toEqual(['change-1']);
    expect(parseDiffSummaryModelOutput(JSON.stringify({ walkthrough: { title: 'Read', intro: '', stops: [],
      otherChangeRefs: ['change-1'] } }), { comparison })).toBeNull();
  });

  it('presents published findings using aliases without exposing finding identities', () => {
    const params = start({ ...input(['walkthrough']), resultId: 'saved', reviewNarration: { phase: 'writing', provenance: {
      reviewedRuns: [{ runId: 'review-a', callId: 'call-a', backendId: 'claude', status: 'failed', hasOutput: true,
        reviewOutcome: 'partial', comparisonId: comparison.id }], narrationMode: 'continued_review', comparisonFreshness: 'unchanged',
    }, reviewFindings: [{ runRef: { runId: 'review-a', callId: 'call-a', backendId: 'claude' },
      findings: [{ id: 'secret-finding-identity', title: 'Published concern', summary: 'Evidence' }] }] } });
    const context = ScmDiffSummaryProfile.buildInitialInputContext?.({ start: params });
    expect(context).toContain('F1');
    expect(context).toContain('Published concern');
    expect(context).toContain('partial');
    expect(context).not.toContain('secret-finding-identity');
    expect(context).toContain('[text](finding:F3)');
  });

  it('retains seeded multi-run finding aliases through native publication and a later explanation input', async () => {
    const provenance = { reviewedRuns: ['review-a', 'review-b'].map(runId => ({ runId, callId: `call-${runId}`,
      backendId: 'claude', status: 'succeeded' as const, hasOutput: true, comparisonId: comparison.id })),
      narrationMode: 'seeded_narrator' as const, comparisonFreshness: 'unchanged' as const };
    const prepared = await prepareSavedReviewWalkthroughInput(start(input(['walkthrough'])), provenance, JSON.stringify({ reviews:
      provenance.reviewedRuns.map(runRef => ({ runRef, findings: [{ id: 'same-real-id', title: runRef.runId, summary: 'Published' }] })) }));
    expect(prepared.instructions).toContain('"id":"F1"');
    expect(prepared.instructions).toContain('"id":"F2"');
    expect(prepared.instructions).not.toContain('same-real-id');
    const params = start(prepared.intentInput, 'native-model');
    const completed = await ScmDiffSummaryProfile.onTurnComplete?.({ start: params, turnId: 'narrate',
      inputIds: [prepared.localId], finishedAtMs: 11, rawText: JSON.stringify({ walkthrough: {
        title: 'Read', intro: '', stops: [{ id: 'stop', title: 'a.ts', changeRefs: ['c1'], findingRefs: ['F2'],
          explanationMarkdown: '[second](finding:F2) [other](finding:F1)' }], otherChangeRefs: [],
      } }) });
    const saved = ScmDiffSummaryGenerateOutputSchema.parse(completed?.toolResultOutput);
    expect(saved.outputs?.walkthrough?.value?.stops[0]).toMatchObject({ findingRefs: ['review-b:same-real-id'],
      explanationMarkdown: '[second](finding:review-b:same-real-id) other' });
    const scope = { cwd: '/repo', sessionId: 'sess-1', resultId: saved.resultId! };
    await scmDiffSummaryResultStore.beginInput({ ...scope, inputId: 'explain-citation', expectedRevision: saved.revision,
      outputs: ['walkthrough'], stopIds: ['stop'], reviewExplanation: { requestedBy: { kind: 'user' }, targets: [
        { stopId: 'stop', findingRefs: [{ runId: 'review-b', findingId: 'same-real-id' }] },
      ] } });
    const explanation = await ScmDiffSummaryProfile.onTurnComplete?.({ start: params, turnId: 'explain',
      inputIds: ['explain-citation'], finishedAtMs: 12, previousStructuredMeta: completed?.structuredMeta,
      rawText: JSON.stringify({ reviewExplanations: [{ stopId: 'stop', markdown: '[why](finding:F2) [wrong](finding:F1)' }] }) });
    expect(explanation?.toolResultOutput).toMatchObject({ outputs: { walkthrough: { value: { stops: [
      { reviewExplanations: [{ markdown: '[why](finding:review-b:same-real-id) wrong' }] },
    ] } } } });
  });

  it('does not trust model-written canonical finding URLs in the bounded output path', () => {
    const completed = ScmDiffSummaryProfile.onBoundedComplete?.({ start: start(input(['walkthrough'])), finishedAtMs: 3,
      rawText: JSON.stringify({ walkthrough: { title: 'Read', intro: '', otherChangeRefs: [], stops: [
        { id: 'stop', title: 'a.ts', changeRefs: ['c1'], findingRefs: ['unpublished:actual'],
          explanationMarkdown: '[spoof](finding:unpublished:actual)' },
      ] } }) });
    expect(completed?.toolResultOutput).toMatchObject({ outputs: { walkthrough: { value: { stops: [
      { findingRefs: [], explanationMarkdown: 'spoof' },
    ] } } } });
  });

  it('publishes separate finding explanations with the admitted requester and actual native producer', async () => {
    const created = await scmDiffSummaryResultStore.create({ cwd: '/repo', sessionId: 'sess-1', output: ScmDiffSummaryGenerateOutputSchema.parse({
      success: true, sourceKey: comparison.id, comparison, metadata: input().metadata, requestedOutputs: ['walkthrough'],
      outputs: { walkthrough: { state: 'complete', value: { title: 'Read', intro: '', otherChangeRefs: [],
        stops: [{ id: 'stop', title: 'a.ts', explanationMarkdown: 'Manual prose', changeRefs: ['change-1'] }] } } },
      analysis: { suppliedChangeRefs: ['change-1'], analysedChangeRefs: ['change-1'], remainingChangeRefs: [] },
    }) });
    const scope = { cwd: '/repo', sessionId: 'sess-1', resultId: created.resultId };
    await scmDiffSummaryResultStore.beginInput({ ...scope, inputId: 'explain', outputs: ['walkthrough'], stopIds: ['stop'],
      reviewExplanation: { targets: [{ stopId: 'stop', findingRefs: [{ runId: 'review-1', findingId: 'finding-1' }] }],
        requestedBy: { kind: 'user' }, requestedAtMs: 7 } });
    const seeded = start({ ...input(['walkthrough']), ...scope, resultBaseRevision: 0, stopIds: ['stop'],
      reviewExplanationInputId: 'explain' }, 'native-model');
    await ScmDiffSummaryProfile.onStarted?.({ start: seeded, rawText: '', finishedAtMs: 9 });
    expect(await scmDiffSummaryResultStore.readInput({ ...scope, inputIds: ['execution-run-initial:run-1'] }))
      .toMatchObject({ reviewExplanation: { requestedBy: { kind: 'user' }, requestedAtMs: 7 } });
    expect(await scmDiffSummaryResultStore.readInput({ ...scope, inputIds: ['explain'] })).toBeNull();
    const completed = await ScmDiffSummaryProfile.onTurnComplete?.({ start: seeded,
      turnId: 'native-turn', inputIds: ['execution-run-initial:run-1'], finishedAtMs: 11,
      previousStructuredMeta: { kind: 'scm_diff_summary.v1', payload: created.output },
      rawText: JSON.stringify({ reviewExplanations: [{ stopId: 'stop', markdown: 'Finding clarification' }] }) });
    expect(completed?.toolResultOutput).toMatchObject({ outputs: { walkthrough: { value: { stops: [{
      explanationMarkdown: 'Manual prose', reviewExplanations: [{ markdown: 'Finding clarification', provenance: {
        requestedBy: { kind: 'user' }, requestedAtMs: 7, generatedAtMs: 11, runId: 'run-1', modelId: 'native-model',
      } }],
    }] } } } });
  });

  it('persists engine launch failures separately from actual reviewer Run identities', async () => {
    const failures = [{ engineId: 'unavailable-reviewer', errorCode: 'admission_failed', error: 'Engine unavailable' }];
    const params = start({ ...input(['walkthrough']), reviewNarration: { phase: 'writing', provenance: {
      reviewedRuns: [{ runId: 'review', callId: 'review-call', backendId: 'claude', status: 'succeeded', hasOutput: true,
        reviewOutcome: 'complete', comparisonId: comparison.id }], narrationMode: 'seeded_narrator',
      comparisonFreshness: 'unchanged', launchFailures: failures,
    } } });
    const completion = await ScmDiffSummaryProfile.onTurnComplete?.({ ...await admitInitial(params), turnId: 'narrate', finishedAtMs: 2,
      rawText: JSON.stringify({ walkthrough: { title: 'Read', intro: '', stops: [], otherChangeRefs: ['c1'] } }) });
    expect(completion?.toolResultOutput).toMatchObject({ producer: { kind: 'review', launchFailures: failures } });
    const output = ScmDiffSummaryGenerateOutputSchema.parse(completion?.toolResultOutput);
    expect(await scmDiffSummaryResultStore.read({ cwd: '/repo', sessionId: 'sess-1', resultId: output.resultId! }))
      .toMatchObject({ success: true, result: { output: { producer: { launchFailures: failures } } } });
  });

  it('keeps retained partial prose writing until the final multipart merge settles', async () => {
    const active = { ...input(['walkthrough']), scmAnalysis: { phase: 'evidence', current: ['change-1'], pending: [],
      parts: [], supplied: [], analysed: [], failures: [], failedRefs: [] } };
    const first = await ScmDiffSummaryProfile.onTurnComplete?.({ ...await admitInitial(start(active)), turnId: 'part', finishedAtMs: 2,
      rawText: JSON.stringify({ walkthrough: { title: 'Read', intro: '', stops: [], otherChangeRefs: ['c1'] } }) });
    expect(first?.nextInput).toBeDefined();
    expect(first?.toolResultOutput).toMatchObject({ outputs: { walkthrough: { state: 'writing', value: { title: 'Read' } } } });
    await ScmDiffSummaryProfile.onBeforeRetainedInput?.({ start: start(first!.nextInput!.intentInput), localId: first!.nextInput!.localId });
    const final = await ScmDiffSummaryProfile.onTurnComplete?.({ start: start(first!.nextInput!.intentInput), turnId: 'merge',
      inputIds: [first!.nextInput!.localId], previousStructuredMeta: first!.structuredMeta, finishedAtMs: 3, rawText: 'not JSON' });
    expect(final?.nextInput).toBeUndefined();
    expect(final?.toolResultOutput).toMatchObject({ outputs: { walkthrough: { state: 'partial' } } });
  });

  it('does not let a replaced generator capture new writes or terminalize the replacement result', async () => {
    const created = await scmDiffSummaryResultStore.create({ cwd: '/repo', sessionId: 'sess-1', output: ScmDiffSummaryGenerateOutputSchema.parse({
      success: true, sourceKey: comparison.id, comparison, metadata: input().metadata, runId: 'replacement-run',
      requestedOutputs: ['summary'], outputs: { summary: { state: 'pending' } },
      analysis: { suppliedChangeRefs: [], analysedChangeRefs: [], remainingChangeRefs: ['change-1'] },
    }) });
    const previous = start({ ...input(), cwd: '/repo', resultId: created.resultId });
    await expect(ScmDiffSummaryProfile.onBeforeRetainedInput?.({ start: previous, localId: 'old-run-input' })).rejects.toThrow();
    expect(await ScmDiffSummaryProfile.onTerminal?.({ start: previous, status: 'cancelled', finishedAtMs: 2 })).toBeNull();
    expect(await scmDiffSummaryResultStore.read({ cwd: '/repo', sessionId: 'sess-1', resultId: created.resultId }))
      .toMatchObject({ success: true, result: { revision: 0, output: { runId: 'replacement-run', outputs: { summary: { state: 'pending' } } } } });
  });

  it('does not publish unmatched completion or resurrect a replaced generator even without input IDs', async () => {
    const initial = await ScmDiffSummaryProfile.onStarted?.({ start: start(input(['walkthrough'])), rawText: '', finishedAtMs: 2 });
    const saved = ScmDiffSummaryGenerateOutputSchema.parse(initial?.toolResultOutput);
    const scope = { cwd: '/repo', sessionId: 'sess-1', resultId: saved.resultId! };
    const incumbent = start({ ...input(['walkthrough']), ...scope });
    const replacement = await scmDiffSummaryResultStore.bindRun({ ...scope, expectedRevision: saved.revision!, runId: 'replacement' });
    if (!replacement.success) throw new Error(replacement.error);
    const manual = await scmDiffSummaryResultStore.edit({ ...scope, expectedRevision: replacement.result.revision,
      edit: { kind: 'replaceWalkthrough', value: { title: 'Manual title', intro: '', stops: [], otherChangeRefs: ['change-1'] } } });
    if (!manual.success) throw new Error(manual.error);
    for (const inputIds of [undefined, ['unmatched'], ['execution-run-initial:run-1']]) {
      expect(await ScmDiffSummaryProfile.onTurnComplete?.({ start: incumbent, turnId: 'late', inputIds, finishedAtMs: 4,
        previousStructuredMeta: initial?.structuredMeta, rawText: JSON.stringify({ walkthrough: {
          title: 'Old overwrite', intro: '', stops: [], otherChangeRefs: ['c1'],
        } }) })).toBeNull();
    }
    expect(await scmDiffSummaryResultStore.read(scope)).toMatchObject({ success: true, result: {
      revision: manual.result.revision, output: { runId: 'replacement', outputs: { walkthrough: { value: { title: 'Manual title' } } } },
    } });
  });

  it('uses only admitted initial or follow-up revision bases on completion', async () => {
    const requested = { ...input(['walkthrough']), requestedModelId: 'narrator-model', resolvedSelector: { catalogId: 'profile:narrator-model' } };
    const initial = await ScmDiffSummaryProfile.onStarted?.({ start: start(requested, 'narrator-model'), rawText: '', finishedAtMs: 2 });
    const saved = ScmDiffSummaryGenerateOutputSchema.parse(initial?.toolResultOutput);
    const scope = { cwd: '/repo', sessionId: 'sess-1', resultId: saved.resultId! };
    const params = start({ ...requested, ...scope }, 'narrator-model');
    const rawText = JSON.stringify({ walkthrough: { title: 'First', intro: '', stops: [], otherChangeRefs: ['c1'] } });
    const first = await ScmDiffSummaryProfile.onTurnComplete?.({ start: params, turnId: 'first-native', finishedAtMs: 3,
      previousStructuredMeta: initial?.structuredMeta, rawText });
    expect(first?.toolResultOutput).toMatchObject({ outputs: { walkthrough: { value: { title: 'First' } } } });
    expect(await ScmDiffSummaryProfile.onTurnComplete?.({ start: params, turnId: 'unadmitted-native', finishedAtMs: 4,
      previousStructuredMeta: first?.structuredMeta, rawText })).toBeNull();
    await scmDiffSummaryResultStore.beginInput({ ...scope, inputId: 'follow-up', outputs: ['walkthrough'],
      expectedRevision: ScmDiffSummaryGenerateOutputSchema.parse(first?.toolResultOutput).revision! });
    await ScmDiffSummaryProfile.onBeforeRetainedInput?.({ start: params, localId: 'follow-up' });
    const current = ScmDiffSummaryGenerateOutputSchema.parse(first?.toolResultOutput);
    await scmDiffSummaryResultStore.edit({ ...scope, expectedRevision: current.revision!, edit: { kind: 'renameWalkthrough', title: 'New manual edit' } });
    const conflict = await ScmDiffSummaryProfile.onTurnComplete?.({ start: params, turnId: 'follow-native', inputIds: ['follow-up'],
      finishedAtMs: 5, previousStructuredMeta: first?.structuredMeta,
      rawText: JSON.stringify({ walkthrough: { title: 'Rejected stale model result', intro: '', stops: [], otherChangeRefs: ['c1'] } }) });
    expect(conflict?.toolResultMeta).toMatchObject({ scmResultUpdate: { status: 'revision_conflict' } });
    expect(await scmDiffSummaryResultStore.read(scope)).toMatchObject({ success: true, result: { output: {
      outputs: { walkthrough: { value: { title: 'New manual edit' } } },
    } } });
  });

  it('keeps the admitted initial revision rather than rebasing model kickoff over an intervening manual edit', async () => {
    const created = await scmDiffSummaryResultStore.create({ cwd: '/repo', sessionId: 'sess-1', output: ScmDiffSummaryGenerateOutputSchema.parse({
      success: true, sourceKey: comparison.id, comparison, metadata: input().metadata,
      requestedOutputs: ['summary'], outputs: { summary: { state: 'pending' } },
      analysis: { suppliedChangeRefs: [], analysedChangeRefs: [], remainingChangeRefs: ['change-1'] },
    }) });
    const scope = { cwd: '/repo', sessionId: 'sess-1', resultId: created.resultId };
    await scmDiffSummaryResultStore.edit({ ...scope, expectedRevision: 0,
      edit: { kind: 'replaceSummary', value: { summaryMarkdown: 'My newer manual explanation.' } } });
    await expect(ScmDiffSummaryProfile.onStarted?.({ start: start({ ...input(), ...scope, resultBaseRevision: 0 }), rawText: '', finishedAtMs: 2 }))
      .rejects.toThrow();
    await ScmDiffSummaryProfile.onTerminal?.({ start: start({ ...input(), ...scope, resultBaseRevision: 0 }), status: 'failed', finishedAtMs: 3 });
    expect(await scmDiffSummaryResultStore.read(scope)).toMatchObject({ success: true,
      result: { revision: 1, canUndo: true, output: { summaryMarkdown: 'My newer manual explanation.', outputs: { summary: { state: 'complete' } } } } });
  });

  it('parses requested structured output variants using the captured reference contract', () => {
    expect(parseDiffSummaryModelOutput(JSON.stringify({ walkthrough: { title: 'a', intro: '', stops: [], otherChangeRefs: ['c1'] },
      commitPlan: { groups: [], leftOutChangeRefs: ['c1'] } }), { comparison, requestedOutputs: ['walkthrough', 'commitPlan'], requireCompleteCoverage: true }))
      .toMatchObject({ walkthrough: { otherChangeRefs: ['change-1'] }, commitPlan: { leftOutChangeRefs: ['change-1'] } });
  });

  it('does not claim evidence was supplied when terminal cancellation has no prior generation artifact', async () => {
    const settled = await ScmDiffSummaryProfile.onTerminal?.({ start: start(input()), status: 'cancelled', finishedAtMs: 2 });
    expect(settled?.toolResultOutput).toMatchObject({ outputs: { summary: { state: 'cancelled' } }, analysis: {
      suppliedChangeRefs: [], analysedChangeRefs: [], remainingChangeRefs: ['change-1'],
    } });
  });

  it('persists a typed cancellation reason through the saved result reader', async () => {
    const admitted = await admitInitial(start(input(['walkthrough', 'summary'])));
    const pending = ScmDiffSummaryGenerateOutputSchema.parse(admitted.previousStructuredMeta?.payload);
    const published = await scmDiffSummaryResultStore.publishProgress({ cwd: '/repo', sessionId: 'sess-1',
      resultId: pending.resultId!, expectedRevision: pending.revision!,
      output: ScmDiffSummaryGenerateOutputSchema.parse({ ...pending, outputs: {
        summary: { state: 'complete', value: { summaryMarkdown: 'Published summary' } },
        walkthrough: { state: 'partial', value: { title: 'Usable reading', intro: '', stops: [], otherChangeRefs: ['change-1'] } },
      } }),
    });
    expect(published.success).toBe(true);
    const terminal = await ScmDiffSummaryProfile.onTerminal!({ start: admitted.start,
      structuredMeta: admitted.previousStructuredMeta, status: 'cancelled', finishedAtMs: 1234 });
    const output = ScmDiffSummaryGenerateOutputSchema.parse(terminal?.toolResultOutput);
    const saved = ScmDiffSummaryResultResponseSchema.parse(await scmDiffSummaryResultStore.read({
      cwd: '/repo', sessionId: 'sess-1', resultId: output.resultId!,
    }));
    expect(saved).toMatchObject({ success: true, result: { output: { outputs: {
      walkthrough: { state: 'cancelled', reasonCode: 'generation_cancelled', value: { title: 'Usable reading' } },
      summary: { state: 'complete', value: { summaryMarkdown: 'Published summary' } },
    } } } });
  });

  it('seeds saved follow-up context from the current capture while retaining the original generation provenance', async () => {
    const savedOutput = { success: true, sourceKey: comparison.id, comparison, metadata: input().metadata,
      runId: 'original-run', producer: { kind: 'generation', runId: 'original-run' },
      cost: { inputTokens: 17 }, summaryMarkdown: 'Saved explanation.',
      requestedOutputs: ['summary'], outputs: { summary: { state: 'complete', value: { summaryMarkdown: 'Saved explanation.' } } },
      analysis: { suppliedChangeRefs: ['change-1'], analysedChangeRefs: ['change-1'], remainingChangeRefs: [] } };
    const saved = await scmDiffSummaryResultStore.create({ cwd: '/repo', sessionId: 'sess-1',
      output: ScmDiffSummaryGenerateOutputSchema.parse(savedOutput) });
    const current = start({ ...input(), resultId: saved.resultId });
    const restored = await ScmDiffSummaryProfile.onStarted?.({ start: current, rawText: '', finishedAtMs: 2 });
    expect(restored?.toolResultOutput).toMatchObject({ runId: 'run-1', producer: { runId: 'original-run', seededFromRunId: 'original-run' },
      cost: { inputTokens: 17 }, comparison, metadata: input().metadata });
    expect(ScmDiffSummaryProfile.buildInitialInputContext?.({ start: current, structuredMeta: restored?.structuredMeta })).toContain('Saved explanation.');
    expect(ScmDiffSummaryProfile.buildInitialInputContext?.({ start: current, structuredMeta: restored?.structuredMeta })).toContain('+new');
  });

  it('supplies every captured file and the full textual evidence to model admission', () => {
    const marker = 'LAST-LINE-BEYOND-THE-FORMER-SLICE';
    const files = Array.from({ length: 101 }, (_, index) => ({ path: `src/file-${index}.ts`,
      changeKind: 'modified', unifiedDiff: `${'a'.repeat(16_001)}\n${marker}-${index}` }));
    const prompt = buildDiffSummaryPrompt({ metadata: { source: { kind: 'workingTree' }, sourceKey: 'pending' }, files });
    expect(prompt.includes('src/file-100.ts')).toBe(true);
    expect(prompt.includes(`${marker}-100`)).toBe(true);
    expect(prompt.includes(`${marker}-0`)).toBe(true);
  });

  it('keeps the language and evidence boundary on a seeded generator', async () => {
    await withTempDir('happier-scm-language-', async cwd => {
      execFileSync('git', ['init', '-q'], { cwd });
      const captured = await captureScmComparison({ cwd, sessionId: 'sess-1', source: { kind: 'workingTree' } });
      const saved = await scmDiffSummaryResultStore.create({ cwd, sessionId: 'sess-1', output:
        ScmDiffSummaryGenerateOutputSchema.parse({ success: true, sourceKey: captured.comparison.id, metadata: captured.metadata,
          comparison: captured.comparison, runId: 'previous-run', requestedOutputs: ['walkthrough'],
          analysis: { suppliedChangeRefs: [], analysedChangeRefs: [], remainingChangeRefs: [] },
          outputs: { walkthrough: { state: 'complete', value: { title: 'Saved prose', intro: '', stops: [], otherChangeRefs: [] } } } }) });
      const prepared = await ScmDiffSummaryProfile.prepareStartParams!({ cwd, sessionId: 'sess-1', request: {
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, intent: 'scm_diff_summary',
        permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'streaming',
        intentInput: { cwd, source: captured.comparison.source, comparisonId: captured.comparison.id,
          resultId: saved.resultId, expectedRevision: saved.revision, outputs: ['walkthrough'], outputLanguage: 'fr',
          instructions: 'Keep the saved structure' },
      } });
      expect(prepared?.instructions).toContain('Editorial guidance:');
      expect(prepared?.instructions).toContain('Evidence boundary:');
      expect(prepared?.instructions).toContain('Prose language: fr');
      expect(prepared?.instructions).toContain('references, identifiers, paths, code and enum values');
      expect(prepared?.instructions).toContain('Saved prose');
      expect(prepared?.instructions).toContain('User instructions:\nKeep the saved structure');
    });
  });

  it('uses the strict protocol output contract without arbitrary prose length limits', () => {
    expect(parseDiffSummaryModelOutput(JSON.stringify({ summaryMarkdown: 'a'.repeat(80_001) }))?.summaryMarkdown?.length).toBe(80_001);
    expect(parseDiffSummaryModelOutput(JSON.stringify({ summaryMarkdown: 'Valid.', injectedCommand: 'git commit' }))).toBeNull();
  });

  it('reads the strict output a model wraps in leading prose and a code fence, still refusing unknown keys', () => {
    const wrap = (value: unknown) => ['I will group these changes by intent.', '', fence + 'json', JSON.stringify(value, null, 2), fence].join('\n');
    const commitPlan = { groups: [{ id: 'g1', message: 'Add sorting', rationale: 'Newest first.', changeRefs: ['c1'] }], leftOutChangeRefs: [] };
    expect(parseDiffSummaryModelOutput(wrap({ commitPlan }))?.commitPlan?.groups[0]?.message).toBe('Add sorting');
    expect(parseDiffSummaryModelOutput(wrap({ summaryMarkdown: 'Valid.', injectedCommand: 'git commit' }))).toBeNull();
  });

  it('publishes walkthrough-only output with captured identities and separate analysis coverage', async () => {
    const admitted = await admitInitial(start(input(['walkthrough'])));
    const baseRevision = ScmDiffSummaryGenerateOutputSchema.parse(admitted.previousStructuredMeta?.payload).revision;
    // Observational spies retain the real normalizer/schema and saved publication path.
    const normalization = vi.spyOn(diffSummaryProtocol, 'normalizeScmDiffSummaryModelOutput');
    const envelopes = vi.spyOn(ScmDiffSummaryGenerateOutputSchema, 'parse');
    let completed;
    try {
      completed = await ScmDiffSummaryProfile.onTurnComplete?.({ ...admitted,
      turnId: 'turn-1', finishedAtMs: 2, rawText: JSON.stringify({ walkthrough: {
        title: 'Read the change', intro: '', stops: [{ id: 'stop-1', title: 'a.ts', explanationMarkdown: 'Updates a.', changeRefs: ['c1'] }],
        otherChangeRefs: [],
      } }) });
      expect(normalization).toHaveBeenCalledTimes(1);
      expect(envelopes.mock.calls.filter(([value]) => value && typeof value === 'object'
        && 'comparison' in value && 'success' in value && value.success === true
        && 'revision' in value && value.revision === baseRevision)).toHaveLength(1);
    } finally {
      normalization.mockRestore();
      envelopes.mockRestore();
    }
    const output = ScmDiffSummaryGenerateOutputSchema.parse(completed?.toolResultOutput);
    expect(output).not.toHaveProperty('summaryMarkdown');
    expect(output.outputs?.walkthrough).toMatchObject({ state: 'complete', value: { stops: [{ changeRefs: ['change-1'] }] } });
    expect(output.outputs).not.toHaveProperty('summary');
    expect(output.analysis).toEqual({ suppliedChangeRefs: ['change-1'], analysedChangeRefs: ['change-1'], remainingChangeRefs: [] });
    // Read the real saved producer output with the same strict consumer contract.
    const read = await scmDiffSummaryResultStore.read({ cwd: comparison.repository.rootPath, sessionId: 'sess-1', resultId: output.resultId! });
    expect(read.success).toBe(true);
    if (!read.success) throw new Error(read.error);
    expect(ScmDiffSummaryGenerateOutputSchema.parse(read.result.output)).toEqual(output);
    expect(ScmDiffSummaryGenerateOutputSchema.safeParse({ ...output, outputs: { ...output.outputs,
      walkthrough: { ...output.outputs?.walkthrough, value: { ...output.outputs?.walkthrough?.value,
        stops: [{ ...output.outputs?.walkthrough?.value?.stops[0], changeRefs: ['c1'] }] } },
    } }).success).toBe(false);
  });

  it('publishes a readable saved result identity and revision on retained structured completion', async () => {
    const completed = await ScmDiffSummaryProfile.onTurnComplete?.({ ...await admitInitial(start(input(['walkthrough']))),
      turnId: 'saved-turn', finishedAtMs: 2, rawText: JSON.stringify({ walkthrough: {
        title: 'Saved beyond the generator', intro: '', stops: [], otherChangeRefs: ['c1'],
      } }) });
    const saved = ScmDiffSummaryGenerateOutputSchema.parse(completed?.toolResultOutput);
    expect(saved.resultId).toEqual(expect.any(String));
    expect(saved.revision).toBe(2);
    expect(completed?.toolResultMeta).toMatchObject({ scmResultUpdate: { status: 'published', canUndo: true,
      outputs: [{ kind: 'walkthrough', change: 'created' }] } });
    const scope = { cwd: '/repo', sessionId: 'sess-1', resultId: saved.resultId! };
    const edited = await scmDiffSummaryResultStore.edit({ ...scope, expectedRevision: saved.revision!,
      edit: { kind: 'renameWalkthrough', title: 'My title' } });
    if (!edited.success) throw new Error(edited.error);
    await scmDiffSummaryResultStore.beginInput({ ...scope, expectedRevision: edited.result.revision,
      inputId: 'refine', outputs: ['walkthrough'] });
    const updated = await ScmDiffSummaryProfile.onTurnComplete?.({ start: start({ ...input(['walkthrough']), resultId: saved.resultId }),
      previousStructuredMeta: completed?.structuredMeta, inputIds: ['refine'], turnId: 'refined-turn', finishedAtMs: 3,
      rawText: JSON.stringify({ walkthrough: { title: 'Updated explanation', intro: 'Refined explanation', stops: [], otherChangeRefs: ['c1'] } }) });
    expect(updated?.toolResultMeta).toMatchObject({ scmResultUpdate: { status: 'published', canUndo: true,
      outputs: [{ kind: 'walkthrough', change: 'updated' }], titleEditKept: true,
      updateNotice: { kind: 'generation', revision: edited.result.revision + 1, affectedStopIds: [] } } });
    const refined = ScmDiffSummaryGenerateOutputSchema.parse(updated?.toolResultOutput);
    await scmDiffSummaryResultStore.beginInput({ ...scope, expectedRevision: refined.revision!, inputId: 'unchanged', outputs: ['walkthrough'] });
    const unchanged = await ScmDiffSummaryProfile.onTurnComplete?.({ start: start({ ...input(['walkthrough']), resultId: saved.resultId }),
      previousStructuredMeta: updated?.structuredMeta, inputIds: ['unchanged'], turnId: 'unchanged-turn', finishedAtMs: 4,
      rawText: JSON.stringify({ walkthrough: { title: 'Updated explanation', intro: 'Refined explanation', stops: [], otherChangeRefs: ['c1'] } }) });
    expect(unchanged?.toolResultMeta?.scmResultUpdate).toBeUndefined();
  });

  it.each(['wrapped', 'bare'] as const)('publishes a selected-stop refinement without requiring the model to repeat unrelated reading fields (%s)', async (shape) => {
    const completed = await ScmDiffSummaryProfile.onTurnComplete?.({ ...await admitInitial(start(input(['walkthrough']))),
      turnId: 'initial', finishedAtMs: 2, rawText: JSON.stringify({ walkthrough: {
        title: 'Saved reading', intro: 'Saved introduction', otherChangeRefs: [], stops: [
          { id: 'selected', title: 'Before', explanationMarkdown: 'Before explanation', changeRefs: ['c1'] },
          { id: 'unselected', title: 'Keep', explanationMarkdown: 'Keep explanation', changeRefs: [] },
        ],
      } }) });
    const saved = ScmDiffSummaryGenerateOutputSchema.parse(completed?.toolResultOutput);
    const scope = { cwd: '/repo', sessionId: 'sess-1', resultId: saved.resultId! };
    await scmDiffSummaryResultStore.beginInput({ ...scope, expectedRevision: saved.revision!,
      inputId: 'selected-refine', outputs: ['walkthrough'], stopIds: ['selected'] });
    const walkthrough = { stops: [
      { id: 'selected', title: 'After', explanationMarkdown: 'After explanation', changeRefs: ['c1'] },
    ], otherChangeRefs: [] };
    const rawText = JSON.stringify(shape === 'wrapped' ? { walkthrough } : walkthrough);
    expect(parseDiffSummaryModelOutput(rawText), 'whole-reading admission still requires its own title and intro').toBeNull();
    const refined = await ScmDiffSummaryProfile.onTurnComplete?.({ start: start({ ...input(['walkthrough']), resultId: saved.resultId }),
      previousStructuredMeta: completed?.structuredMeta, inputIds: ['selected-refine'], turnId: 'refined', finishedAtMs: 3,
      rawText });
    expect(refined?.toolResultMeta).toMatchObject({ scmResultUpdate: { status: 'published', canUndo: true,
      outputs: [{ kind: 'walkthrough', change: 'updated' }] } });
    expect(refined?.toolResultOutput).toMatchObject({ revision: saved.revision! + 1, outputs: { walkthrough: { value: {
      title: 'Saved reading', intro: 'Saved introduction', stops: [
        { id: 'selected', title: 'After', explanationMarkdown: 'After explanation' },
        saved.outputs!.walkthrough!.value!.stops[1],
      ],
    } } } });
    const undone = await scmDiffSummaryResultStore.undo({ ...scope, expectedRevision: saved.revision! + 1 });
    expect(undone).toMatchObject({ success: true, result: { output: { outputs: saved.outputs } } });
  });

  it('keeps selected-stop shorthand scoped to its base and validates explicit reading fields', () => {
    const base = { title: 'Saved reading', intro: 'Saved introduction' };
    const walkthrough = { title: 'New reading', intro: 'New introduction', stops: [], otherChangeRefs: [] };
    expect(parseDiffSummaryModelOutput(JSON.stringify(walkthrough), undefined, base)?.walkthrough).toEqual(walkthrough);
    expect(parseDiffSummaryModelOutput(JSON.stringify(walkthrough))).toBeNull();
    for (const malformed of [
      { ...walkthrough, title: null },
      { ...walkthrough, stops: 'not-an-array' },
      { ...walkthrough, injectedCommand: 'git commit' },
      { ...walkthrough, walkthrough: null },
    ]) expect(parseDiffSummaryModelOutput(JSON.stringify(malformed), undefined, base)).toBeNull();
  });

  it('settles an unparseable selected-stop reply with a visible invalid-output notice and keeps discussion prose unchanged', async () => {
    const completed = await ScmDiffSummaryProfile.onTurnComplete?.({ ...await admitInitial(start(input(['walkthrough']))),
      turnId: 'initial', finishedAtMs: 2, rawText: JSON.stringify({ walkthrough: {
        title: 'Saved reading', intro: 'Saved introduction', otherChangeRefs: [], stops: [
          { id: 'selected', title: 'Before', explanationMarkdown: 'Before explanation', changeRefs: ['c1'] },
        ],
      } }) });
    const saved = ScmDiffSummaryGenerateOutputSchema.parse(completed?.toolResultOutput);
    const scope = { cwd: '/repo', sessionId: 'sess-1', resultId: saved.resultId! };
    const followupStart = start({ ...input(['walkthrough']), resultId: saved.resultId });
    const rawText = 'I could not produce the requested refinement.';
    await scmDiffSummaryResultStore.beginInput({ ...scope, expectedRevision: saved.revision!,
      inputId: 'invalid-targeted', outputs: ['walkthrough'], stopIds: ['selected'] });
    const refused = await ScmDiffSummaryProfile.onTurnComplete?.({ start: followupStart,
      previousStructuredMeta: completed?.structuredMeta, inputIds: ['invalid-targeted'], turnId: 'refused', finishedAtMs: 3, rawText });
    expect(refused?.toolResultMeta).toMatchObject({ scmResultUpdate: { status: 'invalid_output' } });
    expect(refused?.summary).toEqual(expect.any(String));
    expect(refused?.summary).not.toBe('');
    expect(refused?.toolResultOutput).toEqual(saved);
    expect(await scmDiffSummaryResultStore.readInput({ ...scope, inputIds: ['invalid-targeted'] })).toBeNull();
    expect(await scmDiffSummaryResultStore.read(scope)).toMatchObject({ success: true, result: { revision: saved.revision, output: saved } });

    await ScmDiffSummaryProfile.onBeforeRetainedInput?.({ start: followupStart, localId: 'discussion' });
    const discussed = await ScmDiffSummaryProfile.onTurnComplete?.({ start: followupStart,
      previousStructuredMeta: completed?.structuredMeta, inputIds: ['discussion'], turnId: 'discussed', finishedAtMs: 4, rawText });
    expect(discussed).toBeNull();
    expect(await scmDiffSummaryResultStore.read(scope)).toMatchObject({ success: true, result: { revision: saved.revision, output: saved } });
  });

  it('preserves prior output when later structured turns complete another requested output and ignores invalid discussion', async () => {
    const requested = { ...input(['summary']), requestedModelId: 'summary-model', resolvedSelector: { catalogId: 'profile:summary-model' } };
    const params = { ...await admitInitial(start(requested, 'summary-model')), turnId: 'turn-1', finishedAtMs: 2 };
    const first = await ScmDiffSummaryProfile.onTurnComplete?.({ ...params, rawText: '{"summaryMarkdown":"Useful summary"}' });
    const saved = ScmDiffSummaryGenerateOutputSchema.parse(first?.toolResultOutput);
    const followupStart = start({ ...requested, resultId: saved.resultId }, 'summary-model');
    const scope = { cwd: '/repo', sessionId: 'sess-1', resultId: saved.resultId! };
    const added = await scmDiffSummaryResultStore.beginInput({ ...scope, inputId: 'second', outputs: ['commitPlan'] });
    if (!added.success) throw new Error(added.error);
    const second = await ScmDiffSummaryProfile.onTurnComplete?.({ ...params, turnId: 'turn-2',
      inputIds: ['second'],
      previousStructuredMeta: first?.structuredMeta, rawText: JSON.stringify({ commitPlan: {
        groups: [{ id: 'group-1', message: 'fix: update a', rationale: '', changeRefs: ['c1'] }], leftOutChangeRefs: [],
      } }) });
    expect(second?.toolResultOutput).toMatchObject({ summaryMarkdown: 'Useful summary', outputs: {
      summary: { state: 'complete', value: { summaryMarkdown: 'Useful summary' } }, commitPlan: { state: 'complete' },
    } });
    await ScmDiffSummaryProfile.onBeforeRetainedInput?.({ start: followupStart, localId: 'chat' });
    expect(await ScmDiffSummaryProfile.onTurnComplete?.({ ...params, inputIds: ['chat'], previousStructuredMeta: second?.structuredMeta,
      rawText: 'An ordinary discussion answer.' })).toBeNull();
    const beforeDiscussion = await scmDiffSummaryResultStore.read(scope);
    await ScmDiffSummaryProfile.onBeforeRetainedInput?.({ start: followupStart, localId: 'json-chat' });
    expect(await ScmDiffSummaryProfile.onTurnComplete?.({ ...params, inputIds: ['json-chat'], previousStructuredMeta: second?.structuredMeta,
      rawText: JSON.stringify({ summaryMarkdown: 'An unrequested replacement' }) })).toBeNull();
    expect(await scmDiffSummaryResultStore.read(scope)).toEqual(beforeDiscussion);
    await scmDiffSummaryResultStore.beginInput({ ...scope, inputId: 'invalid', outputs: ['commitPlan'] });
    await ScmDiffSummaryProfile.onBeforeRetainedInput?.({ start: followupStart, localId: 'invalid' });
    const invalid = await ScmDiffSummaryProfile.onTurnComplete?.({ ...params, inputIds: ['invalid'], previousStructuredMeta: second?.structuredMeta,
      rawText: JSON.stringify({ commitPlan: { groups: [], leftOutChangeRefs: ['invented'] } }) });
    expect(invalid?.toolResultOutput).toEqual(second?.toolResultOutput);
    expect(invalid?.toolResultMeta).toMatchObject({ scmResultUpdate: { status: 'invalid_output' } });
  });

  it('does not claim unavailable occurrences in partially readable evidence were analysed', async () => {
    const partial = { ...comparison, inventory: { ...comparison.inventory, state: 'incomplete' as const,
      reasons: ['One layer unavailable'], files: comparison.inventory.files.map((file) => ({ ...file,
        evidence: { state: 'unavailable' as const, reason: 'One layer unavailable', unifiedDiff: '@@ -1 +1 @@\n-old\n+new\n' },
        occurrences: [{ ...file.occurrences[0]!, evidence: { state: 'available' as const } },
          { ...file.occurrences[0]!, id: 'change-2', alias: 'c2', evidence: { state: 'unavailable' as const, reason: 'Missing layer' } }],
      })) } };
    const completed = await ScmDiffSummaryProfile.onTurnComplete?.({ ...await admitInitial(start({ ...input(), comparison: partial })),
      turnId: 'turn-1', finishedAtMs: 2, rawText: '{"summaryMarkdown":"Evidence partly unavailable."}' });
    expect(completed?.toolResultOutput).toMatchObject({ analysis: {
      suppliedChangeRefs: ['change-1'], analysedChangeRefs: ['change-1'], remainingChangeRefs: ['change-2'],
    } });
    const malformed = await ScmDiffSummaryProfile.onTurnComplete?.({ ...await admitInitial(start({ ...input(), comparison: partial })),
      turnId: 'turn-invalid', finishedAtMs: 3, rawText: 'Malformed first generation.' });
    expect(malformed?.toolResultOutput).toMatchObject({ analysis: {
      suppliedChangeRefs: ['change-1'], analysedChangeRefs: [], remainingChangeRefs: ['change-1', 'change-2'],
    } });
  });

  it('prepares fresh captured evidence and seeds only a saved result without accepting caller publication scope', async () => {
    // Git/disk are genuine boundaries; capture/admission/profile run real logic.
    const cwd = mkdtempSync(join(tmpdir(), 'happier-summary-profile-'));
    execFileSync('git', ['init'], { cwd, stdio: 'ignore' });
    writeFileSync(join(cwd, 'a.ts'), 'new\n');
    const captured = await captureScmComparison({ cwd, source: { kind: 'workingTree' }, sessionId: 'sess-1' });
    const request = { kind: 'scm_diff_summary.v1' as const, intent: 'scm_diff_summary' as const,
      backendTarget: { kind: 'backend' as const, backendId: 'claude', sourceKind: 'built_in' as const },
      modelId: 'fast-summary',
      modelSelection: ProviderBoundModelRefSchema.parse({ agentTargetKey: 'agent:claude', providerConnectionId: 'connection-a', modelId: 'fast-summary' }),
      permissionMode: 'read_only', retentionPolicy: 'resumable' as const, runClass: 'long_lived' as const, ioMode: 'streaming' as const,
      intentInput: { cwd, source: { kind: 'workingTree' as const }, comparisonId: captured.comparison.id,
        outputs: ['summary'], resolvedSelector: { catalogId: 'profile:fast-summary' } } };
    const pending = await scmDiffSummaryResultStore.create({ cwd, sessionId: 'sess-1', output: ScmDiffSummaryGenerateOutputSchema.parse({
      success: true, sourceKey: captured.comparison.id, comparison: captured.comparison, metadata: captured.metadata,
      requestedOutputs: ['summary'], outputs: { summary: { state: 'pending' } },
      analysis: { suppliedChangeRefs: [], analysedChangeRefs: [], remainingChangeRefs: captured.comparison.inventory.files.flatMap(file => file.occurrences.map(change => change.id)) },
    }) });
    const captureFirst = await ScmDiffSummaryProfile.prepareStartParams?.({ cwd, sessionId: 'sess-1', request: { ...request,
      intentInput: { ...request.intentInput, resultId: pending.resultId, expectedRevision: 0, cachePolicy: { mode: 'bypass' } } } });
    expect(captureFirst?.instructions).toContain('"summaryMarkdown":');
    expect(ExecutionRunScmDiffSummaryInputV1Schema.safeParse(captureFirst?.intentInput).success).toBe(true);
    expect(captureFirst?.instructions).not.toContain('replacement generator');
    const fresh = await ScmDiffSummaryProfile.prepareStartParams?.({ cwd, sessionId: 'sess-1', request: {
      ...request, intentInput: { ...request.intentInput, scmAnalysis: { phase: 'done' },
        reviewExplanation: { targets: [{ stopId: 'stop', findingRefs: [{ runId: 'review', findingId: 'finding' }] }],
          requestedBy: { kind: 'user', id: 'spoofed-user' }, requestedAtMs: 1 } } } });
    expect(fresh?.intentInput).not.toHaveProperty('scmAnalysis');
    expect(fresh?.intentInput).not.toHaveProperty('reviewExplanation');
    const refs = captured.comparison.inventory.files.flatMap(file => file.occurrences.map(change => change.id));
    const saved = await scmDiffSummaryResultStore.create({ cwd, sessionId: 'sess-1', output: ScmDiffSummaryGenerateOutputSchema.parse({
      success: true, sourceKey: captured.comparison.id, comparison: captured.comparison, metadata: captured.metadata,
      requestedOutputs: ['walkthrough'], outputs: { walkthrough: { state: 'complete', value: {
        title: 'Saved', intro: '', stops: [], otherChangeRefs: refs,
      } } }, analysis: { suppliedChangeRefs: refs, analysedChangeRefs: refs, remainingChangeRefs: [] },
    }) });
    const seeded = await ScmDiffSummaryProfile.prepareStartParams?.({ cwd, sessionId: 'sess-1', contextWindowTokens: 1, request: {
      ...request, intentInput: { ...request.intentInput, resultId: saved.resultId, expectedRevision: 0, outputs: ['walkthrough'] },
    } });
    expect(seeded?.instructions).toContain('replacement generator');
    // A saved-result conversation is not itself a generation request. Capacity
    // reporting must not grant a whole-result multipart publication authority.
    expect((seeded?.intentInput as Record<string, unknown>).scmAnalysis).toBeUndefined();
    expect(seeded?.instructions).toContain('"otherChangeRefs":["c1"]');
    for (const ref of refs) expect(seeded?.instructions).not.toContain(ref);
  });
});
