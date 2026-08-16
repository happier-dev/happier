import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Credentials } from '@/persistence';
import type { CatalogAcpRuntimeCreateCall } from '@/testkit/backends/catalogAcpRuntime';
import { createCatalogAcpBackendSpy, createMessageBufferFixture, createSessionProviderInputConsumerFixture } from '@/testkit/backends/catalogAcpRuntime';
import { createApprovedPermissionHandler } from '@/testkit/backends/permissionHandler';
import { createApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';

import { createPiAcpRuntime } from './runtime';

const credentials: Credentials = {
  token: 'test-token',
  encryption: { type: 'legacy', secret: new Uint8Array([1]) },
};

describe('Pi ACP runtime spawn system prompt', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('delivers the shell-bridge tool appendix in the spawn-time system prompt', async () => {
    const createCalls: CatalogAcpRuntimeCreateCall[] = [];
    createCatalogAcpBackendSpy(createCalls);
    const session = Object.assign(createApiSessionClientFixture(), {
      sessionId: 'happy-session-1',
    });

    const runtime = createPiAcpRuntime({
      directory: '/tmp/repo',
      machineId: 'machine-1',
      session,
      messageBuffer: createMessageBufferFixture(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange() {},
      getPermissionMode: () => 'default',
      providerInputConsumer: createSessionProviderInputConsumerFixture(),
      credentials,
      accountSettings: {},
    });

    await runtime.startOrLoad({});

    const appendSystemPromptText = createCalls[0]?.appendSystemPromptText ?? '';
    expect(appendSystemPromptText).toContain('Happier tools are available through the CLI bridge');
    expect(appendSystemPromptText).toContain("'--session-id' 'happy-session-1'");
    expect(appendSystemPromptText).toContain("'--directory' '/tmp/repo'");
  });

  it('includes memory recall guidance in the spawn-time system prompt when enabled', async () => {
    const createCalls: CatalogAcpRuntimeCreateCall[] = [];
    createCatalogAcpBackendSpy(createCalls);
    const session = Object.assign(createApiSessionClientFixture(), {
      sessionId: 'happy-session-2',
    });

    const runtime = createPiAcpRuntime({
      directory: '/tmp/repo',
      machineId: 'machine-9',
      session,
      messageBuffer: createMessageBufferFixture(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange() {},
      getPermissionMode: () => 'default',
      providerInputConsumer: createSessionProviderInputConsumerFixture(),
      credentials,
      accountSettings: {},
      memoryRecallGuidanceEnabled: true,
    });

    await runtime.startOrLoad({});

    const appendSystemPromptText = createCalls[0]?.appendSystemPromptText ?? '';
    expect(appendSystemPromptText).toContain('memory_search');
    expect(appendSystemPromptText).toContain('machine-9');
  });
});
