import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { connectUiPersonActionClient } from '@happier-tests/ui-action-client';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { WorkflowInvocationListResultV1Schema, WorkflowRunStartResultV1Schema } from '@happier-dev/protocol/workflows/actionsV1';
import { readMuseLoginRecording, readMuseMspProcessAudit } from '../../../plugins/muse/src/agent/testkit/mspProcess';
import { startFinJourneyFixture, type FinJourneyFixture } from '../../src/testkit/finJourney';
import { writeFinMuseExecutable } from '../../src/testkit/finMuse';
import { createRunDirs } from '../../src/testkit/runDir';
import { execGit, initGitRepo } from '../../src/testkit/uiE2e/gitRepoFixtures';

const run = createRunDirs({ runLabel: 'core' });
const muse = { kind: 'agent', identity: { pluginId: 'happier.agent.muse', localId: 'muse' } } as const;
const modelId = 'meta/muse-spark-1.3-contributor';
const document = (text: string) => ({ text, references: [], attachments: [] });

// Public Action -> encrypted Home/SQLite -> daemon -> retained Review and Check
// executions -> real Muse adapter/stdio. Only the native executable is playback.
describe('FIN selected Muse Review and convergence through public Actions', () => {
  let fixture: FinJourneyFixture | undefined;
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
    recordingPath = join(testDir, 'muse-playback.json');
    auditPath = join(testDir, 'muse-native-audit.json');
    recording = await readMuseLoginRecording();
    await nativeReply({ summary: 'No findings in the fixture change', findings: [] });
    const executablePath = await writeFinMuseExecutable({ binDir: bin, recordingPath, auditPath });
    const features = { ...process.env, HAPPIER_FEATURE_WORKFLOWS__ENABLED: '1', HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1' };
    fixture = await startFinJourneyFixture({ testDir, serverEnv: features });
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
  afterEach(async () => { try { await ui?.close(); } finally { ui = undefined; await fixture?.stop(); fixture = undefined; } });
  async function act(actionId: ActionId, input: unknown) {
    if (!ui) throw new Error('Review Action client is not mounted');
    const result = await ui.executeConfirmed(actionId, input, { surface: 'ui', authority: 'present_user',
      actionCaller: { kind: 'host' }, serverId: ui.serverId, serverIdentityId: fixture!.serverId,
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
        perEngineOutcome: [{ key: 'muse', runId: expect.any(String), outcome: 'completed' }],
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
});
