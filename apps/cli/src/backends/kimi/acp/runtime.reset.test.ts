import { afterEach, describe, expect, it, vi } from 'vitest';

import { createKimiAcpRuntime } from './runtime';
import {
  createKimiCatalogBackendSpy,
  createKimiMessageBufferFixture,
  createKimiPermissionHandlerFixture,
  createKimiSessionFixture,
  type KimiRuntimeCreateCall,
} from './runtime.testkit';

describe('Kimi ACP runtime backend lifecycle', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('recreates backend after runtime.reset()', async () => {
    const createCalls: KimiRuntimeCreateCall[] = [];
    const createSpy = createKimiCatalogBackendSpy(createCalls);

    const runtime = createKimiAcpRuntime({
      directory: '/tmp',
      session: createKimiSessionFixture(),
      messageBuffer: createKimiMessageBufferFixture(),
      mcpServers: {},
      permissionHandler: createKimiPermissionHandlerFixture(),
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
