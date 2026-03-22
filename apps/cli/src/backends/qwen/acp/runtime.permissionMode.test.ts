import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PermissionMode } from '@/api/types';
import type { CatalogAcpRuntimeCreateCall } from '@/testkit/backends/catalogAcpRuntime';
import { createCatalogAcpBackendSpy, createMessageBufferFixture } from '@/testkit/backends/catalogAcpRuntime';
import { createApprovedPermissionHandler } from '@/testkit/backends/permissionHandler';
import { createApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { createQwenAcpRuntime } from './runtime';

describe('Qwen ACP runtime permission mode wiring', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('forwards permissionMode to createCatalogAcpBackend and recreates backend after reset', async () => {
    const createCalls: CatalogAcpRuntimeCreateCall[] = [];
    const createSpy = createCatalogAcpBackendSpy(createCalls);
    let permissionMode: 'default' | 'safe-yolo' = 'default';
    const runtime = createQwenAcpRuntime({
      directory: '/tmp',
      machineId: 'machine-1',
      session: createApiSessionClientFixture(),
      messageBuffer: createMessageBufferFixture(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange() {},
      getPermissionMode: () => permissionMode,
    });

    await runtime.startOrLoad({});
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]).toEqual({ agentId: 'qwen', permissionMode: 'default' });

    permissionMode = 'safe-yolo';
    await runtime.reset();
    await runtime.startOrLoad({});
    expect(createSpy).toHaveBeenCalledTimes(2);
    expect(createCalls).toHaveLength(2);
    expect(createCalls[1]).toEqual({ agentId: 'qwen', permissionMode: 'safe-yolo' });
  });

  it('normalizes non-string permissionMode values to undefined', async () => {
    const createCalls: CatalogAcpRuntimeCreateCall[] = [];
    const createSpy = createCatalogAcpBackendSpy(createCalls);
    let permissionMode: unknown = null;
    const runtime = createQwenAcpRuntime({
      directory: '/tmp',
      machineId: 'machine-1',
      session: createApiSessionClientFixture(),
      messageBuffer: createMessageBufferFixture(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange() {},
      getPermissionMode: () => permissionMode as PermissionMode | null | undefined,
    });

    await runtime.startOrLoad({});
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]).toEqual({ agentId: 'qwen', permissionMode: undefined });

    permissionMode = 123;
    await runtime.reset();
    await runtime.startOrLoad({});
    expect(createSpy).toHaveBeenCalledTimes(2);
    expect(createCalls).toHaveLength(2);
    expect(createCalls[1]).toEqual({ agentId: 'qwen', permissionMode: undefined });
  });
});
