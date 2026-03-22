import { describe, expect, it, vi } from 'vitest';

import type { PermissionMode } from '@/api/types';
import type { CatalogAcpRuntimeCreateCall } from '@/testkit/backends/catalogAcpRuntime';
import { createCatalogAcpBackendSpy, createMessageBufferFixture } from '@/testkit/backends/catalogAcpRuntime';
import { createApprovedPermissionHandler } from '@/testkit/backends/permissionHandler';
import { createApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';

describe('Auggie ACP runtime permission mode wiring', () => {
  it('forwards permissionMode to createCatalogAcpBackend and recreates backend after reset', async () => {
    const createCalls: CatalogAcpRuntimeCreateCall[] = [];
    let permissionMode: PermissionMode = 'default';
    const createCatalogSpy = createCatalogAcpBackendSpy(createCalls);

    try {
      const { createAuggieAcpRuntime } = await import('./runtime');
      const runtime = createAuggieAcpRuntime({
        directory: '/tmp',
        machineId: 'machine-1',
        session: createApiSessionClientFixture(),
        messageBuffer: createMessageBufferFixture(),
        mcpServers: {},
        permissionHandler: createApprovedPermissionHandler(),
        onThinkingChange() {},
        allowIndexing: false,
        getPermissionMode: () => permissionMode,
      });

      await runtime.startOrLoad({});
      expect(createCalls).toHaveLength(1);
      expect(createCalls[0]?.agentId).toBe('auggie');
      expect(createCalls[0]?.permissionMode).toBe('default');

      permissionMode = 'yolo';
      await runtime.reset();
      await runtime.startOrLoad({});
      expect(createCalls).toHaveLength(2);
      expect(createCalls[1]?.permissionMode).toBe('yolo');
    } finally {
      createCatalogSpy.mockRestore();
    }
  });
});
