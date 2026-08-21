import { describe, expect, it, vi } from 'vitest';
import { CLAUDE_UNIFIED_TERMINAL_DIALOG_CHOICE_REQUEST_SOURCE } from '@happier-dev/agents';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol';

import type { AgentState } from '@/api/types';
import { createPermissionHandlerSessionStub } from '../../utils/permissionHandler.testkit';
import { parseClaudeScreenState } from '../tuiControls/screenState';
import { resolveClaudeUnifiedVisibleDialog } from '../tuiControls/dialogRegistry';
import { ClaudeUnifiedDialogChoiceBroker } from './claudeUnifiedDialogChoiceBroker';

const EFFORT_DIALOG = [
  'Change effort level?',
  'Switching to high means the full history gets re-read before Claude can continue.',
  '❯ 1. Yes, switch to high',
  '  2. No, go back',
].join('\n');

const SAFEGUARD_DIALOG = [
  'Session paused',
  "Fable 5's safeguards flagged this message.",
  '❯ 1. Switch to Opus 4.8',
  '  2. Edit prompt and retry with Fable 5',
].join('\n');

function dialog(screen: string) {
  const resolved = resolveClaudeUnifiedVisibleDialog(parseClaudeScreenState(screen));
  if (!resolved) throw new Error('expected dialog fixture');
  return resolved;
}

function deferredAgentStateWrite(client: ReturnType<typeof createPermissionHandlerSessionStub>['client']) {
  let release!: () => void;
  const persisted = new Promise<void>((resolve) => { release = resolve; });
  Object.defineProperty(client, 'updateAgentState', {
    configurable: true,
    value: (updater: (state: AgentState) => AgentState) => {
      client.agentState = updater(client.agentState as AgentState) as typeof client.agentState;
      return persisted;
    },
  });
  return release;
}

function deferredSerializedAgentStateWrites(
  client: ReturnType<typeof createPermissionHandlerSessionStub>['client'],
) {
  const releases: Array<() => void> = [];
  let tail = Promise.resolve();
  Object.defineProperty(client, 'updateAgentState', {
    configurable: true,
    value: (updater: (state: AgentState) => AgentState) => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      releases.push(release);
      const write = tail.then(async () => {
        const next = updater(client.agentState as AgentState);
        await gate;
        client.agentState = next as typeof client.agentState;
      });
      tail = write.catch(() => {});
      return write;
    },
  });
  return {
    release(index: number) {
      const release = releases[index];
      if (!release) throw new Error(`missing deferred AgentState write ${index}`);
      release();
    },
    count: () => releases.length,
  };
}

