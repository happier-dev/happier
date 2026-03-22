import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CatalogAcpRuntimeCreateCall } from '@/testkit/backends/catalogAcpRuntime';
import { createCatalogAcpBackendSpy, createMessageBufferFixture } from '@/testkit/backends/catalogAcpRuntime';
import { createApprovedPermissionHandler } from '@/testkit/backends/permissionHandler';
import { createApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { createOpenCodeAcpRuntime } from './runtime';

describe('OpenCode ACP runtime permission mode wiring', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('forwards permissionMode to createCatalogAcpBackend and recreates backend after reset', async () => {
    const createCalls: CatalogAcpRuntimeCreateCall[] = [];
    const createSpy = createCatalogAcpBackendSpy(createCalls);
    let permissionMode: 'default' | 'yolo' = 'default';
    const runtime = createOpenCodeAcpRuntime({
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
    expect(createCalls[0]).toEqual({ agentId: 'opencode', permissionMode: 'default' });

    permissionMode = 'yolo';
    await runtime.reset();
    await runtime.startOrLoad({});
    expect(createSpy).toHaveBeenCalledTimes(2);
    expect(createCalls).toHaveLength(2);
    expect(createCalls[1]).toEqual({ agentId: 'opencode', permissionMode: 'yolo' });
  });

  it('passes undefined permissionMode when getPermissionMode is not provided', async () => {
    const createCalls: CatalogAcpRuntimeCreateCall[] = [];
    const createSpy = createCatalogAcpBackendSpy(createCalls);
    const runtime = createOpenCodeAcpRuntime({
      directory: '/tmp',
      machineId: 'machine-1',
      session: createApiSessionClientFixture(),
      messageBuffer: createMessageBufferFixture(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange() {},
    });

    await runtime.startOrLoad({});
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(createCalls[0]).toEqual({ agentId: 'opencode', permissionMode: undefined });
  });
});
