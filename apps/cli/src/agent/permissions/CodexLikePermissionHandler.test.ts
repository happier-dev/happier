import { describe, expect, it, vi } from 'vitest';

import { CodexLikePermissionHandler } from './CodexLikePermissionHandler';

class FakeRpcHandlerManager {
  handlers = new Map<string, (payload: any) => any>();
  registerHandler(_name: string, handler: any) {
    this.handlers.set(_name, handler);
  }
}

class FakeSession {
  sessionId = 'session-test';
  rpcHandlerManager = new FakeRpcHandlerManager();
  agentState: any = { requests: {}, completedRequests: {} };
  metadata: any = null;

  getAgentStateSnapshot() {
    return this.agentState;
  }

  updateAgentState(updater: any) {
    this.agentState = updater(this.agentState);
    return this.agentState;
  }

  getMetadataSnapshot() {
    return this.metadata;
  }

  setMetadataSnapshot(next: any) {
    this.metadata = next;
  }
}

describe('CodexLikePermissionHandler', () => {
  it('hard-denies write-like tools in read-only mode', async () => {
    const session = new FakeSession();
    const handler = new CodexLikePermissionHandler({ session: session as any, logPrefix: '[Test]' });
    handler.setPermissionMode('read-only');

    const result = await handler.handleToolCall('tool-1', 'Write', { path: '/tmp/x', content: 'hi' });
    expect(result.decision).toBe('denied');

    expect(session.agentState.requests).toEqual({});
    expect(session.agentState.completedRequests['tool-1']).toEqual(
      expect.objectContaining({
        tool: 'Write',
        status: 'denied',
        decision: 'denied',
      }),
    );
  });

  it('hard-denies write-like tools in plan mode', async () => {
    const session = new FakeSession();
    const handler = new CodexLikePermissionHandler({ session: session as any, logPrefix: '[Test]' });
    handler.setPermissionMode('plan');

    const promise = handler.handleToolCall('tool-1', 'Write', { path: '/tmp/x', content: 'hi' });

    const hasPrompted = Boolean(session.agentState.requests['tool-1']);
    if (hasPrompted) {
      // Resolve the pending request so the test doesn't hang on failure.
      const rpc = session.rpcHandlerManager.handlers.get('permission');
      await rpc!({ id: 'tool-1', approved: false, decision: 'denied' });
    }

    const result = await promise;
    expect(hasPrompted).toBe(false);
    expect(result.decision).toBe('denied');
  });

  it('does not auto-approve AskUserQuestion in plan mode', async () => {
    const session = new FakeSession();
    const handler = new CodexLikePermissionHandler({ session: session as any, logPrefix: '[Test]' });
    handler.setPermissionMode('plan');

    const promise = handler.handleToolCall('tool-ask', 'AskUserQuestion', {
      questions: [
        {
          header: 'Export Shape',
          question: 'Which session export behavior should the plan target?',
          options: [{ label: 'Single JSON', description: 'Portable JSON export' }],
          multiSelect: false,
        },
      ],
    });

    expect(session.agentState.requests['tool-ask']).toEqual(
      expect.objectContaining({
        tool: 'AskUserQuestion',
        kind: 'user_action',
      }),
    );

    const rpc = session.rpcHandlerManager.handlers.get('permission');
    expect(rpc).toBeDefined();
    await rpc!({
      id: 'tool-ask',
      approved: true,
      answers: {
        'Which session export behavior should the plan target?': 'Single JSON',
      },
    });

    await expect(promise).resolves.toEqual({
      decision: 'approved',
      answers: {
        'Which session export behavior should the plan target?': 'Single JSON',
      },
    });
  });

  it('prompts for write-like tools in safe-yolo mode', async () => {
    const session = new FakeSession();
    const handler = new CodexLikePermissionHandler({ session: session as any, logPrefix: '[Test]' });
    handler.setPermissionMode('safe-yolo');

    const promise = handler.handleToolCall('tool-1', 'Write', { path: '/tmp/x', content: 'hi' });

    expect(session.agentState.requests['tool-1']).toEqual(
      expect.objectContaining({
        tool: 'Write',
      }),
    );

    const rpc = session.rpcHandlerManager.handlers.get('permission');
    expect(rpc).toBeDefined();
    await rpc!({ id: 'tool-1', approved: true, decision: 'approved' });

    const result = await promise;
    expect(result.decision).toBe('approved');
  });

  it('resolves every compatible duplicate request id from one permission response', async () => {
    const session = new FakeSession();
    const handler = new CodexLikePermissionHandler({ session: session as any, logPrefix: '[Test]' });
    handler.setPermissionMode('safe-yolo');

    const input = { path: '/tmp/x', content: 'hi' };
    const first = handler.handleToolCall('tool-duplicate', 'Write', input);
    const second = handler.handleToolCall('tool-duplicate', 'Write', input);

    expect(Object.keys(session.agentState.requests)).toEqual(['tool-duplicate']);

    const rpc = session.rpcHandlerManager.handlers.get('permission');
    expect(rpc).toBeDefined();
    await rpc!({ id: 'tool-duplicate', approved: true, decision: 'approved' });

    const firstState = await Promise.race([
      first.then((value) => ({ status: 'resolved' as const, value })),
      new Promise<{ status: 'timeout' }>((resolve) => setTimeout(() => resolve({ status: 'timeout' }), 20)),
    ]);
    const secondState = await Promise.race([
      second.then((value) => ({ status: 'resolved' as const, value })),
      new Promise<{ status: 'timeout' }>((resolve) => setTimeout(() => resolve({ status: 'timeout' }), 20)),
    ]);

    expect(firstState).toEqual({ status: 'resolved', value: { decision: 'approved' } });
    expect(secondState).toEqual({ status: 'resolved', value: { decision: 'approved' } });
    expect(session.agentState.requests['tool-duplicate']).toBeUndefined();
    expect(session.agentState.completedRequests['tool-duplicate']).toEqual(
      expect.objectContaining({
        tool: 'Write',
        status: 'approved',
        decision: 'approved',
      }),
    );
  });

  it('keeps the original pending request live when the same id is retried with different input', async () => {
    const session = new FakeSession();
    const handler = new CodexLikePermissionHandler({ session: session as any, logPrefix: '[Test]' });

    const first = handler.handleToolCall('tool-duplicate', 'Write', {
      path: '/tmp/original',
      content: 'hi',
    });

    expect(session.agentState.requests['tool-duplicate']).toEqual(
      expect.objectContaining({
        tool: 'Write',
        arguments: { path: '/tmp/original', content: 'hi' },
      }),
    );

    const second = handler.handleToolCall('tool-duplicate', 'Write', {
      path: '/tmp/other',
      content: 'bye',
    });

    await expect(second).rejects.toBeInstanceOf(Error);
    expect(session.agentState.requests['tool-duplicate']).toEqual(
      expect.objectContaining({
        tool: 'Write',
        arguments: { path: '/tmp/original', content: 'hi' },
      }),
    );

    handler.setPermissionMode('read-only', 10);

    await expect(first).resolves.toEqual({ decision: 'denied' });
    expect(session.agentState.requests['tool-duplicate']).toBeUndefined();
    expect(session.agentState.completedRequests['tool-duplicate']).toEqual(
      expect.objectContaining({
        tool: 'Write',
        status: 'denied',
        decision: 'denied',
      }),
    );
  });

  it('auto-approves write-like tools in yolo mode', async () => {
    const session = new FakeSession();
    const handler = new CodexLikePermissionHandler({ session: session as any, logPrefix: '[Test]' });
    handler.setPermissionMode('yolo');

    const result = await handler.handleToolCall('tool-1', 'Write', { path: '/tmp/x', content: 'hi' });
    expect(result.decision).toBe('approved_for_session');
  });

  it('auto-approves write-like tools in bypassPermissions mode', async () => {
    const session = new FakeSession();
    const handler = new CodexLikePermissionHandler({ session: session as any, logPrefix: '[Test]' });
    handler.setPermissionMode('bypassPermissions');

    const result = await handler.handleToolCall('tool-1', 'Write', { path: '/tmp/x', content: 'hi' });
    expect(result.decision).toBe('approved_for_session');
  });

  it('auto-approves session_title_set in default mode without prompting', async () => {
    const session = new FakeSession();
    const handler = new CodexLikePermissionHandler({ session: session as any, logPrefix: '[Test]' });

    const result = await handler.handleToolCall('tool-1', 'mcp__happier__session_title_set', { title: 'Renamed' });

    expect(result.decision).toBe('approved');
    expect(session.agentState.requests['tool-1']).toBeUndefined();
    expect(session.agentState.completedRequests['tool-1']).toEqual(
      expect.objectContaining({
        tool: 'mcp__happier__session_title_set',
        status: 'approved',
        decision: 'approved',
      }),
    );
  });

  it('suppresses provider prompts for Happier MCP tools only when Happier approval is required', async () => {
    const session = new FakeSession();
    const handler = new CodexLikePermissionHandler({
      session: session as any,
      logPrefix: '[Test]',
      getAccountSettings: () => ({
        actionsSettingsV1: {
          v: 1,
          actions: {
            'session.list': {
              disabledSurfaces: [],
              approvalRequiredSurfaces: ['agent'],
            },
          },
        },
      } as any),
    });

    await expect(handler.handleToolCall('list-1', 'mcp__happier__session_list', {})).resolves.toEqual({
      decision: 'approved',
    });
    expect(session.agentState.requests['list-1']).toBeUndefined();

    const pending = handler.handleToolCall('status-1', 'happier_action_execute', { actionId: 'session.status.get' });
    expect(session.agentState.requests['status-1']).toEqual(
      expect.objectContaining({ tool: 'happier_action_execute' }),
    );
    const rpc = session.rpcHandlerManager.handlers.get('permission');
    await rpc!({ id: 'status-1', approved: false, decision: 'denied' });
    await expect(pending).resolves.toEqual({ decision: 'denied' });
  });

  it('denies session_title_set when coding prompt title updates are disabled', async () => {
    const session = new FakeSession();
    const handler = new CodexLikePermissionHandler({
      session: session as any,
      logPrefix: '[Test]',
      getAccountSettings: () => ({
        codingPromptBehaviorV1: {
          v: 1,
          sessionTitleUpdates: 'disabled',
          responseOptions: 'agent',
        },
      } as any),
    });

    const result = await handler.handleToolCall('tool-1', 'mcp__happier__session_title_set', { title: 'Renamed' });

    expect(result.decision).toBe('denied');
    expect(session.agentState.requests['tool-1']).toBeUndefined();
    expect(session.agentState.completedRequests['tool-1']).toEqual(
      expect.objectContaining({
        tool: 'mcp__happier__session_title_set',
        status: 'denied',
        decision: 'denied',
      }),
    );
  });

  it('denies Happier shell-bridge title calls when coding prompt title updates are disabled', async () => {
    const session = new FakeSession();
    const handler = new CodexLikePermissionHandler({
      session: session as any,
      logPrefix: '[Test]',
      getAccountSettings: () => ({
        codingPromptBehaviorV1: {
          v: 1,
          sessionTitleUpdates: 'disabled',
          responseOptions: 'agent',
        },
      } as any),
    });

    const result = await handler.handleToolCall('tool-1', 'Bash', {
      command:
        `happier tools call --session-id cmmfivqgm002d8o1ug15b02o1 --directory /tmp/workspace ` +
        `--source happier --tool change_title --args-json '{"title":"Blocked"}' --json`,
    });

    expect(result.decision).toBe('denied');
    expect(session.agentState.requests['tool-1']).toBeUndefined();
    expect(session.agentState.completedRequests['tool-1']).toEqual(
      expect.objectContaining({
        tool: 'Bash',
        status: 'denied',
        decision: 'denied',
      }),
    );
  });

  it('treats setPermissionMode without updatedAt as provisional when newer metadata exists', async () => {
    const session = new FakeSession();
    session.setMetadataSnapshot({ permissionMode: 'yolo', permissionModeUpdatedAt: 10 });
    const handler = new CodexLikePermissionHandler({ session: session as any, logPrefix: '[Test]' });

    handler.setPermissionMode('read-only');
    const result = await handler.handleToolCall('tool-1', 'Write', { path: '/tmp/x', content: 'hi' });

    expect(result.decision).toBe('approved_for_session');
  });

  it('does not let older metadata override an explicit newer setPermissionMode', async () => {
    const session = new FakeSession();
    session.setMetadataSnapshot({ permissionMode: 'yolo', permissionModeUpdatedAt: 10 });
    const handler = new CodexLikePermissionHandler({ session: session as any, logPrefix: '[Test]' });

    handler.setPermissionMode('read-only', 20);
    const result = await handler.handleToolCall('tool-1', 'Write', { path: '/tmp/x', content: 'hi' });

    expect(result.decision).toBe('denied');
  });

  it('keeps read-only deny strict even after approved_for_session history', async () => {
    const session = new FakeSession();
    const handler = new CodexLikePermissionHandler({ session: session as any, logPrefix: '[Test]' });

    handler.setPermissionMode('safe-yolo');
    const firstCall = handler.handleToolCall('tool-1', 'Write', { path: '/tmp/x', content: 'hi' });
    const rpc = session.rpcHandlerManager.handlers.get('permission');
    await rpc!({ id: 'tool-1', approved: true, decision: 'approved_for_session' });
    await expect(firstCall).resolves.toEqual({ decision: 'approved_for_session' });

    handler.setPermissionMode('read-only', 100);
    const result = await handler.handleToolCall('tool-2', 'Write', { path: '/tmp/x', content: 'hi' });
    expect(result.decision).toBe('denied');
  });

  it('resolves pending permission requests when permission mode changes to read-only', async () => {
    const session = new FakeSession();
    const handler = new CodexLikePermissionHandler({ session: session as any, logPrefix: '[Test]' });

    const promise = handler.handleToolCall('tool-1', 'bash', { command: 'echo hi' });
    expect(session.agentState.requests['tool-1']).toBeTruthy();

    handler.setPermissionMode('read-only', 10);

    const result = await promise;
    expect(result.decision).toBe('denied');
    expect(session.agentState.requests).toEqual({});
    expect(session.agentState.completedRequests['tool-1']).toEqual(
      expect.objectContaining({
        tool: 'bash',
        status: 'denied',
        decision: 'denied',
      }),
    );
  });

  it('does not emit unhandledRejection when updateAgentState rejects while resolving pending requests', async () => {
    const session = new FakeSession();
    session.updateAgentState = async () => {
      throw new Error('updateAgentState failed');
    };
    const handler = new CodexLikePermissionHandler({ session: session as any, logPrefix: '[Test]' });

    const onUnhandled = vi.fn();
      process.on('unhandledRejection', onUnhandled);
    try {
      const promise = handler.handleToolCall('tool-1', 'bash', { command: 'echo hi' });

      handler.setPermissionMode('read-only', 10);

      await expect(promise).resolves.toEqual({ decision: 'denied' });

      // Give Node a chance to surface an unhandled rejection if one was created.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(onUnhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('auto-approves Happier tools shell-bridge bash commands in default mode', async () => {
    const session = new FakeSession();
    const handler = new CodexLikePermissionHandler({ session: session as any, logPrefix: '[Test]' });

    const result = await handler.handleToolCall('tool-1', 'Bash', {
      command:
        `TSX_TSCONFIG_PATH='/Users/leeroy/Documents/Development/happier/dev/apps/cli/tsconfig.json' ` +
        `'/Users/leeroy/.nvm/versions/node/v22.14.0/bin/node' --import ` +
        `'/Users/leeroy/Documents/Development/happier/dev/node_modules/tsx/dist/esm/index.mjs' ` +
        `'/Users/leeroy/Documents/Development/happier/dev/apps/cli/src/index.ts' tools call ` +
        `--session-id cmmfivqgm002d8o1ug15b02o1 --directory /tmp/workspace --source happier ` +
        `--tool change_title --args-json '{"title":"Kimi Fresh QA Title"}' --json`,
    });

    expect(result.decision).toBe('approved');
    expect(session.agentState.requests['tool-1']).toBeUndefined();
    expect(session.agentState.completedRequests['tool-1']).toEqual(
      expect.objectContaining({
        tool: 'Bash',
        status: 'approved',
        decision: 'approved',
      }),
    );
  });

  it('auto-approves Happier tools shell-bridge bash commands even in read-only mode', async () => {
    const session = new FakeSession();
    const handler = new CodexLikePermissionHandler({ session: session as any, logPrefix: '[Test]' });
    handler.setPermissionMode('read-only');

    const result = await handler.handleToolCall('tool-1', 'bash', {
      command:
        `TSX_TSCONFIG_PATH='/Users/leeroy/Documents/Development/happier/dev/apps/cli/tsconfig.json' ` +
        `'/Users/leeroy/.nvm/versions/node/v22.14.0/bin/node' --import ` +
        `'/Users/leeroy/Documents/Development/happier/dev/node_modules/tsx/dist/esm/index.mjs' ` +
        `'/Users/leeroy/Documents/Development/happier/dev/apps/cli/src/index.ts' tools list ` +
        `--session-id cmmfivqgm002d8o1ug15b02o1 --directory /tmp/workspace --json`,
    });

    expect(result.decision).toBe('approved');
    expect(session.agentState.requests['tool-1']).toBeUndefined();
    expect(session.agentState.completedRequests['tool-1']).toEqual(
      expect.objectContaining({
        tool: 'bash',
        status: 'approved',
        decision: 'approved',
      }),
    );
  });

  it.each([
    `happier tools call --source happier --tool save_memory --json; touch /tmp/happier-pwn`,
    `happier tools call --source happier --tool save_memory --json && touch /tmp/happier-pwn`,
    `happier tools call --source happier --tool save_memory --json || touch /tmp/happier-pwn`,
    `happier tools call --source happier --tool save_memory --json | cat`,
    `happier tools call --source happier --tool save_memory --json $(touch /tmp/happier-pwn)`,
    `happier tools call --source happier --tool save_memory --json \`touch /tmp/happier-pwn\``,
    `happier tools call --source happier --tool save_memory --json extra-token`,
  ])('does not auto-approve shell-bridge commands with trailing execution in default mode: %s', async (command) => {
    const session = new FakeSession();
    const handler = new CodexLikePermissionHandler({ session: session as any, logPrefix: '[Test]' });

    const pending = handler.handleToolCall('tool-1', 'bash', { command });

    expect(session.agentState.requests['tool-1']).toEqual(
      expect.objectContaining({
        tool: 'bash',
      }),
    );

    const rpc = session.rpcHandlerManager.handlers.get('permission');
    expect(rpc).toBeDefined();
    await rpc!({ id: 'tool-1', approved: false, decision: 'denied' });

    await expect(pending).resolves.toEqual({ decision: 'denied' });
  });

  it('prompts for Happier shell-bridge calls with non-vetted custom sources in default mode', async () => {
    const session = new FakeSession();
    const handler = new CodexLikePermissionHandler({ session: session as any, logPrefix: '[Test]' });

    const promise = handler.handleToolCall('tool-1', 'bash', {
      command:
        `happier tools call --session-id cmmfivqgm002d8o1ug15b02o1 --directory /tmp/workspace ` +
        `--source qa_marker_stdio_20260306 --tool get_marker --args-json '{}' --json`,
    });

    expect(session.agentState.requests['tool-1']).toEqual(
      expect.objectContaining({
        tool: 'bash',
      }),
    );

    const rpc = session.rpcHandlerManager.handlers.get('permission');
    expect(rpc).toBeDefined();
    await rpc!({ id: 'tool-1', approved: true, decision: 'approved' });

    await expect(promise).resolves.toEqual({ decision: 'approved' });
  });

  it('prompts for non-vetted internal Happier shell-bridge tools in default mode', async () => {
    const session = new FakeSession();
    const handler = new CodexLikePermissionHandler({ session: session as any, logPrefix: '[Test]' });

    const promise = handler.handleToolCall('tool-1', 'bash', {
      command:
        `happier tools call --session-id cmmfivqgm002d8o1ug15b02o1 --directory /tmp/workspace ` +
        `--source happier --tool action_execute --args-json '{"actionId":"dangerous.action"}' --json`,
    });

    expect(session.agentState.requests['tool-1']).toEqual(
      expect.objectContaining({
        tool: 'bash',
      }),
    );

    const rpc = session.rpcHandlerManager.handlers.get('permission');
    expect(rpc).toBeDefined();
    await rpc!({ id: 'tool-1', approved: false, decision: 'denied' });

    await expect(promise).resolves.toEqual({ decision: 'denied' });
  });
});
