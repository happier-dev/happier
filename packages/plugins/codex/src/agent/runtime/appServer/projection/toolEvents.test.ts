import { describe, expect, it } from 'vitest';

import { createCodexAppServerToolEventProjector, projectCodexAppServerToolEventsFromNotification } from './toolEvents.js';

describe('projectCodexAppServerToolEventsFromNotification', () => {
  it('settles a yielded Script with its wait output and nested native calls', () => {
    const projector = createCodexAppServerToolEventProjector();
    const project = (method: string, item?: Record<string, unknown>) => projector.project({
      method, scopeId: 'turn', notificationParams: { item }, codeModeOnly: true,
    });
    const raw = (item: Record<string, unknown>) => project('rawResponseItem/completed', item);
    const input = 'const a = await tools.exec_command({cmd:"pwd"}); text(a.stdout.trim());';
    const events = [
      ...raw({ type: 'custom_tool_call', call_id: 'exec', name: 'exec', input }),
      ...raw({ type: 'custom_tool_call_output', call_id: 'exec', output: 'Script running with cell ID 3' }),
      ...raw({ type: 'function_call', call_id: 'wait', name: 'wait', arguments: '{"cell_id":"3"}' }),
      ...project('item/completed', { id: 'command', type: 'commandExecution', command: 'pwd', aggregatedOutput: '/work\n' }),
      ...raw({ type: 'function_call_output', call_id: 'wait', output: 'Script completed\n/work' }),
      ...project('turn/completed'),
    ];
    expect(events).toMatchObject([
      { type: 'tool-call', callId: 'exec', name: 'Script', input: { code: input, cellId: '3', language: 'javascript', origin: 'native' } },
      { type: 'tool-call', callId: 'command', name: 'Bash', sidechainId: 'exec' },
      { type: 'tool-result', callId: 'command', sidechainId: 'exec' },
      { type: 'tool-result', callId: 'exec', output: { output: 'Script completed\n/work' } },
    ]);
  });

  it.each([
    { code: 'text(6 * 7);', native: false, only: true, names: ['Script'] },
    { code: 'await tools.exec_command({cmd:"pwd"});', native: true, only: true, names: ['Bash'] },
    { code: 'await tools.exec_command({cmd:"pwd"});', native: true, only: false, names: ['Script', 'Bash'] },
    { code: 'const result = await tools.exec_command({cmd:"pwd"}); result.stdout.trim();', native: true, only: true, names: ['Script', 'Bash'] },
  ])('projects $code using the model tool mode', ({ code, native, only, names }) => {
    const projector = createCodexAppServerToolEventProjector();
    const project = (method: string, item?: Record<string, unknown>) => projector.project({
      method, scopeId: 'turn', notificationParams: { item }, codeModeOnly: only,
    });
    const events = [
      ...project('rawResponseItem/completed', { type: 'custom_tool_call', call_id: 'exec', name: 'exec', input: code }),
      ...(native ? project('item/completed', { id: 'command', type: 'commandExecution', command: 'pwd', exitCode: 0 }) : []),
      ...project('rawResponseItem/completed', { type: 'custom_tool_call_output', call_id: 'exec', output: native ? 'Script completed' : 'Script completed\n42' }),
      ...project('turn/completed'),
    ];
    expect(events.flatMap(event => event.type === 'tool-call' ? [event.name] : [])).toEqual(names);
  });

  it('parents each call across exec and wait without retaining a second top-level copy', () => {
    const projector = createCodexAppServerToolEventProjector();
    const project = (method: string, item?: Record<string, unknown>) => projector.project({
      method, scopeId: 'turn', notificationParams: { item }, codeModeOnly: true,
    });
    const raw = (item: Record<string, unknown>) => project('rawResponseItem/completed', item);
    const children = (start: number) => Array.from({ length: 10 }, (_, idx) => {
      const callId = `command-${start + idx}`;
      return project('item/completed', { id: callId, type: 'commandExecution', command: 'pwd', exitCode: 0 });
    }).flat();
    const events = [
      ...raw({ type: 'custom_tool_call', call_id: 'exec', name: 'exec', input: 'for (let i = 0; i < 20; i++) await tools.exec_command({cmd:"pwd"});' }),
      ...children(0),
      ...raw({ type: 'custom_tool_call_output', call_id: 'exec', output: 'Script running with cell ID 3' }),
      ...raw({ type: 'function_call', call_id: 'wait', name: 'wait', arguments: '{"cell_id":"3"}' }),
      ...children(10),
      ...raw({ type: 'function_call_output', call_id: 'wait', output: 'Script completed' }),
      ...project('turn/completed'),
    ];
    expect(events.filter(event => event.callId === 'exec')).toMatchObject([
      { type: 'tool-call', name: 'Script' },
      { type: 'tool-result' },
    ]);
    expect(events.filter(event => event.sidechainId === 'exec')).toHaveLength(40);
    expect(events.filter(event => event.callId !== 'exec')).toHaveLength(40);
  });

  it('flushes completed non-yielding Script before the next script and streams passThrough inner calls live before turn/completed', () => {
    const projector = createCodexAppServerToolEventProjector();
    const project = (method: string, item?: Record<string, unknown>) => projector.project({
      method, scopeId: 'turn', notificationParams: { item }, codeModeOnly: true,
    });
    const raw = (item: Record<string, unknown>) => project('rawResponseItem/completed', item);

    // 1. Non-yielding multi-line script completes immediately on custom_tool_call_output (before turn/completed).
    expect(raw({ type: 'custom_tool_call', call_id: 'exec-1', name: 'exec', input: 'text(6 * 7);' })).toEqual([]);
    const firstDone = raw({ type: 'custom_tool_call_output', call_id: 'exec-1', output: 'Script completed\n42' });
    expect(firstDone).toMatchObject([
      { type: 'tool-call', callId: 'exec-1', name: 'Script' },
      { type: 'tool-result', callId: 'exec-1', output: { output: 'Script completed\n42' } },
    ]);

    // 2. Single-call passThrough script emits its inner tool-call immediately on item/started so live approvals render.
    expect(raw({ type: 'custom_tool_call', call_id: 'exec-2', name: 'exec', input: 'await tools.exec_command({cmd:"pwd"});' })).toEqual([]);
    const liveInner = project('item/started', { id: 'cmd-live', type: 'commandExecution', command: 'pwd' });
    expect(liveInner).toMatchObject([{ type: 'tool-call', callId: 'cmd-live', name: 'Bash', sidechainId: null }]);
    const liveResult = project('item/completed', { id: 'cmd-live', type: 'commandExecution', command: 'pwd', exitCode: 0 });
    expect(liveResult).toMatchObject([{ type: 'tool-result', callId: 'cmd-live', sidechainId: null }]);
    expect(raw({ type: 'custom_tool_call_output', call_id: 'exec-2', output: 'Script completed' })).toEqual([]);
    expect(project('turn/completed')).toEqual([]);
  });

  it.each([
    { id: 'activity', type: 'subAgentActivity', kind: 'interacted', agentThreadId: 'child' },
    { id: 'collab', type: 'collabAgentToolCall', tool: 'send_input', status: 'completed', agentsStates: { child: { status: 'running' } } },
    { id: 'dynamic', type: 'dynamicToolCall', tool: 'lookup', arguments: { query: 'facts' }, contentItems: [{ type: 'text', text: 'found' }], success: false },
  ])('projects native $type through the shared history and live owner', item => {
    const projected = projectCodexAppServerToolEventsFromNotification({ method: 'item/completed', notificationParams: { item } });
    expect(projected).toMatchObject([
      { type: 'tool-call', callId: item.id, name: item.type === 'subAgentActivity' ? item.type : item.tool },
      { type: 'tool-result', callId: item.id },
    ]);
    const scoped = createCodexAppServerToolEventProjector();
    const notify = (method: string) => scoped.project({ scopeId: 'turn', method, notificationParams: { item } });
    expect(notify('item/started')).toEqual([projected[0]]);
    expect(notify('item/completed')).toEqual([projected[1]]);
    expect(notify('item/completed')).toEqual([]);
    if (item.type === 'dynamicToolCall') expect(projected[1]).toMatchObject({ isError: true, output: { contentItems: item.contentItems } });
    if (item.type === 'subAgentActivity') expect(projected[0]).toMatchObject({ input: { kind: item.kind, agentThreadId: item.agentThreadId } });
  });

  // Shapes generated by codex-cli 0.162.1 app-server generate-ts.
  it('projects native web searches, image views and sleeps through history and scoped live events', () => {
    const action = { type: 'search', query: 'fused kernels', queries: ['fused kernels'] };
    const results = [{ title: 'Fusion benchmark', url: 'https://example.invalid/bench', snippet: 'Compared.' }];
    const search = { id: 'search', type: 'webSearch', query: 'fused kernels', action, results };
    const view = { id: 'view', type: 'imageView', path: '/repo/plot.png' };
    const sleep = { id: 'sleep', type: 'sleep', durationMs: 30_000 };
    const project = (method: string, item: Record<string, unknown>) => projectCodexAppServerToolEventsFromNotification({
      method, notificationParams: { item },
    });
    expect(project('item/started', { ...search, query: '', action: null, results: null })).toEqual([]);
    for (const [item, name, input, output] of [
      [search, 'WebSearch', { query: search.query, action }, { results }],
      [view, 'view_image', { path: view.path }, {}],
      [sleep, 'sleep', { durationMs: sleep.durationMs }, {}],
    ] as const) {
      const call = { type: 'tool-call', callId: item.id, name, input, sidechainId: null };
      const result = { type: 'tool-result', callId: item.id, output, sidechainId: null };
      expect(project('item/completed', item)).toEqual([call, result]);
      const scoped = createCodexAppServerToolEventProjector();
      const notify = (method: string, value: Record<string, unknown>) => scoped.project({
        scopeId: 'turn', method, notificationParams: { item: value },
      });
      expect(notify('item/started', item)).toEqual(item.type === 'webSearch' ? [] : [call]);
      expect(notify('item/completed', item)).toEqual(item.type === 'webSearch' ? [call, result] : [result]);
      expect(notify('item/completed', item)).toEqual([]);
    }
    expect(project('item/completed', { ...search, action: null, results: null })[1])
      .toMatchObject({ output: { results: null } });
    expect(project('item/completed', { type: 'webSearch', query: 'missing identity', action, results })).toEqual([]);
  });

  it('preserves native aggregated command output as stdout without treating it as input', () => {
    const events = projectCodexAppServerToolEventsFromNotification({ method: 'item/completed', notificationParams: {
      item: { id: 'native-command', type: 'commandExecution', command: 'pwd', aggregatedOutput: '/repo\n', exitCode: 0 },
    } });
    expect(events).toEqual([
      expect.objectContaining({ type: 'tool-call', input: { cmd: 'pwd' } }),
      expect.objectContaining({ type: 'tool-result', output: expect.objectContaining({ stdout: '/repo\n', exitCode: 0 }) }),
    ]);
  });

  it('preserves native code-mode input without relabeling an app-server call as terminal control', () => {
    const input = 'const r = await tools.exec_command({cmd:"pwd"}); text(r);';
    expect(projectCodexAppServerToolEventsFromNotification({ method: 'rawResponseItem/completed', notificationParams: {
      item: { type: 'custom_tool_call', call_id: 'call-code-mode', name: 'exec', input },
    } })).toEqual([{ type: 'tool-call', callId: 'call-code-mode', name: 'exec', input, sidechainId: null }]);
  });
    it('restores exact SDK MCP wire keys after native key sanitization and collision suffixing', () => {
        const mcpServerKeys = new Map([['happier', 'happier'], ['first__team', 'happier__first_team'], ['first_team', 'happier__first_team_2']]);
        for (const [wireKey, nativeKey] of mcpServerKeys) {
            const events = projectCodexAppServerToolEventsFromNotification({ method: 'item/started', mcpServerKeys,
                notificationParams: { item: { id: nativeKey, type: 'mcpToolCall', server: nativeKey, tool: 'tool__with__segments', arguments: {} } } });
            expect(events[0]).toMatchObject({ name: `mcp__${wireKey}__tool__with__segments` });
        }
    });
  it('projects app-server command executions while preserving command context', () => {
    expect(projectCodexAppServerToolEventsFromNotification({
      method: 'item/started',
      notificationParams: {
        item: {
          id: 'cmd_1',
          type: 'commandExecution',
          command: 'pwd',
          cwd: '/repo',
        },
      },
    })).toEqual([
      {
        type: 'tool-call',
        callId: 'cmd_1',
        name: 'Bash',
        input: {
          cmd: 'pwd',
          cwd: '/repo',
        },
        sidechainId: null,
      },
    ]);

    expect(projectCodexAppServerToolEventsFromNotification({
      method: 'item/completed',
      notificationParams: {
        item: {
          id: 'cmd_1',
          type: 'commandExecution',
          command: 'pwd',
          cwd: '/repo',
          stdout: '/repo\n',
          exitCode: 0,
        },
      },
    })).toEqual([
      {
        type: 'tool-call',
        callId: 'cmd_1',
        name: 'Bash',
        input: {
          cmd: 'pwd',
          cwd: '/repo',
        },
        sidechainId: null,
      },
      {
        type: 'tool-result',
        callId: 'cmd_1',
        output: {
          id: 'cmd_1',
          type: 'commandExecution',
          command: 'pwd',
          cwd: '/repo',
          stdout: '/repo\n',
          exitCode: 0,
        },
        sidechainId: null,
        isError: false,
      },
    ]);
  });

  it('projects app-server MCP tool calls and results as canonical runtime tool events', () => {
    expect(projectCodexAppServerToolEventsFromNotification({
      method: 'item/started',
      notificationParams: {
        item: {
          id: 'tool_1',
          type: 'mcpToolCall',
          server: 'playwright',
          tool: 'browser_navigate',
          arguments: { url: 'https://example.com' },
        },
      },
    })).toEqual([
      {
        type: 'tool-call',
        callId: 'tool_1',
        name: 'mcp__playwright__browser_navigate',
        input: { url: 'https://example.com' },
        sidechainId: null,
      },
    ]);

    expect(projectCodexAppServerToolEventsFromNotification({
      method: 'item/started',
      notificationParams: {
        item: {
          id: 'title_1',
          type: 'mcpToolCall',
          server: 'happier__happier',
          tool: 'change_title',
          arguments: { title: 'Normalized title' },
        },
      },
    })).toEqual([
      {
        type: 'tool-call',
        callId: 'title_1',
        name: 'mcp__happier__change_title',
        input: { title: 'Normalized title' },
        sidechainId: null,
      },
    ]);

    expect(projectCodexAppServerToolEventsFromNotification({
      method: 'item/completed',
      notificationParams: {
        item: {
          id: 'tool_1',
          type: 'mcpToolCall',
          result: { Ok: { status: 'ok' } },
        },
      },
    })).toEqual([
      {
        type: 'tool-result',
        callId: 'tool_1',
        output: { status: 'ok' },
        sidechainId: null,
      },
    ]);

    expect(projectCodexAppServerToolEventsFromNotification({
      method: 'item/completed',
      notificationParams: {
        item: {
          id: 'title_1',
          type: 'mcpToolCall',
          result: { output: { title: 'Normalized title' } },
        },
      },
    })).toEqual([
      {
        type: 'tool-result',
        callId: 'title_1',
        output: { title: 'Normalized title' },
        sidechainId: null,
      },
    ]);
  });

  it('projects app-server namespaced MCP tool calls through the rollout MCP name rules', () => {
    expect(projectCodexAppServerToolEventsFromNotification({
      method: 'item/started',
      notificationParams: {
        item: {
          id: 'tool_namespace_1',
          type: 'mcpToolCall',
          namespace: 'mcp__node_repl',
          name: 'js',
          arguments: { code: 'nodeRepl.write(1)' },
        },
      },
    })).toEqual([
      {
        type: 'tool-call',
        callId: 'tool_namespace_1',
        name: 'mcp__node_repl__js',
        input: { code: 'nodeRepl.write(1)' },
        sidechainId: null,
      },
    ]);
  });

  it('projects injected Happier MCP server names through the shared rollout MCP name rules', () => {
    expect(projectCodexAppServerToolEventsFromNotification({
      method: 'item/started',
      notificationParams: {
        item: {
          id: 'tool_happier_context7_1',
          type: 'mcpToolCall',
          server: 'happier__context7',
          tool: 'resolve-library-id',
          arguments: { libraryName: 'react' },
        },
      },
    })).toEqual([
      {
        type: 'tool-call',
        callId: 'tool_happier_context7_1',
        name: 'mcp__happier__context7__resolve-library-id',
        input: { libraryName: 'react' },
        sidechainId: null,
      },
    ]);
  });

  it('projects app-server file changes as canonical patch tool events', () => {
    const changes = [
      {
        path: 'src/file.ts',
        kind: { type: 'update', move_path: null },
        diff: '@@ -1 +1,2 @@\n-old line\n+old line\n+new line\n',
      },
    ];

    expect(projectCodexAppServerToolEventsFromNotification({
      method: 'item/started',
      notificationParams: {
        item: {
          id: 'patch_1',
          type: 'fileChange',
          auto_approved: true,
          changes,
        },
      },
    })).toEqual([
      {
        type: 'tool-call',
        callId: 'patch_1',
        name: 'Patch',
        input: {
          auto_approved: true,
          changes,
        },
        sidechainId: null,
      },
    ]);

    expect(projectCodexAppServerToolEventsFromNotification({
      method: 'item/completed',
      notificationParams: {
        item: {
          id: 'patch_1',
          type: 'fileChange',
          stdout: 'patched',
          success: true,
        },
      },
    })).toEqual([
      {
        type: 'tool-result',
        callId: 'patch_1',
        output: {
          stdout: 'patched',
          success: true,
        },
        sidechainId: null,
      },
    ]);
  });
});
