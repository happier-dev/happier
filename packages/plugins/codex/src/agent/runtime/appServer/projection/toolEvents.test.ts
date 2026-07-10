import { describe, expect, it } from 'vitest';

import { projectCodexAppServerToolEventsFromNotification } from './toolEvents.js';

describe('projectCodexAppServerToolEventsFromNotification', () => {
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
