import { describe, expect, it, vi } from 'vitest';

import { claudeRemoteAgentSdk } from './claudeRemoteAgentSdk';
import { makeMode } from './claudeRemoteAgentSdk.testkit';
import { PermissionHandler } from '../utils/permissionHandler';
import { createPermissionHandlerSessionStubWithMetadata } from '../utils/permissionHandler.testkit';

async function expectResolvesWithin<T>(promise: Promise<T>, ms = 250): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

describe('claudeRemoteAgentSdk (ExitPlanMode transition)', () => {
  it('switches permission mode and clears agentModeId after ExitPlanMode approval within the same assistant turn', async () => {
    let capturedOptions: any = null;
    let response: any = null;

    const createQuery = vi.fn((_params: any) => {
      capturedOptions = _params.options;
      response = {
        async *[Symbol.asyncIterator]() {
          const controller = new AbortController();
          await capturedOptions.canUseTool(
            'ExitPlanMode',
            { plan: 'p1' },
            { signal: controller.signal, toolUseID: 'toolu_exit_1', agentID: 'agent_1' },
          );
          await capturedOptions.canUseTool(
            'Bash',
            { command: 'pwd' },
            { signal: controller.signal, toolUseID: 'toolu_bash_1', agentID: 'agent_1' },
          );
          yield { type: 'result' } as any;
        },
        close: vi.fn(),
        setPermissionMode: vi.fn(),
        setModel: vi.fn(),
        setMaxThinkingTokens: vi.fn(),
        supportedCommands: vi.fn(async () => []),
        supportedModels: vi.fn(async () => []),
      };
      return response;
    });

    const seenModes: Array<{ toolName: string; agentModeId: string | null; permissionMode: string | null }> = [];
    const canCallTool = vi.fn(async (toolName: string, input: unknown, mode: any) => {
      seenModes.push({
        toolName,
        agentModeId: typeof mode?.agentModeId === 'string' ? mode.agentModeId : null,
        permissionMode: typeof mode?.permissionMode === 'string' ? mode.permissionMode : null,
      });
      return { behavior: 'allow', updatedInput: (input as any) ?? {} };
    });

    let didSendFirst = false;
    const nextMessage = vi.fn(async () => {
      if (didSendFirst) return null;
      didSendFirst = true;
      return {
        message: 'hello',
        mode: makeMode({
          claudeRemoteAgentSdkEnabled: true,
          permissionMode: 'yolo',
          agentModeId: 'plan',
        } as any),
      };
    });

    await claudeRemoteAgentSdk({
      sessionId: null,
      transcriptPath: null,
      path: '/tmp',
      claudeArgs: [],
      claudeExecutablePath: '/tmp/claude',
      canCallTool,
      isAborted: () => false,
      nextMessage,
      onReady: () => {},
      onSessionFound: () => {},
      onMessage: () => {},
      createQuery,
    } as any);

    const bashCall = seenModes.find((entry) => entry.toolName === 'Bash');
    expect(bashCall?.agentModeId).toBeNull();
    expect(response?.setPermissionMode).toHaveBeenCalledWith('bypassPermissions');
  });

  it('resolves duplicate ExitPlanMode permission waiters from canUseTool and PermissionRequest with one approval', async () => {
    const { session, client } = createPermissionHandlerSessionStubWithMetadata({
      sessionId: 's1',
      metadata: { acpSessionModeOverrideV1: { v: 1, updatedAt: 1, modeId: 'plan' } },
    });
    const permissionHandler = new PermissionHandler(session);

    let capturedOptions: any = null;
    let response: any = null;

    const createQuery = vi.fn((_params: any) => {
      capturedOptions = _params.options;
      response = {
        async *[Symbol.asyncIterator]() {
          const toolUseId = 'toolu_exit_duplicate_1';
          const directController = new AbortController();
          const hookController = new AbortController();
          const directPromise = capturedOptions.canUseTool(
            'ExitPlanMode',
            { plan: 'p1' },
            { signal: directController.signal, toolUseID: toolUseId, agentID: 'agent_1' },
          );
          const hookPromise = capturedOptions.hooks.PermissionRequest[0].hooks[0](
            {
              hook_event_name: 'PermissionRequest',
              session_id: 'sess_1',
              transcript_path: '/tmp/sess_1.jsonl',
              cwd: '/tmp',
              tool_name: 'ExitPlanMode',
              tool_input: { plan: 'p1' },
            },
            toolUseId,
            { signal: hookController.signal },
          );

          expect(Object.keys(client.agentState.requests)).toEqual([toolUseId]);

          const permissionRpc = client.rpcHandlerManager.getHandler('permission');
          expect(permissionRpc).toBeDefined();
          await permissionRpc?.({ id: toolUseId, approved: true } as any);

          const bothPermissionWaiters = Promise.all([directPromise, hookPromise]);

          const [directResult, hookResult] = await expectResolvesWithin(bothPermissionWaiters);
          expect(directResult).toEqual({ behavior: 'allow', updatedInput: { plan: 'p1' } });
          expect(hookResult).toEqual(
            expect.objectContaining({
              continue: true,
              suppressOutput: true,
              hookSpecificOutput: {
                hookEventName: 'PermissionRequest',
                decision: { behavior: 'allow', updatedInput: { plan: 'p1' } },
              },
            }),
          );

          yield { type: 'result' } as any;
        },
        close: vi.fn(),
        setPermissionMode: vi.fn(),
        setModel: vi.fn(),
        setMaxThinkingTokens: vi.fn(),
        supportedCommands: vi.fn(async () => []),
        supportedModels: vi.fn(async () => []),
      };
      return response;
    });

    let didSendFirst = false;
    const nextMessage = vi.fn(async () => {
      if (didSendFirst) return null;
      didSendFirst = true;
      return {
        message: 'hello',
        mode: makeMode({
          claudeRemoteAgentSdkEnabled: true,
          permissionMode: 'yolo',
          agentModeId: 'plan',
          localId: 'm1',
        } as any),
      };
    });

    await claudeRemoteAgentSdk({
      sessionId: null,
      transcriptPath: null,
      path: '/tmp',
      claudeArgs: [],
      claudeExecutablePath: '/tmp/claude',
      canCallTool: (toolName: string, input: unknown, mode: any, options: any) =>
        permissionHandler.handleToolCall(toolName, input, mode, options),
      isAborted: () => false,
      nextMessage,
      onReady: () => {},
      onSessionFound: () => {},
      onMessage: () => {},
      createQuery,
    } as any);

    expect(client.agentState.requests.toolu_exit_duplicate_1).toBeUndefined();
    expect(client.agentState.completedRequests.toolu_exit_duplicate_1).toEqual(expect.objectContaining({ status: 'approved' }));
    expect(response?.setPermissionMode).toHaveBeenCalledWith('bypassPermissions');
    expect((client.metadata as any).acpSessionModeOverrideV1?.modeId).toBeNull();
  });
});
