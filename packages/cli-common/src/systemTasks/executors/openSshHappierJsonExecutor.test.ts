import { describe, expect, it, vi } from 'vitest';

import { createOpenSshHappierJsonExecutor } from './openSshHappierJsonExecutor.js';

describe('createOpenSshHappierJsonExecutor', () => {
  it('prefixes remote commands with release-ring env scoping for dev lane', async () => {
    const runRemoteText = vi.fn<(params: any) => Promise<void>>(async () => {});

    const executor = createOpenSshHappierJsonExecutor({
      ssh: { target: 'dev@example.test', auth: 'agent' },
      auth: { mode: 'agent' },
      knownHostsMode: 'app',
      channel: 'publicdev',
      runRemoteText: async ({ remoteCommand, ...rest }) => {
        await runRemoteText({ remoteCommand, ...rest });
        return { status: 0, stdout: '{}\n', stderr: '' };
      },
    });

    await executor.runHappierText(['auth', 'status']);

    const firstCall = runRemoteText.mock.calls[0]?.[0];
    expect(String(firstCall?.remoteCommand ?? '')).toContain("HAPPIER_PUBLIC_RELEASE_CHANNEL='dev'");
    expect(String(firstCall?.remoteCommand ?? '')).toContain("HAPPIER_RELEASE_RING='dev'");
  });

  it('does not prefix scoping env vars for the stable lane', async () => {
    const runRemoteText = vi.fn<(remoteCommand: string) => Promise<void>>(async () => {});

    const executor = createOpenSshHappierJsonExecutor({
      ssh: { target: 'dev@example.test', auth: 'agent' },
      auth: { mode: 'agent' },
      knownHostsMode: 'app',
      channel: 'stable',
      runRemoteText: async ({ remoteCommand }) => {
        await runRemoteText(remoteCommand);
        return { status: 0, stdout: '{}\n', stderr: '' };
      },
    });

    await executor.runHappierText(['auth', 'status']);

    const cmd = String(runRemoteText.mock.calls[0]?.[0] ?? '');
    expect(cmd).not.toContain('HAPPIER_PUBLIC_RELEASE_CHANNEL');
    expect(cmd).not.toContain('HAPPIER_RELEASE_RING');
  });
});
