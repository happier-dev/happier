import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PermissionMode } from '@/api/types';
import type { CatalogAcpRuntimeCreateCall } from '@/testkit/backends/catalogAcpRuntime';
import { createCatalogAcpBackendSpy, createMessageBufferFixture } from '@/testkit/backends/catalogAcpRuntime';
import { createApprovedPermissionHandler } from '@/testkit/backends/permissionHandler';
import { createApiSessionClientFixture, createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { readRuntimeDescriptorV1FromMetadata } from '@happier-dev/protocol';

import { createPiAcpRuntime } from './runtime';

describe('Pi ACP runtime permission mode wiring', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('passes the Happier session id to createCatalogAcpBackend', async () => {
    const createCalls: CatalogAcpRuntimeCreateCall[] = [];
    const createSpy = createCatalogAcpBackendSpy(createCalls);
    const session = Object.assign(createApiSessionClientFixture(), {
      sessionId: 'happy-session-1',
    });

    const runtime = createPiAcpRuntime({
      directory: '/tmp',
      machineId: 'machine-1',
      session,
      messageBuffer: createMessageBufferFixture(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange() {},
      getPermissionMode: () => 'default',
    });

    await runtime.startOrLoad({});

    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(createCalls[0]).toMatchObject({
      agentId: 'pi',
      happierSessionId: 'happy-session-1',
    });
  });

  it('publishes Pi runtime descriptor metadata when the provider session id is known', async () => {
    const createCalls: CatalogAcpRuntimeCreateCall[] = [];
    createCatalogAcpBackendSpy(createCalls);
    const session = createMutableApiSessionClientFixture();

    const runtime = createPiAcpRuntime({
      directory: '/tmp',
      machineId: 'machine-1',
      session,
      messageBuffer: createMessageBufferFixture(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange() {},
      getPermissionMode: () => 'default',
    });

    await runtime.startOrLoad({});

    await vi.waitFor(() => {
      const metadata = session.__getMetadata();
      expect(metadata).toMatchObject({ piSessionId: 'session-1' });
      expect(readRuntimeDescriptorV1FromMetadata(metadata)).toMatchObject({
        v: 1,
        providerId: 'pi',
        provider: {
          resumeStrategy: 'sessionFileAbsolutePreferred',
          providerSessionId: 'session-1',
        },
      });
    });
  });

  it('forwards permissionMode to createCatalogAcpBackend and recreates backend after reset', async () => {
    const createCalls: CatalogAcpRuntimeCreateCall[] = [];
    const createSpy = createCatalogAcpBackendSpy(createCalls);

    let permissionMode: PermissionMode = 'default';

    const runtime = createPiAcpRuntime({
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
    expect(createCalls).toEqual([{ agentId: 'pi', permissionMode: 'default' }]);

    permissionMode = 'read-only';
    await runtime.reset();
    await runtime.startOrLoad({});
    expect(createSpy).toHaveBeenCalledTimes(2);
    expect(createCalls[1]).toEqual({ agentId: 'pi', permissionMode: 'read-only' });
  });
});