describe('ClaudeUnifiedDialogChoiceBroker lifecycle', () => {
  it('does not publish a replacement until the prior request cancellation is persisted', async () => {
    const { session, client } = createPermissionHandlerSessionStub('dialog-broker-replacement');
    let sequence = 0;
    const broker = new ClaudeUnifiedDialogChoiceBroker(session, {
      createRequestId: () => `dialog-${++sequence}`,
    });
    const first = broker.requestDialogChoice({ dialog: dialog(EFFORT_DIALOG) });
    void first.catch(() => {});
    await vi.waitFor(() => expect(client.agentState.requests['dialog-1']).toBeDefined());

    const release = deferredAgentStateWrite(client);
    const second = broker.requestDialogChoice({ dialog: dialog(SAFEGUARD_DIALOG) });
    void second.catch(() => {});
    await Promise.resolve();
    expect(client.agentState.requests['dialog-2']).toBeUndefined();

    release();
    await vi.waitFor(() => expect(client.agentState.requests['dialog-2']).toBeDefined());
    expect(client.agentState.completedRequests['dialog-1']).toMatchObject({
      status: 'canceled',
      reason: 'claude_unified_dialog_changed',
    });
  });

  it('does not finish disposal until every source-owned cancellation is persisted', async () => {
    const { session, client } = createPermissionHandlerSessionStub('dialog-broker-dispose');
    const broker = new ClaudeUnifiedDialogChoiceBroker(session, { createRequestId: () => 'dialog-1' });
    const pending = broker.requestDialogChoice({ dialog: dialog(EFFORT_DIALOG) });
    void pending.catch(() => {});
    await vi.waitFor(() => expect(client.agentState.requests['dialog-1']).toBeDefined());
    const release = deferredAgentStateWrite(client);
    let disposed = false;
    const disposal = broker.dispose().then(() => { disposed = true; });

    await Promise.resolve();
    expect(disposed).toBe(false);
    release();
    await disposal;
    expect(client.agentState.requests['dialog-1']).toBeUndefined();
    expect(client.agentState.completedRequests['dialog-1']).toMatchObject({ status: 'canceled' });
  });

  it('does not release an approved choice until the source request completion is persisted', async () => {
    const { session, client } = createPermissionHandlerSessionStub('dialog-broker-approved-cleanup');
    const broker = new ClaudeUnifiedDialogChoiceBroker(session, { createRequestId: () => 'dialog-1' });
    broker.activate();

    let settled = false;
    const pending = broker.requestDialogChoice({ dialog: dialog(EFFORT_DIALOG) }).then((decision) => {
      settled = true;
      return decision;
    });
    await vi.waitFor(() => expect(client.agentState.requests['dialog-1']).toBeDefined());

    const release = deferredAgentStateWrite(client);
    await client.rpcHandlerManager.getHandler('permission')?.({
      id: 'dialog-1',
      approved: true,
      answers: { answer: 'confirm' },
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);

    release();
    await expect(pending).resolves.toEqual({ dialogId: 'effort_change', choice: 'confirm' });
    expect(client.agentState.completedRequests['dialog-1']).toMatchObject({
      status: 'approved',
      decision: 'allow',
    });
  });

  it('accepts the modern structured answer for a recognized dialog choice', async () => {
    const { session, client } = createPermissionHandlerSessionStub('dialog-broker-structured-answer');
    const broker = new ClaudeUnifiedDialogChoiceBroker(session, { createRequestId: () => 'dialog-1' });
    broker.activate();

    const pending = broker.requestDialogChoice({ dialog: dialog(EFFORT_DIALOG) });
    await vi.waitFor(() => expect(client.agentState.requests['dialog-1']).toBeDefined());

    const respond = client.rpcHandlerManager.getHandler(SESSION_RPC_METHODS.SESSION_STRUCTURED_QUESTION_RESPOND_V1);
    if (!respond) throw new Error('expected structured-question RPC handler');
    await Reflect.apply(respond, undefined, [{
      id: 'dialog-1',
      structuredAnswersV1: { answer: ['confirm'] },
    }]);

    await expect(pending).resolves.toEqual({ dialogId: 'effort_change', choice: 'confirm' });
    expect(client.agentState.completedRequests['dialog-1']).toMatchObject({
      status: 'approved',
      dialogChoice: 'confirm',
    });
  });

  it('advertises structured answer support on the request it publishes', async () => {
    // The request is published under the AskUserQuestion tool name, so a client that
    // declines the ambiguous legacy downgrade gates submission on this capability.
    // Without it the dialog is unanswerable remotely even though the broker accepts
    // the modern structured answer, as the preceding test shows.
    const { session, client } = createPermissionHandlerSessionStub('dialog-broker-capabilities');
    const broker = new ClaudeUnifiedDialogChoiceBroker(session, { createRequestId: () => 'dialog-1' });
    broker.activate();

    const pending = broker.requestDialogChoice({ dialog: dialog(EFFORT_DIALOG) });
    void pending.catch(() => {});
    await vi.waitFor(() => expect(client.agentState.requests['dialog-1']).toBeDefined());

    expect(client.agentState.capabilities).toMatchObject({
      askUserQuestionAnswersInPermission: true,
      structuredQuestionAnswersV1Supported: true,
    });

    await broker.dispose();
  });

  it('does not finish disposal while a denied choice cancellation is still persisting', async () => {
    const { session, client } = createPermissionHandlerSessionStub('dialog-broker-denied-cleanup');
    const broker = new ClaudeUnifiedDialogChoiceBroker(session, { createRequestId: () => 'dialog-1' });
    broker.activate();

    const pending = broker.requestDialogChoice({ dialog: dialog(EFFORT_DIALOG) });
    void pending.catch(() => {});
    await vi.waitFor(() => expect(client.agentState.requests['dialog-1']).toBeDefined());

    const release = deferredAgentStateWrite(client);
    await client.rpcHandlerManager.getHandler('permission')?.({
      id: 'dialog-1',
      approved: false,
      reason: 'user_denied',
    });

    let disposed = false;
    const disposal = broker.dispose().then(() => { disposed = true; });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(disposed).toBe(false);

    release();
    await disposal;
    await expect(pending).rejects.toThrow('user_denied');
    expect(client.agentState.completedRequests['dialog-1']).toMatchObject({
      status: 'canceled',
      reason: 'user_denied',
    });
  });

  it('does not release an approved choice when disposal starts before approval persistence settles', async () => {
    const { session, client } = createPermissionHandlerSessionStub('dialog-broker-approved-dispose');
    const broker = new ClaudeUnifiedDialogChoiceBroker(session, { createRequestId: () => 'dialog-1' });
    broker.activate();

    let choiceSettled = false;
    const pending = broker.requestDialogChoice({ dialog: dialog(EFFORT_DIALOG) }).finally(() => {
      choiceSettled = true;
    });
    void pending.catch(() => {});
    await vi.waitFor(() => expect(client.agentState.requests['dialog-1']).toBeDefined());

    const writes = deferredSerializedAgentStateWrites(client);
    await client.rpcHandlerManager.getHandler('permission')?.({
      id: 'dialog-1',
      approved: true,
      answers: { answer: 'confirm' },
    });
    const disposal = broker.dispose();
    await vi.waitFor(() => expect(writes.count()).toBe(2));

    writes.release(0);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(choiceSettled).toBe(false);

    writes.release(1);
    await disposal;
    await expect(pending).rejects.toThrow('claude_unified_dialog_choice_broker_disposed');
    expect(client.agentState.completedRequests['dialog-1']).toMatchObject({
      status: 'canceled',
      reason: 'claude_unified_dialog_choice_broker_disposed',
    });
  });

  it('cancels an AgentState-only response instead of accepting it without a live waiter', async () => {
    const { session, client } = createPermissionHandlerSessionStub('dialog-broker-stale');
    client.agentState.requests.stale = {
      tool: 'AskUserQuestion',
      kind: 'user_action',
      source: CLAUDE_UNIFIED_TERMINAL_DIALOG_CHOICE_REQUEST_SOURCE,
      arguments: {
        happierDialog: { kind: 'recognized', dialogId: 'effort_change' },
        questions: [{ options: [{ choice: 'confirm', label: 'Switch model' }] }],
      },
      createdAt: 1,
    };
    const broker = new ClaudeUnifiedDialogChoiceBroker(session);
    broker.activate();

    await client.rpcHandlerManager.getHandler('permission')?.({
      id: 'stale',
      approved: true,
      answers: { answer: 'confirm' },
    });
    await vi.waitFor(() => expect(client.agentState.requests.stale).toBeUndefined());
    expect(client.agentState.completedRequests.stale).toMatchObject({
      status: 'canceled',
      reason: 'claude_unified_dialog_choice_no_live_waiter',
    });
  });

  it('leaves a claimed source-owned dialog request outstanding on disposal', async () => {
    const { session, client } = createPermissionHandlerSessionStub('dialog-broker-claimed-dispose');
    const opaqueClaim = { malformed: { future: true } };
    client.agentState.requests.claimed = {
      tool: 'AskUserQuestion',
      kind: 'user_action',
      source: CLAUDE_UNIFIED_TERMINAL_DIALOG_CHOICE_REQUEST_SOURCE,
      arguments: {
        happierDialog: { kind: 'recognized', dialogId: 'effort_change' },
        questions: [{ options: [{ choice: 'confirm', label: 'Switch model' }] }],
      },
      createdAt: 1,
      permissionResponseClaimV1: opaqueClaim,
    };

    const broker = new ClaudeUnifiedDialogChoiceBroker(session);
    await broker.dispose();

    const retained = client.agentState.requests.claimed as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(retained, 'permissionResponseClaimV1')).toBe(true);
    expect(retained.permissionResponseClaimV1).toBe(opaqueClaim);
    expect(client.agentState.completedRequests.claimed).toBeUndefined();
  });
});
