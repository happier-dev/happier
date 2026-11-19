import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveAgentCliManagedCommandPathForRuntime } from '@happier-dev/cli-common/agents';
import { connectUiPersonActionClient } from '@happier-tests/ui-action-client';
import { REVIEW_NEW_ROUND_ACTION_ID_V1, type ActionId } from '@happier-dev/protocol/actions/actionIds';
import { reviewReviewerIdForSelectionV1, type ReviewEngineReviewerSelectionV1 } from '@happier-dev/protocol/reviews/reviewStart';
import { ReviewEngineInventorySchema } from '@happier-dev/protocol/reviews/reviewEngines';
import { BUILT_IN_ROLES_V1 } from '@happier-dev/protocol/prompts/roles/builtInRolesV1';
import { ReviewCommentListResponseV1Schema } from '@happier-dev/protocol/reviews/comments/actions';
import { WorkflowDefinitionCreateResultV1Schema, WorkflowInvocationListResultV1Schema, WorkflowRunGetResultV1Schema, WorkflowRunListResultV1Schema, WorkflowRunStartResultV1Schema } from '@happier-dev/protocol/workflows/actionsV1';
import { readMuseLoginRecording, readMuseMspProcessAudit, waitForMuseMspProcessAudit } from '../../../plugins/muse/src/agent/testkit/mspProcess';
import { REPOSITORY_REVIEW_WORKFLOW_V1 } from '@happier-dev/protocol/workflows/builtins/repositoryReview';
import { ReviewStartTerminalValueV1Schema } from '@happier-dev/protocol/actions/specs/executionRunCompletion';
import { ReviewGetResponseV1Schema } from '@happier-dev/protocol/reviews/reviewListV1';
import { ReviewNativeNewRoundResultV1Schema } from '@happier-dev/protocol/reviews/reviewRoundActionsV1';
import { ScmComparisonCaptureOutputSchema } from '@happier-dev/protocol/scm/diffSummary';
import panelNativeReview from '../../../plugins/review-panels/src/agent/reviews/fixtures/selected-review.json';
import { ExecutionRunGetResponseSchema, ExecutionRunStartResponseSchema } from '@happier-dev/protocol/execution/runs/responseSchemas';
import { readMuseRecord } from '../../../plugins/muse/src/agent/nativeInput';
import { buildMuseNativeAuth } from '../../../plugins/muse/src/connectedAccounts/nativeAuth';
import { startDatabaseWorkbenchPostgres } from '../../src/testkit/process/databaseWorkbenchPostgres';
import { startFinJourneyFixture, type FinJourneyFixture } from '../../src/testkit/finJourney';
import { writeFinMuseExecutable } from '../../src/testkit/finMuse';
import { createRunDirs } from '../../src/testkit/runDir';
import { waitFor } from '../../src/testkit/timing';
import { encryptLegacyBase64 } from '../../src/testkit/messageCrypto';
import { postEncryptedSessionMessage } from '../../src/testkit/memoryRpc';
import { createSessionWithCiphertexts } from '../../src/testkit/sessions';
import { execGit, initGitRepo } from '../../src/testkit/uiE2e/gitRepoFixtures';

const run = createRunDirs({ runLabel: 'core' });
const muse = { kind: 'agent', identity: { pluginId: 'happier.agent.muse', localId: 'muse' } } as const;
const modelId = 'meta/muse-spark-1.3-contributor';
const document = (text: string) => ({ text, references: [], attachments: [] });
const sourceClaim = 'The assistant reported all tests passed, but the test command was skipped.';

