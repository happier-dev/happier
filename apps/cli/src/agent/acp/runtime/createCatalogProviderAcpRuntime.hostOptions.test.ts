import { afterEach, describe, expect, it, vi } from 'vitest';

import * as acpModule from '@/agent/acp';
import type { AgentBackend } from '@/agent/core';
import type { Credentials } from '@/persistence';
import { createMessageBufferFixture, createSessionProviderInputConsumerFixture } from '@/testkit/backends/catalogAcpRuntime';
import { createApprovedPermissionHandler } from '@/testkit/backends/permissionHandler';
import { createApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';

import { createCatalogProviderAcpRuntime } from './createCatalogProviderAcpRuntime';

const credentials: Credentials = {
  token: 'test-token',
  encryption: { type: 'legacy', secret: new Uint8Array([1]) },
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createCatalogProviderAcpRuntime host-owned backend options', () => {
  it('applies host-owned cwd/mcpServers after resolver output so they cannot be overridden', async () => {
    const receivedOpts: Record<string, unknown>[] = [];
    vi.spyOn(acpModule, 'createCatalogAcpBackend').mockImplementation(async () => ({
      backend: { async startSession() { return { sessionId: 's1' }; }, async sendPrompt() {}, async cancel() {}, onMessage() {}, async dispose() {} } as unknown as AgentBackend,
    }));

    const runtime = createCatalogProviderAcpRuntime<Record<string, unknown>>({
      provider: 'pi',
      loggerLabel: '[test]',
      directory: '/host/repo',
      session: Object.assign(createApiSessionClientFixture(), { sessionId: 'happy-session-hostopts' }),
      messageBuffer: createMessageBufferFixture(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange() {},
      getPermissionMode: () => 'default',
      providerInputConsumer: createSessionProviderInputConsumerFixture(),
      sessionIdentity: { kind: 'manifest-metadata' },
      resolveBackendOptionsBeforeSpawn: async () => ({
        // Hostile/accidental override attempt — the narrowed type forbids these keys; the
        // merge order must also make them ineffective at runtime (defense in depth).
        cwd: '/attacker/controlled',
        mcpServers: { injected: { command: 'evil' } as never },
      }) as never,
    });

    await runtime.startOrLoad({});

    // The single create call captured: host fields must win.
    const spy = vi.mocked(acpModule.createCatalogAcpBackend);
    receivedOpts.push(...spy.mock.calls.map((call) => call[1] as Record<string, unknown>));
    expect(receivedOpts).toHaveLength(1);
    expect(receivedOpts[0].cwd).toBe('/host/repo');
    expect(receivedOpts[0].mcpServers).toEqual({});
  });
});
