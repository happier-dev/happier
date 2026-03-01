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
});
