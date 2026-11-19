import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { WorkflowTriggerListResultV1Schema, WorkflowTriggerWriteResultV1Schema } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import { startFinJourneyFixture, type FinJourneyFixture } from '../../src/testkit/finJourney';
import { createRunDirs } from '../../src/testkit/runDir';
import { createSessionWithCiphertexts } from '../../src/testkit/sessions';
import { encryptDataKeyBase64 } from '../../src/testkit/rpcCrypto';

const run = createRunDirs({ runLabel: 'fin-trigger-approval' });
let fixture: Awaited<ReturnType<typeof startFinJourneyFixture>> | undefined;
beforeAll(async () => {
  fixture = await startFinJourneyFixture({ testDir: run.testDir('trigger-approval'),
    serverEnv: { ...process.env,
      HAPPIER_FEATURE_WORKFLOWS__ENABLED: '1', HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1' } });
});
afterAll(async () => { await fixture?.stop(); });

async function assertRemovalAsks(actor: Awaited<ReturnType<FinJourneyFixture['createAccount']>>,
  input: { triggerId: string; automationId: string }, listInput: object) {
  const actionId = 'workflow.trigger.remove';
  for (const surface of ['agent', 'mcp'] as const) {
    const removal = await actor.execute(actionId, input, { surface });
    expect(removal, `${surface} ${actionId} must ask before deleting the saved trigger`).toMatchObject({
      ok: true, result: { kind: 'approval_request_created', actionId, artifactId: expect.any(String) },
    });
    const listed = await actor.execute('workflow.trigger.list', listInput);
    expect(listed.ok, JSON.stringify(listed)).toBe(true);
    if (!listed.ok) throw new Error(listed.errorCode);
    expect(WorkflowTriggerListResultV1Schema.parse(listed.result).sets.flatMap(set =>
      set.triggers.map(trigger => trigger.id))).toContain(input.triggerId);
  }
  expect(await actor.execute(actionId, input, { presentUserConfirmation: { actionId } })).toMatchObject({ ok: true });
  const afterRemoval = await actor.execute('workflow.trigger.list', listInput);
  expect(afterRemoval.ok, JSON.stringify(afterRemoval)).toBe(true);
  if (!afterRemoval.ok) throw new Error(afterRemoval.errorCode);
  expect(WorkflowTriggerListResultV1Schema.parse(afterRemoval.result).sets.flatMap(set =>
    set.triggers.map(trigger => trigger.id))).not.toContain(input.triggerId);
}

it('J12 agent and MCP trigger authoring asks and rejected changes preserve Account triggers', async () => {
  if (!fixture) throw new Error('Trigger approval Home did not start');
  const actor = await fixture.createAccount('trigger-owner');
  const machine = await fixture.enrollDaemon(actor, { env: { ...process.env,
    HAPPIER_FEATURE_WORKFLOWS__ENABLED: '1', HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1' } });
  const input = {
    actionApproval: 'automatic',
    target: { kind: 'inline', definition: { version: 1, blocks: [
      { kind: 'action', id: 'command', actionId: 'machines.command.run',
        input: { command: { kind: 'literal', value: 'echo approval-journey' } } },
    ] } },
    project: { machineId: machine.target.machineId, directory: machine.workspaceDir },
    trigger: { kind: 'schedule', enabled: true,
      schedule: { kind: 'cron', scheduleExpr: '0 0 1 1 *', everyMs: null, timezone: 'UTC' } },
  };
  const rejectAuthoredChange = async (actionId: 'workflow.trigger.add' | 'workflow.trigger.update', request: unknown) => {
    for (const surface of ['agent', 'mcp'] as const) {
      const before = await readTriggers();
      const attempted = await actor.execute(actionId, request, { surface });
      expect(attempted, `${surface} ${actionId} must ask before changing a saved trigger`).toMatchObject({ ok: true });
      if (!attempted.ok) throw new Error(attempted.errorCode);
      const pending = ActionApprovalRequestCreatedResultSchema.parse(attempted.result);
      expect(pending.actionId).toBe(actionId);
      expect(await readTriggers(), 'a pending Ask has not applied the authored change').toEqual(before);
      expect(await actor.execute('approval.request.decide', { artifactId: pending.artifactId, decision: 'reject' }))
        .toMatchObject({ ok: true });
      expect(await readTriggers(), 'Reject leaves the original trigger state intact').toEqual(before);
    }
  };
  const readTriggers = async () => {
    const listed = await actor.execute('workflow.trigger.list', { scope: 'account_all' });
    expect(listed.ok, JSON.stringify(listed)).toBe(true);
    if (!listed.ok) throw new Error(listed.errorCode);
    return WorkflowTriggerListResultV1Schema.parse(listed.result).sets;
  };
  await rejectAuthoredChange('workflow.trigger.add', input);
  expect(await readTriggers()).toEqual([]);
  const created = await actor.execute('workflow.trigger.add', input,
    { presentUserConfirmation: { actionId: 'workflow.trigger.add' } });
  expect(created.ok, JSON.stringify(created)).toBe(true);
  if (!created.ok) throw new Error(created.errorCode);
  const saved = WorkflowTriggerWriteResultV1Schema.parse(created.result);
  if (!saved.triggerId) throw new Error('Account trigger creation did not return its persisted trigger id');
  expect(saved.set.context?.actionApprovals?.[0]?.operation.steps).toEqual([
    { actionId: 'machines.command.run', input: { command: 'echo approval-journey' } },
  ]);
  await rejectAuthoredChange('workflow.trigger.update', { automationId: saved.set.automationId,
    triggerId: saved.triggerId, expectedRevision: saved.set.revision, patch: { enabled: false } });
  expect((await readTriggers()).find(set => set.automationId === saved.set.automationId))
    .toMatchObject({ revision: saved.set.revision, triggers: [expect.objectContaining({ id: saved.triggerId, enabled: true })] });
  await assertRemovalAsks(actor,
    { automationId: saved.set.automationId, triggerId: saved.triggerId }, { scope: 'account_all' });
});

it('J12 Session cleanup exemption never bypasses agent or MCP removal approval', async () => {
  if (!fixture) throw new Error('Trigger approval Home did not start');
  const actor = await fixture.createAccount('session-trigger-owner');
  const machine = await fixture.enrollDaemon(actor, { env: { ...process.env,
    HAPPIER_FEATURE_WORKFLOWS__ENABLED: '1', HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1' } });
  // The fixed regression was the Session cleanup approval exemption leaking to
  // ordinary callers, so Account-only removal would not discriminate that bug.
  const dataKey = randomBytes(32);
  const session = await createSessionWithCiphertexts({ baseUrl: fixture.server.baseUrl, token: actor.credentials.token,
    metadataCiphertextBase64: encryptDataKeyBase64({ v: 1, path: machine.workspaceDir, homeDir: machine.homeDir,
      machineId: machine.target.machineId, host: 'fin-trigger-owner', flavor: 'claude', version: '0.0.0-test' }, dataKey),
    dataEncryptionKeyBase64: Buffer.from(sealEncryptedDataKeyEnvelopeV1({ dataKey,
      recipientPublicKey: actor.credentials.encryption.publicKey, randomBytes })).toString('base64'),
    agentStateCiphertextBase64: encryptDataKeyBase64({ requests: {}, completedRequests: {} }, dataKey) });
  const sessionCreated = await actor.execute('workflow.trigger.add', {
    lifetimeSession: { sessionId: session.sessionId },
    target: { kind: 'inline', definition: { version: 1, blocks: [
      { kind: 'action', id: 'command', actionId: 'machines.command.run',
        input: { command: { kind: 'literal', value: 'echo session-approval-journey' } } },
    ] } },
    trigger: { kind: 'schedule', enabled: true,
      schedule: { kind: 'cron', scheduleExpr: '0 0 1 1 *', everyMs: null, timezone: 'UTC' } },
  }, { presentUserConfirmation: { actionId: 'workflow.trigger.add' } });
  expect(sessionCreated.ok, JSON.stringify(sessionCreated)).toBe(true);
  if (!sessionCreated.ok) throw new Error(sessionCreated.errorCode);
  const sessionSaved = WorkflowTriggerWriteResultV1Schema.parse(sessionCreated.result);
  if (!sessionSaved.triggerId) throw new Error('Session trigger creation did not return its persisted trigger id');
  expect(sessionSaved.set.scopeSessionId).toBe(session.sessionId);
  await assertRemovalAsks(actor,
    { automationId: sessionSaved.set.automationId, triggerId: sessionSaved.triggerId },
    { lifetimeSession: { sessionId: session.sessionId } });
});
