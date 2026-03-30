import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CatalogAcpRuntimeCreateCall } from '@/testkit/backends/catalogAcpRuntime';
import { createCatalogAcpBackendSpy, createMessageBufferFixture } from '@/testkit/backends/catalogAcpRuntime';
import { createApprovedPermissionHandler } from '@/testkit/backends/permissionHandler';
import { createApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { createKimiAcpRuntime } from './runtime';

describe('Kimi ACP runtime backend lifecycle', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('recreates backend after runtime.reset()', async () => {
    const createCalls: CatalogAcpRuntimeCreateCall[] = [];
    const createSpy = createCatalogAcpBackendSpy(createCalls);

    const runtime = createKimiAcpRuntime({
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
    expect(createCalls[0]?.agentId).toBe('kimi');

    await runtime.reset();
    await runtime.startOrLoad({});
    expect(createSpy).toHaveBeenCalledTimes(2);
    expect(createCalls[1]?.agentId).toBe('kimi');
  });
});
