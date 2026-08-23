import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CatalogAcpRuntimeCreateCall } from '@/testkit/backends/catalogAcpRuntime';
import {
  createCatalogAcpBackendSpy,
  createMessageBufferFixture,
  createSessionProviderInputConsumerFixture,
} from '@/testkit/backends/catalogAcpRuntime';
import { createApprovedPermissionHandler } from '@/testkit/backends/permissionHandler';
import { createApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';

import { createPiAcpRuntime } from './runtime';

describe('Pi ACP runtime spawn system prompt', () => {
  afterEach(() => vi.restoreAllMocks());

  it('resolves and delivers the host-owned effective prompt before backend spawn', async () => {
    const createCalls: CatalogAcpRuntimeCreateCall[] = [];
    createCatalogAcpBackendSpy(createCalls);
    const resolveSystemPromptBeforeSpawn = vi.fn(async () => 'Happier effective system prompt');

    const runtime = createPiAcpRuntime({
      directory: '/tmp/repo',
      machineId: 'machine-1',
      session: createApiSessionClientFixture(),
      messageBuffer: createMessageBufferFixture(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange() {},
      getPermissionMode: () => 'default',
      providerInputConsumer: createSessionProviderInputConsumerFixture(),
      resolveSystemPromptBeforeSpawn,
    });

    await runtime.startOrLoad({});

    expect(resolveSystemPromptBeforeSpawn).toHaveBeenCalledOnce();
    expect(createCalls[0]?.appendSystemPromptText).toBe('Happier effective system prompt');
  });

  it('fails session open before constructing the backend when prompt resolution fails', async () => {
    const createCalls: CatalogAcpRuntimeCreateCall[] = [];
    createCatalogAcpBackendSpy(createCalls);
    const runtime = createPiAcpRuntime({
      directory: '/tmp/repo',
      machineId: 'machine-1',
      session: createApiSessionClientFixture(),
      messageBuffer: createMessageBufferFixture(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange() {},
      getPermissionMode: () => 'default',
      providerInputConsumer: createSessionProviderInputConsumerFixture(),
      resolveSystemPromptBeforeSpawn: async () => {
        throw new Error('prompt composition failed');
      },
    });

    await expect(runtime.startOrLoad({})).rejects.toThrow('prompt composition failed');
    expect(createCalls).toHaveLength(0);
  });
});
