import { describe, expect, it } from 'vitest';
import { createReducer } from "../reducer.js";
import { runAgentStatePermissionsPhase } from "./agentStatePermissions.js";
import { applyToolResultUpdateToReducerMessage } from "../helpers/applyToolResultUpdateToReducerMessage.js";
import { buildToolPermissionFromStored } from '../helpers/toolCallProjection.js';
import { collectTranscriptRequestStates, type TranscriptRequestState } from '../../pending/listPendingRequests.js';

describe('runAgentStatePermissionsPhase (request kind)', () => {
  it('keeps the question answering actor separate from the worker and ignores actor labels inside the answer', () => {
    const state = createReducer();
    const changed = new Set<string>();
    const request = { tool: 'AskUserQuestion', kind: 'user_action', createdAt: 100,
      arguments: { questions: [{ question: 'Revision?' }], answeredBy: { kind: 'session', sessionId: 'forged' } } };
    const run = (answeredBy?: { kind: 'session'; sessionId: string } | { kind: 'person'; accountId?: string }) => runAgentStatePermissionsPhase({ state,
      agentState: { requests: {}, completedRequests: { question: { ...request, status: 'approved', completedAt: 200,
        structuredAnswersV1: { 'Revision?': ['3'] }, ...(answeredBy ? { answeredBy } : {}) } } },
      incomingToolIds: new Set<string>(), mainHistoryStartLoaded: true, changed, allocateId: () => 'question-message', enableLogging: false });
    run();
    const message = state.messages.get('question-message')!;
    const cause = { requestRef: 'bob-input', requester: { serverId: 'home', accountId: 'bob' },
      persona: { serverId: 'home', sessionId: 'worker' }, origin: null };
    message.meta = { actionRequestAttributionV1: cause };
    expect(message.tool?.permission).not.toHaveProperty('answeredBy');
    // Terminal provider results may precede the host's completed disposition.
    message.tool!.startedAt = 150;
    message.tool!.permission!.date = 210;
    changed.clear();
    run({ kind: 'session', sessionId: 'manager' });
    expect(message.tool?.permission).toMatchObject({ answeredBy: { kind: 'session', sessionId: 'manager' } });
    expect(message.tool?.result).toEqual({ answers: { 'Revision?': '3' } });
    expect(message.meta?.actionRequestAttributionV1).toBe(cause);
    expect(buildToolPermissionFromStored('question', state.permissions.get('question')!))
      .toMatchObject({ answeredBy: { kind: 'session', sessionId: 'manager' } });
    expect(changed.has('question-message')).toBe(true);
    changed.clear();
    run({ kind: 'session', sessionId: 'manager' });
    expect(changed.size).toBe(0);
    // An authoritative refresh is not a Session-global last answerer.
    run({ kind: 'person' });
    expect(message.tool?.permission).toMatchObject({ answeredBy: { kind: 'person' } });
    run({ kind: 'person', accountId: 'bob' });
    expect(message.tool?.permission).toMatchObject({ answeredBy: { kind: 'person', accountId: 'bob' } });
    expect(message.meta?.actionRequestAttributionV1).toBe(cause);
    run();
    expect(message.tool?.permission).not.toHaveProperty('answeredBy');
  });
  it('retains the request source through transcript-only projection and clears it on an authoritative refresh', () => {
    const state = createReducer();
    const changed = new Set<string>();
    const run = (source?: string) => runAgentStatePermissionsPhase({ state,
      agentState: { requests: { edit: { tool: 'Edit', arguments: {}, createdAt: 1, turnId: 'turn-first', ...(source ? { source } : {}) } } },
      incomingToolIds: new Set<string>(), changed, allocateId: () => 'edit-message', enableLogging: false });
    run('native_tool_approval_once');
    expect(state.messages.get('edit-message')?.tool?.permission).toMatchObject({ source: 'native_tool_approval_once', turnId: 'turn-first' });
    expect(buildToolPermissionFromStored('edit', state.permissions.get('edit')!)).toMatchObject({ source: 'native_tool_approval_once' });
    const tool = state.messages.get('edit-message')!.tool!;
    const transcriptStates = new Map<string, TranscriptRequestState>();
    collectTranscriptRequestStates([{ kind: 'tool-call', id: 'edit-message', localId: null, createdAt: 1, tool, children: [] }], null, transcriptStates);
    expect(transcriptStates.get('edit')?.request).toMatchObject({ source: 'native_tool_approval_once', turnId: 'turn-first' });
    changed.clear();
    run('native_tool_approval_once');
    expect(changed.size).toBe(0);
    run();
    expect(state.messages.get('edit-message')?.tool?.permission).not.toHaveProperty('source', 'native_tool_approval_once');
    expect(buildToolPermissionFromStored('edit', state.permissions.get('edit')!)).not.toHaveProperty('source', 'native_tool_approval_once');
    expect(changed.has('edit-message')).toBe(true);
  });
  it('retains exact pending turn custody through projection, refresh, and stored reconstruction', () => {
    const state = createReducer();
    const changed = new Set<string>();
    const run = (turnId?: string) => runAgentStatePermissionsPhase({ state,
      agentState: { requests: { edit: { tool: 'Edit', arguments: {}, createdAt: 1, ...(turnId ? { turnId } : {}) } } },
      incomingToolIds: new Set<string>(), changed, allocateId: () => 'edit-message', enableLogging: false });
    run('turn-first');
    expect(state.messages.get('edit-message')?.tool?.permission).toMatchObject({ turnId: 'turn-first' });
    expect(buildToolPermissionFromStored('edit', state.permissions.get('edit')!)).toMatchObject({ turnId: 'turn-first' });
    const tool = state.messages.get('edit-message')!.tool!;
    const transcriptStates = new Map<string, TranscriptRequestState>();
    collectTranscriptRequestStates([{ kind: 'tool-call', id: 'edit-message', localId: null,
      createdAt: 1, tool, children: [] }], null, transcriptStates);
    expect(transcriptStates.get('edit')?.request).toMatchObject({ turnId: 'turn-first' });
    changed.clear();
    run('turn-next');
    expect(state.messages.get('edit-message')?.tool?.permission).toMatchObject({ turnId: 'turn-next' });
    expect(changed.has('edit-message')).toBe(true);
    changed.clear();
    run('turn-next');
    expect(changed.size).toBe(0);
    run();
    expect(state.messages.get('edit-message')?.tool?.permission?.turnId).toBeUndefined();
    expect(buildToolPermissionFromStored('edit', state.permissions.get('edit')!).turnId).toBeUndefined();
  });
  it('keeps the nonhuman approval actor when execution has already started', () => {
    const state = createReducer();
    const changed = new Set<string>();
    const completed = { tool: 'Read', arguments: { path: '/workspace/README.md' }, createdAt: 100, completedAt: 200,
      status: 'approved' as const, decision: 'approved' as const,
      permissionDecisionClaimV1: { version: 1 as const, origin: 'approvalReviewer' as const, scope: 'request' as const, decision: 'approved' as const }, permissionDecisionActorV1: { kind: 'approvalReviewer' } };
    const run = () => runAgentStatePermissionsPhase({ state,
      agentState: { controlledByUser: null, requests: {}, completedRequests: { read: completed } },
      incomingToolIds: new Set<string>(), mainHistoryStartLoaded: true, changed, allocateId: () => 'read-message', enableLogging: false });
    run();
    const tool = state.messages.get('read-message')!.tool!;
    tool.startedAt = 150;
    delete tool.permission!.decisionActor;
    changed.clear();
    run();
    expect(tool.permission).toMatchObject({ decisionActor: { kind: 'approvalReviewer' } });
    expect(changed.has('read-message')).toBe(true);
    applyToolResultUpdateToReducerMessage({ message: state.messages.get('read-message')!, messageId: 'read-message',
      toolResult: { tool_use_id: 'read', content: 'contents', is_error: false, permissions: { result: 'approved', date: 210 } }, resultCreatedAt: 220, changed });
    expect(tool.permission?.decisionActor).toEqual({ kind: 'approvalReviewer' });
  });
  it('projects persisted structured answers onto the original completed question', () => {
    const state = createReducer();
    const changed = new Set<string>();
    const requestId = 'codex-question-1';
    const questions = [
      { header: 'Question 1', question: 'Pick one', options: [], multiSelect: false },
      { header: 'Question 2', question: 'Add context', options: [], multiSelect: false },
    ];
    const request = { tool: 'AskUserQuestion', kind: 'user_action' as const, arguments: { questions }, createdAt: 100 };
    runAgentStatePermissionsPhase({
      state, agentState: { controlledByUser: null, requests: { [requestId]: request }, completedRequests: null },
      incomingToolIds: new Set<string>(), changed, allocateId: () => 'question-message', enableLogging: false,
    });
    runAgentStatePermissionsPhase({
      state,
      agentState: {
        controlledByUser: null, requests: {},
        completedRequests: { [requestId]: {
          ...request, completedAt: 200, status: 'approved',
          structuredAnswersV1: { 'Pick one': ['Option B'], 'Add context': ['lorem ipsum'] },
        } },
      },
      incomingToolIds: new Set<string>(), changed, allocateId: () => 'unexpected', enableLogging: false,
    });

    expect(state.messages.get('question-message')?.tool?.result).toEqual({
      answers: { 'Pick one': 'Option B', 'Add context': 'lorem ipsum' },
    });
  });

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
