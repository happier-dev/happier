import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { startInstalledDaemonFixture } from '@/daemon/testkit/installedDaemon.testkit';
import { createFirstConversationAgentFixture } from '@/daemon/testkit/firstConversationAgent.testkit';
import { WorkflowInvocationListResultV1Schema, WorkflowRunWaitResultV1Schema } from '@happier-dev/protocol/workflows/actionsV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';

// Both targets use the same installed daemon lifetime. Its process-wide
// plugin registry is terminal after shutdown, just as in the shipped process.
let f: Awaited<ReturnType<typeof startInstalledDaemonFixture>>;
let stopDaemon: (() => Promise<void>) | undefined;
beforeAll(async () => {
  f = await startInstalledDaemonFixture({ plugins: [createFirstConversationAgentFixture('WORKFLOW_FIRST_INPUT')],
    registerCleanup: cleanup => { stopDaemon = cleanup; } });
}, 120_000);
afterAll(async () => { await stopDaemon?.(); }, 120_000);

it('merges daemon-applied native factory readiness with requester physical inventory', async () => {
  const inventory = await f.invoke(RPC_METHODS.CAPABILITIES_DETECT, { requests: [
    { id: 'cli.acme.project-launch/agent', params: { includeLoginStatus: true } },
    { id: 'cli.codex' },
  ] });
  expect(inventory, JSON.stringify(inventory)).toMatchObject({ results: {
    'cli.acme.project-launch/agent': { ok: true, data: { available: true, installed: true,
      signIn: { required: false } } },
    'cli.codex': { ok: true, data: { available: expect.any(Boolean) } },
  } });
}, 120_000);

it.each(['session', 'detached_run'] as const)('completes an owner Workflow %s through the installed coordinator and first conversation, with member no-effect refusals', async target => {
  const before = await f.home.readWorkflowSessionEffects();
  const context = { surface: 'rpc' as const, authority: 'present_user' as const, serverId: f.serverId,
    externalActionTarget: { kind: 'machine' as const, machineId: f.machineId,
      project: { machineId: f.machineId, directory: f.directory } } };
  const request = (runId: string) => ({ runId, executionTarget: { kind: target }, source: { kind: 'inline' as const,
    definition: { version: 1 as const, inputs: [], defaults: {
      agentTarget: { kind: 'agent' as const, identity: { pluginId: 'acme.project-launch', localId: 'agent' } }, connectedServices: null,
      conversation: { kind: 'fresh' as const },
    }, blocks: [{ kind: 'step' as const, id: 'conversation',
      document: { text: 'WORKFLOW_FIRST_INPUT', references: [], attachments: [] }, input: [], result: { kind: 'text' as const } }] },
  } });
  const runId = randomUUID();
  const owner = f.createActionExecutor();
  const started = await owner.execute('workflow.run.start', request(runId), context);
  expect(started, JSON.stringify(started)).toMatchObject({ ok: true });
  // This is the public Workflow wait, not an injected coordinator or a
  // test-created child. Home pushes wake its installed automation worker.
  const settled = await owner.execute('workflow.run.wait', { runId, timeoutSeconds: 60 }, context);
  expect(settled).toMatchObject({ ok: true });
  if (!settled.ok) throw new Error('Workflow observation refused');
  expect(WorkflowRunWaitResultV1Schema.parse(settled.result)).toMatchObject({
    observation: 'terminal', run: { id: runId, state: 'succeeded' },
  });
  const listed = await owner.execute('workflow.run.invocations.list', { runId, includeContent: true }, context);
  expect(listed).toMatchObject({ ok: true });
  if (!listed.ok) throw new Error('Workflow persisted invocation read refused');
  const invocation = WorkflowInvocationListResultV1Schema.parse(listed.result).invocationDetails
    ?.find(detail => detail.progress.invocationPath.blockId === 'conversation');
  expect(invocation?.index.lifecycle).toBe('completed');
  expect(invocation?.progress).toMatchObject({
    input: { document: { text: 'WORKFLOW_FIRST_INPUT' } }, execution: { kind: target } });
  expect(JSON.stringify(invocation?.progress.result)).toContain('git version ');
  expect(JSON.stringify(invocation?.progress.result)).not.toContain('WORKFLOW_FIRST_INPUT');
  const effects = await f.home.readWorkflowSessionEffects();
  expect(effects.runs.filter(run => !before.runs.some(previous => previous.id === run.id)))
    .toEqual([expect.objectContaining({ id: runId, accountId: f.home.accountId, state: 'succeeded' })]);
  const sessions = effects.sessions.filter(session => !before.sessions.some(previous => previous.id === session.id));
  expect(sessions).toHaveLength(target === 'session' ? 1 : 0);
  expect(effects.pending).toEqual([]);
  const user = effects.messages.filter(message => sessions.some(session => session.id === message.sessionId) && message.messageRole === 'user');
  const assistant = effects.messages.filter(message => sessions.some(session => session.id === message.sessionId) && message.messageRole === 'agent');
  if (target === 'session') {
    expect(sessions[0]).toMatchObject({ pendingCount: 0, pendingBlockedCount: 0 });
    expect(user).toHaveLength(1);
    expect(user[0]?.content).toMatchObject({ t: 'plain', v: { content: { text: 'WORKFLOW_FIRST_INPUT' } } });
    expect(JSON.stringify(assistant)).toContain('git version ');
    expect(JSON.stringify(assistant)).not.toContain('WORKFLOW_FIRST_INPUT');
    const turns = effects.turns.filter(turn => turn.sessionId === sessions[0]?.id);
    expect(turns).toEqual([expect.objectContaining({ sessionId: sessions[0]?.id, status: 'completed' })]);
    expect(JSON.parse(turns[0]!.transcriptAnchorsJson!)).toMatchObject({
      startUserMessageSeq: user[0]?.seq, userMessageSeqs: [user[0]?.seq],
      finalAssistantMessageSeq: assistant.at(-1)?.seq,
    });
  }
  for (const accessLevel of ['view', 'admin'] as const) {
    const member = await f.home.createMachineMember(accessLevel);
    const result = await f.createActionExecutor(member).execute('workflow.run.start', request(randomUUID()), context);
    expect(result).toMatchObject({ ok: false, errorCode: 'target_unavailable' });
    const after = await f.home.readWorkflowSessionEffects();
    expect(after.sessions).toEqual(effects.sessions);
    expect(after.messages).toEqual(effects.messages);
    expect(after.runs).toEqual(effects.runs);
    expect(after.turns).toEqual(effects.turns);
    expect(after.pending).toEqual(effects.pending);
  }
}, 120_000);
