import { describe, expect, it, vi } from 'vitest';

import { buildHappierToolsShellBridgeCommand } from '@/agent/tools/happierTools/runtime/buildHappierToolsShellBridgeCommand';
import { CodexLikePermissionHandler } from './CodexLikePermissionHandler';
import { ServerBoundPermissionRpcHandlerManager } from './testkit/serverBoundPermissionRpcHandlerManager';

class FakeSession {
  sessionId = 'session-test';
  rpcHandlerManager = new ServerBoundPermissionRpcHandlerManager(this.sessionId);
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

class DeferredUpdateSession extends FakeSession {
  private deferredUpdate: Promise<void> | null = null;
  private resolveDeferredUpdate: (() => void) | null = null;
  private deferredUpdater: ((state: any) => any) | null = null;

  deferNextUpdate(): void {
    this.deferredUpdate = new Promise<void>((resolve) => {
      this.resolveDeferredUpdate = resolve;
    });
  }

  releaseNextUpdate(): void {
    const update = this.deferredUpdater;
    this.deferredUpdater = null;
    if (update) this.agentState = update(this.agentState);
    this.resolveDeferredUpdate?.();
    this.resolveDeferredUpdate = null;
    this.deferredUpdate = null;
  }

  override updateAgentState(updater: any) {
    if (!this.deferredUpdate) return super.updateAgentState(updater);
    this.deferredUpdater = updater;
    return this.deferredUpdate;
  }
}

async function settledState<T>(promise: Promise<T>): Promise<'pending' | 'fulfilled' | 'rejected'> {
  await Promise.resolve();
  await Promise.resolve();
  return Promise.race([
    promise.then(
      () => 'fulfilled' as const,
      () => 'rejected' as const,
    ),
    new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 0)),
  ]);
}

