import { describe, expect, it } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { registerMachineRpcHandlers } from './rpcHandlers';

describe('voice foundation machine RPC assembly', () => {
  it('registers and disposes resolver-backed OpenAI-compatible operations through the canonical machine owner', async () => {
    const registered = new Map<string, (raw: unknown) => Promise<unknown>>();
    const lifecycle = registerMachineRpcHandlers({
      rpcHandlerManager: {
        registerHandler(method: string, handler: (raw: unknown) => Promise<unknown>) {
          registered.set(method, handler);
        },
      } as never,
      handlers: {
        spawnSession: async () => ({ type: 'success', sessionId: 'session' } as const),
        stopSession: async () => true,
        requestShutdown: () => undefined,
      },
    });

    expect(registered.has(RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_CHAT)).toBe(true);
    expect(registered.has(RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_SYNTHESIZE)).toBe(true);
    expect(registered.has(RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_TRANSCRIBE_UPLOAD_INIT)).toBe(true);
    expect(lifecycle.voiceOpenAiCompat).toBeDefined();
    await expect(lifecycle.dispose()).resolves.toBeUndefined();
  });
});
