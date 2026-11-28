import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Credentials } from '@/persistence';
import { createCatalogAcpBackendSpy, createMessageBufferFixture, createSessionProviderInputConsumerFixture } from '@/testkit/backends/catalogAcpRuntime';
import { createApprovedPermissionHandler } from '@/testkit/backends/permissionHandler';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { createTempDirSync, removeTempDirSync } from '@/testkit/fs/tempDir';

import { createPiAcpRuntime } from './runtime';

// Daemon IPC is the boundary: the daemon writes the session marker that direct-session takeover
// reads to find the live owner of a Pi session.
const { notifyDaemonSessionStartedMock } = vi.hoisted(() => ({
  notifyDaemonSessionStartedMock: vi.fn(async () => ({})),
}));
vi.mock('@/daemon/controlClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/daemon/controlClient')>()),
  notifyDaemonSessionStarted: notifyDaemonSessionStartedMock,
}));

const credentials: Credentials = {
  token: 'test-token',
  encryption: { type: 'legacy', secret: new Uint8Array([1]) },
};

describe('Pi ACP runtime daemon session report', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    notifyDaemonSessionStartedMock.mockClear();
  });

  // Without the bound id, takeover cannot see this runner and would start a second Pi writer
  // on the same session file.
  it('reports the bound Pi session id so the daemon marker names this live owner', async () => {
    const agentDir = createTempDirSync('happier-pi-daemon-report-');
    vi.stubEnv('PI_CODING_AGENT_DIR', agentDir);
    try {
      createCatalogAcpBackendSpy([]);
      const session = Object.assign(
        createMutableApiSessionClientFixture({ metadata: createTestMetadata({ flavor: 'pi', path: '/tmp/repo' }) }),
        { sessionId: 'happy-session-report' },
      );

      const runtime = createPiAcpRuntime({
        directory: '/tmp/repo',
        machineId: 'machine-1',
        session,
        messageBuffer: createMessageBufferFixture(),
        mcpServers: {},
        permissionHandler: createApprovedPermissionHandler(),
        onThinkingChange() {},
        getPermissionMode: () => 'default',
        providerInputConsumer: createSessionProviderInputConsumerFixture(),
        credentials,
        accountSettings: {},
      });
      await runtime.startOrLoad({});

      await vi.waitFor(() => expect(notifyDaemonSessionStartedMock).toHaveBeenCalledWith(
        'happy-session-report',
        expect.objectContaining({ flavor: 'pi', piSessionId: 'session-1' }),
        expect.anything(),
      ));
    } finally {
      removeTempDirSync(agentDir);
    }
  });
});
