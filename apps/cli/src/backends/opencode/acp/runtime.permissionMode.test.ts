import { afterEach, describe, expect, it, vi } from 'vitest';

import { createOpenCodeAcpRuntime } from './runtime';
import {
  createOpenCodeCatalogBackendSpy,
  createOpenCodeMessageBufferFixture,
  createOpenCodePermissionHandlerFixture,
  createOpenCodeSessionFixture,
  type OpenCodeRuntimeCreateCall,
} from './runtime.testkit';

describe('OpenCode ACP runtime permission mode wiring', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('forwards permissionMode to createCatalogAcpBackend and recreates backend after reset', async () => {
    const createCalls: OpenCodeRuntimeCreateCall[] = [];
    const createSpy = createOpenCodeCatalogBackendSpy(createCalls);
    let permissionMode: 'default' | 'yolo' = 'default';
    const runtime = createOpenCodeAcpRuntime({
      directory: '/tmp',
      session: createOpenCodeSessionFixture(),
      messageBuffer: createOpenCodeMessageBufferFixture(),
      mcpServers: {},
      permissionHandler: createOpenCodePermissionHandlerFixture(),
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
    const createCalls: OpenCodeRuntimeCreateCall[] = [];
    const createSpy = createOpenCodeCatalogBackendSpy(createCalls);
    const runtime = createOpenCodeAcpRuntime({
      directory: '/tmp',
      session: createOpenCodeSessionFixture(),
      messageBuffer: createOpenCodeMessageBufferFixture(),
      mcpServers: {},
      permissionHandler: createOpenCodePermissionHandlerFixture(),
      onThinkingChange() {},
    });

    await runtime.startOrLoad({});
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(createCalls[0]).toEqual({ agentId: 'opencode', permissionMode: undefined });
  });
});
