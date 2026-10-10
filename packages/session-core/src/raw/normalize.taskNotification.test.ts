import { describe, expect, it } from 'vitest';
import { normalizeRawMessage } from './normalize.js';
import type { RawRecord } from './schemas.js';
import { createReducer, reducer } from '../reducer/reducer.js';
import { isAsyncSubAgentLaunchToolResult } from '@happier-dev/protocol/tools/v2';

describe('typesRaw.normalizeRawMessage (task-notification)', () => {
  it.each([false, true])('routes a main-conversation native completion to its exact nested sidechain tool (before import=%s)', (beforeImport) => {
    const state = createReducer();
    const rows = [
      { type: 'assistant', uuid: 'parent-call', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'parent-tool', name: 'Agent', input: {} }] } },
      { type: 'assistant', uuid: 'nested-call', isSidechain: true, sidechainId: 'parent-tool', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'nested-tool', name: 'Agent', input: {} }] } },
      { type: 'user', uuid: 'nested-ack', isSidechain: true, sidechainId: 'parent-tool', toolUseResult: { status: 'async_launched', agentId: 'nested-agent' }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'nested-tool', content: 'Async agent launched successfully.' }] } },
      { type: 'user', uuid: 'nested-terminal-main', origin: { kind: 'task-notification', taskId: 'nested-agent', toolUseId: 'nested-tool', status: 'completed' }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'nested-tool', content: 'Nested settled outcome' }] } },
    ];
    const ordered = beforeImport ? [rows[3], ...rows.slice(0, 3)] : rows;
    const updates: ReturnType<typeof reducer>[] = [];
    ordered.forEach((data, index) => {
      const normalized = normalizeRawMessage(`nested-${index}`, null, index + 1, { role: 'agent', content: { type: 'output', data }, meta: { source: 'cli' } } as never);
      if (normalized) updates.push(reducer(state, [normalized]));
    });
    const nestedId = state.sidechainToolIdToMessageId.get('nested-tool');
    const parentId = state.toolIdToMessageId.get('parent-tool');
    expect(nestedId ? state.messages.get(nestedId)?.tool?.result : null).toBe('Nested settled outcome');
    expect(parentId ? state.messages.get(parentId)?.tool?.state : null).toBe('running');
    const publishedParents = updates.flatMap(update => update.messages).filter(message => message.kind === 'tool-call' && message.tool.id === 'parent-tool');
    expect(publishedParents.some(parent => parent.kind === 'tool-call' && parent.children.some(child => child.kind === 'tool-call' && child.tool.id === 'nested-tool' && child.tool.result === 'Nested settled outcome'))).toBe(true);
  });

  it('keeps a main result orphaned when two sibling sidechains reuse its bare tool ID in the same batch', () => {
    const state = createReducer();
    const rows = [
      { type: 'user', uuid: 'ambiguous-terminal', origin: { kind: 'task-notification', status: 'completed' }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'shared-child-tool', content: 'Ambiguous outcome' }] } },
      ...['first-parent', 'second-parent'].flatMap(sidechainId => [
        { type: 'assistant', uuid: `${sidechainId}-call`, isSidechain: true, sidechainId, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'shared-child-tool', name: 'Agent', input: {} }] } },
        { type: 'user', uuid: `${sidechainId}-ack`, isSidechain: true, sidechainId, toolUseResult: { status: 'async_launched' }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'shared-child-tool', content: 'Async agent launched successfully.' }] } },
      ]),
    ];
    const normalized = rows.map((data, index) => normalizeRawMessage(`ambiguous-${index}`, null, index + 1, { role: 'agent', content: { type: 'output', data }, meta: { source: 'cli' } } as never));
    reducer(state, normalized.filter(row => row !== null));
    expect(state.orphanToolResults.has('shared-child-tool')).toBe(true);
    for (const sidechain of state.sidechains.values()) {
      expect(sidechain.some(message => message.tool?.result === 'Ambiguous outcome')).toBe(false);
    }
  });

  it('settles only the explicitly scoped child when sibling sidechains reuse a tool ID', () => {
    const state = createReducer();
    const rows: Array<Extract<Extract<RawRecord, { role: 'agent' }>['content'], { type: 'output' }>['data']> = ['first-parent', 'second-parent'].flatMap(sidechainId => [
      { type: 'assistant', uuid: `${sidechainId}-call`, isSidechain: true, sidechainId, message: { role: 'assistant', usage: undefined, content: [{ type: 'tool_use', id: 'shared-scoped-tool', name: 'Agent', input: {} }] } },
      { type: 'user', uuid: `${sidechainId}-ack`, isSidechain: true, sidechainId, toolUseResult: { status: 'async_launched' }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'shared-scoped-tool', content: 'Async agent launched successfully.' }] } },
    ]);
    rows.push({ type: 'user', uuid: 'first-terminal', isSidechain: true, sidechainId: 'first-parent', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'shared-scoped-tool', content: 'First scoped outcome' }] } });
    rows.forEach((data, index) => {
      const normalized = normalizeRawMessage(`scoped-${index}`, null, index + 1, { role: 'agent', content: { type: 'output', data }, meta: { source: 'cli' } } as never);
      if (normalized) reducer(state, [normalized]);
    });
    expect(state.sidechains.get('first-parent')?.find(message => message.tool?.id === 'shared-scoped-tool')?.tool?.result).toBe('First scoped outcome');
    expect(isAsyncSubAgentLaunchToolResult(state.sidechains.get('second-parent')?.find(message => message.tool?.id === 'shared-scoped-tool')?.tool?.result)).toBe(true);
  });

  it.each([false, true])('does not settle an unrelated main tool from an explicitly scoped child result with the same ID (permission=%s)', (hasPermission) => {
    const state = createReducer();
    if (hasPermission) reducer(state, [], { requests: {}, completedRequests: { 'shared-main-child': { tool: 'Bash', arguments: {}, status: 'approved', createdAt: 0, completedAt: 0 } } }, [], { mainHistoryStartLoaded: true });
    const rows = [
      { type: 'assistant', uuid: 'foreground-shared', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'shared-main-child', name: 'Bash', input: {} }] } },
      { type: 'assistant', uuid: 'child-shared', isSidechain: true, sidechainId: 'parent-scope', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'shared-main-child', name: 'Agent', input: {} }] } },
      { type: 'user', uuid: 'child-shared-terminal', isSidechain: true, sidechainId: 'parent-scope', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'shared-main-child', content: 'Child outcome' }] } },
    ];
    rows.forEach((data, index) => {
      const normalized = normalizeRawMessage(`main-child-${index}`, null, index + 1, { role: 'agent', content: { type: 'output', data }, meta: { source: 'cli' } } as never);
      if (normalized) reducer(state, [normalized]);
    });
    const mainId = state.toolIdToMessageId.get('shared-main-child');
    expect(mainId ? state.messages.get(mainId)?.tool?.state : null).toBe('running');
    expect(state.sidechains.get('parent-scope')?.find(message => message.tool?.id === 'shared-main-child')?.tool?.result).toBe('Child outcome');
  });

  it('retains the existing permission mirror when a scoped child result completes the approved request', () => {
    const state = createReducer();
    reducer(state, [], { requests: {}, completedRequests: { 'mirrored-tool': {
      tool: 'Bash', arguments: {}, status: 'approved', createdAt: 1, completedAt: 2,
    } } }, [], { mainHistoryStartLoaded: true });
    const rows = [
      { type: 'assistant', uuid: 'mirror-child', isSidechain: true, sidechainId: 'mirror-parent', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'mirrored-tool', name: 'Bash', input: {} }] } },
      { type: 'user', uuid: 'mirror-result', isSidechain: true, sidechainId: 'mirror-parent', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'mirrored-tool', content: 'Mirrored outcome' }] } },
    ];
    rows.forEach((data, index) => {
      const normalized = normalizeRawMessage(`mirror-${index}`, null, index + 3, { role: 'agent', content: { type: 'output', data }, meta: { source: 'cli' } } as never);
      if (normalized) reducer(state, [normalized]);
    });
    const mainId = state.toolIdToMessageId.get('mirrored-tool');
    expect(mainId ? state.messages.get(mainId)?.tool?.result : null).toBe('Mirrored outcome');
    expect(state.sidechains.get('mirror-parent')?.find(message => message.tool?.id === 'mirrored-tool')?.tool?.result).toBe('Mirrored outcome');
  });

  it.each([true, false])('accepts native result with isMeta=%s through normalization and replaces the async ACK', (isMeta) => {
    const toolUseId = 'toolu_506';
    const output = (data: Record<string, unknown>) => ({ role: 'agent', content: { type: 'output', data }, meta: { source: 'cli' } });
    const state = createReducer();
    const rows = [
      output({ type: 'assistant', uuid: 'launch', message: { role: 'assistant', content: [{ type: 'tool_use', id: toolUseId, name: 'Agent', input: { run_in_background: true } }] } }),
      output({ type: 'user', uuid: 'ack', toolUseResult: { isAsync: true, status: 'async_launched', agentId: 'agent_506' }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'Async agent launched successfully.' }] } }),
      output({ type: 'user', uuid: 'done', isMeta, origin: { kind: 'task-notification', taskId: 'agent_506', toolUseId, status: 'completed' }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: [{ type: 'text', text: 'Findings from agent' }], is_error: false }] } }),
    ];
    rows.forEach((row, index) => {
      const normalized = normalizeRawMessage(`row-${index}`, null, 1000 + index, row as never, { seq: index + 1 });
      if (normalized) reducer(state, [normalized]);
    });
    const messageId = state.toolIdToMessageId.get(toolUseId);
    const tool = messageId ? state.messages.get(messageId)?.tool : null;
    expect(tool?.state).toBe('completed');
    expect(isAsyncSubAgentLaunchToolResult(tool?.result)).toBe(false);
    expect(tool?.result).toBe('Findings from agent');
  });

  it.each([
    { origin: undefined, content: [{ type: 'tool_result', tool_use_id: 'known', content: 'copied outcome' }] },
    { origin: { kind: 'task-notification' }, content: [{ type: 'text', text: 'metadata note' }] },
  ])('keeps unrelated metadata out of tool results', ({ origin, content }) => {
    const row = { role: 'agent', content: { type: 'output', data: { type: 'user', uuid: 'meta', isMeta: true,
      ...(origin ? { origin } : {}), message: { role: 'user', content } } }, meta: { source: 'cli' } };
    expect(normalizeRawMessage('meta', null, 1, row as never)).toBeNull();
  });

  it('drops Claude Code <task-notification> user-text messages from the main transcript', () => {
    const raw: any = {
      role: 'agent',
      content: {
        type: 'output',
        data: {
          type: 'user',
          uuid: 'uuid_task_note_1',
          parentUuid: null,
          isSidechain: false,
          origin: { kind: 'task-notification' },
          message: {
            role: 'user',
            content:
              '<task-notification>\n' +
              '<task-id>a971610</task-id>\n' +
              '<status>completed</status>\n' +
              '<summary>done</summary>\n' +
              '<result>Hello</result>\n' +
              '</task-notification>',
          },
        },
      },
      meta: { source: 'cli' },
    };

    const normalized = normalizeRawMessage('msg_task_note_1', null, 1000, raw, { seq: 5 });
    expect(normalized).toBeNull();
  });

  it('keeps ordinary user text that quotes a task notification', () => {
    const raw = { role: 'agent', content: { type: 'output', data: {
      type: 'user', uuid: 'quoted-task', message: { role: 'user', content:
        '<task-notification><task-id>known</task-id><status>completed</status><result>example</result></task-notification>' },
    } }, meta: { source: 'cli' } };
    expect(normalizeRawMessage('quoted-task', null, 1, raw as never)?.role).toBe('user');
  });

  it('keeps regular user text messages', () => {
    const raw: any = {
      role: 'agent',
      content: {
        type: 'output',
        data: {
          type: 'user',
          uuid: 'uuid_user_1',
          parentUuid: null,
          isSidechain: false,
          message: { role: 'user', content: 'hello' },
        },
      },
      meta: { source: 'cli' },
    };

    const normalized = normalizeRawMessage('msg_user_1', null, 1001, raw, { seq: 7 });
    expect(normalized).not.toBeNull();
    expect((normalized as any).seq).toBe(7);
    expect((normalized as any)?.role).toBe('user');
  });
});
