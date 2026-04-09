import { describe, expect, it, vi } from 'vitest';

const { runRemoteTextSyncMock } = vi.hoisted(() => ({
  runRemoteTextSyncMock: vi.fn(),
}));

vi.mock('@happier-dev/cli-common/ssh', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@happier-dev/cli-common/ssh')>();
  return {
    ...actual,
    runRemoteTextSync: runRemoteTextSyncMock,
  };
});

import { runRemoteDaemonServiceCommandDefault } from './remoteSshManageHostTasks.js';

describe('runRemoteDaemonServiceCommandDefault', () => {
  it('uses the canonical background-service command surface for remote lifecycle actions', async () => {
    runRemoteTextSyncMock.mockReset();

    await runRemoteDaemonServiceCommandDefault({
      ssh: {
        target: 'dev@example.test',
        auth: 'agent',
      },
      auth: { mode: 'agent' },
      knownHostsMode: 'app',
      action: 'restart',
      serviceMode: 'user',
      channel: 'preview',
    });

    expect(runRemoteTextSyncMock).toHaveBeenCalledTimes(1);
    expect(runRemoteTextSyncMock).toHaveBeenCalledWith(expect.objectContaining({
      remoteCommand: expect.stringContaining('service restart --mode=user --json'),
      errorPrefix: 'Remote background service command failed for dev@example.test',
    }));
    expect(runRemoteTextSyncMock).toHaveBeenCalledWith(expect.objectContaining({
      remoteCommand: expect.not.stringContaining('daemon service restart'),
    }));
  });
});
