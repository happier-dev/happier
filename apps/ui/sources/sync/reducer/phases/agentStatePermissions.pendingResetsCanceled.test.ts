import { describe, expect, it } from 'vitest';
import { createReducer } from '../reducer';
import { runAgentStatePermissionsPhase } from './agentStatePermissions';

describe('runAgentStatePermissionsPhase (pending request resets canceled tool)', () => {
  it('restores a canceled permission tool back to pending when AgentState.requests still contains it', () => {
    const state = createReducer();
    const changed = new Set<string>();

    const permId = 'que_1';
    const messageId = 'msg_1';

    state.toolIdToMessageId.set(permId, messageId);
    state.messages.set(messageId, {
      id: messageId,
      localId: null,
      realID: null,
      seq: null,
      role: 'agent',
      createdAt: 10,
      text: null,
      event: null,
      tool: {
        name: 'AskUserQuestion',
        state: 'error',
        input: { questions: [{ header: 'H', question: 'Q', options: [], multiSelect: false }] },
        createdAt: 10,
        startedAt: null,
        completedAt: 11,
        description: null,
        result: { error: 'Request interrupted' },
        permission: {
          id: permId,
          status: 'canceled',
          reason: 'Request interrupted',
          decision: 'abort',
        },
      },
    });

    runAgentStatePermissionsPhase({
      state,
      agentState: {
        controlledByUser: null,
        requests: {
          [permId]: {
            tool: 'AskUserQuestion',
            kind: 'user_action',
            arguments: { questions: [{ header: 'H', question: 'Q', options: [], multiSelect: false }] },
            createdAt: 12,
          },
        },
        completedRequests: null,
      },
      incomingToolIds: new Set<string>(),
      changed,
      allocateId: () => 'alloc',
      enableLogging: false,
    });

    const message = state.messages.get(messageId);
    expect(message?.tool?.permission?.status).toBe('pending');
    expect(message?.tool?.state).toBe('running');
    expect(message?.tool?.completedAt).toBeNull();
    expect(message?.tool?.result).toBeUndefined();
    expect(changed.has(messageId)).toBe(true);
  });

  it('restores a locally interrupted pending permission even when the placeholder completed after the request was created', () => {
    const state = createReducer();
    const changed = new Set<string>();

    const permId = 'perm_waiting';
    const messageId = 'msg_perm_waiting';

    state.toolIdToMessageId.set(permId, messageId);
    state.messages.set(messageId, {
      id: messageId,
      localId: null,
      realID: null,
      seq: null,
      role: 'agent',
      createdAt: 100,
      text: null,
      event: null,
      tool: {
        id: permId,
        name: 'Bash',
        state: 'error',
        input: { command: 'find . -type f | head' },
        createdAt: 100,
        startedAt: null,
        completedAt: 150,
        description: null,
        result: { error: 'Request interrupted' },
        permission: {
          id: permId,
          status: 'canceled',
          kind: 'permission',
          reason: 'Request interrupted',
          decision: 'abort',
        },
      },
    });

    runAgentStatePermissionsPhase({
      state,
      agentState: {
        controlledByUser: null,
        requests: {
          [permId]: {
            tool: 'Bash',
            kind: 'permission',
            arguments: { command: 'find . -type f | head' },
            createdAt: 100,
          },
        },
        completedRequests: null,
      },
      incomingToolIds: new Set<string>(),
      changed,
      allocateId: () => 'alloc',
      enableLogging: false,
    });

    const message = state.messages.get(messageId);
    expect(message?.tool?.permission?.status).toBe('pending');
    expect(message?.tool?.state).toBe('running');
    expect(message?.tool?.completedAt).toBeNull();
    expect(message?.tool?.result).toBeUndefined();
    expect(changed.has(messageId)).toBe(true);
  });

  it('does not restore a real canceled permission back to pending when AgentState.requests is stale', () => {
    const state = createReducer();
    const changed = new Set<string>();

    const permId = 'que_2';
    const messageId = 'msg_2';

    state.toolIdToMessageId.set(permId, messageId);
    state.messages.set(messageId, {
      id: messageId,
      localId: null,
      realID: 'real-msg-2',
      seq: 22,
      role: 'agent',
      createdAt: 20,
      text: null,
      event: null,
      tool: {
        id: permId,
        name: 'AskUserQuestion',
        state: 'error',
        input: { questions: [{ header: 'H', question: 'Q', options: [], multiSelect: false }] },
        createdAt: 20,
        startedAt: null,
        completedAt: 21,
        description: null,
        result: { error: 'User canceled' },
        permission: {
          id: permId,
          status: 'canceled',
          reason: 'User canceled',
        },
      },
    });

    runAgentStatePermissionsPhase({
      state,
      agentState: {
        controlledByUser: null,
        requests: {
          [permId]: {
            tool: 'AskUserQuestion',
            kind: 'user_action',
            arguments: { questions: [{ header: 'H', question: 'Q', options: [], multiSelect: false }] },
            createdAt: 22,
          },
        },
        completedRequests: null,
      },
      incomingToolIds: new Set<string>(),
      changed,
      allocateId: () => 'alloc',
      enableLogging: false,
    });

    const message = state.messages.get(messageId);
    expect(message?.tool?.permission?.status).toBe('canceled');
    expect(message?.tool?.state).toBe('error');
    expect(message?.tool?.completedAt).toBe(21);
    expect(message?.tool?.result).toEqual({ error: 'User canceled' });
  });
});