describe('CodexLikePermissionHandler', () => {
  it('hard-denies an explicitly malformed causal permission authority', async () => {
    const session = new FakeSession();
    const handler = new CodexLikePermissionHandler({ session: session as any, logPrefix: '[Test]' });
    handler.setPermissionMode('default');

    await expect(handler.handleToolCall(
      'malformed-causal-authority',
      'Write',
      { path: '/tmp/x', content: 'hi' },
      {
        causalPermissionAuthority: {
          kind: 'admittedSessionInputV1',
          admittedPermissionCeiling: 'not-a-real-mode',
        },
      } as never,
    )).resolves.toEqual({ decision: 'denied' });
    expect(session.agentState.requests['malformed-causal-authority']).toBeUndefined();
    expect(session.agentState.completedRequests['malformed-causal-authority']).toEqual(expect.objectContaining({
      status: 'denied',
      decision: 'denied',
    }));
  });

  it('does not let a later mutable mode widening auto-approve a causally bounded write', () => {
    const session = new FakeSession();
    const handler = new CodexLikePermissionHandler({ session: session as any, logPrefix: '[Test]' });
    handler.setPermissionMode('yolo');

    expect(handler.getImmediateDecision(
      'causal-ceiling-1',
      'Write',
      { path: '/tmp/x', content: 'hi' },
      { causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default' } } as any,
    )).toBeNull();
  });

  it('keeps a causally bounded pending write pending when the mutable mode later widens', async () => {
    const session = new FakeSession();
    const handler = new CodexLikePermissionHandler({ session: session as any, logPrefix: '[Test]' });
    handler.setPermissionMode('safe-yolo');

    const pending = handler.handleToolCall(
      'causal-pending-1',
      'Write',
      { path: '/tmp/x', content: 'hi' },
      { causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default' } },
    );
    expect(session.agentState.requests['causal-pending-1']).toBeTruthy();

    handler.setPermissionMode('yolo');

    expect(session.agentState.requests['causal-pending-1']).toBeTruthy();
    await session.rpcHandlerManager.handlers.get('permission')?.({
      id: 'causal-pending-1',
      approved: false,
      decision: 'denied',
    });
    await expect(pending).resolves.toEqual({ decision: 'denied' });
  });

  it('keeps a mediated write pending when the host grant ledger is unavailable without a local fallback', async () => {
    const session = new FakeSession();
    const listPermissionMediationRecords = vi.fn(async () => {
      throw new Error('Session System Records are unavailable');
    });
    const readPermissionMediationRecord = vi.fn();
    Object.assign(session, {
      getStoredContentEncryptionContext: () => ({ mode: 'plain' as const }),
      readPermissionMediationRecord,
      writePermissionMediationRecord: vi.fn(),
      listPermissionMediationRecords,
      prunePermissionMediationRecord: vi.fn(),
    });
    const handler = new CodexLikePermissionHandler({ session: session as any, logPrefix: '[Test]' });
    handler.setPermissionMode('yolo');

    expect(listPermissionMediationRecords).toHaveBeenCalledTimes(1);

    const pending = handler.handleToolCall(
      'unavailable-mediated-grant',
      'Write',
      { path: '/tmp/x', content: 'hi' },
      {
        causalPermissionAuthority: {
          kind: 'admittedSessionInputV1',
          admittedPermissionCeiling: 'default',
          sourceAuthority: {
            kind: 'mediatedExternal',
            mediatorPluginId: 'happier.channels',
            sourceRef: 'binding:ops',
            sourceRevisionOrEpoch: '42',
            admittedPermissionCeiling: 'default',
            remoteApprovalMaxScope: 'session',
          },
        },
      },
    );

    expect(await settledState(pending)).toBe('pending');
    expect(session.agentState.requests['unavailable-mediated-grant']).toBeDefined();
    expect(readPermissionMediationRecord).not.toHaveBeenCalled();

    await handler.reset();
    await expect(pending).rejects.toThrow('Session reset');
  });

  it('does not let a present-user allowlist response bypass newer narrowed permission metadata', async () => {
    const session = new FakeSession();
    const handler = new CodexLikePermissionHandler({ session: session as any, logPrefix: '[Test]' });
    handler.setPermissionMode('safe-yolo', 1);
    const context = {
      causalPermissionAuthority: {
        kind: 'admittedSessionInputV1',
        admittedPermissionCeiling: 'safe-yolo',
      },
    } as const;
    const input = { path: '/tmp/x', content: 'hi' };
    const first = handler.handleToolCall('allowlist-currentness-first', 'Write', input, context);
    const second = handler.handleToolCall('allowlist-currentness-second', 'Write', input, context);

    session.setMetadataSnapshot({ permissionMode: 'read-only', permissionModeUpdatedAt: 2 });
    const rpc = session.rpcHandlerManager.handlers.get('permission');
    expect(rpc).toBeDefined();
    await rpc!({
      id: 'allowlist-currentness-first',
      approved: true,
      updatedPermissions: [{
        type: 'addRules',
        behavior: 'allow',
        destination: 'session',
        rules: [{ toolName: 'Write' }],
      }],
    });

    await expect(first).resolves.toEqual({ decision: 'denied' });
    await expect(second).resolves.toEqual({ decision: 'denied' });
    expect(session.agentState.completedRequests['allowlist-currentness-first']).toEqual(expect.objectContaining({
      status: 'denied',
      decision: 'denied',
    }));
    expect(session.agentState.completedRequests['allowlist-currentness-second']).toEqual(expect.objectContaining({
      status: 'denied',
      decision: 'denied',
    }));
  });

  it('does not let a metadata-only narrowing be bypassed by a pending present-user approval', async () => {
    const session = new FakeSession();
    const handler = new CodexLikePermissionHandler({ session: session as any, logPrefix: '[Test]' });
    const causalPermissionContext = {
      causalPermissionAuthority: {
        kind: 'admittedSessionInputV1',
        admittedPermissionCeiling: 'safe-yolo',
      },
    } as const;
    const pending = handler.handleToolCall(
      'metadata-narrowed-before-present-response',
      'Write',
      { path: '/tmp/x', content: 'hi' },
      causalPermissionContext,
    );
    expect(session.agentState.requests['metadata-narrowed-before-present-response']).toBeTruthy();

    session.setMetadataSnapshot({ permissionMode: 'read-only', permissionModeUpdatedAt: 1 });
    const rpc = session.rpcHandlerManager.handlers.get('permission');
    expect(rpc).toBeDefined();
    await rpc!({
      id: 'metadata-narrowed-before-present-response',
      approved: true,
      decision: 'approved',
    });

    await expect(pending).resolves.toEqual({ decision: 'denied' });
    expect(session.agentState.completedRequests['metadata-narrowed-before-present-response']).toEqual(
      expect.objectContaining({ status: 'denied', decision: 'denied' }),
    );
  });

  it('does not persist a present-user approval when its causal mode narrows during the terminal write', async () => {
    const session = new DeferredUpdateSession();
    const handler = new CodexLikePermissionHandler({ session: session as any, logPrefix: '[Test]' });
    const causalPermissionContext = {
      causalPermissionAuthority: {
        kind: 'admittedSessionInputV1',
        admittedPermissionCeiling: 'safe-yolo',
      },
    } as const;
    const pending = handler.handleToolCall(
      'metadata-narrowed-during-present-terminal-write',
      'Write',
      { path: '/tmp/x', content: 'hi' },
      causalPermissionContext,
    );
    expect(session.agentState.requests['metadata-narrowed-during-present-terminal-write']).toBeTruthy();

    session.deferNextUpdate();
    const rpc = session.rpcHandlerManager.handlers.get('permission');
    expect(rpc).toBeDefined();
    const response = rpc!({
      id: 'metadata-narrowed-during-present-terminal-write',
      approved: true,
      decision: 'approved',
    });
    await Promise.resolve();
    await Promise.resolve();
    session.setMetadataSnapshot({ permissionMode: 'read-only', permissionModeUpdatedAt: 1 });
    session.releaseNextUpdate();

    await expect(response).resolves.toEqual({
      ok: false,
      errorCode: 'permission_request_not_found',
      requestId: 'metadata-narrowed-during-present-terminal-write',
    });
    await expect(pending).resolves.toEqual({ decision: 'denied' });
    expect(session.agentState.completedRequests['metadata-narrowed-during-present-terminal-write']).toEqual(
      expect.objectContaining({ status: 'denied', decision: 'denied' }),
    );
  });

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

  it('does not use the tool call id as authorization input', async () => {
    const session = new FakeSession();
    const handler = new CodexLikePermissionHandler({ session: session as any, logPrefix: '[Test]' });
    handler.setPermissionMode('read-only');

    await expect(
      handler.handleToolCall('call_think_9f2', 'bash', { command: 'echo unsafe' }),
    ).resolves.toEqual({ decision: 'denied' });
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
        'Which session export behavior should the plan target?': ['Single JSON'],
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

  it('fails closed for an opaque prior claim across mode changes and reset', async () => {
    const session = new FakeSession();
    const handler = new CodexLikePermissionHandler({ session: session as any, logPrefix: '[Test]' });
    handler.setPermissionMode('safe-yolo');

    const pending = handler.handleToolCall('mode-claim-race', 'Write', { path: '/tmp/x', content: 'hi' });
    session.agentState.requests['mode-claim-race'].permissionResponseClaimV1 = {
      predecessor: 'unrecognized-first-answer-claim',
    };

    handler.setPermissionMode('yolo');
    expect(await settledState(pending)).toBe('pending');
    expect(session.agentState.requests['mode-claim-race']).toBeDefined();
    expect(session.agentState.completedRequests['mode-claim-race']).toBeUndefined();

    await handler.reset();
    expect(await settledState(pending)).toBe('pending');
    expect(session.agentState.requests['mode-claim-race']).toBeDefined();
    expect(session.agentState.completedRequests['mode-claim-race']).toBeUndefined();
  });

  it('does not let an immediate automatic decision overwrite an opaque outstanding claim after handler recovery', async () => {
    const session = new FakeSession();
    const handler = new CodexLikePermissionHandler({ session: session as any, logPrefix: '[Test]' });
    handler.setPermissionMode('yolo');
    session.agentState.requests['opaque-auto-claim'] = {
      tool: 'Write',
      arguments: { path: '/tmp/x', content: 'hi' },
      createdAt: 1,
      permissionResponseClaimV1: { predecessor: 'unrecognized-first-answer-claim' },
    };

    const pending = handler.handleToolCall('opaque-auto-claim', 'Write', { path: '/tmp/x', content: 'hi' });

    expect(await settledState(pending)).toBe('pending');
    expect(session.agentState.requests['opaque-auto-claim']).toEqual(expect.objectContaining({
      permissionResponseClaimV1: { predecessor: 'unrecognized-first-answer-claim' },
    }));
    expect(session.agentState.completedRequests['opaque-auto-claim']).toBeUndefined();
  });

  it('atomically replaces a recovered unclaimed request when an automatic decision completes it', async () => {
    const session = new FakeSession();
    const handler = new CodexLikePermissionHandler({ session: session as any, logPrefix: '[Test]' });
    handler.setPermissionMode('yolo');
    session.agentState.requests['recovered-unclaimed-auto'] = {
      tool: 'Write',
      arguments: { path: '/tmp/x', content: 'hi' },
      createdAt: 1,
    };

    await expect(handler.handleToolCall(
      'recovered-unclaimed-auto',
      'Write',
      { path: '/tmp/x', content: 'hi' },
    )).resolves.toEqual({ decision: 'approved_for_session' });

    expect(session.agentState.requests['recovered-unclaimed-auto']).toBeUndefined();
    expect(session.agentState.completedRequests['recovered-unclaimed-auto']).toEqual(expect.objectContaining({
      status: 'approved',
      decision: 'approved_for_session',
    }));
  });

  it('does not persist or return a stale yolo write approval after permission mode narrows during its AgentState update', async () => {
    const session = new DeferredUpdateSession();
    const handler = new CodexLikePermissionHandler({ session: session as any, logPrefix: '[Test]' });
    handler.setPermissionMode('yolo');
    session.deferNextUpdate();

    const result = handler.handleToolCall('direct-auto-mode-currentness', 'Write', {
      path: '/tmp/x',
      content: 'hi',
    });
    handler.setPermissionMode('read-only');
    session.releaseNextUpdate();

    await expect(result).resolves.toEqual({ decision: 'denied' });
    expect(session.agentState.requests['direct-auto-mode-currentness']).toBeUndefined();
    expect(session.agentState.completedRequests['direct-auto-mode-currentness']).toEqual(expect.objectContaining({
      status: 'denied',
      decision: 'denied',
    }));
    expect(session.agentState.completedRequests['direct-auto-mode-currentness'].allowedTools).toBeUndefined();
  });

  it('rechecks mode after an asynchronous automatic claim instead of committing its stale approval', async () => {
    const session = new DeferredUpdateSession();
    const handler = new CodexLikePermissionHandler({ session: session as any, logPrefix: '[Test]' });
    handler.setPermissionMode('safe-yolo');

    const pending = handler.handleToolCall('mode-currentness', 'Write', { path: '/tmp/x', content: 'hi' });
    session.deferNextUpdate();
    handler.setPermissionMode('yolo');
    handler.setPermissionMode('safe-yolo');
    session.releaseNextUpdate();

    expect(await settledState(pending)).toBe('pending');
    expect(session.agentState.requests['mode-currentness']).toBeDefined();
    expect(session.agentState.completedRequests['mode-currentness']).toBeUndefined();

    const rpc = session.rpcHandlerManager.handlers.get('permission');
    expect(rpc).toBeDefined();
    await rpc!({ id: 'mode-currentness', approved: false, decision: 'denied' });
    await expect(pending).resolves.toEqual({ decision: 'denied' });
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

  it('does not acknowledge an immediate automatic decision when completed Agent State persistence fails', async () => {
    const session = new FakeSession();
    const handler = new CodexLikePermissionHandler({ session: session as any, logPrefix: '[Test]' });
    handler.setPermissionMode('yolo');
    session.updateAgentState = async () => {
      throw new Error('updateAgentState failed');
    };

    try {
      await expect(handler.handleToolCall('immediate-persistence-failure', 'Write', {
        path: '/tmp/x',
        content: 'hi',
      })).rejects.toThrow('updateAgentState failed');
      expect(session.agentState.completedRequests['immediate-persistence-failure']).toBeUndefined();
    } finally {
      session.updateAgentState = (updater: any) => {
        session.agentState = updater(session.agentState);
        return session.agentState;
      };
      await handler.reset();
    }
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

  it('keeps an automatic persistence failure live and denies a stale follow-on approval after restart', async () => {
    const session = new FakeSession();
    const handler = new CodexLikePermissionHandler({ session: session as any, logPrefix: '[Test]' });
    let reloadedHandler: CodexLikePermissionHandler | null = null;

    try {
      const promise = handler.handleToolCall('automatic-persistence-restart', 'bash', { command: 'echo hi' });
      void promise.catch(() => undefined);
      expect(session.agentState.requests['automatic-persistence-restart']).toBeDefined();

      session.setMetadataSnapshot({ permissionMode: 'read-only', permissionModeUpdatedAt: 10 });

      session.updateAgentState = async () => {
        throw new Error('updateAgentState failed');
      };

      handler.setPermissionMode('read-only', 10);

      const outcome = await settledState(promise);
      expect(outcome).toBe('pending');
      expect(session.agentState.requests['automatic-persistence-restart']).toBeDefined();
      expect(session.agentState.completedRequests['automatic-persistence-restart']).toBeUndefined();

      session.updateAgentState = (updater: any) => {
        session.agentState = updater(session.agentState);
        return session.agentState;
      };
      reloadedHandler = new CodexLikePermissionHandler({ session: session as any, logPrefix: '[Reloaded]' });

      const rpc = session.rpcHandlerManager.handlers.get('permission');
      await rpc!({
        id: 'automatic-persistence-restart',
        approved: true,
        decision: 'approved',
      });

      expect(session.agentState.completedRequests['automatic-persistence-restart']).toEqual(
        expect.objectContaining({
          status: 'denied',
          decision: 'denied',
        }),
      );
    } finally {
      session.updateAgentState = (updater: any) => {
        session.agentState = updater(session.agentState);
        return session.agentState;
      };
      await reloadedHandler?.reset();
      await handler.reset();
    }
  });

  it('auto-approves Happier tools shell-bridge bash commands in default mode', async () => {
    const session = new FakeSession();
    const handler = new CodexLikePermissionHandler({ session: session as any, logPrefix: '[Test]' });

    const result = await handler.handleToolCall('tool-1', 'Bash', {
      command: buildHappierToolsShellBridgeCommand([
        'call',
        '--session-id',
        'cmmfivqgm002d8o1ug15b02o1',
        '--directory',
        '/tmp/workspace',
        '--source',
        'happier',
        '--tool',
        'change_title',
        '--args-json',
        '{"title":"Kimi Fresh QA Title"}',
        '--json',
      ]),
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
      command: buildHappierToolsShellBridgeCommand([
        'list',
        '--session-id',
        'cmmfivqgm002d8o1ug15b02o1',
        '--directory',
        '/tmp/workspace',
        '--json',
      ]),
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

  it('does not auto-approve a model-supplied bridge-shaped shell command', async () => {
    const session = new FakeSession();
    const handler = new CodexLikePermissionHandler({ session: session as any, logPrefix: '[Test]' });

    const pending = handler.handleToolCall('tool-forged-bridge', 'bash', {
      command: 'PATH=./tools happier tools list --json',
    });

    expect(session.agentState.requests['tool-forged-bridge']).toBeTruthy();
    await session.rpcHandlerManager.handlers.get('permission')?.({
      id: 'tool-forged-bridge',
      approved: false,
      decision: 'denied',
    });
    await expect(pending).resolves.toEqual({ decision: 'denied' });
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
