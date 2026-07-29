import { describe, expect, it } from 'vitest';
import { createReducer } from '../reducer';
import { runAgentStatePermissionsPhase } from './agentStatePermissions';

describe('runAgentStatePermissionsPhase (request kind)', () => {
  it('retires a completed source-owned question and preserves its submitted answer', () => {
    const state = createReducer();
    const changed = new Set<string>();
    const requestId = 'claude-dialog-choice-1';
    const messageId = 'claude-dialog-message-1';
    const question = 'Yes, I trust this folder';

    runAgentStatePermissionsPhase({
      state,
      agentState: {
        controlledByUser: null,
        requests: {
          [requestId]: {
            tool: 'AskUserQuestion',
            kind: 'user_action',
            source: 'claude_unified_terminal_dialog_choice',
            arguments: {
              questions: [{
                header: 'Claude needs attention',
                question,
                options: [],
                multiSelect: false,
              }],
            },
            createdAt: 100,
          },
        },
        completedRequests: null,
      },
      incomingToolIds: new Set<string>(),
      changed,
      allocateId: () => messageId,
      enableLogging: false,
    });

    changed.clear();
    runAgentStatePermissionsPhase({
      state,
      agentState: {
        controlledByUser: null,
        requests: {},
        completedRequests: {
          [requestId]: {
            tool: 'AskUserQuestion',
            kind: 'user_action',
            source: 'claude_unified_terminal_dialog_choice',
            arguments: {
              questions: [{
                header: 'Claude needs attention',
                question,
                options: [],
                multiSelect: false,
              }],
            },
            createdAt: 100,
            completedAt: 200,
            status: 'approved',
            answers: { [question]: 'trust_once' },
            dialogId: 'trust_folder',
            dialogChoice: 'trust_once',
          },
        },
      },
      incomingToolIds: new Set<string>(),
      changed,
      allocateId: () => 'unexpected-message',
      enableLogging: false,
    });

    expect(state.messages.get(messageId)?.tool).toMatchObject({
      state: 'completed',
      completedAt: 200,
      permission: {
        id: requestId,
        kind: 'user_action',
        status: 'approved',
      },
      result: { answers: { [question]: 'trust_once' } },
    });
  });

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

  it('does not suppress a same-id pending request when the completed entry has different arguments', () => {
    const state = createReducer();
    const changed = new Set<string>();

    const permId = 'perm-retry';
    const messageId = 'msg-retry';

    runAgentStatePermissionsPhase({
      state,
      agentState: {
        controlledByUser: null,
        requests: {
          [permId]: {
            tool: 'Bash',
            kind: 'permission',
            arguments: { command: 'pwd' },
            createdAt: 10,
          },
        },
        completedRequests: {
          [permId]: {
            tool: 'Bash',
            kind: 'permission',
            arguments: { command: 'ls' },
            createdAt: 1,
            completedAt: 20,
            status: 'approved',
          },
        },
      },
      incomingToolIds: new Set<string>(),
      changed,
      allocateId: () => messageId,
      enableLogging: false,
    });

    const message = state.messages.get(messageId);
    expect(message?.tool?.permission?.status).toBe('pending');
    expect(message?.tool?.input).toEqual({ command: 'pwd' });
    expect(changed.has(messageId)).toBe(true);
  });
});