// Public Action -> encrypted Home/Postgres -> daemon -> retained Review and Check
// executions -> real Muse adapter/stdio. Only the native executable is playback.
describe('FIN selected Muse Review and convergence through public Actions', () => {
  let fixture: FinJourneyFixture | undefined;
  let postgres: Awaited<ReturnType<typeof startDatabaseWorkbenchPostgres>> | undefined;
  let owner: Awaited<ReturnType<FinJourneyFixture['createAccount']>>;
  let machine: Awaited<ReturnType<FinJourneyFixture['enrollDaemon']>>;
  let ui: Awaited<ReturnType<typeof connectUiPersonActionClient>> | undefined;
  let recordingPath: string;
  let auditPath: string;
  let recording: Awaited<ReturnType<typeof readMuseLoginRecording>>;
  let sourceSessionId: string;
  let panelReplyPath: string;
  let panelAuditPath: string;
  let deepSecAuditPath: string;
  let deepSecExecutablePath: string;
  let sliceAuditPath: string;
  let nativeHoldPath: string;
  async function createSourceSession(account = owner) {
    const source = await createSessionWithCiphertexts({ baseUrl: fixture!.server.baseUrl, token: account.auth.token,
      metadataCiphertextBase64: encryptLegacyBase64({ path: machine.workspaceDir }, account.auth.accountSigningSeed),
    });
    await postEncryptedSessionMessage({ baseUrl: fixture!.server.baseUrl, token: account.auth.token,
      sessionId: source.sessionId, secret: account.auth.accountSigningSeed, messageRole: 'user',
      payload: { role: 'user', content: { type: 'text', text: sourceClaim } },
    });
    return source.sessionId;
  }
  async function nativeReply(value: unknown) {
    // Schema-derived model output inside the existing sanitized native capture.
    // Request/response framing and lifecycle remain the captured MSP protocol.
    await writeFile(recordingPath, JSON.stringify(recording).replaceAll('"PEBBLE"', JSON.stringify(JSON.stringify(value))));
  }
  beforeEach(async () => {
    const testDir = run.testDir(`fin-review-model-${randomUUID()}`);
    const bin = join(testDir, 'bin');
    const nativeHome = join(testDir, 'native-home');
    await Promise.all([bin, nativeHome].map(path => mkdir(path, { recursive: true })));
    const nativeConfig = join(nativeHome, 'config');
    await mkdir(join(nativeConfig, 'muse'), { recursive: true });
    await writeFile(join(nativeConfig, 'muse', 'auth.json'), JSON.stringify(buildMuseNativeAuth({
      access_token: 'synthetic-review-account-token', api_key: 'synthetic-review-inference-key',
      api_base_url: 'https://api.meta.ai/v1', obtained_via: 'device_code', mechanism: 'oauth',
    })), { mode: 0o600 });
    recordingPath = join(testDir, 'muse-playback.json');
    auditPath = join(testDir, 'muse-native-audit.json');
    recording = await readMuseLoginRecording();
    await nativeReply({ summary: 'No findings in the fixture change', findings: [] });
    const executablePath = await writeFinMuseExecutable({ binDir: bin, recordingPath, auditPath });
    panelReplyPath = join(testDir, 'panel-reply.json');
    nativeHoldPath = join(testDir, 'native-hold');
    panelAuditPath = join(testDir, 'panel-audit.jsonl');
    await writeFile(panelAuditPath, '');
    await writeFile(panelReplyPath, JSON.stringify(panelNativeReview));
    await writeFile(join(bin, 'roborev'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('--version')) console.log('roborev 0.1.0');
else {
  fs.appendFileSync(${JSON.stringify(panelAuditPath)}, JSON.stringify({ args, cwd: process.cwd(), dataDirectory: process.env.ROBOREV_DATA_DIR }) + '\\n');
  if (args[0] === 'review') console.log('Enqueued job 3');
  else if (args[0] === 'job' && args[1] === 'list') console.log('[{"id":3,"job_type":"synthesis"}]');
  else if (args[0] === 'job' && args[1] === 'show') console.log(fs.readFileSync(${JSON.stringify(panelReplyPath)}, 'utf8'));
  else if (args[0] === 'job' && args[1] === 'wait') {
    if (fs.existsSync(${JSON.stringify(nativeHoldPath)})) setInterval(() => {}, 1000);
    else process.exitCode = 1;
  }
}
`, { mode: 0o755 });
    sliceAuditPath = join(testDir, 'slice-audit.jsonl');
    await writeFile(sliceAuditPath, '');
    // Native 0.8.4 state files are the external process contract. Real host
    // storage, normalization, Actions and finding persistence remain in use.
    await writeFile(join(bin, 'clawpatch'), `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args.includes('--version')) console.log('0.8.4');
else {
  const state = args[args.indexOf('--state-dir') + 1];
  fs.appendFileSync(${JSON.stringify(sliceAuditPath)}, JSON.stringify({ args, state }) + '\\n');
  const save = (name, value) => { const file = path.join(state, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); };
  if (args[0] === 'init') { save('project.json', {}); console.log('{}'); }
  else if (args[0] === 'map') {
    for (const featureId of ['slice-a', 'slice-b']) save('features/' + featureId + '.json', { schemaVersion: 1, featureId, status: 'reviewed' });
    console.log('{}');
  } else if (args[0] === 'review' && fs.existsSync(${JSON.stringify(nativeHoldPath)})) {
    setInterval(() => {}, 1000);
  } else if (args[0] === 'review') {
    const runId = 'native-slices';
    const ids = ['slice-a', 'slice-b'];
    for (const [index, featureId] of ids.entries()) {
      console.error('clawpatch review feature-start index=' + (index + 1) + ' total=2 feature=' + featureId);
      save('findings/' + featureId + '.json', { schemaVersion: 1, findingId: featureId, featureId,
        title: 'Defect in ' + featureId, category: 'bug', severity: 'high', confidence: 'high',
        evidence: [{ path: 'README.md', startLine: 1, endLine: 1, symbol: featureId, quote: 'lost write' }],
        reasoning: 'The write in ' + featureId + ' is lost.', recommendation: 'Commit before returning.' });
      console.error('clawpatch review feature-done index=' + (index + 1) + ' total=2 feature=' + featureId);
    }
    save('runs/' + runId + '.json', { schemaVersion: 1, runId, status: 'completed', findingIds: ids, errors: [] });
    console.log(JSON.stringify({ run: runId, reviewed: 2, findings: 2 }));
  } else process.exitCode = 1;
}
`, { mode: 0o755 });
    deepSecAuditPath = join(testDir, 'deepsec-audit.jsonl');
    await writeFile(deepSecAuditPath, '');
    deepSecExecutablePath = join(bin, 'deepsec');
    await writeFile(deepSecExecutablePath, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('--version')) console.log('2.3.12');
else {
  fs.appendFileSync(${JSON.stringify(deepSecAuditPath)}, JSON.stringify({ args, dataRoot: process.env.DEEPSEC_DATA_ROOT }) + '\\n');
  if (args[0] === 'scan' && fs.existsSync(${JSON.stringify(nativeHoldPath)})) setInterval(() => {}, 1000);
  else if (args[0] === 'process') process.exitCode = 2;
  else if (args[0] === 'export') fs.writeFileSync(args[args.indexOf('--out') + 1], JSON.stringify([{
    title: 'Validate redirects', description: 'Reject an external redirect before returning.', severity: 'CRITICAL',
    metadata: { filePath: 'README.md', lineNumbers: [1] },
  }]));
}
`, { mode: 0o755 });
    const features = { ...process.env, HAPPIER_FEATURE_WORKFLOWS__ENABLED: '1', HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1' };
    const databaseUrl = process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
      ?? (postgres = await startDatabaseWorkbenchPostgres({ preloadStatistics: false })).homeDatabaseUrl;
    fixture = await startFinJourneyFixture({ testDir, dbProvider: 'postgres', requestObservation: {},
      serverEnv: { ...features, DATABASE_URL: databaseUrl } });
    owner = await fixture.createAccount('review-owner');
    machine = await fixture.enrollDaemon(owner, { prepareHome: async homeDir => {
      // Pinned npm dependencies execute their package bin, never a PATH shim.
      // Seed that native boundary in this fixture's private managed install.
      const command = resolveAgentCliManagedCommandPathForRuntime({
        id: 'dep.review-slices', title: 'Slice review', binaryName: 'clawpatch', sourcePreferenceDefault: 'managed-first',
        managedInstall: { kind: 'managed_package', packageName: 'clawpatch@0.8.4', binaryName: 'clawpatch' },
        manualInstallKind: 'none', manualInstallRecipes: {}, acceptsJavaScriptFileOverride: false,
      }, { processEnv: { ...process.env, HAPPIER_HOME_DIR: homeDir } });
      const packageDir = join(dirname(dirname(command)), 'workspace', 'node_modules', 'clawpatch');
      await mkdir(packageDir, { recursive: true });
      await writeFile(join(packageDir, 'package.json'), JSON.stringify({ name: 'clawpatch', version: '0.8.4', bin: { clawpatch: 'index.cjs' } }));
      await writeFile(join(packageDir, 'index.cjs'), await readFile(join(bin, 'clawpatch')));
    }, env: { ...features,
      HAPPIER_MUSE_PATH: executablePath, PATH: [bin, process.env.PATH].filter(Boolean).join(delimiter), MUSE_INSTALL_DIR: bin,
      HAPPIER_JS_RUNTIME_PATH: process.execPath,
      HOME: nativeHome, XDG_CONFIG_HOME: join(nativeHome, 'config'), XDG_DATA_HOME: join(nativeHome, 'data'),
      XDG_CACHE_HOME: join(nativeHome, 'cache'), CODEX_HOME: join(nativeHome, 'codex'),
    } });
    await initGitRepo({ repoDir: machine.workspaceDir });
    await writeFile(join(machine.workspaceDir, 'README.md'), 'Review fixture\n');
    execGit(machine.workspaceDir, ['add', 'README.md']);
    execGit(machine.workspaceDir, ['commit', '-m', 'test: review baseline']);
    await writeFile(join(machine.workspaceDir, 'README.md'), 'Review fixture with a change\n');
    ui = await connectUiPersonActionClient({ serverUrl: fixture!.actionServerApiUrl, accountSecret: owner.auth.accountSigningSeed });
    sourceSessionId = await createSourceSession();
    // The fixture observes daemon control readiness and this client awaits its
    // Account bootstrap. The public Action owns target availability admission.
  });
  afterEach(async () => {
    try { await ui?.close(); } finally {
      ui = undefined;
      try { await fixture?.stop(); } finally {
        fixture = undefined;
        await postgres?.stop();
        postgres = undefined;
      }
    }
  });
  async function execute(actionId: ActionId, input: unknown) {
    if (!ui) throw new Error('Review Action client is not mounted');
    return ui.executeConfirmed(actionId, input, { surface: 'ui', authority: 'present_user',
      actionCaller: { kind: 'host' }, serverId: ui.serverId, serverIdentityId: fixture!.serverId,
      executionRunTargetMachineId: machine.target.machineId,
      actionRequestId: randomUUID(), externalActionTarget: { kind: 'machine', machineId: machine.target.machineId,
      project: { machineId: machine.target.machineId, directory: machine.workspaceDir } } });
  }
  async function act(actionId: ActionId, input: unknown) {
    const result = await execute(actionId, input);
    expect(result.ok, `${actionId}: ${JSON.stringify(result)}`).toBe(true);
    if (!result.ok) throw new Error(`${actionId}: ${result.errorCode}`);
    return result.result;
  }
  it.each(['continue', 'converged'] as const)('J10 deferred Review keeps the selected model, then Check publishes %s', async verdict => {
    const started = WorkflowRunStartResultV1Schema.parse(await act('workflow.run.start', {
      runId: randomUUID(), executionTarget: { kind: 'detached_run' }, inputs: {
        reviewers: [{ kind: 'engine', engineId: 'muse', includeSessionTranscript: false }],
      },
      source: { kind: 'inline', definition: { version: 1,
        inputs: [{ name: 'reviewers', valueType: 'json', required: true }],
        defaults: { agentTarget: muse, permissionMode: 'read-only',
          modelSelection: { v: 1, ref: { agentTargetKey: 'agent:happier.agent.muse/muse', providerConnectionId: null, modelId }, updatedAt: 0 },
          sessionConfigOptionOverrides: { v: 1, updatedAt: 0, overrides: { reasoning_effort: { value: 'minimal', updatedAt: 0 } } } },
        blocks: [
          { kind: 'loop', id: 'panel', repetition: { kind: 'items', items: { kind: 'input', name: 'reviewers', path: [] },
            execution: 'sequential', failurePolicy: 'fail_stop' }, body: [
            { kind: 'action', id: 'review', actionId: 'review.start', input: {
              target: { kind: 'literal', value: { kind: 'detached' } }, instructions: { kind: 'literal', value: 'Review this fixture change.' },
              reviewers: { kind: 'list', items: [{ kind: 'item', field: 'value' }] },
              sourceSession: { kind: 'literal', value: { sessionId: sourceSessionId, serverId: ui!.serverId } },
              reviewCommentAuthorIntent: { kind: 'literal', value: 'open' },
            } },
          ] },
          { kind: 'wait', id: 'read-review', document: document('Review the findings before checking convergence') },
          { kind: 'step', id: 'check', execution: { conversation: { kind: 'fresh' } },
            document: document('Check convergence and return a verdict.'), input: [], result: { kind: 'json', schema: {
              type: 'object', additionalProperties: false, required: ['verdict'], properties: { verdict: { type: 'string', enum: ['continue', 'converged'] } },
            } } },
        ], finalOutput: { kind: 'result', producer: { blockId: 'check', scope: { kind: 'current' } }, path: [] },
      } },
    }));
    const runId = started.run.id;
    expect(await act('workflow.run.wait', { runId, conditions: ['attention'] }))
      .toMatchObject({ observation: 'needs_attention' });
    const held = WorkflowInvocationListResultV1Schema.parse(await act('workflow.run.invocations.list', { runId, includeContent: true }));
    const review = held.invocationDetails?.find(row => row.progress.invocationPath.blockId === 'review');
    expect(review, JSON.stringify(review?.progress.result))
      .toMatchObject({ index: { lifecycle: 'completed' }, progress: { result: {
        perEngineOutcome: [{ key: reviewReviewerIdForSelectionV1(0), runId: expect.any(String), outcome: 'completed' }],
      } } });
    const reviewResult = review?.progress.result;
    expect(reviewResult && typeof reviewResult === 'object' && !Array.isArray(reviewResult) && 'perEngineOutcome' in reviewResult
      ? reviewResult.perEngineOutcome : undefined).toHaveLength(1);
    // At this held boundary only the detached Review has run. Transcript Off
    // must neither fetch the source messages nor include them in native input.
    expect(fixture!.requestProxy!.count()).toBeGreaterThan(0);
    expect(fixture!.requestProxy!.count(request => request.method === 'GET'
      && request.path.split('?')[0] === `/v1/sessions/${sourceSessionId}/messages`))
      .toBe(0);
    // This is the native process's received selection, below every internal
    // Workflow/Review/default-selection owner implicated in 10e094ddb785.
    const nativeAudit = await readMuseMspProcessAudit(auditPath);
    expect(JSON.stringify(nativeAudit.turnInputs).includes(sourceClaim)).toBe(false);
    expect(nativeAudit.modelSelections)
      .toContainEqual({ providerId: 'meta', modelId: 'muse-spark-1.3-contributor' });
    expect(nativeAudit.commandTargets).toContainEqual(expect.objectContaining({
      method: 'session/setReasoningEffort', reasoningEffort: 'minimal',
    }));
    const gate = held.invocationDetails?.find(row => row.progress.invocationPath.blockId === 'read-review');
    if (!gate) throw new Error('Review did not reach its public approval boundary');
    await nativeReply({ verdict });
    await act('workflow.run.invocations.complete_review', { runId, invocation: { recordId: gate.index.id },
      expectedContentRevision: gate.index.contentRevision, mode: 'use_result' });
    expect(await act('workflow.run.wait', { runId, conditions: ['terminal'] }))
      .toMatchObject({ observation: 'terminal', run: { state: 'succeeded' }, result: { verdict } });
    const history = WorkflowInvocationListResultV1Schema.parse(await act('workflow.run.invocations.list', { runId, includeContent: true }));
    expect(history.invocationDetails?.find(row => row.progress.invocationPath.blockId === 'check'))
      .toMatchObject({ index: { lifecycle: 'completed' }, progress: { result: { verdict } } });
  });
  it.each(['complete', 'partial'] as const)('F5 saved Hunt preserves %s repository coverage outside the diff', async reviewOutcome => {
    // The unchanged file is deliberately absent from the worktree diff. Native
    // playback models the external reviewer; its received prompt proves scope.
    await writeFile(join(machine.workspaceDir, 'unchanged.ts'), 'export const unsafe = true;\n');
    execGit(machine.workspaceDir, ['add', 'unchanged.ts']);
    execGit(machine.workspaceDir, ['commit', '-m', 'test: unchanged Hunt target']);
    await nativeReply({ summary: 'An unchanged file needs a fix.', reviewOutcome, findings: [{
      id: 'outside-diff', title: 'Unsafe unchanged export', severity: 'high', category: 'security',
      filePath: 'unchanged.ts', startLine: 1, summary: 'Remove the unsafe export.',
    }] });
    const saved = WorkflowDefinitionCreateResultV1Schema.parse(await act('workflow.definition.create', {
      definitionId: randomUUID(), metadata: { title: 'Repository security Hunt' }, definition: REPOSITORY_REVIEW_WORKFLOW_V1,
    }));
    const started = WorkflowRunStartResultV1Schema.parse(await act('workflow.run.start', {
      runId: randomUUID(), executionTarget: { kind: 'detached_run' },
      source: { kind: 'saved', definitionId: saved.definitionId, revision: saved.revision },
      inputs: { cwd: machine.workspaceDir, instructions: 'Inspect security throughout this repository.',
        reviewers: [{ kind: 'engine', engineId: 'muse', modelId,
          sessionConfigOptionOverrides: { v: 1, updatedAt: 0,
            overrides: { reasoning_effort: { value: 'minimal', updatedAt: 0 } } } }],
      },
    }));
    const runId = started.run.id;
    expect(await act('workflow.run.wait', { runId, conditions: ['terminal'] }))
      .toMatchObject({ observation: 'terminal', run: { state: 'succeeded' } });
    const history = WorkflowInvocationListResultV1Schema.parse(await act('workflow.run.invocations.list', { runId, includeContent: true }));
    const review = history.invocationDetails?.find(row => row.progress.invocationPath.blockId === 'review');
    expect(review).toMatchObject({ index: { lifecycle: 'completed' }, progress: { result: {
      perEngineOutcome: [{ runId: expect.any(String), outcome: 'completed' }],
    } } });
    const terminal = ReviewStartTerminalValueV1Schema.parse(review?.progress.result);
    expect(terminal.perEngineOutcome).toMatchObject([{ reviewOutcome }]);
    expect(terminal.reviewRound?.reviewId).toEqual(expect.any(String));
    expect(terminal.commentIds).toHaveLength(1);
    const retained = ReviewGetResponseV1Schema.parse(await act('review.get', {
      reviewId: terminal.reviewRound?.reviewId,
    }));
    expect(retained.review).toMatchObject({ sourceKind: 'workflow', workflowId: saved.definitionId,
      state: reviewOutcome === 'partial' ? 'partial' : 'completed' });
    const runs = WorkflowRunListResultV1Schema.parse(await act('workflow.run.list', { sourceArtifactId: saved.definitionId }));
    expect(runs.runs.map(row => row.id)).toContain(runId);
    const audit = await readMuseMspProcessAudit(auditPath);
    expect(JSON.stringify(audit.turnInputs)).toContain('including unchanged and tracked files outside the current diff');
  });
  it('F5 saved Hunt stops native work and permits an explicit fresh retry in ordinary history', async () => {
    const captured = readMuseRecord(recording);
    if (!Array.isArray(captured.rows)) throw new Error('Muse capture lacks its native frames');
    // Model an admitted native turn that has not completed. The real host still
    // owns cancellation, run settlement and cleanup of the native process.
    await writeFile(recordingPath, JSON.stringify({ ...captured, rows: captured.rows.filter(row => {
      const method = readMuseRecord(readMuseRecord(row).message).method;
      return method !== 'turn/foregroundCompleted' && method !== 'turn/completed';
    }) }));
    const saved = WorkflowDefinitionCreateResultV1Schema.parse(await act('workflow.definition.create', {
      definitionId: randomUUID(), metadata: { title: 'Stoppable repository Hunt' }, definition: REPOSITORY_REVIEW_WORKFLOW_V1,
    }));
    const start = async () => WorkflowRunStartResultV1Schema.parse(await act('workflow.run.start', {
      runId: randomUUID(), executionTarget: { kind: 'detached_run' },
      source: { kind: 'saved', definitionId: saved.definitionId, revision: saved.revision },
      inputs: { cwd: machine.workspaceDir, instructions: 'Inspect the whole repository.',
        reviewers: [{ kind: 'engine', engineId: 'muse', modelId,
          sessionConfigOptionOverrides: { v: 1, updatedAt: 0,
            overrides: { reasoning_effort: { value: 'minimal', updatedAt: 0 } } } }],
      },
    }));
    const stopped = await start();
    const observation = new AbortController();
    try {
      await waitForMuseMspProcessAudit(auditPath, audit => audit.turnInputs.length > 0, { signal: observation.signal });
    } finally { observation.abort(); }
    const opened = WorkflowRunGetResultV1Schema.parse(await act('workflow.run.get', { runId: stopped.run.id }));
    await act('workflow.run.cancel', { runId: stopped.run.id, expectedRevision: opened.run.revision });
    expect(await act('workflow.run.wait', { runId: stopped.run.id, conditions: ['terminal'] }))
      .toMatchObject({ observation: 'terminal', run: { state: 'cancelled' } });
    const history = WorkflowInvocationListResultV1Schema.parse(await act('workflow.run.invocations.list', {
      runId: stopped.run.id, includeContent: true,
    }));
    const review = history.invocationDetails?.find(row => row.progress.invocationPath.blockId === 'review');
    expect(review?.index.lifecycle).toBe('cancelled');
    const execution = review?.progress.execution;
    const nativeRunId = execution?.kind === 'action' ? execution.awaitedRuns?.[0]?.runId : undefined;
    if (!nativeRunId) throw new Error('Stopped Hunt lacks its admitted native run');
    expect(ExecutionRunGetResponseSchema.parse(await act('execution.run.get', { runId: nativeRunId })))
      .toMatchObject({ run: { status: 'cancelled' } });
    await nativeReply({ summary: 'Completed the explicitly retried repository review.', findings: [] });
    const retried = await start();
    expect(await act('workflow.run.wait', { runId: retried.run.id, conditions: ['terminal'] }))
      .toMatchObject({ observation: 'terminal', run: { state: 'succeeded' } });
    const retryHistory = WorkflowInvocationListResultV1Schema.parse(await act('workflow.run.invocations.list', {
      runId: retried.run.id, includeContent: true,
    }));
    const retryTerminal = ReviewStartTerminalValueV1Schema.parse(retryHistory.invocationDetails
      ?.find(row => row.progress.invocationPath.blockId === 'review')?.progress.result);
    const retained = ReviewGetResponseV1Schema.parse(await act('review.get', {
      reviewId: retryTerminal.reviewRound?.reviewId,
    }));
    expect(retained.review).toMatchObject({ sourceKind: 'workflow', workflowId: saved.definitionId });
    const runs = WorkflowRunListResultV1Schema.parse(await act('workflow.run.list', { sourceArtifactId: saved.definitionId }));
    expect(runs.runs.map(row => row.id)).toEqual(expect.arrayContaining([stopped.run.id, retried.run.id]));
  });
  async function startNativeReview(engineId: string, extra: Readonly<{ comparisonId?: string; scope?: 'repository' }> = {},
    reviewer: Omit<ReviewEngineReviewerSelectionV1, 'kind' | 'engineId'> = {}) {
    const started = await act('review.start', { target: { kind: 'detached' },
      reviewers: [{ kind: 'engine', engineId, ...reviewer }],
      instructions: 'Review this fixture change.', reviewCommentAuthorIntent: 'open', ...extra });
    expect(started, `${engineId}: ${JSON.stringify(started)}`).toMatchObject({
      results: [{ key: reviewReviewerIdForSelectionV1(0), ok: true }],
    });
    if (!started || typeof started !== 'object' || !('results' in started) || !Array.isArray(started.results)) {
      throw new Error('Review start did not return engine results');
    }
    const engine: unknown = started.results[0];
    if (!engine || typeof engine !== 'object' || !('result' in engine)) throw new Error(`${engineId} did not start`);
    const { runId } = ExecutionRunStartResponseSchema.parse(engine.result);
    await act('execution.run.wait', { runId, condition: 'terminal' });
    return ExecutionRunGetResponseSchema.parse(await act('execution.run.get', { runId, includeStructured: true }));
  }
  async function createWriteEnabledReviewRole() {
    const roleId = randomUUID();
    await act('roles.create', { roleId, role: { ...BUILT_IN_ROLES_V1.reviewer,
      name: 'Native review with workspace writes', workspaceWrites: 'allow' } });
    return roleId;
  }
  async function stopNativeRound(firstRunId: string, audit: string, isWaiting: (args: string[]) => boolean) {
    await writeFile(nativeHoldPath, 'hold native process until Stop');
    const previousLines = (await readFile(audit, 'utf8')).trim().split('\n').length;
    const next = ReviewNativeNewRoundResultV1Schema.parse(await act(REVIEW_NEW_ROUND_ACTION_ID_V1, {
      runId: firstRunId, target: { kind: 'detached' },
    }));
    await waitFor(async () => (await readFile(audit, 'utf8')).trim().split('\n').slice(previousLines)
      .some(line => isWaiting((JSON.parse(line) as { args: string[] }).args)),
    { failFast: true, context: 'New round reaches held native process before Stop' });
    await act('execution.run.stop', { runId: next.runId });
    await act('execution.run.wait', { runId: next.runId, condition: 'terminal' });
    expect(ExecutionRunGetResponseSchema.parse(await act('execution.run.get', { runId: next.runId })))
      .toMatchObject({ run: { status: 'cancelled' } });
  }
  it('F3 DeepSec retains exported partial audit findings with an explicitly write-enabled Role through public Actions, New round and Stop', async () => {
    const profileId = 'happier.review.deepsec/repository-security-audit';
    const roster = ReviewEngineInventorySchema.parse(await act('review.engines.list', { sessionId: null }));
    const profileSourceCustody = roster.items.find(item => item.engineId === 'deepsec')?.profileSourceCustody;
    if (!profileSourceCustody) throw new Error('DeepSec source custody is unavailable');
    const inventory = ReviewEngineInventorySchema.parse(await act('review.engines.list', {
      sessionId: null, scope: 'repository', profileSelections: [{ engineId: 'deepsec', profileId, profileSourceCustody }],
    }));
    const profile = inventory.selectionItems?.find(item => item.engineId === 'deepsec' && item.profileId === profileId);
    if (!profile?.profileSourceCustody) throw new Error('DeepSec audit profile is unavailable');
    let result = await startNativeReview('deepsec', { scope: 'repository' }, {
      roleId: await createWriteEnabledReviewRole(), profileId, profileSourceCustody: profile.profileSourceCustody,
      options: { confirmedCostWarning: true, preferredExecutablePath: deepSecExecutablePath },
    });
    const firstRunId = result.run.runId;
    const reviewId = result.run.display?.groupId;
    expect(reviewId).toBeTruthy();
    let originalId: string | undefined;
    for (const round of [1, 2]) {
      if (round === 2) {
        const next = ReviewNativeNewRoundResultV1Schema.parse(await act(REVIEW_NEW_ROUND_ACTION_ID_V1, {
          runId: firstRunId, target: { kind: 'detached' },
        }));
        expect(next.reviewRound).toEqual({ reviewId, roundOrdinal: 2 });
        await act('execution.run.wait', { runId: next.runId, condition: 'terminal' });
        result = ExecutionRunGetResponseSchema.parse(await act('execution.run.get', { runId: next.runId, includeStructured: true }));
      }
      expect(result, JSON.stringify(result)).toMatchObject({ run: { status: 'succeeded' }, reviewFindings: {
        reviewOutcome: 'partial', findings: [{ filePath: 'README.md', severity: 'blocker', startLine: 1 }],
      } });
      const persisted = ReviewCommentListResponseV1Schema.parse(await act('reviews.comments.list', { reviewId }));
      expect(persisted.items).toHaveLength(1);
      if (round === 1) originalId = persisted.items[0]?.id;
      else expect(persisted.items[0]?.id).toBe(originalId);
      expect(persisted.items[0]?.author).toEqual({ kind: 'executionRun', agentId: 'deepsec', runId: firstRunId });
      expect(persisted.items[0]?.appearances).toEqual(expect.arrayContaining([
        expect.objectContaining({ roundOrdinal: round, runId: result.run.runId }),
      ]));
      expect(ReviewGetResponseV1Schema.parse(await act('review.get', { reviewId })).review)
        .toMatchObject({ state: 'partial', currentRoundOrdinal: round, counts: { total: 1 } });
    }
    const commands: { args: string[]; dataRoot: string }[] = (await readFile(deepSecAuditPath, 'utf8'))
      .trim().split('\n').map(line => JSON.parse(line));
    expect(commands.map(command => command.args[0])).toEqual(['scan', 'process', 'export', 'scan', 'process', 'export']);
    for (const start of [0, 3]) {
      expect(new Set(commands.slice(start, start + 3).map(command => command.dataRoot)).size).toBe(1);
      expect(commands[start]?.dataRoot).toBeTruthy();
    }
    await stopNativeRound(firstRunId, deepSecAuditPath, args => args[0] === 'scan');
  });
  it('F4 native slices preserve distinct evidence and findings through public Actions, New round and Stop', async () => {
    let result = await startNativeReview('slices', { scope: 'repository' });
    const firstRunId = result.run.runId;
    const reviewId = result.run.display?.groupId;
    let originalIds: string[] = [];
    for (const round of [1, 2]) {
      if (round === 2) {
        const next = ReviewNativeNewRoundResultV1Schema.parse(await act(REVIEW_NEW_ROUND_ACTION_ID_V1, {
          runId: firstRunId, target: { kind: 'detached' },
        }));
        expect(next.reviewRound).toEqual({ reviewId, roundOrdinal: 2 });
        await act('execution.run.wait', { runId: next.runId, condition: 'terminal' });
        result = ExecutionRunGetResponseSchema.parse(await act('execution.run.get', { runId: next.runId, includeStructured: true }));
      }
      expect(result, JSON.stringify(result)).toMatchObject({ run: { status: 'succeeded' }, reviewFindings: {
        reviewOutcome: 'complete', findings: [
          { extensions: { 'happier.review.slices': { featureId: 'slice-a' } } },
          { extensions: { 'happier.review.slices': { featureId: 'slice-b' } } },
        ],
      } });
      const persisted = ReviewCommentListResponseV1Schema.parse(await act('reviews.comments.list', { reviewId }));
      expect(persisted.items).toHaveLength(2);
      if (round === 1) originalIds = persisted.items.map(item => item.id).sort();
      else expect(persisted.items.map(item => item.id).sort()).toEqual(originalIds);
      for (const item of persisted.items) {
        expect(item.author).toEqual({ kind: 'executionRun', agentId: 'slices', runId: firstRunId });
        expect(item.appearances).toEqual(expect.arrayContaining([expect.objectContaining({ roundOrdinal: round, runId: result.run.runId })]));
      }
      expect(ReviewGetResponseV1Schema.parse(await act('review.get', { reviewId })).review)
        .toMatchObject({ state: 'completed', currentRoundOrdinal: round, counts: { total: 2 } });
    }
    const commands: { args: string[]; state: string }[] = (await readFile(sliceAuditPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(commands.filter(command => command.args[0] === 'review')).toHaveLength(2);
    expect(new Set(commands.map(command => command.state)).size).toBe(1);
    expect(commands[0]?.state.startsWith(machine.workspaceDir)).toBe(false);
    await stopNativeRound(firstRunId, sliceAuditPath, args => args[0] === 'review');
  });
  it('F4 native panel with an explicitly write-enabled Role preserves a failed member and substantive evidence through public Actions, New round and Stop', async () => {
    const panelRecord = structuredClone(panelNativeReview);
    panelRecord.panel.members[1]!.status = 'failed';
    await writeFile(panelReplyPath, JSON.stringify(panelRecord));
    execGit(machine.workspaceDir, ['add', 'README.md']);
    execGit(machine.workspaceDir, ['commit', '-m', 'test: native panel committed subject']);
    const captured = ScmComparisonCaptureOutputSchema.parse(await act('scm.diffSummary.capture', {
      cwd: machine.workspaceDir, source: { kind: 'commit', commit: 'HEAD' },
    }));
    expect(captured.success).toBe(true);
    if (!captured.success) throw new Error(captured.errorCode);
    let result = await startNativeReview('panels', { comparisonId: captured.comparison.id }, {
      roleId: await createWriteEnabledReviewRole(),
    });
    const firstRunId = result.run.runId;
    const reviewId = result.run.display?.groupId;
    let firstCommentId: string | undefined;
    for (const round of [1, 2]) {
      if (round === 2) {
        const next = ReviewNativeNewRoundResultV1Schema.parse(await act(REVIEW_NEW_ROUND_ACTION_ID_V1, {
          runId: firstRunId, target: { kind: 'detached' },
        }));
        expect(next.runId).not.toBe(firstRunId);
        expect(next.reviewRound).toEqual({ reviewId, roundOrdinal: 2 });
        await act('execution.run.wait', { runId: next.runId, condition: 'terminal' });
        result = ExecutionRunGetResponseSchema.parse(await act('execution.run.get', { runId: next.runId, includeStructured: true }));
      }
      expect(result, JSON.stringify(result)).toMatchObject({ run: { status: 'succeeded' }, reviewFindings: { reviewOutcome: 'partial', findings: [{
        suggestion: 'Return the selected value.', extensions: { 'happier.review.panels': {
          verdict: 'fail', sources: [1], members: [{ status: 'done' }, { status: 'failed' }],
        } },
      }] } });
      const commands: unknown[] = (await readFile(panelAuditPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      expect(commands).toHaveLength(round * 6);
      expect(commands.at(-1)).toMatchObject({ args: ['daemon', 'stop'] });
      expect(commands.filter(command => command && typeof command === 'object' && 'args' in command
        && Array.isArray(command.args) && command.args[0] === 'review')).toHaveLength(round);
      const persisted = ReviewCommentListResponseV1Schema.parse(await act('reviews.comments.list', { reviewId }));
      expect(persisted.items).toHaveLength(1);
      expect(persisted.items[0]?.author).toEqual({ kind: 'executionRun', agentId: 'panels', runId: firstRunId });
      if (round === 1) firstCommentId = persisted.items[0]!.id;
      else expect(persisted.items[0]?.id).toBe(firstCommentId);
      expect(persisted.items[0]?.appearances).toEqual(expect.arrayContaining([
        expect.objectContaining({ roundOrdinal: round, runId: result.run.runId }),
      ]));
      expect(ReviewGetResponseV1Schema.parse(await act('review.get', { reviewId })).review)
        .toMatchObject({ state: 'partial', currentRoundOrdinal: round, counts: { total: 1 } });
    }
    await stopNativeRound(firstRunId, panelAuditPath, args => args[0] === 'job' && args[1] === 'wait');
    const stoppedCommands: { args: string[] }[] = (await readFile(panelAuditPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(stoppedCommands.at(-1)).toMatchObject({ args: ['daemon', 'stop'] });
  });
  it('F1 refuses an inaccessible source Session before launching a reviewer', async () => {
    const other = await fixture!.createAccount('source-owner');
    const inaccessibleSessionId = await createSourceSession(other);
    const denied = await execute('review.start', { target: { kind: 'detached' },
      sourceSession: { sessionId: inaccessibleSessionId, serverId: ui!.serverId },
      reviewers: [{ kind: 'engine', engineId: 'muse', includeSessionTranscript: true }],
      instructions: 'Review the actual workspace change.', reviewCommentAuthorIntent: 'open',
    });
    expect(denied).toMatchObject({ ok: false, errorCode: 'not_found' });
    const nativeAudit = await readMuseMspProcessAudit(auditPath).catch((error: unknown) => {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return undefined;
      throw error;
    });
    expect(nativeAudit?.turnInputs ?? []).toHaveLength(0);
  });
});
