import { describe, expect, it } from 'vitest';
import { createReducer } from '../reducer';
import { runAgentStatePermissionsPhase } from './agentStatePermissions';

describe('runAgentStatePermissionsPhase (request kind)', () => {
  it('persists request kind onto newly-created tool permission entries', () => {
    const state = createReducer();
    const changed = new Set<string>();

    const permId = 'perm-1';
    const messageId = 'msg-1';

    runAgentStatePermissionsPhase({
      state,
      agentState: {
        controlledByUser: null,
        requests: {
          [permId]: {
            tool: 'SomeNewInteractiveTool',
            kind: 'user_action',
            arguments: { q: 'hello' },
            createdAt: 1,
          },
        },
        completedRequests: null,
      },
      incomingToolIds: new Set<string>(),
      changed,
      allocateId: () => messageId,
      enableLogging: false,
    });

    const message = state.messages.get(messageId);
    expect(message?.tool?.permission?.kind).toBe('user_action');
    expect(message?.tool?.id).toBe(permId);
  });

  it('updates existing tool permission entries with request kind when available', () => {
    const state = createReducer();
    const changed = new Set<string>();

    const permId = 'perm-2';
    const messageId = 'msg-2';

    state.toolIdToMessageId.set(permId, messageId);
    state.messages.set(messageId, {
      id: messageId,
      localId: null,
      realID: null,
      seq: null,
      role: 'agent',
      createdAt: 1,
      text: null,
      event: null,
      tool: {
        name: 'SomeNewInteractiveTool',
        state: 'running',
        input: { q: 'hello' },
        createdAt: 1,
        startedAt: null,
        completedAt: null,
        description: null,
        result: undefined,
        permission: {
          id: permId,
          status: 'pending',
        },
      },
    });

    runAgentStatePermissionsPhase({
      state,
      agentState: {
        controlledByUser: null,
        requests: {
          [permId]: {
            tool: 'SomeNewInteractiveTool',
            kind: 'user_action',
            arguments: { q: 'hello' },
            createdAt: 1,
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
    expect(message?.tool?.permission?.kind).toBe('user_action');
  });

  it('backfills the permission id onto existing tool entries when missing', () => {
    const state = createReducer();
    const changed = new Set<string>();

    const permId = 'perm-3';
    const messageId = 'msg-3';

    state.toolIdToMessageId.set(permId, messageId);
    state.messages.set(messageId, {
      id: messageId,
      localId: null,
      realID: null,
      seq: null,
      role: 'agent',
      createdAt: 1,
      text: null,
      event: null,
      tool: {
        name: 'SomeNewInteractiveTool',
        state: 'running',
        input: { q: 'hello' },
        createdAt: 1,
        startedAt: null,
        completedAt: null,
        description: null,
        result: undefined,
        permission: {
          id: permId,
          status: 'pending',
        },
      },
    });

    runAgentStatePermissionsPhase({
      state,
      agentState: {
        controlledByUser: null,
        requests: {
          [permId]: {
            tool: 'SomeNewInteractiveTool',
            kind: 'user_action',
            arguments: { q: 'hello' },
            createdAt: 1,
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
    expect(message?.tool?.id).toBe(permId);
  });
});
