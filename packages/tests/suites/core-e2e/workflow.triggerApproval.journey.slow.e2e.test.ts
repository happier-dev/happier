import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol';
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

it('J12 agent and MCP removal ask before deleting an Account trigger', async () => {
  if (!fixture) throw new Error('Trigger approval Home did not start');
  const actor = await fixture.createAccount('trigger-owner');
  const machine = await fixture.enrollDaemon(actor, { env: { ...process.env,
    HAPPIER_FEATURE_WORKFLOWS__ENABLED: '1', HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1' } });
  const created = await actor.execute('workflow.trigger.add', {
    target: { kind: 'inline', definition: { version: 1, blocks: [
      { kind: 'action', id: 'command', actionId: 'machines.command.run',
        input: { command: { kind: 'literal', value: 'echo approval-journey' } } },
    ] } },
    project: { machineId: machine.target.machineId, directory: machine.workspaceDir },
    trigger: { kind: 'schedule', enabled: true,
      schedule: { kind: 'cron', scheduleExpr: '0 0 1 1 *', everyMs: null, timezone: 'UTC' } },
  }, { presentUserConfirmation: { actionId: 'workflow.trigger.add' } });
  expect(created.ok, JSON.stringify(created)).toBe(true);
  if (!created.ok) throw new Error(created.errorCode);
  const saved = WorkflowTriggerWriteResultV1Schema.parse(created.result);
  if (!saved.triggerId) throw new Error('Account trigger creation did not return its persisted trigger id');
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
