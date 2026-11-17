import { expect, it } from 'vitest';
import type { NativePermissionChoicesV1 } from '@happier-dev/protocol/sessions/permissions/respondRpcParamsV1';
import type { AgentState } from '@/api/types';
import { AgentStateRequestStore } from '@/agent/permissions/agentStateRequestStore';
import { createDeferred } from '@/testkit/async/deferred';
import { createExecutionRunPermissionHandler } from './executionRunPermissionDecision';

const nativeChoices: NativePermissionChoicesV1 = { source: 'native-fixture', requirementId: 'requirement-current', choices: [
  { id: 'one-native-choice', label: 'Native once', decision: 'approved', scope: 'once',
    response: { approved: true, decision: 'approved' } },
] };

it('applies the Happier Action owner decision through the exact native offer without granting shell access', () => {
  const f = fixture('read-only');
  const context = { nativeChoices, source: 'native_tool_approval_once' };
  expect(f.handler.getImmediateDecision('discovery', 'mcp__happier__action_spec_search', { query: 'scm' }, context))
    .toEqual({ decision: 'approved', nativeChoice: { requirementId: nativeChoices.requirementId, choiceId: 'one-native-choice' } });
  expect(f.handler.getImmediateDecision('write', 'mcp__happier__action_execute',
    { actionId: 'daemon.filesystem.writeFile' }, context)).toMatchObject({ decision: 'denied' });
  expect(f.handler.getImmediateDecision('shell', 'Bash', { command: 'pwd' }, context)).toBeNull();
});

function fixture(permissionMode = 'default') {
  let state: AgentState = {};
  const store = new AgentStateRequestStore({ logPrefix: '[Run native permission test]', target: {
    scopeId: 'detached-run-native', readState: () => state,
    updateState: async update => { state = update(state); },
  } });
  const handler = createExecutionRunPermissionHandler({ backendId: 'fixture-agent', permissionMode,
    getPermissionRequestStore: () => store,
    publishPendingRequest: async request => { await store.publishRequestAndWait({ ...request, createdAt: 1 }); },
  });
  return { handler, store, state: () => state };
}

it('publishes the exact offered native requirement through the existing Run pending owner', async () => {
  const f = fixture();
  const context = { nativeChoices, source: 'native_tool_approval_once' };
  const pending = f.handler.handleToolCall('native-approval', 'Bash', { command: 'echo harmless' }, context);
  try {
    await Promise.resolve();
    expect(f.state().requests?.['native-approval']?.nativeChoices).toEqual(nativeChoices);
  } finally { await f.handler.abortPendingRequestsAndFlush?.('test cleanup'); await pending; }
});

it('preserves the actual offered choice when a matching native observation precedes application acknowledgement', async () => {
  const f = fixture();
  const native = createDeferred<void>();
  const observed = createDeferred<boolean>();
  const source = 'native_tool_approval_once';
  const answer = { decision: 'approved' as const,
    nativeChoice: { requirementId: nativeChoices.requirementId, choiceId: nativeChoices.choices[0]!.id } };
  const pending = f.handler.handleToolCall('native-observed', 'Bash', { command: 'echo harmless' }, {
    nativeChoices, source, async acknowledgeDecisionApplication() {
      // Native notifications are read independently of the command result.
      void f.handler.settleObservedDecision({ requestId: 'native-observed', source, decision: 'approved' })
        .then(observed.resolve);
      await native.promise;
    },
  });
  try {
    await Promise.resolve();
    const delivered = Promise.resolve(f.handler.respondToPermissionRequest('native-observed', answer));
    await Promise.resolve();
    expect(f.state().requests?.['native-observed']).toBeDefined();
    native.resolve();
    await expect(delivered).resolves.toEqual(answer);
    await expect(pending).resolves.toEqual(answer);
    await expect(observed.promise).resolves.toBe(true);
  } finally { native.resolve(); await f.handler.abortPendingRequestsAndFlush?.('test cleanup'); await pending; }
});

