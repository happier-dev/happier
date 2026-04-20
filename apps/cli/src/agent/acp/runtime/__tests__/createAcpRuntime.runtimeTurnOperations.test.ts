import { describe, expect, it, vi } from 'vitest';

import { createAcpRuntime } from '../createAcpRuntime';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { isRuntimeTurnOperations } from '@/agent/runtime/turns/runtimeTurnOperations';
import { createFakeAcpRuntimeBackend } from '@/testkit/backends/acpRuntimeBackend';
import { createApprovedPermissionHandler } from '@/testkit/backends/permissionHandler';
import { createBasicSessionClient } from '@/testkit/backends/sessionFixtures';

describe('createAcpRuntime (native lower-operation surface)', () => {
  it('implements RuntimeTurnOperations directly on the ACP runtime leaf', async () => {
    const startSession = vi.fn(async () => ({ sessionId: 'acp-session-1' }));
    const sendPrompt = vi.fn(async () => undefined);
    const setSessionMode = vi.fn(async () => undefined);
    const setSessionModel = vi.fn(async () => undefined);
    const setSessionConfigOption = vi.fn(async () => undefined);
    const cancel = vi.fn(async () => undefined);
    const dispose = vi.fn(async () => undefined);

    const runtime = createAcpRuntime({
      provider: 'gemini',
      directory: '/tmp',
      session: createBasicSessionClient(),
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => createFakeAcpRuntimeBackend({
        startSession,
        sendPrompt,
        setSessionMode,
        setSessionModel,
        setSessionConfigOption,
        cancel,
        dispose,
      }),
    });

    expect(isRuntimeTurnOperations(runtime)).toBe(true);
    if (!isRuntimeTurnOperations(runtime)) {
      throw new Error('Expected ACP runtime to satisfy RuntimeTurnOperations');
    }

    await runtime.startOrLoadSession();
    runtime.beginTurnLifecycle();
    await runtime.sendTurnPrompt('hello');
    await runtime.updateSessionRuntimeConfig({
      modeId: 'plan',
      modelId: 'gemini-2.5-pro',
      configOption: { id: 'reasoning_effort', value: 'high' },
    });
    await runtime.cancelTurn();
    await runtime.resetOrDisposeRuntime();

    expect(runtime.readSessionIdentity()).toEqual({ sessionId: null });
    expect(startSession).toHaveBeenCalledTimes(1);
    expect(sendPrompt).toHaveBeenCalledWith('acp-session-1', 'hello');
    expect(setSessionMode).toHaveBeenCalledWith('acp-session-1', 'plan');
    expect(setSessionModel).toHaveBeenCalledWith('acp-session-1', 'gemini-2.5-pro');
    expect(setSessionConfigOption).toHaveBeenCalledWith('acp-session-1', 'reasoning_effort', 'high');
    expect(cancel).toHaveBeenCalledWith('acp-session-1');
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
