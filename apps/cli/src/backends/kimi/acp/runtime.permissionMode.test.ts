import { afterEach, describe, expect, it, vi } from 'vitest';

import { createKimiAcpRuntime } from './runtime';
import {
  createKimiCatalogBackendSpy,
  createKimiMessageBufferFixture,
  createKimiPermissionHandlerFixture,
  createKimiSessionFixture,
  type KimiRuntimeCreateCall,
} from './runtime.testHelpers';

describe('Kimi ACP runtime permissionMode wiring', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('forwards getPermissionMode() value to createCatalogAcpBackend', async () => {
    const createCalls: KimiRuntimeCreateCall[] = [];
    const createSpy = createKimiCatalogBackendSpy(createCalls);

    let permissionMode: 'default' | 'yolo' = 'default';
    const runtime = createKimiAcpRuntime({
      directory: '/tmp',
      session: createKimiSessionFixture(),
      messageBuffer: createKimiMessageBufferFixture(),
      mcpServers: {},
      permissionHandler: createKimiPermissionHandlerFixture(),
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
    const createCalls: KimiRuntimeCreateCall[] = [];
    const createSpy = createKimiCatalogBackendSpy(createCalls);

    const runtime = createKimiAcpRuntime({
      directory: '/tmp',
      session: createKimiSessionFixture({ metadataPermissionMode: 'read-only' }),
      messageBuffer: createKimiMessageBufferFixture(),
      mcpServers: {},
      permissionHandler: createKimiPermissionHandlerFixture(),
      onThinkingChange() {},
    });

    await runtime.startOrLoad({});
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(createCalls[0]).toEqual({ agentId: 'kimi', permissionMode: 'read-only' });
  }, 20_000);
});
