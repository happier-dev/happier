import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PermissionMode } from '@/api/types';
import { createQwenAcpRuntime } from './runtime';
import {
  createQwenCatalogBackendSpy,
  createQwenMessageBufferFixture,
  createQwenPermissionHandlerFixture,
  createQwenSessionFixture,
  type QwenRuntimeCreateCall,
} from './runtime.testkit';

describe('Qwen ACP runtime permission mode wiring', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('forwards permissionMode to createCatalogAcpBackend and recreates backend after reset', async () => {
    const createCalls: QwenRuntimeCreateCall[] = [];
    const createSpy = createQwenCatalogBackendSpy(createCalls);
    let permissionMode: 'default' | 'safe-yolo' = 'default';
    const runtime = createQwenAcpRuntime({
      directory: '/tmp',
      session: createQwenSessionFixture(),
      messageBuffer: createQwenMessageBufferFixture(),
      mcpServers: {},
      permissionHandler: createQwenPermissionHandlerFixture(),
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
    const createCalls: QwenRuntimeCreateCall[] = [];
    const createSpy = createQwenCatalogBackendSpy(createCalls);
    let permissionMode: unknown = null;
    const runtime = createQwenAcpRuntime({
      directory: '/tmp',
      session: createQwenSessionFixture(),
      messageBuffer: createQwenMessageBufferFixture(),
      mcpServers: {},
      permissionHandler: createQwenPermissionHandlerFixture(),
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
