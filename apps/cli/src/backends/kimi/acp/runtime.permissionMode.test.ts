import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CatalogAcpRuntimeCreateCall } from '@/testkit/backends/catalogAcpRuntime';
import { createCatalogAcpBackendSpy, createMessageBufferFixture } from '@/testkit/backends/catalogAcpRuntime';
import { createApprovedPermissionHandler } from '@/testkit/backends/permissionHandler';
import { createApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { createKimiAcpRuntime } from './runtime';

describe('Kimi ACP runtime permissionMode wiring', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('forwards getPermissionMode() value to createCatalogAcpBackend', async () => {
    const createCalls: CatalogAcpRuntimeCreateCall[] = [];
    const createSpy = createCatalogAcpBackendSpy(createCalls);

    let permissionMode: 'default' | 'yolo' = 'default';
    const runtime = createKimiAcpRuntime({
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
    expect(createCalls).toEqual([{ agentId: 'kimi', permissionMode: 'default' }]);

    permissionMode = 'yolo';
    await runtime.reset();
    await runtime.startOrLoad({});
    expect(createSpy).toHaveBeenCalledTimes(2);
    expect(createCalls[1]).toEqual({ agentId: 'kimi', permissionMode: 'yolo' });
  }, 20_000);

  it('falls back to session metadata permissionMode when getPermissionMode is absent', async () => {
    const createCalls: CatalogAcpRuntimeCreateCall[] = [];
    const createSpy = createCatalogAcpBackendSpy(createCalls);

    const runtime = createKimiAcpRuntime({
      directory: '/tmp',
      machineId: 'machine-1',
      session: createApiSessionClientFixture({ metadataPermissionMode: 'read-only' }),
      messageBuffer: createMessageBufferFixture(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange() {},
    });

    await runtime.startOrLoad({});
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(createCalls[0]).toEqual({ agentId: 'kimi', permissionMode: 'read-only' });
  }, 20_000);
});
