import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PermissionMode } from '@/api/types';
import type { CatalogAcpRuntimeCreateCall } from '@/testkit/backends/catalogAcpRuntime';
import { createCatalogAcpBackendSpy, createMessageBufferFixture } from '@/testkit/backends/catalogAcpRuntime';
import { createApprovedPermissionHandler } from '@/testkit/backends/permissionHandler';
import { createApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';

import { createKiloAcpRuntime } from './runtime';

describe('Kilo ACP runtime permission mode wiring', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('forwards permissionMode to createCatalogAcpBackend and recreates backend after reset', async () => {
    const createCalls: CatalogAcpRuntimeCreateCall[] = [];
    const createSpy = createCatalogAcpBackendSpy(createCalls);

    let permissionMode: PermissionMode = 'default';

    const runtime = createKiloAcpRuntime({
      directory: '/tmp',
      machineId: 'machine-1',
      session: createApiSessionClientFixture(),
      messageBuffer: createMessageBufferFixture(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      getPermissionMode: () => permissionMode,
    });

    await runtime.startOrLoad({});
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(createCalls).toEqual([
      { agentId: 'kilo', permissionMode: 'default' },
    ]);

    permissionMode = 'read-only';
    await runtime.reset();
    await runtime.startOrLoad({});
    expect(createSpy).toHaveBeenCalledTimes(2);
    expect(createCalls[1]).toEqual({ agentId: 'kilo', permissionMode: 'read-only' });
  });
});
