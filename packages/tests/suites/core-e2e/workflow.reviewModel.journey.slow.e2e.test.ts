import { randomBytes, randomUUID } from 'node:crypto';
import { watch } from 'node:fs';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, delimiter, dirname, join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ensureManagedJavaScriptRuntimeCommand, managedJavaScriptRuntimeBinPath, resolveAgentCliManagedCommandPathForRuntime } from '@happier-dev/cli-common/agents';
import { connectUiPersonActionClient } from '@happier-tests/ui-action-client';
import { REVIEW_NEW_ROUND_ACTION_ID_V1, type ActionId } from '@happier-dev/protocol/actions/actionIds';
import { EXTERNAL_ACTION_HTTP_BODY_HEADER_V1, EXTERNAL_ACTION_HTTP_READ_BODY_MARKER_V1 } from '@happier-dev/protocol/actions/externalActionHttpTransportV1';
import { reviewReviewerIdForSelectionV1, type ReviewEngineReviewerSelectionV1 } from '@happier-dev/protocol/reviews/reviewStart';
import { sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol';
import { WorkflowDefinitionCreateResultV1Schema, WorkflowInvocationListResultV1Schema, WorkflowRunGetResultV1Schema, WorkflowRunListResultV1Schema, WorkflowRunStartResultV1Schema } from '@happier-dev/protocol/workflows/actionsV1';
import { REPOSITORY_REVIEW_WORKFLOW_V1 } from '@happier-dev/protocol/workflows/builtins/repositoryReview';
import { WorkflowTriggerWriteResultV1Schema } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import { AutomationV3RunMutationResponseSchema } from '@happier-dev/protocol/automations/automationApiV3';
import { readReviewWorkflowStartActionResultV1, ReviewStartTerminalValueV1Schema } from '@happier-dev/protocol/actions/specs/executionRunCompletion';
import { ReviewEngineInventorySchema } from '@happier-dev/protocol/reviews/reviewEngines';
import { ReviewGetResponseV1Schema, ReviewListResponseV1Schema } from '@happier-dev/protocol/reviews/reviewListV1';
import { ReviewNativeNewRoundResultV1Schema } from '@happier-dev/protocol/reviews/reviewRoundActionsV1';
import { BUILT_IN_ROLES_V1 } from '@happier-dev/protocol/prompts/roles/builtInRolesV1';
import { ExecutionRunGetResponseSchema, ExecutionRunStartResponseSchema } from '@happier-dev/protocol/execution/runs/responseSchemas';
import { ScmComparisonCaptureOutputSchema } from '@happier-dev/protocol/scm/diffSummary';
import { SessionSpawnNewActionResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { normalizeExecutableParticipantSelectionV1 } from '@happier-dev/protocol/discussions/executableParticipants';
import { ReviewHumanStateV1Schema } from '@happier-dev/protocol/reviews/reviewHumanV1';
import { REVIEW_HUMAN_ACTION_IDS_V1 } from '@happier-dev/protocol/actions/actionIdsReviewHumanV1';
import { readAccountIdFromToken } from '../../../../apps/cli/src/cloud/decodeJwtPayload';
import { ReviewCommentListResponseV1Schema } from '@happier-dev/protocol/reviews/comments/actions';
import panelNativeReview from '../../../plugins/review-panels/src/agent/reviews/fixtures/selected-review.json';
import { readMuseLoginRecording, readMuseMspProcessAudit, waitForMuseMspProcessAudit } from '../../../plugins/muse/src/agent/testkit/mspProcess';
import { readMuseRecord } from '../../../plugins/muse/src/agent/nativeInput';
import { buildMuseNativeAuth } from '../../../plugins/muse/src/connectedAccounts/nativeAuth';
import { startFinJourneyFixture, type FinJourneyFixture } from '../../src/testkit/finJourney';
import { writeFinMuseExecutable } from '../../src/testkit/finMuse';
import { createRunDirs } from '../../src/testkit/runDir';
import { waitFor } from '../../src/testkit/timing';
import { startDatabaseWorkbenchPostgres } from '../../src/testkit/process/databaseWorkbenchPostgres';
import { encryptDataKeyBase64 } from '../../src/testkit/rpcCrypto';
import { postEncryptedSessionMessage } from '../../src/testkit/memoryRpc';
import { createSessionWithCiphertexts } from '../../src/testkit/sessions';
import { execGit, initGitRepo } from '../../src/testkit/uiE2e/gitRepoFixtures';
import { repoRootDir } from '../../src/testkit/paths';

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
  let codeRabbitReplyPath: string;
  let sourceSessionDataKey: Uint8Array;
  let codeRabbitAuditPath: string;
  let panelReplyPath: string;
  let panelAuditPath: string;
  let deepSecAuditPath: string;
  let deepSecExecutablePath: string;
  let sliceAuditPath: string;
  let nativeHoldPath: string;
  let managedRuntimeDirectory: string;
  beforeAll(async () => {
    // Provision once, then copy the complete native runtime layout into each
    // installation. Authoring resolves the wrapper in that installation's root.
    const runtimeRoot = join(run.runDir, 'managed-runtime');
    const command = await ensureManagedJavaScriptRuntimeCommand({ ...process.env,
      HAPPIER_HOME_DIR: runtimeRoot, HAPPIER_MANAGED_TOOLS_ROOT: join(runtimeRoot, 'tools'),
      HAPPIER_JS_RUNTIME_PATH: undefined, HAPPIER_MANAGED_NODE_BIN: undefined, HAPPIER_NODE_PATH: undefined,
    });
    if (!command) throw new Error('Review fixture managed JavaScript runtime unavailable');
    managedRuntimeDirectory = dirname(dirname(command));
  }, 0);
  async function createSourceSession(account = owner) {
    // Paired-device credentials open a Session DEK, never content encrypted
    // directly with the Account recovery secret.
    const dataKey = randomBytes(32);
    const source = await createSessionWithCiphertexts({ baseUrl: fixture!.server.baseUrl, token: account.auth.token,
      metadataCiphertextBase64: encryptDataKeyBase64({ path: machine.workspaceDir }, dataKey),
      dataEncryptionKeyBase64: Buffer.from(sealEncryptedDataKeyEnvelopeV1({ dataKey,
        recipientPublicKey: account.credentials.encryption.publicKey, randomBytes })).toString('base64'),
    });
    await postEncryptedSessionMessage({ baseUrl: fixture!.server.baseUrl, token: account.auth.token,
      sessionId: source.sessionId, secret: dataKey, encryptionVariant: 'dataKey', messageRole: 'user',
      payload: { role: 'user', content: { type: 'text', text: sourceClaim } },
    });
    return { sessionId: source.sessionId, dataKey };
  }
  async function nativeReply(value: unknown) {
    // Schema-derived model output inside the existing sanitized native capture.
    // Request/response framing and lifecycle remain the captured MSP protocol.
    await writeFile(recordingPath, JSON.stringify(recording).replaceAll('"PEBBLE"', JSON.stringify(JSON.stringify(value))));
  }
  beforeEach(async () => {
    const testDir = run.testDir(`fin-review-model-${randomUUID()}`);
    const bin = join(testDir, 'bin');
    const managedToolsRoot = join(testDir, 'managed-tools');
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
    codeRabbitReplyPath = join(testDir, 'coderabbit-reply.json');
    codeRabbitAuditPath = join(testDir, 'coderabbit-audit.jsonl');
    nativeHoldPath = join(testDir, 'native-hold');
    await writeFile(codeRabbitAuditPath, '');
    await writeFile(codeRabbitReplyPath, JSON.stringify({ events: [{ type: 'complete', status: 'review_completed', findings: 0 }], exitCode: 0 }));
    // The native executable is the only substituted CodeRabbit boundary. Its
    // on-disk audit distinguishes a refused launch from a clean empty review.
    await writeFile(join(bin, 'coderabbit'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('--version')) console.log('CodeRabbit CLI 0.9.5');
else if (args[0] === 'auth') console.log(JSON.stringify({ type: 'status', phase: 'auth', authenticated: true }));
else if (args[0] === 'review') {
  fs.appendFileSync(${JSON.stringify(codeRabbitAuditPath)}, JSON.stringify({ args, cwd: process.cwd() }) + '\\n');
  const reply = JSON.parse(fs.readFileSync(${JSON.stringify(codeRabbitReplyPath)}, 'utf8'));
  if (fs.existsSync(${JSON.stringify(nativeHoldPath)})) setInterval(() => {}, 1000);
  else {
    for (const event of reply.events) console.log(JSON.stringify(event));
    process.exitCode = reply.exitCode;
  }
} else process.exitCode = 1;
`, { mode: 0o755 });
    panelReplyPath = join(testDir, 'panel-reply.json');
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
    const runId = 'native-clawpatch';
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
  const files = args.includes('--files-from') ? fs.readFileSync(args[args.indexOf('--files-from') + 1], 'utf8').trim().split('\\n') : undefined;
  fs.appendFileSync(${JSON.stringify(deepSecAuditPath)}, JSON.stringify({ args, dataRoot: process.env.DEEPSEC_DATA_ROOT,
    files: files?.map(file => ({ path: file, contents: fs.readFileSync(file, 'utf8') })) }) + '\\n');
  if (args[0] === 'scan' && fs.existsSync(${JSON.stringify(nativeHoldPath)})) setInterval(() => {}, 1000);
  else if (args[0] === 'process' && args.includes('--comment-out')) fs.writeFileSync(args[args.indexOf('--comment-out') + 1], '');
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
      // Authoring uses this installation's managed runtime path. Reuse the
      // genuine provisioned runtime within each case's private tool root.
      const runtimeEnv = { ...process.env, HAPPIER_HOME_DIR: homeDir, HAPPIER_MANAGED_TOOLS_ROOT: managedToolsRoot };
      await cp(managedRuntimeDirectory, dirname(dirname(managedJavaScriptRuntimeBinPath(runtimeEnv))), { recursive: true });
      // Pinned npm dependencies execute their package bin, never a PATH shim.
      // Seed that native boundary in this fixture's private managed install.
      const command = resolveAgentCliManagedCommandPathForRuntime({
        id: 'dep.review-clawpatch', title: 'clawpatch', binaryName: 'clawpatch', sourcePreferenceDefault: 'managed-first',
        managedInstall: { kind: 'managed_package', packageName: 'clawpatch@0.8.4', binaryName: 'clawpatch' },
        manualInstallKind: 'none', manualInstallRecipes: {}, acceptsJavaScriptFileOverride: false,
      }, { processEnv: { ...process.env, HAPPIER_HOME_DIR: homeDir, HAPPIER_MANAGED_TOOLS_ROOT: managedToolsRoot } });
      const packageDir = join(dirname(dirname(command)), 'workspace', 'node_modules', 'clawpatch');
      await mkdir(packageDir, { recursive: true });
      await writeFile(join(packageDir, 'package.json'), JSON.stringify({ name: 'clawpatch', version: '0.8.4', bin: { clawpatch: 'index.cjs' } }));
      await writeFile(join(packageDir, 'index.cjs'), await readFile(join(bin, 'clawpatch')));
    }, env: { ...features,
      HAPPIER_MUSE_PATH: executablePath, PATH: [bin, process.env.PATH].filter(Boolean).join(delimiter), MUSE_INSTALL_DIR: bin,
      // Keep the seeded package ready through the native runtime boundary;
      // setup would otherwise install a runtime and replace it with stock npm.
      HAPPIER_JS_RUNTIME_PATH: undefined,
      HAPPIER_MANAGED_NODE_BIN: undefined, HAPPIER_NODE_PATH: undefined,
      HAPPIER_MANAGED_TOOLS_ROOT: managedToolsRoot,
      HOME: nativeHome, XDG_CONFIG_HOME: join(nativeHome, 'config'), XDG_DATA_HOME: join(nativeHome, 'data'),
      XDG_CACHE_HOME: join(nativeHome, 'cache'), CODEX_HOME: join(nativeHome, 'codex'),
    } });
    await initGitRepo({ repoDir: machine.workspaceDir });
    await writeFile(join(machine.workspaceDir, 'README.md'), 'Review fixture\n');
    execGit(machine.workspaceDir, ['add', 'README.md']);
    execGit(machine.workspaceDir, ['commit', '-m', 'test: review baseline']);
    await writeFile(join(machine.workspaceDir, 'README.md'), 'Review fixture with a change\n');
    ui = await connectUiPersonActionClient({ serverUrl: fixture!.actionServerApiUrl, accountSecret: owner.auth.accountSigningSeed });
    const sourceSession = await createSourceSession();
    sourceSessionId = sourceSession.sessionId;
    sourceSessionDataKey = sourceSession.dataKey;
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
  async function readHuntReviewInputs(instructions: string) {
    const paths = (await readdir(dirname(auditPath))).filter(name => name.startsWith(`${basename(auditPath)}.`) && !name.endsWith('.tmp'));
    const audits = await Promise.all(paths.map(name => readMuseMspProcessAudit(join(dirname(auditPath), name))));
    // Match the authored input, as in F1, to exclude native startup/warmup turns.
    return audits.flatMap(audit => audit.turnInputs).filter(input => JSON.stringify(input).includes(instructions));
  }
  it.each(['complete', 'partial'] as const)('F5 saved Hunt preserves %s repository coverage outside the diff', async reviewOutcome => {
    await writeFinMuseExecutable({ binDir: join(dirname(auditPath), 'bin'), recordingPath, auditPath, perProcessAudit: true });
    const instructions = 'Inspect security throughout this repository.';
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
    const inputs = { cwd: machine.workspaceDir, instructions,
      reviewers: [{ kind: 'engine', engineId: 'muse', modelId,
        sessionConfigOptionOverrides: { v: 1, updatedAt: 0,
          overrides: { reasoning_effort: { value: 'minimal', updatedAt: 0 } } } }],
    };
    const scheduled = WorkflowTriggerWriteResultV1Schema.parse(await act('workflow.trigger.add', {
      workflow: saved.definitionId, inputs,
      project: { machineId: machine.target.machineId, directory: machine.workspaceDir },
      // An annual schedule stays dormant; Run now invokes its real occurrence
      // owner without waiting for a wall-clock tick or adding another scheduler.
      trigger: { kind: 'schedule', enabled: true,
        schedule: { kind: 'cron', scheduleExpr: '0 0 1 1 *', everyMs: null, timezone: 'UTC' } },
    }));
    const occurrence = AutomationV3RunMutationResponseSchema.parse(await act('workflow.trigger.run_now', {
      automationId: scheduled.set.automationId,
    }));
    expect(occurrence.run.automationId).toBe(scheduled.set.automationId);
    let runId: string | undefined;
    await waitFor(async () => {
      const history = WorkflowRunListResultV1Schema.parse(await act('workflow.run.list', {
        automationId: scheduled.set.automationId,
      }));
      runId = history.runs.find(run => run.id === occurrence.run.id)?.id;
      return runId !== undefined;
    }, { timeoutMs: 60_000, failFast: true, context: 'The saved Hunt schedule publishes its explicit occurrence' });
    if (!runId) throw new Error('The scheduled Hunt has no ordinary Workflow run');
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
    const reviewInputs = await readHuntReviewInputs(instructions);
    expect(reviewInputs).toHaveLength(1);
    expect(JSON.stringify(reviewInputs)).toContain('including unchanged and tracked files outside the current diff');
  });
  it('F5 saved Hunt stops native work and permits an explicit fresh retry in ordinary history', async () => {
    await writeFinMuseExecutable({ binDir: join(dirname(auditPath), 'bin'), recordingPath, auditPath, perProcessAudit: true });
    const instructions = 'Inspect the whole repository.';
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
      inputs: { cwd: machine.workspaceDir, instructions,
        reviewers: [{ kind: 'engine', engineId: 'muse', modelId,
          sessionConfigOptionOverrides: { v: 1, updatedAt: 0,
            overrides: { reasoning_effort: { value: 'minimal', updatedAt: 0 } } } }],
      },
    }));
    const stopped = await start();
    const observation = new AbortController();
    try {
      await waitForMuseMspProcessAudit(auditPath,
        audit => audit.turnInputs.some(input => JSON.stringify(input).includes(instructions)),
        { signal: observation.signal, perProcessAudit: true });
    } finally { observation.abort(); }
    const opened = WorkflowRunGetResultV1Schema.parse(await act('workflow.run.get', { runId: stopped.run.id }));
    await act('workflow.run.cancel', { runId: stopped.run.id, expectedRevision: opened.run.revision });
    expect(await act('workflow.run.wait', { runId: stopped.run.id, conditions: ['terminal'] }))
      .toMatchObject({ observation: 'terminal', run: { state: 'cancelled' } });
    const history = WorkflowInvocationListResultV1Schema.parse(await act('workflow.run.invocations.list', {
      runId: stopped.run.id, includeContent: true,
    }));
    const review = history.invocationDetails?.find(row => row.progress.invocationPath.blockId === 'review');
    const execution = review?.progress.execution;
    const nativeRunId = execution?.kind === 'action' ? execution.awaitedRuns?.[0]?.runId : undefined;
    if (!nativeRunId) throw new Error('Stopped Hunt lacks its admitted native run');
    // Workflow Cancel ends authored work before indexed recovery has necessarily
    // observed the native stop and settled the retained child invocation.
    await act('execution.run.wait', { runId: nativeRunId, condition: 'terminal' });
    expect(ExecutionRunGetResponseSchema.parse(await act('execution.run.get', { runId: nativeRunId })))
      .toMatchObject({ run: { status: 'cancelled' } });
    await waitFor(async () => {
      const settled = WorkflowInvocationListResultV1Schema.parse(await act('workflow.run.invocations.list', {
        runId: stopped.run.id, includeContent: true,
      }));
      const retained = settled.invocationDetails?.find(row => row.index.id === review?.index.id);
      if (retained?.index.lifecycle === 'cancelled') return true;
      if (retained?.index.lifecycle !== 'completed') return false;
      // Fanout completion retains each native outcome in its terminal value;
      // the Action itself can finish observing an already-cancelled reviewer.
      const terminal = ReviewStartTerminalValueV1Schema.safeParse(retained.progress.result);
      return terminal.success && terminal.data.perEngineOutcome.length === 1
        && terminal.data.perEngineOutcome[0]?.outcome === 'cancelled';
    }, { failFast: true, context: 'Stopped Hunt native work settles its retained Review invocation' });
    expect(await readHuntReviewInputs(instructions)).toHaveLength(1);
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
    expect(await readHuntReviewInputs(instructions)).toHaveLength(2);
  });
  async function startNativeReview(engineId: string, extra: Readonly<{ comparisonId?: string; scope?: 'repository'; changeType?: 'all' }> = {},
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
  async function stopNativeRound(firstRunId: string, audit: string, isWaiting: (args: string[]) => boolean, costConsent?: boolean) {
    await writeFile(nativeHoldPath, 'hold native process until Stop');
    const previousLines = (await readFile(audit, 'utf8')).trim().split('\n').length;
    const next = ReviewNativeNewRoundResultV1Schema.parse(await act(REVIEW_NEW_ROUND_ACTION_ID_V1, {
      runId: firstRunId, target: { kind: 'detached' }, ...(costConsent ? { costConsent: true } : {}),
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
          runId: firstRunId, target: { kind: 'detached' }, costConsent: true,
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
    await stopNativeRound(firstRunId, deepSecAuditPath, args => args[0] === 'scan', true);
  });
  it('D1 DeepSec admits live captured files and refuses dirty committed or moved HEAD subjects through public Actions', async () => {
    const installed = await act('plugins.install', { path: join(repoRootDir(), 'packages/plugins/review-deepsec'), dev: true });
    expect(installed, JSON.stringify(installed)).toMatchObject({ ok: true });
    const roster = ReviewEngineInventorySchema.parse(await act('review.engines.list', { sessionId: null }));
    const installedEngine = roster.items.find(item => item.engineId === 'happier.review.deepsec/deepsec');
    if (!installedEngine?.profileSourceCustody) throw new Error('Installed DeepSec source custody is unavailable');
    const inventory = ReviewEngineInventorySchema.parse(await act('review.engines.list', {
      sessionId: null, profileSelections: [{ engineId: installedEngine.engineId,
        profileId: 'happier.review.deepsec/review', profileSourceCustody: installedEngine.profileSourceCustody }],
    }));
    const selected = inventory.selectionItems?.find(item => item.engineId === installedEngine.engineId
      && item.profileId === 'happier.review.deepsec/review');
    if (!selected?.profileSourceCustody) throw new Error('Installed DeepSec review profile is unavailable');
    const reviewer = { roleId: await createWriteEnabledReviewRole(),
      profileId: selected.profileId, profileSourceCustody: selected.profileSourceCustody,
      options: { confirmedCostWarning: true, preferredExecutablePath: deepSecExecutablePath } };
    const working = ScmComparisonCaptureOutputSchema.parse(await act('scm.diffSummary.capture', {
      cwd: machine.workspaceDir, source: { kind: 'workingTree', area: 'both' },
    }));
    if (!working.success) throw new Error(working.errorCode);
    const workingResult = await startNativeReview(selected.engineId, { comparisonId: working.comparison.id }, reviewer);
    expect(workingResult, JSON.stringify({ engineId: selected.engineId, profileId: selected.profileId, error: workingResult.run.error }))
      .toMatchObject({ run: { status: 'succeeded' }, reviewFindings: { reviewOutcome: 'complete', findings: [] } });
    const commands = (await readFile(deepSecAuditPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as {
      args: string[]; files?: { path: string; contents: string }[];
    });
    expect(commands).toHaveLength(1);
    expect(commands[0]?.args).toEqual(expect.arrayContaining(['--files-from', '--no-ignore']));
    expect(commands[0]?.files).toEqual([{ path: 'README.md', contents: 'Review fixture with a change\n' }]);

    execGit(machine.workspaceDir, ['add', 'README.md']);
    execGit(machine.workspaceDir, ['commit', '-m', 'test: DeepSec captured review head']);
    const committed = ScmComparisonCaptureOutputSchema.parse(await act('scm.diffSummary.capture', {
      cwd: machine.workspaceDir, source: { kind: 'commit', commit: 'HEAD' },
    }));
    if (!committed.success) throw new Error(committed.errorCode);
    await writeFile(join(machine.workspaceDir, 'README.md'), 'Uncaptured tracked checkout edit\n');
    expect(await startNativeReview(selected.engineId, { comparisonId: committed.comparison.id }, reviewer))
      .toMatchObject({ run: { status: 'failed', error: { code: 'deepsec_execution_failed', message: expect.stringMatching(/clean tracked checkout/) } } });
    execGit(machine.workspaceDir, ['add', 'README.md']);
    execGit(machine.workspaceDir, ['commit', '-m', 'test: advance beyond DeepSec captured head']);
    expect(await startNativeReview(selected.engineId, { comparisonId: committed.comparison.id }, reviewer))
      .toMatchObject({ run: { status: 'failed', error: { code: 'deepsec_execution_failed', message: expect.stringMatching(/captured comparison.*live checkout/) } } });
    expect((await readFile(deepSecAuditPath, 'utf8')).trim().split('\n')).toHaveLength(1);
  });
  it('F2 CodeRabbit preserves findings through public Actions, New round and Stop and refuses a different captured head', async () => {
    // CodeRabbit's native uncommitted mode covers the whole working tree;
    // Review's default pending-only selector is an intentionally unsupported partial scope.
    const clean = await startNativeReview('coderabbit', { changeType: 'all' });
    expect(clean, JSON.stringify(clean)).toMatchObject({ run: { status: 'succeeded' }, reviewFindings: { reviewOutcome: 'complete', findings: [] } });
    const finding = { type: 'finding', severity: 'major', fileName: 'README.md', startLine: 1,
      title: 'A substantive fixture defect', comment: 'The changed path loses the write.', codegenInstructions: 'Commit the write before returning.' };
    await writeFile(codeRabbitReplyPath, JSON.stringify({ events: [finding,
      { type: 'complete', status: 'review_completed', findings: 1 }], exitCode: 0 }));
    const reviewed = await startNativeReview('coderabbit', { changeType: 'all' });
    expect(reviewed).toMatchObject({ run: { status: 'succeeded' }, reviewFindings: { reviewOutcome: 'complete', findings: [{
      filePath: 'README.md', severity: 'high', suggestion: 'Commit the write before returning.',
    }] } });
    const firstRunId = reviewed.run.runId;
    const reviewId = reviewed.run.display?.groupId;
    const initialComments = ReviewCommentListResponseV1Schema.parse(await act('reviews.comments.list', { reviewId }));
    expect(initialComments.items).toHaveLength(1);
    await writeFile(codeRabbitReplyPath, JSON.stringify({ events: [finding,
      { type: 'complete', status: 'review_completed', findings: 1, unreviewedFileCount: 1 }], exitCode: 0 }));
    const next = ReviewNativeNewRoundResultV1Schema.parse(await act(REVIEW_NEW_ROUND_ACTION_ID_V1, {
      runId: firstRunId, target: { kind: 'detached' },
    }));
    expect(next.runId).not.toBe(firstRunId);
    await act('execution.run.wait', { runId: next.runId, condition: 'terminal' });
    expect(ExecutionRunGetResponseSchema.parse(await act('execution.run.get', { runId: next.runId, includeStructured: true })))
      .toMatchObject({ run: { status: 'succeeded' },
      reviewFindings: { reviewOutcome: 'partial', findings: [{ filePath: 'README.md' }] } });
    const carried = ReviewCommentListResponseV1Schema.parse(await act('reviews.comments.list', { reviewId }));
    expect(carried.items).toHaveLength(1);
    expect(carried.items[0]).toMatchObject({ id: initialComments.items[0]?.id,
      author: { kind: 'executionRun', agentId: 'coderabbit', runId: firstRunId } });
    expect(carried.items[0]?.appearances).toEqual(expect.arrayContaining([
      expect.objectContaining({ roundOrdinal: 2, runId: next.runId }),
    ]));
    expect(ReviewGetResponseV1Schema.parse(await act('review.get', { reviewId })).review)
      .toMatchObject({ state: 'partial', currentRoundOrdinal: 2, counts: { total: 1 } });
    await writeFile(codeRabbitReplyPath, JSON.stringify({ events: [{ type: 'error', errorType: 'rate_limit' }], exitCode: 1 }));
    expect(await startNativeReview('coderabbit', { changeType: 'all' })).toMatchObject({ run: { status: 'failed', error: { code: 'coderabbit_rate_limit' } } });
    const commands = (await readFile(codeRabbitAuditPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as unknown);
    expect(commands).toHaveLength(4);
    expect(commands).toEqual(expect.arrayContaining([expect.objectContaining({ cwd: machine.workspaceDir,
      args: ['review', '--agent', '--dir', machine.workspaceDir, '--uncommitted'] })]));
    await stopNativeRound(firstRunId, codeRabbitAuditPath, args => args[0] === 'review');

    // Capture a committed subject, then advance checkout with a second defect.
    // Reviewing ambient HEAD would silently review a different set of changes.
    execGit(machine.workspaceDir, ['add', 'README.md']);
    execGit(machine.workspaceDir, ['commit', '-m', 'test: captured review head']);
    const captured = ScmComparisonCaptureOutputSchema.parse(await act('scm.diffSummary.capture', {
      cwd: machine.workspaceDir, source: { kind: 'commit', commit: 'HEAD' },
    }));
    expect(captured.success).toBe(true);
    if (!captured.success) throw new Error(captured.errorCode);
    await writeFile(join(machine.workspaceDir, 'outside-captured-head.ts'), 'export const secondDefect = true;\n');
    execGit(machine.workspaceDir, ['add', 'outside-captured-head.ts']);
    execGit(machine.workspaceDir, ['commit', '-m', 'test: outside captured review']);
    expect(await startNativeReview('coderabbit', { comparisonId: captured.comparison.id }))
      .toMatchObject({ run: { status: 'failed', error: { code: 'coderabbit_scope_unsupported' } } });
    expect((await readFile(codeRabbitAuditPath, 'utf8')).trim().split('\n')).toHaveLength(5);
  });
  it('F1 retains zero-finding, failed and cancelled Workflow Reviews through the ordinary Review reader', async () => {
    const outcomes = ['completed', 'failed', 'cancelled'] as const;
    const reviewIds = new Set<string>();
    for (const outcome of outcomes) {
      await writeFile(codeRabbitReplyPath, JSON.stringify({
        events: outcome === 'failed' ? [{ type: 'error', errorType: 'rate_limit' }]
          : [{ type: 'complete', status: 'review_completed', findings: 0 }],
        exitCode: outcome === 'failed' ? 1 : 0,
      }));
      if (outcome === 'cancelled') await writeFile(nativeHoldPath, 'hold native process until Workflow Cancel');
      const previousStarts = (await readFile(codeRabbitAuditPath, 'utf8')).trim().split('\n').filter(Boolean).length;
      const nativeStarted = Promise.withResolvers<void>();
      const nativeWatcher = watch(codeRabbitAuditPath, () => nativeStarted.resolve());
      nativeWatcher.once('error', nativeStarted.reject);
      const started = WorkflowRunStartResultV1Schema.parse(await act('workflow.run.start', {
        runId: randomUUID(), executionTarget: { kind: 'detached_run' },
        source: { kind: 'inline', definition: { version: 1, defaults: {}, blocks: [{
          kind: 'action', id: 'review', actionId: 'review.start', input: {
            target: { kind: 'literal', value: { kind: 'detached' } },
            cwd: { kind: 'literal', value: machine.workspaceDir },
            changeType: { kind: 'literal', value: 'all' },
            reviewers: { kind: 'literal', value: [{ kind: 'engine', engineId: 'coderabbit' }] },
            instructions: { kind: 'literal', value: 'Review this fixture change.' },
            reviewCommentAuthorIntent: { kind: 'literal', value: 'open' },
          },
        }], finalOutput: { kind: 'result', producer: { blockId: 'review', scope: { kind: 'current' } }, path: [] } } },
      }).catch(error => { nativeWatcher.close(); throw error; }));
      const terminal = act('workflow.run.wait', { runId: started.run.id, conditions: ['terminal'] });
      // Startup belongs to the Workflow lifetime. Observe the external process
      // for Cancel, while an early terminal failure reports its actual outcome.
      const startupOutcome = await Promise.race([nativeStarted.promise, terminal]).finally(() => nativeWatcher.close());
      expect((await readFile(codeRabbitAuditPath, 'utf8')).trim().split('\n').filter(Boolean).length,
        JSON.stringify(startupOutcome)).toBeGreaterThan(previousStarts);
      const admitted = ReviewListResponseV1Schema.parse(await act('reviews.list', {
        sourceKind: 'workflow', limit: outcomes.length,
      })).items.filter(review => review.workflowRunId === started.run.id);
      expect(admitted).toHaveLength(1);
      const review = admitted[0];
      if (!review) throw new Error('Workflow native Review has no addressable record');
      reviewIds.add(review.reviewId);
      if (outcome === 'cancelled') {
        expect(review).toMatchObject({ state: 'running', counts: { total: 0, needsDecision: 0 } });
        const running = WorkflowRunGetResultV1Schema.parse(await act('workflow.run.get', { runId: started.run.id }));
        await act('workflow.run.cancel', { runId: started.run.id, expectedRevision: running.run.revision });
      }
      expect(await terminal)
        .toMatchObject({ observation: 'terminal' });
      // Workflow Cancel and native cancellation settle separately; inspect the
      // durable Review through its ordinary reader, as the retained UI does.
      await waitFor(async () => ReviewGetResponseV1Schema.parse(await act('review.get', {
        reviewId: review.reviewId,
      })).review.state === outcome, { failFast: true, context: 'The retained Workflow Review settles its native outcome' });
      const retained = ReviewGetResponseV1Schema.parse(await act('review.get', { reviewId: review.reviewId }));
      expect(retained.review).toMatchObject({ reviewId: review.reviewId, sourceKind: 'workflow',
        workflowRunId: started.run.id, state: outcome, currentRoundOrdinal: 1,
        finishedAt: expect.any(Number), counts: { total: 0, needsDecision: 0 } });
      expect(ReviewCommentListResponseV1Schema.parse(await act('reviews.comments.list', { reviewId: review.reviewId })).items)
        .toEqual([]);
      expect(ReviewGetResponseV1Schema.parse(await act('review.get', { reviewId: review.reviewId })).review)
        .toEqual(retained.review);
      expect((await readFile(codeRabbitAuditPath, 'utf8')).trim().split('\n').filter(Boolean)).toHaveLength(previousStarts + 1);
    }
    expect(reviewIds.size).toBe(outcomes.length);
  });
  it('F4 native clawpatch preserves distinct evidence and findings through public Actions, New round and Stop', async () => {
    let result = await startNativeReview('clawpatch', { scope: 'repository' });
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
          { extensions: { 'happier.review.clawpatch': { featureId: 'slice-a' } } },
          { extensions: { 'happier.review.clawpatch': { featureId: 'slice-b' } } },
        ],
      } });
      const persisted = ReviewCommentListResponseV1Schema.parse(await act('reviews.comments.list', { reviewId }));
      expect(persisted.items).toHaveLength(2);
      if (round === 1) originalIds = persisted.items.map(item => item.id).sort();
      else expect(persisted.items.map(item => item.id).sort()).toEqual(originalIds);
      for (const item of persisted.items) {
        expect(item.author).toEqual({ kind: 'executionRun', agentId: 'clawpatch', runId: firstRunId });
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
  it('F4 native roborev with an explicitly write-enabled Role preserves a failed member and substantive evidence through public Actions, New round and Stop', async () => {
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
    let result = await startNativeReview('roborev', { comparisonId: captured.comparison.id }, {
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
        suggestion: 'Return the selected value.', extensions: { 'happier.review.roborev': {
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
      expect(persisted.items[0]?.author).toEqual({ kind: 'executionRun', agentId: 'roborev', runId: firstRunId });
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
  it('F1 reads once and delivers a transcript-only false test-success claim beside the captured diff to Agent, Session/bot and model reviewers', async () => {
    await writeFinMuseExecutable({ binDir: join(dirname(auditPath), 'bin'), recordingPath, auditPath, perProcessAudit: true });
    const baseline = 'export function charge(amount: number) { return amount; }\n';
    const broken = 'export function charge(amount: number) { return 0; }\n';
    await writeFile(join(machine.workspaceDir, 'billing.ts'), baseline);
    execGit(machine.workspaceDir, ['add', 'billing.ts']);
    execGit(machine.workspaceDir, ['commit', '-m', 'test: establish billing before transcript review']);
    await writeFile(join(machine.workspaceDir, 'billing.ts'), broken);
    const captured = ScmComparisonCaptureOutputSchema.parse(await act('scm.diffSummary.capture', {
      cwd: machine.workspaceDir, source: { kind: 'workingTree', area: 'both' },
    }));
    if (!captured.success) throw new Error(captured.errorCode);
    expect(captured.comparison.inventory.files).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'billing.ts' })]));
    const testSuccessClaim = 'All tests passed.';
    const skippedTests = 'I skipped the test command; no tests ran.';
    for (const message of [skippedTests, testSuccessClaim]) {
      await postEncryptedSessionMessage({ baseUrl: fixture!.server.baseUrl, token: owner.auth.token,
        sessionId: sourceSessionId, secret: sourceSessionDataKey, encryptionVariant: 'dataKey', messageRole: 'agent',
        payload: { role: 'agent', content: { type: 'acp', agentId: 'muse', data: { type: 'message', message } } },
      });
    }
    expect(JSON.stringify(captured.comparison)).not.toContain(testSuccessClaim);
    expect(baseline + broken).not.toContain(testSuccessClaim);
    const claimFinding = { id: 'source-claim', title: 'Test success is unsupported by the transcript',
      severity: 'medium', category: 'correctness', summary: sourceClaim,
      evidence: `${skippedTests} Then: ${testSuccessClaim}` };
    const diffFinding = { id: 'lost-charge', title: 'Billing drops the charge amount', severity: 'high', category: 'correctness',
      filePath: 'billing.ts', startLine: 1, summary: 'Returning zero discards every positive charge amount.', evidence: broken.trim() };
    // Model judgment is substituted only at the native executable. The admitted
    // evidence and both findings traverse real runtime and persistence owners.
    await nativeReply({ summary: 'A transcript-only test claim and a defect in the selected diff.',
      reviewOutcome: 'complete', findings: [claimFinding, diffFinding] });
    const launch = { executionTarget: machine.target, directory: { kind: 'path' as const, path: machine.workspaceDir },
      agentTarget: muse, permissionMode: 'read-only' as const,
      modelSelection: { v: 1 as const, ref: { agentTargetKey: 'agent:happier.agent.muse/muse', providerConnectionId: null, modelId }, updatedAt: 0 },
    };
    const session = SessionSpawnNewActionResultV1Schema.parse(await act('session.spawn_new', launch));
    if (session.type !== 'success') throw new Error('The Session reviewer did not open');
    const bot = normalizeExecutableParticipantSelectionV1({ kind: 'bot',
      session: { serverId: ui!.serverId, sessionId: session.sessionId } });
    if (!bot) throw new Error('The Bot display choice did not normalize to its Session');
    const started = await act('review.start', { target: { kind: 'detached' }, cwd: machine.workspaceDir,
      comparisonId: captured.comparison.id, selectedPaths: ['billing.ts'],
      sourceSession: { sessionId: sourceSessionId, serverId: ui!.serverId },
      instructions: 'Review the change and verify the source Session claim.', reviewCommentAuthorIntent: 'open',
      reviewers: [{ kind: 'engine', engineId: 'muse', modelId, includeSessionTranscript: true },
        { ...bot, includeSessionTranscript: true }, { kind: 'model', launch, includeSessionTranscript: true }],
    });
    const admitted = readReviewWorkflowStartActionResultV1(started);
    if (!admitted?.reviewRound) throw new Error('Review admission did not bind its Workflow and round');
    expect(await act('workflow.run.wait', { runId: admitted.workflow.runId, conditions: ['terminal'] }))
      .toMatchObject({ observation: 'terminal', run: { state: 'succeeded' } });
    // Signed logical GETs carry their proof frame as POST at the HTTP boundary.
    expect(fixture!.requestProxy!.count(request => (request.method === 'GET'
      || (request.method === 'POST' && request.headers[EXTERNAL_ACTION_HTTP_BODY_HEADER_V1] === EXTERNAL_ACTION_HTTP_READ_BODY_MARKER_V1))
      && request.path.split('?')[0] === `/v1/sessions/${sourceSessionId}/messages`)).toBe(1);
    const paths = (await readdir(dirname(auditPath))).filter(name => name.startsWith(`${basename(auditPath)}.`));
    const audits = await Promise.all(paths.map(name => readMuseMspProcessAudit(join(dirname(auditPath), name))));
    const received = audits.flatMap(audit => audit.turnInputs).filter(input => JSON.stringify(input).includes(sourceClaim));
    expect(received).toHaveLength(3);
    for (const input of received) {
      const ordinaryInput = JSON.stringify(input);
      expect(ordinaryInput).toContain('Session transcript (complete coverage)');
      expect(ordinaryInput).toContain(testSuccessClaim);
      expect(ordinaryInput).toContain(skippedTests);
      expect(ordinaryInput).toContain(captured.comparison.id);
      expect(ordinaryInput).toContain('billing.ts');
    }
    // Native ReviewProfile includes retained patch bytes. Session/model steps
    // receive the captured index and open its evidence lazily.
    expect(received.some(input => {
      const ordinaryInput = JSON.stringify(input);
      return ordinaryInput.includes(baseline.trim()) && ordinaryInput.includes(broken.trim());
    })).toBe(true);
    const history = WorkflowInvocationListResultV1Schema.parse(await act('workflow.run.invocations.list', {
      runId: admitted.workflow.runId, includeContent: true,
    }));
    const reviewers = history.invocationDetails?.filter(row => row.progress.invocationPath.blockId.startsWith('step-1-reviewer-'));
    expect(reviewers).toHaveLength(3);
    expect(reviewers?.map(row => row.index.lifecycle)).toEqual(['completed', 'completed', 'completed']);
    const receipts = (reviewers ?? []).flatMap(row => ReviewStartTerminalValueV1Schema.parse(row.progress.result).perEngineOutcome ?? []);
    expect(receipts).toHaveLength(3);
    expect(receipts).toEqual(expect.arrayContaining([0, 1, 2].map(index => expect.objectContaining({
      key: reviewReviewerIdForSelectionV1(index), outcome: 'completed', reviewOutcome: 'complete',
      materialization: expect.objectContaining({ kind: 'complete' }),
    }))));
    const detail = ReviewGetResponseV1Schema.parse(await act('review.get', { reviewId: admitted.reviewRound.reviewId }));
    expect(detail.review).toMatchObject({ state: 'completed', counts: { total: 2 } });
    const findings = ReviewCommentListResponseV1Schema.parse(await act('reviews.comments.list', { reviewId: admitted.reviewRound.reviewId }));
    expect(findings.items).toHaveLength(2);
    expect(findings.items.map(item => item.finding)).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: claimFinding.title, summary: claimFinding.summary, evidence: claimFinding.evidence }),
      expect.objectContaining({ title: diffFinding.title, filePath: 'billing.ts', startLine: 1,
        summary: diffFinding.summary, evidence: diffFinding.evidence }),
    ]));
  });
  it('F1 preserves a clean direct control before a joined two-model, Session and person Review', async () => {
    await writeFinMuseExecutable({ binDir: join(dirname(auditPath), 'bin'), recordingPath, auditPath, perProcessAudit: true });
    await nativeReply({ summary: 'No findings in the selected comparison.', reviewOutcome: 'complete', findings: [] });
    const direct = await startNativeReview('muse', {}, { modelId });
    expect(direct).toMatchObject({ run: { status: 'succeeded' }, reviewFindings: { reviewOutcome: 'complete', findings: [] } });
    const directReviewId = direct.run.display?.groupId;
    expect(directReviewId).toEqual(expect.any(String));
    const directReview = ReviewGetResponseV1Schema.parse(await act('review.get', { reviewId: directReviewId }));
    expect(directReview.review).toMatchObject({ sourceKind: 'direct', state: 'completed', counts: { total: 0 } });

    const makeLaunch = (selectedModelId: string) => ({ executionTarget: machine.target,
      directory: { kind: 'path' as const, path: machine.workspaceDir }, agentTarget: muse, permissionMode: 'read-only' as const,
      modelSelection: { v: 1 as const, ref: { agentTargetKey: 'agent:happier.agent.muse/muse',
        providerConnectionId: null, modelId: selectedModelId }, updatedAt: 0 },
    });
    const session = SessionSpawnNewActionResultV1Schema.parse(await act('session.spawn_new', makeLaunch(modelId)));
    if (session.type !== 'success') throw new Error('The mixed Review Session did not open');
    const accountId = readAccountIdFromToken(owner.auth.token);
    if (!accountId) throw new Error('The mixed Review owner credential has no Account subject');
    const marker = 'Independently inspect the joined mixed roster without editing the workspace.';
    const selectedModels = ['meta/muse-spark-1.3', modelId];
    const captured = ScmComparisonCaptureOutputSchema.parse(await act('scm.diffSummary.capture', {
      cwd: machine.workspaceDir, source: { kind: 'workingTree', area: 'both' },
    }));
    if (!captured.success) throw new Error(captured.errorCode);
    const before = await readFile(join(machine.workspaceDir, 'README.md'), 'utf8');
    const started = readReviewWorkflowStartActionResultV1(await act('review.start', {
      target: { kind: 'detached' }, cwd: machine.workspaceDir, comparisonId: captured.comparison.id,
      instructions: marker, reviewCommentAuthorIntent: 'open', reviewers: [
        ...selectedModels.map(selected => ({ kind: 'model', launch: makeLaunch(selected) })),
        { kind: 'session', session: { serverId: ui!.serverId, sessionId: session.sessionId } },
        { kind: 'person', principal: { kind: 'account', accountId }, required: true },
      ],
    }));
    if (!started?.reviewRound) throw new Error('The mixed roster did not admit its Review and Workflow');
    expect(started.reviewRound.reviewId).not.toBe(directReviewId);
    expect(await act('workflow.run.wait', { runId: started.workflow.runId, conditions: ['terminal'] }))
      .toMatchObject({ observation: 'terminal', run: { state: 'succeeded' } });
    const history = WorkflowInvocationListResultV1Schema.parse(await act('workflow.run.invocations.list', {
      runId: started.workflow.runId, includeContent: true,
    }));
    const leaves = history.invocationDetails?.filter(row => row.progress.invocationPath.blockId.startsWith('step-1-reviewer-'));
    expect(leaves).toHaveLength(3);
    expect(leaves?.map(row => row.index.lifecycle)).toEqual(['completed', 'completed', 'completed']);
    const mixed = ReviewGetResponseV1Schema.parse(await act('review.get', { reviewId: started.reviewRound.reviewId }));
    expect(mixed.review).toMatchObject({ state: 'completed', subjectKind: 'comparison', counts: { total: 0 } });
    const requested = ReviewHumanStateV1Schema.parse(await act(REVIEW_HUMAN_ACTION_IDS_V1.get, {
      reviewId: started.reviewRound.reviewId,
    }));
    expect(requested.requests).toEqual([expect.objectContaining({ principal: { kind: 'account', accountId },
      required: true, needsAccess: false, roundOrdinal: 1 })]);
    const auditFiles = (await readdir(dirname(auditPath))).filter(name => name.startsWith(`${basename(auditPath)}.`));
    const audits = await Promise.all(auditFiles.map(name => readMuseMspProcessAudit(join(dirname(auditPath), name))));
    const mixedAudits = audits.filter(audit => audit.turnInputs.some(input => JSON.stringify(input).includes(marker)));
    expect(mixedAudits).toHaveLength(3);
    for (const audit of mixedAudits) expect(JSON.stringify(audit.turnInputs)).toContain(captured.comparison.id);
    // One base-model process plus two contributor processes (fresh + retained
    // Session) distinguishes independent selections from either global model.
    expect(mixedAudits.flatMap(audit => audit.modelSelections)
      .sort((left, right) => (left.modelId ?? '').localeCompare(right.modelId ?? ''))).toEqual([
      { providerId: 'meta', modelId: 'muse-spark-1.3' },
      { providerId: 'meta', modelId: 'muse-spark-1.3-contributor' },
      { providerId: 'meta', modelId: 'muse-spark-1.3-contributor' },
    ]);
    expect(await readFile(join(machine.workspaceDir, 'README.md'), 'utf8')).toBe(before);
    expect(ReviewGetResponseV1Schema.parse(await act('review.get', { reviewId: directReviewId })).review).toEqual(directReview.review);
  });
  it('F1 refuses an inaccessible source Session before launching a reviewer', async () => {
    const other = await fixture!.createAccount('source-owner');
    const { sessionId: inaccessibleSessionId } = await createSourceSession(other);
    const denied = await execute('review.start', { target: { kind: 'detached' },
      sourceSession: { sessionId: inaccessibleSessionId, serverId: ui!.serverId },
      reviewers: [{ kind: 'engine', engineId: 'muse', includeSessionTranscript: true }],
      instructions: 'Review the actual workspace change.', reviewCommentAuthorIntent: 'open',
    });
    // Home's signed Action admission preserves its typed source-access refusal.
    expect(denied).toMatchObject({ ok: false, errorCode: 'action_forbidden' });
    const nativeAudit = await readMuseMspProcessAudit(auditPath).catch((error: unknown) => {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return undefined;
      throw error;
    });
    expect(nativeAudit?.turnInputs ?? []).toHaveLength(0);
  });
});
