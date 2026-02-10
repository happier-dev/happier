import { describe, expect, it, vi } from 'vitest';

import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { createAcpRuntime } from '../createAcpRuntime';
import { createApprovedPermissionHandler, createBasicSessionClient, createFakeAcpRuntimeBackend } from '../createAcpRuntime.testkit';

describe('createAcpRuntime (in-flight steer)', () => {
  it('exposes turn-in-flight state and steerPrompt when enabled', async () => {
    const backend = createFakeAcpRuntimeBackend({ sessionId: 'sess_1' }) as any;
    backend.sendSteerPrompt = vi.fn(async () => {});

    const runtime = createAcpRuntime({
      provider: 'codex',
      directory: '/tmp',
      session: createBasicSessionClient(),
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
      inFlightSteer: { enabled: true },
    } as any);

    expect(typeof (runtime as any).supportsInFlightSteer).toBe('function');
    expect((runtime as any).supportsInFlightSteer()).toBe(true);

    expect(typeof (runtime as any).isTurnInFlight).toBe('function');
    expect((runtime as any).isTurnInFlight()).toBe(false);

    runtime.beginTurn();
    expect((runtime as any).isTurnInFlight()).toBe(true);

    await (runtime as any).startOrLoad({});
    await (runtime as any).steerPrompt('steer text');

    expect(backend.sendSteerPrompt).toHaveBeenCalledWith('sess_1', 'steer text');

    runtime.flushTurn();
    expect((runtime as any).isTurnInFlight()).toBe(false);
  });
});

