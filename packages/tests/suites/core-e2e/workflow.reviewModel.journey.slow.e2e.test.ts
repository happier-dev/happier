import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { connectUiPersonActionClient } from '@happier-tests/ui-action-client';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { reviewReviewerIdForSelectionV1 } from '@happier-dev/protocol/reviews/reviewStart';
import { WorkflowDefinitionCreateResultV1Schema, WorkflowInvocationListResultV1Schema, WorkflowRunGetResultV1Schema, WorkflowRunListResultV1Schema, WorkflowRunStartResultV1Schema } from '@happier-dev/protocol/workflows/actionsV1';
import { readMuseLoginRecording, readMuseMspProcessAudit, waitForMuseMspProcessAudit } from '../../../plugins/muse/src/agent/testkit/mspProcess';
import { REPOSITORY_REVIEW_WORKFLOW_V1 } from '@happier-dev/protocol/workflows/builtins/repositoryReview';
import { ReviewStartTerminalValueV1Schema } from '@happier-dev/protocol/actions/specs/executionRunCompletion';
import { ReviewGetResponseV1Schema } from '@happier-dev/protocol/reviews/reviewListV1';
import { ExecutionRunGetResponseSchema } from '@happier-dev/protocol/execution/runs/responseSchemas';
import { readMuseRecord } from '../../../plugins/muse/src/agent/nativeInput';
import { buildMuseNativeAuth } from '../../../plugins/muse/src/connectedAccounts/nativeAuth';
import { startDatabaseWorkbenchPostgres } from '../../src/testkit/process/databaseWorkbenchPostgres';
import { startFinJourneyFixture, type FinJourneyFixture } from '../../src/testkit/finJourney';
import { writeFinMuseExecutable } from '../../src/testkit/finMuse';
import { createRunDirs } from '../../src/testkit/runDir';
import { execGit, initGitRepo } from '../../src/testkit/uiE2e/gitRepoFixtures';

const run = createRunDirs({ runLabel: 'core' });
const muse = { kind: 'agent', identity: { pluginId: 'happier.agent.muse', localId: 'muse' } } as const;
const modelId = 'meta/muse-spark-1.3-contributor';
const document = (text: string) => ({ text, references: [], attachments: [] });

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
    const features = { ...process.env, HAPPIER_FEATURE_WORKFLOWS__ENABLED: '1', HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1' };
    const databaseUrl = process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
      ?? (postgres = await startDatabaseWorkbenchPostgres({ preloadStatistics: false })).homeDatabaseUrl;
    fixture = await startFinJourneyFixture({ testDir, dbProvider: 'postgres',
      serverEnv: { ...features, DATABASE_URL: databaseUrl } });
    owner = await fixture.createAccount('review-owner');
    machine = await fixture.enrollDaemon(owner, { env: { ...features,
      HAPPIER_MUSE_PATH: executablePath, PATH: [bin, process.env.PATH].filter(Boolean).join(delimiter), MUSE_INSTALL_DIR: bin,
      HOME: nativeHome, XDG_CONFIG_HOME: join(nativeHome, 'config'), XDG_DATA_HOME: join(nativeHome, 'data'),
      XDG_CACHE_HOME: join(nativeHome, 'cache'), CODEX_HOME: join(nativeHome, 'codex'),
    } });
    await initGitRepo({ repoDir: machine.workspaceDir });
    await writeFile(join(machine.workspaceDir, 'README.md'), 'Review fixture\n');
    execGit(machine.workspaceDir, ['add', 'README.md']);
    execGit(machine.workspaceDir, ['commit', '-m', 'test: review baseline']);
    await writeFile(join(machine.workspaceDir, 'README.md'), 'Review fixture with a change\n');
    ui = await connectUiPersonActionClient({ serverUrl: fixture!.actionServerApiUrl, accountSecret: owner.auth.accountSigningSeed });
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
  async function act(actionId: ActionId, input: unknown) {
    if (!ui) throw new Error('Review Action client is not mounted');
    const result = await ui.executeConfirmed(actionId, input, { surface: 'ui', authority: 'present_user',
      actionCaller: { kind: 'host' }, serverId: ui.serverId, serverIdentityId: fixture!.serverId,
      executionRunTargetMachineId: machine.target.machineId,
      actionRequestId: randomUUID(), externalActionTarget: { kind: 'machine', machineId: machine.target.machineId,
      project: { machineId: machine.target.machineId, directory: machine.workspaceDir } } });
    expect(result.ok, `${actionId}: ${JSON.stringify(result)}`).toBe(true);
    if (!result.ok) throw new Error(`${actionId}: ${result.errorCode}`);
    return result.result;
  }
  it.each(['continue', 'converged'] as const)('J10 deferred Review keeps the selected model, then Check publishes %s', async verdict => {
    const started = WorkflowRunStartResultV1Schema.parse(await act('workflow.run.start', {
      runId: randomUUID(), executionTarget: { kind: 'detached_run' }, inputs: { engines: ['muse'] },
      source: { kind: 'inline', definition: { version: 1,
        inputs: [{ name: 'engines', valueType: 'json', required: true }],
        defaults: { agentTarget: muse, permissionMode: 'read-only',
          modelSelection: { v: 1, ref: { agentTargetKey: 'agent:happier.agent.muse/muse', providerConnectionId: null, modelId }, updatedAt: 0 },
          sessionConfigOptionOverrides: { v: 1, updatedAt: 0, overrides: { reasoning_effort: { value: 'minimal', updatedAt: 0 } } } },
        blocks: [
          { kind: 'loop', id: 'panel', repetition: { kind: 'items', items: { kind: 'input', name: 'engines', path: [] },
            execution: 'sequential', failurePolicy: 'fail_stop' }, body: [
            { kind: 'action', id: 'review', actionId: 'review.start', input: {
              target: { kind: 'literal', value: { kind: 'detached' } }, instructions: { kind: 'literal', value: 'Review this fixture change.' },
              engineIds: { kind: 'list', items: [{ kind: 'item', field: 'value' }] },
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
    // This is the native process's received selection, below every internal
    // Workflow/Review/default-selection owner implicated in 10e094ddb785.
    const nativeAudit = await readMuseMspProcessAudit(auditPath);
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
});
