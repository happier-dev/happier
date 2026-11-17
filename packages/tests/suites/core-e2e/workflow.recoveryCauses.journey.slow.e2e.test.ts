import { randomUUID } from 'node:crypto';
import { rename, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { connectUiPersonActionClient } from '@happier-tests/ui-action-client';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { DiscussionCreateResultV1Schema } from '@happier-dev/protocol/discussions/actions';
import { createAccountScopedCryptoMaterialSnapshotV1 } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { WorkflowRunRecipientCensusResponseV1Schema } from '@happier-dev/protocol/workflows/workflowRunKeyV1';
import { resolveWorkflowRunDataKeyV1 } from '@happier-dev/protocol/workflows/workflowRunDataKeyV1';
import { openWorkflowAcceptedSnapshotStoredEnvelopeV1, parseWorkflowStoredContentEnvelopeV1 } from '@happier-dev/protocol/workflows/workflowStoredContentV1';
import { WorkflowInvocationGetResultV1Schema, WorkflowInvocationListResultV1Schema,
  WorkflowRunGetResultV1Schema, WorkflowRunStartResultV1Schema } from '@happier-dev/protocol/workflows/actionsV1';
import { startFinJourneyFixture, type FinJourneyFixture } from '../../src/testkit/finJourney';
import { execGit, initGitRepo } from '../../src/testkit/uiE2e/gitRepoFixtures';
import { createRunDirs } from '../../src/testkit/runDir';
import { waitFor } from '../../src/testkit/timing';
import { startHttpRequestRecordingProxy } from '../../src/testkit/httpRequestRecordingProxy';
import { createCliActionExecutorFromCredentials } from '../../../../apps/cli/src/session/actions/createCliActionExecutorFromCredentials';
import { createWorkflowRunStorageClient } from '../../../../apps/cli/src/daemon/workflows/workflowRunStorageClient';
import { buildWorkflowActionContext } from '../../../../apps/cli/src/daemon/workflows/workflowActionContext';

const run = createRunDirs({ runLabel: 'core' });

// Real public Actions, encrypted storage, disposable SQLite, server and daemon.
// Only the external Claude executable and the explicit HTTP refusal are doubled.
describe('FIN recovery and Discussion causes through the public Action surface', () => {
  let fixture: FinJourneyFixture | undefined;
  let owner: Awaited<ReturnType<FinJourneyFixture['createAccount']>>;
  let other: Awaited<ReturnType<FinJourneyFixture['createAccount']>>;
  let machine: Awaited<ReturnType<FinJourneyFixture['enrollDaemon']>>;
  let ui: Awaited<ReturnType<typeof connectUiPersonActionClient>> | undefined;
  let testDir: string;
  beforeEach(async () => {
    testDir = run.testDir(`fin-recovery-journey-${randomUUID()}`);
    const features = { ...process.env, HAPPIER_FEATURE_WORKFLOWS__ENABLED: '1', HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1' };
    fixture = await startFinJourneyFixture({ testDir, serverEnv: features });
    owner = await fixture.createAccount('recovery-owner');
    other = await fixture.createAccount('other-account');
    machine = await fixture.enrollDaemon(owner, { env: features });
    await initGitRepo({ repoDir: machine.workspaceDir });
    await writeFile(join(machine.workspaceDir, 'README.md'), 'Recovery journey fixture\n');
    execGit(machine.workspaceDir, ['add', 'README.md']);
    execGit(machine.workspaceDir, ['commit', '-m', 'test: recovery source']);
    ui = await connectUiPersonActionClient({ serverUrl: fixture!.actionServerApiUrl, accountSecret: owner.auth.accountSigningSeed });
    // The fixture observes daemon control readiness and this client awaits its
    // Account bootstrap. The public Action owns target availability admission.
  });
  afterEach(async () => { try { await ui?.close(); } finally { ui = undefined; await fixture?.stop(); fixture = undefined; } });

  const context = () => ({ externalActionTarget: { kind: 'machine' as const, machineId: machine.target.machineId,
    project: { machineId: machine.target.machineId, directory: machine.workspaceDir } } });
  async function act(actionId: ActionId, input: unknown) {
    if (!ui) throw new Error('Recovery Action client is not mounted');
    const result = await ui.executeConfirmed(actionId, input, { surface: 'ui', authority: 'present_user',
      actionCaller: { kind: 'host' }, serverId: ui.serverId, serverIdentityId: fixture!.serverId,
      actionRequestId: randomUUID(), ...context() });
    expect(result.ok, `${actionId}: ${JSON.stringify(result)}`).toBe(true);
    if (!result.ok) throw new Error(`${actionId}: ${result.errorCode}`);
    return result.result;
  }
  const document = (text: string) => ({ text, references: [], attachments: [] });

  it.each(['action', 'step'] as const)('J5 hold → lose workspace → retain %s cause → Restore → finish', async kind => {
    const started = WorkflowRunStartResultV1Schema.parse(await act('workflow.run.start', {
      runId: randomUUID(), executionTarget: { kind: 'session' }, source: { kind: 'inline', definition: { version: 1,
        defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
          permissionMode: 'read-only', terminal: { mode: 'plain' }, conversation: { kind: 'fresh' },
          workspace: { kind: 'new_worktree', source: { kind: 'original' }, displayName: `recover-${kind}` } },
        blocks: [
          { kind: 'action', id: 'prepare-workspace', actionId: 'machines.list', input: {} },
          { kind: 'wait', id: 'before-loss', document: document('Continue after workspace loss') },
          kind === 'action'
            ? { kind: 'action', id: 'after-loss', actionId: 'machines.list', input: {} }
            : { kind: 'step', id: 'after-loss', inputMode: 'none', document: document(''), input: [], result: { kind: 'text' } },
        ],
      } },
    }));
    const runId = started.run.id;
    expect(await act('workflow.run.wait', { runId, conditions: ['attention'] }))
      .toMatchObject({ observation: 'needs_attention' });
    const held = WorkflowInvocationListResultV1Schema.parse(await act('workflow.run.invocations.list', { runId, includeContent: true }));
    const gate = held.invocationDetails?.find(row => row.progress.invocationPath.blockId === 'before-loss');
    const recordedWorkspace = held.invocationDetails?.find(row => row.progress.workspace?.descriptor?.checkout?.kind === 'git_worktree')
      ?.progress.workspace?.descriptor;
    if (!gate || !recordedWorkspace) throw new Error(`Held Run did not publish its created worktree: ${JSON.stringify(held)}`);
    // The disposable checkout becomes temporarily unavailable, as when its
    // volume disconnects. Restore requires the same intact recorded checkout;
    // it deliberately refuses recreation after deletion or replacement.
    const fromSource = relative(machine.workspaceDir, recordedWorkspace.directory);
    expect(fromSource).not.toBe('');
    const fromFixture = relative(testDir, recordedWorkspace.directory);
    expect(isAbsolute(fromFixture) || fromFixture.startsWith('..')).toBe(false);
    const offlineDirectory = `${recordedWorkspace.directory}.offline-${randomUUID()}`;
    await rename(recordedWorkspace.directory, offlineDirectory);
    await act('workflow.run.invocations.complete_review', { runId, invocation: { recordId: gate.index.id },
      expectedContentRevision: gate.index.contentRevision, mode: 'use_result' });
    expect(await act('workflow.run.wait', { runId, conditions: ['attention'] }))
      .toMatchObject({ observation: 'needs_attention' });
    const failed = WorkflowInvocationListResultV1Schema.parse(await act('workflow.run.invocations.list', { runId, includeContent: true }));
    const failure = failed.invocationDetails?.find(row => row.progress.invocationPath.blockId === 'after-loss');
    expect(failure).toMatchObject({ index: { lifecycle: 'needs_attention' },
      progress: { blockKind: kind, reason: { code: 'workspace_unavailable' } } });
    if (!failure) throw new Error('Missing recoverable invocation');
    expect(failure.progress.execution).toBeUndefined();
    const opened = WorkflowInvocationGetResultV1Schema.parse(await act('workflow.run.invocations.get', {
      runId, invocationId: failure.index.id }));
    expect(opened.invocation.recoveryAvailability?.restoreWorkspace).toMatchObject({ kind: 'available' });
    // The person reconnects the original checkout before choosing Restore.
    await rename(offlineDirectory, recordedWorkspace.directory);
    const interrupted = WorkflowRunGetResultV1Schema.parse(await act('workflow.run.get', { runId }));
    await act('workflow.run.resume', { mode: 'recover', runId, expectedRevision: interrupted.run.revision,
      invocations: [{ kind: 'restore_workspace', invocation: { recordId: failure.index.id },
        conversation: 'fresh_agent', input: { kind: 'original' } }] });
    expect(await act('workflow.run.wait', { runId, conditions: ['terminal'] }))
      .toMatchObject({ observation: 'terminal', run: { state: 'succeeded' } });
    const history = WorkflowInvocationListResultV1Schema.parse(await act('workflow.run.invocations.list', { runId, includeContent: true }));
    expect(history.invocationDetails?.find(row => row.index.id === failure.index.id))
      .toMatchObject({ index: { lifecycle: 'superseded' }, progress: { reason: { code: 'workspace_unavailable' } } });
    expect(history.invocationDetails?.filter(row => row.progress.invocationPath.blockId === 'before-loss')).toHaveLength(1);
    expect(history.invocationDetails?.find(row => row.progress.invocationPath.blockId === 'after-loss' && row.index.lifecycle === 'completed'))
      .toMatchObject({ progress: { blockKind: kind, attempt: '1' } });
  });

  it('J6/J8 owner Discussion start succeeds; another Account receives the original typed read refusal', async () => {
    const discussion = DiscussionCreateResultV1Schema.parse(await act('discussion.create', { title: 'Private recovery review',
      firstMessage: { content: { v: 1, parts: [{ t: 'text', text: 'Review the recovery' }] } } }));
    const input = () => ({ runId: randomUUID(), source: { kind: 'inline', definition: { version: 1,
      blocks: [{ kind: 'wait', id: 'review', document: document('Review') }] } },
      origin: { kind: 'discussion', discussion: { serverId: fixture!.serverId, discussionId: discussion.discussion.id },
        addressingMessageId: discussion.firstMessage.id }, onComplete: { kind: 'originating_discussion' } });
    const allowed = WorkflowRunStartResultV1Schema.parse(await act('workflow.run.start', input()));
    const otherMachine = await fixture!.enrollDaemon(other);
    await ui!.close();
    ui = await connectUiPersonActionClient({ serverUrl: fixture!.actionServerApiUrl, accountSecret: other.auth.accountSigningSeed });
    const refused = await ui.executeConfirmed('workflow.run.start', input(), { surface: 'ui', authority: 'present_user',
      actionCaller: { kind: 'host' }, serverId: ui.serverId, serverIdentityId: fixture!.serverId, actionRequestId: randomUUID(),
      externalActionTarget: { kind: 'machine', machineId: otherMachine.target.machineId,
        project: { machineId: otherMachine.target.machineId, directory: otherMachine.workspaceDir } } });
    // Cross-Account Discussion reads intentionally conceal existence. The
    // enclosing Workflow must retain that exact typed cause, not replace it
    // with workflow_discussion_context_unavailable.
    expect(refused, JSON.stringify(refused)).toMatchObject({ ok: false,
      failureCause: { phase: 'workflow.run.start', errorCode: 'discussion_not_found' } });
    expect(await other.execute('workflow.run.get', { runId: allowed.run.id }))
      .toMatchObject({ ok: false, errorCode: 'run_not_found' });
    const retained = await owner.execute('workflow.run.get', { runId: allowed.run.id });
    if (!retained.ok) throw new Error(JSON.stringify(retained));
    expect(WorkflowRunGetResultV1Schema.parse(retained.result).run.id)
      .toBe(allowed.run.id);
  });

  it('J6 an admitted Round frame read preserves an HTTP storage refusal instead of missing content', async () => {
    const started = WorkflowRunStartResultV1Schema.parse(await act('workflow.run.start', {
      runId: randomUUID(), executionTarget: { kind: 'session' }, source: { kind: 'inline', definition: { version: 1,
        blocks: [{ kind: 'action', id: 'round', actionId: 'workflow.discussion.round.project',
          input: { collections: { kind: 'literal', value: ['speakers'] } } }],
      } },
    }));
    const runId = started.run.id;
    let opened: ReturnType<typeof WorkflowInvocationListResultV1Schema.parse> | undefined;
    await waitFor(async () => {
      opened = WorkflowInvocationListResultV1Schema.parse(await act('workflow.run.invocations.list', { runId, includeContent: true }));
      return opened.invocationDetails?.some(row => row.progress.invocationPath.blockId === 'round' && row.progress.execution?.kind === 'action') === true;
    }, { context: 'The real coordinator admits the Round Action before its storage read is refused' });
    if (!opened) throw new Error('Admitted Round invocation absent');
    const round = opened.invocationDetails?.find(row => row.progress.invocationPath.blockId === 'round');
    const execution = round?.progress.execution;
    if (!round || execution?.kind !== 'action') throw new Error(`Round Action was not admitted: ${JSON.stringify(opened)}`);
    const stored = await createWorkflowRunStorageClient({ token: owner.credentials.token, serverHttpBaseUrl: fixture!.server.baseUrl })
      .execute({ operation: 'get', runId });
    if (typeof stored !== 'object' || stored === null || !('keyCensus' in stored) || !('acceptedEnvelope' in stored)) {
      throw new Error('Admitted Round snapshot absent');
    }
    const census = WorkflowRunRecipientCensusResponseV1Schema.parse(stored.keyCensus);
    if (census.ownerAccountCurrentness.mode !== 'e2ee') throw new Error('Expected the fixture Account to retain E2EE mode');
    const material = createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee', material: owner.credentials.encryption,
      dataKeyPublicKey: owner.credentials.encryption.publicKey });
    const key = resolveWorkflowRunDataKeyV1({ encryption: { witness: { ...census.ownerAccountCurrentness, mode: census.ownerAccountCurrentness.mode }, material }, census });
    const envelope = parseWorkflowStoredContentEnvelopeV1(stored.acceptedEnvelope);
    if (key.kind !== 'available' || !envelope) throw new Error('Admitted Round key unavailable');
    const accepted = openWorkflowAcceptedSnapshotStoredEnvelopeV1({ ...key.encryption.runCrypto,
      binding: { v: 1, purpose: 'accepted_snapshot', accountId: census.ownerAccountId, runId }, envelope });
    if (accepted.kind !== 'available') throw new Error('Admitted Round authorization unavailable');
    // Replay the real accepted invocation's read through the public Action
    // executor. The HTTP boundary alone refuses; no storage/domain function is
    // supplied by the test. In particular, the accepted frame is not fabricated.
    const proxy = await startHttpRequestRecordingProxy({ targetBaseUrl: fixture!.server.baseUrl,
      rewriteResponseBody: { when: request => request.path === '/v3/automations/runs/workflow-storage',
        statusCode: 403, rewrite: () => JSON.stringify({ error: 'run_access_denied' }) } });
    try {
      // The real client must observe the substituted endpoint refusal. Proxy
      // entries retain the genuine upstream 200, rather than the client status.
      await expect(createWorkflowRunStorageClient({ token: owner.credentials.token, serverHttpBaseUrl: proxy.baseUrl })
        .execute({ operation: 'get', runId }))
        .rejects.toMatchObject({ response: { status: 403, data: { error: 'run_access_denied' } } });
      const executor = createCliActionExecutorFromCredentials({ credentials: owner.credentials,
        readCredentials: async () => owner.credentials, serverId: fixture!.serverId,
        serverIdentityId: fixture!.serverId, serverApiUrl: proxy.baseUrl });
      const refused = await executor.execute('workflow.discussion.round.project', { collections: ['speakers'] }, {
        ...buildWorkflowActionContext({ runId, invocationRecordId: round.index.id, authorization: accepted.content.authorization,
          origin: accepted.content.origin, workspace: accepted.content.workspaceTarget.project }),
        serverId: fixture!.serverId, serverIdentityId: fixture!.serverId, actionRequestId: execution.actionRequestId,
      });
      expect(proxy.count(request => request.path === '/v3/automations/runs/workflow-storage')).toBeGreaterThan(0);
      expect(refused, JSON.stringify({ refused, transport: proxy.entries().map(request => ({
        path: request.path, status: request.statusCode,
        operation: request.body?.text ? JSON.parse(request.body.text).operation : null,
      })) })).toMatchObject({ ok: false, errorCode: 'run_access_denied', failureCause: { errorCode: 'run_access_denied' } });
    } finally { await proxy.stop(); }
  });
});