it('retains structured question answers and notes instead of collapsing them into a boolean approval', async () => {
  const f = fixture();
  const pending = f.handler.handleToolCall('native-question', 'AskUserQuestion', { questions: [{
    id: 'pick', question: 'Choose a native option', selection: 'single', required: true,
    allowCustom: true, allowNote: true, options: [{ id: 'Exact, label', label: 'Exact, label' }],
  }] }, { signal: new AbortController().signal });
  const answer = { decision: 'approved' as const, answers: { pick: ['Exact, label'] },
    answerDetails: { pick: { note: 'Keep this note' } } };
  try {
    await Promise.resolve();
    expect(await f.handler.respondToPermissionRequest('native-question', answer)).toEqual(answer);
    await expect(pending).resolves.toEqual(answer);
  } finally { await f.handler.abortPendingRequestsAndFlush?.('test cleanup'); await pending; }
});

it('acknowledges native application before delivery and keeps a refused application pending for retry', async () => {
  const f = fixture();
  const native = createDeferred<void>();
  let applications = 0;
  let refuse = true;
  const context = { nativeChoices, signal: new AbortController().signal,
    async acknowledgeDecisionApplication() {
      applications++;
      if (refuse) throw new Error('Native boundary refused the decision');
      await native.promise;
    },
  };
  const pending = f.handler.handleToolCall('native-application', 'Bash', { command: 'echo harmless' }, context);
  const answer = { decision: 'approved' as const,
    nativeChoice: { requirementId: nativeChoices.requirementId, choiceId: nativeChoices.choices[0]!.id } };
  let delivered = false;
  try {
    await Promise.resolve();
    await expect(Promise.resolve(f.handler.respondToPermissionRequest('native-application', answer))).rejects.toThrow('Native boundary refused');
    expect(applications).toBe(1);
    refuse = false;
    const delivery = Promise.resolve(f.handler.respondToPermissionRequest('native-application', answer))
      .then(value => { delivered = true; return value; });
    await Promise.resolve();
    expect(applications).toBe(2);
    expect(delivered).toBe(false);
    native.resolve();
    await expect(delivery).resolves.toEqual(answer);
    await expect(pending).resolves.toEqual(answer);
  } finally { native.resolve(); await f.handler.abortPendingRequestsAndFlush?.('test cleanup'); await pending; }
});

it('keeps a native offer authoritative even when Run mode otherwise auto-approves the tool', async () => {
  const f = fixture('yolo');
  const context = { nativeChoices, source: 'native_tool_approval_once' };
  const pending = f.handler.handleToolCall('native-offer', 'Bash', { command: 'echo harmless' }, context);
  const answer = { decision: 'approved' as const,
    nativeChoice: { requirementId: nativeChoices.requirementId, choiceId: nativeChoices.choices[0]!.id } };
  try {
    await Promise.resolve();
    expect(f.state().requests?.['native-offer']?.nativeChoices).toEqual(nativeChoices);
    expect(await f.handler.respondToPermissionRequest('native-offer', { ...answer,
      nativeChoice: { ...answer.nativeChoice, choiceId: 'unoffered-persistent-choice' } })).toBeNull();
    expect(await f.handler.respondToPermissionRequest('native-offer', answer)).toEqual(answer);
    await expect(pending).resolves.toEqual(answer);
  } finally { await f.handler.abortPendingRequestsAndFlush?.('test cleanup'); await pending; }
});

it('keeps native questions pending for an actual structured answer under automatic tool mode', async () => {
  const f = fixture('yolo');
  const pending = f.handler.handleToolCall('native-yolo-question', 'AskUserQuestion', { questions: [{
    id: 'pick', question: 'Choose', selection: 'single', options: [{ label: 'Exact' }],
  }] }, { origin: 'host_occurrence_question', lifetime: 'occurrence' });
  const answer = { decision: 'approved' as const, answers: { pick: ['Exact'] } };
  try {
    await Promise.resolve();
    expect(f.state().requests?.['native-yolo-question']).toMatchObject({ kind: 'user_action',
      questionV1: { mode: 'wait', lasting: false, type: 'decision' }, lifetime: 'occurrence' });
    expect(await f.handler.respondToPermissionRequest('native-yolo-question', answer)).toEqual(answer);
    await expect(pending).resolves.toEqual(answer);
  } finally { await f.handler.abortPendingRequestsAndFlush?.('test cleanup'); await pending; }
});
