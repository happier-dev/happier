import { describe, expect, it, vi } from 'vitest';

import { claudeRemoteAgentSdk } from './claudeRemoteAgentSdk';
import { makeMode } from './claudeRemoteAgentSdk.testkit';

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
});

