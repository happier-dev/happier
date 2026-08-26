import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Credentials } from '@/persistence';
import { createCatalogAcpBackendSpy, createMessageBufferFixture, createSessionProviderInputConsumerFixture } from '@/testkit/backends/catalogAcpRuntime';
import { createApprovedPermissionHandler } from '@/testkit/backends/permissionHandler';
import { createApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';

import { createPiAcpRuntime } from './runtime';

// Prompt resolution is a system boundary for this contract: the runtime must propagate its
// failure through the session-start error path instead of silently spawning pi without the
// Happier prompt addition.
vi.mock('@/agent/prompting/coding/resolveEffectiveCodingPrompt', () => ({
  resolveEffectiveCodingPromptText: vi.fn(async () => {
    throw new Error('prompt resolution failed (probe)');
  }),
}));

const credentials: Credentials = {
  token: 'test-token',
  encryption: { type: 'legacy', secret: new Uint8Array([1]) },
};

describe('Pi ACP runtime prompt-preparation failure', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects session start instead of silently spawning without the Happier prompt', async () => {
    const createCalls: unknown[] = [];
    createCatalogAcpBackendSpy(createCalls as never);

    const runtime = createPiAcpRuntime({
      directory: '/tmp/repo',
      machineId: 'machine-1',
      session: Object.assign(createApiSessionClientFixture(), { sessionId: 'happy-session-prompt-fail' }),
      messageBuffer: createMessageBufferFixture(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange() {},
      getPermissionMode: () => 'default',
      providerInputConsumer: createSessionProviderInputConsumerFixture(),
      credentials,
      fallbackToolDelivery: 'shell_bridge',
      accountSettings: {},
    });

    await expect(runtime.startOrLoad({})).rejects.toThrow('prompt resolution failed (probe)');
    // No backend may be constructed when prompt preparation fails.
    expect(createCalls).toHaveLength(0);
  });
});
